import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import {
  createServiceManagerProcess,
  isControlGroupEmpty,
  userManagerState,
} from "../src/modules/service-manager-process";
import { applicationUnitName } from "../src/modules/systemd-user-runner";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";

// Linux qualification of OS-owned applications against the REAL systemd user
// manager, through the real compiled CLI: start a declared Bun module through
// `app-request`, end the Launchpad (gracefully, then by SIGKILL), prove that the
// application keeps answering under the SAME service invocation, rediscover it
// from a new Launchpad, stop and start it there WITHOUT any recovery step, prove
// that its control group is gone, operate it with no Launchpad at all, and prove
// that an interrupted dependency preparation still requires explicit recovery.
// Compile this runner for a source-free guest and supply that guest's module Bun.
// It creates only transient units and a temporary home; it installs nothing.
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  allowPositionals: true,
  options: { "module-bun": { type: "string" } },
});
const cli = positionals[0];
const moduleBun = values["module-bun"];
assert.ok(cli && positionals.length === 1 && isAbsolute(cli));
assert.ok(moduleBun && isAbsolute(moduleBun));
const runtimeDirectory = process.env.XDG_RUNTIME_DIR ?? "";
const manager =
  process.platform === "linux" && runtimeDirectory.startsWith("/")
    ? await userManagerState(createServiceManagerProcess(runtimeDirectory))
    : null;
if (!["running", "degraded", "starting"].includes(manager ?? "")) {
  console.log(
    JSON.stringify({
      pass: false,
      unavailable:
        "no reachable systemd user manager on this Machine; nothing was started",
      platform: process.platform,
      manager,
    }),
  );
  process.exit(2);
}
const systemd = createServiceManagerProcess(runtimeDirectory);
const home = await realpath(
  await mkdtemp(join(tmpdir(), "lazurio-application-service-")),
);
const env = {
  HOME: home,
  PATH: "/usr/bin:/bin",
  XDG_RUNTIME_DIR: runtimeDirectory,
  BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"),
};
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const folder = join(home, "Folder");
const organizationDirectory = join(home, "Organization");
const moduleDirectory = join(organizationDirectory, "workspace/fixture");
const owner = join(moduleDirectory, "app");
const selection = {
  company: "Example",
  module: "fixture",
  package: "app/package.json",
};
const unit = applicationUnitName(organizationDirectory, selection);
const launchpads: ReturnType<typeof Bun.spawn>[] = [];
const timings: Record<string, number> = {};
const timed = async <T>(name: string, action: () => Promise<T>) => {
  const started = performance.now();
  try {
    return await action();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
};

async function run(argv: string[], stdin?: unknown, cwd = home) {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([JSON.stringify(stdin)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, error };
  } finally {
    clearTimeout(timeout);
  }
}
const show = async (property: string) =>
  (
    await systemd(
      "systemctl",
      ["--user", "show", "--value", `--property=${property}`, "--", unit],
      { timeoutMs: 5000 },
    )
  ).stdout.trim();

async function launchpad() {
  const child = Bun.spawn(
    [
      cli as string,
      "launchpad",
      "--folder",
      folder,
      "--organization-directory",
      organizationDirectory,
      "--bun-executable",
      moduleBun as string,
      // Explicit: this qualification must never silently fall back to `session`.
      "--application-runner",
      "systemd-user",
    ],
    { cwd: home, env, stdout: "pipe", stderr: "pipe" },
  );
  launchpads.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let startup = "";
  while (!startup.includes("\n")) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, "Launchpad exited before readiness");
    startup += new TextDecoder().decode(chunk.value);
    assert.ok(startup.length < 16_384);
  }
  reader.releaseLock();
  const ready = JSON.parse(startup.split("\n")[0] as string);
  assert.equal(ready.applicationRunner, "systemd-user");
  const operation = async (name: string) => {
    const result = await run([cli as string, "app-request"], {
      sessionUrl: ready.url,
      operation: name,
      selection,
    });
    return { code: result.code, ...JSON.parse(result.output || "{}") };
  };
  const healthy = async () => {
    let status = await operation("status");
    for (let attempt = 0; attempt < 300 && !status.observedHealthy; attempt++) {
      await Bun.sleep(100);
      status = await operation("status");
    }
    assert.equal(status.observedHealthy, true, JSON.stringify(status));
    return status;
  };
  return { child, operation, healthy, sessionUrl: ready.url as string };
}
const retainedRecord = async () => {
  try {
    return (await lstat(join(owner, ".operation-lock"))).isDirectory();
  } catch {
    return false;
  }
};
const answers = async (port: number) =>
  (
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(5000),
    })
  ).text();

try {
  const write = (path: string, value: unknown) =>
    writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const initialized = await run([
    cli,
    "folder-init",
    "--folder",
    folder,
    "--access",
    "local",
    "--purpose",
    "human",
    "--locale",
    "en",
    "--detail",
    "concise",
    "--coordination",
    "direct",
  ]);
  assert.equal(initialized.code, 0, initialized.error);
  await mkdir(owner, { recursive: true, mode: 0o700 });
  const inventory = {
    company: "Example",
    github_org: "Example",
    module_slots: [{ path: "workspace/fixture", slug: "fixture" }],
  };
  const declaration = {
    schema_version: "lazurio.organization.v1",
    kind: "organization",
    organization: {
      slug: "Example",
      display_name: "Example",
      metadata: {},
      forge_binding: {
        forge: "github",
        locator: "Example",
        binding_state: "unverified",
      },
    },
    manifests: { modules: "modules.manifest.json" },
    extensions: { legacy: {} },
    compatibility: {
      legacy_projection: {
        path: "company.gen3.json",
        algorithm: "sha256-canonical-json-v1",
        sha256: `sha256:${"0".repeat(64)}`,
      },
    },
  };
  await write(join(organizationDirectory, "lazurio.organization.json"), {
    ...declaration,
    compatibility: {
      legacy_projection: {
        ...declaration.compatibility.legacy_projection,
        sha256: expectedLegacyProjection(declaration, inventory).hash,
      },
    },
  });
  await write(join(organizationDirectory, "modules.manifest.json"), inventory);
  await write(
    join(organizationDirectory, "company.gen3.json"),
    expectedLegacyProjection(declaration, inventory).projection,
  );
  const reserve = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reservation"),
  });
  const port = reserve.port as number;
  await reserve.stop(true);
  await write(join(moduleDirectory, "lazurio.module.json"), {
    schema_version: "lazurio.module.v1",
    id: selection.module,
    company: selection.company,
    tcp_port_policy: { mode: "single" },
    port_leases: [{ id: "main", host: "127.0.0.1", port }],
    apps: [selection.package],
    default_app: selection.package,
  });
  const bunVersion = (await run([moduleBun, "--version"])).output.trim();
  assert.match(bunVersion, /^\d+\.\d+\.\d+$/);
  await write(join(moduleDirectory, selection.package), {
    name: "application-service-fixture",
    packageManager: `bun@${bunVersion}`,
    dependencies: { "fixture-dependency": "file:./dependency" },
    scripts: {
      "prepare:data": "bun run prepare-data.ts",
      "check:data": "bun run check-data.ts",
      dev: "bun run fixture-server.ts",
    },
    lazurio: {
      preparation: {
        schema_version: "lazurio.preparation.v1",
        owner_package: "app/package.json",
        prepare_script: "prepare:data",
        check_script: "check:data",
      },
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
    },
  });
  await writeFile(
    join(owner, "fixture-server.ts"),
    'Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST ?? "127.0.0.1", port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: (request) => new URL(request.url).pathname === "/environment" ? Response.json(Object.keys(process.env).sort()) : new Response("service-owned module") });\n',
    { mode: 0o600 },
  );
  await writeFile(
    join(owner, "check-data.ts"),
    "const pkg = await Bun.file('node_modules/fixture-dependency/package.json').json(); if (pkg.name !== 'fixture-dependency' || (await Bun.file('module-data').text()) !== 'prepared') process.exit(1);\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(owner, "prepare-data.ts"),
    "if (await Bun.file('slow').exists()) { await Bun.write('preparing', '1'); await Bun.sleep(120000); } if (!(await Bun.file('module-data').exists())) await Bun.write('module-data', 'prepared');\n",
    { mode: 0o600 },
  );
  await mkdir(join(owner, "dependency"), { mode: 0o700 });
  await write(join(owner, "dependency/package.json"), {
    name: "fixture-dependency",
    version: "1.0.0",
  });
  const seed = await run(
    [moduleBun, "--no-env-file", "install", "--lockfile-only"],
    undefined,
    owner,
  );
  assert.equal(seed.code, 0, seed.error);
  assert.equal(await show("LoadState"), "not-found");

  // A. Start through the CLI and the first Launchpad.
  const first = await launchpad();
  assert.equal((await first.operation("prepare")).kind, "prepared");
  assert.equal(
    (await timed("startMs", () => first.operation("start"))).kind,
    "started",
  );
  const started = await timed("startToHealthyMs", first.healthy);
  assert.equal(started.runner, "systemd-user");
  assert.equal(started.survivesLaunchpadRestart, true);
  const invocation = started.service.invocationId;
  assert.match(invocation, /^[0-9a-f]{32}$/);
  assert.equal(started.service.unit, unit);
  assert.equal(await show("InvocationID"), invocation);
  const controlGroup = await show("ControlGroup");
  assert.equal(await isControlGroupEmpty(controlGroup), false);
  assert.equal(
    (await first.operation("open")).url,
    `http://127.0.0.1:${port}/`,
  );
  assert.equal(await answers(port), "service-owned module");
  const environment = await (
    await fetch(`http://127.0.0.1:${port}/environment`)
  ).json();
  // Dependencies are never changed beneath the running application.
  const refused = await first.operation("prepare");
  assert.equal(refused.kind, "application-running");
  assert.equal(await show("InvocationID"), invocation);

  // B. Graceful Launchpad exit, as a product update would do it.
  await timed("gracefulLaunchpadExitMs", async () => {
    first.child.kill("SIGTERM");
    assert.equal(await first.child.exited, 0);
  });
  assert.equal(await answers(port), "service-owned module");
  assert.equal(await show("InvocationID"), invocation);

  // C. A new Launchpad rediscovers the same invocation from the manager.
  const second = await launchpad();
  const rediscovered = await timed("rediscoveryMs", second.healthy);
  assert.equal(rediscovered.service.invocationId, invocation);
  assert.equal((await second.operation("start")).kind, "already-managed");
  // Launchpad crash: no shutdown code runs at all.
  second.child.kill("SIGKILL");
  await second.child.exited;
  assert.equal(await answers(port), "service-owned module");
  assert.equal(await show("InvocationID"), invocation);

  // D. Third Launchpad after the CRASH: no recovery step of any kind. Application
  // operations are coordinated by a kernel lock that died with its holder.
  const third = await launchpad();
  assert.equal((await third.healthy()).service.invocationId, invocation);
  assert.equal(await retainedRecord(), false);
  const stopped = await timed("stopAfterCrashMs", () =>
    third.operation("stop"),
  );
  assert.equal(stopped.kind, "group-stopped", JSON.stringify(stopped));

  // E. The manager and the kernel agree that nothing is left.
  assert.equal(await show("LoadState"), "not-found");
  assert.equal(await isControlGroupEmpty(controlGroup), true);
  assert.equal((await third.operation("status")).kind, "not-managed");
  await assert.rejects(answers(port));
  // A new start is a new invocation, never the old identity.
  assert.equal(
    (await timed("startAfterCrashMs", () => third.operation("start"))).kind,
    "started",
  );
  const again = await third.healthy();
  assert.notEqual(again.service.invocationId, invocation);
  third.child.kill("SIGKILL");
  await third.child.exited;

  // F. No Launchpad at all: the CLI reads and stops the service through the same
  // core, runner and coordination lock.
  const direct = async (name: string) => {
    const result = await run([cli as string, "app-request"], {
      organizationDirectory,
      operation: name,
      selection,
    });
    return { code: result.code, ...JSON.parse(result.output || "{}") };
  };
  const directStatus = await direct("status");
  assert.equal(directStatus.code, 0, JSON.stringify(directStatus));
  assert.equal(directStatus.runner, "systemd-user");
  assert.equal(directStatus.observedHealthy, true);
  assert.equal(directStatus.service.invocationId, again.service.invocationId);
  assert.equal(
    (await timed("directStopMs", () => direct("stop"))).kind,
    "group-stopped",
  );
  assert.equal((await direct("status")).kind, "not-managed");
  assert.equal(await show("LoadState"), "not-found");

  // G. The other kind of exclusion is NOT weakened: a dependency preparation
  // whose owner dies mid-transaction keeps its retained record, and neither
  // preparing nor starting proceeds until an operator recovers it explicitly.
  await rm(join(owner, "module-data"));
  await writeFile(join(owner, "slow"), "1", { mode: 0o600 });
  const fourth = await launchpad();
  const interrupted = Bun.spawn([cli, "app-request"], {
    cwd: home,
    env,
    stdin: new Blob([
      JSON.stringify({
        sessionUrl: fourth.sessionUrl,
        operation: "prepare",
        selection,
      }),
    ]),
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await Bun.file(join(owner, "preparing")).exists()) break;
    await Bun.sleep(100);
  }
  assert.ok(await Bun.file(join(owner, "preparing")).exists());
  assert.equal(await retainedRecord(), true);
  fourth.child.kill("SIGKILL");
  await fourth.child.exited;
  await interrupted.exited;
  const fifth = await launchpad();
  assert.equal(await retainedRecord(), true);
  const blockedStart = await fifth.operation("start");
  assert.equal(blockedStart.kind, "preparation-recovery-required");
  assert.equal(
    (await fifth.operation("prepare")).kind,
    "preparation-recovery-required",
  );
  assert.equal((await fifth.operation("status")).kind, "not-managed");
  assert.equal((await fifth.operation("stop")).kind, "not-managed");
  assert.equal(await show("LoadState"), "not-found");
  // Explicit operator recovery in this synthetic fixture: the script killed the
  // owner itself and the guard ended the preparation subprocess with it.
  await rmdir(join(owner, ".operation-lock"));
  await rm(join(owner, "slow"));
  await rm(join(owner, "preparing"));
  // The interrupted tree is still not started: its declared check fails.
  const unprepared = await fifth.operation("start");
  assert.equal(unprepared.kind, "prerequisites-not-ready");
  assert.equal((await fifth.operation("prepare")).kind, "prepared");
  // A completed preparation releases its record; nothing is retained.
  assert.equal(await retainedRecord(), false);
  assert.equal((await fifth.operation("start")).kind, "started");
  await fifth.healthy();
  assert.equal((await fifth.operation("stop")).kind, "group-stopped");
  fifth.child.kill("SIGTERM");
  assert.equal(await fifth.child.exited, 0);
  assert.equal(await show("LoadState"), "not-found");
  console.log(
    JSON.stringify({
      pass: true,
      platform: process.platform,
      arch: process.arch,
      systemd: (
        await systemd("systemctl", ["--version"], { timeoutMs: 5000 })
      ).stdout.split("\n")[0],
      userManager: manager,
      cliSha256: await digest(cli),
      runner: "systemd-user",
      unit: unit.replace(/[0-9a-f]{16}/g, "<digest>"),
      sameInvocationAcross: [
        "graceful Launchpad exit (SIGTERM)",
        "new Launchpad",
        "Launchpad crash (SIGKILL)",
        "third Launchpad",
      ],
      newInvocationAcross: ["second Launchpad crash (SIGKILL)", "CLI alone"],
      applicationEnvironment: environment,
      preparationWhileRunning: refused.kind,
      afterLaunchpadCrash:
        "stop and start through a new Launchpad succeeded with no recovery step and no retained record",
      withoutLaunchpad: "status and stop through the CLI alone",
      interruptedPreparation: {
        start: blockedStart.kind,
        afterOperatorRecovery: unprepared.kind,
      },
      controlGroupGoneAfterStop: true,
      timings,
      note: "real systemd user manager and compiled CLI with a declared Bun module; transient units only. Not reboot persistence, lingering, product activation, hosted entry or a real Organization module.",
    }),
  );
} finally {
  for (const child of launchpads)
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  await systemd("systemctl", ["--user", "stop", "--", unit], {
    timeoutMs: 20_000,
  });
  await systemd("systemctl", ["--user", "reset-failed", "--", unit], {
    timeoutMs: 5000,
  });
  await rm(home, { recursive: true, force: true });
}
