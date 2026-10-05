import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import {
  acquireFileLock,
  type FileLock,
  FileLockError,
} from "../platform/flock";

// One content operation at a time per Folder, across the CLI and the
// Launchpad: a kernel `flock` on one file per Folder in the install base's
// `content/` directory (beside the product's own `update/lock`; the Folder's
// `.lazurio/` admits no foreign entry). Coordination only, as `flock.ts`
// requires: nothing on disk needs a retained owner record, because every
// intermediate state is a temporary sibling the next holder recognizes as
// its own and removes, and every destination is published atomically.

/** The lock file of one Folder (its canonical path) in `lockDirectory`. */
export function contentLockFile(lockDirectory: string, folder: string) {
  const digest = createHash("sha256").update(folder).digest("hex");
  return join(lockDirectory, `content-${digest.slice(0, 32)}.lock`);
}

/** The Folder's content lock, or null when another operation holds it. */
export async function tryContentLock(
  lockDirectory: string,
  folder: string,
): Promise<FileLock | null> {
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  await inspectOwnedDirectory(lockDirectory);
  try {
    return await acquireFileLock(contentLockFile(lockDirectory, folder), {
      timeoutMs: 0,
    });
  } catch (error) {
    if (error instanceof FileLockError && error.reason === "busy") return null;
    throw error;
  }
}
