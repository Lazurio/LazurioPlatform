// Dependency operations may have surviving writers after their owner exits.
// Retain the previous protocol until lifecycle cleanup is proven. Native Folder
// locks refuse this unmarked directory; this adapter refuses any occupied path.
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "./owned-directory";

// One lock per explicitly bound local state owner. Callers must use that same
// directory, check pending recovery under the lock, and recheck before mutation.
// This development adapter is not yet native-qualified for Windows/network FS.
export async function acquireRetainedOperationLock(stateDirectory: string) {
  if (process.platform === "win32")
    throw new Error("Unqualified lock platform");
  const parent = await inspectOwnedDirectory(stateDirectory);
  const path = join(stateDirectory, ".operation-lock");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Folder operation busy or requires recovery");
    throw error;
  }
  const created = await lstat(path);
  const assertHeld = async () => {
    const currentParent = await inspectOwnedDirectory(stateDirectory);
    const current = await lstat(path);
    if (
      currentParent.dev !== parent.dev ||
      currentParent.ino !== parent.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== created.dev ||
      current.ino !== created.ino
    )
      throw new Error("Folder operation lock changed; recovery required");
  };
  await assertHeld();
  return Object.freeze({
    assertHeld,
    async release() {
      // Never remove a replaced lock, recursively erase unexpected content or
      // reclaim an old lock on age alone. A killed process leaves a blocking lock.
      await assertHeld();
      await rmdir(path);
    },
  });
}
