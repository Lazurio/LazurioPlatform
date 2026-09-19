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
// from a new Launchpad, stop it there and prove that its control group is gone.
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
  return { child, operation, healthy };
}
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
    "if (!(await Bun.file('module-data').exists())) await Bun.write('module-data', 'prepared');\n",
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

  // D. Third Launchpad: status is rediscovered again. Mutations after a CRASH
  // meet the crashed owner's retained dependency lock, which is never reclaimed
  // automatically (documented, pre-existing). The application is unaffected.
  const third = await launchpad();
  assert.equal((await third.healthy()).service.invocationId, invocation);
  let stopped = await timed("stopMs", () => third.operation("stop"));
  let crashRecovery = "not-needed";
  if (stopped.kind !== "group-stopped") {
    assert.equal(stopped.error, "operation-failed", JSON.stringify(stopped));
    assert.equal(await answers(port), "service-owned module");
    const lock = join(owner, ".operation-lock");
    assert.ok((await lstat(lock)).isDirectory());
    // Operator recovery in this synthetic fixture only: the crashed owner is
    // known to be gone (this script killed it) and the lock directory is empty.
    await rmdir(lock);
    crashRecovery =
      "stale dependency-owner lock of the killed Launchpad removed by the operator";
    stopped = await timed("stopMs", () => third.operation("stop"));
  }
  assert.equal(stopped.kind, "group-stopped", JSON.stringify(stopped));

  // E. The manager and the kernel agree that nothing is left.
  assert.equal(await show("LoadState"), "not-found");
  assert.equal(await isControlGroupEmpty(controlGroup), true);
  assert.equal((await third.operation("status")).kind, "not-managed");
  await assert.rejects(answers(port));
  // A new start is a new invocation, never the old identity.
  assert.equal((await third.operation("start")).kind, "started");
  const again = await third.healthy();
  assert.notEqual(again.service.invocationId, invocation);
  assert.equal((await third.operation("stop")).kind, "group-stopped");
  third.child.kill("SIGTERM");
  assert.equal(await third.child.exited, 0);
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
      applicationEnvironment: environment,
      preparationWhileRunning: refused.kind,
      crashRecovery,
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
