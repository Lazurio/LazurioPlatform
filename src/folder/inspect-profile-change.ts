import { planProfileChange } from "./change-profile";
import { inspectInstructions } from "./inventory";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readFolderState } from "./read-state";

// One folder-relative state location for every caller. Existing directory custody
// and schema are verified; its name alone does not grant file ownership. No import
// or automatic home discovery, and no alternate state-directory override.
// Only the ephemeral operation lock is written; no preferences/output are changed.
export async function inspectProfileChange(
  folder: string,
  expectedRevision: number,
  requested: unknown,
) {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
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

import { join } from "node:path";
