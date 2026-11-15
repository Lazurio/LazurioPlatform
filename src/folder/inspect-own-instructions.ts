import { join } from "node:path";
import { withFolderReadLock } from "./lock";
import {
  maxOwnInstructionsBytes,
  ownInstructionsAllowed,
  ownInstructionsOfOrganization,
} from "./own-instructions";
import { inspectOwnedDirectory } from "./owned-directory";
import { readFolderState } from "./read-state";

// The person's own instructions for agents as one Folder records them (root
// decision 0233): the read-only twin of `updateOwnInstructions`, as
// `readFolderTools` is of `updateTools`. Under the common lock; nothing is
// written but the ephemeral lock.
export async function readFolderOwnInstructions(folder: string) {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  return withFolderReadLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    const preset = preferences.preset.name;
    const text = preferences.customInstructions;
    return Object.freeze({
      revision: preferences.revision,
      locale: preferences.profile.locale,
      /** Whether this Environment has own instructions at all; a text
       * recorded where it does not is kept and renders nothing. */
      allowed: ownInstructionsAllowed(preset, preferences.machine),
      /** A Work Environment: they belong to the Organization with the
       * Environment and its Admins may read them. */
      ofOrganization: ownInstructionsOfOrganization(preset),
      text,
      bytes: new TextEncoder().encode(text).length,
      maxBytes: maxOwnInstructionsBytes,
    });
  });
}
