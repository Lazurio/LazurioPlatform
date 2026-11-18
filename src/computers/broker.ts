import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import {
  appUpdateTool,
  busyMessage,
  computerBusy,
  errorAnswer,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  lineSplitter,
  methodNotFound,
  parseMessage,
  protocolVersion,
  resultAnswer,
} from "./lines";
import {
  type AppDetails,
  type AuditEntry,
  appOf,
  auditLabel,
  ensureComputersDirectory,
  socketPath,
  socketPathFits,
} from "./state";

// The broker of one computer's session (decision F75): the session is the
// WebSocket the computer opened (`./attach-ws`, contract v3), and on the
// computer's end runs the MCP server of Lazurio Agent Desktop: the computer
// is the server, this Environment never connects to it (root decisions 0240
// and 0241).
//
// The broker sends the computer `initialize`, then opens the owner-only
// socket `~/.local/state/lazurio/computers/<id>.sock` for the agents of this
// Environment (`lazurio computer mcp`). It answers each agent's `initialize`
// with the computer's own answer and forwards the rest with ids of its own.
//
// - One agent at a time: a tool call takes the computer's lease; another
//   agent's call is refused with who holds it and since when. The lease
//   ends when its agent disconnects, or after `idleLeaseMs` without a call
//   of its own, because one long-lived MCP process (Executor's) may serve
//   many agents. Listing tools needs no lease.
// - One session per computer: while another session's socket answers, a
//   new one is refused.
// - The session is alive while the computer answers `ping`; it ends when the
//   computer stops answering, when `stillAllowed` says no (its record was
//   removed) or when the session closes.
// - The history writes connections, the lease, each tool call's name,
//   outcome and duration; never arguments or results. A shell command is an
//   argument too: it may carry a password or a token (review of #943).

export type BrokerOptions = Readonly<{
  home: string;
  /** The account that owns the state directory. */
  uid: number | undefined;
  device: string;
  /** The computer's name as the person sees it. */
  name: string;
  version: string;
  /** The computer's session (`./attach-ws`, a WebSocket): one JSON-RPC
   * message per message. */
  transport: BrokerTransport;
  stderr: (text: string) => void;
  audit: (entry: Omit<AuditEntry, "ts" | "device">) => Promise<void>;
  /** Keeps the tool list of this session for agents while it is away. */
  saveTools: (tools: readonly unknown[]) => Promise<void>;
  /** Whether the computer may still be served, asked every `checkMs`. */
  stillAllowed: () => Promise<boolean>;
  /** Called once the computer answered `initialize`, with what its
   * application says it is (`appOf`). */
  connected?: (app: AppDetails) => Promise<void>;
  /** The application's own update (`lazurio_app_update`): marks the
   * computer as updating, clears the mark, and asks whether it is. */
  updating?: Readonly<{
    mark: () => Promise<void>;
    clear: () => Promise<void>;
    active: () => Promise<boolean>;
  }>;
  now?: () => number;
  /** How often the broker asks `stillAllowed`. */
  checkMs?: number;
  idleLeaseMs?: number;
  initTimeoutMs?: number;
}>;

/** The computer's session as the broker uses it, whatever carries it. The
 * transport keeps it alive (a WebSocket's ping every 15 s, closed after 45 s
 * without an answer) and says why it ended. */
export type BrokerTransport = Readonly<{
  send: (message: string) => void;
  onMessage: (listener: (message: string) => void) => void;
  /** Resolves once the session ended: `session-closed`, `computer-silent`,
   * or the reason `close` was given. */
  closed: Promise<string>;
  close: (reason: string) => void;
}>;

/** The tools of the application that run commands on the computer (contract
 * v1 section 3): the history keeps that a command ran and its exit code,
 * never the command itself (review of #943). */
const shellCommandTools: ReadonlySet<string> = new Set([
  "lazurio_shell_run",
  "lazurio_shell_start",
]);

/** The longest text of a shell tool's result that is read for its exit code
 * (the application keeps 64 KiB of each output). */
const maxShellResultText = 4 * 1024 * 1024;

/** A shell tool's exit code for the history: `exitCode` of the result's
 * `structuredContent` or, as Lazurio Agent Desktop answers, of the JSON object
 * in the result's one text part. Nothing else of the result is read or kept. */
export function shellExitCode(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { structuredContent, content } = result as {
    structuredContent?: unknown;
    content?: unknown;
  };
  const integer = (value: unknown) =>
    Number.isInteger(value) ? (value as number) : undefined;
  if (typeof structuredContent === "object" && structuredContent !== null) {
    const code = integer(
      (structuredContent as { exitCode?: unknown }).exitCode,
    );
    if (code !== undefined) return code;
  }
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const part = content[0] as { type?: unknown; text?: unknown } | null;
  if (part?.type !== "text" || typeof part.text !== "string") return undefined;
  if (part.text.length > maxShellResultText) return undefined;
  const text = part.text.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? integer((parsed as { exitCode?: unknown }).exitCode)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Exit statuses: 0 the session ended, 2 refused (already attached, no device
 * lock announced, or the
 * socket cannot be placed), 3 the computer never answered `initialize`. */
export const brokerExit = Object.freeze({
  ended: 0,
  refused: 2,
  silent: 3,
});

/** The version of the device lock a computer must announce in its answer to
 * `initialize` (ADR 0006 point 4 of Lazurio App, LZD-0018): one exclusive
 * lock of the person's session that Lazurio App and the pilot application
 * both take before any tool call, so two agents never work on one computer at
 * once. */
export const deviceLockVersion = 1;

/** The first version of the pilot application Lazurio Agent Desktop that
 * takes the device lock. An older one that claims the lock is not believed. */
export const firstUtilityWithDeviceLock = "0.1.0-pilot.8";

/** Orders two exact semver versions (`MAJOR.MINOR.PATCH[-PRERELEASE]`, no
 * build metadata) as semver does; `undefined` when either is not one. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (text: string) => {
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/.exec(
        text,
      );
    if (match === null) return undefined;
    return {
      core: [match[1], match[2], match[3]].map(Number),
      pre: match[4] === undefined ? [] : match[4].split("."),
    };
  };
  const x = parse(a);
  const y = parse(b);
  if (x === undefined || y === undefined) return undefined;
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number);
    if (d !== 0) return Math.sign(d);
  }
  // A release ranks above every pre-release of the same version.
  if (x.pre.length === 0 || y.pre.length === 0)
    return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i] as string;
    const q = y.pre[i] as string;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return Math.sign(x.pre.length - y.pre.length);
}

/** Whether the computer's answer to `initialize` announces the device lock.
 * The application announces itself under its own key of `_meta`: Lazurio App
 * under `io.lazurio/app`, the pilot application Lazurio Agent Desktop under
 * `io.lazurio/agent-desktop`. At least one of them must be present, and every
 * one present must carry `deviceLock` exactly `deviceLockVersion`; the pilot
 * application must also carry an `appVersion` no older than
 * `firstUtilityWithDeviceLock`. Missing or broken metadata is no
 * announcement. */
export function announcesDeviceLock(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const meta = (result as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return false;
  const record = meta as Record<string, unknown>;
  const locks = (about: unknown): about is Record<string, unknown> =>
    typeof about === "object" &&
    about !== null &&
    (about as { deviceLock?: unknown }).deviceLock === deviceLockVersion;
  const app = record["io.lazurio/app"];
  const utility = record["io.lazurio/agent-desktop"];
  if (app === undefined && utility === undefined) return false;
  if (app !== undefined && !locks(app)) return false;
  if (utility !== undefined) {
    if (!locks(utility)) return false;
    const version = utility.appVersion;
    if (typeof version !== "string") return false;
    const order = compareVersions(version, firstUtilityWithDeviceLock);
    if (order === undefined || order < 0) return false;
  }
  return true;
}

/** Whether something listens on the Unix socket at `path`. */
export function socketAnswers(
  path: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const done = (value: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

type Client = {
  socket: Socket;
  agent: string;
  harness: string | null;
  closed: boolean;
  lastCall: number;
};

type Pending = Readonly<{
  client: Client;
  id: JsonRpcId;
  method: string;
  tool: string | null;
  /** A shell tool's call, whose exit code the history keeps. */
  shell?: true;
  started: number;
}>;

export async function runBroker(options: BrokerOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const checkMs = options.checkMs ?? 15_000;
  const idleLeaseMs = options.idleLeaseMs ?? 120_000;
  const initTimeoutMs = options.initTimeoutMs ?? 30_000;
  const path = socketPath(options.home, options.device);
  const audit = (entry: Omit<AuditEntry, "ts" | "device">) =>
    options.audit(entry).catch(() => undefined);
  const updating = options.updating;

  if (!socketPathFits(options.home, options.device)) {
    options.stderr(
      "This account's home is too long for the computer's socket.\n",
    );
    return brokerExit.refused;
  }
  try {
    await ensureComputersDirectory(options.home, options.uid);
  } catch {
    options.stderr("The computers' state directory is not this account's.\n");
    return brokerExit.refused;
  }
  if (await socketAnswers(path)) {
    options.stderr(
      `Počítač ${options.name} je už připojený jinou relací. (Computer ${options.name} is already attached in another session.)\n`,
    );
    await audit({ event: "refused", reason: "already-attached" });
    return brokerExit.refused;
  }
  await rm(path, { force: true });

  let initResult: unknown = null;
  let toolsRequest = 0;
  let nextId = 0;
  const pending = new Map<string, Pending>();
  const clients = new Set<Client>();
  let holder: Client | null = null;
  let holderSince = 0;

  let ended: (reason: string) => void = () => undefined;
  const end = new Promise<string>((resolve) => {
    ended = resolve;
  });
  let initialized: (ok: boolean) => void = () => undefined;
  const initialize = new Promise<boolean>((resolve) => {
    initialized = resolve;
  });

  const send = (message: unknown) =>
    options.transport.send(JSON.stringify(message));
  const write = (client: Client, line: string) => {
    if (client.closed) return;
    try {
      client.socket.write(`${line}\n`);
    } catch {
      client.closed = true;
    }
  };
  const label = (client: Client) =>
    client.harness === null || client.harness === client.agent
      ? client.agent
      : `${client.agent} via ${client.harness}`;

  const askTools = () => {
    toolsRequest++;
    send({ jsonrpc: "2.0", id: `t${toolsRequest}`, method: "tools/list" });
  };

  // What the computer says.
  const fromComputer = (line: string) => {
    const message = parseMessage(line);
    if (message === null) return;
    if (isResponse(message)) {
      const id = String(message.id);
      if (id === "b0") {
        initResult = (message as { result?: unknown }).result ?? null;
        initialized(initResult !== null);
        return;
      }
      if (id.startsWith("p")) return;
      if (id.startsWith("t")) {
        const tools = (message.result as { tools?: unknown } | undefined)
          ?.tools;
        if (Array.isArray(tools))
          void options.saveTools(tools).catch(() => undefined);
        return;
      }
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      if (entry.method === "tools/call") {
        // A refusal of the application's own lock across Environments
        // ("Počítač teď ovládá agent z …", contract v1 section 1) is an
        // ordinary failed call: the session stays.
        const result = message.result as { isError?: unknown } | undefined;
        const ok = message.error === undefined && result?.isError !== true;
        const exitCode =
          entry.shell === true ? shellExitCode(message.result) : undefined;
        void audit({
          event: "tool",
          tool: entry.tool ?? "unknown",
          ok,
          ms: Math.max(0, now() - entry.started),
          agent: label(entry.client),
          ...(exitCode === undefined ? {} : { exitCode }),
        });
        // An update that did not start: the computer stays.
        if (entry.tool === appUpdateTool && !ok)
          void updating?.clear().catch(() => undefined);
        entry.client.lastCall = now();
      }
      write(entry.client, JSON.stringify({ ...message, id: entry.id }));
      return;
    }
    if (isRequest(message)) {
      const id = message.id as JsonRpcId;
      options.transport.send(
        message.method === "ping"
          ? resultAnswer(id, {})
          : errorAnswer(id, methodNotFound, "Not served by this Environment"),
      );
      return;
    }
    if (isNotification(message)) {
      if (message.method === "notifications/tools/list_changed") {
        for (const client of clients) write(client, line);
        askTools();
        return;
      }
      if (holder !== null) write(holder, line);
    }
  };

  options.transport.onMessage(fromComputer);
  void options.transport.closed.then((why) => {
    initialized(false);
    ended(why);
  });

  send({
    jsonrpc: "2.0",
    id: "b0",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "lazurio-computer-attach", version: options.version },
    },
  });
  const initTimer = setTimeout(() => initialized(false), initTimeoutMs);
  const ok = await initialize;
  clearTimeout(initTimer);
  if (!ok) {
    options.stderr("The computer did not answer initialize.\n");
    await audit({ event: "refused", reason: "no-initialize" });
    options.transport.close("no-initialize");
    return brokerExit.silent;
  }
  // A computer whose application does not take the device lock could let a
  // second agent work at the same time (an old pilot application next to
  // Lazurio App), so it is served nothing.
  if (!announcesDeviceLock(initResult)) {
    options.stderr(
      "The computer's application does not take the device lock; update it.\n",
    );
    await audit({ event: "refused", reason: "no-device-lock" });
    options.transport.close("no-device-lock");
    return brokerExit.refused;
  }
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  askTools();

  // Whether `client` may call a tool now: null, or why not.
  const lease = (client: Client): string | null => {
    const current = holder;
    if (current !== null && current !== client && !current.closed) {
      const working = [...pending.values()].some(
        (entry) => entry.client === current && entry.method === "tools/call",
      );
      if (working || now() - current.lastCall < idleLeaseMs)
        return busyMessage(options.name, label(current), new Date(holderSince));
      void audit({ event: "release", agent: label(current), reason: "idle" });
    }
    if (holder !== client) {
      holder = client;
      holderSince = now();
      void audit({ event: "lease", agent: label(client) });
    }
    return null;
  };

  // What an agent says.
  const fromAgent = (client: Client, line: string) => {
    const message = parseMessage(line);
    if (message === null) return;
    if (isNotification(message)) {
      if (message.method === "lazurio/hello") {
        const harness = (message.params as { harness?: unknown } | undefined)
          ?.harness;
        client.harness = harness === undefined ? null : auditLabel(harness);
        return;
      }
      if (message.method === "notifications/cancelled" && holder === client) {
        const requestId = (
          message.params as { requestId?: unknown } | undefined
        )?.requestId;
        for (const [id, entry] of pending)
          if (entry.client === client && entry.id === requestId)
            send({
              ...message,
              params: { ...(message.params as object), requestId: id },
            });
      }
      return;
    }
    if (!isRequest(message)) return;
    const id = message.id as JsonRpcId;
    const method = message.method as string;
    if (method === "initialize") {
      const info = (
        message.params as { clientInfo?: { name?: unknown } } | undefined
      )?.clientInfo;
      client.agent = auditLabel(info?.name);
      write(client, resultAnswer(id, initResult));
      return;
    }
    if (method === "ping") {
      write(client, resultAnswer(id, {}));
      return;
    }
    let tool: string | null = null;
    let shell = false;
    if (method === "tools/call") {
      const refused = lease(client);
      if (refused !== null) {
        void audit({ event: "busy", agent: label(client) });
        write(client, errorAnswer(id, computerBusy, refused));
        return;
      }
      tool = auditLabel(
        (message.params as { name?: unknown } | undefined)?.name,
      );
      client.lastCall = now();
      shell = shellCommandTools.has(tool);
      // The application updates itself and restarts: the computer will be
      // away for about a minute, which is expected, not a failure.
      if (tool === appUpdateTool) {
        void updating?.mark().catch(() => undefined);
        void audit({ event: "updating", agent: label(client) });
      }
    }
    nextId++;
    const own = `c${nextId}`;
    pending.set(own, {
      client,
      id,
      method,
      tool,
      ...(shell ? { shell: true as const } : {}),
      started: now(),
    });
    send({ ...(message as JsonRpcMessage), id: own });
  };

  const server = createServer((socket) => {
    const client: Client = {
      socket,
      agent: "unknown",
      harness: null,
      closed: false,
      lastCall: 0,
    };
    clients.add(client);
    socket.on(
      "data",
      lineSplitter((line) => fromAgent(client, line)),
    );
    const close = () => {
      if (client.closed && !clients.has(client)) return;
      client.closed = true;
      clients.delete(client);
      for (const [id, entry] of pending)
        if (entry.client === client) pending.delete(id);
      if (holder === client) {
        holder = null;
        void audit({ event: "release", agent: label(client) });
      }
    };
    socket.once("close", close);
    socket.once("error", close);
  });
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
  } catch {
    process.umask(previous);
    options.stderr("The computer's socket could not be opened.\n");
    options.transport.close("socket-unavailable");
    return brokerExit.refused;
  }
  process.umask(previous);
  await chmod(path, 0o600).catch(() => undefined);
  const server_info = (initResult as { serverInfo?: { name?: unknown } } | null)
    ?.serverInfo;
  // Back after an update, or simply connected: no longer updating.
  await updating?.clear().catch(() => undefined);
  await options.connected?.(appOf(initResult)).catch(() => undefined);
  await audit({
    event: "connected",
    agent: auditLabel(server_info?.name),
    ...appOf(initResult),
  });

  // Removal, every `checkMs`; the transport keeps the session alive.
  const timer = setInterval(() => {
    void options.stillAllowed().then(
      (allowed) => {
        if (!allowed) ended("removed");
      },
      () => undefined,
    );
  }, checkMs);

  const reason = await end;
  clearInterval(timer);
  options.transport.close(reason);
  for (const client of clients) client.socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(path, { force: true }).catch(() => undefined);
  // Leaving to update is expected: the history says so, not a failure.
  const leftToUpdate =
    reason === "session-closed" || reason === "computer-silent"
      ? await (updating?.active() ?? Promise.resolve(false)).catch(() => false)
      : false;
  await audit({
    event: "disconnected",
    reason: leftToUpdate ? "updating" : reason,
  });
  return brokerExit.ended;
}
