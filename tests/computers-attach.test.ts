import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachMessage,
  attachPath,
  createComputerAttach,
  verifyAttach,
} from "../src/computers/attach-ws";
import { type RegistryEntry, updateRegistry } from "../src/computers/registry";
import { auditPath, socketPath } from "../src/computers/state";

// A computer's session over HTTPS (contract v1 section 2, decision F73's
// addendum of 2026-11-13), against a real server on loopback and a fake
// computer that signs with its own ed25519 key: the challenge, the checks
// of the signature, the challenge's age, the pairing and the one session,
// `denied` with its reason, `ready`, and then the broker as ever. Every test
// runs in a temporary home.

const posix = process.platform !== "win32";
type Message = Record<string, unknown>;
const wire = (bytes: Buffer) =>
  Buffer.concat([Buffer.alloc(4), bytes])
    .fill(0, 0, 3)
    .fill(bytes.length, 3, 4);

function sshKey(publicKey: KeyObject): string {
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x as string,
    "base64url",
  );
  return `ssh-ed25519 ${Buffer.concat([wire(Buffer.from("ssh-ed25519")), wire(raw)]).toString("base64")}`;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(
  options: Readonly<{
    now?: () => number;
    attemptsPerMinute?: number;
    checkMs?: number;
  }> = {},
) {
  const home = await mkdtemp(join(tmpdir(), "lzc-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const entry: RegistryEntry = {
    deviceId: "alex-macbook",
    name: "MacBook Pro Alexe",
    os: "macos",
    publicKey: sshKey(keys.publicKey),
    fingerprint: "SHA256:test",
    addedBy: "alex",
    added: "2026-11-13",
    executor: null,
  };
  await updateRegistry(home, process.getuid?.(), () => ({
    computers: [entry],
    result: null,
  }));
  const journal: Record<string, string>[] = [];
  const attach = createComputerAttach({
    home,
    uid: process.getuid?.(),
    environmentId: () => "launchpad.alex-work.example",
    version: "test",
    journal: (line) => journal.push({ ...line }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.attemptsPerMinute === undefined
      ? {}
      : { attemptsPerMinute: options.attemptsPerMinute }),
    ...(options.checkMs === undefined ? {} : { checkMs: options.checkMs }),
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
  return { home, keys, attach, server, journal };
}

/** A fake computer: signs the challenge with `key` and then answers MCP. */
function computer(
  port: number,
  key: KeyObject,
  device = "alex-macbook",
  query = "?device=alex-macbook",
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${attachPath}${query}`);
  const seen: Message[] = [];
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    seen.push(message);
    if (message.type === "challenge") {
      const signature = sign(
        null,
        attachMessage(
          message.environment as string,
          message.nonce as string,
          message.ts as number,
        ),
        key,
      ).toString("base64url");
      ws.send(JSON.stringify({ type: "auth", v: 1, device, signature }));
      return;
    }
    if (message.jsonrpc === undefined || message.id === undefined) return;
    const reply = (result: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize")
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-desktop", version: "1.2.0" },
        _meta: {
          "io.lazurio/agent-desktop": { appVersion: "0.2.0", os: "macos" },
        },
      });
    else if (message.method === "tools/list")
      reply({ tools: [{ name: "desktop_snapshot", inputSchema: {} }] });
    else if (message.method === "tools/call")
      reply({ content: [{ type: "text", text: "snap" }] });
    else reply({});
  });
  return { ws, seen, closed };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000) {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

test.skipIf(!posix)(
  "a paired computer that signs the challenge gets ready, and agents reach it",
  async () => {
    const { home, keys, server } = await setup();
    const fake = computer(server.port as number, keys.privateKey);
    await waitFor(() => fake.seen.some((message) => message.type === "ready"));
    const challenge = fake.seen[0] as Message;
    expect(challenge).toMatchObject({
      type: "challenge",
      v: 1,
      environment: "launchpad.alex-work.example",
    });
    expect(String(challenge.nonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await waitFor(() =>
      readFile(auditPath(home), "utf8").then(
        (text) => text.includes('"connected"'),
        () => false,
      ),
    );
    expect((await callTool(home)).result).toEqual({
      content: [{ type: "text", text: "snap" }],
    });
    const history = await readFile(auditPath(home), "utf8");
    expect(history).toContain('"version":"0.2.0"');
    // A second session of the same computer is refused.
    const second = computer(server.port as number, keys.privateKey);
    expect(await second.closed).toBe(1008);
    expect(second.seen.at(-1)).toEqual({
      type: "denied",
      reason: "already-attached",
    });
    fake.ws.close();
    await fake.closed;
    await waitFor(() =>
      readFile(auditPath(home), "utf8").then((text) =>
        text.includes('"disconnected"'),
      ),
    );
  },
);

for (const [why, run] of [
  [
    "bad-signature",
    (port: number) => computer(port, generateKeyPairSync("ed25519").privateKey),
  ],
  [
    "not-paired",
    (port: number) =>
      computer(
        port,
        generateKeyPairSync("ed25519").privateKey,
        "someone-else",
        "",
      ),
  ],
  [
    "device-mismatch",
    (port: number) =>
      computer(port, generateKeyPairSync("ed25519").privateKey, "someone-else"),
  ],
] as const)
  test.skipIf(!posix)(
    `a computer that fails the check is denied: ${why}`,
    async () => {
      const { server, journal } = await setup();
      const fake = run(server.port as number);
      expect(await fake.closed).toBe(1008);
      expect(fake.seen.at(-1)).toEqual({ type: "denied", reason: why });
      expect(fake.seen.some((message) => message.type === "ready")).toBe(false);
      expect(journal.at(-1)).toMatchObject({ outcome: "denied", reason: why });
    },
  );

test.skipIf(!posix)("an answer to an old challenge is denied", async () => {
  let clock = Date.now();
  const { server, keys } = await setup({ now: () => clock });
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}${attachPath}?device=alex-macbook`,
  );
  const seen: Message[] = [];
  const closed = new Promise((resolve) =>
    ws.addEventListener("close", resolve),
  );
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    seen.push(message);
    if (message.type !== "challenge") return;
    clock += 61_000;
    ws.send(
      JSON.stringify({
        type: "auth",
        v: 1,
        device: "alex-macbook",
        signature: sign(
          null,
          attachMessage(
            message.environment as string,
            message.nonce as string,
            message.ts as number,
          ),
          keys.privateKey,
        ).toString("base64url"),
      }),
    );
  });
  await closed;
  expect(seen.at(-1)).toEqual({ type: "denied", reason: "challenge-expired" });
});

test.skipIf(!posix)(
  "a computer removed while attached loses its session",
  async () => {
    const { home, keys, server } = await setup({ checkMs: 30 });
    const fake = computer(server.port as number, keys.privateKey);
    await waitFor(() => fake.seen.some((message) => message.type === "ready"));
    await updateRegistry(home, process.getuid?.(), () => ({
      computers: [],
      result: null,
    }));
    await fake.closed;
    await waitFor(() =>
      readFile(auditPath(home), "utf8").then((text) =>
        text.includes('"reason":"removed"'),
      ),
    );
  },
);

test.skipIf(!posix)(
  "only a GET upgrade to a WebSocket, a few times a minute per address",
  async () => {
    const { attach } = await setup({ attemptsPerMinute: 2 });
    const url = `http://127.0.0.1${attachPath}`;
    const upgrade = { connection: "Upgrade", upgrade: "websocket" };
    const server = { upgrade: () => true };
    expect(
      attach.upgrade(new Request(url, { method: "POST" }), server, "127.0.0.1")
        ?.status,
    ).toBe(405);
    expect(attach.upgrade(new Request(url), server, "127.0.0.1")?.status).toBe(
      426,
    );
    expect(
      attach.upgrade(
        new Request(`${url}?device=A B`, { headers: upgrade }),
        server,
        "127.0.0.1",
      )?.status,
    ).toBe(400);
    const from = (address: string) =>
      attach.upgrade(
        new Request(url, {
          headers: {
            ...upgrade,
            "x-forwarded-for": `198.51.100.1, ${address}`,
          },
        }),
        server,
        "127.0.0.1",
      );
    expect(from("203.0.113.7")).toBeUndefined();
    expect(from("203.0.113.7")).toBeUndefined();
    expect(from("203.0.113.7")?.status).toBe(429);
    // Another address has its own attempts; the gateway's last entry counts.
    expect(from("203.0.113.8")).toBeUndefined();
  },
);

test("the signature is checked over exactly the contract's bytes", () => {
  const keys = generateKeyPairSync("ed25519");
  const message = attachMessage("env", "nonce", 1700000000000);
  expect(message.toString()).toBe(
    "lazurio-computer-attach-v1\nenv\nnonce\n1700000000000",
  );
  const signature = sign(null, message, keys.privateKey).toString("base64url");
  expect(verifyAttach(sshKey(keys.publicKey), message, signature)).toBe(true);
  expect(
    verifyAttach(
      sshKey(keys.publicKey),
      attachMessage("env", "nonce", 1700000000001),
      signature,
    ),
  ).toBe(false);
  expect(verifyAttach(sshKey(keys.publicKey), message, "short")).toBe(false);
});

test.skipIf(!posix)(
  "behind the gateway the attach route needs no session, and nothing else opens without one",
  async () => {
    const { mkdir, realpath } = await import("node:fs/promises");
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
    await mkdir(home, { mode: 0o700 });
    const app = await startLaunchpad(
      folder,
      undefined,
      undefined,
      undefined,
      // Every session is refused: only the attach route may answer.
      { fetcher: async () => new Response("no", { status: 401 }) },
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
    // The computer's WebSocket with the gateway's Host: the challenge comes
    // without any session.
    const ws = new WebSocket(`ws://${base}${attachPath}`, {
      headers: { host },
    } as unknown as string[]);
    const first = await new Promise<Message>((resolve, reject) => {
      ws.addEventListener("message", (event) =>
        resolve(JSON.parse(String(event.data)) as Message),
      );
      ws.addEventListener("error", () => reject(new Error("no upgrade")));
    });
    expect(first).toMatchObject({ type: "challenge", v: 1 });
    ws.close();
    // The same path without an upgrade is no page, and another Host no
    // answer; every other route still needs the session.
    expect(
      (await fetch(`http://${base}${attachPath}`, { headers: { host } }))
        .status,
    ).toBe(426);
    expect(
      (
        await fetch(`http://${base}${attachPath}`, {
          headers: {
            host: "evil.example",
            connection: "Upgrade",
            upgrade: "websocket",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(`http://${base}/api/computers`, { headers: { host } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`http://${base}/.lazurio/computers`, { headers: { host } }))
        .status,
    ).toBe(401);
  },
);
