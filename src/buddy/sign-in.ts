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
// One sign-in at a time, in this process's memory; a new start cancels the
// one before it on Hermes first, as src/tools/login.ts does. The holder knows
// it by an opaque handle of its own (32 hex characters, the curated logins'
// shape), and Hermes's session id stays here. The one-time code and OpenAI's
// page go only to the holder, and only in their exact shapes: OpenAI's page
// for a sign-in by code (`codexDevicePage`) and a whole code
// (`codexDeviceCode`), the same checks as the agents' "Přihlásit kódem".
// Hermes's own words (`error_message`, `detail`) never leave this module:
// the answer and the journal get a closed reason. The journal names the
// operation, the outcome and the reason, never a code, a handle, a ticket or
// a session.

/** How often the holder asks again: Začínáme's AI step asks every 2 s too. */
export const buddySignInPollMs = 2_000;

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

export type BuddySignInAnswer =
  | BuddySignInPending
  | Readonly<{ kind: "signed-in" }>
  | Readonly<{ kind: "failed"; reason: BuddySignInFailure }>
  /** No sign-in by this handle (any more). */
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "cancelled" }>
  /** Buddy's gateway does not answer: nothing started. */
  | Readonly<{ kind: "unavailable"; reason: GatewayFailure }>;

export type BuddySignOutAnswer =
  | Readonly<{ kind: "signed-out" }>
  | Readonly<{ kind: "failed"; reason: "failed" }>
  | Readonly<{ kind: "unavailable"; reason: GatewayFailure }>;

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
  code: string;
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

  const pending = (session: Session): BuddySignInPending =>
    Object.freeze({
      kind: "pending",
      session: session.handle,
      code: session.code,
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
  /** Cancels Hermes's session; whatever it answers, it is no longer ours. */
  const cancelOnHermes = async (hermes: string) => {
    await gateway
      .request("DELETE", `/api/providers/oauth/sessions/${hermes}`)
      .catch(() => undefined);
  };

  async function start(): Promise<BuddySignInAnswer> {
    const before = current;
    if (before !== undefined) {
      current = undefined;
      await cancelOnHermes(before.hermes);
      journal({
        operation: "cancel",
        outcome: "cancelled",
        reason: "replaced",
      });
    }
    const answer = await gateway.request("POST", `${codexPath}/start`);
    if (!answer.ok) {
      journal({
        operation: "start",
        outcome: "unavailable",
        reason: answer.reason,
      });
      return Object.freeze({ kind: "unavailable", reason: answer.reason });
    }
    const refused = (reason: BuddySignInFailure) => {
      journal({ operation: "start", outcome: "failed", reason });
      return Object.freeze({ kind: "failed" as const, reason });
    };
    const { status, body } = answer.value;
    if (status !== 200 || !isObject(body))
      return refused(
        isObject(body) && refusedByOpenAi(body.detail) ? "refused" : "failed",
      );
    const hermes = body.session_id;
    if (typeof hermes !== "string" || !hermesSessionPattern.test(hermes))
      return refused("failed");
    const expiresIn = body.expires_in;
    if (
      body.verification_url !== codexDevicePage ||
      typeof body.user_code !== "string" ||
      !codexDeviceCode.test(body.user_code) ||
      typeof expiresIn !== "number" ||
      !Number.isSafeInteger(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > 3600
    ) {
      // Never shown, so never left waiting on Hermes either.
      await cancelOnHermes(hermes);
      return refused("failed");
    }
    current = {
      handle: randomBytes(16).toString("hex"),
      hermes,
      code: body.user_code,
      url: codexDevicePage,
      expiresAt: now() + expiresIn * 1000,
    };
    journal({ operation: "start", outcome: "pending" });
    return pending(current);
  }

  /** What one answer of Hermes's poll means for the running session. */
  async function follow(
    session: Session,
    answer: GatewayResult<GatewayAnswer>,
  ): Promise<BuddySignInAnswer> {
    if (!answer.ok)
      // A slow answer is asked again; a gateway that is gone or going took
      // the session with it (it lives in the gateway's memory).
      return answer.reason === "timeout"
        ? pending(session)
        : ended("poll", { kind: "failed", reason: "lost" });
    const { status, body } = answer.value;
    if (status === 404)
      return ended("poll", { kind: "failed", reason: "lost" });
    if (
      status !== 200 ||
      !isObject(body) ||
      body.session_id !== session.hermes
    ) {
      await cancelOnHermes(session.hermes);
      return ended("poll", { kind: "failed", reason: "failed" });
    }
    switch (body.status) {
      case "pending":
        return pending(session);
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
      default:
        await cancelOnHermes(session.hermes);
        return ended("poll", { kind: "failed", reason: "failed" });
    }
  }

  return Object.freeze({
    /** Přihlásit Buddyho, Nový kód, Přihlásit znovu: a new sign-in, the one
     * before it cancelled on Hermes first. */
    start: () => serial(start),

    /** The sign-in of this handle as Hermes has it now; an outcome is
     * answered once, then the handle names none. */
    poll: (handle: string) =>
      serial(async (): Promise<BuddySignInAnswer> => {
        const session = current;
        if (session === undefined || session.handle !== handle)
          return Object.freeze({ kind: "none" });
        if (now() >= session.expiresAt) {
          await cancelOnHermes(session.hermes);
          return ended("poll", { kind: "failed", reason: "expired" });
        }
        return follow(
          session,
          await gateway.request("GET", `${codexPath}/poll/${session.hermes}`),
        );
      }),

    /** Zrušit: Hermes marks its session cancelled before it could save a
     * sign-in. */
    cancel: (handle: string) =>
      serial(async (): Promise<BuddySignInAnswer> => {
        const session = current;
        if (session === undefined || session.handle !== handle)
          return Object.freeze({ kind: "none" });
        current = undefined;
        await cancelOnHermes(session.hermes);
        journal({ operation: "cancel", outcome: "cancelled" });
        return Object.freeze({ kind: "cancelled" });
      }),

    /** Odhlásit: Hermes removes Buddy's ChatGPT sign-in (its singleton and
     * its pool entries); a running sign-in is cancelled first, so it cannot
     * sign him in again. An empty store (Hermes's 409) is signed out too. */
    signOut: () =>
      serial(async (): Promise<BuddySignOutAnswer> => {
        const session = current;
        if (session !== undefined) {
          current = undefined;
          await cancelOnHermes(session.hermes);
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
