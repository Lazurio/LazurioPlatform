import { acquireFileLock, FileLockError } from "../platform/flock";
import { storageFailure, UpdateFailure } from "./errors";
import {
  ensureLayout,
  layout,
  pruneVersions,
  raiseHighWater,
  readSelector,
  swapSelector,
} from "./layout";
import { type ServiceControl, waitForLaunchpad } from "./service-control";

/** Activation (docs/update.md "Activation"): the candidate proved itself
 * before this runs (self-check and Launchpad probe), so the switch of
 * `bin/lazurio` is ONE rename and the commit. After it the only direction is
 * forward: nothing here ever selects an earlier version again.
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

/** Names of the steps, in order; tests stop the process after each. */
export type ActivationStep = "switch" | "high-water" | "restarted";

export type ActivationInput = Readonly<{
  base: string;
  to: string;
  /** Null: not supervised — a running Launchpad finishes by restarting. */
  service: ServiceControl | null;
  healthDeadlineMs?: number | undefined;
  afterStep?: ((step: ActivationStep) => void | Promise<void>) | undefined;
}>;

/** Under the update lock; `versions/<to>` is staged and passed its self-check
 * and Launchpad probe. Returns once `to` is active and, supervised, its
 * Launchpad reports it; throws `activation-unhealthy` when it does not, with
 * `to` still active.
 */
export async function activate(input: ActivationInput): Promise<void> {
  const { base, to, service } = input;
  const step = async (name: ActivationStep) => input.afterStep?.(name);
  const from = await readSelector(base);
  if (from === null) throw new UpdateFailure("not-installed");
  // One rename: a reader, or a Machine that loses power, sees `from` or `to`,
  // never neither. A failure here changed nothing.
  try {
    await swapSelector(base, to);
  } catch (error) {
    throw storageFailure(error, "activate");
  }
  await step("switch");
  // The mark follows the switch. A crash in between leaves it below the
  // active version, which the floor already covers (the higher of the two).
  await raiseHighWater(base, to).catch(() => undefined);
  await step("high-water");
  await pruneVersions(base).catch(() => undefined);
  if (!service) return;
  const healthy = await service
    .restartLaunchpad()
    .then(async () => {
      await step("restarted");
      return waitForLaunchpad(service, to, {
        deadlineMs: input.healthDeadlineMs,
      });
    })
    .catch(() => false);
  if (!healthy) throw new UpdateFailure("activation-unhealthy", { from, to });
}
