import { afterEach, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import {
  type ActivationEffects,
  resumeActivation,
  runActivationWorker,
  type WorkerInput,
} from "../src/update/activate";
import {
  type ActivationRecord,
  parseServiceSpec,
  readActivationRecord,
  readPrevious,
  writeActivationRecord,
} from "../src/update/activation-record";
import { selfCheckCommand } from "../src/update/cli";
import { writeDurableFile } from "../src/update/durable-file";
import { UpdateFailure, updateErrors } from "../src/update/errors";
import {
  layout,
  readSelector,
  swapSelector,
  versionName,
} from "../src/update/layout";
import { acquireUpdateLock, probeUpdateLock } from "../src/update/lock";
import { readObserved } from "../src/update/observed";
import {
  announceLaunchpadReady,
  createStabilityTracker,
  evaluateReadiness,
  type LaunchpadReadiness,
  readLaunchpadReadiness,
} from "../src/update/readiness";
import {
  type ProcessRunner,
  requireSelfCheck,
  runProcess,
} from "../src/update/self-check";
import {
  createServiceControl,
  type ServiceControl,
  serviceEnvironment,
  systemdRestartCommand,
  workerCommand,
} from "../src/update/service-control";
import { workerArguments } from "../src/update/update";

// The activation state machine with INJECTED service manager, process and
// clock adapters: no real systemd exists in CI. Versions here are synthetic
// bytes — with a service adapter nothing is executed; the compiled journeys
// (update-journey.test.ts) cover real executables.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const systemd = {
  kind: "systemd-user",
  unit: "lazurio-launchpad.service",
} as const;

async function installation() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "update-activation-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "base");
  const stage = async (
    version: string,
    schemas = { preferences: [1], manifest: [1] },
  ) => {
    const bytes = randomBytes(2048);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const name = versionName(version, sha256);
    const directory = join(base, "versions", name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "lazurio"), bytes, { mode: 0o500 });
    await writeFile(
      join(directory, "identity.json"),
      JSON.stringify({
        schemaVersion: 1,
        version,
        target: "linux-x64",
        sourceCommit: "c".repeat(40),
        schemas,
        artifactSha256: sha256,
        artifactBytes: bytes.length,
      }),
    );
    return { name, sha256, version };
  };
  const a = await stage("1.0.0");
  const b = await stage("1.1.0");
  await swapSelector(base, a.name);
  await mkdir(join(base, "update"), { recursive: true });
  // A clock that only moves when the worker sleeps: the whole wait is
  // deterministic and takes no real time.
  let now = Date.parse("2026-09-19T10:00:00.000Z");
  const restarts: number[] = [];
  let readiness: (at: number) => LaunchpadReadiness | null = () => null;
  let onRestart: () => Promise<void> = async () => {};
  const service: ServiceControl = {
    kind: "systemd-user",
    async restartLaunchpad() {
      restarts.push(now);
      await onRestart();
    },
    launchpadReadiness: async () => readiness(now),
  };
  const effects: Partial<ActivationEffects> = {
    clock: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
    pidAlive: (pid) => pid !== 666,
    service: () => service,
    run: async () => {
      throw new Error("Nothing is executed with a service adapter");
    },
  };
  const worker = (overrides: Partial<WorkerInput> = {}) =>
    runActivationWorker({
      base,
      candidate: b.name,
      operation: "op-1",
      kind: "update",
      service: systemd,
      policy: {
        deadlineMs: 60_000,
        stabilityMs: 5_000,
        pollMs: 1_000,
        lockTimeoutMs: 200,
      },
      effects,
      ...overrides,
    });
  // One instance: it started when it was first looked at, after the switch.
  const fresh = (sha256: string, pid = 4242) => {
    let startedAt: string | undefined;
    return (at: number) => {
      startedAt ??= new Date(at).toISOString();
      return { artifactSha256: sha256, pid, startedAt };
    };
  };
  return {
    root,
    base,
    a,
    b,
    stage,
    worker,
    effects,
    restarts,
    fresh,
    advance: (ms: number) => {
      now += ms;
    },
    time: () => now,
    setReadiness(next: typeof readiness) {
      readiness = next;
    },
    setOnRestart(next: typeof onRestart) {
      onRestart = next;
    },
    updateEntries: async () => (await readdir(join(base, "update"))).sort(),
  };
}

test("the service adapter builds exact commands, passes only the session variables, and refuses unit names that are not units", async () => {
  expect(systemdRestartCommand("lazurio-launchpad.service")).toEqual([
    "systemctl",
    "--user",
    "restart",
    "lazurio-launchpad.service",
  ]);
  const worker = [
    "/base/versions/1.0.0+0123456789abcdef/lazurio",
    "update",
    "apply-worker",
  ];
  expect(workerCommand({ kind: "none" }, worker, "op-1")).toEqual(worker);
  // Its own transient unit: a child of the Launchpad would die with the
  // Launchpad's control group at `systemctl restart`.
  expect(workerCommand(systemd, worker, "op-1")).toEqual([
    "systemd-run",
    "--user",
    "--collect",
    "--quiet",
    "--wait",
    "--pipe",
    "--unit=lazurio-update-op-1",
    "--",
    ...worker,
  ]);
  expect(
    workerArguments({
      base: "/base",
      candidate: "1.1.0+0123456789abcdef",
      operation: "op-1",
      kind: "rollback",
      service: systemd,
      folder: "/folder",
      policy: {
        deadlineMs: 120_000,
        stabilityMs: 10_000,
        pollMs: 1,
        lockTimeoutMs: 1,
        settleLockTimeoutMs: 1,
        selfCheckTimeoutMs: 1,
      },
    }),
  ).toEqual([
    "update",
    "apply-worker",
    "--base",
    "/base",
    "--candidate",
    "1.1.0+0123456789abcdef",
    "--operation",
    "op-1",
    "--kind",
    "rollback",
    "--service",
    "systemd-user",
    "--unit",
    "lazurio-launchpad.service",
    "--folder",
    "/folder",
    "--deadline-ms",
    "120000",
    "--stability-ms",
    "10000",
  ]);
  for (const unit of [
    "",
    "launchpad",
    "../x.service",
    "a b.service",
    "-x.service",
    "x.service;rm",
  ])
    expect(parseServiceSpec({ kind: "systemd-user", unit })).toBeUndefined();
  expect(parseServiceSpec({ kind: "launchd" })).toBeUndefined();
  expect(parseServiceSpec({ kind: "none" })).toEqual({ kind: "none" });

  const calls: { command: readonly string[]; env: unknown }[] = [];
  let exitCode = 0;
  const run: ProcessRunner = async (command, _timeout, env) => {
    calls.push({ command, env });
    return { exitCode, stdout: "" };
  };
  const control = createServiceControl(systemd, {
    base: "/nowhere",
    run,
    env: {
      HOME: "/home/u",
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SECRET_TOKEN: "never passed on",
    },
  });
  await control.restartLaunchpad();
  expect(calls).toEqual([
    {
      command: ["systemctl", "--user", "restart", "lazurio-launchpad.service"],
      env: {
        HOME: "/home/u",
        PATH: "/usr/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
    },
  ]);
  exitCode = 1;
  await expect(control.restartLaunchpad()).rejects.toThrow();
  expect(await control.launchpadReadiness()).toBeNull();
  expect(serviceEnvironment({})).toEqual({});
  // `none` restarts nothing and knows no Launchpad.
  const none = createServiceControl(
    { kind: "none" },
    { base: "/nowhere", run, env: {} },
  );
  await none.restartLaunchpad();
  expect(await none.launchpadReadiness()).toBeNull();
  expect(calls).toHaveLength(2);
});

test("readiness needs a FRESH instance with the expected digest that is alive, for the whole stability period", () => {
  const switchedAt = new Date("2026-09-19T10:00:00.000Z");
  const ready = {
    artifactSha256: "b".repeat(64),
    pid: 4242,
    startedAt: "2026-09-19T10:00:01.000Z",
  };
  const verdict = (readiness: LaunchpadReadiness | null, alive = true) =>
    evaluateReadiness({
      readiness,
      expectedSha256: "b".repeat(64),
      switchedAt,
      pidAlive: () => alive,
    });
  expect(verdict(null)).toBe("absent");
  expect(verdict(ready)).toBe("ready");
  // The old process still answering proves nothing.
  expect(verdict({ ...ready, artifactSha256: "a".repeat(64) })).toBe(
    "wrong-artifact",
  );
  expect(verdict({ ...ready, startedAt: "2026-09-19T09:59:59.000Z" })).toBe(
    "stale-instance",
  );
  expect(verdict(ready, false)).toBe("not-running");

  const stable = createStabilityTracker(5_000);
  expect(stable(0, "ready", ready)).toBe(false);
  expect(stable(4_999, "ready", ready)).toBe(false);
  expect(stable(5_000, "ready", ready)).toBe(true);
  // One bad look starts the period again.
  expect(stable(6_000, "not-running", ready)).toBe(false);
  expect(stable(7_000, "ready", ready)).toBe(false);
  expect(stable(12_000, "ready", ready)).toBe(true);
  // A crash loop is a new instance at every look and never confirms.
  const looping = createStabilityTracker(5_000);
  for (let look = 0; look < 20; look++)
    expect(
      looping(look * 1_000, "ready", { ...ready, pid: 5_000 + look }),
    ).toBe(false);
});

test("systemd activation: the step lock is free while the Launchpad restarts, a stale instance is not accepted, a fresh stable one confirms, and retention keeps active, previous and what still runs", async () => {
  const i = await installation();
  const other = await i.stage("0.9.0");
  const runningOld = await i.stage("0.8.0");
  await mkdir(join(i.base, "update", "scratch-abandoned"));
  const locks: string[] = [];
  i.setOnRestart(async () => {
    // The restarted Launchpad needs the step lock; the worker stays alive.
    const step = await acquireUpdateLock(layout(i.base).stepLock, {
      timeoutMs: 0,
    });
    await step.release();
    locks.push(await probeUpdateLock(layout(i.base).activationLock));
    expect(await readSelector(i.base)).toBe(i.b.name);
    expect(await readActivationRecord(i.base)).toMatchObject({
      record: {
        phase: "confirming",
        previous: i.a.name,
        candidate: i.b.name,
        service: systemd,
      },
    });
    expect((await readObserved(i.base, new Date(i.time()))).status).toBe(
      "activating",
    );
  });
  const switched = i.time();
  i.setReadiness((at) =>
    at < switched + 3_000
      ? // The OLD Launchpad still answers: right pid, wrong artifact.
        {
          artifactSha256: i.a.sha256,
          pid: 4000,
          startedAt: new Date(switched - 60_000).toISOString(),
        }
      : at < switched + 6_000
        ? null
        : {
            artifactSha256: i.b.sha256,
            pid: 4242,
            startedAt: new Date(switched + 6_000).toISOString(),
          },
  );
  expect(await i.worker()).toEqual({
    kind: "confirmed",
    version: "1.1.0",
    candidate: i.b.name,
    previous: i.a.name,
  });
  expect(locks).toEqual(["held"]);
  expect(i.restarts).toHaveLength(1);
  // Not before the instance had been ready for the whole stability period.
  expect(i.time()).toBeGreaterThanOrEqual(switched + 6_000 + 5_000);
  expect(await readSelector(i.base)).toBe(i.b.name);
  expect(await readPrevious(i.base)).toBe(i.a.name);
  expect(await i.updateEntries()).toEqual([
    "activation.lock",
    "lock",
    "observed.json",
    "previous.json",
  ]);
  expect((await readdir(join(i.base, "versions"))).sort()).toEqual(
    [i.a.name, i.b.name].sort(),
  );
  expect(other.name).not.toBe(runningOld.name);
  expect(await readObserved(i.base, new Date(i.time()))).toMatchObject({
    status: "up-to-date",
    selected: { version: "1.1.0" },
    lastHealthyActivation: { version: "1.1.0" },
    error: null,
  });
  // Both locks are free again.
  expect(await probeUpdateLock(layout(i.base).stepLock)).toBe("free");
  expect(await probeUpdateLock(layout(i.base).activationLock)).toBe("free");
});

test("retention keeps the version a live Launchpad still runs", async () => {
  const i = await installation();
  const old = await i.stage("0.8.0");
  const unused = await i.stage("0.9.0");
  let confirmedLook = false;
  const candidate = i.fresh(i.b.sha256);
  i.setReadiness((at) => {
    // During the wait the new instance reports; at retention time a second,
    // older Launchpad is what the readiness file shows.
    if (confirmedLook)
      return {
        artifactSha256: old.sha256,
        pid: 4000,
        startedAt: new Date(at).toISOString(),
      };
    return candidate(at);
  });
  const original = i.effects.write ?? writeDurableFile;
  i.effects = Object.assign(i.effects, {
    write: async (directory: string, name: string, bytes: Uint8Array) => {
      if (name === "previous.json") confirmedLook = true;
      await original(directory, name, bytes);
    },
  });
  expect(await i.worker()).toMatchObject({ kind: "confirmed" });
  const kept = await readdir(join(i.base, "versions"));
  expect(kept).toContain(old.name);
  expect(kept).not.toContain(unused.name);
});

test("systemd activation that never becomes ready — wrong artifact, crash loop, dead process, failing restart — is rolled back with the reason, and the service is restarted onto the previous version", async () => {
  for (const [name, arrange, reason] of [
    [
      "wrong artifact",
      (i: Awaited<ReturnType<typeof installation>>) =>
        i.setReadiness(i.fresh(i.a.sha256)),
      "wrong-artifact",
    ],
    ["never announced", () => undefined, "absent"],
    [
      "crash loop",
      (i: Awaited<ReturnType<typeof installation>>) =>
        i.setReadiness((at) => ({
          ...(i.fresh(i.b.sha256)(at) as LaunchpadReadiness),
          pid: 10_000 + (at % 100_000),
        })),
      "unstable",
    ],
    [
      "dead process",
      (i: Awaited<ReturnType<typeof installation>>) =>
        i.setReadiness(i.fresh(i.b.sha256, 666)),
      "not-running",
    ],
    [
      "restart fails",
      (i: Awaited<ReturnType<typeof installation>>) =>
        i.setOnRestart(async () => {
          if (i.restarts.length === 1) throw new Error("systemctl failed");
        }),
      "restart",
    ],
  ] as const) {
    const i = await installation();
    arrange(i);
    const started = i.time();
    expect([name, await i.worker()]).toEqual([
      name,
      {
        kind: "error",
        code: "activation-failed",
        context: { reason, rolledBackTo: "1.0.0" },
      },
    ]);
    expect(await readSelector(i.base)).toBe(i.a.name);
    expect((await readActivationRecord(i.base)).kind).toBe("absent");
    expect(await readPrevious(i.base)).toBeNull();
    // Once to start the candidate, once more to leave it.
    expect(i.restarts).toHaveLength(2);
    // Bounded by the deadline, and the candidate stays staged for a retry.
    expect(i.time() - started).toBeLessThanOrEqual(62_000);
    expect(await readdir(join(i.base, "versions"))).toContain(i.b.name);
    expect(await readObserved(i.base, new Date(i.time()))).toMatchObject({
      status: "error",
      error: { code: "activation-failed", context: { reason } },
      canRetry: true,
      selected: { version: "1.0.0" },
    });
  }
});

test("a worker refuses, without touching anything, when another worker is alive, the step is busy, the candidate is damaged or a rollback target cannot read the current schemas", async () => {
  const i = await installation();
  const untouched = async () => {
    expect(await readSelector(i.base)).toBe(i.a.name);
    expect((await readActivationRecord(i.base)).kind).toBe("absent");
    expect(i.restarts).toEqual([]);
  };
  const alive = await acquireUpdateLock(layout(i.base).activationLock, {
    timeoutMs: 0,
  });
  expect(await i.worker()).toEqual({
    kind: "error",
    code: "busy",
    context: { reason: "activation" },
  });
  await alive.release();
  await untouched();
  const step = await acquireUpdateLock(layout(i.base).stepLock, {
    timeoutMs: 0,
  });
  expect(await i.worker()).toMatchObject({ kind: "error", code: "busy" });
  await step.release();
  await untouched();
  expect(await i.worker({ candidate: i.a.name })).toEqual({
    kind: "already-active",
    version: "1.0.0",
    candidate: i.a.name,
  });
  expect(await i.worker({ candidate: "not a name" })).toMatchObject({
    code: "invalid-request",
  });
  // Program rollback is not data rollback.
  const narrow = await i.stage("0.9.0", { preferences: [1], manifest: [1] });
  expect(
    await i.worker({
      kind: "rollback",
      candidate: narrow.name,
      requiredSchemas: { preferences: [2], manifest: [1] },
    }),
  ).toEqual({
    kind: "error",
    code: "rollback-unavailable",
    context: { reason: "schema", version: "0.9.0" },
  });
  await untouched();
  // Staged bytes that are no longer the signed bytes are never selected.
  const executable = join(i.base, "versions", i.b.name, "lazurio");
  await chmod(executable, 0o700);
  await writeFile(executable, "tampered");
  expect(await i.worker()).toEqual({
    kind: "error",
    code: "artifact-invalid",
    context: { reason: "staged" },
  });
  await untouched();
  await rm(join(i.base, "bin"), { recursive: true });
  expect(await i.worker()).toMatchObject({ code: "not-installed" });
});

test("resumeActivation is free without a record, never touches a live worker's switch, and otherwise decides from the record alone", async () => {
  const i = await installation();
  // No record: nothing is created, not even the lock files.
  const nowhere = join(i.root, "absent-base");
  expect(await resumeActivation({ base: nowhere })).toEqual({ kind: "none" });
  await expect(stat(nowhere)).rejects.toThrow();
  expect(await resumeActivation({ base: i.base, effects: i.effects })).toEqual({
    kind: "none",
  });
  expect(await i.updateEntries()).toEqual([]);

  const record = (
    overrides: Partial<ActivationRecord> = {},
  ): ActivationRecord => ({
    schemaVersion: 1,
    operation: "op-1",
    kind: "update",
    previous: i.a.name,
    candidate: i.b.name,
    phase: "confirming",
    deadline: new Date(i.time() + 60_000).toISOString(),
    switchedAt: new Date(i.time()).toISOString(),
    service: systemd,
    folder: null,
    ...overrides,
  });
  const abandon = async (overrides: Partial<ActivationRecord> = {}) => {
    await swapSelector(i.base, i.b.name);
    await writeActivationRecord(i.base, record(overrides), writeDurableFile);
  };
  const resume = () =>
    resumeActivation({
      base: i.base,
      effects: i.effects,
      policy: { stabilityMs: 5_000, lockTimeoutMs: 200 },
    });

  // A live worker owns the record: whatever the record says, hands off.
  await abandon({ deadline: new Date(i.time() - 1).toISOString() });
  const worker = await acquireUpdateLock(layout(i.base).activationLock, {
    timeoutMs: 0,
  });
  expect(await resume()).toEqual({ kind: "in-progress" });
  expect(await readSelector(i.base)).toBe(i.b.name);
  expect((await readActivationRecord(i.base)).kind).toBe("record");
  await worker.release();
  // The same record without a worker: past its deadline, undone.
  expect(await resume()).toEqual({ kind: "rolled-back", previous: i.a.name });
  expect(await readSelector(i.base)).toBe(i.a.name);
  expect(i.restarts).toHaveLength(1);
  expect(await readObserved(i.base, new Date(i.time()))).toMatchObject({
    status: "error",
    error: {
      code: "activation-interrupted",
      context: {
        reason: "deadline",
        phase: "confirming",
        rolledBackTo: "1.0.0",
      },
    },
  });
  expect(await resume()).toEqual({ kind: "none" });

  // Within the deadline and not ready yet: left for a later start, untouched.
  await abandon();
  expect(await resume()).toEqual({ kind: "in-progress" });
  expect(await readSelector(i.base)).toBe(i.b.name);
  // A fresh instance that is younger than the stability period: still waiting.
  i.setReadiness(i.fresh(i.b.sha256));
  expect(await resume()).toEqual({ kind: "in-progress" });
  // …and once it has been up for the period, any start confirms it.
  const startedAt = new Date(i.time()).toISOString();
  i.setReadiness(() => ({ artifactSha256: i.b.sha256, pid: 4242, startedAt }));
  i.advance(5_000);
  expect(await resume()).toEqual({ kind: "confirmed", candidate: i.b.name });
  expect(await readPrevious(i.base)).toBe(i.a.name);
  expect((await readActivationRecord(i.base)).kind).toBe("absent");

  // `switching` was never acknowledged: always undone, wherever the selector is.
  for (const selector of [i.a.name, i.b.name]) {
    await abandon({ phase: "switching", switchedAt: null });
    await swapSelector(i.base, selector);
    expect(await resume()).toEqual({ kind: "rolled-back", previous: i.a.name });
    expect(await readSelector(i.base)).toBe(i.a.name);
  }
  // A candidate that is gone cannot be confirmed.
  const gone = await i.stage("1.5.0");
  await abandon({ candidate: gone.name });
  await rm(join(i.base, "versions", gone.name), { recursive: true });
  expect(await resume()).toEqual({ kind: "rolled-back", previous: i.a.name });
  // Nothing to go back to: the candidate is the only executable left.
  const only = await i.stage("1.6.0");
  await abandon({
    candidate: only.name,
    previous: versionName("0.1.0", "d".repeat(64)),
  });
  await swapSelector(i.base, only.name);
  expect(await resume()).toEqual({ kind: "confirmed", candidate: only.name });
  expect(await readSelector(i.base)).toBe(only.name);

  // A record nobody can read is removed; the selector is not guessed at.
  for (const damaged of [
    "{ not json",
    '{"schemaVersion":2}',
    JSON.stringify(record({ candidate: i.a.name })),
  ]) {
    await writeFile(join(i.base, "update", "activation.json"), damaged);
    expect(await resume()).toEqual({ kind: "discarded" });
    expect(await readSelector(i.base)).toBe(only.name);
    expect((await readActivationRecord(i.base)).kind).toBe("absent");
    expect(await readObserved(i.base, new Date(i.time()))).toMatchObject({
      error: { code: "activation-interrupted", context: { reason: "record" } },
    });
  }
});

test("a durable write that fails at any point of an activation never leaves a half state: the worker undoes it or a resume converges, and a second resume changes nothing", async () => {
  const counting = await installation();
  counting.setReadiness(counting.fresh(counting.b.sha256));
  let writes = 0;
  counting.effects = Object.assign(counting.effects, {
    write: async (...args: Parameters<typeof writeDurableFile>) => {
      writes += 1;
      await writeDurableFile(...args);
    },
  });
  expect(await counting.worker()).toMatchObject({ kind: "confirmed" });
  // record(switching), record(confirming), observed, previous, observed.
  expect(writes).toBe(5);
  for (let survive = 0; survive < writes; survive++) {
    const i = await installation();
    i.setReadiness(i.fresh(i.b.sha256));
    let done = 0;
    const dying = Object.assign({}, i.effects, {
      write: async (...args: Parameters<typeof writeDurableFile>) => {
        if (done >= survive) throw new Error("killed");
        done += 1;
        await writeDurableFile(...args);
      },
    });
    await runActivationWorker({
      base: i.base,
      candidate: i.b.name,
      operation: "op-1",
      kind: "update",
      service: systemd,
      policy: {
        deadlineMs: 60_000,
        stabilityMs: 5_000,
        pollMs: 1_000,
        lockTimeoutMs: 200,
      },
      effects: dying,
    }).catch(() => undefined);
    // The instance has been up long enough for a later start to judge it.
    const startedAt = new Date(i.time()).toISOString();
    i.setReadiness(() => ({
      artifactSha256: i.b.sha256,
      pid: 4242,
      startedAt,
    }));
    i.advance(10_000);
    const resume = () =>
      resumeActivation({
        base: i.base,
        effects: i.effects,
        policy: { stabilityMs: 5_000, lockTimeoutMs: 200 },
      });
    await resume();
    const selected = await readSelector(i.base);
    expect((await readActivationRecord(i.base)).kind).toBe("absent");
    // Never a half state: the selector names a complete version, and
    // `previous` exists exactly when the candidate was confirmed.
    expect([i.a.name, i.b.name]).toContain(selected as string);
    expect(await readPrevious(i.base)).toBe(
      selected === i.b.name ? i.a.name : null,
    );
    expect(await readlink(join(i.base, "bin", "lazurio"))).toBe(
      `../versions/${selected}/lazurio`,
    );
    expect(await resume()).toEqual({ kind: "none" });
    expect(await readSelector(i.base)).toBe(selected);
  }
});

test("the Launchpad announces its readiness with the digest of its own executable and withdraws only its own announcement", async () => {
  const i = await installation();
  const executable = join(i.base, "versions", i.b.name, "lazurio");
  const startedAt = new Date("2026-09-19T10:00:00.000Z");
  const announce = (pid: number, path = executable) =>
    announceLaunchpadReady({
      base: i.base,
      executable: path,
      pid,
      startedAt,
      write: writeDurableFile,
    });
  // A source run or a development binary is not what an activation waits for.
  expect(await announce(100, process.execPath)).toBeNull();
  expect(
    await announce(100, join(i.root, "versions", i.b.name, "lazurio")),
  ).toBeNull();
  expect(await readLaunchpadReadiness(i.base)).toBeNull();
  const withdraw = await announce(4242);
  expect(await readLaunchpadReadiness(i.base)).toEqual({
    artifactSha256: i.b.sha256,
    pid: 4242,
    startedAt: startedAt.toISOString(),
  });
  // A successor already announced itself: the old instance leaves it alone.
  const successor = await announce(4343);
  await withdraw?.();
  expect((await readLaunchpadReadiness(i.base))?.pid).toBe(4343);
  await successor?.();
  expect(await readLaunchpadReadiness(i.base)).toBeNull();
  for (const damaged of ["{", '{"schemaVersion":1,"pid":1}']) {
    await writeFile(
      join(i.base, "update", "launchpad-readiness.json"),
      damaged,
    );
    expect(await readLaunchpadReadiness(i.base)).toBeNull();
  }

  // The server itself: started from a source run it announces nothing and
  // still starts and closes normally.
  const folder = join(i.root, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  await rm(join(i.base, "update", "launchpad-readiness.json"));
  const app = await startLaunchpad(folder, undefined, undefined, {
    base: i.base,
    executable: process.execPath,
  });
  expect(await readLaunchpadReadiness(i.base)).toBeNull();
  expect(await app.close()).toEqual({ kind: "closed" });
});

test("self-check reads the named Folder state without writing, and a Folder it cannot read fails it", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "update-self-check-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  const identity = {
    version: "1.1.0",
    commit: "c".repeat(40),
    target: "linux-x64",
  };
  const snapshot = async () => {
    const entries: string[] = [];
    for (const name of (
      await readdir(join(folder, ".lazurio"), { recursive: true })
    ).sort()) {
      const info = await stat(join(folder, ".lazurio", name));
      entries.push(`${name}:${info.size}:${info.mtimeMs}:${info.ino}`);
    }
    return entries;
  };
  const before = await snapshot();
  const plain = await selfCheckCommand(["--json"], identity);
  expect(plain.code).toBe(0);
  expect(JSON.parse(plain.stdout)).toEqual({
    schemaVersion: 1,
    identity,
    updaterContract: 1,
    schemas: { preferences: [1], manifest: [1] },
    folder: null,
  });
  const withFolder = await selfCheckCommand(
    ["--json", "--folder", folder],
    identity,
  );
  expect(JSON.parse(withFolder.stdout).folder).toEqual({
    preferences: 1,
    manifest: 1,
  });
  expect((await selfCheckCommand(["--folder", folder], identity)).stdout).toBe(
    "lazurio 1.1.0 can start and read the Folder state.",
  );
  expect(await snapshot()).toEqual(before);
  // State of a schema this version does not know.
  const preferences = join(folder, ".lazurio", "preferences.json");
  await writeFile(
    preferences,
    JSON.stringify({
      ...JSON.parse(await readFile(preferences, "utf8")),
      schemaVersion: 2,
    }),
  );
  expect(
    await selfCheckCommand(["--json", "--folder", folder], identity),
  ).toEqual({
    code: updateErrors["self-check-failed"].exit,
    stdout: "",
    stderr: "Self-check failed: self-check-failed",
  });
  for (const args of [["--folder", "relative"], ["--unknown"], ["extra"]])
    expect((await selfCheckCommand(args, identity)).code).toBe(2);
});

test("the caller side of a self-check is bounded and compares the executable's own answer with the signed identity", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "update-self-check-")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const expected = {
    version: "1.1.0",
    sourceCommit: "c".repeat(40),
    target: "linux-x64",
  };
  const script = async (name: string, body: string) => {
    const path = join(root, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    return path;
  };
  const reason = async (executable: string, timeoutMs = 5_000) => {
    try {
      await requireSelfCheck({ executable, expected, timeoutMs });
      return "passed";
    } catch (error) {
      return (error as UpdateFailure).failure.context.reason;
    }
  };
  const report = (version: string) =>
    JSON.stringify({
      schemaVersion: 1,
      identity: {
        version,
        commit: expected.sourceCommit,
        target: expected.target,
      },
    });
  expect(await reason(await script("ok", `echo '${report("1.1.0")}'`))).toBe(
    "passed",
  );
  // Signed as 1.1.0 but the executable says otherwise.
  expect(await reason(await script("other", `echo '${report("1.0.9")}'`))).toBe(
    "identity-mismatch",
  );
  expect(await reason(await script("garbage", "echo hello"))).toBe("output");
  expect(await reason(await script("fails", "exit 3"))).toBe("exit");
  // The shell is killed; the `sleep` it started still holds the pipe.
  expect(await reason(await script("hangs", "sleep 5"), 200)).toBe("timeout");
  expect(await reason(join(root, "absent"))).toBe("not-executable");
  // Nothing of the caller's environment reaches a candidate.
  process.env.LAZURIO_TEST_LEAK = "leaked";
  try {
    const leak = await script("env", 'echo "[$LAZURIO_TEST_LEAK]"');
    expect(await runProcess([leak], 5_000)).toEqual({
      exitCode: 0,
      stdout: "[]\n",
    });
  } finally {
    delete process.env.LAZURIO_TEST_LEAK;
  }
});

test("a filesystem without flock is its own error, immediately, not a timeout reported as busy", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "update-lock-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "lock");
  const started = performance.now();
  const refused = await acquireUpdateLock(path, {
    timeoutMs: 30_000,
    tryLock: () => "unsupported",
  }).catch((error) => error);
  expect(refused).toBeInstanceOf(UpdateFailure);
  expect((refused as UpdateFailure).failure.code).toBe("lock-unsupported");
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(updateErrors["lock-unsupported"].retryable).toBe(false);
  // Contention is still `busy`, and the probe sees a holder without waiting.
  expect(await probeUpdateLock(path)).toBe("free");
  const held = await acquireUpdateLock(path, { timeoutMs: 0 });
  expect(await probeUpdateLock(path)).toBe("held");
  expect(
    (
      (await acquireUpdateLock(path, { timeoutMs: 50 }).catch(
        (error) => error,
      )) as UpdateFailure
    ).failure.code,
  ).toBe("busy");
  await held.release();
  expect(await probeUpdateLock(path)).toBe("free");
  expect(await probeUpdateLock(join(root, "absent"))).toBe("free");
  expect(await readdir(root)).toEqual(["lock"]);
});
