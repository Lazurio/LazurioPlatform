import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type FolderFilePath, outputDirectories, outputFile } from "./outputs";
import type { ObservedFile } from "./reconcile";

// Caller supplies an already validated, owned, stable Folder. This read-only
// snapshot of one generated output is not a lock, authorization check or
// protection against parent swaps. POSIX only until native Windows no-follow
// semantics have been qualified.
export async function inspectOutput(
  folder: string,
  output: FolderFilePath,
): Promise<ObservedFile> {
  if (process.platform === "win32")
    throw new Error("Unqualified inventory platform");
  if (!isAbsolute(folder))
    throw new Error("Explicit absolute directory required");
  const root = await lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink()) return { kind: "unsafe" };
  const { directory, name } = outputFile(folder, output);
  try {
    // Every directory on the way, outermost first (`manual/`, or a skill's
    // `.agents/skills/<name>/`): an absent one means the file is absent;
    // anything but a real directory is unsafe, so no symlink is followed.
    for (const relative of outputDirectories(output)) {
      const parent = await lstat(join(folder, relative));
      if (!parent.isDirectory() || parent.isSymbolicLink())
        return { kind: "unsafe" };
    }
    const path = join(directory, name);
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
    if (code === "ELOOP" || code === "ENOTDIR") return { kind: "unsafe" };
    throw error; // Permission/IO failure is never treated as an absent file.
  }
}
