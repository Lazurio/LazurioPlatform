import { type HostedEntry, parseHostedEntry } from "../launchpad/hosted-trust";
import { type MachineBinding, parseMachineBinding } from "./machine-binding";
import { type OutputPath, outputPaths } from "./outputs";
import {
  type PresetReference,
  parsePresetReference,
  validatePresetComposition,
} from "./presets";
import { type FolderProfile, parseFolderProfile } from "./profile";
import { ownDataValue, stateFields } from "./state-fields";

export { stateFields } from "./state-fields";

// Schema versions this product can read; a release declares them in its
// artifact identity so staging can check backward read compatibility.
export const folderStateSchemas = Object.freeze({
  preferences: Object.freeze([2]),
  manifest: Object.freeze([2]),
});

// Development schema for the generated-output transaction. Parsing is not proof
// of custody: a filesystem adapter must establish the state owner's trusted
// boundary. Schema 2 adds the workspace preset reference and the immutable
// Machine binding recorded from the handover (null on a workstation). The whole
// composition is validated: an unknown preset, version or disallowed
// combination never parses.
export type FolderPreferences = Readonly<{
  schemaVersion: 2;
  revision: number;
  preset: PresetReference;
  machine: MachineBinding | null;
  profile: FolderProfile;
  customInstructions: string;
  /** The hosted entry of this Machine (decision F16); null until recorded. */
  entry: HostedEntry | null;
}>;

// Manifest schema 2 records one digest per generated output, AGENTS.md and
// every manual file (decision F14), in the fixed output order. A digest is the
// proof of ownership for a file: bytes that differ from it are never replaced.
export type OutputDigests = Readonly<Record<OutputPath, string>>;
export type InstructionManifest = Readonly<{
  schemaVersion: 2;
  preferenceRevision: number;
  templateRevision: string;
  outputs: OutputDigests;
}>;

function revision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    throw new Error("Invalid Folder revision");
  return input;
}

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseOutputDigests(input: unknown): OutputDigests {
  const value = stateFields(input, outputPaths);
  const digests: Partial<Record<OutputPath, string>> = {};
  for (const path of outputPaths) {
    const digest = value[path];
    if (!isDigest(digest)) throw new Error("Invalid output digest");
    digests[path] = digest;
  }
  return Object.freeze(digests) as OutputDigests;
}

export function parseFolderPreferences(input: unknown): FolderPreferences {
  // `entry` joined schema 2 as an optional member: absent reads as null.
  const withEntry = ownDataValue(input, "entry") !== undefined;
  const value = stateFields(input, [
    "schemaVersion",
    "revision",
    "preset",
    "machine",
    "profile",
    "customInstructions",
    ...(withEntry ? ["entry" as const] : []),
  ]);
  if (value.schemaVersion !== 2 || typeof value.customInstructions !== "string")
    throw new Error("Unsupported Folder preferences");
  const preset = parsePresetReference(value.preset);
  const machine = parseMachineBinding(value.machine);
  const profile = parseFolderProfile(value.profile);
  validatePresetComposition(preset, machine, profile);
  const entry =
    !withEntry || value.entry === null ? null : parseHostedEntry(value.entry);
  // A hosted entry belongs to a Machine of an Organization's network, never to
  // a workstation Folder without a handover.
  if (entry !== null && machine === null)
    throw new Error("Hosted entry requires a Machine binding");
  return Object.freeze({
    schemaVersion: 2,
    revision: revision(value.revision),
    preset,
    machine,
    profile,
    // Source is preserved verbatim. This schema neither executes it nor imports
    // effective mandates; composition/conflict handling is a separate consumer.
    customInstructions: value.customInstructions,
    entry,
  });
}

export function parseInstructionManifest(input: unknown): InstructionManifest {
  const value = stateFields(input, [
    "schemaVersion",
    "preferenceRevision",
    "templateRevision",
    "outputs",
  ]);
  if (
    value.schemaVersion !== 2 ||
    typeof value.templateRevision !== "string" ||
    value.templateRevision.length === 0
  )
    throw new Error("Unsupported instruction manifest");
  return Object.freeze({
    schemaVersion: 2,
    preferenceRevision: revision(value.preferenceRevision),
    templateRevision: value.templateRevision,
    outputs: parseOutputDigests(value.outputs),
  });
}
