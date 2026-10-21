import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { type FolderFilePath, outputDirectories } from "./outputs";
import { checkoutDirectoryRefusal } from "./owned-directory";

// The directories an output lies in, made present right before the output is
// written (decision F14, addendum of 2026-10-14). A missing one is created
// owner-only and made durable in its parent. An existing one is accepted only
// as a real directory (never a symlink) of this account on the Folder's
// filesystem; `.agents/` and `.claude/` may already hold the person's own
// skills and settings, so group write bits (Ubuntu's umask 002) are no reason
// to refuse, as for the account's configuration directories (decision F23).
// Nothing in them is listed, read, moved or removed, and Lazurio owns only its
// own files there. `manual/` is created by initialization alone, with its
// marker: it is checked here, never created. Not a sandbox against the same
// account racing the transaction.
export async function ensureOutputDirectories(
  folder: string,
  path: FolderFilePath,
) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Directory owner unavailable");
  const root = await lstat(folder);
  let parent = folder;
  for (const relative of outputDirectories(path)) {
    const directory = join(folder, relative);
    let stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) {
      if (relative === "manual")
        throw new Error("Missing owned manual directory");
      await mkdir(directory, { mode: 0o700 });
      await syncDirectory(parent);
      stat = await lstat(directory);
    }
    if (
      stat.isSymbolicLink() ||
      checkoutDirectoryRefusal(stat, uid) !== null ||
      stat.dev !== root.dev
    )
      throw new Error(`Unsafe output directory: ${relative}`);
    parent = directory;
  }
}

// Every directory the outputs lie in, Folder-relative and innermost first, so
// that syncing them in this order makes each entry durable before its parent.
export function outputDirectoriesInnermostFirst(
  paths: readonly FolderFilePath[],
): readonly string[] {
  return [...new Set(paths.flatMap(outputDirectories))].sort(
    (a, b) => b.split("/").length - a.split("/").length,
  );
}

async function syncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
