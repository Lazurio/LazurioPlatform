import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { readPersona } from "../buddy/persona";
import {
  type BuddyFolderPath,
  type BuddyProfile,
  buddyFolderPaths,
  renderBuddyFolder,
} from "./buddy-gen4";
import { writeBuddyLayerLocked } from "./buddy-layer";
import { inspectOutput } from "./inventory";
import type { MachineBinding } from "./machine-binding";
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
// renders the generic, formal text.
//
// The home is the Folder's parent: a hosted Folder is `<home>/Lazurio` of
// its operator, whose home the binding checked against the account's own
// (`bindMachineOperator`, `readLinuxOperator`). The folder the handover
// names must be exactly `<home>/Buddy` of that home, which must be its own
// canonical path (no symlinked ancestor); anything else is refused and
// nothing is written (`buddyFolderTarget`).
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
  const target = await buddyFolderTarget(home, entry.buddyFolder);
  await writeBuddyGen4Locked(
    home,
    target,
    instructionSource(preferences),
    entry.buddyProfile,
    assertHeld,
  );
}

/** Whether a change of the Folder to `machine` can write Buddy's
 * instructions, checked before the change commits so that a refusal leaves
 * the Folder, its binding and its entry as they were (a retry after the
 * fix then sees the change anew). For a converted person: the folder is
 * exactly `Buddy` of the Folder's canonical home, an existing one is a real
 * directory of this account without `CLAUDE.md` and none of its files is
 * unsafe. Nothing is created or written here. */
export async function checkBuddyLocked(
  folder: string,
  machine: MachineBinding | null | undefined,
): Promise<void> {
  const entry = machine?.entry;
  if (entry?.buddyFolder === undefined || entry.buddyProfile === undefined)
    return;
  const target = await buddyFolderTarget(dirname(folder), entry.buddyFolder);
  const uid = process.getuid?.();
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return;
  if (
    uid === undefined ||
    stat.isSymbolicLink() ||
    checkoutDirectoryRefusal(stat, uid) !== null
  )
    throw new Error("Unsafe Buddy folder");
  await refuseClaudeInstructions(target);
  for (const path of buddyFolderPaths)
    if ((await inspectOutput(target, path)).kind === "unsafe")
      throw new Error(`Unsafe Buddy folder file: ${path}`);
}

/** The folder to write: the declared one, only when it is exactly `Buddy`
 * of `home` and `home` is its own canonical path, a real directory of this
 * account. A nested path, another home or a symlinked ancestor is refused. */
export async function buddyFolderTarget(
  home: string,
  declared: string,
): Promise<string> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Directory owner unavailable");
  if (!isAbsolute(home) || declared !== join(home, "Buddy"))
    throw new Error("Buddy folder mismatch");
  const canonical = await realpath(home);
  const stat = await lstat(home);
  if (
    canonical !== home ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid
  )
    throw new Error("Unsafe Buddy folder home");
  return declared;
}

/** Buddy GEN4's folder of `home` written for `profile`, with the persona of
 * Nastavení → Buddy read from that home. */
export async function writeBuddyGen4Locked(
  home: string,
  target: string,
  source: unknown,
  profile: BuddyProfile,
  assertHeld: () => Promise<void>,
): Promise<readonly BuddyFolderPath[]> {
  const persona = await readPersona(home);
  return writeBuddyFolderLocked(
    target,
    renderBuddyFolder(
      source,
      profile,
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
  await refuseClaudeInstructions(buddyFolder);
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
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== uid ||
    (await realpath(home)) !== home
  )
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

// Claude Code loads a CLAUDE.md of the project instead of its AGENTS.md
// (V1), so with one of them in Buddy's folder his thread would miss the
// coordinator's instructions. The person's file is never removed or changed;
// the refresh is refused and names it, before anything is written.
export const claudeInstructionPaths = ["CLAUDE.md", ".claude/CLAUDE.md"];
async function refuseClaudeInstructions(buddyFolder: string) {
  for (const path of claudeInstructionPaths) {
    const present = await lstat(join(buddyFolder, path)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw error;
      },
    );
    if (present)
      throw new Error(
        `Buddy folder has ${path}: Claude Code would load it instead of AGENTS.md; move it away, nothing was written`,
      );
  }
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
