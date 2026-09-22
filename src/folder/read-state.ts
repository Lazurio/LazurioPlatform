import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { initializationReceipts } from "./initialization-receipt";
import { outputFile, outputPaths, stagedName } from "./outputs";
import { inspectOwnedDirectory } from "./owned-directory";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

// Development state layout, inside the same caller-bound stable operation owner.
// Call under its lock. Unknown entries (including any pending journal) block use.
// This is not discovery, import, fresh-state initialization or custody proof.
export async function readFolderState(stateDirectory: string) {
  await inspectStateLayout(stateDirectory, false);
  return {
    preferences: parseFolderPreferences(
      await readStateJson(stateDirectory, "preferences.json"),
    ),
    manifest: parseInstructionManifest(
      await readStateJson(stateDirectory, "instructions.json"),
    ),
  };
}

// History is retained evidence, never an alternate active-state source. Only its
// canonical owned directory is inspected; unrelated historical content is not read.
export async function inspectStateLayout(
  stateDirectory: string,
  pending: boolean,
) {
  const entries = await readdir(stateDirectory);
  const names = ["preferences.json", "instructions.json", ".operation-lock"];
  if (pending) names.push("transaction");
  if (
    entries.some((name) => name !== "history" && !names.includes(name)) ||
    names.some((name) => !entries.includes(name))
  )
    throw new Error("Unrecognized or pending Folder state");
  if (entries.includes("history")) {
    const root = await inspectOwnedDirectory(stateDirectory);
    const history = await inspectOwnedDirectory(
      join(stateDirectory, "history"),
    );
    if (root.dev !== history.dev)
      throw new Error("Cross-filesystem history is unsupported");
  }
}

export async function readStateJson(
  directory: string,
  name:
    | "preferences.json"
    | "instructions.json"
    | "before.json"
    | "prepared.json",
) {
  return JSON.parse((await readOwnedStateFile(directory, name)).content);
}

// Every file this product reads as its own: the state and journal files, the
// initialization receipts, the generated outputs at their Folder location and
// their flat staged names inside a transaction. Nothing else is ever read.
const ownedStateFileNames: readonly string[] = Object.freeze([
  "preferences.json",
  "instructions.json",
  "before.json",
  "prepared.json",
  ...Object.values(initializationReceipts),
  ...outputPaths.map((path) => outputFile("", path).name),
  ...outputPaths.map(stagedName),
  ".lazurio-generated",
]);

export async function readOwnedStateFile(directory: string, name: string) {
  if (!ownedStateFileNames.includes(name))
    throw new Error("Unknown state file name");
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
      opened.uid !== process.getuid?.() ||
      (opened.mode & 0o022) !== 0 ||
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
    return {
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(Buffer.concat(chunks)),
      identity: { dev: String(opened.dev), ino: String(opened.ino) },
    };
  } finally {
    await file.close();
  }
}

// Read one generated output at its Folder location with the same custody
// checks as the state files.
export function readOwnedOutput(
  folder: string,
  path: (typeof outputPaths)[number],
) {
  const { directory, name } = outputFile(folder, path);
  return readOwnedStateFile(directory, name);
}
