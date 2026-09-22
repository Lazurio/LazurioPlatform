import { afterAll, afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import {
  createUpdatePill,
  createUpdatePoller,
  derivePillStatus,
  type PillInput,
  type PillStatus,
} from "../src/launchpad/update-pill";
import { type UpdateError, updateError } from "../src/update/errors";
import {
  type Activation,
  type Activator,
  childActivator,
  systemdActivator,
  updateCommand,
} from "../src/update/launchpad-activation";
import { layout, setPrevious } from "../src/update/layout";
import type { ProcessResult, ProcessRunner } from "../src/update/self-check";
import type { CheckResult, UpdateStatus } from "../src/update/update";
import {
  closeSharedSigstore,
  createWorld,
  type World,
} from "./fixtures/update-world";

// The pill (docs/update.md "Surfaces") derives one state from what is on disk,
// what the poller last learned and the activation in flight; nothing here
// touches the network, and nothing activates without `apply`.

const now = new Date("2026-09-22T12:00:00.000Z");
const check = (latest: string, hoursAgo = 1) => ({
  checkedAt: new Date(now.getTime() - hoursAgo * 60 * 60_000).toISOString(),
  latest,
  notesUrl: `https://example.test/${latest}`,
});
const status = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  kind: "status",
  running: "1.0.0",
  active: "1.0.0",
  previous: null,
  highWater: null,
  supervised: true,
  pending: null,
  stateInvalid: null,
  lastCheck: null,
  updateAvailable: false,
  ...overrides,
});
const quiet: Activation = { inFlight: false, failure: null };
const derive = (input: Partial<PillInput> & { status: UpdateStatus }) =>
  derivePillStatus({
    checking: false,
    checkError: null,
    activation: quiet,
    now,
    ...input,
  });
const shape = (pill: PillStatus) => ({
  state: pill.state,
  action: pill.action,
  error: pill.error?.code ?? null,
  restartRequired: pill.restartRequired,
  stale: pill.stale,
});

test("every pill state and the single action for it", () => {
  const network = updateError("network-unavailable");
  const rows: [
    string,
    Partial<PillInput> & { status: UpdateStatus },
    ReturnType<typeof shape>,
  ][] = [
    [
      "never checked",
      { status: status() },
      {
        state: "idle",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "up to date",
      { status: status({ lastCheck: check("1.0.0") }) },
      {
        state: "idle",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "checking keeps what the last check knew",
      { status: status({ lastCheck: check("1.1.0") }), checking: true },
      {
        state: "checking",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "a failed check keeps the previous knowledge and shows the error",
      { status: status({ lastCheck: check("1.0.0") }), checkError: network },
      {
        state: "idle",
        action: null,
        error: "network-unavailable",
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "available",
      { status: status({ lastCheck: check("1.1.0") }) },
      {
        state: "available",
        action: "update",
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "available below the floor is not available",
      {
        status: status({
          highWater: "1.2.0",
          lastCheck: check("1.1.0"),
        }),
      },
      {
        state: "idle",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "the equal-high-water retry after a rollback is available",
      {
        status: status({
          highWater: "1.1.0",
          previous: "1.1.0",
          lastCheck: check("1.1.0"),
        }),
      },
      {
        state: "available",
        action: "update",
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "downloading: in flight, nothing switched",
      {
        status: status({ lastCheck: check("1.1.0") }),
        activation: { inFlight: true, failure: null },
      },
      {
        state: "downloading",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "activating: in flight, marker switched",
      {
        status: status({
          lastCheck: check("1.1.0"),
          active: "1.1.0",
          pending: { from: "1.0.0", to: "1.1.0" },
        }),
        activation: { inFlight: true, failure: null },
      },
      {
        state: "activating",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "activating: the new Launchpad is up and will commit",
      {
        status: status({
          running: "1.1.0",
          active: "1.1.0",
          lastCheck: check("1.1.0"),
          pending: { from: "1.0.0", to: "1.1.0" },
        }),
      },
      {
        state: "activating",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "interrupted after the switch: the same click reconciles and retries",
      {
        status: status({
          active: "1.1.0",
          lastCheck: check("1.1.0"),
          pending: { from: "1.0.0", to: "1.1.0" },
        }),
      },
      {
        state: "available",
        action: "retry",
        error: "activation-failed",
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "failed activation returns to available with the error and a retry",
      {
        status: status({ lastCheck: check("1.1.0") }),
        activation: {
          inFlight: false,
          failure: updateError("activation-failed", {
            from: "1.0.0",
            to: "1.1.0",
          }),
        },
      },
      {
        state: "available",
        action: "retry",
        error: "activation-failed",
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "an activation failure outranks a check failure",
      {
        status: status({ lastCheck: check("1.1.0") }),
        checkError: network,
        activation: { inFlight: false, failure: updateError("disk-full") },
      },
      {
        state: "available",
        action: "retry",
        error: "disk-full",
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "reinstall-required has no retry",
      {
        status: status({ lastCheck: check("1.1.0") }),
        checkError: updateError("reinstall-required"),
      },
      {
        state: "available",
        action: null,
        error: "reinstall-required",
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "unsupervised, switched: restart finishes the update",
      {
        status: status({
          supervised: false,
          active: "1.1.0",
          previous: "1.0.0",
          highWater: "1.1.0",
          lastCheck: check("1.1.0"),
        }),
      },
      {
        state: "activating",
        action: "restart",
        error: null,
        restartRequired: true,
        stale: false,
      },
    ],
    [
      "unsupervised, child running before the switch",
      {
        status: status({ supervised: false, lastCheck: check("1.1.0") }),
        activation: { inFlight: true, failure: null },
      },
      {
        state: "downloading",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "state-invalid: shown, no action, whatever the last check said",
      {
        status: status({
          stateInvalid: "update/pending.json",
          lastCheck: check("1.1.0"),
        }),
      },
      {
        state: "idle",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
    [
      "older than 24 h is stale in whatever state",
      { status: status({ lastCheck: check("1.1.0", 25) }) },
      {
        state: "available",
        action: "update",
        error: null,
        restartRequired: false,
        stale: true,
      },
    ],
    [
      "exactly 24 h is not yet stale",
      { status: status({ lastCheck: check("1.0.0", 24) }) },
      {
        state: "idle",
        action: null,
        error: null,
        restartRequired: false,
        stale: false,
      },
    ],
  ];
  for (const [name, input, expected] of rows)
    expect([name, shape(derive(input))]).toEqual([name, expected]);
  const shown = derive({ status: status({ lastCheck: check("1.1.0") }) });
  expect(shown).toMatchObject({
    kind: "update-pill",
    running: "1.0.0",
    active: "1.0.0",
    latest: "1.1.0",
    notesUrl: "https://example.test/1.1.0",
    checkedAt: check("1.1.0").checkedAt,
    supervised: true,
    stateInvalid: null,
  });
  expect(
    derive({ status: status({ stateInvalid: "update/high-water" }) })
      .stateInvalid,
  ).toBe("update/high-water");
});

/** Fake timers: callbacks run when the test advances the clock. */
function fakeTimers() {
  const pending: { at: number; callback: () => void; id: number }[] = [];
  let clock = 0;
  let next = 1;
  return {
    delays: [] as number[],
    setTimeout(callback: () => void, ms: number) {
      const id = next++;
      this.delays.push(ms);
      pending.push({ at: clock + ms, callback, id });
      return id;
    },
    clearTimeout(id: unknown) {
      const index = pending.findIndex((entry) => entry.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    async advance(ms: number) {
      clock += ms;
      for (;;) {
        const due = pending.filter((entry) => entry.at <= clock);
        if (due.length === 0) break;
        for (const entry of due) {
          pending.splice(pending.indexOf(entry), 1);
          entry.callback();
        }
        // Let the check and its scheduling settle.
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
    },
    get scheduled() {
      return pending.length;
    },
  };
}

test("the poller: startup delay, interval with bounded jitter, no overlap, failures keep the last knowledge", async () => {
  const timers = fakeTimers();
  const results: CheckResult[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const poller = createUpdatePoller(
    () =>
      new Promise<CheckResult>((resolve) => {
        calls++;
        release = () =>
          resolve(
            results.shift() ??
              Object.freeze({
                kind: "up-to-date" as const,
                running: "1.0.0",
                latest: "1.0.0",
                notesUrl: "",
              }),
          );
      }),
    {
      startupDelayMs: 30_000,
      intervalMs: 600_000,
      jitterMs: 60_000,
      random: () => 1,
      setTimeout: timers.setTimeout.bind(timers),
      clearTimeout: timers.clearTimeout.bind(timers),
    },
  );
  poller.start();
  poller.start();
  expect(timers.delays).toEqual([30_000]);
  await timers.advance(29_999);
  expect(calls).toBe(0);
  await timers.advance(1);
  expect([calls, poller.checking]).toEqual([1, true]);
  // Two ticks or a click during a check never start a second one.
  const clicked = poller.checkNow();
  expect(calls).toBe(1);
  release?.();
  await clicked;
  await timers.advance(0);
  expect([poller.checking, poller.error]).toEqual([false, null]);
  // The next tick is the interval plus the whole jitter (random() = 1).
  expect(timers.delays).toEqual([30_000, 660_000]);
  results.push(
    Object.freeze({
      kind: "error" as const,
      ...updateError("network-unavailable"),
    }),
  );
  await timers.advance(660_000);
  expect(calls).toBe(2);
  release?.();
  await Bun.sleep(0);
  expect(poller.error).toEqual(updateError("network-unavailable"));
  expect(timers.delays).toHaveLength(3);
  // The next verified check clears the error.
  await timers.advance(660_000);
  release?.();
  await Bun.sleep(0);
  expect(poller.error).toBeNull();
  poller.stop();
  expect(timers.scheduled).toBe(0);
  // A thrown check is a failure, not a crash of the Launchpad.
  const throwing = createUpdatePoller(() => Promise.reject(new Error("x")), {
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
  });
  expect((await throwing.checkNow()).kind).toBe("error");
  expect(throwing.error?.code).toBe("internal");
});

test("the poller's jitter stays within its bounds", async () => {
  for (const random of [0, 0.25, 0.5, 0.75, 1]) {
    const timers = fakeTimers();
    const poller = createUpdatePoller(
      async () =>
        Object.freeze({
          kind: "up-to-date" as const,
          running: "1.0.0",
          latest: "1.0.0",
          notesUrl: "",
        }),
      {
        startupDelayMs: 1,
        intervalMs: 1000,
        jitterMs: 100,
        random: () => random,
        setTimeout: timers.setTimeout.bind(timers),
        clearTimeout: timers.clearTimeout.bind(timers),
      },
    );
    poller.start();
    await timers.advance(1);
    await Bun.sleep(0);
    poller.stop();
    const [, interval] = timers.delays;
    expect(interval).toBe(1000 + Math.round((random * 2 - 1) * 100));
  }
});

/** A service manager stand-in answering `systemctl show`, `systemd-run`,
 * `reset-failed` and `journalctl` from a scripted unit state.
 */
function fakeManager(initial: {
  active: string;
  load?: string;
  journal?: string;
}) {
  const state = { load: "loaded", journal: "", ...initial };
  const commands: string[][] = [];
  const run: ProcessRunner = async (command) => {
    commands.push([...command]);
    const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout });
    if (command[0] === "systemctl" && command[2] === "show")
      return ok(
        `LoadState=${state.load}\nActiveState=${state.active}\nInvocationID=${"ab".repeat(16)}\n`,
      );
    if (command[0] === "systemctl" && command[2] === "reset-failed") {
      state.active = "inactive";
      state.load = "not-found";
      return ok();
    }
    if (command[0] === "systemd-run") {
      state.active = "active";
      state.load = "loaded";
      return ok();
    }
    if (command[0] === "journalctl") return ok(state.journal);
    return { exitCode: 1, stdout: "" };
  };
  return { state, commands, run };
}

test("supervised: the action is exactly systemd-run of the selector, and the pill follows the unit", async () => {
  const manager = fakeManager({ active: "inactive", load: "not-found" });
  const env = { HOME: "/home/x", PATH: "/usr/bin", SECRET: "no" };
  const activator = systemdActivator({ base: "/base", env, run: manager.run });
  expect(await activator.observe()).toEqual({ inFlight: false, failure: null });
  await activator.start("1.1.0");
  expect(manager.commands.at(-1)).toEqual([
    "systemd-run",
    "--user",
    "--unit",
    "lazurio-update",
    "--quiet",
    "--no-ask-password",
    "--",
    "/base/bin/lazurio",
    "update",
    "--version",
    "v1.1.0",
    "--json",
    "--base",
    "/base",
  ]);
  expect(updateCommand("/base", "1.1.0")).toEqual([
    "/base/bin/lazurio",
    "update",
    "--version",
    "v1.1.0",
    "--json",
    "--base",
    "/base",
  ]);
  // Running: in flight, and a second start is refused without touching the manager.
  expect(await activator.observe()).toEqual({ inFlight: true, failure: null });
  const before = manager.commands.length;
  await expect(activator.start("1.1.0")).rejects.toThrow("busy");
  expect(manager.commands.slice(before).map((c) => c[0])).toEqual([
    "systemctl",
  ]);
  // Failed: the code comes from that invocation's journal, read once.
  manager.state.active = "failed";
  manager.state.journal = `noise\n${JSON.stringify({
    kind: "error",
    code: "attestation-invalid",
    context: { resource: "bundle", nested: { no: 1 } },
  })}\n`;
  const failed = await activator.observe();
  expect(failed).toEqual({
    inFlight: false,
    failure: updateError("attestation-invalid", { resource: "bundle" }),
  });
  const reads = manager.commands.filter((c) => c[0] === "journalctl").length;
  await activator.observe();
  expect(manager.commands.filter((c) => c[0] === "journalctl")).toHaveLength(
    reads,
  );
  expect(manager.commands.find((c) => c[0] === "journalctl")).toEqual([
    "journalctl",
    "--user",
    "--unit",
    "lazurio-update.service",
    "--output",
    "cat",
    "--no-pager",
    "--lines",
    "50",
    `_SYSTEMD_INVOCATION_ID=${"ab".repeat(16)}`,
  ]);
  // The next start clears the failed record first, so the name is free.
  await activator.start("1.1.0");
  expect(manager.commands.slice(-2).map((c) => [c[0], c[2] ?? c[1]])).toEqual([
    ["systemctl", "reset-failed"],
    ["systemd-run", "--unit"],
  ]);
  // A run that died before its answer: nothing more precise than internal.
  const silent = fakeManager({ active: "failed", journal: "no json here\n" });
  expect(
    (await systemdActivator({ base: "/b", env, run: silent.run }).observe())
      .failure?.code,
  ).toBe("internal");
  // A manager that cannot start it: a typed failure, never a throw.
  const broken = systemdActivator({
    base: "/b",
    env,
    run: async (command) =>
      command[0] === "systemd-run"
        ? { exitCode: 1, stdout: "" }
        : {
            exitCode: 0,
            stdout: "LoadState=not-found\nActiveState=inactive\n",
          },
  });
  await expect(broken.start("1.1.0")).rejects.toMatchObject({
    failure: { code: "internal", context: { stage: "systemd-run" } },
  });
});

test("unsupervised: the same command as a child; its --json answer is the error, disk is the success", async () => {
  let resolveChild: ((result: ProcessResult) => void) | undefined;
  const commands: string[][] = [];
  const run: ProcessRunner = (command) => {
    commands.push([...command]);
    return new Promise((resolve) => {
      resolveChild = resolve;
    });
  };
  const activator = childActivator({ base: "/base", env: {}, run });
  await activator.start("1.1.0");
  expect(commands).toEqual([[...updateCommand("/base", "1.1.0")]]);
  expect(await activator.observe()).toEqual({ inFlight: true, failure: null });
  await expect(activator.start("1.1.0")).rejects.toThrow("busy");
  resolveChild?.({
    exitCode: 1,
    stdout: JSON.stringify({
      kind: "error",
      code: "network-unavailable",
      context: { stage: "artifact" },
    }),
  });
  await Bun.sleep(0);
  expect(await activator.observe()).toEqual({
    inFlight: false,
    failure: updateError("network-unavailable", { stage: "artifact" }),
  });
  // Success leaves no failure; the switch shows on disk, not here.
  await activator.start("1.1.0");
  resolveChild?.({ exitCode: 0, stdout: '{"kind":"updated"}' });
  await Bun.sleep(0);
  expect(await activator.observe()).toEqual({ inFlight: false, failure: null });
  for (const [answer, expected] of [
    [
      { exitCode: 1, stdout: "garbage" },
      { stage: "child", exitCode: 1 },
    ],
    [
      { exitCode: 1, stdout: '{"kind":"error","code":"made-up"}' },
      { stage: "child", exitCode: 1 },
    ],
    ["timeout", { stage: "timeout" }],
  ] as const) {
    await activator.start("1.1.0");
    resolveChild?.(answer);
    await Bun.sleep(0);
    expect((await activator.observe()).failure).toEqual(
      updateError("internal", expected),
    );
  }
});

let world: World;
afterEach(async () => world?.close());
afterAll(closeSharedSigstore);

/** An activator that records starts and answers a scripted observation. */
function fakeActivator(): Activator & {
  starts: string[];
  activation: { inFlight: boolean; failure: UpdateError | null };
} {
  const fake = {
    starts: [] as string[],
    activation: { inFlight: false, failure: null as UpdateError | null },
    async start(version: string) {
      fake.starts.push(version);
      fake.activation.inFlight = true;
    },
    async observe() {
      return { ...fake.activation };
    },
  };
  return fake;
}

test("the pill runs the one check use case and applies only what it showed", async () => {
  world = await createWorld();
  await world.release("1.1.0");
  const activator = fakeActivator();
  const pill = createUpdatePill({
    environment: world.environment("1.0.0"),
    activator,
    // Not started: every check here is explicit.
    now: () => now,
  });
  // A stale click starts a check in the background; wait for it to settle.
  const settled = async () => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = await pill.status();
      if (current.state !== "checking") return current;
      await Bun.sleep(10);
    }
    throw new Error("Check did not settle");
  };
  // Before any check: idle, nothing known, no network touched.
  expect(await pill.status()).toMatchObject({
    state: "idle",
    latest: null,
    checkedAt: null,
    action: null,
  });
  expect(world.origin.requests).toEqual([]);
  // A click for a version no check verified is refused and triggers a check.
  expect(await pill.apply("1.1.0")).toEqual({
    kind: "stale",
    version: "1.1.0",
    latest: null,
  });
  // The third request is the artifact of the check; the check settles a moment
  // after it (verification, last-check.json), so wait for the status, not the
  // request count.
  expect(activator.starts).toEqual([]);
  expect(await settled()).toMatchObject({
    state: "available",
    latest: "1.1.0",
    action: "update",
    notesUrl: "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.1.0",
  });
  const requests = world.origin.requests.length;
  // Status never touches the network.
  await pill.status();
  expect(world.origin.requests).toHaveLength(requests);
  expect(await pill.apply("1.0.0")).toMatchObject({ kind: "stale" });
  await settled();
  expect(await pill.apply("not a version")).toMatchObject({
    kind: "error",
    code: "internal",
  });
  expect(await pill.apply("1.1.0")).toEqual({
    kind: "started",
    version: "1.1.0",
  });
  expect(activator.starts).toEqual(["1.1.0"]);
  expect((await pill.status()).state).toBe("downloading");
  // One at a time.
  expect(await pill.apply("1.1.0")).toMatchObject({
    kind: "error",
    code: "busy",
  });
  expect(activator.starts).toEqual(["1.1.0"]);
  activator.activation = {
    inFlight: false,
    failure: updateError("activation-failed", { from: "1.0.0", to: "1.1.0" }),
  };
  expect(await pill.status()).toMatchObject({
    state: "available",
    action: "retry",
    error: { code: "activation-failed" },
  });
  // The retry is the same click.
  expect(await pill.apply("1.1.0")).toEqual({
    kind: "started",
    version: "1.1.0",
  });
  // State a person must look at: shown with its path, and no click starts anything.
  activator.activation = { inFlight: false, failure: null };
  await setPrevious(world.base, "0.9.0");
  await writeFile(layout(world.base).pending, "garbage");
  expect(await pill.status()).toMatchObject({
    state: "idle",
    action: null,
    stateInvalid: "update/pending.json",
  });
  expect(await pill.apply("1.1.0")).toMatchObject({
    kind: "error",
    code: "state-invalid",
    context: { path: "update/pending.json" },
  });
  expect(activator.starts).toEqual(["1.1.0", "1.1.0"]);
});
