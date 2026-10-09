import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationsCatalog } from "../src/integrations/catalog";
import {
  type ConnectHost,
  createConnectSessions,
} from "../src/integrations/connect";
import {
  type ExecutorEndpoint,
  executorCall,
  listenerOwnedBy,
} from "../src/integrations/executor-client";
import { readExecutor } from "../src/integrations/executor-source";
import { startFakeExecutor } from "./fixtures/fake-executor-api";
import { runChild } from "./fixtures/run-child";

// The Launchpad's client of the Environment's Executor (decision F42): the
// console token is read only from an owner-only regular file, sent only to a
// listener proven to be this account's, never through a proxy of the
// environment, and an answer of another shape is never guessed at.

const token = "clientTokenCanary000000000000000000";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function world(mode = 0o600) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "lazurio-executor-")),
  );
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const dataDir = join(parent, ".executor");
  await mkdir(join(dataDir, "server-control"), { recursive: true });
  const file = join(dataDir, "server-control", "auth.json");
  await writeFile(file, JSON.stringify({ token }), { mode });
  await chmod(file, mode);
  const executor = await startFakeExecutor(token);
  cleanups.push(() => executor.stop());
  const host = (owned = true): ExecutorEndpoint => ({
    dataDir,
    port: executor.port,
    uid: process.getuid?.() ?? 0,
    ownsListener: async () => owned,
  });
  return { parent, dataDir, file, executor, host };
}

test("the token goes only from an owner-only file, only to this account's listener", async () => {
  const ok = await world();
  expect(await executorCall(ok.host(), "GET", "/integrations")).toEqual({
    kind: "answer",
    status: 200,
    body: [],
  });
  expect(ok.executor.calls.map((call) => call.authorized)).toEqual([true]);
  // A listener that is not proven this account's never sees it.
  expect(await executorCall(ok.host(false), "GET", "/integrations")).toEqual({
    kind: "unavailable",
    reason: "listener-unproven",
  });
  expect(ok.executor.calls).toHaveLength(1);
  // A file others may read, or a link to the file, is refused.
  const loose = await world(0o644);
  expect(await executorCall(loose.host(), "GET", "/integrations")).toEqual({
    kind: "unavailable",
    reason: "token-unreadable",
  });
  expect(loose.executor.calls).toEqual([]);
  const linked = await world();
  const target = join(linked.parent, "elsewhere.json");
  await writeFile(target, JSON.stringify({ token }), { mode: 0o600 });
  await rm(linked.file);
  await symlink(target, linked.file);
  expect(await executorCall(linked.host(), "GET", "/integrations")).toEqual({
    kind: "unavailable",
    reason: "token-unreadable",
  });
  await rm(linked.file);
  expect(await executorCall(linked.host(), "GET", "/integrations")).toEqual({
    kind: "unavailable",
    reason: "token-missing",
  });
  expect(linked.executor.calls).toEqual([]);
});

test("no proxy of the environment ever sees the token", async () => {
  const { dataDir, executor } = await world();
  const seen: string[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization") ?? request.url);
      return new Response("proxied");
    },
  });
  cleanups.push(() => proxy.stop(true));
  const address = `http://127.0.0.1:${proxy.port}`;
  // The proxy variables reach only a process of their own.
  const child = await runChild(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures", "executor-call.ts"),
      dataDir,
      String(executor.port),
    ],
    {
      env: {
        ...process.env,
        HTTP_PROXY: address,
        http_proxy: address,
        ALL_PROXY: address,
        all_proxy: address,
        NO_PROXY: "",
        no_proxy: "",
        NODE_USE_ENV_PROXY: "1",
      },
      timeout: 20_000,
    },
  );
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({
    kind: "answer",
    status: 200,
    body: [],
  });
  expect(seen).toEqual([]);
  expect(executor.calls.map((call) => call.authorized)).toEqual([true]);
});

test("no redirect is followed and no answer of another kind is taken", async () => {
  const { dataDir } = await world();
  const odd = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        });
      if (path === "/api/text") return new Response("not json");
      if (path === "/api/large")
        return new Response("x".repeat(3 * 1024 * 1024));
      return new Response("Unauthorized", { status: 401 });
    },
  });
  cleanups.push(() => odd.stop(true));
  const host: ExecutorEndpoint = {
    dataDir,
    port: odd.port as number,
    uid: process.getuid?.() ?? 0,
    ownsListener: async () => true,
  };
  expect(await executorCall(host, "GET", "/redirect")).toEqual({
    kind: "failed",
    reason: "redirect",
  });
  expect(await executorCall(host, "GET", "/text")).toEqual({
    kind: "failed",
    reason: "not-json",
  });
  expect(await executorCall(host, "GET", "/large")).toEqual({
    kind: "failed",
    reason: "too-large",
  });
  expect(await executorCall(host, "GET", "/other")).toEqual({
    kind: "answer",
    status: 401,
    body: null,
  });
  // A refused token makes the source unreadable, never "nothing connected".
  expect(await readExecutor(host, integrationsCatalog)).toEqual({
    state: "unreadable",
  });
});

test("an Executor answer of another shape makes the source unreadable", async () => {
  const shapes: [string, unknown][] = [
    ["integrations not a list", { integrations: {} }],
    [
      "an integration without a slug",
      { integrations: [{ name: "x", kind: "mcp" }] },
    ],
    [
      "a connection of an unknown owner",
      { connections: [{ owner: "team", name: "default", integration: "x" }] },
    ],
    [
      "an unknown health",
      {
        connections: [
          {
            owner: "org",
            name: "default",
            integration: "x",
            lastHealth: { status: "fine" },
          },
        ],
      },
    ],
    [
      "a connection name of another form",
      { connections: [{ owner: "org", name: "../x", integration: "x" }] },
    ],
  ];
  const { dataDir } = await world();
  for (const [name, answer] of shapes) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const shape = answer as Record<string, unknown>;
        if (path === "/api/integrations")
          return Response.json(shape.integrations ?? []);
        if (path === "/api/connections")
          return Response.json(shape.connections ?? []);
        return Response.json(null, { status: 404 });
      },
    });
    const reading = await readExecutor(
      {
        dataDir,
        port: server.port as number,
        uid: process.getuid?.() ?? 0,
        ownsListener: async () => true,
      },
      integrationsCatalog,
    );
    await server.stop(true);
    expect([name, reading]).toEqual([name, { state: "unreadable" }]);
  }
});

test.if(existsSync("/usr/sbin/lsof") || existsSync("/usr/bin/lsof"))(
  "a loopback listener of this process is this account's, and of no other",
  async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
    });
    cleanups.push(() => server.stop(true));
    const uid = process.getuid?.() ?? 0;
    expect(await listenerOwnedBy(server.port as number, uid)).toBe(true);
    expect(await listenerOwnedBy(server.port as number, uid + 1)).toBe(false);
  },
);

function sessionsOver(
  host: ExecutorEndpoint,
  environmentBrowser: ConnectHost["environmentBrowser"],
) {
  return createConnectSessions(() => ({
    executor: host,
    composio: async () => null,
    environmentBrowser,
  }));
}

test("on a Remote Environment the sign-in opens in the Environment browser, and the page gets only the view", async () => {
  const { executor, host } = await world();
  executor.probes.set("https://mcp.linear.app/mcp", { requiresOAuth: true });
  const opened: string[] = [];
  const sessions = sessionsOver(host(), async (url) => {
    opened.push(url);
    return { view: "https://browser.example.lazurio.io/t/TARGET" };
  });
  const started = await sessions.start("linear", "direct", null);
  expect(started).toEqual({
    kind: "authorize",
    session: expect.stringMatching(/^[0-9a-f]{32}$/),
    view: "https://browser.example.lazurio.io/t/TARGET",
  });
  expect(opened).toEqual(["https://auth.example.test/authorize?state=state1"]);
  // Without the Environment browser the sign-in cannot finish there.
  const none = sessionsOver(host(), async () => null);
  expect(await none.start("linear", "direct", null)).toEqual({
    kind: "blocked",
    reason: "browser-unavailable",
  });
  // An app the catalog does not know, or without a direct path.
  expect(await none.start("nope", "direct", null)).toEqual({
    kind: "blocked",
    reason: "app-unknown",
  });
  expect(await none.start("salesforce", "direct", null)).toEqual({
    kind: "blocked",
    reason: "path-unavailable",
  });
});
