import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  closeOnExecFlag,
  darwinFilesystemName,
  FolderOperationBusyError,
  lockDirectoryDescriptor,
} from "./native-lock";

export { FolderOperationBusyError };

import { inspectOwnedDirectory } from "./owned-directory";

const marker = "lazurio-directory-flock-v1\n";

// One persistent inode per explicit owner. Never unlink it: a waiter may still
// reference it, producing two lock domains. Unmarked old locks stay refused.
export async function acquireFolderOperationLock(stateDirectory: string) {
  return acquireLock(stateDirectory, undefined);
}

/** `ownRead`, the key of this process's short read, counts the lock as such
 * a read from the moment the kernel grants it until it is released, in the
 * same synchronous step as the grant and the release: a mutation of this
 * process that finds the lock busy then always knows whether its own read
 * holds it, also while the read still verifies and syncs the lock (#272's
 * wait, issue #413). */
async function acquireLock(
  stateDirectory: string,
  ownRead: string | undefined,
) {
  const cloexec = closeOnExecFlag();
  const parent = await inspectOwnedDirectory(stateDirectory);
  // Qualification: ext4 by its stable magic number; APFS by name, because the
  // darwin `f_type` number is assigned at boot and not stable (native-lock.ts).
  // The observed value is named so an unqualified mount identifies itself.
  const filesystem =
    process.platform === "darwin"
      ? darwinFilesystemName(stateDirectory)
      : String((await statfs(stateDirectory)).type);
  if (
    (process.platform === "darwin" && filesystem !== "apfs") ||
    (process.platform === "linux" && filesystem !== String(0xef53))
  )
    throw new Error(
      `Unqualified lock filesystem (${process.platform} ${filesystem})`,
    );
  const path = join(stateDirectory, ".operation-lock");
  let created = false;
  try {
    await mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const observed = await inspectOwnedDirectory(path);
  if (!created && !(await readdir(path)).includes("protocol"))
    throw new FolderOperationBusyError(
      "Folder operation busy or requires recovery; unrecognized lock",
    );
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | cloexec,
  );
  let released = false;
  let countedRead = false;
  // The descriptor's close releases the kernel lock; only then does this
  // process's read stop counting.
  const close = async () => {
    const counted = countedRead;
    countedRead = false;
    released = true;
    try {
      await handle.close();
    } finally {
      if (counted && ownRead !== undefined) uncountOwnRead(ownRead);
    }
  };
  try {
    const opened = await handle.stat();
    const assertIdentity = async () => {
      if (released) throw new Error("Folder operation lock released");
      const currentParent = await inspectOwnedDirectory(stateDirectory);
      const current = await inspectOwnedDirectory(path);
      if (
        currentParent.dev !== parent.dev ||
        currentParent.ino !== parent.ino ||
        opened.dev !== parent.dev ||
        opened.dev !== observed.dev ||
        opened.ino !== observed.ino ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      )
        throw new Error("Folder operation lock changed; recovery required");
    };
    await assertIdentity();
    lockDirectoryDescriptor(handle.fd);
    if (ownRead !== undefined) {
      countOwnRead(ownRead);
      countedRead = true;
    }
    if (created) {
      // Interrupted initialization stays unrecognized, never adopted on retry.
      await assertIdentity();
      const file = await open(join(path, "protocol"), "wx", 0o600);
      try {
        await file.writeFile(marker);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const assertHeld = async () => {
      await assertIdentity();
      const entries = await readdir(path);
      if (entries.length !== 1 || entries[0] !== "protocol")
        throw new Error(
          "Folder operation busy or requires recovery; unrecognized lock",
        );
      const file = await open(
        join(path, "protocol"),
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          cloexec,
      );
      try {
        const before = await file.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.uid !== process.getuid?.() ||
          (before.mode & 0o022) !== 0 ||
          before.dev !== opened.dev ||
          before.size !== Buffer.byteLength(marker)
        )
          throw new Error("Unsafe lock protocol; recovery required");
        const bytes = Buffer.alloc(Buffer.byteLength(marker));
        const read = await file.read(bytes, 0, bytes.length, 0);
        const after = await lstat(join(path, "protocol"));
        if (
          read.bytesRead !== bytes.length ||
          bytes.toString() !== marker ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.ctimeMs !== before.ctimeMs ||
          after.size !== before.size
        )
          throw new Error("Lock protocol changed; recovery required");
      } finally {
        await file.close();
      }
      await assertIdentity();
    };
    await assertHeld();
    await handle.sync();
    const parentHandle = await open(
      stateDirectory,
      constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        cloexec,
    );
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    return Object.freeze({
      assertHeld,
      async release() {
        try {
          await assertHeld();
        } finally {
          await close();
        }
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}

/** This process's short reads that hold the lock now, by state directory,
 * and how many of them have ended. A mutation of this process waits a
 * bounded moment for them (issue #272): the shell setup cache starts its
 * background read right after a profile change, and the person's next change
 * must not fail as busy because of the Launchpad's own read. It never waits
 * for another process. A read counts from the kernel's grant to its release
 * (`acquireLock`); one that ended while a refused mutation was on its way is
 * waited for too, because it may have been what refused it. */
const ownReads = new Map<string, Readonly<{ held: number; ended: number }>>();

function countOwnRead(key: string) {
  const reads = ownReads.get(key) ?? { held: 0, ended: 0 };
  ownReads.set(key, { held: reads.held + 1, ended: reads.ended });
}

function uncountOwnRead(key: string) {
  const reads = ownReads.get(key) ?? { held: 1, ended: 0 };
  ownReads.set(key, { held: reads.held - 1, ended: reads.ended + 1 });
}

/** How long a mutation of this process waits for its own short reads. */
export const ownReadWaitMs = 3_000;

/** A mutation under the lock. It refuses at once when another process holds
 * the lock, or this process's own mutation does; only this process's short
 * read (`withFolderReadLock`) is waited for, `waitForOwnReadsMs` at most. */
export async function withFolderOperationLock<T>(
  stateDirectory: string,
  operation: (assertHeld: () => Promise<void>) => Promise<T>,
  waitForOwnReadsMs = ownReadWaitMs,
): Promise<T> {
  const key = resolve(stateDirectory);
  const deadline = Date.now() + waitForOwnReadsMs;
  for (let attempt = 1; ; attempt += 1) {
    const endedBefore = ownReads.get(key)?.ended ?? 0;
    let lock: Awaited<ReturnType<typeof acquireFolderOperationLock>>;
    try {
      lock = await acquireFolderOperationLock(stateDirectory);
    } catch (error) {
      const reads = ownReads.get(key);
      const ownRead =
        reads !== undefined && (reads.held > 0 || reads.ended !== endedBefore);
      if (
        !(error instanceof FolderOperationBusyError) ||
        !ownRead ||
        Date.now() >= deadline
      )
        throw error;
      await Bun.sleep(Math.min(10 * attempt, 100));
      continue;
    }
    try {
      return await operation(lock.assertHeld);
    } finally {
      await lock.release();
    }
  }
}

/** Holds the lock for one short read, counted as this process's own while
 * the kernel grants it: a mutation that finds the lock busy meanwhile knows
 * whom it waits for. */
async function ownRead<T>(
  stateDirectory: string,
  operation: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(stateDirectory, resolve(stateDirectory));
  try {
    return await operation(lock.assertHeld);
  } finally {
    await lock.release();
  }
}

/** A short READ of the Folder's state under the same lock, for readers that
 * run beside each other in one process (the Launchpad's status, the Team
 * rule's preset reads of a running gh session, a poll): the lock is
 * exclusive and non-blocking, so two such reads at the same moment would
 * refuse one of them as busy. A read waits for the holder instead, a
 * bounded time (default 3 s), and then fails as before. A mutation of this
 * process waits for such a read (`withFolderOperationLock`); one of another
 * process is refused at once. */
export async function withFolderReadLock<T>(
  stateDirectory: string,
  operation: (assertHeld: () => Promise<void>) => Promise<T>,
  waitMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await ownRead(stateDirectory, operation);
    } catch (error) {
      if (
        !(error instanceof FolderOperationBusyError) ||
        Date.now() >= deadline
      )
        throw error;
      await Bun.sleep(Math.min(10 * attempt, 100));
    }
  }
}
