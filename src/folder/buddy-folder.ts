import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readPersona } from "../buddy/persona";
import { type BuddyFolderPath, renderBuddyFolder } from "./buddy-gen4";
import { writeBuddyLayerLocked } from "./buddy-layer";
import { inspectOutput } from "./inventory";
import { ensureOutputDirectories } from "./output-directories";
import { outputFile } from "./outputs";
import { checkoutDirectoryRefusal } from "./owned-directory";
import { readFolderState } from "./read-state";
import { instructionSource } from "./render";

// Buddy's instructions after every change of the Folder (plan LZD-0033, R2):
// a person the handover names converted (`entry.buddy.generation: 4`, the
// binding's `buddyFolder`) gets Buddy GEN4's folder with the persona of
// Nastavení → Buddy, and Buddy GEN3's layer in `.agents/buddy/` is no longer
// written, nor removed (its removal is the conversion's, R9). Everyone else
// keeps Buddy GEN3's layer exactly as before. An absent or unreadable persona
// renders the generic, formal text. The folder written is always the
// Folder's own sibling `<home>/Buddy`, never a path read from elsewhere, so
// nothing outside the Folder's home is written; on a hosted Environment that
// is the very folder the handover names (`/home/<operator>/Buddy`).
export async function writeBuddyLocked(
  folder: string,
  assertHeld: () => Promise<void>,
): Promise<void> {
  const { preferences } = await readFolderState(join(folder, ".lazurio"));
  const entry = preferences.machine?.entry;
  if (entry?.buddyFolder === undefined || entry.buddyProfile === undefined) {
    await writeBuddyLayerLocked(folder, assertHeld);
    return;
  }
  const home = dirname(folder);
  const persona = await readPersona(home);
  await writeBuddyFolderLocked(
    join(home, "Buddy"),
    renderBuddyFolder(
      instructionSource(preferences),
      entry.buddyProfile,
      persona.state === "valid" ? persona.persona : undefined,
    ),
    assertHeld,
  );
}

// Buddy GEN4's folder (plan LZD-0033, R2): `~/Buddy`, beside the Lazurio
// Folder and never inside it, where T3 Code keeps Buddy's project
// (Lazurio/t3code#214). Lazurio owns exactly the files of
// `buddyFolderPaths` there and nothing else: Buddy's own notes, the pilot's
// files and anything the person keeps beside them are never listed, read,
// moved or removed. As for Buddy GEN3's layer, no digest proves ownership:
// a refresh writes each file over whatever bytes are there and keeps a file
// whose bytes are the rendered ones. The folder is created owner-only when
// absent, in an existing home; an existing one is accepted only as a real
// directory of this account (never a symlink). A path inside it that is no
// regular file of this account is refused, as everywhere in the Folder. Each
// file is replaced atomically, so a harness reads the old bytes or the new
// ones, never a part. Runs under the Folder's operation lock.
export async function writeBuddyFolderLocked(
  buddyFolder: string,
  files: Readonly<Record<BuddyFolderPath, string>>,
  assertHeld: () => Promise<void>,
): Promise<readonly BuddyFolderPath[]> {
  await ensureBuddyFolder(buddyFolder);
  const written: BuddyFolderPath[] = [];
  for (const [path, content] of Object.entries(files) as [
    BuddyFolderPath,
    string,
  ][]) {
    const observed = await inspectOutput(buddyFolder, path);
    if (observed.kind === "unsafe")
      throw new Error(`Unsafe Buddy folder file: ${path}`);
    if (
      observed.kind === "regular" &&
      observed.digest === createHash("sha256").update(content).digest("hex")
    )
      continue;
    await ensureOutputDirectories(buddyFolder, path);
    const { directory, name } = outputFile(buddyFolder, path);
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

async function ensureBuddyFolder(buddyFolder: string) {
  if (!isAbsolute(buddyFolder) || basename(buddyFolder) !== "Buddy")
    throw new Error("Invalid Buddy folder");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Directory owner unavailable");
  const home = dirname(buddyFolder);
  const parent = await lstat(home);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid)
    throw new Error("Unsafe Buddy folder parent");
  let stat = await lstat(buddyFolder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) {
    await mkdir(buddyFolder, { mode: 0o700 });
    await syncDirectory(home);
    stat = await lstat(buddyFolder);
  }
  if (stat.isSymbolicLink() || checkoutDirectoryRefusal(stat, uid) !== null)
    throw new Error("Unsafe Buddy folder");
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
