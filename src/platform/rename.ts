import { dlopen, type Pointer, read } from "bun:ffi";

// A rename that never replaces its destination: `renamex_np(RENAME_EXCL)` on
// macOS, `renameat2(RENAME_NOREPLACE)` on Linux. POSIX `rename` replaces an
// existing empty directory and a file silently; content materialization
// publishes a verified checkout only into an ABSENT destination
// (docs/content-sync.md), so the kernel decides atomically, not a check before
// the call. Neutral, dependency-free primitive in the style of `flock.ts`.

let library: ReturnType<typeof load> | undefined;
function load() {
  const errno = { args: [], returns: "ptr" } as const;
  if (process.platform === "darwin") {
    const native = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: ["cstring", "cstring", "u32"], returns: "i32" },
      __error: errno,
    });
    const exclusive = 0x4; // RENAME_EXCL
    return {
      rename: (from: Buffer, to: Buffer) =>
        native.symbols.renamex_np(from, to, exclusive),
      errnoAddress: native.symbols.__error,
    };
  }
  if (process.platform === "linux") {
    const native = dlopen("libc.so.6", {
      renameat2: {
        args: ["i32", "cstring", "i32", "cstring", "u32"],
        returns: "i32",
      },
      __errno_location: errno,
    });
    const currentDirectory = -100; // AT_FDCWD
    const noReplace = 0x1; // RENAME_NOREPLACE
    return {
      rename: (from: Buffer, to: Buffer) =>
        native.symbols.renameat2(
          currentDirectory,
          from,
          currentDirectory,
          to,
          noReplace,
        ),
      errnoAddress: native.symbols.__errno_location,
    };
  }
  throw new Error("Unqualified rename platform");
}

const exists = 17; // EEXIST on both qualified platforms

/** Renames `from` to `to` only when nothing is at `to`: `renamed`, or
 * `exists` when the destination is occupied (by anything, an empty directory
 * included). Every other failure throws; nothing is retried or replaced. */
export function renameNoReplace(
  from: string,
  to: string,
): "renamed" | "exists" {
  if (from.includes("\0") || to.includes("\0"))
    throw new Error("Invalid rename path");
  library ??= load();
  if (library.rename(Buffer.from(`${from}\0`), Buffer.from(`${to}\0`)) === 0)
    return "renamed";
  const address = library.errnoAddress() as Pointer | null;
  const errno = address === null ? 0 : read.i32(address, 0);
  if (errno === exists) return "exists";
  throw new Error(`No-replace rename failed (errno ${errno})`);
}
