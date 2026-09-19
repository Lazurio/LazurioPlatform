import { dlopen, type Pointer, read } from "bun:ffi";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

// Coordination-only exclusion: one kernel `flock` on one regular file. The
// kernel releases it when the descriptor closes or the holder dies, so a crashed
// holder can never block the next one and there is no owner record to recover.
// Use it ONLY where no intermediate state on disk needs protecting — where the
// next holder re-reads the truth from its real owner and converges. A
// transaction that can die half-written keeps a retained lock instead
// (`src/folder/retained-lock.ts`): there, owner death must not admit a new writer.
//
// Neutral, dependency-free primitive. The update slice carries an equivalent
// private implementation (`src/update/lock.ts` on its own branch) and can adopt
// this one: map `FileLockError.reason` to its own failure type.
export class FileLockError extends Error {
  constructor(readonly reason: "busy" | "unsupported") {
    super(
      reason === "busy"
        ? "Lock held by another operation"
        : "Filesystem does not support advisory locks",
    );
    this.name = "FileLockError";
  }
}
export type FileLock = Readonly<{ release(): Promise<void> }>;
export type LockAttempt = (
  descriptor: number,
) => "locked" | "contended" | "unsupported";

let library: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Unqualified lock platform");
  const flock = { args: ["i32", "i32"], returns: "i32" } as const;
  // Address of the calling thread's errno; the symbol differs per libc.
  const errno = { args: [], returns: "ptr" } as const;
  if (process.platform === "darwin") {
    const native = dlopen("/usr/lib/libSystem.B.dylib", {
      flock,
      __error: errno,
    });
    return {
      flock: native.symbols.flock,
      errnoAddress: native.symbols.__error,
    };
  }
  const native = dlopen("libc.so.6", { flock, __errno_location: errno });
  return {
    flock: native.symbols.flock,
    errnoAddress: native.symbols.__errno_location,
  };
}

// EINVAL, ENOLCK and ENOTSUP/EOPNOTSUPP of the two qualified platforms: errno
// values that mean "this filesystem cannot flock", never "someone holds it".
const unsupportedErrno: Readonly<Record<string, readonly number[]>> = {
  darwin: [22, 77, 45, 102],
  linux: [22, 37, 95],
};

// One non-blocking exclusive `flock`. Every failure that is not provably
// "unsupported" stays `contended`: a misread errno can at worst become a
// timeout, never a second holder.
export const tryLockDescriptor: LockAttempt = (descriptor) => {
  library ??= load();
  if (library.flock(descriptor, 2 | 4) === 0) return "locked";
  const address = library.errnoAddress() as Pointer | null;
  const errno = address === null ? 0 : read.i32(address, 0);
  return (unsupportedErrno[process.platform] ?? []).includes(errno)
    ? "unsupported"
    : "contended";
};

function closeOnExec() {
  if (process.platform === "darwin") return 0x01000000;
  if (process.platform === "linux") return 0x80000;
  throw new Error("Unqualified lock platform");
}

// The descriptor IS the lock. A handle that became unreachable would be closed by
// garbage collection and silently release it, so held handles stay rooted here.
const held = new Set<FileHandle>();

// Acquired blocking with a bounded wait (polled; `flock` itself is never called
// blocking, so the event loop and the deadline stay in control). `O_CREAT` of one
// regular file is atomic and idempotent and its content is never read: there is no
// initialization to interrupt. The file is never unlinked — a waiter may hold a
// descriptor to it, and unlinking would create two lock domains. If it is replaced
// anyway, the identity check retries on the new inode.
export async function acquireFileLock(
  path: string,
  options: Readonly<{
    timeoutMs: number;
    pollMs?: number;
    sleep?: (milliseconds: number) => Promise<unknown>;
    now?: () => number;
    // The native call; injected only to prove the classification.
    tryLock?: LockAttempt;
  }>,
): Promise<FileLock> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 0 ||
    options.timeoutMs > 3_600_000
  )
    throw new Error("Bounded lock timeout required");
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMs = options.pollMs ?? 25;
  const tryLock = options.tryLock ?? tryLockDescriptor;
  const flags =
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | closeOnExec();
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const handle = await open(path, flags, 0o600);
    try {
      const attempt = tryLock(handle.fd);
      // A filesystem without `flock` can never become free: waiting and then
      // reporting `busy` would only invite a pointless retry.
      if (attempt === "unsupported") throw new FileLockError("unsupported");
      if (attempt === "locked") {
        const opened = await handle.stat();
        const current = await lstat(path).catch(() => undefined);
        if (
          current?.isFile() &&
          current.dev === opened.dev &&
          current.ino === opened.ino
        ) {
          held.add(handle);
          return Object.freeze({
            async release() {
              if (!held.delete(handle)) return;
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
    if (now() >= deadline) throw new FileLockError("busy");
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
