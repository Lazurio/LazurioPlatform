import {
  type MachineBinding,
  machineIdentity,
  parseMachineBinding,
} from "./machine-binding";
import type { OutputPath } from "./outputs";
import {
  allowedPresets,
  derivePreset,
  type PresetName,
  parsePresetName,
  presetReference,
  workspacePreset,
} from "./presets";
import { desiredOutputs, outputDigests, previewFolder } from "./preview";
import { type FolderProfile, parseFolderProfile } from "./profile";
import type { ObservedFile } from "./reconcile";
import { instructionSource, instructionTemplateRevision } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";
import { ownDataValue, stateFields } from "./state-fields";

// One request shape for CLI, Launchpad and a future typed owner request: the
// preset (absent means keep the current one) and the full profile. The Machine
// binding is never part of a request; it is immutable.
export type ProfileRequest = Readonly<{
  preset: PresetName | undefined;
  profile: FolderProfile;
}>;

export function parseProfileRequest(input: unknown): ProfileRequest {
  const withPreset = ownDataValue(input, "preset") !== undefined;
  const value = stateFields(
    input,
    withPreset ? ["preset", "profile"] : ["profile"],
  );
  return Object.freeze({
    preset: withPreset ? parsePresetName(value.preset) : undefined,
    profile: parseFolderProfile(value.profile),
  });
}

// Shared profile-change planning. The caller reads trusted current state under
// the common lock and must revalidate before writing. This is not an apply token.
// A requested profile change keeps the recorded Machine binding.
export async function planProfileChange(
  currentPreferencesInput: unknown,
  currentManifestInput: unknown,
  expectedRevision: number,
  requestedInput: unknown,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
) {
  const current = parseFolderPreferences(currentPreferencesInput);
  const requested = parseProfileRequest(requestedInput);
  return planFolderChange(
    current,
    currentManifestInput,
    expectedRevision,
    { ...requested, machine: current.machine },
    inspect,
  );
}

// The one planner behind every change of the generated Folder: a requested
// profile change (the binding carried forward) and a refresh from the current
// handover (the recorded preset and profile carried forward, the binding of
// the same Machine re-projected). The Machine identity never changes here; the
// handover-derived rest of the binding (assignment, relationships, document
// digest) follows the handover. A binding that renders the same bytes is
// `unchanged` and is not recorded, so a re-apply that only rewrote
// `installed` never bumps the revision.
export type FolderChange = Readonly<{
  preset: PresetName | undefined;
  profile: FolderProfile;
  machine: MachineBinding | null;
}>;

export async function planFolderChange(
  currentPreferencesInput: unknown,
  currentManifestInput: unknown,
  expectedRevision: number,
  change: FolderChange,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
) {
  const current = parseFolderPreferences(currentPreferencesInput);
  const manifest = parseInstructionManifest(currentManifestInput);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision !== current.revision
  )
    return { kind: "blocked", reason: "stale-revision" } as const;
  if (manifest.preferenceRevision !== current.revision)
    return { kind: "blocked", reason: "incomplete-state" } as const;
  if (manifest.templateRevision !== instructionTemplateRevision)
    return { kind: "blocked", reason: "template-upgrade-required" } as const;
  if (change.profile.os !== current.profile.os)
    return { kind: "blocked", reason: "execution-os-change" } as const;
  if (current.customInstructions !== "")
    return {
      kind: "blocked",
      reason: "custom-composition-unavailable",
    } as const;
  const machine = parseMachineBinding(change.machine);
  if (
    JSON.stringify(machineIdentity(machine)) !==
    JSON.stringify(machineIdentity(current.machine))
  )
    return { kind: "blocked", reason: "binding-changed" } as const;
  // The preset may only change within what the handover allows, and the fixed
  // axes of the profile must match the requested preset's composition.
  const presetName = change.preset ?? current.preset.name;
  if (!allowedPresets(machine).includes(presetName))
    return { kind: "blocked", reason: "preset-not-allowed" } as const;
  const composition = workspacePreset(presetName).composition;
  if (
    change.profile.access !== composition.access ||
    change.profile.purpose !== composition.purpose
  )
    return { kind: "blocked", reason: "preset-composition" } as const;
  // An unchanged preset keeps its recorded reference: the choice was not made
  // again. A preset recorded as derived that the handover no longer derives
  // (the assignment changed) is not carried forward silently; the Principal
  // chooses it again through a profile change.
  if (
    presetName === current.preset.name &&
    current.preset.selection === "derived" &&
    derivePreset(machine) !== presetName
  )
    return { kind: "blocked", reason: "preset-derivation-changed" } as const;
  const preset =
    presetName === current.preset.name
      ? current.preset
      : presetReference(presetName, machine);

  // The recorded digests must be what the current composition renders; a
  // manifest that claims other bytes is incomplete state, not drift.
  const expectedCurrent = outputDigests(
    desiredOutputs(instructionSource(current)),
  );
  if (JSON.stringify(expectedCurrent) !== JSON.stringify(manifest.outputs))
    return { kind: "blocked", reason: "incomplete-state" } as const;

  const preview = await previewFolder(
    {
      preset: preset.name,
      machine,
      profile: change.profile,
    },
    manifest.outputs,
    inspect,
  );
  if (preview.plan.kind === "blocked") return preview.plan;
  if (preview.plan.kind === "unchanged") return { kind: "unchanged" } as const;
  if (current.revision === Number.MAX_SAFE_INTEGER)
    return { kind: "blocked", reason: "revision-exhausted" } as const;
  const preferences = parseFolderPreferences({
    ...current,
    revision: current.revision + 1,
    preset,
    machine,
    profile: change.profile,
  });
  const nextManifest = parseInstructionManifest({
    schemaVersion: 2,
    preferenceRevision: preferences.revision,
    templateRevision: preview.templateRevision,
    outputs: outputDigests(preview.desired),
  });
  return {
    kind: "profile-change" as const,
    expectedRevision: current.revision,
    previous: manifest.outputs,
    preferences,
    manifest: nextManifest,
    desired: preview.desired,
    files: preview.plan.files,
  };
}
