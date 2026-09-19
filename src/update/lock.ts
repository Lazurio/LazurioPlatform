import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import {
  closeOnExecFlag,
  lockDirectoryDescriptor,
} from "../folder/native-lock";
import { UpdateFailure } from "./errors";

/** One lock covers one update step (docs/update.md "The three steps": acquired
 * blocking with a timeout, crash-safe initialization, any local filesystem
 * that provides `flock`).
 *
 * TODO(docs/update.md, lock paragraph): converge with `src/folder/lock.ts` in
 * its own change. That helper cannot serve this contract today because it
 * (a) refuses every filesystem except APFS and ext (lock.ts:14-19),
 * (b) wedges forever when a process dies between `mkdir` of the lock
 *     directory (lock.ts:23) and the durable `protocol` marker
 *     (lock.ts:57-67): every later acquisition takes the "unrecognized lock"
 *     refusal at lock.ts:29-32, deliberately ("never adopted on retry",
 *     lock.ts:58). A second process that arrives inside that same window
 *     while the first is alive and healthy gets the same hard refusal. Any
 *     stray entry in the directory, or a half-written marker, refuses equally
 *     (lock.ts:70-74, 84-92), and
 * (c) never waits: `flock` is called with LOCK_NB only, so a concurrent
 *     holder is an immediate failure (native-lock.ts:16-18).
 *
 * This acquisition has no initialization to interrupt: `O_CREAT` of one
 * regular file is atomic and idempotent, the file's content is never read, and
 * the kernel releases `flock` when the descriptor closes or the process dies,
 * so no stale state can exist. The file is never unlinked — a waiter may hold
 * a descriptor to it, and unlinking would create two lock domains. If someone
 * else replaces it anyway, the identity check below retries on the new inode.
 */
export type UpdateLock = Readonly<{ release(): Promise<void> }>;

// The descriptor IS the lock. A handle that became unreachable would be closed
// by garbage collection and silently release it, so held handles stay rooted
// here until `release`.
const heldHandles = new Set<FileHandle>();

// The pinned FFI helper reports every failure alike (it cannot read errno), so
// a filesystem without `flock` surfaces as `busy` after the timeout rather
// than as its own code.
function tryLock(descriptor: number): boolean {
  try {
    lockDirectoryDescriptor(descriptor);
    return true;
  } catch {
    return false;
  }
}

export async function acquireUpdateLock(
  path: string,
  options: Readonly<{
    timeoutMs: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }>,
): Promise<UpdateLock> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    throw new Error("Invalid lock timeout");
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 50;
  // Throws on a platform without the qualified native call; that is a product
  // defect (`internal`), not contention.
  const cloexec = closeOnExecFlag();
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const handle = await open(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | cloexec,
      0o600,
    );
    try {
      if (tryLock(handle.fd)) {
        const opened = await handle.stat();
        const current = await lstat(path).catch(() => undefined);
        // Otherwise an inode that is no longer the lock was locked: retry.
        if (
          current?.isFile() &&
          current.dev === opened.dev &&
          current.ino === opened.ino
        ) {
          heldHandles.add(handle);
          return Object.freeze({
            async release() {
              if (!heldHandles.delete(handle)) return;
              await handle.close();
            },
          });
        }
      }
    } catch (error) {
      await handle.close();
      throw error;
    }
    await handle.close();
    if (now() >= deadline) throw new UpdateFailure("busy");
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
