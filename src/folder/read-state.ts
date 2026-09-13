import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

// Development state layout, inside the same caller-bound stable operation owner.
// Call under its lock. Unknown entries (including any pending journal) block use.
// This is not discovery, import, fresh-state initialization or custody proof.
export async function readFolderState(stateDirectory: string) {
  const entries = await readdir(stateDirectory);
  const names = ["preferences.json", "instructions.json", ".operation-lock"];
  if (entries.some((name) => !names.includes(name)))
    throw new Error("Unrecognized or pending Folder state");
  return {
    preferences: parseFolderPreferences(
      await readJson(stateDirectory, "preferences.json"),
    ),
    manifest: parseInstructionManifest(
      await readJson(stateDirectory, "instructions.json"),
    ),
  };
}

async function readJson(
  directory: string,
  name: "preferences.json" | "instructions.json",
) {
  const path = join(directory, name);
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o022) !== 0
  )
    throw new Error("Unsafe Folder state file");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error("Folder state file changed");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      length += chunk.length;
      // Bounded development decoder, not a published preference-size guarantee.
      if (length > 16 * 1024 * 1024)
        throw new Error("Folder state exceeds decoder limit");
      chunks.push(chunk);
    }
    const after = await file.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("Folder state file changed during read");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await file.close();
  }
}
