import type { OutputPath } from "./outputs";
import {
  allowedPresets,
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
export async function planProfileChange(
  currentPreferencesInput: unknown,
  currentManifestInput: unknown,
  expectedRevision: number,
  requestedInput: unknown,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
) {
  const current = parseFolderPreferences(currentPreferencesInput);
  const manifest = parseInstructionManifest(currentManifestInput);
  const requested = parseProfileRequest(requestedInput);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision !== current.revision
  )
    return { kind: "blocked", reason: "stale-revision" } as const;
  if (manifest.preferenceRevision !== current.revision)
    return { kind: "blocked", reason: "incomplete-state" } as const;
  if (manifest.templateRevision !== instructionTemplateRevision)
    return { kind: "blocked", reason: "template-upgrade-required" } as const;
  if (requested.profile.os !== current.profile.os)
    return { kind: "blocked", reason: "execution-os-change" } as const;
  if (current.customInstructions !== "")
    return {
      kind: "blocked",
      reason: "custom-composition-unavailable",
    } as const;
  // The preset may only change within what the recorded handover allows, and
  // the fixed axes of the profile must match the requested preset's composition.
  const presetName = requested.preset ?? current.preset.name;
  if (!allowedPresets(current.machine).includes(presetName))
    return { kind: "blocked", reason: "preset-not-allowed" } as const;
  const composition = workspacePreset(presetName).composition;
  if (
    requested.profile.access !== composition.access ||
    requested.profile.purpose !== composition.purpose
  )
    return { kind: "blocked", reason: "preset-composition" } as const;
  const preset = presetReference(presetName, current.machine);

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
      machine: current.machine,
      profile: requested.profile,
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
    profile: requested.profile,
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
