import { stat } from "node:fs/promises";
import { acquireFileLock, FileLockError } from "../platform/flock";
import { storageFailure, UpdateFailure } from "./errors";
import {
  deletePending,
  ensureLayout,
  layout,
  markerState,
  pruneVersions,
  raiseHighWater,
  readHighWater,
  readPending,
  readPrevious,
  readSelector,
  setPrevious,
  swapSelector,
  versionExecutable,
  writePending,
} from "./layout";
import { type ServiceControl, waitForLaunchpad } from "./service-control";

/** Activation (docs/update.md "Activation"): one path for an update and for a
 * rollback. Every step is durable before the next, so a Machine that loses
 * power at any instant is either on the old version with at most a stale
 * marker, or on the new one with `pending.json` saying how to finish or undo.
 */

/** ONE kernel `flock` for every mutating update operation. The kernel drops it
 * when the holder dies, so a crashed updater never blocks the next one.
 */
export async function withUpdateLock<T>(
  base: string,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    await ensureLayout(base);
    lock = await acquireFileLock(layout(base).lock, { timeoutMs });
  } catch (error) {
    if (error instanceof FileLockError)
      throw error.reason === "busy"
        ? new UpdateFailure("busy")
        : new UpdateFailure("storage-unavailable", { stage: "lock" });
    throw storageFailure(error, "lock");
  }
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

/** Names of the durable steps, in order; tests stop the process after each. */
export type ActivationStep =
  | "previous"
  | "pending"
  | "switch"
  | "restarted"
  | "high-water";

export type ActivationInput = Readonly<{
  base: string;
  to: string;
  /** Null: not supervised — the switch is the commit and there is no marker. */
  service: ServiceControl | null;
  healthDeadlineMs?: number | undefined;
  afterStep?: ((step: ActivationStep) => void | Promise<void>) | undefined;
}>;

/** Commit: raise the high-water mark, delete the marker, prune. Only a
 * committed version ever raises the mark.
 */
async function commit(
  base: string,
  to: string,
  afterStep?: ActivationInput["afterStep"],
) {
  try {
    await raiseHighWater(base, to);
    await afterStep?.("high-water");
    await deletePending(base);
  } catch (error) {
    throw storageFailure(error, "commit");
  }
  await pruneVersions(base).catch(() => undefined);
}

/** Undo: switch back, restart, delete the marker. */
async function undo(
  base: string,
  from: string,
  service: ServiceControl | null,
) {
  try {
    await swapSelector(base, from);
  } catch (error) {
    throw storageFailure(error, "switch-back");
  }
  // The selector is already right; a restart that fails here is retried by
  // the service manager and must not keep the marker alive.
  await service?.restartLaunchpad().catch(() => undefined);
  await deletePending(base);
}

/** Under the update lock, after the marker was reconciled; `versions/<to>` is
 * staged and passed its self-check. Returns once the activation is committed
 * and throws `activation-failed` after it was undone.
 */
export async function activate(input: ActivationInput): Promise<void> {
  const { base, to, service } = input;
  const step = async (name: ActivationStep) => input.afterStep?.(name);
  const from = await readSelector(base);
  if (from === null) throw new UpdateFailure("not-installed");
  try {
    await setPrevious(base, from);
    await step("previous");
    if (service) {
      await writePending(base, { from, to });
      await step("pending");
    }
    await swapSelector(base, to);
    await step("switch");
  } catch (error) {
    // Nothing was restarted. Put the selector back if it moved at all; a
    // marker with the selector on `from` is stale and the next holder of the
    // lock deletes it.
    if ((await readSelector(base)) === to)
      await swapSelector(base, from).catch(() => undefined);
    throw storageFailure(error, "activate");
  }
  if (!service) return commit(base, to, input.afterStep);
  const healthy = await service
    .restartLaunchpad()
    .then(async () => {
      await step("restarted");
      return waitForLaunchpad(service, to, {
        deadlineMs: input.healthDeadlineMs,
      });
    })
    .catch(() => false);
  if (healthy) return commit(base, to, input.afterStep);
  await undo(base, from, service);
  throw new UpdateFailure("activation-failed", { from, to });
}

export type Reconciled = "none" | "discarded" | "committed" | "undone";

/** A mutating update command, under the lock, before anything else
 * (docs/update.md "Reconciling the marker"): a stale marker is deleted; a
 * switched, uncommitted activation is decided by asking the service ONCE —
 * healthy at `to` commits, anything else undoes. The command then continues.
 * Every state a crash cannot produce throws `state-invalid` untouched.
 */
export async function reconcilePending(input: {
  base: string;
  service: ServiceControl | null;
}): Promise<Reconciled> {
  // An unreadable mark is `state-invalid` too, whatever the marker says.
  await readHighWater(input.base);
  const state = await markerState(input.base);
  if (state.kind === "absent") return "none";
  if (state.kind === "not-switched") {
    await deletePending(input.base);
    return "discarded";
  }
  if ((await input.service?.launchpadVersion()) === state.pending.to) {
    await commit(input.base, state.pending.to);
    return "committed";
  }
  await undo(input.base, state.pending.from, input.service);
  return "undone";
}

/** `lazurio update rollback --auto`, run by `lazurio-rollback.service` when the
 * Launchpad unit hit its start limit: it undoes a switched, uncommitted
 * activation and in every other row does nothing. A held lock is an updater
 * that is alive and undoes its own activation.
 */
export async function automaticRollback(input: {
  base: string;
  service: ServiceControl | null;
}): Promise<Reconciled> {
  try {
    return await withUpdateLock(input.base, 0, async () => {
      const state = await markerState(input.base);
      if (state.kind !== "switched") return "none";
      await undo(input.base, state.pending.from, input.service);
      return "undone";
    });
  } catch (error) {
    if (error instanceof UpdateFailure && error.failure.code === "busy")
      return "none";
    throw error;
  }
}

/** A starting Launchpad: one of version `to` that started healthy commits the
 * activation whose updater is gone (power loss). While an updater lives it
 * holds the lock and commits itself; this waits longer than any updater polls.
 */
export async function reconcileAsLaunchpad(input: {
  base: string;
  version: string;
  lockTimeoutMs?: number | undefined;
}): Promise<Reconciled> {
  if ((await readPending(input.base)) === null) return "none";
  return withUpdateLock(input.base, input.lockTimeoutMs ?? 45_000, async () => {
    const state = await markerState(input.base);
    if (state.kind === "absent") return "none";
    if (state.kind === "not-switched") {
      await deletePending(input.base);
      return "discarded";
    }
    if (state.pending.to !== input.version) return "none";
    await commit(input.base, state.pending.to);
    return "committed";
  });
}

/** The rollback target, or why there is none. */
export async function rollbackTarget(base: string): Promise<string> {
  const active = await readSelector(base);
  if (active === null) throw new UpdateFailure("not-installed");
  const previous = await readPrevious(base);
  if (previous === null || previous === active)
    throw new UpdateFailure("rollback-unavailable", { reason: "none" });
  const executable = await stat(versionExecutable(base, previous)).catch(
    () => undefined,
  );
  if (!executable?.isFile())
    throw new UpdateFailure("rollback-unavailable", { reason: "missing" });
  return previous;
}
