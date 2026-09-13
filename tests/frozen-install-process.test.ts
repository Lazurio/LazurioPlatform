import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { preflightBunPreparation } from "../src/modules/bun-preparation";
import {
  runFrozenInstallProcess,
  runModulePreparationProcess,
} from "../src/modules/frozen-install-process";
import { inspectInstallAuthority } from "../src/modules/install-authority";
import { createApplicationLifecycle } from "../src/modules/lifecycle";

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let platform = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "frozen-process-")));
  platform = join(root, "platform");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      resolve("src/cli.ts"),
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      platform,
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

async function fixture(
  name: string,
  script = "await Bun.write('marker', 'ran');",
) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: directory,
    BUN_INSTALL_CACHE_DIR: join(directory, "cache"),
  };
  const pkg = {
    name: "synthetic-install-fixture",
    version: "1.0.0",
    packageManager: `bun@${Bun.version}`,
    dependencies: { "fixture-dependency": "file:./dependency" },
  };
  await mkdir(join(directory, "dependency"), { mode: 0o700 });
  await writeFile(
    join(directory, "dependency/package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      version: "1.0.0",
    }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, "package.json"), JSON.stringify(pkg), {
    mode: 0o600,
  });
  // Fixture setup only: produce a genuine pinned lock without network dependencies.
  const seed = Bun.spawn(
    [process.execPath, "--no-env-file", "install", "--lockfile-only"],
    {
      cwd: directory,
      env,
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  expect(await seed.exited, await new Response(seed.stderr).text()).toBe(0);
  await writeFile(join(directory, "hook.ts"), script, { mode: 0o600 });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      ...pkg,
      scripts: { postinstall: `"${process.execPath}" --no-env-file hook.ts` },
    }),
    { mode: 0o600 },
  );
  const authority = await inspectInstallAuthority(directory, directory);
  return {
    directory,
    request: {
      authority,
      executable: process.execPath,
      platformExecutable: platform,
      env,
      timeoutMs: 10_000,
    },
  };
}

posixTest(
  "real frozen Bun install runs hook and drains group without claiming readiness",
  async () => {
    const f = await fixture("success");
    const lock = await readFile(join(f.directory, "bun.lock"));
    const result = await runFrozenInstallProcess(f.request);
    expect(result.kind).toBe("process-exited");
    if (result.kind !== "process-exited")
      throw new Error("Expected exit evidence");
    expect(result.code).toBe(0);
    expect(result.cleanup).toBe("group-stopped");
    expect(await readFile(join(f.directory, "marker"), "utf8")).toBe("ran");
    expect(await readFile(join(f.directory, "bun.lock"))).toEqual(lock);
    expect(result.handle.inspect().stopped).toBe(true);
  },
);

posixTest(
  "lifecycle preparation runs real Bun and requires module-owned dependency postconditions",
  async () => {
    const f = await fixture("composed-preparation");
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const selection = {
      company: "Example",
      module: "fixture",
      package: "package.json",
    };
    const pkg = await Bun.file(join(f.directory, "package.json")).json();
    pkg.scripts.dev = `"${process.execPath}" --no-env-file "${resolve("tests/fixtures/lifecycle-app.ts")}"`;
    pkg.lazurio = {
      runtime: {
        schema_version: "lazurio.runtime.v1",
        id: "fixture-app",
        title: "Fixture",
        company: selection.company,
        module: selection.module,
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
    };
    await writeFile(join(f.directory, "package.json"), JSON.stringify(pkg), {
      mode: 0o600,
    });
    await writeFile(
      join(f.directory, "lazurio.module.json"),
      JSON.stringify({
        schema_version: "lazurio.module.v1",
        id: selection.module,
        company: selection.company,
        tcp_port_policy: { mode: "single" },
        port_leases: [{ id: "main", host: "127.0.0.1", port }],
        apps: [selection.package],
        default_app: selection.package,
      }),
      { mode: 0o600 },
    );
    let requireMissingData = false;
    const verify = async () => {
      const dependency = await Bun.file(
        join(f.directory, "node_modules/fixture-dependency/package.json"),
      ).json();
      return (
        dependency.name === "fixture-dependency" &&
        dependency.version === "1.0.0" &&
        (await Bun.file(join(f.directory, "marker")).text()) === "ran" &&
        (!requireMissingData ||
          (await Bun.file(
            join(f.directory, "db/required-fixture-data"),
          ).exists()))
      );
    };
    const owner = createApplicationLifecycle({
      platformExecutable: platform,
      authorize: async (value) => {
        expect(value).toEqual(selection);
        return { moduleDirectory: f.directory };
      },
      prepareLaunch: async (plan, cwd) => {
        if (!(await verify()))
          throw new Error("Module dependencies not prepared");
        return {
          executable: process.execPath,
          args: ["--no-env-file", "run", plan.runtime.dev_script],
          cwd,
          env: { ...f.request.env, FIXTURE_PORT: String(port) },
        };
      },
      preflightPreparation: async (_plan, cwd) =>
        preflightBunPreparation({
          checkout: f.directory,
          owner: cwd,
          executable: process.execPath,
          platformExecutable: platform,
          env: f.request.env,
          timeoutMs: 10_000,
          verifyPrepared: verify,
        }),
    });
    try {
      expect(await owner.prepare(selection)).toEqual({ kind: "prepared" });
      expect(await owner.status(selection)).toEqual({ kind: "not-managed" });
      expect(await owner.start(selection)).toEqual({ kind: "started" });
      expect(await owner.stop(selection)).toEqual({ kind: "group-stopped" });
      requireMissingData = true;
      expect(await owner.prepare(selection)).toEqual({
        kind: "preparation-failed",
      });
      expect(await owner.start(selection)).toEqual({
        kind: "invalid-or-unavailable",
      });
      expect(await owner.status(selection)).toEqual({ kind: "not-managed" });
    } finally {
      expect(await owner.close()).toEqual({ kind: "closed" });
    }
  },
  15_000,
);

posixTest(
  "declared module preparation runs after install and still requires postconditions",
  async () => {
    const f = await fixture("module-preparation");
    const pkg = await Bun.file(join(f.directory, "package.json")).json();
    pkg.scripts["prepare:data"] =
      `"${process.execPath}" --no-env-file prepare.ts`;
    await writeFile(join(f.directory, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(f.directory, "prepare.ts"),
      "if (!(await Bun.file('marker').exists())) process.exit(17); await Bun.write('module-data', 'prepared');",
    );
    let accept = true;
    const create = () =>
      preflightBunPreparation({
        checkout: f.directory,
        owner: f.directory,
        executable: process.execPath,
        platformExecutable: platform,
        env: f.request.env,
        timeoutMs: 10_000,
        modulePreparationScript: "prepare:data",
        verifyPrepared: async () =>
          accept &&
          (await Bun.file(join(f.directory, "module-data")).text()) ===
            "prepared",
      });
    const preparation = await create();
    try {
      expect(await preparation.run(new AbortController().signal)).toEqual({
        kind: "prepared",
      });
    } finally {
      expect(await preparation.close()).toEqual({ kind: "closed" });
    }
    accept = false;
    const rejected = await create();
    try {
      expect(await rejected.run(new AbortController().signal)).toEqual({
        kind: "preparation-failed",
      });
    } finally {
      expect(await rejected.close()).toEqual({ kind: "closed" });
    }
    expect(await Bun.file(join(f.directory, "module-data")).text()).toBe(
      "prepared",
    );
    const authority = await inspectInstallAuthority(f.directory, f.directory);
    expect(() =>
      runModulePreparationProcess({
        ...f.request,
        authority,
        script: "missing",
      }),
    ).toThrow();
    expect(() =>
      runModulePreparationProcess({
        ...f.request,
        authority,
        script: "--eval",
      }),
    ).toThrow();
  },
  15_000,
);

posixTest(
  "cancelling a declared preparation drains descendants and preserves partial module data",
  async () => {
    const f = await fixture("cancel-module-preparation");
    const pkg = await Bun.file(join(f.directory, "package.json")).json();
    pkg.scripts.prepare = `"${process.execPath}" --no-env-file prepare.ts`;
    await writeFile(join(f.directory, "package.json"), JSON.stringify(pkg));
    await writeFile(
      join(f.directory, "prepare.ts"),
      `
      await Bun.write('partial-module-data', 'preserve');
      Bun.spawn([process.execPath, '--no-env-file', 'descendant.ts'], { stdout: 'ignore', stderr: 'ignore' });
      await Bun.sleep(60_000);
    `,
    );
    await writeFile(
      join(f.directory, "descendant.ts"),
      `
      await Bun.write('descendant-ready', 'yes');
      setInterval(() => { void Bun.write('heartbeat', String(Date.now())); }, 20);
      await Bun.sleep(60_000);
    `,
    );
    const authority = await inspectInstallAuthority(f.directory, f.directory);
    const controller = new AbortController();
    const pending = runModulePreparationProcess({
      ...f.request,
      authority,
      script: "prepare",
      signal: controller.signal,
    });
    try {
      const deadline = performance.now() + 3000;
      while (
        !(await Bun.file(join(f.directory, "heartbeat")).exists()) &&
        performance.now() < deadline
      )
        await Bun.sleep(20);
      expect(
        await Bun.file(join(f.directory, "descendant-ready")).exists(),
      ).toBe(true);
    } finally {
      controller.abort();
      const result = await pending;
      expect(result.kind).toBe("cancelled");
      expect("cleanup" in result && result.cleanup).toBe("group-stopped");
    }
    const heartbeat = await readFile(join(f.directory, "heartbeat"));
    await Bun.sleep(100);
    expect(await readFile(join(f.directory, "heartbeat"))).toEqual(heartbeat);
    expect(
      await readFile(join(f.directory, "partial-module-data"), "utf8"),
    ).toBe("preserve");
  },
);

posixTest(
  "failed install script returns nonzero exit and drains its group",
  async () => {
    const f = await fixture("failure", "process.exit(23);");
    const result = await runFrozenInstallProcess(f.request);
    expect(result.kind).toBe("process-exited");
    if (result.kind !== "process-exited")
      throw new Error("Expected exit evidence");
    expect(result.code).not.toBe(0);
    expect(result.cleanup).toBe("group-stopped");
  },
);

posixTest(
  "timeout stops a running install and cancellation refuses an unstarted install",
  async () => {
    const f = await fixture("timeout", "await Bun.sleep(60_000);");
    const result = await runFrozenInstallProcess({
      ...f.request,
      timeoutMs: 800,
    });
    expect(result.kind).toBe("timed-out");
    expect("cleanup" in result && result.cleanup).toBe("group-stopped");
    const controller = new AbortController();
    controller.abort();
    expect(
      await runFrozenInstallProcess({
        ...f.request,
        signal: controller.signal,
      }),
    ).toEqual({ kind: "cancelled" });
  },
);

posixTest(
  "script changing package authority cannot produce accepted exit evidence",
  async () => {
    const f = await fixture(
      "drift",
      "await Bun.write('package.json', '{}'); await Bun.sleep(60_000);",
    );
    const result = await runFrozenInstallProcess(f.request);
    expect(result.kind).toBe("authority-changed");
    expect("cleanup" in result && result.cleanup).toBe("group-stopped");
  },
);

posixTest(
  "cancellation after the real install hook starts drains the owned group",
  async () => {
    const f = await fixture(
      "cancel-running",
      "await Bun.write('started', 'yes'); await Bun.sleep(60_000);",
    );
    const controller = new AbortController();
    const pending = runFrozenInstallProcess({
      ...f.request,
      signal: controller.signal,
    });
    try {
      const deadline = performance.now() + 3000;
      while (
        !(await Bun.file(join(f.directory, "started")).exists()) &&
        performance.now() < deadline
      )
        await Bun.sleep(20);
      expect(await Bun.file(join(f.directory, "started")).exists()).toBe(true);
    } finally {
      controller.abort();
      const result = await pending;
      expect(result.kind).toBe("cancelled");
      expect("cleanup" in result && result.cleanup).toBe("group-stopped");
    }
  },
);
