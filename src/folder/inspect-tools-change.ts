import { join } from "node:path";
import { toolSelection } from "../tools/catalog";
import { planToolsChange } from "./change-profile";
import { inspectOutput } from "./inventory";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readFolderState } from "./read-state";
import { sharedEnvironment } from "./render";
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

// On an Environment shared by several operators a sign-in of a tool is shared
// by all of them. Every surface says so whenever a change adds a tool there.
export function sharedSignInsWarning(
  recorded: Readonly<{
    sharedEnvironment: boolean;
    enabled: readonly string[];
  }>,
  requested: unknown,
): { warning: "shared-environment-sign-ins" } | Record<string, never> {
  return recorded.sharedEnvironment &&
    Array.isArray(requested) &&
    requested.some((tool) => !recorded.enabled.includes(tool))
    ? { warning: "shared-environment-sign-ins" }
    : {};
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
      // Sign-ins are shared by every operator of this Environment.
      sharedEnvironment: sharedEnvironment(preferences.preset.name),
      enabled: enabledTools(preferences),
      tools: toolSelection(enabledTools(preferences)),
    };
  });
}
