import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  type BuddyFolderWriteFailure,
  buddyGen3Present,
  writeBuddyLocked,
} from "../folder/buddy-folder";
import { type BuddyFolderPath, renderBuddyFolder } from "../folder/buddy-gen4";
import { inspectOutput } from "../folder/inventory";
import { withFolderOperationLock } from "../folder/lock";
import { readFolderState } from "../folder/read-state";
import { instructionSource } from "../folder/render";
import { readPersona } from "./persona";

// Buddy GEN4's persona (plan LZD-0033, R3): he has no Hermes of his own, so
// what derives from the persona is his folder `~/Buddy`, which the Folder
// renders from its profile and the persona (`folder/buddy-folder.ts`). A
// reading compares those files with the bytes there; an apply writes them
// under the Folder's operation lock, as every change of the Folder does.

/** Whether `~/Buddy` holds exactly what the Folder and the persona render
 * now. Anything that is not the rendered file (absent, other bytes, no
 * regular file) is outdated. */
export async function buddyFolderInPlace(folder: string): Promise<boolean> {
  const { preferences } = await readFolderState(join(folder, ".lazurio"));
  const profile = preferences.machine?.entry?.buddyProfile;
  if (profile === undefined) return false;
  const home = dirname(folder);
  const persona = await readPersona(home);
  const files = renderBuddyFolder(
    instructionSource(preferences),
    profile,
    persona.state === "valid" ? persona.persona : undefined,
    { gen3: await buddyGen3Present(home) },
  );
  for (const [path, content] of Object.entries(files) as [
    BuddyFolderPath,
    string,
  ][]) {
    const observed = await inspectOutput(join(home, "Buddy"), path);
    if (
      observed.kind !== "regular" ||
      observed.digest !== createHash("sha256").update(content).digest("hex")
    )
      return false;
  }
  return true;
}

/** Writes `~/Buddy` from the Folder and the persona as they are now; the
 * refusal `writeBuddyLocked` reports (a foreign Buddy folder, a CLAUDE.md
 * there), undefined once written. */
export const applyBuddyFolderPersona = (
  folder: string,
): Promise<BuddyFolderWriteFailure | undefined> =>
  withFolderOperationLock(join(folder, ".lazurio"), (assertHeld) =>
    writeBuddyLocked(folder, assertHeld),
  );

/** Whether Buddy GEN4's names are still owed to `~/Buddy`: it is not what
 * the Folder and the persona render now, or it cannot be read. */
export const buddyFolderOwed = (folder: string): Promise<boolean> =>
  buddyFolderInPlace(folder).then(
    (inPlace) => !inPlace,
    () => true,
  );
