import { dlopen } from "bun:ffi";

// Pinned Bun; tested on local APFS/Linux ext4. Keep the library alive with locks.
let library: ReturnType<typeof load> | undefined;
function load() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Unqualified lock platform");
  return dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    { flock: { args: ["i32", "i32"], returns: "i32" } },
  );
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
