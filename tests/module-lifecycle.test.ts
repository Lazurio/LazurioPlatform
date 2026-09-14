import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { requestApplication } from "../src/launchpad/application-client";
import { applicationMessage } from "../src/launchpad/application-view";
import { startLaunchpad } from "../src/launchpad/server";
import { probeListenerHealth } from "../src/modules/health";
import { createApplicationLifecycle } from "../src/modules/lifecycle";
import { createOwnerOperations } from "../src/modules/owner-operations";

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "module-lifecycle-")));
  binary = join(root, "platform");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      resolve("src/cli.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      binary,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [error, code] = await Promise.all([
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(code, error).toBe(0);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const selection = {
  company: "Example",
  module: "fixture",
  package: "app/package.json",
};

posixTest(
  "compiled application CLI reports lost delivery without leaking the session or claiming cancellation",
  async () => {
    const token = "e".repeat(64);
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("deliberately invalid JSON");
      },
    });
    try {
      const sessionUrl = `${endpoint.url.href}#${token}`;
      const child = Bun.spawn([binary, "app-request"], {
        stdin: new Blob([
          JSON.stringify({ sessionUrl, operation: "prepare", selection }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(error).toContain("operation may still be running");
      expect(error).toContain("not confirmation of cancellation");
      expect(error).not.toContain(token);
      expect(error).not.toContain(sessionUrl);
      expect(error).not.toContain("deliberately invalid JSON");
      expect(error).not.toContain("Folder operation failed");
    } finally {
      await endpoint.stop(true);
    }
  },
);

posixTest(
  "CLI preparation waits beyond normal HTTP deadlines for the shared owner",
  async () => {
    const f = await fixture("slow-preparation");
    const folder = join(root, "slow-preparation-folder");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    let runs = 0;
    const app = await startLaunchpad(folder, {
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: f.prepareLaunch,
      preflightPreparation: async () => ({
        run: async () => {
          runs++;
          await Bun.sleep(31_000);
          return { kind: "prepared" as const };
        },
        close: async () => ({ kind: "closed" as const }),
      }),
    });
    try {
      expect(
        await requestApplication({
          sessionUrl: app.url,
          operation: "prepare",
          selection,
        }),
      ).toEqual({
        httpOk: true,
        result: { kind: "prepared" },
      });
      expect(runs).toBe(1);
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
    }
  },
  40_000,
);

posixTest(
  "Launchpad API owns one real application across requests and drains it on close",
  async () => {
    const f = await fixture("http-owner");
    const folder = join(root, "http-folder");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const app = await startLaunchpad(folder, {
      platformExecutable: binary,
      authorize: async (value) => {
        if (JSON.stringify(value) !== JSON.stringify(selection))
          throw new Error("denied");
        return { moduleDirectory: f.directory };
      },
      prepareLaunch: f.prepareLaunch,
    });
    const url = new URL(app.url);
    const headers = {
      "Content-Type": "application/json",
      Origin: url.origin,
      Authorization: `Bearer ${url.hash.slice(1)}`,
    };
    const call = (action: string, body: unknown = selection, override = {}) =>
      fetch(`${url.origin}/api/apps/${action}`, {
        method: "POST",
        headers: { ...headers, ...override },
        body: JSON.stringify(body),
      });
    try {
      expect(
        (await call("start", selection, { Origin: "https://example.invalid" }))
          .status,
      ).toBe(403);
      expect(
        (await call("start", selection, { Authorization: "" })).status,
      ).toBe(403);
      expect(
        await (await call("start", { ...selection, company: "Other" })).json(),
      ).toEqual({ kind: "denied" });
      expect(
        (await call("start", { ...selection, executable: process.execPath }))
          .status,
      ).toBe(400);
      expect(await (await call("status")).json()).toEqual({
        kind: "not-managed",
      });
      const cli = Bun.spawn([binary, "app-request"], {
        env: {},
        cwd: root,
        stdin: new Blob([
          JSON.stringify({
            sessionUrl: app.url,
            operation: "start",
            selection,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toContain(url.hash.slice(1));
      expect(JSON.parse(stdout)).toEqual({ kind: "started" });
      expect(await (await call("start")).json()).toEqual({
        kind: "already-managed",
      });
      let ready = false;
      const deadline = performance.now() + 3000;
      while (!ready && performance.now() < deadline) {
        const value = (await (await call("status")).json()) as {
          observedHealthy?: boolean;
        };
        ready = value.observedHealthy === true;
        if (!ready) await Bun.sleep(25);
      }
      expect(ready).toBe(true);
      expect(await (await call("open")).json()).toEqual({
        kind: "local-entrypoint",
        url: `http://127.0.0.1:${f.port}/`,
      });
      expect(await (await call("stop")).json()).toEqual({
        kind: "group-stopped",
      });
      expect(await (await call("status")).json()).toEqual({
        kind: "not-managed",
      });
      expect(await (await call("start")).json()).toEqual({ kind: "started" });
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
      expect((await f.health()).kind).toBe("unavailable");
    }
  },
);

async function fixture(name: string, host = "127.0.0.1") {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unrelated"),
  });
  const port = reservation.port as number;
  reservation.stop(true);
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "app"), { mode: 0o700 });
  const pkg = {
    scripts: {
      dev: `"${process.execPath}" --no-env-file "${resolve("tests/fixtures/lifecycle-app.ts")}"`,
    },
    lazurio: {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "fixture-app",
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
            health: { kind: "http", path: "/" },
          },
        ],
      },
    },
  };
  const savePackage = () =>
    writeFile(join(directory, "app/package.json"), JSON.stringify(pkg), {
      mode: 0o600,
    });
  await writeFile(
    join(directory, "lazurio.module.json"),
    JSON.stringify({
      schema_version: "lazurio.module.v1",
      id: "fixture",
      company: "Example",
      tcp_port_policy: { mode: "single" },
      port_leases: [{ id: "main", host, port }],
      apps: ["app/package.json"],
      default_app: "app/package.json",
    }),
    { mode: 0o600 },
  );
  await savePackage();
  const prepareLaunch = async (
    plan: { runtime: { dev_script: string } },
    cwd: string,
  ) => ({
    executable: process.execPath,
    args: ["--no-env-file", "run", plan.runtime.dev_script],
    cwd,
    env: { PATH: "/usr/bin:/bin", FIXTURE_PORT: String(port) },
  });
  const health = () =>
    probeListenerHealth({
      host: "127.0.0.1",
      port,
      protocol: "http",
      health: { kind: "http", path: "/" },
    });
  return { directory, port, pkg, savePackage, prepareLaunch, health };
}

posixTest(
  "clean preparation has an explicit API/CLI capability and authorization operation",
  async () => {
    const f = await fixture("clean-api");
    const folder = join(root, "clean-api-folder");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    let cleanRuns = 0;
    let ordinaryRuns = 0;
    let permitted = false;
    const app = await startLaunchpad(folder, {
      platformExecutable: binary,
      authorize: async (_selection, operation) => {
        if (operation === "clean-prepare" && !permitted)
          throw new Error("denied");
        return { moduleDirectory: f.directory };
      },
      prepareLaunch: f.prepareLaunch,
      preflightPreparation: async () => ({
        run: async () => {
          ordinaryRuns++;
          return { kind: "prepared" };
        },
        close: async () => ({ kind: "closed" }),
      }),
      preflightCleanPreparation: async () => ({
        run: async () => {
          cleanRuns++;
          return { kind: "prepared" };
        },
        close: async () => ({ kind: "closed" }),
      }),
    });
    try {
      expect(
        (
          await requestApplication({
            sessionUrl: app.url,
            operation: "clean-prepare",
            selection,
          })
        ).result,
      ).toEqual({ kind: "denied" });
      expect(cleanRuns).toBe(0);
      permitted = true;
      const cli = Bun.spawn([binary, "app-request"], {
        env: {},
        cwd: root,
        stdin: new Blob([
          JSON.stringify({
            sessionUrl: app.url,
            operation: "clean-prepare",
            selection,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, output] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({ kind: "prepared" });
      expect(cleanRuns).toBe(1);
      expect(ordinaryRuns).toBe(0);
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
    }
    const unsupported = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: f.prepareLaunch,
    });
    try {
      expect(await unsupported.prepare(selection, "clean-prepare")).toEqual({
        kind: "preparation-unavailable",
      });
    } finally {
      expect(await unsupported.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "localhost lease produces a browser-presentable healthy entrypoint",
  async () => {
    const f = await fixture("localhost-link", "localhost");
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: f.prepareLaunch,
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "started" });
      const deadline = performance.now() + 3000;
      let link = await owner.entrypoint(selection);
      while (link.kind === "not-ready" && performance.now() < deadline) {
        await Bun.sleep(25);
        link = await owner.entrypoint(selection);
      }
      expect(link).toEqual({
        kind: "local-entrypoint",
        url: `http://localhost:${f.port}/`,
      });
      expect(applicationMessage(link, true)).toBe("appLinkReady");
      expect(applicationMessage(link, false)).toBe("appRemoteLink");
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "exited applications retain cleanup ownership without reporting a successful restart",
  async () => {
    const f = await fixture("exited-restart");
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: async (_plan, cwd) => ({
        executable: process.execPath,
        args: ["--no-env-file", "-e", "process.exit(0)"],
        cwd,
        env: { PATH: "/usr/bin:/bin" },
      }),
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "started" });
      const deadline = performance.now() + 3000;
      let result = await owner.start(selection);
      while (
        result.kind === "already-managed" &&
        performance.now() < deadline
      ) {
        await Bun.sleep(25);
        result = await owner.start(selection);
      }
      expect(result).toEqual({ kind: "application-cleanup-required" });
      expect(applicationMessage(result, true)).toBe(
        "appPreparationCleanupRequired",
      );
      expect(await owner.stop(selection)).toEqual({ kind: "group-stopped" });
      expect(await owner.status(selection)).toEqual({ kind: "not-managed" });
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "API and compiled CLI reject restart of an exited retained app",
  async () => {
    const f = await fixture("exited-api");
    const folder = join(root, "exited-api-folder");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const app = await startLaunchpad(folder, {
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: async (_plan, cwd) => ({
        executable: process.execPath,
        args: ["--no-env-file", "-e", "process.exit(0)"],
        cwd,
        env: { PATH: "/usr/bin:/bin" },
      }),
    });
    const call = (operation: string) =>
      requestApplication({ sessionUrl: app.url, operation, selection });
    try {
      expect((await call("start")).result).toEqual({ kind: "started" });
      let response = await call("start");
      const deadline = performance.now() + 3000;
      while (
        response.result.kind === "already-managed" &&
        performance.now() < deadline
      ) {
        await Bun.sleep(25);
        response = await call("start");
      }
      expect(response.result).toEqual({ kind: "application-cleanup-required" });
      expect(applicationMessage(response.result, true)).toBe(
        "appPreparationCleanupRequired",
      );
      const cli = Bun.spawn([binary, "app-request"], {
        env: {},
        cwd: root,
        stdin: new Blob([
          JSON.stringify({
            sessionUrl: app.url,
            operation: "start",
            selection,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        cli.exited,
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
      ]);
      // Domain refusal is exit 2; transport failure is exit 1.
      expect(code).toBe(2);
      expect(JSON.parse(stdout)).toEqual(response.result);
      expect(stderr).not.toContain(app.url);
      expect((await call("stop")).result).toEqual({ kind: "group-stopped" });
      expect((await call("status")).result).toEqual({ kind: "not-managed" });
    } finally {
      expect(await app.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "module preparation checks first, stops only its app and does not imply running readiness",
  async () => {
    const f = await fixture("preparation");
    let failPreflight = true;
    let effects = 0;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: f.prepareLaunch,
      preflightPreparation: async () => {
        if (failPreflight) throw new Error("missing preparation input");
        return {
          run: async () => {
            expect((await f.health()).kind).toBe("unavailable");
            effects++;
            return { kind: "prepared" };
          },
          close: async () => ({ kind: "closed" }),
        };
      },
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "started" });
      expect(await owner.prepare(selection)).toEqual({
        kind: "preparation-preflight-failed",
      });
      expect(effects).toBe(0);
      expect((await owner.status(selection)).kind).toBe("status");
      failPreflight = false;
      expect(await owner.prepare(selection)).toEqual({ kind: "prepared" });
      expect(effects).toBe(1);
      expect(await owner.status(selection)).toEqual({ kind: "not-managed" });
      expect(await owner.start(selection)).toEqual({ kind: "started" });
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "incomplete preparation cleanup remains owned and blocks start until shutdown recovers it",
  async () => {
    const f = await fixture("preparation-cleanup");
    let canClose = false;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: f.prepareLaunch,
      preflightPreparation: async () => ({
        run: async () => ({ kind: "preparation-failed" }),
        close: async () => ({ kind: canClose ? "closed" : "incomplete" }),
      }),
    });
    try {
      expect(await owner.prepare(selection)).toEqual({
        kind: "preparation-cleanup-required",
      });
      expect(await owner.start(selection)).toEqual({
        kind: "preparation-cleanup-required",
      });
      expect(await owner.close()).toEqual({ kind: "incomplete" });
      canClose = true;
      expect(await owner.close()).toEqual({ kind: "closed" });
    } finally {
      canClose = true;
      await owner.close();
    }
  },
);

posixTest(
  "server shutdown drains a pending authorized start without preparing or launching it",
  async () => {
    const f = await fixture("http-shutdown-pending");
    const folder = join(root, "http-shutdown-folder");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let prepared = 0;
    const app = await startLaunchpad(folder, {
      platformExecutable: binary,
      authorize: async () => {
        entered();
        await gate;
        return { moduleDirectory: f.directory };
      },
      prepareLaunch: async (...args) => {
        prepared++;
        return f.prepareLaunch(...args);
      },
    });
    const url = new URL(app.url);
    const request = fetch(`${url.origin}/api/apps/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        Authorization: `Bearer ${url.hash.slice(1)}`,
      },
      body: JSON.stringify(selection),
    }).then(
      async (response) => response.json(),
      () => null,
    );
    try {
      await admission;
      const close = app.close();
      expect(app.close()).toBe(close);
      release();
      expect(await close).toEqual({ kind: "closed" });
      await request;
      expect(prepared).toBe(0);
      expect((await f.health()).kind).toBe("unavailable");
    } finally {
      release();
      await request;
      await app.close();
    }
  },
);

posixTest(
  "shared dependency-owner operation delays real launch until mutation finishes",
  async () => {
    const f = await fixture("dependency-coordination");
    const operations = createOwnerOperations();
    let release = () => {};
    let entered = () => {};
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let prepared = false;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: async (plan, cwd) => {
        prepared = true;
        return f.prepareLaunch(plan, cwd);
      },
      coordinateMutation: async (value, action) => {
        if (value === null) {
          await operations.close();
          return action();
        }
        // Explicit synthetic dependency owner; no app-path fallback resolver.
        expect(value).toEqual(selection);
        return operations.run(f.directory, action);
      },
    });
    try {
      const install = operations.run(f.directory, async () => {
        entered();
        await barrier;
      });
      await enteredPromise;
      const start = owner.start(selection);
      expect(prepared).toBe(false);
      release();
      await install;
      expect(await start).toEqual({ kind: "started" });
      expect(prepared).toBe(true);
      expect(await owner.stop(selection)).toEqual({ kind: "group-stopped" });
    } finally {
      release();
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "one lifecycle starts a declared module, observes status and stops only its retained process",
  async () => {
    const f = await fixture("normal");
    let allowed = true;
    const calls: string[] = [];
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      prepareLaunch: f.prepareLaunch,
      authorize: async (value, operation) => {
        expect(value).toEqual(selection);
        calls.push(operation);
        if (!allowed) throw new Error("synthetic denial");
        return { moduleDirectory: f.directory };
      },
    });
    try {
      expect(await owner.entrypoint(selection)).toEqual({
        kind: "not-managed",
      });
      const results = await Promise.all([
        owner.start(selection),
        owner.start(selection),
      ]);
      expect(results).toEqual([
        { kind: "started" },
        { kind: "already-managed" },
      ]);
      const deadline = performance.now() + 3000;
      let status = await owner.status(selection);
      while (
        status.kind === "status" &&
        !status.observedHealthy &&
        performance.now() < deadline
      ) {
        await Bun.sleep(30);
        status = await owner.status(selection);
      }
      expect(status).toMatchObject({ kind: "status", observedHealthy: true });
      expect(await owner.entrypoint(selection)).toEqual({
        kind: "local-entrypoint",
        url: `http://127.0.0.1:${f.port}/`,
      });
      allowed = false;
      expect(await owner.entrypoint(selection)).toEqual({ kind: "denied" });
      expect(await owner.status(selection)).toEqual({ kind: "denied" });
      expect(await owner.stop(selection)).toEqual({ kind: "denied" });
      expect((await f.health()).kind).toBe("responding");
      allowed = true;
      expect(await owner.stop(selection)).toEqual({ kind: "group-stopped" });
      expect(await owner.entrypoint(selection)).toEqual({
        kind: "not-managed",
      });
      expect((await f.health()).kind).toBe("unavailable");
      expect(await owner.stop(selection)).toEqual({ kind: "not-managed" });
      expect(calls.filter((item) => item === "start")).toHaveLength(3);
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "denied and foreign identities never invoke a launch adapter",
  async () => {
    const f = await fixture("denied");
    let prepared = 0;
    let denied = true;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => {
        if (denied) throw new Error("denied");
        return { moduleDirectory: f.directory };
      },
      prepareLaunch: async (...args) => {
        prepared++;
        return f.prepareLaunch(...args);
      },
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "denied" });
      denied = false;
      expect(await owner.start({ ...selection, company: "Wrong" })).toEqual({
        kind: "invalid-or-unavailable",
      });
      expect(prepared).toBe(0);
      expect((await f.health()).kind).toBe("unavailable");
    } finally {
      await owner.close();
    }
  },
);

posixTest(
  "entrypoint never uses production metadata and refuses changed declarations",
  async () => {
    const f = await fixture("entrypoint-drift");
    Object.assign(f.pkg.lazurio.runtime, {
      production_url: "https://example.invalid/production",
    });
    await f.savePackage();
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: f.prepareLaunch,
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "started" });
      let result = await owner.entrypoint(selection);
      const deadline = performance.now() + 3000;
      while (result.kind === "not-ready" && performance.now() < deadline) {
        await Bun.sleep(25);
        result = await owner.entrypoint(selection);
      }
      expect(result).toEqual({
        kind: "local-entrypoint",
        url: `http://127.0.0.1:${f.port}/`,
      });
      f.pkg.scripts.dev += " --changed";
      await f.savePackage();
      expect(await owner.entrypoint(selection)).toEqual({
        kind: "declaration-changed",
      });
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "occupied port remains untouched and changed script invalidates the prepared launch",
  async () => {
    const f = await fixture("collision");
    const foreign = Bun.serve({
      hostname: "127.0.0.1",
      port: f.port,
      fetch: () => new Response("unrelated"),
    });
    let mutate = false;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: async (...args) => {
        if (mutate) {
          f.pkg.scripts.dev += " changed";
          await f.savePackage();
        }
        return f.prepareLaunch(...args);
      },
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "port-occupied" });
      expect(await (await fetch(`http://127.0.0.1:${f.port}`)).text()).toBe(
        "unrelated",
      );
      foreign.stop(true);
      mutate = true;
      expect(await owner.start(selection)).toEqual({
        kind: "declaration-changed",
      });
      expect((await f.health()).kind).toBe("unavailable");
    } finally {
      foreign.stop(true);
      await owner.close();
    }
  },
);

posixTest(
  "revocation at final authorization and owner shutdown prevent pending launch",
  async () => {
    const f = await fixture("late-denial");
    let calls = 0;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => {
        if (++calls === 2) throw new Error("revoked");
        return { moduleDirectory: f.directory };
      },
      prepareLaunch: f.prepareLaunch,
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "denied" });
      expect((await f.health()).kind).toBe("unavailable");
      expect(await owner.close()).toEqual({ kind: "closed" });
      expect(await owner.start(selection)).toEqual({ kind: "closing" });
    } finally {
      await owner.close();
    }
  },
);

posixTest(
  "failed executable is cleaned up and does not retain a false running entry",
  async () => {
    const f = await fixture("failed");
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: async (_plan, cwd) => ({
        executable: join(root, "absent"),
        args: [],
        cwd,
        env: {},
      }),
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "launch-failed" });
      expect(await owner.status(selection)).toEqual({ kind: "not-managed" });
      expect((await f.health()).kind).toBe("unavailable");
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "scope changes cannot control an old run; shutdown still drains its owned group",
  async () => {
    const f = await fixture("scope-change");
    let directory = f.directory;
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: directory }),
      prepareLaunch: f.prepareLaunch,
    });
    try {
      expect(await owner.start(selection)).toEqual({ kind: "started" });
      directory = join(root, "different-scope");
      expect(await owner.start(selection)).toEqual({ kind: "scope-changed" });
      expect(await owner.status(selection)).toEqual({ kind: "scope-changed" });
      expect(await owner.stop(selection)).toEqual({ kind: "scope-changed" });
      expect(await owner.close()).toEqual({ kind: "closed" });
      expect((await f.health()).kind).toBe("unavailable");
    } finally {
      await owner.close();
    }
  },
);

posixTest(
  "package lifecycle hook changes invalidate prepared execution",
  async () => {
    const f = await fixture("hook-change");
    const owner = createApplicationLifecycle({
      platformExecutable: binary,
      authorize: async () => ({ moduleDirectory: f.directory }),
      prepareLaunch: async (...args) => {
        Object.assign(f.pkg.scripts, { predev: "exit 77" });
        await f.savePackage();
        return f.prepareLaunch(...args);
      },
    });
    try {
      expect(await owner.start(selection)).toEqual({
        kind: "declaration-changed",
      });
      expect(await owner.status(selection)).toEqual({ kind: "not-managed" });
      expect((await f.health()).kind).toBe("unavailable");
    } finally {
      await owner.close();
    }
  },
);
