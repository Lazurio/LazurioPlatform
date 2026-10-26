import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { qrMatrix, qrSvg } from "../tools/qr";
import { stateDirectory, writeStateFile } from "./gateway-refresh";
import type {
  GatewayAnswer,
  GatewayFailure,
  GatewayResult,
  HermesGateway,
} from "./hermes-gateway";

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
//   approve     PUT  /api/messaging/platforms/telegram  {env: {TELEGRAM_ALLOWED_USERS}}
//               PUT  /api/env                         {key: TELEGRAM_HOME_CHANNEL}
//               POST /api/pairing/approve             {platform, request_id}
//   disconnect  PUT  /api/messaging/platforms/telegram  {enabled: false, clear_env}
//               DELETE /api/env                       {key: TELEGRAM_HOME_CHANNEL}
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
//   `TELEGRAM_HOME_CHANNEL` too (where Delegace's and Buddy's own messages
//   go). Hermes's approval alone writes neither while no allowlist exists
//   (`gateway/pairing.py` `_sync_allowlist_add`). Delegace reads the
//   allowlist from `~/.hermes/.env` on each notice (`telegram_target`), so a
//   Telegram connected later reaches it with no restart. An account already
//   approved in Hermes's pairing store and not in the allowlist (a
//   reconnect, or an approval from a terminal) is offered the same way.
// - The installer's quiet keys (no tool progress, no long-running
//   heartbeat, no autoraise notice, no warning or restart notices, keep the
//   messages that arrived while the gateway was down) are written at the
//   connect, before the restart that reads them, through Hermes's own
//   config writer. The installer writes the same values on every run.
// - The restart that brings the token in, or takes it out, is
//   telegram-restart.ts's. Everything else here takes effect at once.
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
  join(stateDirectory(home), "telegram-bot.json");

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

// ---- The core -------------------------------------------------------------------

export type TelegramJournalEntry = Readonly<{
  operation: "connect" | "approve" | "disconnect";
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
    /** Tests only: Telegram's word on a token. */
    checkBot?: BotChecker | undefined;
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
  ): Promise<GatewayResult<GatewayAnswer>> =>
    gateway
      .request(method, path, body === undefined ? {} : { body })
      .catch(
        (): GatewayResult<GatewayAnswer> =>
          Object.freeze({ ok: false, reason: "invalid-answer" }),
      );

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
    // Hermes's own writer: the token into its `.env` (its mode kept, 0600
    // for a new file), `platforms.telegram.enabled: true` into its
    // config.yaml, explicitly, so a token saved by any other way ends the
    // same. Its audit line names the keys, never a value.
    const saved = await ask("PUT", platformPath, {
      env: { TELEGRAM_BOT_TOKEN: token },
      enabled: true,
    });
    if (!saved.ok) return end(unavailable(saved.reason));
    if (saved.value.status === 400) return end(failed("token-refused"));
    if (saved.value.status !== 200) return end(failed("failed"));
    intent = "connect";
    // The quiet keys before the restart that reads them; a connect without
    // them still connects, and the journal says so.
    const quiet = await ask("PUT", "/api/config", {
      config: telegramQuietConfig,
    });
    if (!quiet.ok || quiet.value.status !== 200)
      journal({ operation: "connect", outcome: "quiet", reason: "failed" });
    // The bot's username beside Hermes's preview of what it saved now.
    const after = await card();
    if (home !== undefined && after.ok && after.value?.preview)
      await writeStateFile(telegramBotPath(home), {
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
    const read = await card();
    if (!read.ok) return end(unavailable(read.reason));
    if (read.value === null) return end(failed("failed"));
    const candidate = (await candidates(read.value)).find(
      (entry) => entry.handle === handle,
    );
    if (candidate === undefined)
      return end(Object.freeze({ kind: "blocked", reason: "request-gone" }));
    // The allowlist first: it is what lets the account in and keeps
    // everyone else out, and what Delegace reads.
    const allowed = await ask("PUT", platformPath, {
      env: { TELEGRAM_ALLOWED_USERS: candidate.userId },
    });
    if (!allowed.ok) return end(unavailable(allowed.reason));
    if (allowed.value.status !== 200) return end(failed("failed"));
    // The home channel: a private chat's id is its account's
    // (`hermes_cli/setup_platforms.py`), written by Hermes in this gateway's
    // own process, so its next turn sees it.
    const channel = await ask("PUT", "/api/env", {
      key: "TELEGRAM_HOME_CHANNEL",
      value: candidate.userId,
    });
    if (!channel.ok) return end(unavailable(channel.reason));
    if (channel.value.status !== 200) return end(failed("failed"));
    // Hermes's own approval takes the request off its list. One that
    // expired meanwhile changes nothing: the allowlist lets the account in.
    if (candidate.requestId !== undefined)
      await ask("POST", "/api/pairing/approve", {
        platform: "telegram",
        request_id: candidate.requestId,
      });
    return end(await telegram());
  }

  async function disconnect(): Promise<TelegramAnswer> {
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
    const off = await ask("PUT", platformPath, {
      enabled: false,
      clear_env: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"],
    });
    if (!off.ok) return end(unavailable(off.reason));
    if (off.value.status !== 200) return end(failed("failed"));
    intent = "disconnect";
    // No home channel left behind (Hermes answers 404 where there is none).
    const channel = await ask("DELETE", "/api/env", {
      key: "TELEGRAM_HOME_CHANNEL",
    });
    if (!channel.ok) return end(unavailable(channel.reason));
    if (channel.value.status !== 200 && channel.value.status !== 404)
      return end(failed("failed"));
    if (home !== undefined)
      await rm(telegramBotPath(home), { force: true }).catch(() => undefined);
    await input.changed().catch(() => undefined);
    return end(await telegram());
  }

  return Object.freeze({
    /** Telegram as Hermes has it now. */
    read: (): Promise<TelegramStatus> => status(),
    /** Připojit: the token checked with Telegram, saved by Hermes, and the
     * restart asked for. */
    connect: (token: string) => serial(() => connect(token)),
    /** "Ano, to jsem já": that account allowed, and Buddy's home channel. */
    approve: (handle: string) => serial(() => approve(handle)),
    /** Odpojit: the bot off, its token and its account gone. */
    disconnect: () => serial(disconnect),
  });
}
