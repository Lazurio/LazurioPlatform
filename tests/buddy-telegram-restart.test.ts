import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ActiveWork } from "../src/buddy/gateway-refresh";
import { writeBuddyStateFile } from "../src/buddy/gateway-refresh";
import { applyLockPath } from "../src/buddy/persona-apply";
import {
  createTelegramRestart,
  markTelegramChanged,
  type TelegramFollowUp,
  type TelegramRestartJournalEntry,
  telegramChangedPath,
  telegramRestartRetryMs,
  telegramRestartSpacingMs,
  telegramUncertainPath,
} from "../src/buddy/telegram-restart";
import { acquireFileLock } from "../src/platform/flock";
import type { ToolRunner } from "../src/tools/status";

// Decision F66: a change of Buddy's Telegram owes one restart of his
// gateway, F64's: derived from his gateway's start against the Platform's
// own record of the change, only while Hermes's `active-work` says he is
// idle, under F64's apply turn, never on units systemd failed to reread, and
// never twice within two minutes (Telegram's flood limit after quick
// reconnects). systemctl and the clock are the test's; the record is a real
// file.

const posix = test.skipIf(process.platform === "win32");

/** `us+utc`, as systemd 255 prints a timestamp. */
function usUtc(microseconds: bigint): string {
  const date = new Date(Number(microseconds / 1000n));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    date.getUTCDay()
  ];
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${day} ${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(Number(microseconds % 1_000_000n), 6)} UTC`;
}

type World = {
  systemd: boolean;
  /** `stopping`: systemd stops it, and its process may still run. */
  unit: "running" | "stopping" | "stopped" | "absent";
  /** The gateway's main process start, in ms since the epoch. */
  startedAt: number;
  needsReload: boolean;
  reload: boolean;
  restartWorks: boolean;
  work: ActiveWork;
  calls: string[][];
  /** The clock's offset from the real one. */
  offset: number;
  /** Runs once the gateway has restarted, within the attempt: a write in
   * the middle of it. */
  onRestart?: (() => void) | undefined;
  /** How far the clock moves while the gateway restarts (ms). */
  restartTakes: number;
  /** What the core's follow-up answers, in order; "done" after them. */
  followUps: ("done" | "again")[];
  /** Why the follow-up was asked, and when (ms of the test's clock). */
  followed: { why: TelegramFollowUp; at: number }[];
};

type Timer = { at: number; callback: () => void; done: boolean };

async function within(
  body: (fixture: {
    home: string;
    world: World;
    restart: ReturnType<typeof createTelegramRestart>;
    journal: TelegramRestartJournalEntry[];
    /** Runs every timer due by now + `ms`, in order. */
    advance: (ms: number) => Promise<void>;
    restarts: () => number;
  }) => Promise<void>,
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "tg-restart-")));
  await mkdir(join(home, ".hermes"), { mode: 0o700 });
  const world: World = {
    systemd: true,
    unit: "running",
    startedAt: Date.now() - 3_600_000,
    needsReload: false,
    reload: true,
    restartWorks: true,
    work: "idle",
    calls: [],
    offset: 0,
    followUps: [],
    followed: [],
    restartTakes: 0,
  };
  const now = () => Date.now() + world.offset;
  const run: ToolRunner = async (command) => {
    world.calls.push([...command]);
    if (!world.systemd) throw new Error("spawn systemctl ENOENT");
    const [program, , verb] = command;
    if (program !== "systemctl")
      return { exitCode: 127, stdout: "", stderr: "" };
    if (verb === "show") {
      if (world.unit === "absent")
        return {
          exitCode: 0,
          stdout: "LoadState=not-found\nActiveState=inactive\n",
          stderr: "",
        };
      // A main process, while it runs or systemd stops it.
      const main = world.unit === "running" || world.unit === "stopping";
      return {
        exitCode: 0,
        stdout: [
          "LoadState=loaded",
          `ActiveState=${{ running: "active", stopping: "deactivating", stopped: "inactive" }[world.unit]}`,
          `ExecMainStartTimestamp=${main ? usUtc(BigInt(world.startedAt) * 1000n) : ""}`,
          `NeedDaemonReload=${world.needsReload ? "yes" : "no"}`,
        ].join("\n"),
        stderr: "",
      };
    }
    if (verb === "daemon-reload") {
      if (world.reload) world.needsReload = false;
      return { exitCode: world.reload ? 0 : 1, stdout: "", stderr: "" };
    }
    if (verb === "restart") {
      if (!world.restartWorks) return { exitCode: 1, stdout: "", stderr: "" };
      // Its new main process starts after everything written so far.
      world.startedAt = now() + 1;
      world.offset += world.restartTakes;
      world.onRestart?.();
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const timers: Timer[] = [];
  const journal: TelegramRestartJournalEntry[] = [];
  const restart = createTelegramRestart({
    home,
    service: { run, env: { HOME: home } },
    activeWork: async () => world.work,
    cleared: async (why) => {
      world.followed.push({ why, at: now() });
      return world.followUps.shift() ?? "done";
    },
    now,
    journal: (entry) => journal.push(entry),
    timers: {
      after: (callback, ms) => {
        const timer = { at: now() + ms, callback, done: false };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        if (timer !== undefined) (timer as Timer).done = true;
      },
    },
  });
  const advance = async (ms: number) => {
    world.offset += ms;
    for (;;) {
      const due = timers
        .filter((timer) => !timer.done && timer.at <= now())
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.done = true;
      due.callback();
      // Let the attempt it started finish.
      for (let turn = 0; turn < 50; turn += 1) await Bun.sleep(1);
    }
  };
  try {
    await body({
      home,
      world,
      restart,
      journal,
      advance,
      restarts: () =>
        world.calls.filter((call) => call[2] === "restart").length,
    });
  } finally {
    restart.close();
    await rm(home, { recursive: true, force: true });
  }
}

/** A change recorded, then the attempt it asked for. */
async function change(restart: ReturnType<typeof createTelegramRestart>) {
  expect(await restart.changed()).toBe("recorded");
  return restart.settled();
}

posix(
  "a change while Buddy is idle restarts his gateway once, after recording it; nothing is owed after",
  () =>
    within(async ({ home, world, restart, restarts, journal }) => {
      expect(await change(restart)).toEqual({ state: "done" });
      expect(restarts()).toBe(1);
      expect(restart.owed()).toBe(false);
      // The record is the Platform's own, 0600 in Buddy's 0700 directory.
      const record = await lstat(telegramChangedPath(home));
      expect(record.mode & 0o777).toBe(0o600);
      expect(
        (await lstat(dirname(telegramChangedPath(home)))).mode & 0o777,
      ).toBe(0o700);
      // The restart is systemd's, the user manager's own.
      expect(world.calls.find((call) => call[2] === "restart")).toEqual([
        "systemctl",
        "--user",
        "restart",
        "hermes-gateway.service",
      ]);
      // The Launchpad starts again: the gateway started after the change,
      // nothing is owed.
      await restart.start();
      expect(restarts()).toBe(1);
      expect(journal.map((entry) => entry.outcome)).toEqual(["done", "none"]);
    }),
);

posix(
  "busy: no restart until Hermes says he is idle, asked again every 15 seconds; two changes meanwhile need one restart",
  () =>
    within(async ({ world, restart, restarts, advance }) => {
      world.work = "busy";
      expect(await change(restart)).toEqual({
        state: "pending",
        reason: "busy",
      });
      expect(restart.owed()).toBe(true);
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(0);
      // A second Připojit, or an Odpojit, while it waits: the same restart.
      expect(await change(restart)).toEqual({
        state: "pending",
        reason: "busy",
      });
      // No answer counts as busy.
      world.work = "unknown";
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(0);
      world.work = "idle";
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(1);
      expect(restart.owed()).toBe(false);
      await advance(10 * telegramRestartRetryMs);
      expect(restarts()).toBe(1);
    }),
);

posix(
  "never twice within two minutes: a change soon after any start waits for the spacing, then restarts once",
  () =>
    within(async ({ world, restart, restarts, advance }) => {
      expect(await change(restart)).toEqual({ state: "done" });
      expect(restarts()).toBe(1);
      // Connected, then Odpojit at once: the gateway started a moment ago.
      await advance(5_000);
      expect(await change(restart)).toEqual({
        state: "pending",
        reason: "spacing",
      });
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(1);
      // And Připojit again before the spacing ended: still one restart.
      expect(await change(restart)).toEqual({
        state: "pending",
        reason: "spacing",
      });
      await advance(telegramRestartSpacingMs);
      expect(restarts()).toBe(2);
      expect(restart.owed()).toBe(false);
      // A start by anyone counts: systemd after a crash a moment ago.
      world.startedAt = Date.now() + world.offset;
      await advance(1_000);
      expect(await change(restart)).toEqual({
        state: "pending",
        reason: "spacing",
      });
    }),
);

posix(
  "a start by anyone after the change settles it; a stopped gateway reads the files when it starts; a gateway with no unit owes nothing",
  () =>
    within(async ({ home, world, restart, restarts }) => {
      await markTelegramChanged(home);
      // F64's apply, the installer or systemd restarted it since.
      world.startedAt = Date.now() + 5_000;
      await restart.start();
      expect(restarts()).toBe(0);
      expect(restart.owed()).toBe(false);
      world.unit = "stopped";
      expect(await change(restart)).toEqual({ state: "none" });
      world.unit = "absent";
      expect(await change(restart)).toEqual({ state: "unavailable" });
      expect(restarts()).toBe(0);
      expect(restart.owed()).toBe(false);
    }),
);

posix(
  "systemd not answering keeps the restart owed, asked again later and later and at most every 15 minutes; once it answers, the idle and spacing rules still hold",
  () =>
    within(async ({ world, restart, restarts, advance, journal }) => {
      const shows = () =>
        world.calls.filter((call) => call[2] === "show").length;
      world.systemd = false;
      expect(await change(restart)).toEqual({ state: "unanswered" });
      expect(restart.owed()).toBe(true);
      expect(shows()).toBe(1);
      // 30 s, then twice as long each time.
      await advance(29_000);
      expect(shows()).toBe(1);
      for (const [wait, count] of [
        [1_000, 2],
        [60_000, 3],
        [120_000, 4],
        [240_000, 5],
        [480_000, 6],
        // At most every 15 minutes.
        [900_000, 7],
        [899_000, 7],
        [1_000, 8],
      ] as const) {
        await advance(wait);
        expect({ wait, count: shows() }).toEqual({ wait, count });
      }
      expect(restart.owed()).toBe(true);
      // It answers, but Buddy works: no restart until he is idle.
      world.systemd = true;
      world.work = "busy";
      await advance(900_000);
      expect(restarts()).toBe(0);
      expect(restart.owed()).toBe(true);
      world.work = "idle";
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(1);
      expect(restart.owed()).toBe(false);
      expect(journal.map((entry) => entry.outcome)).toEqual([
        "unanswered",
        "pending",
        "done",
      ]);
      // A gateway started a moment ago, then a change while systemd does not
      // answer: once it does, the restart still waits for the spacing.
      await advance(telegramRestartSpacingMs);
      world.startedAt = Date.now() + world.offset - 10_000;
      world.systemd = false;
      await advance(1);
      expect(await change(restart)).toEqual({ state: "unanswered" });
      world.systemd = true;
      await advance(30_000);
      expect(restarts()).toBe(1);
      expect(journal.at(-1)).toEqual({
        operation: "restart",
        outcome: "pending",
        reason: "spacing",
      });
      await advance(telegramRestartSpacingMs);
      expect(restarts()).toBe(2);
      expect(restart.owed()).toBe(false);
    }),
);

posix("the Launchpad's start takes up a change it did not see restarted", () =>
  within(async ({ home, restart, restarts }) => {
    // Recorded by the Launchpad before it restarted (an update).
    await markTelegramChanged(home);
    await restart.start();
    expect(restarts()).toBe(1);
  }),
);

posix(
  "never beside F64's apply, and never on units systemd failed to reread",
  () =>
    within(async ({ home, world, restart, restarts, advance }) => {
      const lockPath = applyLockPath(home);
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
      const apply = await acquireFileLock(lockPath, { timeoutMs: 1_000 });
      try {
        expect(await change(restart)).toEqual({
          state: "pending",
          reason: "turn",
        });
        expect(restarts()).toBe(0);
      } finally {
        await apply.release();
      }
      // Units changed on disk: reread first, then the restart.
      world.needsReload = true;
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(1);
      const verbs = world.calls
        .filter((call) => call[0] === "systemctl")
        .map((call) => call[2]);
      expect(verbs.indexOf("daemon-reload")).toBeLessThan(
        verbs.indexOf("restart"),
      );
      // A reload systemd refuses: no restart, retried later.
      await advance(telegramRestartSpacingMs);
      world.needsReload = true;
      world.reload = false;
      expect(await change(restart)).toEqual({ state: "failed" });
      expect(restarts()).toBe(1);
      expect(restart.owed()).toBe(true);
    }),
);

posix(
  "a restart systemd refuses is asked again later and later, until it works",
  () =>
    within(async ({ world, restart, restarts, advance, journal }) => {
      world.restartWorks = false;
      expect(await change(restart)).toEqual({ state: "failed" });
      await advance(30_000);
      await advance(60_000);
      const attempts = world.calls.filter((call) => call[2] === "restart");
      expect(attempts).toHaveLength(3);
      world.restartWorks = true;
      await advance(120_000);
      // Three refused, then the one that worked; none after.
      expect(restarts()).toBe(4);
      expect(restart.owed()).toBe(false);
      await advance(15 * 60_000);
      expect(restarts()).toBe(4);
      // A line only when the outcome changes.
      expect(journal.map((entry) => entry.outcome)).toEqual(["failed", "done"]);
    }),
);

// ---- A write in doubt (F66 point 13) -----------------------------------------

posix(
  "a write in doubt holds the barrier until the restart: blocked, kept on disk, lifted by the restart, and what waited asked once",
  () =>
    within(async ({ home, world, restart, restarts }) => {
      expect(await restart.blocked()).toBe(false);
      expect(await restart.uncertain()).toBe("recorded");
      expect(await restart.blocked()).toBe(true);
      expect(restart.owed()).toBe(true);
      expect((await lstat(telegramUncertainPath(home))).mode & 0o777).toBe(
        0o600,
      );
      expect(await restart.settled()).toEqual({ state: "done" });
      expect(restarts()).toBe(1);
      expect(await restart.blocked()).toBe(false);
      expect(restart.owed()).toBe(false);
      for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1);
      await expect(lstat(telegramUncertainPath(home))).rejects.toThrow();
      expect(world.followed.map((entry) => entry.why)).toEqual(["lifted"]);
    }),
);

posix(
  "a write in doubt during an attempt is not lifted by it: the attempt that write asked for decides, after the spacing",
  () =>
    within(async ({ world, restart, restarts, advance }) => {
      // A change asks an attempt; a write ends in doubt as its restart is
      // made, so it may have reached the new gateway.
      world.restartTakes = 5;
      world.onRestart = () => {
        world.onRestart = undefined;
        void restart.uncertain();
      };
      expect(await restart.changed()).toBe("recorded");
      await restart.settled();
      for (let turn = 0; turn < 50; turn += 1) await Bun.sleep(1);
      expect(restarts()).toBe(1);
      // That restart may have started before the write: still held.
      expect(await restart.blocked()).toBe(true);
      expect(restart.owed()).toBe(true);
      expect(world.followed).toEqual([]);
      await advance(telegramRestartSpacingMs);
      expect(restarts()).toBe(2);
      expect(await restart.blocked()).toBe(false);
      expect(restart.owed()).toBe(false);
      expect(world.followed.map((entry) => entry.why)).toEqual(["lifted"]);
    }),
);

posix(
  "what waited is asked again later and later while it answers again (his gateway not ready yet)",
  () =>
    within(async ({ world, restart, advance }) => {
      world.followUps = ["again", "again"];
      await restart.uncertain();
      await restart.settled();
      for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1);
      expect(world.followed).toHaveLength(1);
      // After 15 s, then 30 s after that; done then. (The fixture's clock
      // moves with real time too: each step keeps a margin.)
      await advance(telegramRestartRetryMs / 2);
      expect(world.followed).toHaveLength(1);
      await advance(telegramRestartRetryMs);
      expect(world.followed).toHaveLength(2);
      await advance(telegramRestartRetryMs);
      expect(world.followed).toHaveLength(2);
      await advance(2 * telegramRestartRetryMs);
      expect(world.followed).toHaveLength(3);
      await advance(15 * 60_000);
      expect(world.followed).toHaveLength(3);
    }),
);

posix(
  "a Launchpad that starts finds the barrier on disk: blocked before anything is asked, lifted by its first restart",
  () =>
    within(async ({ home, world, restart, restarts }) => {
      // Left by the Launchpad before this one: the write's own record, and
      // no change's.
      await writeBuddyStateFile(telegramUncertainPath(home), {
        schema_version: "lazurio.buddy-telegram-uncertain.v1",
      });
      expect(await restart.blocked()).toBe(true);
      await restart.start();
      expect(restarts()).toBe(1);
      expect(await restart.blocked()).toBe(false);
      for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1);
      expect(world.followed.map((entry) => entry.why)).toEqual(["lifted"]);
    }),
);

posix(
  "a Launchpad that starts without a barrier asks what waited once (a disconnect kept across it)",
  () =>
    within(async ({ world, restart }) => {
      await restart.start();
      for (let turn = 0; turn < 20; turn += 1) await Bun.sleep(1);
      expect(world.followed.map((entry) => entry.why)).toEqual(["start"]);
    }),
);

posix(
  "a gateway systemd is still stopping may still run the write: asked again, and the barrier lifts once it has stopped",
  () =>
    within(async ({ world, restart, restarts, advance, journal }) => {
      world.unit = "stopping";
      expect(await restart.uncertain()).toBe("recorded");
      expect(await restart.settled()).toEqual({
        state: "pending",
        reason: "stopping",
      });
      expect(await restart.blocked()).toBe(true);
      expect(restart.owed()).toBe(true);
      // Stopped: the process that took the write is gone, and whoever
      // starts the gateway reads the files then.
      world.unit = "stopped";
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(0);
      expect(await restart.blocked()).toBe(false);
      expect(world.followed.map((entry) => entry.why)).toEqual(["lifted"]);
      expect(journal.map((entry) => entry.outcome)).toEqual([
        "pending",
        "none",
      ]);
    }),
);

posix(
  "repeated: each write in doubt raises the barrier again and each lift asks once; a gateway someone else started after the write's record lifts it with no restart of ours",
  () =>
    within(async ({ world, restart, restarts, advance }) => {
      await restart.uncertain();
      expect(await restart.settled()).toEqual({ state: "done" });
      expect(await restart.blocked()).toBe(false);
      // A second one, a write's timeout later, within the spacing: its
      // restart waits for the spacing.
      await advance(5_000);
      await restart.uncertain();
      expect(await restart.settled()).toEqual({
        state: "pending",
        reason: "spacing",
      });
      expect(await restart.blocked()).toBe(true);
      // F64's apply restarts the gateway meanwhile, after the record.
      await advance(1_000);
      world.startedAt = Date.now() + world.offset;
      await advance(telegramRestartRetryMs);
      expect(restarts()).toBe(1);
      expect(await restart.blocked()).toBe(false);
      // A third: its own restart after the spacing, its own lift.
      await advance(5_000);
      await restart.uncertain();
      expect(await restart.settled()).toEqual({
        state: "pending",
        reason: "spacing",
      });
      expect(await restart.blocked()).toBe(true);
      await advance(telegramRestartSpacingMs);
      expect(restarts()).toBe(2);
      expect(await restart.blocked()).toBe(false);
      expect(world.followed.map((entry) => entry.why)).toEqual([
        "lifted",
        "lifted",
        "lifted",
      ]);
    }),
);
