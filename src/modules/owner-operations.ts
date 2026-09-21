import { inspectOwnedDirectory } from "../folder/owned-directory";
import { acquireRetainedOperationLock } from "../folder/retained-lock";

// One instance belongs to the shared lifecycle owner. Callers resolve the actual
// package/workspace dependency owner first; an app path is not a fallback owner.
// Retain cooperative filesystem exclusion until the lifecycle confirms cleanup.
// This is not authorization or protection against hostile same-user renames.
export function createOwnerOperations(
  inspect: typeof inspectOwnedDirectory = inspectOwnedDirectory,
) {
  const pending = new Map<string, Promise<void>>();
  const locks = new Map<
    string,
    Awaited<ReturnType<typeof acquireRetainedOperationLock>>
  >();
  let releaseQueue = Promise.resolve();
  let admission = Promise.resolve();
  let closing = false;
  // `complete`, when given, decides after the action whether the transaction is
  // complete with confirmed cleanup. Only then is the retained lock released
  // early; a throw, an unconfirmed cleanup or the holder's death keep it.
  async function run<T>(
    directory: string,
    action: () => Promise<T>,
    complete?: (result: T) => boolean,
  ): Promise<T> {
    if (closing) throw new Error("Owner operations closing");
    // Serialize admission, not execution: asynchronous custody inspection must
    // not let a later start overtake an earlier install for the same owner.
    const previousAdmission = admission;
    let releaseAdmission = () => {};
    admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    await previousAdmission;
    let before: Awaited<ReturnType<typeof inspect>>;
    try {
      if (closing) throw new Error("Owner operations closing");
      before = await inspect(directory);
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    releaseAdmission();
    if (closing) throw new Error("Owner operations closing");
    // Filesystem identity merges aliases of the same observed owner. Canonical
    // owned paths are required by inspectOwnedDirectory before accepting work.
    const key = `${before.dev}:${before.ino}`;
    const previous = pending.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      const current = await inspect(directory);
      if (before.dev !== current.dev || before.ino !== current.ino)
        throw new Error("Dependency owner changed while queued");
      let lock = locks.get(key);
      if (!lock) {
        lock = await acquireRetainedOperationLock(directory);
        locks.set(key, lock);
      }
      await lock.assertHeld();
      const held = await inspect(directory);
      if (before.dev !== held.dev || before.ino !== held.ino)
        throw new Error("Dependency owner changed before execution");
      const value = await action();
      if (complete?.(value) && locks.get(key) === lock) {
        await lock.release();
        locks.delete(key);
      }
      return value;
    });
    const settled = result.then(
      () => {},
      () => {},
    );
    pending.set(key, settled);
    void settled.then(() => {
      if (pending.get(key) === settled) pending.delete(key);
    });
    return result;
  }
  async function drain() {
    closing = true;
    await Promise.all(pending.values());
  }
  return Object.freeze({
    run,
    // Whether THIS owner currently retains the lock of that directory.
    async holds(directory: string) {
      const stat = await inspect(directory);
      return locks.has(`${stat.dev}:${stat.ino}`);
    },
    drain,
    async close() {
      await drain();
      const released = releaseQueue.then(async () => {
        for (const [key, lock] of locks) {
          await lock.release();
          locks.delete(key);
        }
      });
      releaseQueue = released.catch(() => {});
      return released;
    },
  });
}
