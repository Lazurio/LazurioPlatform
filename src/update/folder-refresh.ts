import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FolderOperationBusyError,
  withFolderOperationLock,
} from "../folder/lock";
import { neededRefresh } from "../folder/refresh-needed";
import { shownAsItself } from "../folder/visible-text";
import { recordRestartOwed, restartOwedFor } from "../machine/launchpad-entry";
import { layout } from "./layout";
import {
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "./self-check";
import { serviceEnvironment } from "./service-control";

/** The Folder refresh of `lazurio update` (decision F17's addendum of
 * 2026-10-30): after the switch, and also when nothing newer was found, a
 * Folder whose generated files an older template revision rendered is
 * re-rendered by the ACTIVE version, whose templates they are. Its own
 * refresh runs as a bounded child through the selector, exactly the command
 * an agent would run (`neededRefresh`), so it goes through the one Folder
 * change path with its lock, transaction, archive and recovery; a Machines
 * apply that runs the same command meanwhile finds the Folder current or
 * busy, as before. Nothing of it changes the update's result: the switch is
 * final, and the outcome is a report for agents, never shown to people.
 */
export const folderRefreshStates = [
  "refreshed",
  "unchanged",
  "blocked",
  "failed",
] as const;
export type FolderRefreshState = (typeof folderRefreshStates)[number];

export type FolderRefreshOutcome = Readonly<{
  state: FolderRefreshState;
  /** The refresh's own code: why it was blocked, or how it failed. */
  reason?: string;
  /** The Folder-relative path or top-level entry a refusal names. */
  path?: string;
}>;

/** The whole refresh, bounded: one that records a changed entry restarts
 * the Launchpad and waits for it at most 30 seconds. */
export const refreshTimeoutMs = 120_000;

/** `folder-busy` is retried: the Launchpad that the switch has just
 * restarted reads the Folder under its lock for moments. `stale-revision`
 * too, read again: a concurrent change moved the revision first. */
export const refreshRetry = Object.freeze({ attempts: 6, delayMs: 1_000 });

export type FolderRefreshInput = Readonly<{
  base: string;
  folder: string;
  /** The template revision the active version renders. */
  product: string;
  /** The update's environment; the child gets what a service needs. */
  env: Readonly<Record<string, string | undefined>>;
  /** The declared operator's Folder on a hosted Machine; absent, or
   * failing, none. */
  operatorFolder?: (() => Promise<string | undefined>) | undefined;
  run?: ProcessRunner | undefined;
  timeoutMs?: number | undefined;
  retry?: Readonly<{ attempts: number; delayMs: number }> | undefined;
  /** Run each command as a transient systemd user unit (`systemd-run --user
   * --wait --pipe`) instead of this process's child, so that it outlives
   * whatever ends this process: an agent's tool call, a closed session, a
   * caller's limit (#1205). Only on a supervised Linux base. */
  detach?: boolean | undefined;
}>;

/** A transient user unit that runs the command to its end even when this
 * process is gone, passes its output and exit status back while this process
 * waits, and is removed after it ends. Killing this process's child stops
 * only the waiting, never the command. */
export const detachedPrefix = Object.freeze([
  "systemd-run",
  "--user",
  "--quiet",
  "--no-ask-password",
  "--collect",
  "--wait",
  "--pipe",
  "--",
]);

/** A refresh that did not complete, by how it failed. */
export const failedRefresh = (reason: string): FolderRefreshOutcome =>
  Object.freeze({ state: "failed" as const, reason });

/** A refresh that could not run now and is retried (`folder-busy`). */
const blockedRefresh = (reason: string): FolderRefreshOutcome =>
  Object.freeze({ state: "blocked" as const, reason });

// The product's codes and a path within the Folder, never anything else the
// child printed.
const code = /^[a-z][a-z0-9-]{0,63}$/;

/** A path within the Folder or a top-level entry, as the refresh names it
 * (Pablo's review of #731): relative (no leading `/` or `\`, no drive or UNC
 * prefix), normalized (no empty, `.` or `..` segment, so it never points
 * outside the Folder), at most 512 characters, and every character shown as
 * itself. Anything else is dropped; the refusal's reason stays. */
const folderPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/^[A-Za-z]:/.test(value) &&
  shownAsItself(value) &&
  value
    .split(/[\\/]/)
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** One JSON object on stdout, as `machine folder-refresh` and
 * `profile-update` answer: 0 refreshed (`updated`) or unchanged, 2 blocked,
 * 1 failed. */
function outcomeOf(result: ProcessResult | null): FolderRefreshOutcome {
  if (result === null) return failedRefresh("internal");
  if (result === "timeout") return failedRefresh("timeout");
  let answer: Readonly<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return failedRefresh("output");
    answer = parsed as Readonly<Record<string, unknown>>;
  } catch {
    return failedRefresh(result.exitCode === 0 ? "output" : "internal");
  }
  // Buddy GEN4's folder that a refresh could not write after its change
  // (plan LZD-0033 R2): the change stands, but the outcome is a failure an
  // agent acts on, with its reason; the next `lazurio machine folder-refresh`
  // writes the folder again.
  const buddy = answer.buddyFolder as { state?: unknown; reason?: unknown };
  if (
    result.exitCode === 0 &&
    typeof buddy === "object" &&
    buddy !== null &&
    buddy.state === "failed"
  )
    return failedRefresh(
      typeof buddy.reason === "string" && code.test(buddy.reason)
        ? buddy.reason
        : "buddy-folder-failed",
    );
  // A restart of the Launchpad that failed after the refresh recorded its
  // entry: the refresh kept it as owed, and the next update retries it.
  if (result.exitCode === 0 && answer.launchpad === "restart-failed")
    return failedRefresh("launchpad-restart-failed");
  if (
    result.exitCode === 0 &&
    (answer.kind === "refreshed" || answer.kind === "updated")
  )
    return Object.freeze({ state: "refreshed" as const });
  if (result.exitCode === 0 && answer.kind === "unchanged")
    return Object.freeze({ state: "unchanged" as const });
  const reason =
    typeof answer.reason === "string" && code.test(answer.reason)
      ? answer.reason
      : undefined;
  if (result.exitCode !== 2 || answer.kind !== "blocked" || !reason)
    return failedRefresh(reason ?? "internal");
  const path = answer.path ?? answer.entry;
  return Object.freeze({
    state: "blocked" as const,
    reason,
    ...(folderPath(path) ? { path } : {}),
  });
}

const retryable = (outcome: FolderRefreshOutcome) =>
  outcome.state === "blocked" &&
  (outcome.reason === "folder-busy" || outcome.reason === "stale-revision");

/** The refresh when the Folder needs one; null when it does not. Every
 * attempt reads the Folder again, so one that another operation refreshed
 * meanwhile is `unchanged`. A prepared transaction an interrupted change left
 * is finished first (`resumePreparedTransaction`). Never throws. */
export async function refreshFolderWhenBehind(
  input: FolderRefreshInput,
): Promise<FolderRefreshOutcome | null> {
  const retry = input.retry ?? refreshRetry;
  const operator = await operatorOf(input);
  const bounded = boundedRun(input);
  let refused: FolderRefreshOutcome | null = null;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    if (attempt > 1) await Bun.sleep(retry.delayMs);
    const resumed = await resumeWith(input, operator, bounded);
    if (resumed !== null && resumed.state !== "refreshed") {
      if (!retryable(resumed)) return resumed;
      refused = resumed;
      continue;
    }
    // A current Folder still runs the operator's refresh while a restart of
    // its Launchpad is owed (layout launchpadRestartOwed).
    const needed =
      (await neededRefresh(input.folder, input.product, operator)) ??
      (operator === input.folder &&
      (await restartOwedFor(
        layout(input.base).launchpadRestartOwed,
        input.folder,
      ))
        ? { command: ["machine", "folder-refresh"] as const }
        : null);
    if (needed === null)
      return refused === null && resumed === null
        ? null
        : Object.freeze({
            state: resumed === null ? "unchanged" : "refreshed",
          } as const);
    let result: ProcessResult | null;
    try {
      result = await bounded(needed.command);
    } catch {
      result = null;
    }
    const outcome = outcomeOf(result);
    if (!retryable(outcome)) return outcome;
    refused = outcome;
  }
  return refused;
}

/** Finish a prepared transaction an earlier, interrupted change of the Folder
 * left behind (#1205), before anything else of an update reads the Folder:
 * the candidate's Launchpad probe refuses a pending transaction, so this runs
 * with the ACTIVE version before the candidate is checked, and again before
 * the refresh after the switch. It is the active version's own explicit
 * recovery, `profile-resume` at the marker's revision, which validates the
 * whole journal and the active files under the Folder's lock and refuses,
 * changing nothing, when they do not agree. Null when there is nothing to
 * finish; `refreshed` when it finished one; `failed` `transaction-pending`
 * when the recovery refused, the transaction staying for an explicit repair.
 * Never throws. */
export async function resumePreparedTransaction(
  input: FolderRefreshInput,
): Promise<FolderRefreshOutcome | null> {
  return resumeWith(input, await operatorOf(input), boundedRun(input));
}

async function operatorOf(input: FolderRefreshInput) {
  try {
    return await input.operatorFolder?.();
  } catch {
    return undefined;
  }
}

/** The active version's command, bounded. When the bound runs out the child
 * is killed only while this process holds the Folder's operation lock: a
 * child that holds it is inside its change (its transaction), and one whose
 * lock cannot be verified may be, so either is given another period instead, because killing it there leaves a prepared
 * transaction that blocks the Folder and the Launchpad (#1205); and while
 * this process holds it, the child cannot enter one before it is gone. */
function boundedRun(input: FolderRefreshInput) {
  const run = input.run ?? runProcess;
  const killOutsideChange = async (kill: () => Promise<void>) => {
    try {
      await withFolderOperationLock(
        join(input.folder, ".lazurio"),
        () => kill(),
        0,
      );
      return true;
    } catch {
      // Held by the child or another change, or the lock could not be
      // verified at all (an I/O error, no descriptor left): nothing shows
      // that the child is outside its transaction, so it is kept.
      return false;
    }
  };
  return (command: readonly string[]) =>
    run(
      [
        ...(input.detach === true ? detachedPrefix : []),
        layout(input.base).selector,
        ...command,
      ],
      input.timeoutMs ?? refreshTimeoutMs,
      serviceEnvironment(input.env),
      killOutsideChange,
    );
}

async function resumeWith(
  input: FolderRefreshInput,
  operator: string | undefined,
  bounded: ReturnType<typeof boundedRun>,
): Promise<FolderRefreshOutcome | null> {
  const target = await preparedRevision(input.folder);
  if (target === null) return null;
  const resume = async (): Promise<FolderRefreshOutcome> => {
    let result: ProcessResult | null;
    try {
      result = await bounded([
        "profile-resume",
        "--folder",
        input.folder,
        "--target-revision",
        String(target),
      ]);
    } catch {
      result = null;
    }
    // An answer that was lost (the child cut off, its output unreadable) is
    // read from the Folder: a transaction no longer pending was finished.
    return recovered(result) || !(await transactionPending(input.folder))
      ? Object.freeze({ state: "refreshed" as const })
      : failedRefresh("transaction-pending");
  };
  if (operator !== input.folder) return resume();
  // The hosted operator's Launchpad refused to start on the pending
  // transaction. Its restart is owed BEFORE the transaction is finished, under
  // the same restart lock `machine folder-refresh` takes, so that no failure
  // after the recovery (this process dying included) can lose it: the refresh
  // that follows, now or in the next run, restarts the Launchpad and clears
  // the debt. A debt that cannot be recorded stops the recovery.
  const owed = layout(input.base).launchpadRestartOwed;
  const lockDirectory = join(dirname(owed), "launchpad-restart");
  try {
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  } catch {
    return failedRefresh("launchpad-restart-unrecordable");
  }
  try {
    return await withFolderOperationLock(
      lockDirectory,
      async () => {
        const owedBefore = await restartOwedFor(owed, input.folder);
        if (!owedBefore)
          try {
            await recordRestartOwed(owed, input.folder);
          } catch {
            return failedRefresh("launchpad-restart-unrecordable");
          }
        // The debt stays whatever the recovery answers: the Launchpad may be
        // in Recovery mode already, and a refused or interrupted recovery may
        // be finished later by hand. Only a successful restart clears it
        // (`machine folder-refresh`).
        return resume();
      },
      0,
    );
  } catch (error) {
    return error instanceof FolderOperationBusyError
      ? blockedRefresh("folder-busy")
      : failedRefresh("launchpad-restart-unrecordable");
  }
}

const transactionOf = (folder: string) =>
  join(folder, ".lazurio", "transaction");

/** Whether the Folder still has a transaction directory; one that cannot be
 * told apart counts as pending. */
async function transactionPending(folder: string): Promise<boolean> {
  try {
    await lstat(transactionOf(folder));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** The revision a prepared transaction moves the Folder to (its marker's
 * `nextRevision`), or null when there is none or it cannot be read: an
 * incomplete preparation without a marker is not resumed here. */
async function preparedRevision(folder: string): Promise<number | null> {
  try {
    const marker = JSON.parse(
      await readFile(join(transactionOf(folder), "prepared.json"), "utf8"),
    ) as { nextRevision?: unknown };
    const next = marker.nextRevision;
    return typeof next === "number" && Number.isSafeInteger(next) && next >= 2
      ? next
      : null;
  } catch {
    return null;
  }
}

/** `profile-resume` answered that it finished the transaction. */
function recovered(result: ProcessResult | null): boolean {
  if (result === null || result === "timeout" || result.exitCode !== 0)
    return false;
  try {
    const answer = JSON.parse(result.stdout) as { kind?: unknown };
    return answer.kind === "recovered";
  } catch {
    return false;
  }
}
