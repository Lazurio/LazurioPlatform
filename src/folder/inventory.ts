import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ObservedFile } from "./reconcile";

// Caller supplies an already validated, owned, stable directory. This read-only
// snapshot is not a lock, authorization check or protection against parent swaps.
// POSIX only until native Windows no-follow semantics have been qualified.
export async function inspectInstructions(
  directory: string,
): Promise<ObservedFile> {
  if (process.platform === "win32")
    throw new Error("Unqualified inventory platform");
  if (!isAbsolute(directory))
    throw new Error("Explicit absolute directory required");
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) return { kind: "unsafe" };
  const path = join(directory, "AGENTS.md");
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1) return { kind: "unsafe" };
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.ino !== before.ino ||
        opened.dev !== before.dev
      )
        return { kind: "unsafe" };
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false }))
        hash.update(chunk);
      const after = await handle.stat();
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        return { kind: "unsafe" };
      return { kind: "regular", digest: hash.digest("hex") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    if (code === "ELOOP") return { kind: "unsafe" };
    throw error; // Permission/IO failure is never treated as an absent file.
  }
}
