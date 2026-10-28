import { randomBytes } from "node:crypto";
import { codexDeviceCode, codexDevicePage } from "../tools/ai";
import type {
  GatewayAnswer,
  GatewayFailure,
  GatewayResult,
  HermesGateway,
} from "./hermes-gateway";

// Buddy's ChatGPT sign-in (decision F63): only Hermes's own OAuth worker
// writes Buddy's sign-in, into his auth store (`providers.openai-codex`,
// `_save_codex_tokens`); the Launchpad and `lazurio buddy` only start, follow,
// cancel and sign out through the dashboard routes Hermes's own LOGIN uses
// (`hermes_cli/web_routers/oauth.py`), over Buddy's gateway
// (hermes-gateway.ts). Never `hermes auth add`: it writes a
// `manual:device_code` pool entry that dies when two processes refresh it at
// once (NousResearch/hermes-agent#139727), and Buddy's gateway and his chat
// both do.
//
//   start   POST   /api/providers/oauth/openai-codex/start
//   poll    GET    /api/providers/oauth/openai-codex/poll/<session>
//   cancel  DELETE /api/providers/oauth/sessions/<session>
//   sign out DELETE /api/providers/oauth/openai-codex
//
// A sign-in starts only on a gateway that advertises Hermes's OAuth
// cancellation contract (Lazurio/hermes-agent#17, `oauthCancelContract`):
// otherwise nothing starts (`blocked`, `hermes-outdated`). One sign-in at a
// time, in this process's memory, held until it is certain that Hermes's
// worker can no longer save one (Pablo's reviews of #635):
// - its poll answers an ending (approved, expired, denied, error), which its
//   worker sets as it stops;
// - its cancel answers `{ok: true}` for exactly that session: Hermes marks it
//   cancelled under the lock its worker checks before it saves, so nothing is
//   saved after;
// - Hermes holds no session by that id (its poll's 404, its cancel's
//   `{ok: false, message: "session not found"}`), and the gateway instance
//   that says so advertises the contract: its sweep, like its cancel, marks a
//   session before it removes it. At v0.22.4-lazurio.1 the sweep removes a
//   session without the mark, so there "not found" proves nothing.
// Anything else proves nothing: the sign-in stays held and addressable, and
// whatever needed it ended changes nothing: a new start, a cancel, a sign-out
// answer `blocked` (`hermes-outdated` when a gateway without the contract no
// longer holds it, `sign-in-running` for any other answer) or `unavailable`
// when the gateway did not answer. A sign-out without a held sign-in needs no
// contract: removing a stored sign-in does not depend on it.
//
// The holder knows the sign-in by an opaque handle of its own (32 hex
// characters, the curated logins' shape), and Hermes's session id stays here.
// The one-time code and OpenAI's page go only to the holder, and only in their
// exact shapes: OpenAI's page for a sign-in by code (`codexDevicePage`) and a
// whole code (`codexDeviceCode`), the same checks as the agents' "Přihlásit
// kódem". Hermes's own words (`error_message`, `detail`) never leave this
// module: the answer and the journal get a closed reason. The journal names
// the operation, the outcome and the reason, never a code, a handle, a ticket
// or a session.
//
// A sign-in OpenAI approved is not yet a working Buddy (the subscription
// decision of 2026-10-28, Lazurio/LazurioPlatform#694): a free account, or one
// whose plan lacks his model, signs in and then fails every turn with an HTTP
// 400 that never names the plan. Where the gateway's `identify` lists
// `lazurio-codex-entitlement-v1` (Lazurio/hermes-agent#20), the approved poll
// asks Hermes `GET /api/providers/oauth/openai-codex/entitlement`. Only a whole
// answer of its contract refuses: the verdict `no-subscription` with the plan
// `free` and no catalog asked, or `model-missing` with a catalog that answered
// without his model, for `openai-codex` and a model. That signs Buddy out again
// (tried twice) and answers `unusable` with the reason and whether the sign-out
// happened: where it did not, the account is still signed in, and nothing
// claims otherwise. Every other answer (`usable`, `unknown`, no answer, an
// answer of no known or of an inconsistent shape, a Hermes without the
// capability) keeps the sign-in: what cannot be checked never blocks.

/** How often the holder asks again: Začínáme's AI step asks every 2 s too. */
export const buddySignInPollMs = 2_000;

/** Hermes's own lifetime of a code (`_CODEX_EXPIRES_IN`), for a start whose
 * lifetime had no known shape. */
const hermesCodeLifetimeMs = 15 * 60_000;

export type BuddySignInFailure =
  /** The code expired before the person used it. */
  | "expired"
  /** OpenAI refused the sign-in by code (for an account it may have to be
   * allowed in ChatGPT's settings first). */
  | "refused"
  /** Hermes no longer knows the sign-in: Buddy's gateway restarted, or it
   * ended elsewhere. */
  | "lost"
  | "failed";

export type BuddySignInPending = Readonly<{
  kind: "pending";
  /** The holder's handle of this sign-in. */
  session: string;
  code: string;
  url: string;
  /** ISO time the code stops working. */
  expiresAt: string;
  pollMs: number;
}>;

/** Nothing changed: `hermes-outdated`, Buddy's Hermes does not advertise the
 * cancellation contract (a sign-in does not start there, and one it no
 * longer holds may still complete); `sign-in-running`, Hermes did not confirm
 * the cancel of a sign-in that may still complete. */
export type BuddySignInBlocked = Readonly<{
  kind: "blocked";
  reason: "sign-in-running" | "hermes-outdated";
}>;

/** Buddy's gateway did not answer: nothing changed. */
export type BuddyGatewayUnavailable = Readonly<{
  kind: "unavailable";
  reason: GatewayFailure;
}>;

/** Why an account OpenAI signed in cannot run Buddy (the subscription
 * decision of 2026-10-28, Lazurio/LazurioPlatform#694): a free plan, or a
 * plan whose catalog lacks his model. */
export type BuddyUnusableReason = "no-subscription" | "model-missing";

export type BuddySignInAnswer =
  | BuddySignInPending
  | Readonly<{ kind: "signed-in" }>
  /** OpenAI signed the account in, but it cannot run Buddy's model: signed
   * out again, so nothing is left for his chat and Telegram to fail on;
   * `signedOut: false` where Hermes did not sign it out on a second try
   * either, so the account is still signed in. */
  | Readonly<{
      kind: "unusable";
      reason: BuddyUnusableReason;
      signedOut: boolean;
    }>
  | Readonly<{ kind: "failed"; reason: BuddySignInFailure }>
  /** No sign-in by this handle (any more). */
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "cancelled" }>
  | BuddySignInBlocked
  | BuddyGatewayUnavailable;

export type BuddySignOutAnswer =
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "failed"; reason: "failed" }>
  | BuddySignInBlocked
  | BuddyGatewayUnavailable;

/** One line of the owner's journal: the operation, the outcome and the
 * reason, nothing else. */
export type BuddySignInJournalEntry = Readonly<{
  operation: "start" | "poll" | "cancel" | "sign-out";
  outcome: string;
  reason?: string;
}>;

export type BuddySignIn = ReturnType<typeof createBuddySignIn>;

type Session = {
  handle: string;
  /** Hermes's session id: never answered, logged or written. */
  hermes: string;
  /** Null for a start of no known shape, shown to nobody and held only until
   * its worker can no longer save. */
  code: string | null;
  url: string;
  /** Wall time the code stops working, for the holder. */
  expiresAt: number;
};

// `secrets.token_urlsafe(16)` (22 characters), with room either way.
const hermesSessionPattern = /^[A-Za-z0-9_-]{16,64}$/;
export const isBuddySignInHandle = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Hermes's words for OpenAI refusing a sign-in by code
 * (`_codex_device_code_start_error`); they decide the reason and go no
 * further. */
const refusedByOpenAi = (text: unknown) =>
  typeof text === "string" &&
  text.startsWith("OpenAI rejected the device-code login request");

const codexPath = "/api/providers/oauth/openai-codex";

/** The capability of a Hermes that answers whether the signed-in account may
 * run Buddy's model (Lazurio/hermes-agent#20). */
export const codexEntitlementCapability = "lazurio-codex-entitlement-v1";

/** The verdict of a whole entitlement answer (Lazurio/hermes-agent#20) that
 * refuses the account, where its other members bear it out: `no-subscription`
 * for the plan `free`, whose catalog is not asked; `model-missing` for another
 * plan, or none, whose catalog answered without Buddy's model. Anything else
 * refuses nothing. */
function refusedVerdict(body: Json): BuddyUnusableReason | undefined {
  const { provider, model, plan, catalog, verdict } = body;
  if (provider !== "openai-codex" || typeof model !== "string" || !model.trim())
    return undefined;
  if (plan !== null && typeof plan !== "string") return undefined;
  if (verdict === "no-subscription")
    return plan === "free" && catalog === "not-asked" ? verdict : undefined;
  if (verdict === "model-missing")
    return plan !== "free" && catalog === "missing" ? verdict : undefined;
  return undefined;
}

/** What Hermes said of a cancel. */
type Ending =
  | Readonly<{ kind: "ended" }>
  | BuddySignInBlocked
  | BuddyGatewayUnavailable;

const ended: Ending = Object.freeze({ kind: "ended" });
const running: BuddySignInBlocked = Object.freeze({
  kind: "blocked",
  reason: "sign-in-running",
});
const outdated: BuddySignInBlocked = Object.freeze({
  kind: "blocked",
  reason: "hermes-outdated",
});

export function createBuddySignIn(
  options: Readonly<{
    gateway: HermesGateway;
    /** Tests only: the wall clock, for the code's end the holder sees. */
    now?: () => number;
    journal?: (entry: BuddySignInJournalEntry) => void;
  }>,
) {
  const now = options.now ?? Date.now;
  const gateway = options.gateway;
  let current: Session | undefined;
  // One operation at a time, so that two starts (two tabs) end as the later
  // one, on Hermes too, and a poll never answers for a session being
  // replaced.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };
  const journal = (entry: BuddySignInJournalEntry) => {
    try {
      options.journal?.(entry);
    } catch {}
  };

  const pending = (session: Session, code: string): BuddySignInPending =>
    Object.freeze({
      kind: "pending",
      session: session.handle,
      code,
      url: session.url,
      expiresAt: new Date(session.expiresAt).toISOString(),
      pollMs: buddySignInPollMs,
    });
  const end = (
    operation: BuddySignInJournalEntry["operation"],
    answer: BuddySignInAnswer,
  ): BuddySignInAnswer => {
    current = undefined;
    journal({
      operation,
      outcome: answer.kind,
      ...(answer.kind === "failed" || answer.kind === "unusable"
        ? { reason: answer.reason }
        : {}),
    });
    return answer;
  };
  /** Refused, nothing changed: journaled. */
  const refused = <T extends BuddySignInBlocked | BuddyGatewayUnavailable>(
    operation: BuddySignInJournalEntry["operation"],
    answer: T,
  ): T => {
    journal({ operation, outcome: answer.kind, reason: answer.reason });
    return answer;
  };

  /** Asks Hermes to cancel the session: `ended` only when it confirms the
   * cancel of exactly that session, or holds none by that id and keeps the
   * cancellation contract. */
  async function endOnHermes(session: Session): Promise<Ending> {
    let answer: GatewayResult<GatewayAnswer>;
    try {
      answer = await gateway.request(
        "DELETE",
        `/api/providers/oauth/sessions/${session.hermes}`,
      );
    } catch {
      return running;
    }
    if (!answer.ok)
      return Object.freeze({ kind: "unavailable", reason: answer.reason });
    const { status, body, contract } = answer.value;
    if (status === 200 && isObject(body)) {
      if (body.ok === true && body.session_id === session.hermes) return ended;
      if (body.ok === false && body.message === "session not found")
        return contract ? ended : outdated;
    }
    return running;
  }

  async function start(): Promise<BuddySignInAnswer> {
    const before = current;
    if (before !== undefined) {
      // The one before ends first, or nothing starts.
      const ending = await endOnHermes(before);
      if (ending.kind !== "ended") return refused("start", ending);
      current = undefined;
      journal({
        operation: "cancel",
        outcome: "cancelled",
        reason: "replaced",
      });
    }
    // Only where a session that leaves Hermes's map can no longer save.
    const answer = await gateway.request("POST", `${codexPath}/start`, {
      requireContract: true,
    });
    if (!answer.ok)
      return refused(
        "start",
        answer.reason === "outdated"
          ? outdated
          : Object.freeze({
              kind: "unavailable" as const,
              reason: answer.reason,
            }),
      );
    const failed = (reason: BuddySignInFailure) => {
      journal({ operation: "start", outcome: "failed", reason });
      return Object.freeze({ kind: "failed" as const, reason });
    };
    const { status, body } = answer.value;
    if (status !== 200 || !isObject(body))
      return failed(
        isObject(body) && refusedByOpenAi(body.detail) ? "refused" : "failed",
      );
    const hermes = body.session_id;
    // A session that cannot be named in a path cannot be addressed at all;
    // its code is shown to nobody.
    if (typeof hermes !== "string" || !hermesSessionPattern.test(hermes))
      return failed("failed");
    const expiresIn = body.expires_in;
    const lifetimeKnown =
      typeof expiresIn === "number" &&
      Number.isSafeInteger(expiresIn) &&
      expiresIn > 0 &&
      expiresIn <= 3600;
    const session: Session = {
      handle: randomBytes(16).toString("hex"),
      hermes,
      code: null,
      url: codexDevicePage,
      expiresAt:
        now() + (lifetimeKnown ? expiresIn * 1000 : hermesCodeLifetimeMs),
    };
    if (
      body.verification_url !== codexDevicePage ||
      typeof body.user_code !== "string" ||
      !codexDeviceCode.test(body.user_code) ||
      !lifetimeKnown
    ) {
      // Shown to nobody, and never left waiting on Hermes either: held
      // without a holder until its worker can no longer save.
      if ((await endOnHermes(session)).kind !== "ended") current = session;
      return failed("failed");
    }
    session.code = body.user_code;
    current = session;
    journal({ operation: "start", outcome: "pending" });
    return pending(session, body.user_code);
  }

  /** Ends the held sign-in as `answer` once Hermes's cancel shows its worker
   * can no longer save; otherwise it stays held and still waits. */
  async function endConfirmed(
    session: Session,
    code: string,
    answer: BuddySignInAnswer,
  ): Promise<BuddySignInAnswer> {
    return (await endOnHermes(session)).kind === "ended"
      ? end("poll", answer)
      : pending(session, code);
  }

  /** Hermes's verdict on the account it just saved, where a whole answer
   * refuses it; a Hermes without the capability, no answer, any other verdict
   * or an answer its members do not bear out refuses nothing. */
  async function refusal(): Promise<BuddyUnusableReason | undefined> {
    let answer: GatewayResult<GatewayAnswer>;
    try {
      answer = await gateway.request("GET", `${codexPath}/entitlement`, {
        capability: codexEntitlementCapability,
      });
    } catch {
      return undefined;
    }
    if (!answer.ok) return undefined;
    const { status, body } = answer.value;
    if (status !== 200 || !isObject(body)) return undefined;
    return refusedVerdict(body);
  }

  /** One sign-out of Buddy's ChatGPT account: `signed-out` for Hermes's 200,
   * or its 409 for an empty store. */
  async function removeAccount(): Promise<
    "signed-out" | "unavailable" | "failed"
  > {
    try {
      const answer = await gateway.request("DELETE", codexPath);
      if (!answer.ok) return "unavailable";
      return answer.value.status === 200 || answer.value.status === 409
        ? "signed-out"
        : "failed";
    } catch {
      return "failed";
    }
  }

  /** The approved sign-in's answer: `signed-in`, or `unusable` once Hermes
   * refuses the account, signed out again (journaled as a sign-out, tried a
   * second time where the first failed); `signedOut` says whether it was. */
  async function approved(): Promise<BuddySignInAnswer> {
    const reason = await refusal();
    if (reason === undefined) return { kind: "signed-in" };
    let outcome = await removeAccount();
    if (outcome !== "signed-out") outcome = await removeAccount();
    journal({ operation: "sign-out", outcome, reason });
    return { kind: "unusable", reason, signedOut: outcome === "signed-out" };
  }

  /** What one answer of Hermes's poll means for the held sign-in. */
  async function follow(
    session: Session,
    code: string,
    answer: GatewayResult<GatewayAnswer>,
  ): Promise<BuddySignInAnswer> {
    // A gateway that does not answer proves nothing: asked again.
    if (!answer.ok) return pending(session, code);
    const { status, body, contract } = answer.value;
    // Hermes no longer holds it: ended where that means nothing saves it.
    if (status === 404)
      return contract
        ? end("poll", { kind: "failed", reason: "lost" })
        : pending(session, code);
    if (status === 200 && isObject(body) && body.session_id === session.hermes)
      switch (body.status) {
        // Hermes ends a sign-in itself, at its code's end after its worker's
        // last round; until then it waits.
        case "pending":
          return pending(session, code);
        case "approved":
          return end("poll", await approved());
        case "expired":
          return end("poll", { kind: "failed", reason: "expired" });
        case "denied":
          return end("poll", { kind: "failed", reason: "refused" });
        case "error":
          return end("poll", {
            kind: "failed",
            reason: refusedByOpenAi(body.error_message) ? "refused" : "failed",
          });
        case "cancelled":
          return end("poll", { kind: "failed", reason: "lost" });
      }
    // An answer of no known shape: ended only once Hermes's cancel shows it.
    return endConfirmed(session, code, { kind: "failed", reason: "failed" });
  }

  return Object.freeze({
    /** Přihlásit se, Nový kód, Přihlásit znovu: a new sign-in, once the
     * one before it can no longer complete. */
    start: () => serial(start),

    /** The sign-in of this handle as Hermes has it now; an outcome is
     * answered once, then the handle names none. */
    poll: (handle: string) =>
      serial(async (): Promise<BuddySignInAnswer> => {
        const session = current;
        const code = session?.code;
        if (session === undefined || session.handle !== handle || !code)
          return Object.freeze({ kind: "none" });
        return follow(
          session,
          code,
          await gateway.request("GET", `${codexPath}/poll/${session.hermes}`),
        );
      }),

    /** Zrušit: `cancelled` only once Hermes confirmed it, or no longer holds
     * the session under the contract. */
    cancel: (handle: string) =>
      serial(async (): Promise<BuddySignInAnswer> => {
        const session = current;
        if (session === undefined || session.handle !== handle || !session.code)
          return Object.freeze({ kind: "none" });
        const ending = await endOnHermes(session);
        if (ending.kind !== "ended") return refused("cancel", ending);
        current = undefined;
        journal({ operation: "cancel", outcome: "cancelled" });
        return Object.freeze({ kind: "cancelled" });
      }),

    /** Odhlásit: Hermes removes Buddy's ChatGPT sign-in (its singleton and
     * its pool entries), only once a held sign-in can no longer complete, so
     * none can sign him in again; an empty store (Hermes's 409) is signed out
     * too. */
    signOut: () =>
      serial(async (): Promise<BuddySignOutAnswer> => {
        const session = current;
        if (session !== undefined) {
          const ending = await endOnHermes(session);
          if (ending.kind !== "ended") return refused("sign-out", ending);
          current = undefined;
          journal({ operation: "cancel", outcome: "cancelled" });
        }
        const answer = await gateway.request("DELETE", codexPath);
        let result: BuddySignOutAnswer;
        if (!answer.ok)
          result = Object.freeze({
            kind: "unavailable",
            reason: answer.reason,
          });
        else if (answer.value.status === 200 || answer.value.status === 409)
          result = Object.freeze({ kind: "signed-out" });
        else result = Object.freeze({ kind: "failed", reason: "failed" });
        journal({
          operation: "sign-out",
          outcome: result.kind,
          ...(result.kind === "signed-out" ? {} : { reason: result.reason }),
        });
        return result;
      }),
  });
}
