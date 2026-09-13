import { join } from "node:path";
import {
  applyPreparationLocked,
  finalizePreparationLocked,
} from "./apply-preparation";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { prepareProfileChangeLocked } from "./prepare-profile-change";

// One application use case for CLI/Launchpad adapters. Holds exclusion across
// planning, staging, activation and archive; never adopts a pre-existing attempt.
// This is still an explicit existing-state development API, not initialization.
export async function updateProfile(
  folder: string,
  expectedRevision: number,
  requested: unknown,
  checkpoint: (
    step: "prepared" | "applied" | "finalized",
  ) => Promise<void> = async () => {},
) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(
    join(folder, ".lazurio"),
    async (assertHeld) => {
      const prepared = await prepareProfileChangeLocked(
        folder,
        expectedRevision,
        requested,
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
