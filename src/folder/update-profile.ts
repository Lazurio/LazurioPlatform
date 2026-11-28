import { join } from "node:path";
import {
  applyPreparationLocked,
  finalizePreparationLocked,
  resumePreparationLocked,
} from "./apply-preparation";
import { checkBuddyLocked, writeBuddyLocked } from "./buddy-folder";
import { withFolderOperationLock } from "./lock";
import type { MachineBinding } from "./machine-binding";
import { inspectOwnedDirectory } from "./owned-directory";
import {
  type FolderChangeRequest,
  prepareFolderChangeLocked,
} from "./prepare-profile-change";
import type { PresetName } from "./presets";
import { readFolderState } from "./read-state";

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
// renders the same bytes from the same handover digest is `unchanged` and
// nothing is written. A rewritten handover that changes nothing else is
// recorded by its digest alone, and the answer says so, `bindingRebound:
// "handover-digest"` (issue #111). `preset`,
// when given, is the preset a changed assignment now derives, recorded with
// the new binding in the same revision (issue #107). The one correction of
// the identity, a rename of the Owner Organization under the same recorded
// id (`ownerOrganizationCorrection`), is recorded and named in the answer,
// `bindingCorrected: "owner-renamed"`. `organizationKey`, the live
// handover's `owner.organization_key`, is passed on but no longer decides.
export async function refreshFolder(
  folder: string,
  machine: MachineBinding,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
  preset: PresetName | undefined = undefined,
  organizationKey: string | undefined = undefined,
) {
  const result = await changeFolder(
    folder,
    {
      kind: "handover",
      machine,
      ...(preset === undefined ? {} : { preset }),
      ...(organizationKey === undefined ? {} : { organizationKey }),
    },
    checkpoint,
  );
  if (result.kind !== "updated") return result;
  return {
    kind: "refreshed" as const,
    revision: result.revision,
    ...("buddyFolder" in result && result.buddyFolder !== undefined
      ? { buddyFolder: result.buddyFolder }
      : {}),
    ...(result.bindingCorrected === undefined
      ? {}
      : { bindingCorrected: result.bindingCorrected }),
    ...(result.bindingRebound === undefined
      ? {}
      : { bindingRebound: result.bindingRebound }),
  };
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

// Records the person's choice of their ChatGPT account's apps (decision
// F42's addendum of 2026-10-27) and re-renders the generated Folder with what
// it allows: the same planner, transaction, archive and recovery
// (`profile-resume`) as a profile change. Refused where an Organization
// governs (`organization-governed`); the same choice is `unchanged`.
export async function updateChatgptApps(
  folder: string,
  expectedRevision: number,
  allowed: boolean,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
) {
  return changeFolder(
    folder,
    { kind: "chatgpt-apps", expectedRevision, allowed },
    checkpoint,
  );
}

// Records the person's own instructions for agents (root decision 0233,
// decision F14's addendum of 2026-11-06) and re-renders the generated Folder
// with their section: the same planner, transaction, archive and recovery
// (`profile-resume`) as a profile change, never `drift`. `edit` is
// `{ text }`, the whole next text or null to remove them; nothing else of
// the Folder can change through it. Refused where a person has none
// (`own-instructions-unavailable`) and where the text does not fit next to
// the voice (`person-text-too-large`); the same text is `unchanged`.
export async function updateOwnInstructions(
  folder: string,
  expectedRevision: number,
  edit: unknown,
  checkpoint: (step: UpdateStep) => Promise<void> = async () => {},
) {
  return changeFolder(
    folder,
    { kind: "own-instructions", expectedRevision, edit },
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
      // Buddy GEN4's folder can take the instructions of the Folder this
      // change leads to, or nothing changes (`checkBuddyLocked`).
      await checkBuddyLocked(
        folder,
        request.kind === "handover"
          ? request.machine
          : (await readFolderState(join(folder, ".lazurio"))).preferences
              .machine,
      );
      const prepared = await prepareFolderChangeLocked(
        folder,
        request,
        assertHeld,
      );
      // Buddy's Lazurio layer is written after every change of the Folder
      // and also when nothing else changed, never after a refusal
      // (`buddy-layer.ts`).
      if (prepared.kind === "unchanged") {
        const buddy = await writeBuddyLocked(folder, assertHeld);
        return buddy === undefined
          ? prepared
          : { ...prepared, buddyFolder: buddy };
      }
      if (prepared.kind !== "prepared") return prepared;
      await checkpoint("prepared");
      const applied = await applyPreparationLocked(folder, assertHeld);
      if (applied.revision !== prepared.nextRevision)
        throw new Error("Profile transaction revision changed");
      await checkpoint("applied");
      await finalizePreparationLocked(folder, applied.revision, assertHeld);
      await checkpoint("finalized");
      // Buddy GEN4's folder, after the change: a write that fails here is
      // reported, never thrown, so the change and its entry stand and the
      // Launchpad follows them; the next refresh writes the folder again.
      const buddy = await writeBuddyLocked(folder, assertHeld);
      await assertHeld();
      return {
        kind: "updated" as const,
        revision: applied.revision,
        ...(buddy === undefined ? {} : { buddyFolder: buddy }),
        ...(prepared.bindingCorrected === undefined
          ? {}
          : { bindingCorrected: prepared.bindingCorrected }),
        ...(prepared.bindingRebound === undefined
          ? {}
          : { bindingRebound: prepared.bindingRebound }),
      };
    },
  );
}
