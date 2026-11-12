import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import {
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
  /** Lines from the computer: the SSH session's stdin. */
  remote: NodeJS.ReadableStream;
  /** A line to the computer: the SSH session's stdout. */
  send: (line: string) => void;
  stderr: (text: string) => void;
  audit: (entry: Omit<AuditEntry, "ts" | "device">) => Promise<void>;
  /** Keeps the tool list of this session for agents while it is away. */
  saveTools: (tools: readonly unknown[]) => Promise<void>;
  /** Whether the computer's key still allows it. */
  stillAllowed: () => Promise<boolean>;
  now?: () => number;
  pingMs?: number;
  deadMs?: number;
  idleLeaseMs?: number;
  initTimeoutMs?: number;
}>;

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
  started: number;
}>;

export async function runBroker(options: BrokerOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const pingMs = options.pingMs ?? 15_000;
  const deadMs = options.deadMs ?? 45_000;
  const idleLeaseMs = options.idleLeaseMs ?? 120_000;
  const initTimeoutMs = options.initTimeoutMs ?? 30_000;
  const path = socketPath(options.home, options.device);
  const audit = (entry: Omit<AuditEntry, "ts" | "device">) =>
    options.audit(entry).catch(() => undefined);

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

  let lastHeard = now();
  let initResult: unknown = null;
  let toolsRequest = 0;
  let nextId = 0;
  let pingId = 0;
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

  const send = (message: unknown) => options.send(JSON.stringify(message));
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
    lastHeard = now();
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
        const result = message.result as { isError?: unknown } | undefined;
        void audit({
          event: "tool",
          tool: entry.tool ?? "unknown",
          ok: message.error === undefined && result?.isError !== true,
          ms: Math.max(0, now() - entry.started),
          agent: label(entry.client),
        });
        entry.client.lastCall = now();
      }
      write(entry.client, JSON.stringify({ ...message, id: entry.id }));
      return;
    }
    if (isRequest(message)) {
      const id = message.id as JsonRpcId;
      options.send(
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

  const remoteData = lineSplitter(fromComputer);
  options.remote.on("data", remoteData);
  options.remote.once("end", () => {
    initialized(false);
    ended("session-closed");
  });
  options.remote.once("error", () => {
    initialized(false);
    ended("session-closed");
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
    options.remote.removeListener("data", remoteData);
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
    }
    nextId++;
    const own = `c${nextId}`;
    pending.set(own, { client, id, method, tool, started: now() });
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
    options.remote.removeListener("data", remoteData);
    return brokerExit.refused;
  }
  process.umask(previous);
  await chmod(path, 0o600).catch(() => undefined);
  const server_info = (initResult as { serverInfo?: { name?: unknown } } | null)
    ?.serverInfo;
  await audit({
    event: "connected",
    agent: auditLabel(server_info?.name),
    ...appOf(initResult),
  });

  // Liveness and removal, every `pingMs`.
  const timer = setInterval(() => {
    if (now() - lastHeard > deadMs) {
      ended("computer-silent");
      return;
    }
    pingId++;
    send({ jsonrpc: "2.0", id: `p${pingId}`, method: "ping" });
    void options.stillAllowed().then(
      (allowed) => {
        if (!allowed) ended("removed");
      },
      () => undefined,
    );
  }, pingMs);

  const reason = await end;
  clearInterval(timer);
  options.remote.removeListener("data", remoteData);
  for (const client of clients) client.socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(path, { force: true }).catch(() => undefined);
  await audit({ event: "disconnected", reason });
  return brokerExit.ended;
}
