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
  type AuditEntry,
  appOf,
  auditLabel,
  ensureComputersDirectory,
  socketPath,
  socketPathFits,
} from "./state";

// `lazurio computer attach --device <id>` (decision F73, contract v0
// section 3): the forced command of a computer's key. Its stdin and stdout
// are the SSH session the computer opened, and on the computer's end runs
// the MCP server of Lazurio Agent Desktop: the computer is the server, this
// Environment never connects to it (root decisions 0240 and 0241).
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
//   computer stops answering, when its key leaves `authorized_keys` (the
//   computer was removed) or when the SSH session closes.
// - The history writes connections, the lease, each tool call's name,
//   outcome and duration; never arguments or results.

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
  /** Whether the computer's key still allows it. */
  stillAllowed: () => Promise<boolean>;
  /** The application's own update (`lazurio_app_update`): marks the
   * computer as updating, clears the mark, and asks whether it is. */
  updating?: Readonly<{
    mark: () => Promise<void>;
    clear: () => Promise<void>;
    active: () => Promise<boolean>;
  }>;
  now?: () => number;
  /** How often the broker asks whether the computer is still paired. */
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
 * v1 section 3): the history keeps the command and its exit code. */
const shellCommandTools: ReadonlySet<string> = new Set([
  "lazurio_shell_run",
  "lazurio_shell_start",
]);

/** A command as the history keeps it: one line, no control characters, at
 * most 500 characters. */
export function commandLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const command = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, 500);
  return command === "" ? undefined : command;
}

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

/** Exit statuses: 0 the session ended, 2 refused (already attached, or the
 * socket cannot be placed), 3 the computer never answered `initialize`. */
export const brokerExit = Object.freeze({
  ended: 0,
  refused: 2,
  silent: 3,
});

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
  /** A shell tool's command, for the history. */
  command?: string;
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
          entry.command === undefined
            ? undefined
            : shellExitCode(message.result);
        void audit({
          event: "tool",
          tool: entry.tool ?? "unknown",
          ok,
          ms: Math.max(0, now() - entry.started),
          agent: label(entry.client),
          ...(entry.command === undefined ? {} : { command: entry.command }),
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
    let command: string | undefined;
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
      if (shellCommandTools.has(tool))
        command = commandLabel(
          (message.params as { arguments?: { command?: unknown } } | undefined)
            ?.arguments?.command,
        );
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
      ...(command === undefined ? {} : { command }),
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
