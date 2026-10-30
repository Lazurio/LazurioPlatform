import { neededRefresh } from "../folder/refresh-needed";
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
}>;

/** A refresh that did not complete, by how it failed. */
export const failedRefresh = (reason: string): FolderRefreshOutcome =>
  Object.freeze({ state: "failed" as const, reason });

// The product's codes and a path within the Folder, never anything else the
// child printed.
const code = /^[a-z][a-z0-9-]{0,63}$/;

// A character that is not shown as itself: a C0 or C1 control (ESC starts a
// terminal escape), DEL, or an invisible or bidirectional format character
// that makes a path read differently than it is.
const invisible = (point: number) =>
  point < 0x20 ||
  (point >= 0x7f && point <= 0x9f) ||
  point === 0xad ||
  point === 0x61c ||
  point === 0x180e ||
  (point >= 0x200b && point <= 0x200f) ||
  (point >= 0x2028 && point <= 0x202e) ||
  (point >= 0x2060 && point <= 0x206f) ||
  point === 0xfeff;

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
  ![...value].some((character) => invisible(character.codePointAt(0) ?? 0)) &&
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
 * meanwhile is `unchanged`. Never throws. */
export async function refreshFolderWhenBehind(
  input: FolderRefreshInput,
): Promise<FolderRefreshOutcome | null> {
  const run = input.run ?? runProcess;
  const retry = input.retry ?? refreshRetry;
  let operator: string | undefined;
  try {
    operator = await input.operatorFolder?.();
  } catch {
    operator = undefined;
  }
  let refused: FolderRefreshOutcome | null = null;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    if (attempt > 1) await Bun.sleep(retry.delayMs);
    const needed = await neededRefresh(input.folder, input.product, operator);
    if (needed === null)
      return refused === null
        ? null
        : Object.freeze({ state: "unchanged" as const });
    let result: ProcessResult | null;
    try {
      result = await run(
        [layout(input.base).selector, ...needed.command],
        input.timeoutMs ?? refreshTimeoutMs,
        serviceEnvironment(input.env),
      );
    } catch {
      result = null;
    }
    const outcome = outcomeOf(result);
    if (!retryable(outcome)) return outcome;
    refused = outcome;
  }
  return refused;
}
