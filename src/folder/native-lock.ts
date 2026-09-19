import { dlopen, type Pointer, read } from "bun:ffi";

// Pinned Bun; tested on local APFS/Linux ext4. Keep the library alive with locks.
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

export function lockDirectoryDescriptor(fd: number) {
  library ??= load();
  // LOCK_EX | LOCK_NB. Any failure refuses entry, never guesses from PID/age.
  if (library.flock(fd, 2 | 4) !== 0)
    throw new Error("Folder operation busy or requires recovery");
}

/** Errno values that mean "this filesystem cannot `flock`", not "someone else
 * holds it": EINVAL, ENOLCK and ENOTSUP/EOPNOTSUPP of the two qualified
 * platforms.
 */
const unsupportedErrno: Readonly<Record<string, readonly number[]>> = {
  darwin: [22, 77, 45, 102],
  linux: [22, 37, 95],
};

/** One non-blocking exclusive `flock`. `unsupported` is reported only for an
 * errno that can never mean contention; every other failure stays `contended`
 * so a wrong errno read can at worst turn into a timeout, never into a second
 * holder.
 */
export function tryLockDescriptor(
  fd: number,
): "locked" | "contended" | "unsupported" {
  library ??= load();
  if (library.flock(fd, 2 | 4) === 0) return "locked";
  const address = library.errnoAddress() as Pointer | null;
  const errno = address === null ? 0 : read.i32(address, 0);
  return (unsupportedErrno[process.platform] ?? []).includes(errno)
    ? "unsupported"
    : "contended";
}

export function closeOnExecFlag() {
  if (process.platform === "darwin") return 0x01000000;
  if (process.platform === "linux") return 0x80000;
  throw new Error("Unqualified lock platform");
}
