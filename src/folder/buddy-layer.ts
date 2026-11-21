import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { renderBuddyLayer } from "./buddy";
import { inspectOutput } from "./inventory";
import { ensureOutputDirectories } from "./output-directories";
import { type BuddyLayerPath, buddyLayerPaths, outputFile } from "./outputs";
import { readFolderState } from "./read-state";
import { instructionSource } from "./render";

// Buddy's Lazurio layer in the Folder (root decision 0210 with its addendum
// of 2026-10-20 evening, point 1; decision F14's addendum of 2026-10-21).
// Lazurio owns exactly the files of `buddyLayerPaths` and nothing else in
// `.agents/buddy/`, which is Buddy's working directory: Buddy never edits
// them (his own variants live in `~/.hermes/skills`), so no digest proves
// ownership and no change of the person's is at stake. A refresh writes each
// file over whatever bytes are there and keeps a file whose bytes are the
// rendered ones, such as the copy an interim install placed before this
// release; nothing beside them is listed, read, refused or removed. Only a
// path that is no regular file of this account (a symlink, a hard link, a
// directory) is refused, as everywhere in the Folder. Each file is replaced
// atomically (a new file renamed over the old one), so Hermes reads the old
// bytes or the new ones, never a part. Runs under the Folder's operation
// lock, after the change transaction or when it found nothing to change;
// a crash between the transaction and this step leaves the previous layer
// in place, which the next refresh writes again.
export async function writeBuddyLayerLocked(
  folder: string,
  assertHeld: () => Promise<void>,
): Promise<readonly BuddyLayerPath[]> {
  const { preferences } = await readFolderState(join(folder, ".lazurio"));
  const rendered = renderBuddyLayer(instructionSource(preferences));
  const written: BuddyLayerPath[] = [];
  for (const path of buddyLayerPaths) {
    const content = rendered[path];
    const observed = await inspectOutput(folder, path);
    if (observed.kind === "unsafe")
      throw new Error(`Unsafe Buddy layer file: ${path}`);
    if (
      observed.kind === "regular" &&
      observed.digest === createHash("sha256").update(content).digest("hex")
    )
      continue;
    await ensureOutputDirectories(folder, path);
    const { directory, name } = outputFile(folder, path);
    // A new file of its own, removed again unless the rename consumed it.
    const temporary = join(directory, `.${name}.${randomUUID()}.lazurio`);
    const file = await open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await assertHeld();
      await rename(temporary, join(directory, name));
      renamed = true;
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
    await syncDirectory(directory);
    written.push(path);
  }
  return Object.freeze(written);
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
