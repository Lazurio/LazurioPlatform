import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachHost,
  attachPath,
  createComputerAttach,
} from "../src/computers/attach-ws";
import { type ComputersHost, removeComputer } from "../src/computers/computers";
import {
  auditPath,
  computersDirectory,
  readRecord,
  recordPath,
  socketPath,
  toolsPath,
} from "../src/computers/state";
import { manualClock } from "./fixtures/manual-clock";

// A computer's session over HTTPS on contract v3 (Agent Desktop's channel,
// HumanAndMachine-ai/Auth docs/device-channel-entry.md, "The Launchpad"),
// against a real server on loopback. A fake check stands for the gateway
// helper's: the proof `ok-<device>` names that device, anything else is
// refused. No pairing and no registry: the gateway admits the computer, its
// first attach creates its record and its server in Executor. Every test
// runs in a temporary home.

const posix = process.platform !== "win32";
type Message = Record<string, unknown>;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A fake check of the gateway's proof, and whether each device may still
 * be served. Every confirmation lasts five minutes. */
function fakeGateway(now: () => number = Date.now) {
  const allowed = new Set<string>();
  const verifyGatewayProof = async (request: Request) => {
    const proof = request.headers.get("x-test-gateway-proof") ?? "";
    if (proof === "unavailable") throw new Error("helper down");
    const device = proof.startsWith("ok-") ? proof.slice(3) : null;
    if (device === null)
      return { ok: false as const, status: 401 as const, reason: "no-proof" };
    allowed.add(device);
    let deadline = now() + 300_000;
    return {
      ok: true as const,
      identity: {
        device,
        name: device,
        deadline: () => deadline,
        stillAllowed: async () => {
          if (!allowed.has(device)) return false;
          deadline = now() + 300_000;
          return true;
        },
      },
    };
  };
  return { allowed, verifyGatewayProof };
}

/** Executor as the attach route uses it: each added server's slug. */
function fakeServers() {
  const added: string[] = [];
  const removed: string[] = [];
  let hold: Promise<void> | null = null;
  return {
    added,
    removed,
    /** Holds every addition until the answer is called. */
    holdAdditions: () => {
      let release = () => {};
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    servers: {
      register: async (input: Readonly<{ deviceId: string; name: string }>) => {
        added.push(input.deviceId);
        if (hold !== null) await hold;
        return `po_${input.deviceId}_${added.length}`;
      },
      unregister: async (slug: string) => {
        removed.push(slug);
        return true;
      },
    },
  };
}

async function setup(
  options: Readonly<{
    gateway?: boolean;
    now?: () => number;
    setTimer?: AttachHost["setTimer"];
    attemptsPerMinute?: number;
    checkMs?: number;
    socketAnswers?: AttachHost["socketAnswers"];
  }> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "lzc-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const gateway = fakeGateway(options.now);
  const executor = fakeServers();
  const journal: Record<string, string>[] = [];
  const attach = createComputerAttach({
    home,
    uid: process.getuid?.(),
    version: "test",
    journal: (line) => journal.push({ ...line }),
    servers: executor.servers,
    ...(options.gateway === false
      ? {}
      : { verifyGatewayProof: gateway.verifyGatewayProof }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.attemptsPerMinute === undefined
      ? {}
      : { attemptsPerMinute: options.attemptsPerMinute }),
    ...(options.checkMs === undefined ? {} : { checkMs: options.checkMs }),
    ...(options.socketAnswers === undefined
      ? {}
      : { socketAnswers: options.socketAnswers }),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: attach.websocket,
    fetch(request, server) {
      return (
        attach.upgrade(
          request,
          server,
          server.requestIP(request)?.address ?? null,
        ) ?? undefined
      );
    },
  });
  cleanup.push(() => server.stop(true));
  return { home, attach, server, journal, gateway, executor };
}

/** A computer on contract v3: the gateway's proof in its upgrade, then MCP
 * as the app answers it. `os` is the system its `initialize` names. */
function computer(
  port: number,
  proof: string,
  options: Readonly<{ os?: string; query?: string }> = {},
) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${attachPath}${options.query ?? ""}`,
    { headers: { "x-test-gateway-proof": proof } } as unknown as string[],
  );
  const seen: Message[] = [];
  let closeReason = "";
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => {
      closeReason = event.reason;
      resolve(event.code);
    });
    ws.addEventListener("error", () => resolve(-1));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    seen.push(message);
    if (message.jsonrpc === undefined || message.id === undefined) return;
    const reply = (result: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize")
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "lazurio-device", version: "0.2.0" },
        _meta: {
          "io.lazurio/app": {
            version: "0.2.0",
            deviceLock: 1,
            ...(options.os === undefined ? {} : { os: options.os }),
          },
        },
      });
    else if (message.method === "tools/list")
      reply({ tools: [{ name: "desktop_snapshot", inputSchema: {} }] });
    else if (message.method === "tools/call")
      reply({ content: [{ type: "text", text: "snap" }] });
    else reply({});
  });
  return { ws, seen, closed, closeReason: () => closeReason };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const historyHas = (home: string, text: string) => () =>
  readFile(auditPath(home), "utf8").then(
    (history) => history.includes(text),
    () => false,
  );

/** One agent's call through the broker's socket. */
async function callTool(home: string): Promise<Message> {
  const socket = createConnection({ path: socketPath(home, "alex-macbook") });
  await new Promise((resolve) => socket.once("connect", resolve));
  let buffer = "";
  const answers: Message[] = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      answers.push(JSON.parse(buffer.slice(0, i)) as Message);
      buffer = buffer.slice(i + 1);
    }
  });
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } })}\n`,
  );
  socket.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desktop_snapshot", arguments: {} } })}\n`,
  );
  await waitFor(() => answers.some((answer) => answer.id === 2));
  socket.end();
  return answers.find((answer) => answer.id === 2) as Message;
}

const hostOf = (home: string): ComputersHost => ({
  platform: "linux",
  home,
  uid: process.getuid?.(),
  executorCommand: async () => null,
  executor: null,
  allowed: async () => true,
  locale: async () => "cs",
  version: "test",
});

test.skipIf(!posix)(
  "a computer the gateway proved is ready at once, agents reach it, and its first attach creates its record and its server",
  async () => {
    const { home, server, executor } = await setup();
    const fake = computer(server.port as number, "ok-alex-macbook", {
      os: "macos",
    });
    await waitFor(() => fake.seen.length > 0);
    // The first message is `ready` of contract v3; no challenge exists.
    expect(fake.seen[0]).toEqual({ type: "ready", v: 3 });
    expect((await callTool(home)).result).toEqual({
      content: [{ type: "text", text: "snap" }],
    });
    // Named by its device id; its system as its `initialize` named it.
    await waitFor(
      async () => (await readRecord(home, "alex-macbook"))?.os === "macos",
    );
    await waitFor(
      async () => (await readRecord(home, "alex-macbook"))?.executor !== null,
    );
    expect(await readRecord(home, "alex-macbook")).toEqual({
      deviceId: "alex-macbook",
      name: "alex-macbook",
      os: "macos",
      executor: "po_alex-macbook_1",
    });
    expect(executor.added).toEqual(["alex-macbook"]);
    fake.ws.close();
    await fake.closed;
    await waitFor(historyHas(home, '"disconnected"'));

    // The next attach duplicates nothing.
    const again = computer(server.port as number, "ok-alex-macbook", {
      os: "macos",
    });
    await waitFor(() => again.seen.some((m) => m.type === "ready"));
    await waitFor(
      async () =>
        (await readFile(auditPath(home), "utf8"))
          .split("\n")
          .filter((line) => line.includes('"connected"')).length === 2,
    );
    expect(executor.added).toEqual(["alex-macbook"]);
    expect(await readRecord(home, "alex-macbook")).toEqual({
      deviceId: "alex-macbook",
      name: "alex-macbook",
      os: "macos",
      executor: "po_alex-macbook_1",
    });
    again.ws.close();
    await again.closed;
  },
);

test.skipIf(!posix)(
  "a record's own name and server stay; a system its initialize does not name stays unknown",
  async () => {
    const { home, server, executor } = await setup();
    await mkdir(computersDirectory(home), { recursive: true, mode: 0o700 });
    await writeFile(
      recordPath(home, "alex-macbook"),
      JSON.stringify({
        deviceId: "alex-macbook",
        name: "MacBook Pro Alexe",
        os: null,
        executor: "po_old",
      }),
      { mode: 0o600 },
    );
    const fake = computer(server.port as number, "ok-alex-macbook");
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    await waitFor(historyHas(home, '"connected"'));
    expect(await readRecord(home, "alex-macbook")).toEqual({
      deviceId: "alex-macbook",
      name: "MacBook Pro Alexe",
      os: null,
      executor: "po_old",
    });
    expect(executor.added).toEqual([]);
    fake.ws.close();
    await fake.closed;
  },
);

test.skipIf(!posix)(
  "without the gateway's check the attach route answers 404 and upgrades nothing",
  async () => {
    const { attach, home } = await setup({ gateway: false });
    let upgraded = 0;
    const server = {
      upgrade: () => {
        upgraded += 1;
        return true;
      },
    };
    const url = `http://127.0.0.1${attachPath}`;
    const upgrade = { connection: "Upgrade", upgrade: "websocket" };
    for (const request of [
      new Request(url, { headers: upgrade }),
      new Request(`${url}?device=alex-macbook`, { headers: upgrade }),
      new Request(url, {
        headers: { ...upgrade, "x-test-gateway-proof": "ok-alex-macbook" },
      }),
      new Request(url),
      new Request(url, { method: "POST" }),
    ])
      expect((await attach.upgrade(request, server, "127.0.0.1"))?.status).toBe(
        404,
      );
    expect(upgraded).toBe(0);
    expect(await readRecord(home, "alex-macbook")).toBeNull();
  },
);

test.skipIf(!posix)(
  "contract v1's challenge and signature open no session",
  async () => {
    // A computer of contract v1: it names itself in the URL, waits for a
    // challenge and answers it with its signature.
    const keys = generateKeyPairSync("ed25519");
    const v1Computer = (port: number, query: string, key: KeyObject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${attachPath}${query}`);
      const seen: Message[] = [];
      const closed = new Promise<void>((resolve) => {
        ws.addEventListener("close", () => resolve());
        ws.addEventListener("error", () => resolve());
      });
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            type: "auth",
            v: 1,
            device: "alex-macbook",
            signature: sign(
              null,
              Buffer.from("lazurio-computer-attach-v1\nx\nnonce\n1"),
              key,
            ).toString("base64url"),
          }),
        ),
      );
      ws.addEventListener("message", (event) =>
        seen.push(JSON.parse(String(event.data)) as Message),
      );
      return { seen, closed };
    };
    for (const gateway of [true, false]) {
      const { server, home, journal } = await setup({ gateway });
      for (const query of ["?device=alex-macbook", ""]) {
        const attempt = v1Computer(
          server.port as number,
          query,
          keys.privateKey,
        );
        await attempt.closed;
        // No challenge, no `ready`: the upgrade itself was refused.
        expect(attempt.seen).toEqual([]);
      }
      expect(journal.some((line) => line.outcome === "ready")).toBe(false);
      expect(await readRecord(home, "alex-macbook")).toBeNull();
    }
    // The answers before the upgrade: 400 for the query, 401 without the
    // gateway's proof.
    const { attach } = await setup();
    const upgrade = { connection: "Upgrade", upgrade: "websocket" };
    const none = { upgrade: () => true };
    expect(
      (
        await attach.upgrade(
          new Request(`http://127.0.0.1${attachPath}?device=alex-macbook`, {
            headers: upgrade,
          }),
          none,
          "127.0.0.1",
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await attach.upgrade(
          new Request(`http://127.0.0.1${attachPath}`, { headers: upgrade }),
          none,
          "127.0.0.1",
        )
      )?.status,
    ).toBe(401);
  },
);

test.skipIf(!posix)(
  "only a GET upgrade with the gateway's proof, a few times a minute per address",
  async () => {
    const { attach, journal } = await setup({ attemptsPerMinute: 3 });
    const url = `http://127.0.0.1${attachPath}`;
    const upgrade = { connection: "Upgrade", upgrade: "websocket" };
    let upgraded = 0;
    const server = {
      upgrade: () => {
        upgraded += 1;
        return true;
      },
    };
    expect(
      (
        await attach.upgrade(
          new Request(url, { method: "POST" }),
          server,
          "127.0.0.1",
        )
      )?.status,
    ).toBe(405);
    expect(
      (await attach.upgrade(new Request(url), server, "127.0.0.1"))?.status,
    ).toBe(426);
    const from = (address: string, proof?: string) =>
      attach.upgrade(
        new Request(url, {
          headers: {
            ...upgrade,
            "x-forwarded-for": `198.51.100.1, ${address}`,
            ...(proof === undefined ? {} : { "x-test-gateway-proof": proof }),
          },
        }),
        server,
        "127.0.0.1",
      );
    expect((await from("203.0.113.7"))?.status).toBe(401);
    expect(journal.at(-1)).toMatchObject({
      outcome: "denied",
      reason: "no-proof",
    });
    expect((await from("203.0.113.7", "unavailable"))?.status).toBe(503);
    // A device id outside the pattern is refused even when the proof holds.
    expect((await from("203.0.113.7", "ok-Alex MacBook"))?.status).toBe(403);
    expect((await from("203.0.113.7", "ok-alex-macbook"))?.status).toBe(429);
    // Another address has its own attempts; the gateway's last entry counts.
    expect(await from("203.0.113.8", "ok-alex-macbook")).toBeUndefined();
    expect(upgraded).toBe(1);
  },
);

test.skipIf(!posix)(
  "one session per device, refused with denied of v3",
  async () => {
    const { server } = await setup();
    const first = computer(server.port as number, "ok-alex-macbook");
    await waitFor(() => first.seen.some((m) => m.type === "ready"));
    const second = computer(server.port as number, "ok-alex-macbook");
    expect(await second.closed).toBe(1008);
    expect(second.seen.at(-1)).toEqual({
      type: "denied",
      v: 3,
      reason: "already-attached",
    });
    first.ws.close();
    await first.closed;
  },
);

test.skipIf(!posix)(
  "a session whose proof is no longer confirmed ends with denied expired, also on the close",
  async () => {
    const clock = manualClock(Date.now());
    const { home, server, gateway } = await setup({
      now: clock.now,
      setTimer: clock.setTimer,
    });
    const fake = computer(server.port as number, "ok-alex-macbook");
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    gateway.allowed.delete("alex-macbook");
    clock.advance(60_000);
    expect(await fake.closed).toBe(1008);
    expect(fake.seen.at(-1)).toEqual({
      type: "denied",
      v: 3,
      reason: "expired",
    });
    expect(fake.closeReason()).toBe("expired");
    await waitFor(historyHas(home, '"disconnected"'));
  },
);

test.skipIf(!posix)(
  "a computer removed while attached loses its session at the broker's next check, and attaches again while it stays approved",
  async () => {
    const { home, server, executor } = await setup({ checkMs: 30 });
    const fake = computer(server.port as number, "ok-alex-macbook", {
      os: "windows",
    });
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    await waitFor(historyHas(home, '"connected"'));
    await waitFor(
      async () => (await readRecord(home, "alex-macbook"))?.executor !== null,
    );
    const removed = await removeComputer(hostOf(home), "alex-macbook");
    expect(removed).toMatchObject({
      kind: "computer-removed",
      deviceId: "alex-macbook",
    });
    expect(await fake.closed).toBe(1008);
    expect(fake.seen.at(-1)).toEqual({
      type: "denied",
      v: 3,
      reason: "expired",
    });
    await waitFor(historyHas(home, '"reason":"removed"'));
    expect(await readRecord(home, "alex-macbook")).toBeNull();
    expect(
      await readFile(toolsPath(home, "alex-macbook")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // The history stays.
    expect(await readFile(auditPath(home), "utf8")).toContain('"connected"');

    // Still approved at the gateway: it attaches again and is created anew.
    const again = computer(server.port as number, "ok-alex-macbook", {
      os: "windows",
    });
    await waitFor(() => again.seen.some((m) => m.type === "ready"));
    await waitFor(
      async () => (await readRecord(home, "alex-macbook"))?.os === "windows",
    );
    await waitFor(() => executor.added.length === 2);
    again.ws.close();
    await again.closed;
  },
);

test.skipIf(!posix)(
  "a server Executor added after the computer was removed is taken out again",
  async () => {
    const { home, server, executor } = await setup({ checkMs: 30 });
    const release = executor.holdAdditions();
    const fake = computer(server.port as number, "ok-alex-macbook");
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    await waitFor(() => executor.added.length === 1);
    expect(await removeComputer(hostOf(home), "alex-macbook")).toMatchObject({
      kind: "computer-removed",
      agents: "none",
    });
    await fake.closed;
    release();
    await waitFor(() => executor.removed.length === 1);
    expect(executor.removed).toEqual(["po_alex-macbook_1"]);
    expect(await readRecord(home, "alex-macbook")).toBeNull();
  },
);

test.skipIf(!posix)(
  "two simultaneous sessions of one device, only one is ready (review of #1036)",
  async () => {
    // The check of the device's socket answers only once both sessions are
    // waiting on it, so both pass every check made before it.
    let waiting = 0;
    let release = () => {};
    const bothWaiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { server } = await setup({
      socketAnswers: async () => {
        waiting += 1;
        if (waiting === 2) release();
        await Promise.race([
          bothWaiting,
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
        return false;
      },
    });
    const both = [
      computer(server.port as number, "ok-alex-macbook"),
      computer(server.port as number, "ok-alex-macbook"),
    ];
    await waitFor(() => both.every((fake) => fake.seen.length > 0));
    const ready = both.filter((fake) =>
      fake.seen.some((message) => message.type === "ready"),
    );
    const denied = both.filter((fake) =>
      fake.seen.some(
        (message) =>
          message.type === "denied" && message.reason === "already-attached",
      ),
    );
    expect(ready.length).toBe(1);
    expect(denied.length).toBe(1);
    for (const fake of both) fake.ws.close();
    await Promise.all(both.map((fake) => fake.closed));
  },
);

test.skipIf(!posix)(
  "the Launchpad without the wiring: the attach route is 404 without a session, and the pairing page and POST /api/computers are gone",
  async () => {
    const { realpath } = await import("node:fs/promises");
    const { initializeHandoverFolder } = await import(
      "../src/folder/initialize-folder"
    );
    const { executionOs } = await import("../src/folder/platform");
    const { presetProfile } = await import("../src/folder/presets");
    const { startLaunchpad } = await import("../src/launchpad/server");
    const { organizationWithEntry } = await import(
      "./fixtures/machine-bindings"
    );
    const { freePort } = await import("./fixtures/ports");
    const parent = await realpath(await mkdtemp(join(tmpdir(), "lzc-hosted-")));
    cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const folder = join(parent, "Lazurio");
    await mkdir(folder, { mode: 0o700 });
    await mkdir(join(folder, "organizations"), { mode: 0o755 });
    await mkdir(join(folder, "personalspace"), { mode: 0o700 });
    const preset = "hosted-organization-personal";
    const machine = organizationWithEntry(freePort());
    const entry = machine.entry;
    if (entry === undefined) throw new Error("The fixture has an entry");
    await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile: presetProfile(preset, executionOs(process.platform)),
    });
    const home = join(parent, "home");
    await mkdir(join(home, ".ssh"), { recursive: true, mode: 0o700 });
    // A computer of the old SSH path: only an installed Launchpad removes
    // its line.
    const oldLine = `restrict,command="/home/alex/.local/bin/lazurio computer attach --device alex-old" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB lazurio-computer:alex-old:alex:2026-11-12\n`;
    await writeFile(join(home, ".ssh", "authorized_keys"), oldLine, {
      mode: 0o600,
    });
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      // A session with the cookie is admitted.
      { fetcher: async () => new Response("ok") },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        platform: process.platform,
        home,
        uid: process.getuid?.(),
        user: "alex",
        today: () => "2026-11-13",
        hostKeyPath: join(parent, "none.pub"),
        tailnet: async () => ({
          state: "unavailable",
          reason: "tailscale-missing",
        }),
      },
    );
    cleanup.push(async () => {
      await app.close();
    });
    const host = new URL(entry.externalOrigin).host;
    const base = `127.0.0.1:${entry.listenPort}`;
    const upgrade = { connection: "Upgrade", upgrade: "websocket" };
    // The attach route without the gateway's check: 404, no session needed
    // for that answer, nothing upgrades.
    expect(
      (
        await fetch(`http://${base}${attachPath}`, {
          headers: { host, ...upgrade },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`http://${base}${attachPath}?device=alex-old`, {
          headers: { host, ...upgrade },
        })
      ).status,
    ).toBe(404);
    expect(await readFile(join(home, ".ssh", "authorized_keys"), "utf8")).toBe(
      oldLine,
    );
    // Every other route still needs the session.
    expect(
      (await fetch(`http://${base}/api/computers`, { headers: { host } }))
        .status,
    ).toBe(401);
    // With the session: the list stays, the pairing is gone.
    const admitted = {
      host,
      cookie: "__Secure-lazurio-workspace=valid",
    };
    const list = await fetch(`http://${base}/api/computers`, {
      headers: admitted,
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      kind: "computers",
      supported: true,
      computers: [],
    });
    expect(
      (
        await fetch(
          `http://${base}/connect/computer?name=x&os=macos&pubkey=x&callback=x&state=x`,
          { headers: admitted },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`http://${base}/api/computers`, {
          method: "POST",
          headers: {
            ...admitted,
            origin: entry.externalOrigin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Alex MacBook",
            os: "macos",
            publicKey: "ssh-ed25519 AAAA",
          }),
        })
      ).status,
    ).toBe(404);
  },
);
