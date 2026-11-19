import { spawn } from "node:child_process";
import { join } from "node:path";
import { buddyGeneration, type MachineEntry } from "../folder/machine-binding";
import {
  type BuddySignal,
  parseBuddySignal,
  unavailableSignal,
} from "../shell/buddy-signal";
import { resolveOnPath } from "../tools/status";

// The sign by Buddy GEN4's avatar (plan LZD-0033, the sign): whether Buddy
// waits for the person, failed or has answered. Only the shared T3 Code
// knows it, from Buddy's thread (Lazurio/t3code#232); the Launchpad follows
// it with one `t3 lazurio buddy signal --json --follow` and hands the latest
// state to every page of the shell. A reading it cannot make is
// `unavailable`, never quiet: before the first line, while the process is
// down, on a line it does not understand and between restarts.

export {
  type BuddySignal,
  type BuddySignalState,
  unavailableSignal,
} from "../shell/buddy-signal";

/** The longest line a follower reads; a longer one is no sign. */
export const buddySignalLineLimit = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line of `t3 lazurio buddy signal --json --follow`, which T3 Code
 * versions (Lazurio/t3code#232, version 1): exactly that version, a known
 * state and, but for `unavailable`, its thread and the members of version
 * 1. Anything else, an unversioned line included, is `unavailable`. */
export function parseBuddySignalLine(line: string): BuddySignal {
  if (line.length > buddySignalLineLimit) return unavailableSignal;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return unavailableSignal;
  }
  if (!isRecord(value) || value.version !== 1) return unavailableSignal;
  if (value.state === "unavailable") return unavailableSignal;
  if (
    typeof value.threadId !== "string" ||
    !(value.since === null || typeof value.since === "string") ||
    !(value.request === null || isRecord(value.request)) ||
    !(value.startedBy === "person" || value.startedBy === "other")
  )
    return unavailableSignal;
  return (
    parseBuddySignal({
      state: value.state,
      since: value.since,
      request: value.request,
      startedBy: value.startedBy,
    }) ?? unavailableSignal
  );
}

const sameSignal = (left: BuddySignal, right: BuddySignal) =>
  left.state === right.state &&
  left.since === right.since &&
  left.request?.kind === right.request?.kind &&
  left.startedBy === right.startedBy;

/** A running follower: its lines, and how it ended (any end is a failure:
 * it follows for good). */
export type BuddySignalProcess = Readonly<{
  exited: Promise<unknown>;
  stop: () => void;
}>;

export type BuddySignalFollowerSeams = Readonly<{
  /** Starts the follower, reporting each line of its output; throws or
   * rejects where it cannot start. */
  start: (onLine: (line: string) => void) => Promise<BuddySignalProcess>;
  setTimer: (run: () => void, ms: number) => () => void;
  /** The waits before the next start, the last one repeated. */
  retryMs?: readonly number[];
}>;

const defaultRetryMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** Follows the sign for as long as the Launchpad runs: the latest state,
 * and a call to each listener when it changes. */
export function createBuddySignalFollower(seams: BuddySignalFollowerSeams) {
  const retryMs = seams.retryMs ?? defaultRetryMs;
  const listeners = new Set<(signal: BuddySignal) => void>();
  let current = unavailableSignal;
  let process: BuddySignalProcess | null = null;
  let cancelRetry: (() => void) | null = null;
  let failures = 0;
  let closed = false;

  const set = (next: BuddySignal) => {
    if (sameSignal(current, next)) return;
    current = next;
    for (const listener of listeners) listener(current);
  };

  const retry = () => {
    set(unavailableSignal);
    if (closed) return;
    const wait = retryMs[Math.min(failures, retryMs.length - 1)] ?? 60_000;
    failures += 1;
    cancelRetry = seams.setTimer(() => {
      cancelRetry = null;
      void run();
    }, wait);
  };

  async function run(): Promise<void> {
    if (closed) return;
    let started: BuddySignalProcess;
    try {
      started = await seams.start((line) => {
        if (closed || line.trim() === "") return;
        const signal = parseBuddySignalLine(line);
        // A reading T3 Code made resets the waits; its own `unavailable`
        // (T3 down, the session refused) does not, though it says so.
        if (signal.state !== "unavailable") failures = 0;
        set(signal);
      });
    } catch {
      retry();
      return;
    }
    if (closed) {
      started.stop();
      return;
    }
    process = started;
    await started.exited.catch(() => undefined);
    if (process !== started) return;
    process = null;
    retry();
  }

  return Object.freeze({
    start(): void {
      if (closed || process !== null || cancelRetry !== null) return;
      void run();
    },
    current: (): BuddySignal => current,
    /** Calls `listener` with every change; the answer unsubscribes. */
    subscribe(listener: (signal: BuddySignal) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close(): void {
      closed = true;
      cancelRetry?.();
      cancelRetry = null;
      process?.stop();
      process = null;
      listeners.clear();
    },
  });
}

export type BuddySignalFollower = ReturnType<typeof createBuddySignalFollower>;

/** The Launchpad's follower: only for an entry that names Buddy GEN4, and
 * only where the installed service says how to start it; null elsewhere,
 * Buddy GEN3 included. */
export function buddySignalFollowerFor(
  entry: MachineEntry | null | undefined,
  start: BuddySignalFollowerSeams["start"] | undefined,
): BuddySignalFollower | null {
  if (buddyGeneration(entry ?? undefined) !== 4 || start === undefined)
    return null;
  return createBuddySignalFollower({
    start,
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
}

/** `t3 lazurio buddy signal --json --follow` of the shared T3 Code
 * (`~/.t3`), the `t3` on the Launchpad's PATH, in its own process group so
 * that a stop ends it whole. Only its standard output is read: its log on
 * standard error is no sign. */
export function buddySignalProcess(environment: {
  path: string | undefined;
  home: string | undefined;
  platform: string;
}): BuddySignalFollowerSeams["start"] {
  return async (onLine) => {
    const home = environment.home;
    if (home === undefined) throw new Error("No home for the shared T3 Code");
    const t3 = await resolveOnPath(
      "t3",
      environment.path,
      environment.platform,
    );
    if (t3 === undefined) throw new Error("t3 is not on PATH");
    const child = spawn(
      t3,
      [
        "lazurio",
        "buddy",
        "signal",
        "--json",
        "--follow",
        "--base-dir",
        join(home, ".t3"),
      ],
      {
        env: { HOME: home, PATH: environment.path ?? "" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: environment.platform !== "win32",
        windowsHide: true,
      },
    );
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    });
    let buffer = "";
    // Within a line too long to be a sign, until its end.
    let skipping = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        if (!skipping) onLine(buffer.slice(0, newline));
        skipping = false;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      // No sign is this long: say so at once, and drop the rest of it.
      if (buffer.length > buddySignalLineLimit) {
        if (!skipping) onLine(buffer);
        skipping = true;
        buffer = "";
      }
    });
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (environment.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {}
      }
      child.kill("SIGTERM");
    };
    return Object.freeze({ exited, stop });
  };
}
