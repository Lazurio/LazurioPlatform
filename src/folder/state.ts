import {
  canonicalSettings,
  organizationGoverns,
} from "../organization-settings/governance";
import {
  type OrganizationSettingsValues,
  organizationSettings,
} from "../organizations/organization-settings";
import {
  parseEnabledTools,
  parseToolNotes,
  type ToolNotes,
} from "../tools/catalog";
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
// `tools` (decision F18) is the optional list of enabled catalog tools: sorted,
// unique, `recommended` or `optional` tier only. The key is absent when nothing
// is enabled, so a Folder that enables nothing keeps the bytes it always had;
// an empty list is refused, because one selection has one representation.
// `toolNotes` (decision F18, addendum 2026-09-27) is the optional object of the
// operator's notes for agents, keyed by a required or enabled tool, keys
// sorted; absent when there is no note, and an empty object is refused.
// `organizationSettings` (root decision 0194, decision F45) is the optional
// section of the Organization's settings this Folder applies, recorded from
// the Organization like the binding from the handover, because the generated
// Folder renders what they allow: exactly the governed keys of the closed
// section, in one representation (keys sorted, nothing empty), only on an
// Environment an Organization governs; absent when it governs nothing here.
export type FolderPreferences = Readonly<{
  schemaVersion: 2;
  revision: number;
  preset: PresetReference;
  machine: MachineBinding | null;
  profile: FolderProfile;
  customInstructions: string;
  tools?: readonly string[];
  toolNotes?: ToolNotes;
  organizationSettings?: OrganizationSettingsValues;
}>;

/** The Organization settings a Folder applies; `{}` when none. */
export function folderOrganizationSettings(
  preferences: Pick<FolderPreferences, "organizationSettings">,
): OrganizationSettingsValues {
  return preferences.organizationSettings ?? Object.freeze({});
}

/** A settings section as the Organization's contract reads it (a closed
 * section, every governed key valid), in its one representation. Throws on
 * anything else. */
export function parseOrganizationSettingsValues(
  input: unknown,
): OrganizationSettingsValues {
  const verdict = organizationSettings({ settings: input });
  if (verdict.status !== "valid")
    throw new Error("Invalid Organization settings");
  return canonicalSettings(verdict.values);
}

// The preference fields with the given Organization settings: the key present
// only when they govern something.
export function withOrganizationSettings<
  T extends Readonly<{ organizationSettings?: unknown }>,
>(
  fields: T,
  settings: OrganizationSettingsValues,
): Omit<T, "organizationSettings"> & {
  organizationSettings?: OrganizationSettingsValues;
} {
  const { organizationSettings: _, ...rest } = fields;
  return Object.keys(settings).length === 0
    ? rest
    : { ...rest, organizationSettings: settings };
}

export function enabledTools(
  preferences: Pick<FolderPreferences, "tools">,
): readonly string[] {
  return preferences.tools ?? [];
}

export function toolNotes(
  preferences: Pick<FolderPreferences, "toolNotes">,
): ToolNotes {
  return preferences.toolNotes ?? Object.freeze({});
}

// Preference fields with the given selection and notes: each key present only
// when it holds something.
export function withToolSelection<
  T extends Readonly<{ tools?: unknown; toolNotes?: unknown }>,
>(
  fields: T,
  tools: readonly string[],
  notes: ToolNotes,
): Omit<T, "tools" | "toolNotes"> & {
  tools?: readonly string[];
  toolNotes?: ToolNotes;
} {
  const { tools: _, toolNotes: __, ...rest } = fields;
  return {
    ...rest,
    ...(tools.length === 0 ? {} : { tools }),
    ...(Object.keys(notes).length === 0 ? {} : { toolNotes: notes }),
  };
}

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
  const withTools = ownDataValue(input, "tools") !== undefined;
  const withNotes = ownDataValue(input, "toolNotes") !== undefined;
  const withSettings =
    ownDataValue(input, "organizationSettings") !== undefined;
  const value = stateFields(input, [
    "schemaVersion",
    "revision",
    "preset",
    "machine",
    "profile",
    "customInstructions",
    ...(withTools ? ["tools"] : []),
    ...(withNotes ? ["toolNotes"] : []),
    ...(withSettings ? ["organizationSettings"] : []),
  ]);
  if (value.schemaVersion !== 2 || typeof value.customInstructions !== "string")
    throw new Error("Unsupported Folder preferences");
  const tools = withTools ? parseEnabledTools(value.tools) : undefined;
  if (tools?.length === 0)
    throw new Error("Empty enabled tools must be absent");
  const notes = withNotes
    ? parseToolNotes(value.toolNotes, tools ?? [])
    : undefined;
  if (notes !== undefined && Object.keys(notes).length === 0)
    throw new Error("Empty tool notes must be absent");
  const preset = parsePresetReference(value.preset);
  const machine = parseMachineBinding(value.machine);
  const profile = parseFolderProfile(value.profile);
  validatePresetComposition(preset.name, machine, profile);
  const settings = withSettings
    ? parseOrganizationSettingsValues(value.organizationSettings)
    : undefined;
  if (settings !== undefined) {
    if (Object.keys(settings).length === 0)
      throw new Error("Empty Organization settings must be absent");
    if (JSON.stringify(settings) !== JSON.stringify(value.organizationSettings))
      throw new Error("Organization settings not in their one representation");
    if (!organizationGoverns(preset.name))
      throw new Error("No Organization governs this Environment");
  }
  return Object.freeze({
    schemaVersion: 2,
    revision: revision(value.revision),
    preset,
    machine,
    profile,
    // Source is preserved verbatim. This schema neither executes it nor imports
    // effective mandates; composition/conflict handling is a separate consumer.
    customInstructions: value.customInstructions,
    ...(tools === undefined ? {} : { tools }),
    ...(notes === undefined ? {} : { toolNotes: notes }),
    ...(settings === undefined ? {} : { organizationSettings: settings }),
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
