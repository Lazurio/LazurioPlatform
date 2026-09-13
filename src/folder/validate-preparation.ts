import { planProfileChange } from "./change-profile";
import {
  parseFolderPreferences,
  parseInstructionManifest,
  stateFields,
} from "./state";

function identity(input: unknown) {
  const value = stateFields(input, ["dev", "ino"]);
  if (
    typeof value.dev !== "string" ||
    typeof value.ino !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value.dev) ||
    !/^[1-9][0-9]*$/.test(value.ino)
  )
    throw new Error("Invalid transaction file identity");
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

// Validates decoded journal structure and regenerates the proposed transition.
// This does not validate disk custody, current state or actual file identities;
// the activation/recovery adapter must check those under the common lock.
export async function validatePreparation(
  beforeInput: unknown,
  preferencesInput: unknown,
  manifestInput: unknown,
  markerInput: unknown,
  stagedContent: string,
) {
  const before = stateFields(beforeInput, [
    "schemaVersion",
    "preferences",
    "manifest",
    "outputIdentity",
    "preferencesIdentity",
    "manifestIdentity",
  ]);
  const marker = stateFields(markerInput, [
    "schemaVersion",
    "expectedRevision",
    "nextRevision",
    "outputIdentity",
    "outputDigest",
    "preferences",
    "manifest",
    "preferencesIdentity",
    "manifestIdentity",
  ]);
  if (before.schemaVersion !== 2 || marker.schemaVersion !== 2)
    throw new Error("Unsupported transaction schema");
  const previousPreferences = parseFolderPreferences(before.preferences);
  const previousManifest = parseInstructionManifest(before.manifest);
  const preferences = parseFolderPreferences(preferencesInput);
  const manifest = parseInstructionManifest(manifestInput);
  if (
    marker.expectedRevision !== previousPreferences.revision ||
    marker.nextRevision !== preferences.revision
  )
    throw new Error("Transaction revision mismatch");
  const previousIdentity = identity(before.outputIdentity);
  const stagedIdentity = identity(marker.outputIdentity);
  const previousPreferencesIdentity = identity(before.preferencesIdentity);
  const previousManifestIdentity = identity(before.manifestIdentity);
  const stagedPreferencesIdentity = identity(marker.preferencesIdentity);
  const stagedManifestIdentity = identity(marker.manifestIdentity);
  const plan = await planProfileChange(
    previousPreferences,
    previousManifest,
    previousPreferences.revision,
    preferences.profile,
    async () => ({ kind: "regular", digest: previousManifest.output.digest }),
  );
  if (
    plan.kind !== "profile-change" ||
    JSON.stringify(plan.preferences) !== JSON.stringify(preferences) ||
    JSON.stringify(plan.manifest) !== JSON.stringify(manifest) ||
    JSON.stringify(parseFolderPreferences(marker.preferences)) !==
      JSON.stringify(preferences) ||
    JSON.stringify(parseInstructionManifest(marker.manifest)) !==
      JSON.stringify(manifest) ||
    marker.outputDigest !== plan.desired.digest ||
    stagedContent !== plan.desired.content
  )
    throw new Error("Transaction does not match regenerated transition");
  return {
    plan,
    previousPreferences,
    previousManifest,
    previousIdentity,
    stagedIdentity,
    previousPreferencesIdentity,
    previousManifestIdentity,
    stagedPreferencesIdentity,
    stagedManifestIdentity,
  };
}
