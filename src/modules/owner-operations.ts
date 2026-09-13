import { inspectOwnedDirectory } from "../folder/owned-directory";

// One instance belongs to the shared lifecycle owner. Callers resolve the actual
// package/workspace dependency owner first; an app path is not a fallback owner.
// This serializes cooperative operations within that owner process only. It is
// not a cross-process lock, authorization, or protection against hostile renames.
export function createOwnerOperations(
  inspect: typeof inspectOwnedDirectory = inspectOwnedDirectory,
) {
  const pending = new Map<string, Promise<void>>();
  let admission = Promise.resolve();
  let closing = false;
  async function run<T>(
    directory: string,
    action: () => Promise<T>,
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
      return action();
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
  return Object.freeze({
    run,
    async close() {
      closing = true;
      await Promise.all(pending.values());
    },
  });
}
