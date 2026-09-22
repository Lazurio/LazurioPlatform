import { dlopen, ptr } from "bun:ffi";

// Pinned Bun; tested on local APFS/Linux ext4. Keep the library alive with locks.
let library: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Unqualified lock platform");
  return dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      flock: { args: ["i32", "i32"], returns: "i32" },
      // macOS only, read through the 64-bit-inode struct statfs: on x86_64
      // that variant is the `$INODE64` symbol, on arm64 the plain one.
      ...(process.platform === "darwin"
        ? {
            [process.arch === "x64" ? "statfs$INODE64" : "statfs"]: {
              args: ["cstring", "ptr"],
              returns: "i32",
            },
          }
        : {}),
    },
  );
}

// The filesystem's name on macOS (`f_fstypename`, e.g. "apfs"). The numeric
// `f_type` that node's statfs exposes is the kernel's vfs type number, assigned
// in registration order at boot, so it is not stable across machines or even
// boots (observed 25 and 26 for APFS on identical CI images); only the name
// qualifies a filesystem. Layout of the 64-bit-inode struct statfs: f_type at
// byte 60, f_fstypename[16] at byte 72; the struct is 2168 bytes.
export function darwinFilesystemName(path: string): string {
  if (process.platform !== "darwin")
    throw new Error("Unqualified lock platform");
  library ??= load();
  const statfs = (library.symbols as Record<string, unknown>)[
    process.arch === "x64" ? "statfs$INODE64" : "statfs"
  ] as (path: Uint8Array, buffer: number) => number;
  const buffer = new Uint8Array(4096);
  if (statfs(Buffer.from(`${path}\0`), ptr(buffer)) !== 0)
    throw new Error("Lock filesystem could not be inspected");
  const name = Buffer.from(buffer.subarray(72, 88)).toString("utf8");
  return name.slice(0, name.indexOf("\0") === -1 ? 16 : name.indexOf("\0"));
}

export function lockDirectoryDescriptor(fd: number) {
  library ??= load();
  // LOCK_EX | LOCK_NB. Any failure refuses entry, never guesses from PID/age.
  if (library.symbols.flock(fd, 2 | 4) !== 0)
    throw new Error("Folder operation busy or requires recovery");
}

export function closeOnExecFlag() {
  if (process.platform === "darwin") return 0x01000000;
  if (process.platform === "linux") return 0x80000;
  throw new Error("Unqualified lock platform");
}
