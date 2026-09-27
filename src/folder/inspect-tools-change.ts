import { join } from "node:path";
import { toolSelection } from "../tools/catalog";
import { planToolsChange } from "./change-profile";
import { inspectOutput } from "./inventory";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readFolderState } from "./read-state";
import { enabledTools } from "./state";

// The read-only twin of `updateTools`, as `inspectProfileChange` is of
// `updateProfile`: the same planner over the same state under the same lock.
// Only the ephemeral operation lock is written.
export async function inspectToolsChange(
  folder: string,
  expectedRevision: number,
  tools: unknown,
) {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  return withFolderOperationLock(stateDirectory, async (assertHeld) => {
    const state = await readFolderState(stateDirectory);
    if (state.preferences.profile.os !== executionOs(process.platform))
      throw new Error("Stored profile does not match execution Machine");
    const result = await planToolsChange(
      state.preferences,
      state.manifest,
      expectedRevision,
      tools,
      (path) => inspectOutput(folder, path),
    );
    await assertHeld();
    return result;
  });
}

// The recorded selection of one Folder: its revision and the catalog with
// every tool's tier and whether it is on. Read-only, under the common lock.
export async function readFolderTools(folder: string) {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  return withFolderOperationLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    return {
      revision: preferences.revision,
      enabled: enabledTools(preferences),
      tools: toolSelection(enabledTools(preferences)),
    };
  });
}
