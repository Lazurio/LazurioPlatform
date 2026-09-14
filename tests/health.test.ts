import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHealthListener,
  probeListenerHealth,
} from "../src/modules/health";
import { readModuleApplication } from "../src/modules/read-application";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

const listener = (port: number, path = "/health") => ({
  host: "127.0.0.1",
  port,
  protocol: "http",
  health: { kind: "http", path },
});

test.skipIf(process.platform === "win32")(
  "declared module health follows a real fixture process, not a mocked request",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "module-health-")),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--no-compile-autoload-dotenv",
        fileURLToPath(new URL("fixtures/health-app.ts", import.meta.url)),
      ],
      {
        cwd: root,
        env: {},
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reader = child.stdout.getReader();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Fixture start timeout")),
            3000,
          );
        }),
      ]);
      clearTimeout(timer);
      reader.releaseLock();
      const port = Number(new TextDecoder().decode(chunk.value).trim());
      expect(Number.isInteger(port) && port >= 1024).toBe(true);
      await mkdir(join(root, "app"));
      await writeFile(
        join(root, "lazurio.module.json"),
        JSON.stringify({
          schema_version: "lazurio.module.v1",
          id: "fixture",
          company: "Example",
          tcp_port_policy: { mode: "single" },
          port_leases: [{ id: "main", host: "127.0.0.1", port }],
          apps: ["app/package.json"],
          default_app: "app/package.json",
        }),
      );
      await writeFile(
        join(root, "app/package.json"),
        JSON.stringify({
          scripts: { dev: "test-owned child; not executed by reader" },
          lazurio: {
            runtime: {
              schema_version: "lazurio.runtime.v1",
              id: "fixture-web",
              title: "Fixture",
              company: "Example",
              module: "fixture",
              surface: "internal",
              dev_script: "dev",
              tags: [],
              listeners: [
                {
                  id: "web",
                  role: "entrypoint",
                  lease: "main",
                  protocol: "http",
                  health: { kind: "http", path: "/health" },
                },
              ],
            },
          },
        }),
      );
      const plan = await readModuleApplication(root);
      if (plan.kind !== "declared-runtime-plan" || !plan.listeners[0])
        throw new Error("Missing fixture plan");
      const { host, protocol, health } = plan.listeners[0];
      const target = { host, port: plan.listeners[0].port, protocol, health };
      expect(await probeListenerHealth(target)).toEqual({
        kind: "responding",
        status: 200,
      });
      child.kill("SIGTERM");
      await child.exited;
      expect(await probeListenerHealth(target)).toEqual({
        kind: "unavailable",
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("health probe observes success and failure without following redirects or reading bodies", async () => {
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/target" });
      response.end();
    } else if (request.url === "/target") {
      redirected++;
      response.end();
    } else if (request.url === "/failure") {
      response.writeHead(503);
      response.end();
    } else {
      response.writeHead(200);
      response.flushHeaders(); /* intentionally never finish body */
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  try {
    expect(await probeListenerHealth(listener(address.port))).toEqual({
      kind: "responding",
      status: 200,
    });
    expect(
      await probeListenerHealth(listener(address.port, "/failure")),
    ).toEqual({ kind: "http-error", status: 503 });
    expect(
      await probeListenerHealth(listener(address.port, "/redirect")),
    ).toEqual({ kind: "http-error", status: 302 });
    expect(redirected).toBe(0);
    expect(
      await probeListenerHealth({
        ...listener(address.port),
        health: { kind: "tcp" },
      }),
    ).toEqual({ kind: "responding" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("health path parsing is stable and normalization cannot change the request origin", async () => {
  const paths: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  try {
    const input = listener(address.port, "/a/..//health?test=1#fragment");
    const parsed = parseHealthListener(input);
    expect(parseHealthListener(parsed)).toEqual(parsed);
    expect(await probeListenerHealth(parsed)).toEqual({
      kind: "responding",
      status: 200,
    });
    expect(await probeListenerHealth(input)).toEqual({
      kind: "responding",
      status: 200,
    });
    expect(paths).toEqual(["//health?test=1", "//health?test=1"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("health probe bounds a stalled server and reports a closed port", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  try {
    expect(await probeListenerHealth(listener(address.port), 30)).toEqual({
      kind: "timeout",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(await probeListenerHealth(listener(address.port), 100)).toEqual({
    kind: "unavailable",
  });
});

test("health probe refuses non-loopback and origin-changing declarations before networking", async () => {
  for (const patch of [
    { host: "example.com" },
    { port: 80 },
    { port: 65536 },
    { protocol: "file" },
    { health: { kind: "http", path: "//example.com" } },
    { health: { kind: "http", path: "/\\example.com" } },
    { health: { kind: "http", path: "/\t/example.com" } },
    { health: { kind: "tcp", path: "/" } },
  ])
    await expect(
      probeListenerHealth({ ...listener(4100), ...patch }),
    ).rejects.toThrow();
  for (const timeout of [0, -1, 30_001, Number.NaN])
    await expect(
      probeListenerHealth(listener(4100), timeout),
    ).rejects.toThrow();
});
