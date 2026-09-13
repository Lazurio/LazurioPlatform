import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeListenerHealth } from "../src/modules/health";
import { createApplicationLifecycle } from "../src/modules/lifecycle";

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

async function fixture(name: string) {
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
      port_leases: [{ id: "main", host: "127.0.0.1", port }],
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
      allowed = false;
      expect(await owner.status(selection)).toEqual({ kind: "denied" });
      expect(await owner.stop(selection)).toEqual({ kind: "denied" });
      expect((await f.health()).kind).toBe("responding");
      allowed = true;
      expect(await owner.stop(selection)).toEqual({ kind: "group-stopped" });
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
