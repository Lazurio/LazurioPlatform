import { planFolderChange } from "./change-profile";
import { type OutputPath, outputPaths } from "./outputs";
import {
  parseFolderPreferences,
  parseInstructionManifest,
  stateFields,
} from "./state";

export type FileIdentity = Readonly<{ dev: string; ino: string }>;
export type OutputIdentities = Readonly<Record<OutputPath, FileIdentity>>;

function identity(input: unknown): FileIdentity {
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

export function parseOutputIdentities(input: unknown): OutputIdentities {
  const value = stateFields(input, outputPaths);
  return Object.freeze(
    Object.fromEntries(
      outputPaths.map((path) => [path, identity(value[path])]),
    ),
  ) as OutputIdentities;
}

// The transaction journal schema: `before.json` snapshots the active state and
// the identities of every file the transaction will replace; `prepared.json`
// marks a fully staged transaction with the identities of the staged files.
export const transactionSchemaVersion = 3;

// Validates decoded journal structure and regenerates the proposed transition.
// This does not validate disk custody, current state or actual file identities;
// the activation/recovery adapter must check those under the common lock.
export async function validatePreparation(
  beforeInput: unknown,
  preferencesInput: unknown,
  manifestInput: unknown,
  markerInput: unknown,
  stagedContents: Readonly<Record<OutputPath, string>>,
) {
  const before = stateFields(beforeInput, [
    "schemaVersion",
    "preferences",
    "manifest",
    "outputIdentities",
    "preferencesIdentity",
    "manifestIdentity",
  ]);
  const marker = stateFields(markerInput, [
    "schemaVersion",
    "expectedRevision",
    "nextRevision",
    "outputIdentities",
    "preferences",
    "manifest",
    "preferencesIdentity",
    "manifestIdentity",
  ]);
  if (
    before.schemaVersion !== transactionSchemaVersion ||
    marker.schemaVersion !== transactionSchemaVersion
  )
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
  const previousIdentities = parseOutputIdentities(before.outputIdentities);
  const stagedIdentities = parseOutputIdentities(marker.outputIdentities);
  const previousPreferencesIdentity = identity(before.preferencesIdentity);
  const previousManifestIdentity = identity(before.manifestIdentity);
  const stagedPreferencesIdentity = identity(marker.preferencesIdentity);
  const stagedManifestIdentity = identity(marker.manifestIdentity);
  // The staged binding is part of the transition: a refresh carries the
  // re-projected binding of the same Machine, a profile change the recorded one.
  const plan = await planFolderChange(
    previousPreferences,
    previousManifest,
    previousPreferences.revision,
    {
      preset: preferences.preset.name,
      profile: preferences.profile,
      machine: preferences.machine,
    },
    async (path) => ({
      kind: "regular",
      digest: previousManifest.outputs[path],
    }),
  );
  if (
    plan.kind !== "profile-change" ||
    JSON.stringify(plan.preferences) !== JSON.stringify(preferences) ||
    JSON.stringify(plan.manifest) !== JSON.stringify(manifest) ||
    JSON.stringify(parseFolderPreferences(marker.preferences)) !==
      JSON.stringify(preferences) ||
    JSON.stringify(parseInstructionManifest(marker.manifest)) !==
      JSON.stringify(manifest) ||
    outputPaths.some(
      (path) => stagedContents[path] !== plan.desired[path].content,
    )
  )
    throw new Error("Transaction does not match regenerated transition");
  return {
    plan,
    previousPreferences,
    previousManifest,
    previousIdentities,
    stagedIdentities,
    previousPreferencesIdentity,
    previousManifestIdentity,
    stagedPreferencesIdentity,
    stagedManifestIdentity,
  };
}
