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
// process's until Hermes says it ended, because until then Hermes's worker may
// still save a sign-in the person approves: its poll answers an ending
// (approved, expired, denied, error) or does not know the session (404); or a
// cancel is confirmed (`{ok: true}` for exactly that session) or Hermes holds
// no session by that id (`{ok: false, message: "session not found"}`: one
// cancelled before, one a restart dropped, one its own 15-minute clean-up
// removed). Hermes marks a session cancelled under the lock its worker takes
// to save, so after a confirmed cancel it saves nothing. Anything else (a lost
// or refused answer, a timeout, an answer of no known shape) proves nothing:
// the sign-in stays held and addressable, and whatever needed it ended
// refuses (`blocked`, `sign-in-running`; `unavailable` when the gateway did not
// answer): a new start, a cancel, a sign-out. Pablo's review of #635.
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

/** How long past its code's lifetime Hermes may still say a sign-in waits
 * before it is cancelled: its worker's last round may begin just before the
 * end (`_codex_poll_authorization`), sleep its interval, poll OpenAI and
 * exchange the tokens (`_codex_post`, three tries of 15 s). */
export const buddySignInExpiryGraceMs = 90_000;

/** Hermes's own lifetime of a code (`_CODEX_EXPIRES_IN`), for a sign-in
 * whose start named none of a known shape. */
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

/** A sign-in Hermes did not confirm ended, so nothing changed: it may still
 * complete. */
export type BuddySignInRunning = Readonly<{
  kind: "blocked";
  reason: "sign-in-running";
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
  /** Null for a start of no known shape, shown to nobody and held only until
   * Hermes confirms it ended. */
  code: string | null;
  url: string;
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

/** What Hermes said of a cancel. */
type Ending =
  | Readonly<{ kind: "ended" }>
  | BuddySignInRunning
  | BuddyGatewayUnavailable;

const running: BuddySignInRunning = Object.freeze({
  kind: "blocked",
  reason: "sign-in-running",
});

export function createBuddySignIn(
  options: Readonly<{
    gateway: HermesGateway;
    /** Tests only. */
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
  const ended = (
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
  /** Refused because the held sign-in did not end: journaled, nothing
   * changed. */
  const refused = <T extends BuddySignInRunning | BuddyGatewayUnavailable>(
    operation: BuddySignInJournalEntry["operation"],
    answer: T,
  ): T => {
    journal({ operation, outcome: answer.kind, reason: answer.reason });
    return answer;
  };

  /** Asks Hermes to cancel its session: `ended` only when it confirms the
   * cancel of exactly that session or holds none by that id. */
  async function endOnHermes(hermes: string): Promise<Ending> {
    let answer: GatewayResult<GatewayAnswer>;
    try {
      answer = await gateway.request(
        "DELETE",
        `/api/providers/oauth/sessions/${hermes}`,
      );
    } catch {
      return running;
    }
    if (!answer.ok)
      return Object.freeze({ kind: "unavailable", reason: answer.reason });
    const { status, body } = answer.value;
    if (
      status === 200 &&
      isObject(body) &&
      ((body.ok === true && body.session_id === hermes) ||
        (body.ok === false && body.message === "session not found"))
    )
      return Object.freeze({ kind: "ended" });
    return running;
  }

  async function start(): Promise<BuddySignInAnswer> {
    const before = current;
    if (before !== undefined) {
      // The one before ends first, or nothing starts.
      const ending = await endOnHermes(before.hermes);
      if (ending.kind !== "ended") return refused("start", ending);
      current = undefined;
      journal({
        operation: "cancel",
        outcome: "cancelled",
        reason: "replaced",
      });
    }
    const answer = await gateway.request("POST", `${codexPath}/start`);
    if (!answer.ok)
      return refused(
        "start",
        Object.freeze({ kind: "unavailable" as const, reason: answer.reason }),
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
      // without a holder until Hermes confirms it ended.
      if ((await endOnHermes(hermes)).kind !== "ended") current = session;
      return failed("failed");
    }
    session.code = body.user_code;
    current = session;
    journal({ operation: "start", outcome: "pending" });
    return pending(session, body.user_code);
  }

  /** Ends the held sign-in as `answer` once Hermes confirmed its cancel;
   * otherwise it stays held and still waits for the holder. */
  async function endConfirmed(
    session: Session,
    code: string,
    answer: BuddySignInAnswer,
  ): Promise<BuddySignInAnswer> {
    return (await endOnHermes(session.hermes)).kind === "ended"
      ? ended("poll", answer)
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
    const { status, body } = answer.value;
    if (status === 404)
      return ended("poll", { kind: "failed", reason: "lost" });
    if (status === 200 && isObject(body) && body.session_id === session.hermes)
      switch (body.status) {
        case "pending":
          // Hermes ends its own sign-in at its code's end; one it still
          // calls waiting well past that is cancelled.
          return now() < session.expiresAt + buddySignInExpiryGraceMs
            ? pending(session, code)
            : endConfirmed(session, code, {
                kind: "failed",
                reason: "expired",
              });
        case "approved":
          return ended("poll", { kind: "signed-in" });
        case "expired":
          return ended("poll", { kind: "failed", reason: "expired" });
        case "denied":
          return ended("poll", { kind: "failed", reason: "refused" });
        case "error":
          return ended("poll", {
            kind: "failed",
            reason: refusedByOpenAi(body.error_message) ? "refused" : "failed",
          });
        case "cancelled":
          return ended("poll", { kind: "failed", reason: "lost" });
      }
    // An answer of no known shape: ended only once Hermes confirmed a cancel.
    return endConfirmed(session, code, { kind: "failed", reason: "failed" });
  }

  return Object.freeze({
    /** Přihlásit Buddyho, Nový kód, Přihlásit znovu: a new sign-in, once the
     * one before it ended on Hermes. */
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
     * saves under; `cancelled` only once it confirmed that. */
    cancel: (handle: string) =>
      serial(async (): Promise<BuddySignInAnswer> => {
        const session = current;
        if (session === undefined || session.handle !== handle || !session.code)
          return Object.freeze({ kind: "none" });
        const ending = await endOnHermes(session.hermes);
        if (ending.kind !== "ended") return refused("cancel", ending);
        current = undefined;
        journal({ operation: "cancel", outcome: "cancelled" });
        return Object.freeze({ kind: "cancelled" });
      }),

    /** Odhlásit: Hermes removes Buddy's ChatGPT sign-in (its singleton and
     * its pool entries), only after a held sign-in ended on Hermes, so none
     * can sign him in again; an empty store (Hermes's 409) is signed out
     * too. */
    signOut: () =>
      serial(async (): Promise<BuddySignOutAnswer> => {
        const session = current;
        if (session !== undefined) {
          const ending = await endOnHermes(session.hermes);
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
