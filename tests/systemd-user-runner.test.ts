import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { canonicalOwnedDirectory } from "../src/folder/owned-directory";
import { executionOs } from "../src/folder/platform";
import { applicationMessage } from "../src/launchpad/application-view";
import { startLaunchpad } from "../src/launchpad/server";
import { selectApplicationRunnerKind } from "../src/modules/application-runner";
import { createApplicationLifecycle } from "../src/modules/lifecycle";
import {
  createServiceManagerProcess,
  userManagerState,
} from "../src/modules/service-manager-process";
import {
  applicationCoordinationLockFile,
  applicationUnitName,
  createSystemdUserRunner,
  organizationUnitPrefix,
} from "../src/modules/systemd-user-runner";
import { createFakeServiceManager } from "./fixtures/fake-service-manager";

// Every test here talks to an in-memory service manager. Nothing is executed,
// and the account's real home and systemd directories are never consulted.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
const saved: Record<string, string | undefined> = {};
let root = "";
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "systemd-user-runner-")));
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    saved[name] = process.env[name];
    process.env[name] = join(root, "account", name.toLowerCase());
  }
});
afterAll(async () => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  if (root) await rm(root, { recursive: true, force: true });
});

const selection = {
  company: "Example",
  module: "fixture",
  package: "app/package.json",
};
const digest = "a".repeat(64);

async function organization(name: string, port = 41_234) {
  const directory = join(root, name);
  const moduleDirectory = join(directory, "workspace/fixture");
  await mkdir(join(moduleDirectory, "app"), { recursive: true, mode: 0o700 });
  const pkg = {
    scripts: { dev: "fixture" },
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
    writeFile(join(moduleDirectory, "app/package.json"), JSON.stringify(pkg), {
      mode: 0o600,
    });
  await writeFile(
    join(moduleDirectory, "lazurio.module.json"),
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
  return {
    directory,
    moduleDirectory,
    cwd: join(moduleDirectory, "app"),
    port,
    pkg,
    savePackage,
  };
}

type Organization = Awaited<ReturnType<typeof organization>>;
type Binding = {
  pid: number;
  group: number;
  uid: number;
  fd: number;
  host: string;
  port: number;
};

// One "Launchpad": a lifecycle with its own runner instance over a manager that
// outlives it, exactly like a restarted process over the same user manager.
function launchpad(
  manager: ReturnType<typeof createFakeServiceManager>,
  org: Organization,
  options: {
    bindings?: () => Binding[];
    preflight?: () => void;
    launch?: Partial<{
      executable: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    }>;
  } = {},
) {
  const runner = createSystemdUserRunner({
    organizationDirectory: org.directory,
    runtimeDirectory: manager.runtimeDirectory,
    run: manager.run,
    controlGroupEmpty: manager.controlGroupEmpty,
    confirmStopMs: 200,
    sleep: () => Bun.sleep(1),
    observeBindings: async () => ({
      kind: "observed",
      bindings: options.bindings?.() ?? [],
    }),
    probeHealth: async () => ({ kind: "responding", status: 200 }),
    processControlGroup: async (pid) =>
      pid === 4242
        ? `${manager.slice}/${applicationUnitName(org.directory, selection)}`
        : "/user.slice/user-1000.slice/session-3.scope",
  });
  const preparation = async () => {
    options.preflight?.();
    return {
      run: async () => ({ kind: "prepared" as const }),
      close: async () => ({ kind: "closed" as const }),
    };
  };
  const lifecycle = createApplicationLifecycle({
    runner,
    authorize: async (value) => {
      if (JSON.stringify(value) !== JSON.stringify(selection))
        throw new Error("denied");
      return { moduleDirectory: org.moduleDirectory };
    },
    prepareLaunch: async (_plan, cwd) => ({
      executable: "/opt/bun/bin/bun",
      args: ["--no-env-file", "run", "dev"],
      cwd,
      env: {
        HOME: "/home/admin",
        PATH: "/usr/bin:/bin",
        LAZURIO_RUNTIME_LISTENER_WEB_HOST: "127.0.0.1",
        LAZURIO_RUNTIME_LISTENER_WEB_PORT: String(org.port),
      },
      ...options.launch,
    }),
    preflightPreparation: preparation,
    preflightCleanPreparation: preparation,
  });
  return { runner, lifecycle };
}

test("unit names are stable, sanitized, bounded and distinct per Organization directory", () => {
  const name = applicationUnitName("/home/a/Lazurio/organizations/Example", {
    company: "Example",
    module: "fixture",
    package: "app/package.json",
  });
  expect(name).toBe(
    applicationUnitName("/home/a/Lazurio/organizations/Example", {
      ...selection,
    }),
  );
  expect(name).toMatch(
    /^lazurio-app-[0-9a-f]{16}-example\.fixture\.app-[0-9a-f]{16}\.service$/,
  );
  expect(
    name.startsWith(
      organizationUnitPrefix("/home/a/Lazurio/organizations/Example"),
    ),
  ).toBe(true);
  // Two Folders holding the same Organization never share a unit or a listing.
  const other = applicationUnitName("/home/b/Lazurio/organizations/Example", {
    ...selection,
  });
  expect(other).not.toBe(name);
  expect(
    organizationUnitPrefix("/home/b/Lazurio/organizations/Example"),
  ).not.toBe(organizationUnitPrefix("/home/a/Lazurio/organizations/Example"));
  // Sanitization is lossy; identities that sanitize alike still differ.
  const hostile = (pkg: string) =>
    applicationUnitName("/o", {
      company: "Example",
      module: "fixture",
      package: pkg,
    });
  expect(hostile("a b/package.json")).not.toBe(hostile("a-b/package.json"));
  for (const value of [
    hostile("$(reboot);`x`/../%h/package.json"),
    hostile(`${"very-long-segment/".repeat(40)}package.json`),
    hostile("package.json"),
  ]) {
    expect(value).toMatch(/^[a-z0-9.-]+\.service$/);
    expect(value.length).toBeLessThanOrEqual(128);
  }
  expect(hostile("package.json")).toContain(".root-");
});

test("runner selection is explicit and narrow", async () => {
  const state = (value: string | null) => async () => value;
  const linux = { XDG_RUNTIME_DIR: "/run/user/1000" };
  const select = (
    platform: string,
    environment: Record<string, string | undefined>,
    manager: string | null,
    requested?: string,
  ) =>
    selectApplicationRunnerKind({
      platform,
      environment,
      userManagerState: state(manager),
      ...(requested === undefined ? {} : { requested }),
    });
  expect(await select("linux", linux, "running")).toBe("systemd-user");
  // Our own failed application makes the manager report `degraded`.
  expect(await select("linux", linux, "degraded")).toBe("systemd-user");
  expect(await select("linux", linux, null)).toBe("session");
  expect(await select("linux", linux, "offline")).toBe("session");
  expect(await select("linux", {}, "running")).toBe("session");
  expect(
    await select("linux", { XDG_RUNTIME_DIR: "relative" }, "running"),
  ).toBe("session");
  expect(await select("darwin", linux, "running")).toBe("session");
  expect(await select("linux", linux, "running", "session")).toBe("session");
  expect(await select("linux", linux, "running", "auto")).toBe("systemd-user");
  // An explicit request is honored or refused, never silently downgraded.
  await expect(
    select("darwin", linux, "running", "systemd-user"),
  ).rejects.toThrow();
  await expect(select("linux", linux, null, "systemd-user")).rejects.toThrow();
  await expect(select("linux", linux, "running", "launchd")).rejects.toThrow();
  const manager = createFakeServiceManager();
  expect(await userManagerState(manager.run)).toBe("degraded");
  manager.behaviour.unavailable = true;
  expect(await userManagerState(manager.run)).toBeNull();
  expect(() => createServiceManagerProcess("relative")).toThrow();
});

posixTest(
  "the service definition is exact argv with an allowlisted environment and no shell",
  async () => {
    const org = await organization("definition");
    const manager = createFakeServiceManager();
    const { lifecycle } = launchpad(manager, org, {
      launch: { args: ["--no-env-file", "run", "dev", "$HOME", "%h", "a b;c"] },
    });
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    const [call] = manager.commands("systemd-run");
    const unit = applicationUnitName(org.directory, selection);
    expect(call?.args).toEqual([
      "--user",
      "--quiet",
      "--no-ask-password",
      `--unit=${unit}`,
      expect.stringMatching(
        /^--description=Lazurio application; declaration sha256:[0-9a-f]{64}; definition sha256:[0-9a-f]{64}$/,
      ),
      "--service-type=exec",
      `--working-directory=${org.cwd}`,
      "--property=KillMode=control-group",
      "--property=Restart=no",
      "--property=UMask=0077",
      "--property=TimeoutStopSec=5s",
      "--property=StandardInput=null",
      "--property=StandardOutput=null",
      "--property=StandardError=null",
      "--expand-environment=no",
      "--setenv=HOME=/home/admin",
      "--setenv=PATH=/usr/bin:/bin",
      "--setenv=LAZURIO_RUNTIME_LISTENER_WEB_HOST=127.0.0.1",
      `--setenv=LAZURIO_RUNTIME_LISTENER_WEB_PORT=${org.port}`,
      // Everything the manager would otherwise pass on, credentials included.
      "--property=UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS JOURNAL_STREAM MANAGERPID MEMORY_PRESSURE_WATCH MEMORY_PRESSURE_WRITE NOTIFY_SOCKET SSH_AUTH_SOCK SYSTEMD_EXEC_PID WATCHDOG_PID WATCHDOG_USEC XDG_RUNTIME_DIR",
      "--",
      "/opt/bun/bin/bun",
      "--no-env-file",
      "run",
      "dev",
      "$HOME",
      "%h",
      "a b;c",
    ]);
    expect(await lifecycle.status(selection)).toMatchObject({ kind: "status" });
    // Only the fixed service-manager programs are ever invoked, never a shell,
    // and the D-Bus reader is only ever asked to read.
    expect(new Set(manager.calls.map((item) => item.program))).toEqual(
      new Set(["systemctl", "systemd-run", "busctl"]),
    );
    for (const call of manager.commands("busctl"))
      expect(call.args.slice(0, 3)).toEqual([
        "--user",
        "--json=short",
        "get-property",
      ]);
    expect(await lifecycle.close()).toEqual({ kind: "closed" });
  },
);

posixTest(
  "a manager that cannot disable expansion refuses an argument it would expand",
  async () => {
    const org = await organization("old-manager");
    const old = createFakeServiceManager({ version: 249 });
    const refused = launchpad(old, org, {
      launch: { args: ["run", "$HOME"] },
    });
    expect(await refused.lifecycle.start(selection)).toEqual({
      kind: "launch-failed",
    });
    expect(old.commands("systemd-run")).toEqual([]);
    const plain = launchpad(old, org);
    expect(await plain.lifecycle.start(selection)).toEqual({ kind: "started" });
    expect(old.commands("systemd-run")[0]?.args).not.toContain(
      "--expand-environment=no",
    );
  },
);

posixTest(
  "launch outside the owned Organization directory and control characters are refused",
  async () => {
    const org = await organization("containment");
    const manager = createFakeServiceManager();
    const { runner } = launchpad(manager, org);
    const request = (launch: Record<string, unknown>) =>
      runner.start({
        application: selection,
        declarationDigest: digest,
        ports: [org.port],
        launch: {
          executable: "/opt/bun/bin/bun",
          args: [],
          cwd: org.cwd,
          env: {},
          ...launch,
        } as never,
      });
    for (const launch of [
      { cwd: root },
      { cwd: `${org.directory}-sibling` },
      { cwd: join(org.cwd, "absent") },
      { args: ["line\nbreak"] },
      { env: { NAME: "tab\tvalue" } },
      { executable: "relative/bun" },
    ])
      expect(await request(launch)).toEqual({ kind: "launch-failed" });
    expect(manager.commands("systemd-run")).toEqual([]);
    expect(await request({})).toEqual({ kind: "started" });
  },
);

posixTest(
  "status maps the manager's states and never trusts a unit it did not shape",
  async () => {
    const org = await organization("states");
    const manager = createFakeServiceManager();
    const { runner, lifecycle } = launchpad(manager, org);
    const unit = applicationUnitName(org.directory, selection);
    expect(await runner.inspect(selection)).toEqual({ kind: "not-running" });
    expect(await lifecycle.status(selection)).toEqual({ kind: "not-managed" });
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    const state = manager.units.get(unit);
    if (!state) throw new Error("Expected unit");
    expect(await runner.inspect(selection)).toMatchObject({
      kind: "running",
      phase: "running",
      cwd: org.cwd,
      service: { unit, invocationId: state.invocationId, subState: "running" },
    });
    Object.assign(state, { active: "activating", sub: "start" });
    expect(await runner.inspect(selection)).toMatchObject({
      kind: "running",
      phase: "starting",
    });
    expect(await lifecycle.status(selection)).toMatchObject({
      kind: "status",
      runner: "systemd-user",
      survivesLaunchpadRestart: true,
      state: "starting",
      observedHealthy: false,
    });
    Object.assign(state, { active: "deactivating", sub: "stop-sigterm" });
    expect(await runner.inspect(selection)).toMatchObject({
      phase: "stopping",
    });
    Object.assign(state, { active: "active", sub: "running" });
    // Edited by hand: a drop-in, a unit file or another policy is foreign.
    for (const edit of [
      {
        dropIns: `${manager.runtimeDirectory}/systemd/transient/${unit}.d/50-CPUWeight.conf`,
      },
      { transient: "no" },
      { description: "Something else" },
      { cwd: "/somewhere/else" },
      { properties: { ...state.properties, Restart: "always" } },
      { properties: { ...state.properties, KillMode: "process" } },
    ]) {
      const before = { ...state };
      Object.assign(state, edit);
      expect(await runner.inspect(selection)).toEqual({ kind: "unrecognized" });
      for (const result of [
        await lifecycle.status(selection),
        await lifecycle.start(selection),
        await lifecycle.stop(selection),
        await lifecycle.prepare(selection),
        await lifecycle.entrypoint(selection),
      ])
        expect(result).toEqual({ kind: "service-unrecognized" });
      Object.assign(state, before);
    }
    expect(manager.commands("stop")).toEqual([]);
    expect(manager.commands("reset-failed")).toEqual([]);
    manager.crash(unit, "signal");
    expect(await runner.inspect(selection)).toMatchObject({
      kind: "ended",
      result: "signal",
      cleanup: "on-start",
    });
    const ended = await lifecycle.status(selection);
    expect(ended).toMatchObject({
      kind: "status",
      state: "ended",
      result: "signal",
      observedHealthy: false,
    });
    expect(applicationMessage(ended, true)).toBe("appEnded");
    manager.behaviour.unavailable = true;
    expect(await runner.inspect(selection)).toEqual({ kind: "unavailable" });
    expect(await lifecycle.status(selection)).toEqual({
      kind: "inspection-unavailable",
    });
    expect(await runner.list()).toEqual({ kind: "unavailable" });
  },
);

posixTest(
  "readiness is declared health plus the manager's control group, not a port or a PID",
  async () => {
    const org = await organization("ownership");
    const manager = createFakeServiceManager();
    let bindings: Binding[] = [];
    const { lifecycle } = launchpad(manager, org, { bindings: () => bindings });
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    const binding = (pid: number, host = "127.0.0.1") => ({
      pid,
      group: pid,
      uid: 1000,
      fd: 7,
      host,
      port: org.port,
    });
    expect(await lifecycle.status(selection)).toMatchObject({
      observedHealthy: false,
      listeners: [
        {
          id: "web",
          observation: {
            kind: "ownership-unconfirmed",
            reason: "not-observed",
          },
        },
      ],
    });
    // A foreign process answering on the declared port is never this application.
    bindings = [binding(777)];
    expect(await lifecycle.status(selection)).toMatchObject({
      observedHealthy: false,
      listeners: [
        {
          observation: {
            kind: "ownership-unconfirmed",
            reason: "foreign-control-group",
          },
        },
      ],
    });
    expect(await lifecycle.entrypoint(selection)).toEqual({
      kind: "not-ready",
    });
    bindings = [binding(4242, "0.0.0.0")];
    expect(await lifecycle.status(selection)).toMatchObject({
      listeners: [{ observation: { reason: "binding-mismatch" } }],
    });
    bindings = [binding(4242)];
    const healthy = await lifecycle.status(selection);
    expect(healthy).toMatchObject({
      kind: "status",
      runner: "systemd-user",
      survivesLaunchpadRestart: true,
      state: "running",
      observedHealthy: true,
      service: { unit: applicationUnitName(org.directory, selection) },
    });
    expect(applicationMessage(healthy, true)).toBe("appHealthyPersistent");
    expect(JSON.stringify(healthy)).not.toContain("4242");
    expect(await lifecycle.entrypoint(selection)).toEqual({
      kind: "local-entrypoint",
      url: `http://127.0.0.1:${org.port}/`,
    });
    // The running invocation came from another declaration than the one on disk.
    org.pkg.scripts.dev = "changed";
    await org.savePackage();
    expect(await lifecycle.status(selection)).toMatchObject({
      declarationChanged: true,
      observedHealthy: false,
      listeners: [],
    });
    expect(await lifecycle.entrypoint(selection)).toEqual({
      kind: "declaration-changed",
    });
  },
);

posixTest(
  "a port collision is refused before anything is started",
  async () => {
    const org = await organization("collision");
    const manager = createFakeServiceManager();
    const { lifecycle } = launchpad(manager, org, {
      bindings: () => [
        {
          pid: 900,
          group: 900,
          uid: 1000,
          fd: 3,
          host: "127.0.0.1",
          port: org.port,
        },
      ],
    });
    expect(await lifecycle.start(selection)).toEqual({ kind: "port-occupied" });
    expect(manager.commands("systemd-run")).toEqual([]);
    expect(manager.units.size).toBe(0);
  },
);

posixTest(
  "stop waits for the control group and reports incomplete when it never empties",
  async () => {
    const org = await organization("stop");
    const manager = createFakeServiceManager();
    const { lifecycle } = launchpad(manager, org);
    expect(await lifecycle.stop(selection)).toEqual({ kind: "not-managed" });
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    manager.behaviour.stopLeavesPopulatedFor = 3;
    expect(await lifecycle.stop(selection)).toEqual({ kind: "group-stopped" });
    expect(manager.behaviour.stopLeavesPopulatedFor).toBe(0);
    expect(manager.commands("stop")).toHaveLength(1);
    expect(await lifecycle.status(selection)).toEqual({ kind: "not-managed" });

    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    manager.behaviour.stopLeavesPopulatedFor = Number.MAX_SAFE_INTEGER;
    expect(await lifecycle.stop(selection)).toEqual({ kind: "incomplete" });
    manager.behaviour.stopLeavesPopulatedFor = 0;

    // The manager had to kill the group: a failed record remains and is cleared
    // only after the kernel confirms that the group is empty.
    const second = await organization("stop-timeout", 41_235);
    const forced = launchpad(manager, second);
    expect(await forced.lifecycle.start(selection)).toEqual({
      kind: "started",
    });
    manager.behaviour.stop = "timeout-failed";
    expect(await forced.lifecycle.stop(selection)).toEqual({
      kind: "group-stopped",
    });
    expect(manager.commands("reset-failed")).toHaveLength(1);
    expect(await forced.lifecycle.status(selection)).toEqual({
      kind: "not-managed",
    });
    manager.behaviour.stop = "stuck";
    expect(await forced.lifecycle.start(selection)).toEqual({
      kind: "started",
    });
    expect(await forced.lifecycle.stop(selection)).toEqual({
      kind: "incomplete",
    });
    expect(await forced.lifecycle.status(selection)).toMatchObject({
      kind: "status",
      state: "running",
    });
  },
);

posixTest(
  "a failed unit is reported with its result, then reset and started again",
  async () => {
    const org = await organization("failed");
    const manager = createFakeServiceManager();
    const { lifecycle } = launchpad(manager, org);
    const unit = applicationUnitName(org.directory, selection);
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    const first = manager.units.get(unit)?.invocationId;
    manager.crash(unit);
    expect(await lifecycle.status(selection)).toMatchObject({
      state: "ended",
      result: "exit-code",
      service: { invocationId: first, activeState: "failed" },
    });
    // The manager refuses a new transient unit while the failed record remains.
    expect(
      (
        await manager.run(
          "systemd-run",
          [`--unit=${unit}`, "--", "/bin/true"],
          {
            timeoutMs: 1000,
          },
        )
      ).code,
    ).toBe(1);
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    expect(manager.commands("reset-failed")).toHaveLength(1);
    expect(manager.units.get(unit)?.invocationId).not.toBe(first);
    expect(manager.units.get(unit)?.active).toBe("active");
    // Stop alone also clears a failed record.
    manager.crash(unit);
    expect(await lifecycle.stop(selection)).toEqual({ kind: "group-stopped" });
    expect(manager.units.has(unit)).toBe(false);
    expect(manager.commands("stop")).toEqual([]);
  },
);

posixTest("a failed start leaves no half-owned service", async () => {
  const org = await organization("failed-start");
  const manager = createFakeServiceManager();
  const { lifecycle } = launchpad(manager, org);
  manager.behaviour.start = "fail";
  expect(await lifecycle.start(selection)).toEqual({ kind: "launch-failed" });
  expect(manager.units.size).toBe(0);
  manager.behaviour.start = "fail-loaded";
  expect(await lifecycle.start(selection)).toEqual({ kind: "launch-failed" });
  expect(manager.units.size).toBe(0);
  expect(await lifecycle.status(selection)).toEqual({ kind: "not-managed" });
  // The request outlives its deadline while the manager completes the start:
  // the service is withdrawn, never left running without a reported start.
  manager.behaviour.start = "timeout-loaded";
  expect(await lifecycle.start(selection)).toEqual({ kind: "launch-failed" });
  expect(manager.commands("stop")).toHaveLength(1);
  expect(manager.units.size).toBe(0);
  manager.behaviour.start = "ok";
  expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
  expect(await lifecycle.start(selection)).toEqual({ kind: "already-managed" });
  expect(manager.commands("systemd-run")).toHaveLength(4);
});

posixTest(
  "dependency preparation is refused beneath a running service and never stops it",
  async () => {
    const org = await organization("preparation");
    const manager = createFakeServiceManager();
    let preflights = 0;
    const { lifecycle } = launchpad(manager, org, {
      preflight: () => preflights++,
    });
    expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
    for (const mode of ["prepare", "clean-prepare"] as const)
      expect(await lifecycle.prepare(selection, mode)).toEqual({
        kind: "application-running",
      });
    expect(applicationMessage({ kind: "application-running" }, true)).toBe(
      "appApplicationRunning",
    );
    expect(preflights).toBe(0);
    expect(manager.commands("stop")).toEqual([]);
    expect(manager.units.size).toBe(1);
    expect(await lifecycle.stop(selection)).toEqual({ kind: "group-stopped" });
    expect(await lifecycle.prepare(selection)).toEqual({ kind: "prepared" });
    expect(preflights).toBe(1);

    // Another application of the same Organization directory blocks it as well.
    const otherUnit = applicationUnitName(org.directory, {
      ...selection,
      package: "other/package.json",
    });
    await manager.run(
      "systemd-run",
      [`--unit=${otherUnit}`, "--service-type=exec", "--", "/bin/true"],
      { timeoutMs: 1000 },
    );
    expect(await lifecycle.prepare(selection)).toEqual({
      kind: "other-app-managed",
    });
    // A unit of another Organization directory is not this owner's business.
    manager.units.delete(otherUnit);
    await manager.run(
      "systemd-run",
      [
        `--unit=${applicationUnitName(join(root, "elsewhere"), selection)}`,
        "--",
        "/bin/true",
      ],
      { timeoutMs: 1000 },
    );
    expect(await lifecycle.prepare(selection)).toEqual({ kind: "prepared" });
  },
);

posixTest(
  "a new Launchpad rediscovers the running application from the service manager",
  async () => {
    const org = await organization("rediscovery");
    const manager = createFakeServiceManager();
    // The application listens only while its unit exists.
    const bindings = () =>
      manager.units.size
        ? [
            {
              pid: 4242,
              group: 4242,
              uid: 1000,
              fd: 7,
              host: "127.0.0.1",
              port: org.port,
            },
          ]
        : [];
    const first = launchpad(manager, org, { bindings });
    expect(await first.lifecycle.start(selection)).toEqual({ kind: "started" });
    const before = await first.lifecycle.status(selection);
    if (before.kind !== "status" || !("service" in before))
      throw new Error("Expected service status");
    // Owner shutdown: the service-owned application is left alone.
    expect(await first.lifecycle.close()).toEqual({ kind: "closed" });
    expect(manager.commands("stop")).toEqual([]);
    expect(manager.units.size).toBe(1);

    const second = launchpad(manager, org, { bindings });
    const after = await second.lifecycle.status(selection);
    expect(after).toMatchObject({
      kind: "status",
      runner: "systemd-user",
      state: "running",
      observedHealthy: true,
      service: { invocationId: before.service?.invocationId },
    });
    expect(await second.lifecycle.start(selection)).toEqual({
      kind: "already-managed",
    });
    expect(await second.lifecycle.entrypoint(selection)).toEqual({
      kind: "local-entrypoint",
      url: `http://127.0.0.1:${org.port}/`,
    });
    expect(await second.lifecycle.stop(selection)).toEqual({
      kind: "group-stopped",
    });
    expect(manager.units.size).toBe(0);
    expect(await second.lifecycle.close()).toEqual({ kind: "closed" });

    // A different checkout of the same Organization sees none of it.
    const elsewhere = await organization("rediscovery-elsewhere", org.port);
    expect(await first.lifecycle.status(selection)).toEqual({
      kind: "not-managed",
    });
    const third = launchpad(manager, org, { bindings });
    expect(await third.lifecycle.start(selection)).toEqual({ kind: "started" });
    const foreign = launchpad(manager, elsewhere, { bindings });
    expect(await foreign.lifecycle.status(selection)).toEqual({
      kind: "not-managed",
    });
    expect(await foreign.lifecycle.stop(selection)).toEqual({
      kind: "not-managed",
    });
    expect(manager.units.size).toBe(1);
  },
);

posixTest(
  "closing the Launchpad server does not stop a service-owned application",
  async () => {
    const org = await organization("server-close");
    const folder = join(root, "server-close-folder");
    await initializeFolder(folder, {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const manager = createFakeServiceManager();
    const adapters = (): Parameters<typeof createApplicationLifecycle>[0] => ({
      runner: createSystemdUserRunner({
        organizationDirectory: org.directory,
        runtimeDirectory: manager.runtimeDirectory,
        run: manager.run,
        controlGroupEmpty: manager.controlGroupEmpty,
        observeBindings: async () => ({ kind: "observed", bindings: [] }),
      }),
      authorize: async () => ({ moduleDirectory: org.moduleDirectory }),
      prepareLaunch: async (_plan, cwd) => ({
        executable: "/opt/bun/bin/bun",
        args: ["run", "dev"],
        cwd,
        env: { PATH: "/usr/bin:/bin" },
      }),
    });
    const call = async (
      app: Awaited<ReturnType<typeof startLaunchpad>>,
      action: string,
    ) => {
      const url = new URL(app.url);
      const response = await fetch(`${url.origin}/api/apps/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
        },
        body: JSON.stringify(selection),
      });
      return response.json();
    };
    const first = await startLaunchpad(folder, adapters());
    expect(await call(first, "start")).toEqual({ kind: "started" });
    const started = (await call(first, "status")) as {
      service: { invocationId: string };
    };
    expect(await first.close()).toEqual({ kind: "closed" });
    expect(manager.commands("stop")).toEqual([]);
    expect(manager.units.size).toBe(1);
    const second = await startLaunchpad(folder, adapters());
    try {
      expect(await call(second, "status")).toMatchObject({
        kind: "status",
        runner: "systemd-user",
        survivesLaunchpadRestart: true,
        service: { invocationId: started.service.invocationId },
      });
      expect(await call(second, "stop")).toEqual({ kind: "group-stopped" });
      expect(manager.units.size).toBe(0);
    } finally {
      expect(await second.close()).toEqual({ kind: "closed" });
    }
  },
);

posixTest(
  "a unit differing in any single ownership-relevant property is foreign and never touched",
  async () => {
    const org = await organization("ownership-table");
    const inside = join(org.moduleDirectory, "elsewhere");
    await mkdir(inside, { mode: 0o700 });
    type FakeUnit = NonNullable<
      ReturnType<ReturnType<typeof createFakeServiceManager>["units"]["get"]>
    >;
    const property = (name: string, value: string) => (unit: FakeUnit) => {
      unit.properties = { ...unit.properties, [name]: value };
    };
    const cases: [string, (unit: FakeUnit) => void][] = [
      [
        "ExecStart executable",
        (unit) => {
          unit.command = ["/usr/bin/other", ...unit.command.slice(1)];
        },
      ],
      [
        "ExecStart arguments",
        (unit) => {
          unit.command = [...unit.command, "--extra"];
        },
      ],
      [
        "ExecStart argument split",
        (unit) => {
          unit.command = [
            unit.command[0] as string,
            "--no-env-file run",
            "dev",
          ];
        },
      ],
      [
        "ExecStart expansion flag",
        (unit) => {
          unit.flags = [];
        },
      ],
      [
        "Environment value",
        (unit) => {
          unit.environment = unit.environment.map((entry) =>
            entry.startsWith("PATH=") ? "PATH=/tmp/bin:/usr/bin" : entry,
          );
        },
      ],
      [
        "Environment extra variable",
        (unit) => {
          unit.environment = [...unit.environment, "SSH_AUTH_SOCK=/tmp/agent"];
        },
      ],
      [
        "UnsetEnvironment",
        property(
          "UnsetEnvironment",
          "DBUS_SESSION_BUS_ADDRESS JOURNAL_STREAM MANAGERPID",
        ),
      ],
      ["UMask", property("UMask", "0022")],
      ["TimeoutStopSec", property("TimeoutStopSec", "1min 30s")],
      ["StandardInput", property("StandardInput", "tty")],
      ["StandardOutput", property("StandardOutput", "journal")],
      ["StandardError", property("StandardError", "journal")],
      ["KillMode", property("KillMode", "process")],
      ["Restart", property("Restart", "always")],
      [
        "Type",
        (unit) => {
          unit.type = "simple";
        },
      ],
      [
        "WorkingDirectory inside the Organization",
        (unit) => {
          unit.cwd = inside;
        },
      ],
      [
        "WorkingDirectory outside the Organization",
        (unit) => {
          unit.cwd = root;
        },
      ],
      [
        "Description definition digest",
        (unit) => {
          unit.description = unit.description.replace(
            /definition sha256:[0-9a-f]{64}$/,
            `definition sha256:${"0".repeat(64)}`,
          );
        },
      ],
      [
        "Description form",
        (unit) => {
          unit.description = unit.description.replace(/; definition.*$/, "");
        },
      ],
      [
        "Transient",
        (unit) => {
          unit.transient = "no";
        },
      ],
      [
        "FragmentPath",
        (unit) => {
          unit.fragmentPath = "/home/admin/.config/systemd/user/unit.service";
        },
      ],
      [
        "DropInPaths",
        (unit) => {
          unit.dropIns = "/run/user/1000/systemd/transient/unit.d/50-x.conf";
        },
      ],
    ];
    // Active, failed and loaded-but-inactive: state never outranks shape.
    for (const [name, mutate] of cases)
      for (const state of ["active", "failed", "inactive"]) {
        const manager = createFakeServiceManager();
        const { runner, lifecycle } = launchpad(manager, org);
        expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
        const unit = manager.units.get(
          applicationUnitName(org.directory, selection),
        );
        if (!unit) throw new Error("Expected unit");
        // Untouched, the generated unit IS recognized in every state.
        Object.assign(unit, { active: state });
        expect((await runner.inspect(selection)).kind, name).toBe(
          state === "active"
            ? "running"
            : state === "failed"
              ? "ended"
              : "not-running",
        );
        mutate(unit);
        const before = manager.calls.length;
        expect(await runner.inspect(selection), `${name}/${state}`).toEqual({
          kind: "unrecognized",
        });
        expect(await runner.stop(selection), `${name}/${state}`).toEqual({
          kind: "incomplete",
        });
        for (const result of [
          await lifecycle.stop(selection),
          await lifecycle.start(selection),
          await lifecycle.status(selection),
          await lifecycle.prepare(selection),
        ])
          expect(result, `${name}/${state}`).toEqual({
            kind: "service-unrecognized",
          });
        // Reading is all that ever happened to it.
        const after = manager.calls.slice(before);
        expect(
          after.filter(
            (call) =>
              call.program === "systemd-run" ||
              (call.program === "systemctl" &&
                !["show", "list-units"].includes(call.args[1] as string)),
          ),
          `${name}/${state}`,
        ).toEqual([]);
        expect(manager.units.size).toBe(1);
      }
  },
);

posixTest(
  "stop keeps confirming through its whole bound for failed units too",
  async () => {
    const org = await organization("stop-convergence");
    const unit = applicationUnitName(org.directory, selection);
    // Already failed before Stop, its group still populated for a while.
    {
      const manager = createFakeServiceManager();
      const { lifecycle } = launchpad(manager, org);
      expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
      manager.crash(unit, "signal", true);
      manager.behaviour.stopLeavesPopulatedFor = 4;
      expect(await lifecycle.stop(selection)).toEqual({
        kind: "group-stopped",
      });
      expect(manager.behaviour.stopLeavesPopulatedFor).toBe(0);
      expect(manager.commands("stop")).toEqual([]);
      expect(manager.commands("reset-failed")).toHaveLength(1);
      expect(manager.units.size).toBe(0);
    }
    // Running, becomes failed during Stop, group empties before the deadline.
    {
      const manager = createFakeServiceManager();
      const { lifecycle } = launchpad(manager, org);
      expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
      manager.behaviour.stop = "timeout-failed";
      manager.behaviour.stopLeavesPopulatedFor = 4;
      expect(await lifecycle.stop(selection)).toEqual({
        kind: "group-stopped",
      });
      expect(manager.behaviour.stopLeavesPopulatedFor).toBe(0);
      expect(manager.commands("reset-failed")).toHaveLength(1);
      expect(manager.units.size).toBe(0);
    }
    // Never empties: bounded, incomplete, and the failed record is NOT reset.
    for (const path of ["ended-before", "running-to-ended"]) {
      const manager = createFakeServiceManager();
      const { lifecycle } = launchpad(manager, org);
      expect(await lifecycle.start(selection)).toEqual({ kind: "started" });
      if (path === "ended-before") manager.crash(unit, "signal", true);
      else manager.behaviour.stop = "timeout-failed";
      manager.behaviour.stopLeavesPopulatedFor = Number.MAX_SAFE_INTEGER;
      const started = performance.now();
      expect(await lifecycle.stop(selection), path).toEqual({
        kind: "incomplete",
      });
      expect(performance.now() - started).toBeGreaterThanOrEqual(190);
      expect(manager.commands("reset-failed"), path).toEqual([]);
      expect(manager.units.size).toBe(1);
    }
  },
);

posixTest(
  "equivalent spellings of one Organization directory share one unit and one lock",
  async () => {
    const org = await organization("canonical-identity");
    const spellings = [
      org.directory,
      `${org.directory}/../canonical-identity`,
      `${org.directory}/./`,
      `${org.directory}//workspace/..`,
    ];
    const units = new Set<string>();
    const locks = new Set<string>();
    for (const spelling of spellings) {
      const canonical = await canonicalOwnedDirectory(spelling);
      expect(canonical).toBe(org.directory);
      units.add(applicationUnitName(canonical, selection));
      locks.add(applicationCoordinationLockFile("/run/user/1000", canonical));
    }
    expect(units.size).toBe(1);
    expect(locks.size).toBe(1);
    // A spelling that was not canonicalized is refused at every derivation,
    // never hashed into a second identity.
    const manager = createFakeServiceManager();
    for (const spelling of spellings.slice(1)) {
      expect(() => applicationUnitName(spelling, selection)).toThrow(
        "Canonical",
      );
      expect(() =>
        applicationCoordinationLockFile("/run/user/1000", spelling),
      ).toThrow("Canonical");
      expect(() =>
        createSystemdUserRunner({
          organizationDirectory: spelling,
          runtimeDirectory: manager.runtimeDirectory,
          run: manager.run,
        }),
      ).toThrow("Canonical");
    }
    expect(() => applicationUnitName("relative/org", selection)).toThrow();
    // A symlinked spelling is not accepted anywhere else either.
    const link = join(root, "canonical-identity-link");
    await symlink(org.directory, link);
    await expect(canonicalOwnedDirectory(link)).rejects.toThrow();
    // An application started under one spelling is the same application under
    // the other: one unit, found again.
    const first = launchpad(manager, org);
    expect(await first.lifecycle.start(selection)).toEqual({ kind: "started" });
    const again = launchpad(manager, {
      ...org,
      directory: await canonicalOwnedDirectory(spellings[1] as string),
    });
    expect(await again.lifecycle.start(selection)).toEqual({
      kind: "already-managed",
    });
    expect(manager.units.size).toBe(1);
  },
);
