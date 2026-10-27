import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { qrMatrix, qrSvg } from "../tools/qr";
import { buddyStateDirectory, writeBuddyStateFile } from "./gateway-refresh";
import type {
  GatewayAnswer,
  GatewayFailure,
  GatewayResult,
  HermesGateway,
} from "./hermes-gateway";
import type { TelegramFollowUp } from "./telegram-restart";

// Buddy on Telegram (decision F66, plan DEV-6676 PR 5; root decision 0207
// with its addendum of 2026-10-18: every Buddy has his own bot, which his
// person creates at @BotFather). The Launchpad connects that bot to Buddy's
// gateway through Hermes's own writers, over the one client of F63
// (hermes-gateway.ts), and reads its state live from Hermes, never from a
// copy of its own (Lazurio/hermes-agent v0.22.4-lazurio.3):
//
//   read        GET  /api/messaging/platforms         the platform's card
//               GET  /api/pairing                     who asked to talk
//   connect     PUT  /api/messaging/platforms/telegram  {env: {TELEGRAM_BOT_TOKEN}, enabled: true}
//               PUT  /api/config                      the installer's quiet keys
//               PUT  /api/config                      Buddy's words to an unknown account
//   persona     PUT  /api/config                      the same words, after a change
//   approve     PUT  /api/env                         {key: TELEGRAM_HOME_CHANNEL}
//               POST /api/pairing/approve             {platform, request_id}
//               PUT  /api/messaging/platforms/telegram  {env: {TELEGRAM_ALLOWED_USERS}}
//   disconnect  PUT  /api/messaging/platforms/telegram  {enabled: false, clear_env}
//               DELETE /api/env                       {key: TELEGRAM_HOME_CHANNEL}, once
//
// - The token. Its shape is Hermes's own rule (`plugins/platforms/telegram/
//   dashboard_card.py` `_BOT_TOKEN_RE`), bounded. Before anything is saved,
//   Telegram itself says whose token it is (`getMe`): a bot Telegram does not
//   know is never saved, since a gateway whose only platform is refused at
//   its start exits with 78, which the unit `hermes gateway install` writes
//   parks for good (`RestartPreventExitStatus=78`, `gateway/run_startup.py`
//   `_start_handle_no_connections`), and with it Buddy's chat and these
//   routes. getMe also names the bot, which Hermes's card does not. The
//   token lives in this process only for the one connect: never written,
//   logged, answered or kept. The bot's username is kept beside a digest of
//   Hermes's own display-only preview of the token, and shown only while
//   Hermes still holds a token of that preview.
// - The person's account. A bot with a token and no allowlist answers an
//   unknown account with a pairing code and denies it (`gateway/config.py`
//   `unauthorized_dm_behavior` "pair", `gateway/authz_mixin.py`). The page
//   lists who asked (`GET /api/pairing`, by an opaque handle of this process,
//   never Hermes's request id or the account's id) and asks "Je to váš účet
//   …?". The approval ends as the interim installer's: the allowlist
//   `TELEGRAM_ALLOWED_USERS` is that account, which also stops pairing codes
//   for anyone else (`allowlist_suppresses_pairing`), and the home channel
//   `TELEGRAM_HOME_CHANNEL` too (where Hermes's own messages go, a cron
//   job's among them). Hermes's approval alone writes neither while no
//   allowlist exists (`gateway/pairing.py` `_sync_allowlist_add`). The
//   allowlist goes last, after the home channel and Hermes's approval: the
//   state reads connected only once it is there, and until then the account
//   stays offered (by Hermes's request, or by its approval the allowlist does
//   not name yet), so a write that failed halfway is finished by pressing
//   "Ano" again. Delegace reads the allowlist, never the home channel, from
//   `~/.hermes/.env` on each notice (`telegram_target`), so a Telegram
//   connected later reaches it with no restart. An account already approved
//   in Hermes's pairing store and not in the allowlist (a reconnect, or an
//   approval from a terminal) is offered the same way.
// - The installer's quiet keys (no tool progress, no long-running
//   heartbeat, no autoraise notice, no warning or restart notices, keep the
//   messages that arrived while the gateway was down) are written at the
//   connect, before the restart that reads them, through Hermes's own
//   config writer. The installer writes the same values on every run.
// - Buddy's words to an account his bot does not know yet. Upstream's reply
//   to it (`gateway.pairing.code_reply`) tells the person, in English, to
//   run `hermes pairing approve` in a terminal, while the page approves. A
//   gateway that lists `lazurio-pairing-message-v1` (Lazurio/hermes-agent#19,
//   `gateway/lazurio_pairing_message.py`) replies with the text of
//   `gateway.unauthorized_dm_pairing_message` instead, read from its
//   config.yaml when it replies. The connect writes his words there, in his
//   address and the Folder's language, through Hermes's own config writer,
//   and a change of his persona writes them again while his bot is connected
//   from here. They ask the person to confirm in Lazurio and write again:
//   Hermes says nothing once the page approves. An older Hermes is not asked
//   and keeps its own reply, and connecting works the same.
// - The restart that brings the token in, or takes it out, is
//   telegram-restart.ts's. A disconnect owes it as soon as Hermes has the
//   bot off, whatever its cleanup does after. Then it asks Hermes once to
//   remove the home channel, and nothing asks again: Hermes's DELETE removes
//   whatever is there, and one that timed out here may still run in Hermes
//   later, so a second one could remove a newer approval's home channel.
//   That one DELETE cannot: Hermes serves these calls in the gateway's own
//   process (F63), and an approval goes through only once the restart its
//   connect owes is done (the page offers it only then, and `approve`
//   answers „Připojuje se…“ before), so it reaches a gateway that started
//   after the DELETE was sent. A home channel Hermes did not remove
//   stays. While Telegram is off it is inert (no token, no allowlist, the
//   platform off), and the next approval writes its own over it. Everything
//   else here takes effect at once.
// - A write that ends without a clear answer may still run in Hermes after
//   a newer one (F66 point 13). It owes a restart, and until the gateway
//   that took it is gone no Telegram change goes to Hermes (`blocked`):
//   Hermes reads these files only when the gateway starts, so nothing is
//   lost by waiting. The latest change is kept: a connect answers `held`,
//   and only the page keeps its token, sending it once when a reading says
//   `retry`; a disconnect is kept in `telegram-intent.json` and made by the
//   follow-up (`cleared`) after the restart. Either replaces the other; an
//   approval and his words wait too.
//
// Hermes's own words (`message`, `error_message`, `detail`) never leave this
// module; its answers become a closed state. The journal names the
// operation, the outcome and the reason: never the token, a preview, an
// account, a name, a request or a handle.

const platformPath = "/api/messaging/platforms/telegram";
const platformsPath = "/api/messaging/platforms";
const pairingPath = "/api/pairing";

/** A BotFather token: the bot's numeric id, a colon and its secret, as
 * Hermes checks it, with an upper bound. */
export const botTokenShape = /^\d{1,20}:[A-Za-z0-9_-]{30,200}$/;
/** A Telegram username: 5 to 32 characters, a letter first. */
const botUsernameShape = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const telegramId = /^\d{1,20}$/;
const requestIdShape = /^[0-9a-fA-F]{16}$/;
/** The page's handle of an account that asked. */
export const isTelegramRequestHandle = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

/** The installer's quiet keys of Telegram (`buddy-install.sh` step 7):
 * only Buddy's own words reach the person. */
export const telegramQuietConfig = Object.freeze({
  display: Object.freeze({
    platforms: Object.freeze({
      telegram: Object.freeze({
        tool_progress: false,
        long_running_notifications: false,
        suppress_warning_notifications: true,
      }),
    }),
  }),
  compression: Object.freeze({ codex_gpt55_autoraise_notice: false }),
  platforms: Object.freeze({
    telegram: Object.freeze({
      gateway_restart_notification: false,
      extra: Object.freeze({ drop_pending_on_cold_boot: false }),
    }),
  }),
});

/** Hermes's configurable reply to an account it does not know
 * (Lazurio/hermes-agent#19, `gateway/lazurio_pairing_message.py`): a ready
 * gateway that lists `capability` replies with the text of `key` in the
 * `gateway:` section of its config.yaml, read when it replies. */
export const pairingMessage = Object.freeze({
  capability: "lazurio-pairing-message-v1",
  key: "unauthorized_dm_pairing_message",
});

// ---- Telegram's own word on a token ------------------------------------------

/** What Telegram says of a token: a bot and its username, a token it does
 * not know, or nothing usable (no answer, a timeout, its flood limit). */
export type BotCheck =
  | Readonly<{ kind: "bot"; username: string }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unreachable" }>;

export type BotChecker = (token: string) => Promise<BotCheck>;

export const telegramApiOrigin = "https://api.telegram.org";

const refusedCheck: BotCheck = Object.freeze({ kind: "refused" });
const unreachableCheck: BotCheck = Object.freeze({ kind: "unreachable" });

/** At most `limit` bytes of an answer, or null for a larger one. */
async function boundedText(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Telegram's `getMe` for a token: the one call that tells a bot's token
 * from anything else before it is saved. The token is in the path, as the
 * Bot API takes it; the URL is never logged and a failure is never passed
 * on. No redirect is followed. */
export function telegramBotChecker(
  options: Readonly<{
    origin?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }> = {},
): BotChecker {
  const origin = options.origin ?? telegramApiOrigin;
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (token) => {
    if (!botTokenShape.test(token)) return refusedCheck;
    let response: Response;
    try {
      response = await fetcher(`${origin}/bot${token}/getMe`, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return unreachableCheck;
    }
    let body: unknown;
    try {
      const text = await boundedText(response, 64 * 1024);
      body = text === null ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    // The Bot API's own answers for a token it does not know.
    if (response.status === 401 || response.status === 404) return refusedCheck;
    if (
      response.status !== 200 ||
      !isObject(body) ||
      body.ok !== true ||
      !isObject(body.result)
    )
      return unreachableCheck;
    const { is_bot, username } = body.result;
    if (is_bot !== true) return refusedCheck;
    return typeof username === "string" && botUsernameShape.test(username)
      ? Object.freeze({ kind: "bot", username })
      : unreachableCheck;
  };
}

// ---- What Hermes says ----------------------------------------------------------

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Telegram's card in Hermes's `GET /api/messaging/platforms`. Its
 * allowlist and its preview of the token stay in this module. */
export type TelegramCard = Readonly<{
  enabled: boolean;
  configured: boolean;
  /** The running gateway's state of the platform (`connected`,
   * `retrying`, `fatal`, `pending_restart`, ...), Hermes's word. */
  runtime: string | null;
  errorCode: string | null;
  /** Whether the allowlist holds anything at all. */
  allowlisted: boolean;
  /** The numeric accounts it holds. */
  allowed: readonly string[];
  /** Hermes's display-only preview of the token. */
  preview: string | null;
}>;

/** The card of Hermes's answer; null for any other shape. */
export function telegramCardOf(body: unknown): TelegramCard | null {
  if (!isObject(body) || !Array.isArray(body.platforms)) return null;
  const found = body.platforms.filter(
    (platform) => isObject(platform) && platform.id === "telegram",
  );
  if (found.length !== 1) return null;
  const card = found[0] as Json;
  if (typeof card.enabled !== "boolean" || typeof card.configured !== "boolean")
    return null;
  const variables = Array.isArray(card.env_vars)
    ? card.env_vars.filter(isObject)
    : [];
  const variable = (key: string) =>
    variables.find((entry) => entry.key === key);
  const list = variable("TELEGRAM_ALLOWED_USERS");
  const raw = typeof list?.value === "string" ? list.value : "";
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const preview = variable("TELEGRAM_BOT_TOKEN")?.redacted_value;
  return Object.freeze({
    enabled: card.enabled,
    configured: card.configured,
    runtime: typeof card.state === "string" ? card.state : null,
    errorCode: typeof card.error_code === "string" ? card.error_code : null,
    allowlisted: entries.length > 0 || list?.is_set === true,
    allowed: Object.freeze(entries.filter((entry) => telegramId.test(entry))),
    preview: typeof preview === "string" && preview !== "" ? preview : null,
  });
}

/** An account that asked to talk to the bot, or one Hermes approved that the
 * allowlist does not name. */
type Candidate = Readonly<{
  handle: string;
  name: string;
  userId: string;
  /** Hermes's pending request, when there is one to approve. */
  requestId?: string;
  ageMinutes: number;
}>;

/** A name as Telegram gave it (the account's username, else its full name):
 * no control character, at most 64 characters. */
const shownName = (value: unknown): string =>
  typeof value === "string"
    ? [...value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim()]
        .slice(0, 64)
        .join("")
    : "";

/** Who asked, from Hermes's `GET /api/pairing`: its pending requests of
 * Telegram, newest first, then accounts it approved that the allowlist does
 * not name. One entry per account. */
function candidatesOf(
  body: unknown,
  card: TelegramCard,
  handleOf: (kind: string, id: string) => string,
): Candidate[] {
  if (!isObject(body)) return [];
  const seen = new Set<string>(card.allowed);
  const result: Candidate[] = [];
  const pending = Array.isArray(body.pending)
    ? body.pending.filter(isObject)
    : [];
  const sorted = [...pending].sort(
    (left, right) =>
      Number(left.age_minutes ?? 0) - Number(right.age_minutes ?? 0),
  );
  for (const entry of sorted) {
    const requestId = entry.request_id;
    const userId = String(entry.user_id ?? "");
    if (
      entry.platform !== "telegram" ||
      typeof requestId !== "string" ||
      !requestIdShape.test(requestId) ||
      !telegramId.test(userId) ||
      seen.has(userId)
    )
      continue;
    seen.add(userId);
    const age = Number(entry.age_minutes);
    result.push(
      Object.freeze({
        handle: handleOf("pending", requestId.toLowerCase()),
        name: shownName(entry.user_name),
        userId,
        requestId: requestId.toLowerCase(),
        ageMinutes: Number.isFinite(age) && age >= 0 ? Math.floor(age) : 0,
      }),
    );
  }
  const approved = Array.isArray(body.approved)
    ? body.approved.filter(isObject)
    : [];
  for (const entry of approved) {
    const userId = String(entry.user_id ?? "");
    if (
      entry.platform !== "telegram" ||
      !telegramId.test(userId) ||
      seen.has(userId)
    )
      continue;
    seen.add(userId);
    result.push(
      Object.freeze({
        handle: handleOf("approved", userId),
        name: shownName(entry.user_name),
        userId,
        ageMinutes: 0,
      }),
    );
  }
  return result.slice(0, 5);
}

// ---- The state ------------------------------------------------------------------

export type TelegramState =
  /** No token, or the platform switched off. */
  | "none"
  /** On its way: a restart owed, Telegram connecting or retrying. */
  | "starting"
  /** Telegram runs and nobody is allowed yet: the person presses Start. */
  | "waiting"
  /** Telegram runs and the person's account is allowed. */
  | "connected"
  /** Telegram refused the bot at its start. */
  | "failed"
  /** Hermes could not be asked. */
  | "unknown";

/** Why Telegram did not start: a token it no longer takes (`refused`),
 * another program polling the same bot (`conflict`), or anything else. */
export type TelegramFailure = "refused" | "conflict" | "failed";

export type TelegramRequestView = Readonly<{
  /** The page's handle of the request. */
  request: string;
  /** The account's name as Telegram gave it; empty without one. */
  name: string;
}>;

/** What `GET /api/buddy` says of Telegram. */
export type TelegramStatus = Readonly<{
  state: TelegramState;
  reason?: TelegramFailure;
  /** The bot's username, without @, where this Launchpad saw it. */
  bot?: string;
  /** Its `https://t.me/<bot>` as a QR code (an SVG), while the person still
   * has to open it. */
  botQr?: string;
  /** Who asked, while it waits. */
  requests?: readonly TelegramRequestView[];
  /** A restart that brings the change in waits for Buddy to be idle. */
  pending?: true;
  /** A write without a clear answer waits for that restart: nothing goes to
   * Hermes until then, and the latest change waits with it. */
  held?: true;
  /** The connect that waited may go now: the page that keeps its token
   * sends it once more. */
  retry?: true;
}>;

/** The state from Hermes's card: a pure function. A restart owed means the
 * gateway still runs what it read before the change, whatever its card
 * says of the platform. */
export function telegramStatusOf(
  card: TelegramCard | null,
  facts: Readonly<{
    owed: boolean;
    requests?: readonly TelegramRequestView[];
    bot?: string | undefined;
  }>,
): TelegramStatus {
  if (card === null) return Object.freeze({ state: "unknown" });
  const pending = facts.owed ? ({ pending: true } as const) : {};
  if (!card.configured || !card.enabled)
    return Object.freeze({ state: "none", ...pending });
  const bot = facts.bot === undefined ? {} : { bot: facts.bot };
  if (facts.owed)
    return Object.freeze({ state: "starting", ...bot, pending: true });
  if (card.runtime === "fatal")
    return Object.freeze({
      state: "failed",
      reason:
        card.errorCode === "telegram_auth_error"
          ? "refused"
          : card.errorCode === "telegram_polling_conflict"
            ? "conflict"
            : "failed",
      ...bot,
    });
  if (card.runtime === "connected")
    return card.allowlisted
      ? Object.freeze({ state: "connected", ...bot })
      : Object.freeze({
          state: "waiting",
          ...bot,
          requests: Object.freeze([...(facts.requests ?? [])]),
        });
  // Connecting, retrying after Telegram's flood limit or a timeout, not yet
  // started: on its way, never an error.
  return Object.freeze({ state: "starting", ...bot });
}

// ---- The bot's username, beside Hermes's preview ----------------------------------

/** The bot this Launchpad connected: its username and a digest of Hermes's
 * preview of its token, never the token. 0600 in Buddy's state directory. */
export const telegramBotPath = (home: string): string =>
  join(buddyStateDirectory(home), "telegram-bot.json");

const botSchema = "lazurio.buddy-telegram-bot.v1";

const previewDigest = (preview: string) =>
  createHash("sha256").update(preview).digest("hex");

async function readBotRecord(
  home: string,
): Promise<Readonly<{ username: string; preview: string }> | null> {
  try {
    const handle = await open(
      telegramBotPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) return null;
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const record: unknown = JSON.parse(text);
    return isObject(record) &&
      record.schema_version === botSchema &&
      typeof record.username === "string" &&
      botUsernameShape.test(record.username) &&
      typeof record.preview_sha256 === "string"
      ? { username: record.username, preview: record.preview_sha256 }
      : null;
  } catch {
    return null;
  }
}

// ---- The latest intent while a write is in doubt --------------------------------

/** A disconnect asked while a write was in doubt: done once its restart is.
 * No secret: `{intent: "disconnect", at}`, 0600 in Buddy's state directory. */
export const telegramIntentPath = (home: string): string =>
  join(buddyStateDirectory(home), "telegram-intent.json");

const intentSchema = "lazurio.buddy-telegram-intent.v1";

async function readIntent(home: string): Promise<"disconnect" | null> {
  try {
    const handle = await open(
      telegramIntentPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) return null;
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const record: unknown = JSON.parse(text);
    return isObject(record) &&
      record.schema_version === intentSchema &&
      record.intent === "disconnect"
      ? "disconnect"
      : null;
  } catch {
    return null;
  }
}

/** How long, after the barrier lifted, the page may send the token of the
 * connect that waited. */
export const telegramRetryWindowMs = 10 * 60_000;

// ---- The core -------------------------------------------------------------------

export type TelegramJournalEntry = Readonly<{
  operation:
    | "connect"
    | "approve"
    | "disconnect"
    | "pairing-text"
    | "home-channel";
  outcome: string;
  reason?: string;
}>;

/** A connect that did not happen: a token of no bot's shape (`invalid`),
 * one Telegram does not know (`token-refused`), Telegram not answering
 * (`telegram-unreachable`), or Hermes not taking it (`failed`). */
export type TelegramConnectFailure =
  | "token-refused"
  | "telegram-unreachable"
  | "failed";

export type TelegramAnswer =
  | (Readonly<{ kind: "telegram" }> & TelegramStatus)
  | Readonly<{ kind: "invalid"; reason: "invalid-token" }>
  | Readonly<{ kind: "failed"; reason: TelegramConnectFailure }>
  /** The request is no longer there (it expired, or another approval took
   * it): nothing changed. */
  | Readonly<{ kind: "blocked"; reason: "request-gone" }>
  | Readonly<{ kind: "unavailable"; reason: GatewayFailure }>;

export type BuddyTelegram = ReturnType<typeof createBuddyTelegram>;

export function createBuddyTelegram(
  input: Readonly<{
    gateway: HermesGateway;
    /** The account's home, for the bot's record. */
    home: string | undefined;
    /** Whether a restart the last change owes still waits. */
    owed: () => boolean;
    /** Whether that restart was made a moment ago: the gateway may still be
     * starting. */
    restartedRecently?: (() => boolean) | undefined;
    /** The change is made in Hermes: its restart is asked for. */
    changed: () => Promise<unknown>;
    /** A write ended without a clear answer: its restart is owed, and the
     * barrier holds until it is made. */
    uncertain: () => Promise<unknown>;
    /** Whether that barrier holds: no Telegram change goes to Hermes. */
    blocked: () => Promise<boolean>;
    /** Tests only: the clock, in milliseconds since the epoch. */
    now?: (() => number) | undefined;
    /** Tests only: Telegram's word on a token. */
    checkBot?: BotChecker | undefined;
    /** Buddy's words to an account his bot does not know yet: his persona,
     * in the Folder's language; undefined where they cannot be read. */
    pairingText?: (() => Promise<string | undefined>) | undefined;
    journal?: ((entry: TelegramJournalEntry) => void) | undefined;
  }>,
) {
  const { gateway } = input;
  const checkBot = input.checkBot ?? telegramBotChecker();
  // The handles of this process: a request's handle names it to this
  // process alone, and Hermes's id stays here.
  const key = randomBytes(32);
  const handleOf = (kind: string, id: string) =>
    createHmac("sha256", key)
      .update(`${kind}:${id}`)
      .digest("hex")
      .slice(0, 32);
  const home = input.home;
  const journal = (entry: TelegramJournalEntry) => {
    try {
      input.journal?.(entry);
    } catch {}
  };
  // What this process last asked of Hermes: while the restart it owes runs,
  // and the gateway starts again after it, Hermes cannot be asked, and the
  // change is on its way, not unknown.
  let intent: "connect" | "disconnect" | null = null;
  const now = input.now ?? Date.now;
  // The latest change asked while a write was in doubt; a disconnect is on
  // disk too (`telegram-intent.json`), a connect only here and in the page
  // that keeps its token.
  let latest: "connect" | "disconnect" | null = null;
  // Until when the page may send that connect's token once more.
  let retryUntil = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };

  const ask = (
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: Readonly<Record<string, unknown>>,
    capability?: string,
  ): Promise<GatewayResult<GatewayAnswer>> =>
    gateway
      .request(method, path, {
        ...(body === undefined ? {} : { body }),
        ...(capability === undefined ? {} : { capability }),
      })
      .catch(
        (): GatewayResult<GatewayAnswer> =>
          Object.freeze({ ok: false, reason: "invalid-answer" }),
      );

  /** A write of Hermes's. One that ends without a clear answer may still
   * run in Hermes later, in the gateway that took it, after a newer write:
   * so it owes a restart, as a change does, and every Telegram change waits
   * for that restart (`blocked`). A restart ends the gateway that may still run it. Every
   * Telegram write goes through here but the disconnect's one DELETE,
   * whose restart is owed before it is sent. */
  const write = async (
    operation: TelegramJournalEntry["operation"],
    method: "PUT" | "POST",
    path: string,
    body: Readonly<Record<string, unknown>>,
    capability?: string,
  ): Promise<GatewayResult<GatewayAnswer>> => {
    const answer = await ask(method, path, body, capability);
    if (!answer.ok && answer.uncertain === true) {
      journal({ operation, outcome: "restart-owed", reason: answer.reason });
      await input.uncertain().catch(() => undefined);
    }
    return answer;
  };

  async function card(): Promise<GatewayResult<TelegramCard | null>> {
    const answer = await ask("GET", platformsPath);
    if (!answer.ok) return answer;
    return Object.freeze({
      ok: true,
      value:
        answer.value.status === 200 ? telegramCardOf(answer.value.body) : null,
    });
  }

  async function candidates(found: TelegramCard): Promise<Candidate[]> {
    const answer = await ask("GET", pairingPath);
    return answer.ok && answer.value.status === 200
      ? candidatesOf(answer.value.body, found, handleOf)
      : [];
  }

  /** The bot's username, while Hermes still holds a token of the preview it
   * was recorded with. */
  async function botOf(found: TelegramCard): Promise<string | undefined> {
    if (home === undefined || found.preview === null) return undefined;
    const record = await readBotRecord(home);
    return record !== null && record.preview === previewDigest(found.preview)
      ? record.username
      : undefined;
  }

  async function status(): Promise<TelegramStatus> {
    const disconnecting = await disconnectWaits();
    // A write in doubt: the latest change waits with it, whatever Hermes's
    // card says until the restart. A connect that waited stays so until the
    // follow-up asks the page for its token, so no reading between the lift
    // and the follow-up tells the page to forget it.
    if ((await input.blocked()) || (home !== undefined && latest === "connect"))
      return Object.freeze(
        disconnecting
          ? { state: "none", pending: true, held: true }
          : { state: "starting", pending: true, held: true },
      );
    // A disconnect that waited, being made now.
    if (disconnecting) return Object.freeze({ state: "none", pending: true });
    const view = await reading();
    return retryUntil > now() ? Object.freeze({ ...view, retry: true }) : view;
  }

  /** Telegram as Hermes's card has it. */
  async function reading(): Promise<TelegramStatus> {
    const read = await card();
    if (!read.ok || read.value === null) {
      const owed = input.owed();
      if (
        intent !== null &&
        !(read.ok === false && read.reason === "unsafe-path") &&
        (owed || input.restartedRecently?.() === true)
      )
        return Object.freeze({
          state: intent === "disconnect" ? "none" : "starting",
          ...(owed ? { pending: true as const } : {}),
        });
      return Object.freeze({ state: "unknown" });
    }
    const found = read.value;
    const owed = input.owed();
    const bot = await botOf(found);
    const waiting =
      !owed &&
      found.configured &&
      found.enabled &&
      found.runtime === "connected" &&
      !found.allowlisted;
    const requests = waiting
      ? (await candidates(found)).map((candidate) =>
          Object.freeze({ request: candidate.handle, name: candidate.name }),
        )
      : undefined;
    const view = telegramStatusOf(found, {
      owed,
      ...(requests === undefined ? {} : { requests }),
      bot,
    });
    // The bot's address as a code to scan, while the person still opens it.
    if (
      view.bot !== undefined &&
      (view.state === "starting" || view.state === "waiting")
    )
      return Object.freeze({
        ...view,
        botQr: qrSvg(qrMatrix(`https://t.me/${view.bot}`)),
      });
    return view;
  }

  // The words Hermes last took from this process: a change of the persona
  // writes them again only when they changed.
  let pairingWritten: string | undefined;

  /** Buddy's words to an account his bot does not know, through Hermes's
   * config writer, and only to a gateway that honours them. Never a reason
   * for anything else to fail: the journal says how it went. */
  async function writePairingText(always: boolean): Promise<void> {
    if (input.pairingText === undefined) return;
    const text = await input.pairingText().catch(() => undefined);
    const line = (outcome: string, reason?: string) =>
      journal({
        operation: "pairing-text",
        outcome,
        ...(reason === undefined ? {} : { reason }),
      });
    if (text === undefined) return line("unknown");
    if (!always && text === pairingWritten) return;
    // A write in doubt: the words wait, and its lift writes them again.
    if (await input.blocked()) return line("held");
    const written = await write(
      "pairing-text",
      "PUT",
      "/api/config",
      { config: { gateway: { [pairingMessage.key]: text } } },
      pairingMessage.capability,
    );
    // An older Hermes: its own reply stays, and nothing was sent.
    if (!written.ok && written.reason === "outdated") return line("outdated");
    if (!written.ok) return line("unavailable", written.reason);
    if (written.value.status !== 200) return line("failed");
    pairingWritten = text;
    line("written");
  }

  /** The latest change, kept while a write is in doubt: nothing goes to
   * Hermes. A connect is kept here (its token only in the page), a
   * disconnect on disk too; either replaces the other. The answer is the
   * state, which says `held` for a connect that waits until the follow-up,
   * queued after this, asks the page for its token: so a lift after this
   * connect looked at the barrier loses nothing. */
  async function hold(kind: "connect" | "disconnect"): Promise<TelegramAnswer> {
    latest = kind;
    retryUntil = 0;
    if (home !== undefined)
      await (kind === "disconnect"
        ? writeBuddyStateFile(telegramIntentPath(home), {
            schema_version: intentSchema,
            intent: "disconnect",
            at: new Date(now()).toISOString(),
          })
        : rm(telegramIntentPath(home), { force: true })
      ).catch(() => undefined);
    journal({ operation: kind, outcome: "held", reason: "restart-owed" });
    return telegram();
  }

  /** A disconnect asked while a write was in doubt and not made yet. With
   * no home known nothing waits: no barrier, no restart (the documented
   * exception). */
  const disconnectWaits = async (): Promise<boolean> =>
    home !== undefined &&
    (latest === "disconnect" || (await readIntent(home)) === "disconnect");

  /** The latest change is made: nothing waits any longer. */
  async function settleIntent(): Promise<void> {
    latest = null;
    retryUntil = 0;
    if (home !== undefined)
      await rm(telegramIntentPath(home), { force: true }).catch(
        () => undefined,
      );
  }

  /** A write of an approval ended in doubt: its restart is owed, and the
   * page shows Telegram as it is until then. */
  async function doubted(): Promise<TelegramAnswer> {
    journal({ operation: "approve", outcome: "held", reason: "restart-owed" });
    return telegram();
  }

  const unavailable = (reason: GatewayFailure): TelegramAnswer =>
    Object.freeze({ kind: "unavailable", reason });
  const failed = (reason: TelegramConnectFailure): TelegramAnswer =>
    Object.freeze({ kind: "failed", reason });
  const telegram = async (): Promise<TelegramAnswer> =>
    Object.freeze({ kind: "telegram", ...(await status()) });

  async function connect(token: string): Promise<TelegramAnswer> {
    const end = (answer: TelegramAnswer): TelegramAnswer => {
      journal({
        operation: "connect",
        outcome: answer.kind,
        ...("reason" in answer && answer.kind !== "telegram"
          ? { reason: answer.reason }
          : {}),
      });
      return answer;
    };
    if (!botTokenShape.test(token))
      return end(Object.freeze({ kind: "invalid", reason: "invalid-token" }));
    const bot = await checkBot(token);
    if (bot.kind === "refused") return end(failed("token-refused"));
    if (bot.kind === "unreachable") return end(failed("telegram-unreachable"));
    // A write in doubt: nothing goes to Hermes until its restart. This
    // connect is the latest change; the page keeps its token and sends it
    // once more when the reading says `retry`.
    if (await input.blocked()) return hold("connect");
    // Hermes's own writer: the token into its `.env` (its mode kept, 0600
    // for a new file), `platforms.telegram.enabled: true` into its
    // config.yaml, explicitly, so a token saved by any other way ends the
    // same. Its audit line names the keys, never a value.
    const saved = await write("connect", "PUT", platformPath, {
      env: { TELEGRAM_BOT_TOKEN: token },
      enabled: true,
    });
    if (!saved.ok)
      return saved.uncertain === true
        ? hold("connect")
        : end(unavailable(saved.reason));
    if (saved.value.status === 400) return end(failed("token-refused"));
    if (saved.value.status !== 200) return end(failed("failed"));
    intent = "connect";
    // The latest change is made: a disconnect that waited goes.
    await settleIntent();
    // The quiet keys before the restart that reads them; a connect without
    // them still connects, and the journal says so.
    const quiet = await write("connect", "PUT", "/api/config", {
      config: telegramQuietConfig,
    });
    if (!quiet.ok || quiet.value.status !== 200)
      journal({ operation: "connect", outcome: "quiet", reason: "failed" });
    // His words for the person's Start, where Hermes honours them.
    await writePairingText(true);
    // The bot's username beside Hermes's preview of what it saved now.
    const after = await card();
    if (home !== undefined && after.ok && after.value?.preview)
      await writeBuddyStateFile(telegramBotPath(home), {
        schema_version: botSchema,
        username: bot.username,
        preview_sha256: previewDigest(after.value.preview),
      }).catch(() => undefined);
    await input.changed().catch(() => undefined);
    return end(await telegram());
  }

  async function approve(handle: string): Promise<TelegramAnswer> {
    const end = (answer: TelegramAnswer): TelegramAnswer => {
      journal({
        operation: "approve",
        outcome: answer.kind,
        ...("reason" in answer && answer.kind !== "telegram"
          ? { reason: answer.reason }
          : {}),
      });
      return answer;
    };
    // Only once the restart the last change owes is done, as the page
    // offers it, or the one a write owes that ended without a clear answer:
    // the approval then reaches a gateway that started after both, so no
    // write an earlier gateway took (a disconnect's DELETE, an earlier
    // approval's home channel) can still run after it. Nor while a
    // disconnect that waited is not made yet: it is the latest change. A
    // page from before (another tab) gets the state as it is, „Připojuje
    // se…“, and nothing is written.
    if ((await input.blocked()) || input.owed() || (await disconnectWaits())) {
      journal({
        operation: "approve",
        outcome: "pending",
        reason: "restart-owed",
      });
      return telegram();
    }
    const read = await card();
    if (!read.ok) return end(unavailable(read.reason));
    if (read.value === null) return end(failed("failed"));
    const candidate = (await candidates(read.value)).find(
      (entry) => entry.handle === handle,
    );
    if (candidate === undefined)
      return end(Object.freeze({ kind: "blocked", reason: "request-gone" }));
    // The home channel first: a private chat's id is its account's
    // (`hermes_cli/setup_platforms.py`), written by Hermes in this gateway's
    // own process, so its next turn sees it. It replaces any home channel a
    // disconnect left.
    const channel = await write("approve", "PUT", "/api/env", {
      key: "TELEGRAM_HOME_CHANNEL",
      value: candidate.userId,
    });
    if (!channel.ok)
      return channel.uncertain === true
        ? doubted()
        : end(unavailable(channel.reason));
    if (channel.value.status !== 200) return end(failed("failed"));
    // Then Hermes's own approval, which takes the request off its list. One
    // that expired meanwhile (404) leaves nothing to approve.
    if (candidate.requestId !== undefined) {
      const approval = await write("approve", "POST", "/api/pairing/approve", {
        platform: "telegram",
        request_id: candidate.requestId,
      });
      if (!approval.ok)
        return approval.uncertain === true
          ? doubted()
          : end(unavailable(approval.reason));
      if (approval.value.status !== 200 && approval.value.status !== 404)
        return end(failed("failed"));
    }
    // The allowlist last: it lets the account in, keeps everyone else out,
    // is what Delegace reads, and is what the state reads as connected. A
    // write that failed before it leaves the account offered, so "Ano"
    // finishes it.
    const allowed = await write("approve", "PUT", platformPath, {
      env: { TELEGRAM_ALLOWED_USERS: candidate.userId },
    });
    if (!allowed.ok)
      return allowed.uncertain === true
        ? doubted()
        : end(unavailable(allowed.reason));
    if (allowed.value.status !== 200) return end(failed("failed"));
    return end(await telegram());
  }

  async function disconnect(): Promise<TelegramAnswer> {
    // A write in doubt: nothing goes to Hermes until its restart. This
    // disconnect is the latest change, kept on disk and made after it.
    if (await input.blocked()) return hold("disconnect");
    return disconnectNow();
  }

  /** The disconnect's writes. */
  async function disconnectNow(): Promise<TelegramAnswer> {
    const end = (answer: TelegramAnswer): TelegramAnswer => {
      journal({
        operation: "disconnect",
        outcome: answer.kind,
        ...("reason" in answer && answer.kind !== "telegram"
          ? { reason: answer.reason }
          : {}),
      });
      return answer;
    };
    // Off, its token and its allowlist gone: the next connect asks again
    // whose account it is, and the installer's next run finds no Telegram.
    const off = await write("disconnect", "PUT", platformPath, {
      enabled: false,
      clear_env: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"],
    });
    // In doubt: kept as the latest change, made after its restart.
    if (!off.ok)
      return off.uncertain === true
        ? hold("disconnect")
        : end(unavailable(off.reason));
    if (off.value.status !== 200) return end(failed("failed"));
    intent = "disconnect";
    await settleIntent();
    // Hermes has the bot off: the restart that takes it out of the running
    // gateway is owed from now, whatever the cleanup after it does.
    if (home !== undefined)
      await rm(telegramBotPath(home), { force: true }).catch(() => undefined);
    await input.changed().catch(() => undefined);
    // Its home channel, asked once (404: there is none). One Hermes does not
    // remove now stays, and nothing asks again: a DELETE that timed out here
    // may still run in Hermes later, and a second one could overtake a newer
    // approval's home channel. While Telegram is off it is inert, and the
    // next approval writes its own over it. Not through `write`: the restart
    // that ends a gateway still holding it is owed above, before it is sent.
    const channel = await ask("DELETE", "/api/env", {
      key: "TELEGRAM_HOME_CHANNEL",
    });
    if (
      !channel.ok ||
      (channel.value.status !== 200 && channel.value.status !== 404)
    )
      journal({
        operation: "home-channel",
        outcome: "left",
        reason: channel.ok ? "failed" : channel.reason,
      });
    return end(await telegram());
  }

  return Object.freeze({
    /** Telegram as Hermes has it now. A reading never writes. */
    read: (): Promise<TelegramStatus> => status(),
    /** Připojit: the token checked with Telegram, saved by Hermes, and the
     * restart asked for. */
    connect: (token: string) => serial(() => connect(token)),
    /** "Ano, to jsem já": that account allowed, and Buddy's home channel. */
    approve: (handle: string) => serial(() => approve(handle)),
    /** Odpojit: the bot off, its token and its account gone. */
    disconnect: () => serial(disconnect),
    /** His persona changed: his bot's words to an account it does not know
     * follow it, while the bot is connected from here. */
    persona: () =>
      serial(async () => {
        if (home !== undefined && (await readBotRecord(home)) !== null)
          await writePairingText(false);
      }),
    /** The barrier lifted (or the Launchpad started): what waited goes on.
     * A connect that waited may be sent again by the page that keeps its
     * token; a disconnect that waited is made, asked "again" while Hermes
     * cannot take it yet; his words are written again where his bot is
     * connected from here. */
    cleared: (why: TelegramFollowUp): Promise<"done" | "again"> =>
      // In the queue, after every change asked before the lift: a connect
      // or a disconnect that looked at the barrier before it is kept by now.
      serial(async () => {
        // Another write in doubt: its own lift asks again.
        if (await input.blocked()) return "done";
        if (await disconnectWaits()) {
          latest = null;
          const answer = await disconnectNow();
          // Hermes not ready yet: asked again later. Hermes refusing it: the
          // intent goes, and the page shows Telegram as Hermes has it, with
          // Odpojit.
          if (answer.kind === "unavailable") return "again";
          if (answer.kind === "failed") await settleIntent();
          return "done";
        }
        if (latest === "connect") {
          latest = null;
          retryUntil = now() + telegramRetryWindowMs;
        }
        if (
          why === "lifted" &&
          home !== undefined &&
          (await readBotRecord(home)) !== null
        )
          await writePairingText(true);
        return "done";
      }),
  });
}
