import { lstat, mkdir, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock, FileLockError } from "../platform/flock";
import {
  type ActiveWork,
  askActiveWork,
  buddyStateDirectory,
  gatewayUnitState,
  reloadUnits,
  restartGateway,
  restartPending,
  type ServiceRun,
  writeBuddyStateFile,
} from "./gateway-refresh";
import { applyLockPath } from "./persona-apply";

// Telegram's settings reach Buddy's gateway only when it starts (decision
// F66): Hermes's own writer of a messaging platform saves the bot's token and
// `platforms.telegram.enabled` and restarts nothing (Lazurio/hermes-agent
// v0.22.4-lazurio.3, `hermes_cli/web_routers/messaging.py`
// `update_messaging_platform`, which answers `pending_restart` until then).
// So a connect or a disconnect owes one restart of `hermes-gateway.service`,
// and it is F64's restart: the same unit state, the same `active-work`
// question, the same `systemctl --user restart` under the same apply turn,
// and the same derived rule for whether it is still owed.
//
// - What is owed is derived, as F64 derives a restart its files owe: the
//   Platform's own record `telegram-changed.json` in Buddy's state directory
//   is written after each change, and a restart is owed while the gateway's
//   main process started before it (`ExecMainStartTimestamp` against the
//   record's time). Any start after it, whoever made it (F64's apply, the
//   installer, systemd after a crash), settles it, so a connect, a disconnect
//   and a persona change before one restart need that one restart.
// - Only while Hermes's `active-work` says Buddy is idle; no answer counts as
//   busy. Never on units systemd failed to reread.
// - Never twice in quick succession: Telegram answers a bot that reconnects
//   again and again with its flood limit (observed on a person's Buddy after a
//   wizard restarted the gateway several times: polling came back only about
//   three minutes later). A restart this owes waits until the gateway has run
//   `telegramRestartSpacingMs` since its last start, whoever started it.
// - Asked again every 15 seconds while it waits, later and later after a
//   failure; and once when the Launchpad starts, so a restart owed before a
//   Launchpad restart is still made.
// - systemd that does not answer (`systemctl --user show` failing or timing
//   out, the apply turn's lock unusable) keeps the restart owed: asked again
//   later and later, at most every 15 minutes, and the idle and spacing rules
//   hold when it answers. Only a gateway with no unit at all owes nothing:
//   whoever starts it reads the files then.
// - A write that ended without a clear answer (`uncertain`) may still run in
//   the gateway that took it, after any later write. It owes a restart like
//   a change, and it holds a barrier until the gateway that took it is gone:
//   the core sends no Telegram change to Hermes while `blocked` (it keeps the
//   latest intent instead). Its own record is `telegram-uncertain.json`,
//   written before anything else, so a Launchpad restart keeps the barrier
//   and the restart it owes. The barrier lifts only with a restart, a
//   gateway found started after both records, or one found stopped, after
//   every change asked so far; a change during an attempt leaves it to the
//   attempt that change asked for, and a gateway systemd is still stopping
//   is asked again. Lifted, the core's follow-up (`cleared`) applies what
//   waited, asked again later and later while it answers "again" (his
//   gateway not ready yet). A gateway without a unit lifts it without a
//   restart: the documented exception.

/** The Platform's own record of the last change of Buddy's Telegram: its
 * time is what a running gateway must have started after. */
export const telegramChangedPath = (home: string): string =>
  join(buddyStateDirectory(home), "telegram-changed.json");

/** Records a change of Buddy's Telegram now: the record's time is the
 * change's, on the clock the gateway's start is compared with. */
export async function markTelegramChanged(
  home: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const at = now();
  const path = telegramChangedPath(home);
  await writeBuddyStateFile(path, {
    schema_version: "lazurio.buddy-telegram-changed.v1",
    changed_at: `${at.toISOString().slice(0, 19)}Z`,
  });
  await utimes(path, at, at);
}

/** The barrier of a write that ended without a clear answer, and its record:
 * present until the restart that ends the gateway that may still run it, and
 * written at the write's end, on the clock the gateway's start is compared
 * with. No content but its schema; 0600 in Buddy's 0700 state directory. */
export const telegramUncertainPath = (home: string): string =>
  join(buddyStateDirectory(home), "telegram-uncertain.json");

/** Why the core's follow-up is asked: the barrier lifted, or the Launchpad
 * started (a disconnect that waited across it). */
export type TelegramFollowUp = "lifted" | "start";

/** How long a gateway runs before a restart this owes may stop it again. */
export const telegramRestartSpacingMs = 120_000;
/** While Buddy is busy the restart is asked again this often. */
export const telegramRestartRetryMs = 15_000;
/** A failed restart is asked again after this, doubled each time, at most
 * `telegramRestartRetryMaxMs`. */
export const telegramRestartFailedMs = 30_000;
export const telegramRestartRetryMaxMs = 15 * 60_000;

/** One attempt: nothing owed (`none`), made now (`done`), waiting for Buddy
 * to be idle, for the spacing or for another apply (`pending`, with when to
 * ask again), refused by systemd (`failed`), systemd not answering
 * (`unanswered`: still owed, asked again later), or nothing to restart
 * (`unavailable`: no home, or no unit of the gateway). */
export type TelegramRestartOutcome =
  | Readonly<{
      state: "none" | "done" | "failed" | "unanswered" | "unavailable";
    }>
  | Readonly<{
      state: "pending";
      reason: "busy" | "spacing" | "turn" | "stopping";
    }>;

export type TelegramRestartTimers = Readonly<{
  after(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}>;

const processTimers: TelegramRestartTimers = {
  after: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    // A retry never keeps a stopping process alive.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export type TelegramRestartJournalEntry = Readonly<{
  operation: "restart";
  outcome: string;
  reason?: string;
}>;

export function createTelegramRestart(
  input: Readonly<{
    /** The account's home; none known restarts nothing. */
    home: string | undefined;
    service: ServiceRun;
    /** Tests only: Hermes's `active-work` verb. */
    activeWork?: ((hermesHome: string) => Promise<ActiveWork>) | undefined;
    timers?: TelegramRestartTimers | undefined;
    /** Tests only: the clock, in milliseconds since the epoch. */
    now?: (() => number) | undefined;
    journal?: ((entry: TelegramRestartJournalEntry) => void) | undefined;
    spacingMs?: number | undefined;
    /** What waited for the barrier: asked when it lifts and when the
     * Launchpad starts; "again" asks once more later. */
    cleared?:
      | ((why: TelegramFollowUp) => Promise<"done" | "again">)
      | undefined;
  }>,
) {
  const home = input.home;
  const timers = input.timers ?? processTimers;
  const now = input.now ?? Date.now;
  const spacingMs = input.spacingMs ?? telegramRestartSpacingMs;
  const activeWork = input.activeWork ?? askActiveWork;
  let owed = false;
  let closed = false;
  let retry: unknown;
  let running: Promise<TelegramRestartOutcome> | null = null;
  // The attempt the last change asked for, and when this made a restart.
  let asked: Promise<TelegramRestartOutcome | null> = Promise.resolve(null);
  let restartedAt: number | null = null;
  let failedDelay = telegramRestartFailedMs;
  let journaled: string | null = null;
  // Every change and uncertain write counts here: an attempt lifts what is
  // owed only when nothing was asked after it began.
  let generation = 0;
  // A write without a clear answer waits for a restart; kept on disk too.
  let barrier = false;
  let loaded: Promise<void> | null = null;
  const load = (): Promise<void> =>
    (loaded ??= (async () => {
      if (home === undefined) return;
      if (
        await lstat(telegramUncertainPath(home)).then(
          () => true,
          () => false,
        )
      ) {
        barrier = true;
        owed = true;
      }
    })());
  // The barrier's file, written and removed in the order asked.
  let marking: Promise<unknown> = Promise.resolve();
  const mark = (operation: () => Promise<unknown>): Promise<unknown> => {
    const next = marking.then(operation, operation);
    marking = next.catch(() => undefined);
    return next;
  };
  // The core's follow-up, asked again later while it answers "again".
  let lifts = 0;
  let follow: unknown;
  let followDelay = telegramRestartRetryMs;

  const journal = (outcome: TelegramRestartOutcome) => {
    const line = JSON.stringify(outcome);
    if (line === journaled) return;
    journaled = line;
    try {
      input.journal?.({
        operation: "restart",
        outcome: outcome.state,
        ...("reason" in outcome ? { reason: outcome.reason } : {}),
      });
    } catch {}
  };

  /** One attempt under F64's apply turn: never beside an apply of the
   * persona, which restarts the same gateway. */
  async function attempt(): Promise<TelegramRestartOutcome> {
    if (home === undefined) return Object.freeze({ state: "unavailable" });
    const lockPath = applyLockPath(home);
    let turn: Awaited<ReturnType<typeof acquireFileLock>>;
    try {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
      turn = await acquireFileLock(lockPath, { timeoutMs: 2_000 });
    } catch (error) {
      return error instanceof FileLockError && error.reason === "busy"
        ? Object.freeze({ state: "pending", reason: "turn" })
        : Object.freeze({ state: "unanswered" });
    }
    try {
      const unit = await gatewayUnitState(input.service);
      // No answer is not "nothing to restart": the restart stays owed.
      if (unit.state === "unknown")
        return Object.freeze({ state: "unanswered" });
      if (unit.state === "absent")
        return Object.freeze({ state: "unavailable" });
      // A gateway systemd is stopping may still run a write it took: asked
      // again once it has stopped.
      if (unit.state === "stopped" && unit.stopping === true)
        return Object.freeze({ state: "pending", reason: "stopping" });
      // A gateway that does not run reads the files when it starts.
      if (unit.state !== "running") return Object.freeze({ state: "none" });
      // Only these records decide here; units systemd has not reread are
      // reread before the restart, never restarted on.
      if (
        !(await restartPending({ ...unit, needsReload: false }, [
          telegramChangedPath(home),
          telegramUncertainPath(home),
        ]))
      )
        return Object.freeze({ state: "none" });
      const startedMs = Number(unit.startedAt / 1000n);
      if (now() - startedMs < spacingMs)
        return Object.freeze({ state: "pending", reason: "spacing" });
      if ((await activeWork(join(home, ".hermes"))) !== "idle")
        return Object.freeze({ state: "pending", reason: "busy" });
      if (unit.needsReload && !(await reloadUnits(input.service)))
        return Object.freeze({ state: "failed" });
      return Object.freeze({
        state: (await restartGateway(input.service)) ? "done" : "failed",
      });
    } finally {
      await turn.release();
    }
  }

  const schedule = (delay: number) => {
    if (retry !== undefined) timers.cancel(retry);
    retry = timers.after(
      () => {
        retry = undefined;
        void run();
      },
      Math.max(0, delay),
    );
  };

  /** The core's follow-up: what waited for the barrier. */
  function followUp(why: TelegramFollowUp) {
    if (closed || input.cleared === undefined) return;
    if (follow !== undefined) timers.cancel(follow);
    follow = undefined;
    const again = () => {
      if (closed) return;
      follow = timers.after(() => {
        follow = undefined;
        followUp(why);
      }, followDelay);
      followDelay = Math.min(followDelay * 2, telegramRestartRetryMaxMs);
    };
    input.cleared(why).then(
      (answer) => {
        if (answer === "again") again();
        else followDelay = telegramRestartRetryMs;
      },
      () => again(),
    );
  }

  function settle(outcome: TelegramRestartOutcome, seen: number) {
    journal(outcome);
    if (outcome.state === "pending") {
      failedDelay = telegramRestartFailedMs;
      if (!closed) schedule(telegramRestartRetryMs);
      return;
    }
    if (outcome.state === "failed" || outcome.state === "unanswered") {
      const delay = failedDelay;
      failedDelay = Math.min(failedDelay * 2, telegramRestartRetryMaxMs);
      if (!closed) schedule(delay);
      return;
    }
    // Done, nothing owed, or nothing to restart: a change after this one
    // records itself and asks again.
    if (outcome.state === "done") restartedAt = now();
    failedDelay = telegramRestartFailedMs;
    // A change or an uncertain write during this attempt may postdate the
    // start it read: the attempt that change asked for decides.
    if (seen !== generation) return;
    owed = false;
    if (barrier) {
      barrier = false;
      lifts += 1;
      if (home !== undefined)
        void mark(() => rm(telegramUncertainPath(home), { force: true })).catch(
          () => undefined,
        );
      followUp("lifted");
    }
  }

  function run(): Promise<TelegramRestartOutcome> {
    if (running !== null) return running;
    if (retry !== undefined) {
      timers.cancel(retry);
      retry = undefined;
    }
    const seen = generation;
    const current = attempt()
      .catch((): TelegramRestartOutcome => Object.freeze({ state: "failed" }))
      .then((outcome) => {
        running = null;
        settle(outcome, seen);
        return outcome;
      });
    running = current;
    return current;
  }

  /** A change, or a write in doubt, recorded by `write`: then the restart
   * asked for in the background, or joined while one is under way or
   * waits. Resolves once it is recorded; `settled` follows the attempt. */
  async function record(
    write: (home: string) => Promise<unknown>,
  ): Promise<"recorded" | "unrecorded"> {
    if (home === undefined) return "unrecorded";
    await load();
    try {
      await write(home);
    } catch {
      return "unrecorded";
    }
    generation += 1;
    owed = true;
    if (closed) return "recorded";
    // An attempt under way may have read the gateway's start before this
    // record: one more attempt follows it.
    const before = running;
    asked = (async () => {
      if (before !== null) await before;
      return run();
    })().catch(() => null);
    return "recorded";
  }

  return Object.freeze({
    /** Whether a restart this owes still waits: the page says so. */
    owed: (): boolean => owed,

    /** Whether this restarted the gateway within the spacing: while it
     * starts again, Hermes cannot be asked, and the change is still on its
     * way rather than unknown. */
    restartedRecently: (): boolean =>
      restartedAt !== null && now() - restartedAt < spacingMs,

    /** Buddy's Telegram changed through Hermes now: recorded, then the
     * restart asked for in the background, or joined while one is under
     * way or waits. Resolves once the change is recorded; `settled` follows
     * the attempt. */
    changed: () =>
      record((at) => markTelegramChanged(at, () => new Date(now()))),

    /** A write that ended without a clear answer: it may still run in the
     * gateway that took it. A restart is owed, as for a change, and the
     * barrier holds until it is made. */
    async uncertain(): Promise<"recorded" | "unrecorded"> {
      // No home, no restart: nothing to wait for (the documented exception).
      if (home === undefined) return "unrecorded";
      // Before any wait: an attempt under way never lifts what this owes.
      generation += 1;
      barrier = true;
      owed = true;
      // Its own record, kept until the barrier lifts.
      return record((at) =>
        mark(async () => {
          const path = telegramUncertainPath(at);
          const time = new Date(now());
          await writeBuddyStateFile(path, {
            schema_version: "lazurio.buddy-telegram-uncertain.v1",
          });
          await utimes(path, time, time);
        }),
      );
    },

    /** Whether a write without a clear answer still waits for its restart:
     * no Telegram change goes to Hermes until then. */
    async blocked(): Promise<boolean> {
      await load();
      return barrier;
    },

    /** Waits until the attempt for the last change is complete. If an
     * attempt starts after it (for example, a retry from a timer), this also
     * waits for that attempt. The tests use this function. The result is null
     * if there is no attempt. */
    async settled(): Promise<TelegramRestartOutcome | null> {
      const outcome = await asked;
      return running ?? outcome;
    },

    /** The Launchpad starts: a restart owed by a change before it is made
     * once Buddy is idle, without anyone opening a page. Where no change
     * was ever recorded, nothing is asked. */
    async start(): Promise<void> {
      if (home === undefined || closed) return;
      await load();
      const before = lifts;
      const recorded = await lstat(telegramChangedPath(home)).then(
        () => true,
        () => false,
      );
      if (recorded || barrier) {
        owed = true;
        await run();
      }
      // What waited across a Launchpad restart, the barrier lifted already
      // (a lift during this start asked it itself).
      if (!barrier && lifts === before) followUp("start");
    },

    /** The Launchpad stops: nothing more is asked. */
    close() {
      closed = true;
      if (retry !== undefined) timers.cancel(retry);
      retry = undefined;
      if (follow !== undefined) timers.cancel(follow);
      follow = undefined;
    },
  });
}

export type TelegramRestart = ReturnType<typeof createTelegramRestart>;
