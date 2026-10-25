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
// One sign-in at a time, in this process's memory. A sign-in stays this
// process's until it is certain that Hermes's worker can no longer save one,
// because until then it may still save a sign-in the person approves:
// - its poll answers an ending (approved, expired, denied, error), which its
//   worker sets as it stops;
// - its cancel answers `{ok: true}` for exactly that session: Hermes marks it
//   cancelled under the lock its worker takes to save, so it saves nothing
//   after (Pablo's first review of #635);
// - Hermes holds no session by that id (its poll's 404, its cancel's
//   `{ok: false, message: "session not found"}`) and either another gateway
//   instance answers, so the process that ran the worker is gone, or the
//   worker's last chance to save has passed (`buddySignInFinishingMs`). Not before: at
//   v0.22.4-lazurio.1 Hermes's 15-minute clean-up (`_gc_oauth_sessions`)
//   removes a session without marking it cancelled, while its worker, which
//   keeps the same record and checks only that mark, may still be in its last
//   round (Pablo's second review of #635; the fork marks it in a release of
//   its own).
// Anything else proves nothing: the sign-in stays held and addressable, and
// whatever needed it ended changes nothing: a new start, a cancel, a sign-out
// answer `blocked` (`sign-in-finishing` while a session Hermes no longer holds
// may still save, `sign-in-running` for any other answer) or `unavailable`
// when the gateway did not answer.
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

/** How often the holder asks again: Začínáme's AI step asks every 2 s too. */
export const buddySignInPollMs = 2_000;

// Hermes's Codex worker at v0.22.4-lazurio.1, hermes_cli/web_routers/oauth.py
// (`_codex_full_login_worker`, :303-355). Its poll deadline starts after the
// user code is set, before the start's answer leaves (`_start_codex_device_code`
// waits for that code, :518-543): `expires_in` from then (:245, :316). Its last
// round may begin just before the deadline: one more `poll_interval` asleep
// (:250-253), one poll request, then the token exchange (:332) and the save
// (:339-345).
/** One request of its client: httpx.Timeout(15.0) for each of acquiring a
 * connection, connecting, writing and reading (`_codex_client`, :184-192). */
const hermesRequestMs = 4 * 15_000;
/** The token exchange: `_codex_post`, three tries, 1 s and 2 s apart
 * (:195-213, :278-300). */
const hermesExchangeMs = 3 * hermesRequestMs + 1_000 + 2_000;
/** The save's wait for the auth store's lock: `_save_codex_tokens` through
 * `_provider_state_transaction` (auth.py:847-861), AUTH_LOCK_TIMEOUT_SECONDS
 * (auth_constants.py:52). */
const hermesSaveMs = 15_000;
/** The worker's lag behind the start's answer, and slack. */
const finishingMarginMs = 60_000;
/** For a start whose lifetime or interval had no known shape: the longest
 * lifetime this module takes, and a long interval. */
const fallbackLifetimeSeconds = 3600;
const fallbackIntervalSeconds = 600;

/** How long after Hermes's start answer arrived its worker may still save a
 * sign-in: the code's lifetime and the last round. 1223 s (20 min 23 s) for
 * the recorded 900 s and 5 s. */
export const buddySignInFinishingMs = (
  expiresInSeconds: number,
  pollIntervalSeconds: number,
) =>
  (expiresInSeconds + pollIntervalSeconds) * 1000 +
  hermesRequestMs +
  hermesExchangeMs +
  hermesSaveMs +
  finishingMarginMs;

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

/** A sign-in that may still complete, so nothing changed:
 * `sign-in-finishing` while a session Hermes no longer holds may still save
 * one (try again after a while), `sign-in-running` when Hermes did not
 * confirm a cancel. */
export type BuddySignInRunning = Readonly<{
  kind: "blocked";
  reason: "sign-in-running" | "sign-in-finishing";
}>;

/** Buddy's gateway did not answer: nothing changed. */
export type BuddyGatewayUnavailable = Readonly<{
  kind: "unavailable";
  reason: GatewayFailure;
}>;

export type BuddySignInAnswer =
  | BuddySignInPending
  | Readonly<{ kind: "signed-in" }>
  | Readonly<{ kind: "failed"; reason: BuddySignInFailure }>
  /** No sign-in by this handle (any more). */
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "cancelled" }>
  | BuddySignInRunning
  | BuddyGatewayUnavailable;

export type BuddySignOutAnswer =
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "failed"; reason: "failed" }>
  | BuddySignInRunning
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
  /** The gateway instance that started it. */
  instance: string;
  /** Null for a start of no known shape, shown to nobody and held only until
   * its worker can no longer save. */
  code: string | null;
  url: string;
  /** Wall time the code stops working, for the holder. */
  expiresAt: number;
  /** On the monotonic clock: when its worker can certainly no longer save. */
  finishedBy: number;
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

/** What Hermes said of a cancel. */
type Ending =
  | Readonly<{ kind: "ended" }>
  | BuddySignInRunning
  | BuddyGatewayUnavailable;

const ended: Ending = Object.freeze({ kind: "ended" });
const running: BuddySignInRunning = Object.freeze({
  kind: "blocked",
  reason: "sign-in-running",
});
const finishing: BuddySignInRunning = Object.freeze({
  kind: "blocked",
  reason: "sign-in-finishing",
});

export function createBuddySignIn(
  options: Readonly<{
    gateway: HermesGateway;
    /** Tests only: the wall clock, for the code's end the holder sees. */
    now?: () => number;
    /** Tests only: the monotonic clock every bound is measured on. */
    monotonic?: () => number;
    journal?: (entry: BuddySignInJournalEntry) => void;
  }>,
) {
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
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
      ...(answer.kind === "failed" ? { reason: answer.reason } : {}),
    });
    return answer;
  };
  /** Refused because the held sign-in may still complete: journaled,
   * nothing changed. */
  const refused = <T extends BuddySignInRunning | BuddyGatewayUnavailable>(
    operation: BuddySignInJournalEntry["operation"],
    answer: T,
  ): T => {
    journal({ operation, outcome: answer.kind, reason: answer.reason });
    return answer;
  };
  /** Whether a session Hermes no longer holds can no longer be saved: another
   * gateway instance answers (the worker's process is gone), or its worker's
   * last chance to save has passed. */
  const goneForGood = (session: Session, instance: string) =>
    instance !== session.instance || monotonic() >= session.finishedBy;

  /** Asks Hermes to cancel the session: `ended` only when it confirms the
   * cancel of exactly that session, or holds none by that id and its worker
   * can no longer save. */
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
    const { status, body, instanceId } = answer.value;
    if (status === 200 && isObject(body)) {
      if (body.ok === true && body.session_id === session.hermes) return ended;
      if (body.ok === false && body.message === "session not found")
        return goneForGood(session, instanceId) ? ended : finishing;
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
    const answer = await gateway.request("POST", `${codexPath}/start`);
    const answeredAt = monotonic();
    if (!answer.ok)
      return refused(
        "start",
        Object.freeze({ kind: "unavailable" as const, reason: answer.reason }),
      );
    const failed = (reason: BuddySignInFailure) => {
      journal({ operation: "start", outcome: "failed", reason });
      return Object.freeze({ kind: "failed" as const, reason });
    };
    const { status, body, instanceId } = answer.value;
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
    const interval = body.poll_interval;
    const lifetime = lifetimeKnown ? expiresIn : fallbackLifetimeSeconds;
    const session: Session = {
      handle: randomBytes(16).toString("hex"),
      hermes,
      instance: instanceId,
      code: null,
      url: codexDevicePage,
      expiresAt: now() + lifetime * 1000,
      finishedBy:
        answeredAt +
        buddySignInFinishingMs(
          lifetime,
          typeof interval === "number" &&
            Number.isSafeInteger(interval) &&
            interval > 0
            ? interval
            : fallbackIntervalSeconds,
        ),
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

  /** What one answer of Hermes's poll means for the held sign-in. */
  async function follow(
    session: Session,
    code: string,
    answer: GatewayResult<GatewayAnswer>,
  ): Promise<BuddySignInAnswer> {
    // A gateway that does not answer proves nothing: asked again. After a
    // restart Hermes no longer knows the session, and says so (404).
    if (!answer.ok) return pending(session, code);
    const { status, body, instanceId } = answer.value;
    // Hermes no longer holds it: ended only where its worker cannot save.
    if (status === 404)
      return goneForGood(session, instanceId)
        ? end("poll", { kind: "failed", reason: "lost" })
        : pending(session, code);
    if (status === 200 && isObject(body) && body.session_id === session.hermes)
      switch (body.status) {
        case "pending":
          // Its worker stops at the code's end, after its last round; one
          // Hermes still calls waiting past that is cancelled.
          return monotonic() < session.finishedBy
            ? pending(session, code)
            : endConfirmed(session, code, {
                kind: "failed",
                reason: "expired",
              });
        case "approved":
          return end("poll", { kind: "signed-in" });
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
    /** Přihlásit Buddyho, Nový kód, Přihlásit znovu: a new sign-in, once the
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

    /** Zrušit: Hermes marks its session cancelled under the lock its worker
     * saves under; `cancelled` only once that, or the worker's end, is
     * certain. */
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
