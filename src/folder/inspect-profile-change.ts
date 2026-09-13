import { planProfileChange } from "./change-profile";
import { inspectInstructions } from "./inventory";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readFolderState } from "./read-state";

// Caller binds this Folder to its existing trusted state owner; arbitrary imported
// state is never evidence of that relationship. No automatic home/state discovery.
// Only the ephemeral operation lock is written; no preferences/output are changed.
export async function inspectProfileChange(
  folder: string,
  stateDirectory: string,
  expectedRevision: number,
  requested: unknown,
) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(stateDirectory, async (assertHeld) => {
    const state = await readFolderState(stateDirectory);
    if (state.preferences.profile.os !== executionOs(process.platform))
      throw new Error("Stored profile does not match execution Machine");
    const result = await planProfileChange(
      state.preferences,
      state.manifest,
      expectedRevision,
      requested,
      () => inspectInstructions(folder),
    );
    await assertHeld();
    return result;
  });
}
