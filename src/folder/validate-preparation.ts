import { planFolderChange } from "./change-profile";
import { type OutputPath, outputPaths } from "./outputs";
import { recordedFile } from "./reconcile";
import {
  enabledTools,
  folderOrganizationSettings,
  parseFolderPreferences,
  parseInstructionManifest,
  personalChatgptApps,
  stateFields,
  toolNotes,
} from "./state";

export type FileIdentity = Readonly<{ dev: string; ino: string }>;
export type OutputIdentities = Readonly<Record<OutputPath, FileIdentity>>;
// The identities before a change: null for an output the previous manifest
// does not own, which the change creates.
export type PreviousIdentities = Readonly<
  Record<OutputPath, FileIdentity | null>
>;

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

// The identities `before.json` records: null exactly for the outputs the
// previous manifest owns no digest of, an identity for every other.
export function parsePreviousIdentities(
  input: unknown,
  recorded: Readonly<Partial<Record<OutputPath, string>>>,
): PreviousIdentities {
  const value = stateFields(input, outputPaths);
  return Object.freeze(
    Object.fromEntries(
      outputPaths.map((path) => {
        if (recorded[path] !== undefined) return [path, identity(value[path])];
        if (value[path] !== null)
          throw new Error("Invalid transaction file identity");
        return [path, null];
      }),
    ),
  ) as PreviousIdentities;
}

// The transaction journal schema: `before.json` snapshots the active state and
// the identities of every file the transaction will replace, null for an
// output it creates; `prepared.json` marks a fully staged transaction with the
// identities of the staged files. Schema 4 (decision F14, addendum of
// 2026-10-14) adds the created output; schema 3 had an identity for each.
export const transactionSchemaVersion = 4;

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
  const previousIdentities = parsePreviousIdentities(
    before.outputIdentities,
    previousManifest.outputs,
  );
  const stagedIdentities = parseOutputIdentities(marker.outputIdentities);
  const previousPreferencesIdentity = identity(before.preferencesIdentity);
  const previousManifestIdentity = identity(before.manifestIdentity);
  const stagedPreferencesIdentity = identity(marker.preferencesIdentity);
  const stagedManifestIdentity = identity(marker.manifestIdentity);
  // The staged binding is part of the transition: a refresh carries the
  // re-projected binding of the same Machine, a profile change the recorded
  // one; the staged enabled tools and notes are the requested or the
  // recorded ones, and the staged Organization settings the applied or the
  // recorded ones.
  const plan = await planFolderChange(
    previousPreferences,
    previousManifest,
    previousPreferences.revision,
    {
      agentVoice: preferences.agentVoice ?? null,
      preset: preferences.preset.name,
      profile: preferences.profile,
      machine: preferences.machine,
      tools: enabledTools(preferences),
      notes: toolNotes(preferences),
      organizationSettings: folderOrganizationSettings(preferences),
      chatgptAppsAllowed: personalChatgptApps(preferences),
    },
    async (path) => recordedFile(previousManifest.outputs, path),
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
