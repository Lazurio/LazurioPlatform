import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runAgentEntry } from "../src/computers/agent-entry";
import { type BrokerOptions, runBroker } from "../src/computers/broker";
import {
  type AuditEntry,
  readTools,
  socketPath,
  writeTools,
} from "../src/computers/state";

// `lazurio computer attach` and `lazurio computer mcp` (decision F73): the
// broker takes the SSH session's stdio from a fake computer, opens the
// owner-only socket for agents, holds the computer for one agent at a time
// and writes a history without content; the agents' MCP server works with
// and without the computer. Every test runs in a temporary home.

const posix = process.platform !== "win32";
type Message = Record<string, unknown>;

/** A computer on the far end of the SSH session: answers like Agent
 * Desktop's MCP server. A call of `hold` waits until `release`. */
function fakeComputer() {
  const remote = new PassThrough();
  const received: Message[] = [];
  const held: (() => void)[] = [];
  const answer = (id: unknown, result: unknown) =>
    remote.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const send = (line: string) => {
    const message = JSON.parse(line) as Message;
    received.push(message);
    if (message.id === undefined) return;
    if (message.method === "initialize")
      answer(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-desktop", version: "1.0.0" },
      });
    else if (message.method === "tools/list")
      answer(message.id, {
        tools: [{ name: "desktop_snapshot", inputSchema: { type: "object" } }],
      });
    else if (message.method === "ping") answer(message.id, {});
    else if (message.method === "tools/call") {
      const params = message.params as { name: string };
      const done = () =>
        answer(message.id, { content: [{ type: "text", text: "done" }] });
      if (params.name === "hold") held.push(done);
      else done();
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
    remote: computer.remote,
    send: computer.send,
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
        remote: other.remote,
        send: other.send,
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
    { pingMs: 20, stillAllowed: async () => false },
    async ({ audit, done }) => {
      expect(await done).toBe(0);
      expect(audit.at(-1)).toMatchObject({
        event: "disconnected",
        reason: "removed",
      });
    },
  ),
);

test.skipIf(!posix)("a silent computer's session ends", () =>
  withBroker({ pingMs: 20, deadMs: 50 }, async ({ computer, audit, done }) => {
    // From now on the computer answers nothing.
    computer.remote.pause();
    expect(await done).toBe(0);
    expect(audit.at(-1)).toMatchObject({ reason: expect.any(String) });
  }),
);

/** The agents' MCP server on its own stdio, as a harness or Executor runs
 * it. */
function entry(socket: string, cached: readonly unknown[] | null) {
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
  });
  const send = (message: Message) =>
    input.write(`${JSON.stringify(message)}\n`);
  const answer = async (id: number) => {
    await waitFor(() => output.some((message) => message.id === id));
    return output.find((message) => message.id === id) as Message;
  };
  return { input, output, done, send, answer };
}

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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
