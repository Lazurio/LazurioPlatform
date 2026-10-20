import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireFileLock, FileLockError } from "../../platform/flock";
import {
  type BuildProcessInput,
  type BuildProcessOutcome,
  buildTimeoutMs,
  runBuildProcess,
} from "./build-process";
import type { CheckoutHead } from "./checkout";
import type { StaticFallback } from "./static-server";
import {
  type BuildInput,
  type BuildRecord,
  type BuildState,
  type BuildStore,
  openBuildStore,
} from "./store";

// The builds of an Environment's static apps (decision F58): one at a time,
// whichever process asks (a kernel `flock` on the account's build lock, and
// in this process one queue in which a build somebody waits for goes first),
// each of an app's checkout as it is when the build starts. A build reads the
// app's declaration and checkouts, runs the app's own start-time step (the
// frozen install, its check and, when that fails, its preparation), then its
// build script at a low priority, checks that the output answers the
// declared health path, reads the checkouts again and only then installs the
// output under its key: a pull during the build builds again, so an output
// is never of a mix of two commits. A failure is recorded and keeps every
// output there was.

/** What a build needs of one app, read anew when it starts. */
export type BuildContext = Readonly<{
  /** The module's checkout. */
  head: CheckoutHead;
  /** The other checkouts it reads (data mounts, required slots). */
  inputs: readonly BuildInput[];
  key: string;
  /** The app's package directory, where its build script runs. */
  cwd: string;
  script: string;
  output: string;
  fallback: StaticFallback;
  /** The entrypoint's declared health path: the output must answer it. */
  health: string;
  env: Readonly<Record<string, string>>;
}>;

export type BuildJob = Readonly<{
  /** The app's build directory (`appBuildDirectory`). */
  directory: string;
  names: Readonly<{ organization: string; module: string; app: string }>;
  /** The app's declaration and checkouts now, or why it cannot build. */
  read: () => Promise<BuildContext | Readonly<{ refused: string }>>;
  /** The app's start-time step; null when it passed, else its reason. */
  prepare: () => Promise<string | null>;
  /** An explicit build: also of a key whose last build failed, and again
   * of a key already built when the checkout has uncommitted changes. */
  explicit?: boolean | undefined;
}>;

export type BuildOutcome = Readonly<
  | {
      kind: "built";
      record: BuildRecord;
      output: string;
      /** Nothing was built: this key's output was already there. */
      already: boolean;
    }
  | { kind: "failed"; reason: string; key: string | null }
  | { kind: "busy" }
  | { kind: "closing" }
>;

export type BuildRunner = (
  input: BuildProcessInput,
) => Promise<BuildProcessOutcome>;

/** How long a build waits for another process's build to end. */
const lockWaitMs = buildTimeoutMs + 300_000;
/** A pull during each of these many builds in a row ends the attempt. */
const attemptsMax = 3;

export function createBuilds(input: {
  lockFile: string;
  runner: () => Promise<"systemd-user" | "session">;
  runtimeDirectory?: string | undefined;
  executable: string;
  /** Whether the static server answers `path` of `root` with a file: the
   * check of a build before it is kept. */
  servable: (
    root: string,
    path: string,
    fallback: StaticFallback,
  ) => Promise<boolean>;
  /** Test seams. */
  runBuild?: BuildRunner | undefined;
  lockWaitMs?: number | undefined;
  now?: () => Date;
  pid?: number;
}) {
  const runBuild = input.runBuild ?? runBuildProcess;
  const now = input.now ?? (() => new Date());
  const pid = input.pid ?? process.pid;
  const abort = new AbortController();
  type Entry = {
    job: BuildJob;
    foreground: boolean;
    started: boolean;
    promise: Promise<BuildOutcome>;
    resolve: (outcome: BuildOutcome) => void;
  };
  const entries = new Map<string, Entry>();
  let active = false;
  let closing = false;
  let idle: Promise<void> = Promise.resolve();
  let settle: () => void = () => {};

  async function lock() {
    await mkdir(dirname(input.lockFile), { recursive: true, mode: 0o700 });
    return acquireFileLock(input.lockFile, {
      timeoutMs: input.lockWaitMs ?? lockWaitMs,
      pollMs: 500,
    });
  }

  function initial(job: BuildJob): BuildState {
    return Object.freeze({
      schema_version: "lazurio.build-state.v1" as const,
      ...job.names,
      current: null,
      previous: null,
      building: null,
      failure: null,
    });
  }

  async function record(
    store: BuildStore,
    state: BuildState,
    change: Partial<Omit<BuildState, "schema_version">>,
  ) {
    const next = Object.freeze({ ...state, ...change });
    await store.writeState(next);
    return next;
  }

  async function execute(job: BuildJob): Promise<BuildOutcome> {
    const store = openBuildStore(job.directory);
    let held: Awaited<ReturnType<typeof lock>>;
    try {
      held = await lock();
    } catch (error) {
      if (error instanceof FileLockError && error.reason === "busy")
        return Object.freeze({ kind: "busy" as const });
      throw error;
    }
    let state = (await store.state()) ?? initial(job);
    try {
      for (let attempt = 0; attempt < attemptsMax; attempt++) {
        if (closing) return Object.freeze({ kind: "closing" as const });
        const context = await job.read();
        if ("refused" in context)
          return Object.freeze({
            kind: "failed" as const,
            reason: context.refused,
            key: null,
          });
        const { key, head } = context;
        // Another process may have built it while this one waited.
        state = (await store.state()) ?? state;
        const there =
          state.current?.key === key ? await store.output(key) : null;
        if (
          there !== null &&
          state.current !== null &&
          !(job.explicit && head.dirty)
        )
          return Object.freeze({
            kind: "built" as const,
            record: state.current,
            output: there,
            already: true,
          });
        if (!job.explicit && state.failure?.key === key)
          return Object.freeze({
            kind: "failed" as const,
            reason: state.failure.reason,
            key,
          });
        state = await record(store, state, {
          building: Object.freeze({
            key,
            commit: head.commit,
            at: now().toISOString(),
            pid,
          }),
        });
        const failed = async (reason: string) => {
          state = await record(store, state, {
            building: null,
            failure: Object.freeze({
              key,
              commit: head.commit,
              at: now().toISOString(),
              reason,
            }),
          });
          return Object.freeze({ kind: "failed" as const, reason, key });
        };
        const prepared = await job.prepare();
        if (closing) {
          await record(store, state, { building: null });
          return Object.freeze({ kind: "closing" as const });
        }
        if (prepared !== null) return failed(prepared);
        await store.prepareLogs();
        const ran = await runBuild({
          runner: await input.runner(),
          runtimeDirectory: input.runtimeDirectory,
          executable: input.executable,
          cwd: context.cwd,
          script: context.script,
          env: context.env,
          log: store.logFile(key),
          timeoutMs: buildTimeoutMs,
          signal: abort.signal,
        });
        if (ran.kind === "cancelled" || closing) {
          await record(store, state, { building: null });
          return Object.freeze({ kind: "closing" as const });
        }
        if (ran.kind === "timed-out") return failed("build-timed-out");
        if (ran.kind !== "exited" || ran.code !== 0)
          return failed("build-script-failed");
        const output = join(context.cwd, context.output);
        const entry = await lstat(output).catch(() => null);
        if (entry === null || !entry.isDirectory())
          return failed("build-output-missing");
        if (!(await input.servable(output, context.health, context.fallback)))
          return failed("build-output-unservable");
        // A pull while it built: the output may mix two commits. Build the
        // new one instead.
        const after = await job.read();
        if ("refused" in after || after.key !== key) continue;
        const installed = await store.install(output, key);
        const built: BuildRecord = Object.freeze({
          key,
          commit: head.commit,
          inputs: context.inputs,
          dirty: head.dirty || after.head.dirty,
          at: now().toISOString(),
        });
        state = await record(store, state, {
          current: built,
          previous:
            state.current !== null && state.current.key !== key
              ? state.current
              : state.previous,
          building: null,
          failure: null,
        });
        // Keep the current and previous builds and what runs now.
        const served = await store.served();
        await store.collect(
          new Set(
            [state.current?.key, state.previous?.key, served?.key].filter(
              (item): item is string => typeof item === "string",
            ),
          ),
        );
        return Object.freeze({
          kind: "built" as const,
          record: built,
          output: installed,
          already: false,
        });
      }
      state = await record(store, state, { building: null });
      return Object.freeze({
        kind: "failed" as const,
        reason: "checkout-changing",
        key: null,
      });
    } catch (error) {
      // Never leave a build recorded as under way by a process that lives on.
      if (state.building?.pid === pid)
        await record(store, state, { building: null }).catch(() => undefined);
      throw error;
    } finally {
      await held.release();
    }
  }

  function pump() {
    if (active) return;
    const waiting = [...entries.values()].filter((entry) => !entry.started);
    const next =
      waiting.find((entry) => entry.foreground) ?? waiting[0] ?? undefined;
    if (next === undefined) {
      settle();
      return;
    }
    active = true;
    next.started = true;
    const directory = next.job.directory;
    void execute(next.job)
      .catch(() =>
        Object.freeze({
          kind: "failed" as const,
          reason: "build-failed",
          key: null,
        }),
      )
      .then((outcome) => {
        entries.delete(directory);
        active = false;
        next.resolve(outcome);
        pump();
      });
  }

  return Object.freeze({
    /** Builds the app at its checkout as it is when its build starts. A
     * build of the same app that has not started yet is joined (and goes
     * first when someone now waits for it); one under way is joined too. */
    enqueue(job: BuildJob, priority: "foreground" | "background") {
      if (closing)
        return Promise.resolve(Object.freeze({ kind: "closing" as const }));
      const existing = entries.get(job.directory);
      if (existing !== undefined) {
        if (priority === "foreground") existing.foreground = true;
        if (!existing.started)
          existing.job = {
            ...job,
            explicit: existing.job.explicit || job.explicit,
          };
        return existing.promise;
      }
      let resolve: (outcome: BuildOutcome) => void = () => {};
      const promise = new Promise<BuildOutcome>((done) => {
        resolve = done;
      });
      if (entries.size === 0)
        idle = new Promise<void>((done) => {
          settle = done;
        });
      entries.set(job.directory, {
        job,
        foreground: priority === "foreground",
        started: false,
        promise,
        resolve,
      });
      pump();
      return promise;
    },
    /** Whether this process builds (or will build) the app. */
    pending(directory: string) {
      return entries.has(directory);
    },
    /** Resolves when no build is queued or under way (tests, shutdown). */
    settled() {
      return entries.size === 0 ? Promise.resolve() : idle;
    },
    /** Ends a build under way (its process group or unit is stopped) and
     * refuses new ones; queued builds answer `closing`. */
    async close() {
      closing = true;
      abort.abort();
      for (const entry of entries.values())
        if (!entry.started) {
          entries.delete(entry.job.directory);
          entry.resolve(Object.freeze({ kind: "closing" as const }));
        }
      await (entries.size === 0 ? Promise.resolve() : idle);
    },
  });
}

export type Builds = ReturnType<typeof createBuilds>;

/** Whether a build state's `building` is a build that still runs: the
 * process that recorded it is alive. */
export function buildUnderWay(state: BuildState | null): boolean {
  const building = state?.building;
  if (!building) return false;
  try {
    process.kill(building.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
