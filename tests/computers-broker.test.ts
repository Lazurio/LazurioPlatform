import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runAgentEntry } from "../src/computers/agent-entry";
import {
  announcesDeviceLock,
  type BrokerOptions,
  type BrokerTransport,
  brokerExit,
  compareVersions,
  runBroker,
  shellExitCode,
} from "../src/computers/broker";
import { lineSplitter } from "../src/computers/lines";
import {
  type AuditEntry,
  readTools,
  socketPath,
  writeTools,
} from "../src/computers/state";

// `lazurio computer attach` and `lazurio computer mcp` (decision F75): the
// broker takes the SSH session's stdio from a fake computer, opens the
// owner-only socket for agents, holds the computer for one agent at a time
// and writes a history without content; the agents' MCP server works with
// and without the computer. Every test runs in a temporary home.

const posix = process.platform !== "win32";
type Message = Record<string, unknown>;

/** A computer on the far end of the SSH session: answers like Agent
 * Desktop's MCP server. A call of `hold` waits until `release`. */
/** How the computer's answer to `initialize` announces the device lock
 * (ADR 0006 point 4 of Lazurio App): as the pilot application, as Lazurio
 * App, not at all, with a value that is not the lock's version, as a pilot
 * application older than the first one with the lock that claims it anyway,
 * or as one whose version cannot be read or is missing. */
type LockAnnouncement =
  | "utility"
  | "app"
  | "none"
  | "broken"
  | "old-claims-lock"
  | "bad-version"
  | "no-version";

function fakeComputer(
  update: "answer" | "drop" | "refuse" = "answer",
  lock: LockAnnouncement = "utility",
  // Before its answer to `initialize`, the computer says its tools changed
  // and sends an unasked answer to a tool list, as a hostile or broken
  // application could.
  early = false,
) {
  const remote = new PassThrough();
  const received: Message[] = [];
  const held: (() => void)[] = [];
  const answer = (id: unknown, result: unknown) =>
    remote.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const send = (line: string) => {
    const message = JSON.parse(line) as Message;
    received.push(message);
    if (message.id === undefined) return;
    if (message.method === "initialize" && early) {
      remote.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
      );
      answer("t1", {
        tools: [{ name: "early_tool", inputSchema: { type: "object" } }],
      });
    }
    if (message.method === "initialize")
      answer(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-desktop", version: "1.0.0" },
        // Lazurio App announces itself only under its own key.
        _meta:
          lock === "app"
            ? { "io.lazurio/app": { version: "0.2.0", deviceLock: 1 } }
            : {
                "io.lazurio/agent-desktop": {
                  ...(lock === "no-version"
                    ? {}
                    : {
                        appVersion:
                          lock === "old-claims-lock"
                            ? "0.1.0-pilot.7"
                            : lock === "bad-version"
                              ? "pilot-8"
                              : "0.1.3",
                      }),
                  os: "macos",
                  osVersion: "26.1",
                  updateChannel: "beta",
                  ...(lock === "broken" ? { deviceLock: "yes" } : {}),
                  ...(lock === "utility" ||
                  lock === "old-claims-lock" ||
                  lock === "bad-version" ||
                  lock === "no-version"
                    ? { deviceLock: 1 }
                    : {}),
                },
              },
      });
    else if (message.method === "tools/list")
      answer(message.id, {
        tools: [{ name: "desktop_snapshot", inputSchema: { type: "object" } }],
      });
    else if (message.method === "ping") answer(message.id, {});
    else if (message.method === "tools/call") {
      const params = message.params as {
        name: string;
        arguments?: { command?: unknown };
      };
      const done = () =>
        answer(message.id, { content: [{ type: "text", text: "done" }] });
      if (params.name === "hold") held.push(done);
      else if (params.name === "locked")
        // The application's own lock across Environments (contract v1 §1).
        answer(message.id, {
          content: [
            {
              type: "text",
              text: "Počítač teď ovládá agent z Pracovní Prostředí. Zkuste to, až skončí.",
            },
          ],
          isError: true,
        });
      else if (params.name === "lazurio_shell_run")
        answer(
          message.id,
          String(params.arguments?.command ?? "").startsWith("uname")
            ? // As Lazurio Agent Desktop answers: its JSON as the one text.
              {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        exitCode: 0,
                        timedOut: false,
                        stdout: "secret output",
                        stderr: "",
                        truncated: false,
                      },
                      null,
                      2,
                    ),
                  },
                ],
                isError: false,
              }
            : {
                content: [{ type: "text", text: "ok" }],
                structuredContent: { exitCode: 3, stdout: "secret output" },
              },
        );
      else if (params.name === "lazurio_app_update") {
        // The application answers (or not), then restarts.
        if (update === "refuse")
          answer(message.id, {
            content: [{ type: "text", text: "no update" }],
            isError: true,
          });
        else {
          if (update === "answer") done();
          setTimeout(() => remote.end(), 30);
        }
      } else done();
    }
  };
  return {
    remote,
    send,
    received,
    release: () => {
      for (const done of held.splice(0)) done();
    },
  };
}

/** The fake computer's lines as the broker's transport. */
function lineTransport(computer: {
  remote: PassThrough;
  send: (line: string) => void;
}): BrokerTransport {
  let resolve: (reason: string) => void = () => undefined;
  const closed = new Promise<string>((done) => {
    resolve = done;
  });
  const listeners: ((line: string) => void)[] = [];
  computer.remote.on(
    "data",
    lineSplitter((line) => {
      for (const listener of listeners) listener(line);
    }),
  );
  computer.remote.once("end", () => resolve("session-closed"));
  return {
    send: computer.send,
    onMessage: (listener) => {
      listeners.push(listener);
    },
    closed,
    close: (reason) => resolve(reason),
  };
}

/** An agent on the broker's socket. */
async function agent(path: string, name: string) {
  const socket: Socket = await new Promise((resolve, reject) => {
    const created = createConnection({ path });
    created.once("connect", () => resolve(created));
    created.once("error", reject);
  });
  let buffer = "";
  const waiting = new Map<unknown, (message: Message) => void>();
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const message = JSON.parse(buffer.slice(0, newline)) as Message;
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown = {}) => {
    id++;
    const own = id;
    return new Promise<Message>((resolve) => {
      waiting.set(own, resolve);
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: own, method, params })}\n`,
      );
    });
  };
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version: "1" },
  });
  return { call, close: () => socket.end(), socket };
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withBroker(
  options: Partial<BrokerOptions>,
  run: (
    context: Readonly<{
      home: string;
      path: string;
      computer: ReturnType<typeof fakeComputer>;
      audit: AuditEntry[];
      done: Promise<number>;
    }>,
  ) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "lzc-"));
  const computer = fakeComputer();
  const audit: AuditEntry[] = [];
  const done = runBroker({
    home,
    uid: process.getuid?.(),
    device: "alex-macbook",
    name: "Alex MacBook",
    version: "test",
    transport: lineTransport(computer),
    stderr: () => undefined,
    audit: async (entry) => {
      audit.push({
        ts: new Date().toISOString(),
        device: "alex-macbook",
        ...entry,
      });
    },
    saveTools: (tools) =>
      writeTools(home, process.getuid?.(), "alex-macbook", tools),
    stillAllowed: async () => true,
    ...options,
  });
  const path = socketPath(home, "alex-macbook");
  try {
    await waitFor(() =>
      stat(path).then(
        () => true,
        () => false,
      ),
    );
    await run({ home, path, computer, audit, done });
  } finally {
    computer.remote.end();
    await done;
    await rm(home, { recursive: true, force: true });
  }
}

test.skipIf(!posix)(
  "forwards one agent's calls and writes a history without content",
  () =>
    withBroker({}, async ({ home, path, audit, computer }) => {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const first = await agent(path, "codex-mcp-client");
      const answer = await first.call("tools/call", {
        name: "desktop_type",
        arguments: { text: "secret password" },
      });
      expect(answer.result).toEqual({
        content: [{ type: "text", text: "done" }],
      });
      await waitFor(
        async () => (await readTools(home, "alex-macbook")) !== null,
      );
      expect(await readTools(home, "alex-macbook")).toEqual([
        { name: "desktop_snapshot", inputSchema: { type: "object" } },
      ]);
      // The computer received the arguments; the history did not.
      expect(JSON.stringify(computer.received)).toContain("secret password");
      expect(JSON.stringify(audit)).not.toContain("secret");
      // The application's own version wins over its engine's.
      expect(audit[0]).toMatchObject({
        version: "0.1.3",
        system: "macos",
        osVersion: "26.1",
        channel: "beta",
      });
      expect(audit.map((entry) => entry.event)).toEqual([
        "connected",
        "lease",
        "tool",
      ]);
      expect(audit[2]).toMatchObject({
        tool: "desktop_type",
        ok: true,
        agent: "codex-mcp-client",
      });
      first.close();
    }),
);

test.skipIf(!posix)(
  "holds the computer for one agent; the next one hears who and since when",
  () =>
    withBroker({ idleLeaseMs: 60_000 }, async ({ path, audit, computer }) => {
      const first = await agent(path, "claude-code");
      const second = await agent(path, "codex-mcp-client");
      // Listing tools needs no lease.
      expect((await second.call("tools/list")).result).toBeDefined();
      const working = first.call("tools/call", { name: "hold", arguments: {} });
      await waitFor(() =>
        computer.received.some(
          (message) => (message.params as { name?: string })?.name === "hold",
        ),
      );
      const refused = await second.call("tools/call", {
        name: "desktop_snapshot",
        arguments: {},
      });
      const error = refused.error as { code: number; message: string };
      expect(error.code).toBe(-32001);
      expect(error.message).toContain(
        "teď ovládá jiný agent (claude-code, od ",
      );
      computer.release();
      await working;
      // Still within its idle time: the first agent keeps the computer.
      expect(
        (await second.call("tools/call", { name: "desktop_snapshot" })).error,
      ).toBeDefined();
      first.close();
      await waitFor(() => audit.some((entry) => entry.event === "release"));
      const taken = await second.call("tools/call", {
        name: "desktop_snapshot",
      });
      expect(taken.result).toBeDefined();
      second.close();
    }),
);

test.skipIf(!posix)("an idle agent's lease passes to the next one", () =>
  withBroker({ idleLeaseMs: 50 }, async ({ path }) => {
    const first = await agent(path, "executor");
    const second = await agent(path, "claude-code");
    await first.call("tools/call", { name: "desktop_snapshot" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(
      (await second.call("tools/call", { name: "desktop_snapshot" })).result,
    ).toBeDefined();
    expect(
      (await first.call("tools/call", { name: "desktop_snapshot" })).error,
    ).toBeDefined();
    first.close();
    second.close();
  }),
);

test.skipIf(!posix)(
  "refuses a second session and ends cleanly when the computer leaves",
  () =>
    withBroker({}, async ({ home, path, audit, computer, done }) => {
      const other = fakeComputer();
      const refused = await runBroker({
        home,
        uid: process.getuid?.(),
        device: "alex-macbook",
        name: "Alex MacBook",
        version: "test",
        transport: lineTransport(other),
        stderr: () => undefined,
        audit: async () => undefined,
        saveTools: async () => undefined,
        stillAllowed: async () => true,
      });
      expect(refused).toBe(2);
      // The second session never reached the computer.
      expect(other.received).toEqual([]);
      computer.remote.end();
      expect(await done).toBe(0);
      expect(
        await stat(path).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(audit.at(-1)).toMatchObject({
        event: "disconnected",
        reason: "session-closed",
      });
    }),
);

test.skipIf(!posix)("a removed computer's session ends at the next ping", () =>
  withBroker(
    { checkMs: 20, stillAllowed: async () => false },
    async ({ audit, done }) => {
      expect(await done).toBe(0);
      expect(audit.at(-1)).toMatchObject({
        event: "disconnected",
        reason: "removed",
      });
    },
  ),
);

/** The agents' MCP server on its own stdio, as a harness or Executor runs
 * it. */
function entry(
  socket: string,
  cached: readonly unknown[] | null,
  updating?: () => Promise<boolean>,
) {
  const input = new PassThrough();
  const output: Message[] = [];
  const done = runAgentEntry({
    socket,
    name: "Alex MacBook",
    version: "test",
    input,
    write: (line) => output.push(JSON.parse(line) as Message),
    cachedTools: async () => cached,
    harness: "claude",
    retryMs: 20,
    ...(updating === undefined ? {} : { updating }),
  });
  const send = (message: Message) =>
    input.write(`${JSON.stringify(message)}\n`);
  const answer = async (id: number) => {
    await waitFor(() => output.some((message) => message.id === id));
    return output.find((message) => message.id === id) as Message;
  };
  return { input, output, done, send, answer };
}

/** A broker socket that completes the agents' server's handshake and then
 * closes the connection the moment the given method arrives, unanswered: a
 * request taken by a session that ends. */
async function closingBroker(path: string, closeOn: string) {
  const server = createServer((connection) => {
    connection.on(
      "data",
      lineSplitter((line) => {
        const message = JSON.parse(line) as Message;
        if (message.id === "lazurio-init")
          connection.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: "lazurio-init", result: {} })}\n`,
          );
        else if (message.method === closeOn) connection.destroy();
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return server;
}

for (const updating of [false, true])
  test.skipIf(!posix)(
    `a call the closing session took with it is answered as a call to an away computer (updating: ${updating})`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "lzc-"));
      const path = join(home, "broker.sock");
      const broker = await closingBroker(path, "tools/call");
      try {
        const server = entry(
          path,
          [{ name: "desktop_snapshot" }],
          async () => updating,
        );
        server.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        });
        await server.answer(1);
        server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        server.send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "desktop_snapshot", arguments: {} },
        });
        const lost = await server.answer(2);
        // The same shape as a call to a computer that is already away.
        expect(lost.error).toBeUndefined();
        const result = lost.result as {
          isError: boolean;
          content: { text: string }[];
        };
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain(
          updating ? "se aktualizuje. Zkuste to za chvíli" : "není připojený",
        );
        server.input.end();
        expect(await server.done).toBe(0);
      } finally {
        broker.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

test.skipIf(!posix)(
  "a tool list the closing session took with it is answered from the cache",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "lzc-"));
    const path = join(home, "broker.sock");
    const broker = await closingBroker(path, "tools/list");
    try {
      const server = entry(path, [{ name: "desktop_snapshot" }]);
      server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await server.answer(1);
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect((await server.answer(2)).result).toEqual({
        tools: [{ name: "desktop_snapshot" }],
      });
      server.input.end();
      expect(await server.done).toBe(0);
    } finally {
      broker.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  "the agents' server answers plainly while the computer is away",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "lzc-"));
    try {
      const server = entry(socketPath(home, "alex-macbook"), [
        { name: "desktop_snapshot" },
      ]);
      server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const init = (await server.answer(1)).result as Record<string, unknown>;
      expect(init.capabilities).toEqual({ tools: { listChanged: true } });
      expect(String(init.instructions)).toContain("Publikace");
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      server.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect((await server.answer(2)).result).toEqual({
        tools: [{ name: "desktop_snapshot" }],
      });
      server.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "desktop_snapshot", arguments: {} },
      });
      const away = (await server.answer(3)).result as {
        isError: boolean;
        content: { text: string }[];
      };
      expect(away.isError).toBe(true);
      expect(away.content[0]?.text).toContain(
        "Počítač Alex MacBook není připojený: na počítači je ovládání vypnuté, počítač spí nebo je offline.",
      );
      server.input.end();
      expect(await server.done).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  "the agents' server reaches the computer once it attaches",
  () =>
    withBroker({}, async ({ path, audit }) => {
      const server = entry(path, null);
      server.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "claude-code", version: "2" } },
      });
      await server.answer(1);
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      server.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "desktop_snapshot", arguments: {} },
      });
      expect((await server.answer(2)).result).toEqual({
        content: [{ type: "text", text: "done" }],
      });
      expect(audit.find((line) => line.event === "tool")?.agent).toBe(
        "claude-code via claude",
      );
      server.input.end();
      await server.done;
    }),
);

test("the application says its version in _meta, never through its engine's serverInfo", async () => {
  const { appOf } = await import("../src/computers/state");
  // The fixed contract wins over the older shapes.
  expect(
    appOf({
      serverInfo: { name: "agent-desktop", version: "0.4.0" },
      _meta: {
        "io.lazurio/agent-desktop": {
          appVersion: "0.1.5",
          os: "windows",
          osVersion: "10.0.26100",
          updateChannel: "stable",
        },
        "io.lazurio/app": { version: "0.0.1" },
      },
    }),
  ).toEqual({
    version: "0.1.5",
    system: "windows",
    osVersion: "10.0.26100",
    channel: "stable",
  });
  expect(
    appOf({
      serverInfo: { version: "9.9.9" },
      _meta: { "io.lazurio/app": { version: "v0.1.4", system: "windows" } },
    }),
  ).toEqual({ version: "v0.1.4", system: "windows" });
  // The engine's version is not the application's (seen on 2026-11-12:
  // an application without _meta read as its engine's 1.2.0).
  expect(
    appOf({ serverInfo: { name: "agent-desktop", version: "1.2.0" } }),
  ).toEqual({});
  expect(appOf({ _meta: { "io.lazurio/app": { version: "0.1.2" } } })).toEqual({
    version: "0.1.2",
  });
  // Nothing version-like, nothing at all.
  expect(appOf({ serverInfo: { version: "latest; rm -rf" } })).toEqual({});
  expect(
    appOf({ _meta: { "io.lazurio/app": { version: "<b>1</b>" } } }),
  ).toEqual({});
  expect(appOf(null)).toEqual({});
});

test.skipIf(!posix)("the history file is owner-only JSON lines", async () => {
  const home = await mkdtemp(join(tmpdir(), "lzc-"));
  try {
    const { appendAudit, auditPath, lastActivity } = await import(
      "../src/computers/state"
    );
    await appendAudit(home, process.getuid?.(), {
      ts: "2026-11-12T10:00:00.000Z",
      device: "alex-macbook",
      event: "connected",
    });
    await appendAudit(home, process.getuid?.(), {
      ts: "2026-11-12T10:05:00.000Z",
      device: "alex-macbook",
      event: "tool",
      tool: "desktop_snapshot",
      ok: true,
      ms: 12,
    });
    expect((await stat(auditPath(home))).mode & 0o777).toBe(0o600);
    expect((await readFile(auditPath(home), "utf8")).split("\n").length).toBe(
      3,
    );
    expect((await lastActivity(home)).get("alex-macbook")).toEqual({
      ts: "2026-11-12T10:05:00.000Z",
      event: "tool",
    });
    // A connection that names the application: kept until the next one.
    await appendAudit(home, process.getuid?.(), {
      ts: "2026-11-12T11:00:00.000Z",
      device: "alex-macbook",
      event: "connected",
      version: "0.1.3",
      system: "macos",
    });
    await appendAudit(home, process.getuid?.(), {
      ts: "2026-11-12T11:01:00.000Z",
      device: "alex-macbook",
      event: "disconnected",
    });
    expect((await lastActivity(home)).get("alex-macbook")).toEqual({
      ts: "2026-11-12T11:01:00.000Z",
      event: "disconnected",
      version: "0.1.3",
      system: "macos",
    });
    await appendAudit(home, process.getuid?.(), {
      ts: "2026-11-12T12:00:00.000Z",
      device: "alex-macbook",
      event: "connected",
    });
    expect(
      (await lastActivity(home)).get("alex-macbook")?.version,
    ).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const mode of ["answer", "drop"] as const)
  test.skipIf(!posix)(
    `an update the application starts (${mode}) is expected: the computer is away and agents hear it updates`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "lzc-"));
      const state = await import("../src/computers/state");
      const uid = process.getuid?.();
      const computer = fakeComputer(mode);
      const audit: AuditEntry[] = [];
      const done = runBroker({
        home,
        uid,
        device: "alex-macbook",
        name: "Alex MacBook",
        version: "test",
        transport: lineTransport(computer),
        stderr: () => undefined,
        audit: async (entry) => {
          audit.push({
            ts: new Date().toISOString(),
            device: "alex-macbook",
            ...entry,
          });
        },
        saveTools: async () => undefined,
        stillAllowed: async () => true,
        updating: {
          mark: () =>
            state.markUpdating(home, uid, "alex-macbook", Date.now() + 60_000),
          clear: () => state.clearUpdating(home, "alex-macbook"),
          active: () => state.isUpdating(home, "alex-macbook"),
        },
      });
      try {
        const path = socketPath(home, "alex-macbook");
        await waitFor(() =>
          stat(path).then(
            () => true,
            () => false,
          ),
        );
        const server = entry(path, null, () =>
          state.isUpdating(home, "alex-macbook"),
        );
        server.send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {},
        });
        await server.answer(1);
        server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        server.send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "lazurio_app_update", arguments: {} },
        });
        const started = await server.answer(2);
        // Never an error for the agent that asked.
        expect(started.error).toBeUndefined();
        expect(
          (started.result as { isError?: boolean }).isError,
        ).toBeUndefined();
        expect(await done).toBe(0);
        expect(audit.map((line) => line.event)).toContain("updating");
        expect(audit.at(-1)).toMatchObject({
          event: "disconnected",
          reason: "updating",
        });
        server.send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "desktop_snapshot", arguments: {} },
        });
        const later = (await server.answer(3)).result as {
          content: { text: string }[];
        };
        expect(later.content[0]?.text).toContain(
          "se aktualizuje. Zkuste to za chvíli",
        );
        server.input.end();
        await server.done;
      } finally {
        computer.remote.end();
        await done;
        await rm(home, { recursive: true, force: true });
      }
    },
  );

test.skipIf(!posix)(
  "an update the application refuses leaves no mark",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "lzc-"));
    const state = await import("../src/computers/state");
    const uid = process.getuid?.();
    const computer = fakeComputer("refuse");
    const done = runBroker({
      home,
      uid,
      device: "alex-macbook",
      name: "Alex MacBook",
      version: "test",
      transport: lineTransport(computer),
      stderr: () => undefined,
      audit: async () => undefined,
      saveTools: async () => undefined,
      stillAllowed: async () => true,
      updating: {
        mark: () =>
          state.markUpdating(home, uid, "alex-macbook", Date.now() + 60_000),
        clear: () => state.clearUpdating(home, "alex-macbook"),
        active: () => state.isUpdating(home, "alex-macbook"),
      },
    });
    try {
      const path = socketPath(home, "alex-macbook");
      await waitFor(() =>
        stat(path).then(
          () => true,
          () => false,
        ),
      );
      const first = await agent(path, "claude-code");
      const refused = await first.call("tools/call", {
        name: "lazurio_app_update",
      });
      expect((refused.result as { isError?: boolean }).isError).toBe(true);
      await waitFor(
        async () => !(await state.isUpdating(home, "alex-macbook")),
      );
      first.close();
    } finally {
      computer.remote.end();
      await done;
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  "the application's own lock is an ordinary failed call; of a shell command the history keeps its exit code, never the command or its output (review of #943)",
  () =>
    withBroker({}, async ({ path, audit }) => {
      const first = await agent(path, "claude-code");
      const locked = await first.call("tools/call", {
        name: "locked",
        arguments: {},
      });
      expect((locked.result as { isError?: boolean }).isError).toBe(true);
      // The session stays: the next call works.
      const shell = await first.call("tools/call", {
        name: "lazurio_shell_run",
        arguments: {
          command: "mysql -u root -p'hunter2-secret' -e 'select 1'",
          cwd: "~",
        },
      });
      expect(shell.result).toBeDefined();
      // The application's own answer carries the exit code in its JSON text.
      const text = await first.call("tools/call", {
        name: "lazurio_shell_run",
        arguments: { command: "uname -a # token tok-0123456789" },
      });
      expect(text.result).toBeDefined();
      await waitFor(
        () => audit.filter((line) => line.event === "tool").length === 3,
      );
      const tools = audit.filter((line) => line.event === "tool");
      expect(tools[0]).toMatchObject({ tool: "locked", ok: false });
      expect(tools[1]).toMatchObject({
        tool: "lazurio_shell_run",
        exitCode: 3,
      });
      expect(tools[2]).toMatchObject({
        tool: "lazurio_shell_run",
        ok: true,
        exitCode: 0,
      });
      for (const line of tools) expect(line).not.toHaveProperty("command");
      const history = JSON.stringify(audit);
      for (const secret of [
        "secret output",
        "hunter2-secret",
        "tok-0123456789",
        "mysql",
        "uname",
      ])
        expect(history).not.toContain(secret);
      expect(audit.map((line) => line.event)).not.toContain("disconnected");
      first.close();
    }),
);

test("a shell command's exit code comes from structuredContent or the application's one JSON text, and from nothing else", () => {
  const text = (value: string) => ({ type: "text", text: value });
  expect(
    shellExitCode({
      structuredContent: { exitCode: 3 },
      content: [text('{"exitCode":4}')],
    }),
  ).toBe(3);
  expect(
    shellExitCode({
      content: [text('{\n  "exitCode": 0,\n  "stdout": "Darwin"\n}')],
    }),
  ).toBe(0);
  expect(
    shellExitCode({
      structuredContent: { exitCode: "1" },
      content: [text('{"exitCode":2}')],
    }),
  ).toBe(2);
  // A command still running or stopped by its time limit has no code.
  expect(
    shellExitCode({ content: [text('{"exitCode":null,"timedOut":true}')] }),
  ).toBeUndefined();
  expect(shellExitCode({ content: [text("exit 0")] })).toBeUndefined();
  expect(
    shellExitCode({ content: [text('{"exitCode":1.5}')] }),
  ).toBeUndefined();
  expect(shellExitCode({ content: [text("[0]")] })).toBeUndefined();
  expect(
    shellExitCode({ content: [text('{"exitCode":1}'), text("more")] }),
  ).toBeUndefined();
  expect(
    shellExitCode({ content: [{ type: "image", data: '{"exitCode":1}' }] }),
  ).toBeUndefined();
  expect(shellExitCode(undefined)).toBeUndefined();
  expect(shellExitCode("0")).toBeUndefined();
});

/** Runs the broker against a computer that announces the lock as `lock`,
 * and returns how the session ended before any agent connected. With
 * `early`, the computer talks about tools before it answers `initialize`. */
async function sessionWith(lock: LockAnnouncement, early = false) {
  const home = await mkdtemp(join(tmpdir(), "lzc-"));
  const computer = fakeComputer("answer", lock, early);
  const saved: unknown[][] = [];
  const transport = lineTransport(computer);
  const audit: AuditEntry[] = [];
  const done = runBroker({
    home,
    uid: process.getuid?.(),
    device: "alex-macbook",
    name: "Alex MacBook",
    version: "test",
    transport,
    stderr: () => undefined,
    audit: async (entry) => {
      audit.push({
        ts: new Date().toISOString(),
        device: "alex-macbook",
        ...entry,
      });
    },
    saveTools: async (tools) => {
      saved.push([...tools]);
    },
    stillAllowed: async () => true,
  });
  return { home, computer, transport, audit, done, saved };
}

for (const lock of [
  "none",
  "broken",
  "old-claims-lock",
  "bad-version",
  "no-version",
] as const)
  test.skipIf(!posix)(
    `a computer that does not announce the device lock is refused before any agent reaches it (${lock})`,
    async () => {
      const session = await sessionWith(lock);
      try {
        expect(await session.done).toBe(brokerExit.refused);
        expect(await session.transport.closed).toBe("no-device-lock");
        expect(session.audit.at(-1)).toMatchObject({
          event: "refused",
          reason: "no-device-lock",
        });
        // No tool was asked for and no agent socket was placed.
        expect(
          session.computer.received.some(
            (message) => message.method === "tools/list",
          ),
        ).toBe(false);
        expect(
          await stat(socketPath(session.home, "alex-macbook")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      } finally {
        session.computer.remote.end();
        await rm(session.home, { recursive: true, force: true });
      }
    },
  );

for (const lock of ["utility", "app"] as const)
  test.skipIf(!posix)(
    `a computer that announces the device lock is served (${lock})`,
    async () => {
      const session = await sessionWith(lock);
      try {
        await waitFor(() =>
          stat(socketPath(session.home, "alex-macbook")).then(
            () => true,
            () => false,
          ),
        );
        expect(
          session.audit.some((entry) => entry.reason === "no-device-lock"),
        ).toBe(false);
      } finally {
        session.computer.remote.end();
        await session.done;
        await rm(session.home, { recursive: true, force: true });
      }
    },
  );

test.skipIf(!posix)(
  "a computer that talks about tools before its refused answer to initialize is asked for nothing and saves nothing (LZD-0018 task 854)",
  async () => {
    const session = await sessionWith("none", true);
    try {
      expect(await session.done).toBe(brokerExit.refused);
      expect(await session.transport.closed).toBe("no-device-lock");
      // The broker sent `initialize` and nothing else: no `tools/list`
      // after the early notification, no `tools/call`.
      expect(
        session.computer.received.map((message) => message.method),
      ).toEqual(["initialize"]);
      // The unasked tool list of the refused session is not kept.
      expect(session.saved).toEqual([]);
    } finally {
      session.computer.remote.end();
      await rm(session.home, { recursive: true, force: true });
    }
  },
);

test.skipIf(!posix)(
  "a computer that announces the lock and talks about tools before initialize gets its tools asked for once it is accepted",
  async () => {
    const session = await sessionWith("app", true);
    try {
      await waitFor(() => session.saved.length > 0);
      // Only the tools the broker asked for after the check are kept.
      expect(session.saved).toEqual([
        [{ name: "desktop_snapshot", inputSchema: { type: "object" } }],
      ]);
      const methods = session.computer.received.map(
        (message) => message.method,
      );
      expect(methods.slice(0, 3)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
    } finally {
      session.computer.remote.end();
      await session.done;
      await rm(session.home, { recursive: true, force: true });
    }
  },
);

test("versions are ordered as semver orders them, pre-releases numerically", () => {
  expect(compareVersions("0.1.0-pilot.7", "0.1.0-pilot.8")).toBe(-1);
  expect(compareVersions("0.1.0-pilot.10", "0.1.0-pilot.8")).toBe(1);
  expect(compareVersions("0.1.0-pilot.8", "0.1.0-pilot.8")).toBe(0);
  expect(compareVersions("0.1.0", "0.1.0-pilot.8")).toBe(1);
  expect(compareVersions("0.1.3", "0.1.0-pilot.8")).toBe(1);
  expect(compareVersions("0.0.9", "0.1.0-pilot.8")).toBe(-1);
  expect(compareVersions("0.1.0-pilot", "0.1.0-pilot.8")).toBe(-1);
  expect(compareVersions("0.1.0-beta.1", "0.1.0-pilot.8")).toBe(-1);
  for (const broken of ["pilot-8", "0.1", "v0.1.0", "01.1.0", "0.1.0-", ""])
    expect(compareVersions(broken, "0.1.0-pilot.8")).toBeUndefined();
});

test("the announcement holds for every application key present (LZD-0018 task 854)", () => {
  const utility = (about: Record<string, unknown>) => ({
    _meta: { "io.lazurio/agent-desktop": about },
  });
  expect(
    announcesDeviceLock(
      utility({ appVersion: "0.1.0-pilot.8", deviceLock: 1 }),
    ),
  ).toBe(true);
  expect(
    announcesDeviceLock(
      utility({ appVersion: "0.1.0-pilot.7", deviceLock: 1 }),
    ),
  ).toBe(false);
  expect(announcesDeviceLock(utility({ appVersion: 8, deviceLock: 1 }))).toBe(
    false,
  );
  expect(
    announcesDeviceLock({
      _meta: { "io.lazurio/app": { version: "0.2.0", deviceLock: 1 } },
    }),
  ).toBe(true);
  // A valid key does not cover a present key that fails.
  expect(
    announcesDeviceLock({
      _meta: {
        "io.lazurio/app": { version: "0.2.0", deviceLock: 1 },
        "io.lazurio/agent-desktop": { appVersion: "0.1.0-pilot.7" },
      },
    }),
  ).toBe(false);
  expect(announcesDeviceLock({ _meta: {} })).toBe(false);
  expect(announcesDeviceLock({ _meta: null })).toBe(false);
  expect(announcesDeviceLock(null)).toBe(false);
});
