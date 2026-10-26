import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { oauthCancelContract } from "../../src/buddy/hermes-gateway";
import recorded from "./hermes-gateway-v0.22.4-lazurio.1.json";

// A stand-in for Buddy's Hermes gateway (Lazurio/hermes-agent
// v0.22.4-lazurio.1, decision F63): its owner-only control socket in the
// user's `~/.hermes` (`gateway.sock`, or a pointer to
// `/tmp/hermes-gw-<sha256(home)[:16]>/control.sock`), answering `identify`
// and `session-ticket` one line per connection, and its loopback dashboard
// API, which redeems each ticket once, as `native_http.py` does: exactly one
// ticket, no `Origin` of any kind, no `profile` query. Every answer is one
// recorded from the real gateway (hermes-gateway-v0.22.4-lazurio.1.json),
// with the fake's own home, origin and fresh tickets; a test may replace any
// of them. Everything that arrives is recorded as it arrived.
//
// Its sign-in sessions behave as Hermes's do: a cancel marks a session
// cancelled and removes it, and a worker saves only an unmarked one. Its
// 15-minute sweep (`collect`) removes a session without the mark, as the
// recorded tag does, unless the gateway keeps Lazurio/hermes-agent#17's
// cancellation contract (`contract`, on by default): then it marks it first,
// and its `identify` advertises the contract (derived from the recorded
// answer, which has none).
//
// Its Telegram (decision F66) is derived from Hermes's code at
// v0.22.4-lazurio.3 (95e80b77), not recorded: the platform's card of
// `GET /api/messaging/platforms` (hermes_cli/web_routers/messaging.py:194-277,
// 916-931), its writer `PUT /api/messaging/platforms/telegram` with the
// card's own keys and the token's rule (:975-1035,
// plugins/platforms/telegram/dashboard_card.py:9-24), `PUT` and `DELETE
// /api/env` (hermes_cli/web_routers/config_env.py:328-339, 1067-1082), `PUT
// /api/config`'s deep merge (:117-158), and DM pairing (`GET /api/pairing`,
// `POST /api/pairing/approve`: hermes_cli/web_routers/ops.py:84-117,
// gateway/pairing.py:153-162, 431-441, 537-575). A message from an account
// (`telegramMessage`) is paired as the gateway pairs it: a code while no
// allowlist exists, nothing with one (gateway/authz_mixin.py:716-758), and
// its reply recorded: upstream's (locales/en.yaml `gateway.pairing.code_reply`)
// or, where the gateway keeps Lazurio/hermes-agent#19's configurable reply
// (`pairingMessage`, off by default as at v0.22.4-lazurio.3), the text of
// `unauthorized_dm_pairing_message` in its config, read when it replies
// (gateway/lazurio_pairing_message.py at f068a0bd). Its running state is the
// test's (`state.telegram.runtime`), as a restart would leave it. Every body
// that arrives is recorded as it arrived.

type Json = Record<string, unknown>;

/** Lazurio/hermes-agent#19 at f068a0bd, `gateway/lazurio_pairing_message.py`:
 * Hermes's own names, not the client's. */
const pairingCapability = "lazurio-pairing-message-v1";
const pairingKey = "unauthorized_dm_pairing_message";

export type ControlRequest = Readonly<{ line: string; value: Json | null }>;
export type GatewayRequest = Readonly<{
  method: string;
  path: string;
  query: string;
  headers: Readonly<Record<string, string>>;
  peer: string | null;
  /** The body as it arrived; empty without one. */
  body: string;
}>;

/** Buddy's Telegram as the fake's Hermes holds it. */
export type FakeTelegram = {
  /** `TELEGRAM_BOT_TOKEN` in `.env`. */
  token: string | null;
  /** `platforms.telegram.enabled`; null where config.yaml does not name it
   * (Hermes then enables a platform with a token). */
  enabled: boolean | null;
  /** `TELEGRAM_ALLOWED_USERS`. */
  allowed: string;
  /** `TELEGRAM_HOME_CHANNEL`. */
  home: string | null;
  /** The running gateway's state of the platform; null: it never
   * reported (`pending_restart` while enabled and configured). */
  runtime: string | null;
  errorCode: string | null;
  pending: {
    request_id: string;
    user_id: string;
    user_name: string;
    created: number;
  }[];
  approved: { user_id: string; user_name: string }[];
  /** What `PUT /api/config` merged into config.yaml. */
  config: Record<string, unknown>;
  /** What the bot answered each account that got a pairing code. */
  replies: string[];
};

export type FakeGatewayOptions = Readonly<{
  /** The socket through a pointer, as for a home too long for a socket. */
  pointer?: boolean;
  /** Buddy's home as a link to his real one (a symlinked `~/.hermes`). */
  linkedHome?: boolean;
  signedIn?: boolean;
  /** Whether it keeps and advertises the cancellation contract (default:
   * yes; the recorded v0.22.4-lazurio.1 does not). */
  contract?: boolean;
  /** Whether it replies to an unknown account with the configured text and
   * advertises it (Lazurio/hermes-agent#19; default: no, as
   * v0.22.4-lazurio.3). */
  pairingMessage?: boolean;
}>;

type SignInSession = {
  status: string;
  error_message: string | null;
  /** Marked by a cancel, or by the sweep under the contract. */
  cancelled?: boolean;
};

/** What the fake answers on its control socket: a JSON value, a raw line
 * (`raw`), nothing at all (`hang`) or a closed connection (`close`). */
export type ControlReply = Json | { raw: string } | "hang" | "close";

const fill = (value: unknown, home: string, origin: string): unknown =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll("{{home}}", home)
      .replaceAll("{{apiOrigin}}", origin),
  );

export async function fakeHermesGateway(options: FakeGatewayOptions = {}) {
  // Short and real: a socket path has at most ~100 bytes, and the gateway
  // reserves its home's real path.
  const root = await realpath(await mkdtemp("/tmp/hg-"));
  const userHome = join(root, "user");
  await mkdir(userHome, { mode: 0o700 });
  const home = options.linkedHome
    ? join(root, "elsewhere")
    : join(userHome, ".hermes");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  if (options.linkedHome)
    await Bun.$`ln -s ${home} ${join(userHome, ".hermes")}`.quiet();
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  const pointerDirectory = `/tmp/hermes-gw-${hash}`;
  const socket = options.pointer
    ? join(pointerDirectory, "control.sock")
    : join(home, "gateway.sock");
  if (options.pointer) {
    await mkdir(pointerDirectory, { mode: 0o700 });
    await chmod(pointerDirectory, 0o700);
  }

  const control: ControlRequest[] = [];
  const requests: GatewayRequest[] = [];
  const minted = new Set<string>();
  const spent: string[] = [];
  // The sessions Hermes holds (its `_oauth_sessions`), and every session
  // whose worker may still run, held or not.
  const sessions = new Map<string, SignInSession>();
  const workers = new Map<string, SignInSession>();
  let started = 0;
  const state = {
    signedIn: options.signedIn === true,
    /** Replaces the `identify` answer; `answer` is the recorded one. */
    identify: undefined as ((answer: Json) => ControlReply) | undefined,
    /** Replaces the `session-ticket` answer. */
    ticket: undefined as
      | ((request: Json, answer: Json) => ControlReply)
      | undefined,
    /** Answers an API request after its ticket is redeemed; undefined: the
     * recorded route. */
    http: undefined as
      | ((
          request: GatewayRequest,
        ) => Response | undefined | Promise<Response | undefined>)
      | undefined,
    /** The instance this gateway runs as; a restart changes it. */
    instance: recorded.control.identify.result.instance_id,
    /** Whether it keeps and advertises the cancellation contract. */
    contract: options.contract !== false,
    /** Whether it keeps and advertises the configurable pairing reply. */
    pairingMessage: options.pairingMessage === true,
    /** Its Telegram: not set up. */
    telegram: {
      token: null,
      enabled: null,
      allowed: "",
      home: null,
      runtime: null,
      errorCode: null,
      pending: [],
      approved: [],
      config: {},
      replies: [],
    } as FakeTelegram,
  };

  let apiOrigin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const recordedRequest: GatewayRequest = Object.freeze({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.freeze(Object.fromEntries(request.headers)),
        peer: server.requestIP(request)?.address ?? null,
        body: await request.text(),
      });
      requests.push(recordedRequest);
      const json = (entry: { status: number; body: unknown }) =>
        Response.json(fill(entry.body, home, apiOrigin), {
          status: entry.status,
        });
      // native_http.py: one ticket (Bun joins a repeated header with a
      // comma, which a ticket never holds), no Origin, loopback, redeemed
      // once.
      const ticket = request.headers.get("x-hermes-gateway-ticket");
      if (
        ticket === null ||
        ticket.includes(",") ||
        request.headers.has("origin") ||
        !["127.0.0.1", "::1"].includes(recordedRequest.peer ?? "") ||
        !minted.has(ticket)
      )
        return json(recorded.http.unauthorized);
      minted.delete(ticket);
      spent.push(ticket);
      if (url.searchParams.has("profile"))
        return json(recorded.http.profileScopeMismatch);
      const replaced = await state.http?.(recordedRequest);
      if (replaced !== undefined) return replaced;
      const codex = "/api/providers/oauth/openai-codex";
      if (request.method === "GET" && url.pathname === "/api/providers/oauth")
        return json(
          state.signedIn
            ? recorded.http.providersSignedIn
            : recorded.http.providersSignedOut,
        );
      if (request.method === "POST" && url.pathname === `${codex}/start`) {
        started += 1;
        const id = `Fixture_Session_${String(started).padStart(6, "0")}`;
        const session: SignInSession = {
          status: "pending",
          error_message: null,
        };
        sessions.set(id, session);
        workers.set(id, session);
        return json({
          status: 200,
          body: { ...recorded.http.start.body, session_id: id },
        });
      }
      const poll = new RegExp(`^${codex}/poll/(.+)$`).exec(url.pathname);
      if (request.method === "GET" && poll !== null) {
        const session = sessions.get(poll[1] as string);
        return session === undefined
          ? json(recorded.http.pollUnknown)
          : json({
              status: 200,
              body: {
                ...recorded.http.pollPending.body,
                session_id: poll[1],
                status: session.status,
                error_message: session.error_message,
              },
            });
      }
      const cancel = /^\/api\/providers\/oauth\/sessions\/(.+)$/.exec(
        url.pathname,
      );
      if (request.method === "DELETE" && cancel !== null) {
        const id = cancel[1] as string;
        // cancel_oauth_session: marked, then removed, under one lock.
        const session = sessions.get(id);
        if (session === undefined) return json(recorded.http.cancelUnknown);
        session.cancelled = true;
        sessions.delete(id);
        return json({
          status: 200,
          body: { ...recorded.http.cancel.body, session_id: id },
        });
      }
      if (request.method === "DELETE" && url.pathname === codex) {
        if (!state.signedIn) return json(recorded.http.signOutEmpty);
        state.signedIn = false;
        return json(recorded.http.signOut);
      }
      const telegramAnswer = telegramRoute(
        request.method,
        url.pathname,
        recordedRequest.body,
      );
      if (telegramAnswer !== undefined) return telegramAnswer;
      return Response.json({ detail: "Not Found" }, { status: 404 });
    },
  });
  apiOrigin = `http://127.0.0.1:${server.port}`;

  // ---- Telegram, derived from Hermes's code at v0.22.4-lazurio.3 ----

  const telegram = () => state.telegram;
  const enabledNow = () => {
    const t = telegram();
    // An explicit `enabled` wins; otherwise a token enables it
    // (`_platform_enablement`, messaging.py:180-191).
    return t.enabled ?? t.token !== null;
  };
  const card = () => {
    const t = telegram();
    const enabled = enabledNow();
    const configured = t.token !== null;
    let runtime = t.runtime;
    if (!enabled) runtime = "disabled";
    else if (!configured) runtime = "not_configured";
    else if (runtime === null) runtime = "pending_restart";
    const preview = (value: string | null) =>
      value === null || value === ""
        ? null
        : `«redacted:${value.slice(0, 4)}...${value.slice(-4)}»`;
    return {
      id: "telegram",
      name: "Telegram",
      description: "Run Hermes from Telegram DMs, groups, and topics.",
      docs_url: "https://core.telegram.org/bots/features#botfather",
      enabled,
      configured,
      gateway_running: true,
      state: runtime,
      error_code: enabled && configured ? t.errorCode : null,
      error_message:
        enabled && configured && t.errorCode !== null
          ? `Telegram bot token rejected: Unauthorized. Hermes words ${t.token}`
          : null,
      updated_at: null,
      home_channel:
        t.home === null
          ? null
          : { platform: "telegram", chat_id: t.home, name: "Home" },
      env_vars: [
        {
          key: "TELEGRAM_BOT_TOKEN",
          required: true,
          is_set: t.token !== null,
          redacted_value: preview(t.token),
          value: null,
          description: "Telegram bot token from @BotFather",
          prompt: "Telegram bot token",
          help: "",
          url: null,
          is_password: true,
          is_list: false,
          advanced: false,
        },
        {
          key: "TELEGRAM_ALLOWED_USERS",
          required: false,
          is_set: t.allowed !== "",
          redacted_value: preview(t.allowed === "" ? null : t.allowed),
          value: t.allowed === "" ? null : t.allowed,
          description:
            "Comma-separated Telegram user IDs allowed to use the bot",
          prompt: "Allowed Telegram users",
          help: "",
          url: null,
          is_password: false,
          is_list: true,
          advanced: false,
        },
      ],
      ingress_url: null,
    };
  };
  const detail = (status: number, text: string) =>
    Response.json({ detail: text }, { status });
  const parse = (body: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(body) as unknown;
      return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const merge = (
    into: Record<string, unknown>,
    from: Record<string, unknown>,
  ) => {
    for (const [key, value] of Object.entries(from)) {
      const current = into[key];
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current)
      )
        merge(
          current as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      else
        into[key] =
          value !== null && typeof value === "object"
            ? structuredClone(value)
            : value;
    }
  };
  const telegramRoute = (
    method: string,
    path: string,
    body: string,
  ): Response | undefined => {
    const t = telegram();
    if (method === "GET" && path === "/api/messaging/platforms")
      return Response.json({
        env_path: `${home}/.env`,
        gateway_start_command: "hermes gateway start",
        platforms: [
          { ...card(), id: "discord", name: "Discord", env_vars: [] },
          card(),
        ],
      });
    if (method === "PUT" && path === "/api/messaging/platforms/telegram") {
      const update = parse(body);
      if (update === null) return detail(422, "Unprocessable");
      const env = (update.env ?? {}) as Record<string, string>;
      const clear = (update.clear_env ?? []) as string[];
      const allowedKeys = new Set([
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_ALLOWED_USERS",
      ]);
      for (const key of [...clear, ...Object.keys(env)])
        if (!allowedKeys.has(key))
          return detail(400, `${key} is not configurable for Telegram`);
      const token = env.TELEGRAM_BOT_TOKEN?.trim();
      if (token && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token))
        return detail(
          400,
          "Telegram bot token must be the complete token from @BotFather, such as 123456789:ABC…",
        );
      const users = env.TELEGRAM_ALLOWED_USERS?.trim();
      if (
        users &&
        !users
          .split(",")
          .every((user) => user.trim() === "" || /^\d+$/.test(user.trim()))
      )
        return detail(
          400,
          "Telegram allowed users must be comma-separated numeric user IDs.",
        );
      for (const key of clear) {
        if (key === "TELEGRAM_BOT_TOKEN") t.token = null;
        if (key === "TELEGRAM_ALLOWED_USERS") t.allowed = "";
      }
      if (token) t.token = token;
      if (users) t.allowed = users;
      if (typeof update.enabled === "boolean") t.enabled = update.enabled;
      return Response.json({
        ok: true,
        platform: "telegram",
        hot_served: false,
      });
    }
    if (method === "PUT" && path === "/api/config") {
      const update = parse(body);
      if (update === null || typeof update.config !== "object")
        return detail(422, "Unprocessable");
      merge(t.config, update.config as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    if (method === "PUT" && path === "/api/env") {
      const update = parse(body);
      if (update === null || typeof update.key !== "string")
        return detail(422, "Unprocessable");
      if (update.key === "TELEGRAM_HOME_CHANNEL") t.home = String(update.value);
      return Response.json({
        ok: true,
        key: update.key,
        config_updates: [],
      });
    }
    if (method === "DELETE" && path === "/api/env") {
      const update = parse(body);
      if (update === null || typeof update.key !== "string")
        return detail(422, "Unprocessable");
      if (update.key === "TELEGRAM_HOME_CHANNEL" && t.home !== null) {
        t.home = null;
        return Response.json({ ok: true, found: true });
      }
      return detail(404, `${update.key} not found in .env`);
    }
    if (method === "GET" && path === "/api/pairing")
      return Response.json({
        pending: t.pending.map((entry) => ({
          platform: "telegram",
          request_id: entry.request_id,
          user_id: entry.user_id,
          user_name: entry.user_name,
          age_minutes: Math.floor((Date.now() - entry.created) / 60_000),
        })),
        approved: t.approved.map((entry) => ({
          platform: "telegram",
          user_id: entry.user_id,
          user_name: entry.user_name,
          approved_at: 1,
        })),
      });
    if (method === "POST" && path === "/api/pairing/approve") {
      const update = parse(body);
      if (update === null) return detail(422, "Unprocessable");
      const platform = String(update.platform ?? "")
        .toLowerCase()
        .trim();
      const target = String(update.request_id ?? update.code ?? "").trim();
      if (!platform || !target)
        return detail(400, "platform and request_id or code are required");
      const found = t.pending.findIndex(
        (entry) => entry.request_id === target.toLowerCase(),
      );
      if (platform !== "telegram" || found === -1)
        return detail(
          404,
          `Pairing request or code not found or expired for platform '${platform}'.`,
        );
      const [entry] = t.pending.splice(found, 1);
      if (entry === undefined) throw new Error("unreachable");
      t.approved = t.approved.filter((user) => user.user_id !== entry.user_id);
      t.approved.push({ user_id: entry.user_id, user_name: entry.user_name });
      // Mirrored into the allowlist only where one is configured.
      if (t.allowed !== "" && !t.allowed.split(",").includes(entry.user_id))
        t.allowed = `${t.allowed},${entry.user_id}`;
      return Response.json({
        ok: true,
        user: { user_id: entry.user_id, user_name: entry.user_name },
      });
    }
    return undefined;
  };

  /** The reply to an unknown account, as Hermes sends it with its code. */
  const pairingReply = (code: string): string => {
    const config = state.telegram.config;
    const section = config.gateway;
    const configured = [
      config[pairingKey],
      section !== null && typeof section === "object"
        ? (section as Json)[pairingKey]
        : undefined,
    ].find((value) => typeof value === "string" && value.trim() !== "");
    if (state.pairingMessage && typeof configured === "string")
      return configured
        .trim()
        .replaceAll("{code}", code)
        .replaceAll("{validity}", "1 hour");
    return (
      "Hi! I don't recognize you yet, so I can't reply until the person running this bot approves you.\n\n" +
      `Your pairing code: \`${code}\` (valid for 1 hour)\n\n` +
      `If you run this bot, open a terminal and run: \`hermes pairing approve telegram ${code}\`. ` +
      "Otherwise send that command to the bot owner. After approval, send your message again."
    );
  };

  const reply = (request: Json | null): ControlReply => {
    if (request?.verb === "identify") {
      const answer = fill(recorded.control.identify, home, apiOrigin) as Json;
      const result = answer.result as Json;
      result.instance_id = state.instance;
      if (state.contract) {
        const { member, value } = oauthCancelContract;
        const listed = result[member];
        result[member] = Array.isArray(listed) ? [...listed, value] : value;
      }
      if (state.pairingMessage)
        result.capabilities = [
          ...(result.capabilities as unknown[]),
          pairingCapability,
        ];
      return state.identify === undefined ? answer : state.identify(answer);
    }
    if (request?.verb === "session-ticket") {
      // control_socket.py `_session_ticket` and runtime_bootstrap.py `mint`.
      const params = request.params as Json | undefined;
      const keys = Object.keys(request);
      let answer: Json;
      if (
        keys.some((key) => !["protocol", "verb", "id", "params"].includes(key))
      )
        answer = recorded.control.ticketInvalidEnvelope;
      else if (params?.instance_id !== state.instance)
        answer = recorded.control.ticketStaleInstance;
      else if (params?.profile_id !== home || params?.purpose !== "native-http")
        answer = recorded.control.ticketOtherProfile;
      else {
        const ticket = randomBytes(32).toString("base64url");
        minted.add(ticket);
        answer = fill(recorded.control.ticket, home, apiOrigin) as Json;
        answer.result = {
          ...(answer.result as Json),
          ticket,
          instance_id: state.instance,
        };
      }
      return state.ticket === undefined
        ? answer
        : state.ticket(request, answer);
    }
    return { ok: false, error: "unknown verb", protocol: 1 };
  };

  const listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(connection) {
        connection.data = { buffer: "" };
      },
      data(connection, chunk) {
        connection.data.buffer += new TextDecoder().decode(chunk);
        const newline = connection.data.buffer.indexOf("\n");
        if (newline === -1) return;
        const line = connection.data.buffer.slice(0, newline);
        let value: Json | null = null;
        try {
          value = JSON.parse(line) as Json;
        } catch {}
        control.push(Object.freeze({ line, value }));
        const answer = reply(value);
        if (answer === "hang") return;
        if (answer === "close") {
          connection.end();
          return;
        }
        connection.write(
          `${"raw" in answer ? answer.raw : JSON.stringify(answer)}\n`,
        );
        connection.end();
      },
    },
  });
  // Hermes binds under umask 0177 and sets 0600 (control_socket.py).
  await chmod(socket, 0o600);
  if (options.pointer) {
    const pointer = join(home, "gateway.sock.path");
    await writeFile(pointer, socket, { mode: 0o600 });
    await chmod(pointer, 0o600);
  }

  return {
    root,
    /** The user's home: where `~/.hermes` is. */
    userHome,
    /** Buddy's real Hermes home. */
    home,
    socket,
    pointerDirectory,
    apiOrigin,
    control,
    requests,
    /** Tickets the API redeemed, in order. */
    spent,
    /** Tickets minted and not yet redeemed. */
    minted,
    sessions,
    state,
    /** OpenAI approved the sign-in and its worker tries to save it, also
     * after the sweep removed it (`collect`): it checks the mark first, under
     * the lock its cancel takes, and saves only an unmarked session. Whether
     * it saved. */
    approve(id: string): boolean {
      const session = sessions.get(id) ?? workers.get(id);
      if (session === undefined) throw new Error(`No session ${id}`);
      if (session.cancelled === true) return false;
      session.status = "approved";
      state.signedIn = true;
      return true;
    },
    /** Hermes's 15-minute sweep (`_gc_oauth_sessions`): the session leaves the
     * map, so its poll answers 404 and its cancel "session not found". Under
     * the contract it is marked cancelled first; at v0.22.4-lazurio.1 it is
     * not, and its worker may still save. */
    collect(id: string) {
      const session = sessions.get(id);
      if (session === undefined) throw new Error(`No session ${id}`);
      if (state.contract) session.cancelled = true;
      sessions.delete(id);
    },
    /** An account writes to the bot (/start): paired as the gateway pairs
     * an unknown sender, a request while no allowlist exists and the bot
     * runs, nothing for an allowed or approved one; at most 3 pending.
     * Returns the request's id, or null for none. */
    telegramMessage(userId: string, userName: string): string | null {
      const t = state.telegram;
      if (t.runtime !== "connected") return null;
      if (t.allowed.split(",").includes(userId)) return null;
      if (t.approved.some((user) => user.user_id === userId)) return null;
      if (t.allowed !== "") return null;
      if (t.pending.length >= 3) return null;
      const id = randomBytes(8).toString("hex");
      t.pending.push({
        request_id: id,
        user_id: userId,
        user_name: userName,
        created: Date.now(),
      });
      // gateway/pairing.py's alphabet, and the reply it sends with the code.
      const code = [...randomBytes(8)]
        .map((byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32])
        .join("");
      t.replies.push(pairingReply(code));
      return id;
    },
    /** A restart: every session in its memory is gone with its worker, a new
     * instance. */
    restart() {
      sessions.clear();
      workers.clear();
      minted.clear();
      state.instance = randomBytes(16).toString("hex");
    },
    /** Stops answering: the socket and the API are gone. */
    async stop() {
      listener.stop(true);
      server.stop(true);
      await rm(socket, { force: true });
    },
    async close() {
      listener.stop(true);
      server.stop(true);
      await rm(root, { recursive: true, force: true });
      if (options.pointer)
        await rm(pointerDirectory, { recursive: true, force: true });
    },
  };
}

export type FakeHermesGateway = Awaited<ReturnType<typeof fakeHermesGateway>>;

export { recorded };
