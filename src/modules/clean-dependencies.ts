import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import {
  type inspectInstallAuthority,
  verifyInstallAuthority,
} from "./install-authority";

// Explicit effect under the existing dependency-owner lock, after stopping the
// selected owned app. Caller maintains cooperative filesystem custody throughout.
// No arbitrary path, ancestor fallback, global cache, source or database cleanup.
export async function cleanDerivedDependencies(
  authority: Awaited<ReturnType<typeof inspectInstallAuthority>>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!(await verifyInstallAuthority(authority)))
    return { kind: "authority-changed" as const };
  const target = join(authority.owner, "node_modules");
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "dependencies-absent" as const };
    throw error;
  }
  const identity = await inspectOwnedDirectory(target);
  if (String(identity.dev) !== authority.ownerIdentity.split(":")[0])
    throw new Error("Dependency root is a separate filesystem");
  // Refuse nested mounts and explicit Git metadata. Descendant symlinks are
  // directory entries only: never inspect or delete their external destinations.
  const inspect = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const name of await readdir(directory)) {
      signal?.throwIfAborted();
      if (name === ".git")
        throw new Error("Git metadata inside dependency cleanup scope");
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.dev !== identity.dev || stat.uid !== process.getuid?.())
        throw new Error("Foreign dependency tree");
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await inspectOwnedDirectory(path);
        await inspect(path);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("Non-derived dependency entry");
      }
    }
  };
  await inspect(target);
  if (!(await verifyInstallAuthority(authority)))
    return { kind: "authority-changed" as const };
  const current = await inspectOwnedDirectory(target);
  if (current.dev !== identity.dev || current.ino !== identity.ino)
    return { kind: "authority-changed" as const };
  signal?.throwIfAborted();
  // Once recursive removal starts, await completion: cancellation cannot roll it
  // back or release owner coordination while filesystem effects are still active.
  await rm(target, { recursive: true, force: false });
  signal?.throwIfAborted();
  return { kind: "dependencies-removed" as const };
}
