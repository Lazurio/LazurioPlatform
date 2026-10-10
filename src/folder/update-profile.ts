import { join } from "node:path";
import {
  applyPreparationLocked,
  finalizePreparationLocked,
  resumePreparationLocked,
} from "./apply-preparation";
import { withFolderOperationLock } from "./lock";
import type { MachineBinding } from "./machine-binding";
import { inspectOwnedDirectory } from "./owned-directory";
import {
  type FolderChangeRequest,
  prepareFolderChangeLocked,
} from "./prepare-profile-change";
import type { PresetName } from "./presets";

export type UpdateStep = "prepared" | "applied" | "finalized";

export async function resumeProfileUpdate(
  folder: string,
  targetRevision: number,
) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(join(folder, ".lazurio"), (assertHeld) =>
    resumePreparationLocked(folder, targetRevision, assertHeld),
  );
}

// One application use case for CLI/Launchpad adapters. Holds exclusion across
// planning, staging, activation and archive; never adopts a pre-existing attempt.
// This is still an explicit existing-state development API, not initialization.
export async function updateProfile(
  folder: string,
  expectedRevision: number,
  requested: unknown,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
) {
  return changeFolder(
    folder,
    { kind: "profile", expectedRevision, requested },
    checkpoint,
  );
}

// Records the requested selection of enabled catalog tools (decision F18)
// and, when given, the full next set of the operator's notes on them (F18
// addendum; without it the recorded notes of the tools that stay on are kept)
// and re-renders the generated Folder: the same planner, transaction, archive
// and recovery (`profile-resume`) as a profile change.
export async function updateTools(
  folder: string,
  expectedRevision: number,
  tools: unknown,
  notes: unknown = undefined,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
) {
  return changeFolder(
    folder,
    notes === undefined
      ? { kind: "tools", expectedRevision, tools }
      : { kind: "tools", expectedRevision, tools, notes },
    checkpoint,
  );
}

// Re-renders the generated Folder from the current handover of the same
// Machine with the recorded preset and profile: the same planner, transaction,
// archive and recovery (`profile-resume`) as a profile change. Edited or
// removed owned files are refused by path exactly as there; a binding that
// renders the same bytes is `unchanged` and nothing is written. `preset`,
// when given, is the preset a changed assignment now derives, recorded with
// the new binding in the same revision (issue #107).
export async function refreshFolder(
  folder: string,
  machine: MachineBinding,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
  preset: PresetName | undefined = undefined,
) {
  const result = await changeFolder(
    folder,
    preset === undefined
      ? { kind: "handover", machine }
      : { kind: "handover", machine, preset },
    checkpoint,
  );
  return result.kind === "updated"
    ? { kind: "refreshed" as const, revision: result.revision }
    : result;
}

// Records the Organization settings the Launchpad applies (root decision
// 0194 point 4, decision F45) and re-renders the generated Folder with what
// they allow: the same planner, transaction, archive and recovery
// (`profile-resume`) as a profile change, at the current revision. The same
// settings are `unchanged` and nothing is written.
export async function recordOrganizationSettings(
  folder: string,
  settings: unknown,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
) {
  return changeFolder(
    folder,
    { kind: "organization-settings", settings },
    checkpoint,
  );
}

async function changeFolder(
  folder: string,
  request: FolderChangeRequest,
  checkpoint: (step: UpdateStep) => Promise<void>,
) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(
    join(folder, ".lazurio"),
    async (assertHeld) => {
      const prepared = await prepareFolderChangeLocked(
        folder,
        request,
        assertHeld,
      );
      if (prepared.kind !== "prepared") return prepared;
      await checkpoint("prepared");
      const applied = await applyPreparationLocked(folder, assertHeld);
      if (applied.revision !== prepared.nextRevision)
        throw new Error("Profile transaction revision changed");
      await checkpoint("applied");
      await finalizePreparationLocked(folder, applied.revision, assertHeld);
      await checkpoint("finalized");
      await assertHeld();
      return { kind: "updated" as const, revision: applied.revision };
    },
  );
}
