import { type MachineBinding, parseMachineBinding } from "./machine-binding";
import {
  type PresetReference,
  parsePresetReference,
  validatePresetComposition,
} from "./presets";
import { type FolderProfile, parseFolderProfile } from "./profile";
import { stateFields } from "./state-fields";

export { stateFields } from "./state-fields";

// Schema versions this product can read; a release declares them in its
// artifact identity so staging can check backward read compatibility.
export const folderStateSchemas = Object.freeze({
  preferences: Object.freeze([2]),
  manifest: Object.freeze([1]),
});

// Development schema for the single-output transaction. Parsing is not proof of
// custody: a filesystem adapter must establish the state owner's trusted boundary.
// Schema 2 adds the workspace preset reference and the immutable Machine binding
// recorded from the handover (null on a workstation). The whole composition is
// validated: an unknown preset, version or disallowed combination never parses.
export type FolderPreferences = Readonly<{
  schemaVersion: 2;
  revision: number;
  preset: PresetReference;
  machine: MachineBinding | null;
  profile: FolderProfile;
  customInstructions: string;
}>;

export type InstructionManifest = Readonly<{
  schemaVersion: 1;
  preferenceRevision: number;
  templateRevision: string;
  output: Readonly<{ path: "AGENTS.md"; digest: string }>;
}>;

function revision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1)
    throw new Error("Invalid Folder revision");
  return input;
}

export function parseFolderPreferences(input: unknown): FolderPreferences {
  const value = stateFields(input, [
    "schemaVersion",
    "revision",
    "preset",
    "machine",
    "profile",
    "customInstructions",
  ]);
  if (value.schemaVersion !== 2 || typeof value.customInstructions !== "string")
    throw new Error("Unsupported Folder preferences");
  const preset = parsePresetReference(value.preset);
  const machine = parseMachineBinding(value.machine);
  const profile = parseFolderProfile(value.profile);
  validatePresetComposition(preset, machine, profile);
  return Object.freeze({
    schemaVersion: 2,
    revision: revision(value.revision),
    preset,
    machine,
    profile,
    // Source is preserved verbatim. This schema neither executes it nor imports
    // effective mandates; composition/conflict handling is a separate consumer.
    customInstructions: value.customInstructions,
  });
}

export function parseInstructionManifest(input: unknown): InstructionManifest {
  const value = stateFields(input, [
    "schemaVersion",
    "preferenceRevision",
    "templateRevision",
    "output",
  ]);
  const output = stateFields(value.output, ["path", "digest"]);
  if (
    value.schemaVersion !== 1 ||
    typeof value.templateRevision !== "string" ||
    value.templateRevision.length === 0 ||
    output.path !== "AGENTS.md" ||
    typeof output.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(output.digest)
  )
    throw new Error("Unsupported instruction manifest");
  return Object.freeze({
    schemaVersion: 1,
    preferenceRevision: revision(value.preferenceRevision),
    templateRevision: value.templateRevision,
    output: Object.freeze({ path: "AGENTS.md", digest: output.digest }),
  });
}
