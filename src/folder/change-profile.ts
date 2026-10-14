import {
  forbiddenTools,
  organizationGoverns,
} from "../organization-settings/governance";
import type { OrganizationSettingsValues } from "../organizations/organization-settings";
import {
  activatableTools,
  activeTools,
  parseEnabledTools,
  parseToolNotes,
  type ToolNotes,
  toolOffered,
} from "../tools/catalog";
import {
  type MachineBinding,
  machineIdentity,
  parseMachineBinding,
} from "./machine-binding";
import type { OutputPath } from "./outputs";
import {
  derivePreset,
  type PresetName,
  parsePresetName,
  presetReference,
  selectablePresets,
  workspacePreset,
} from "./presets";
import { desiredOutputs, outputDigests, previewFolder } from "./preview";
import { type FolderProfile, parseFolderProfile } from "./profile";
import type { ObservedFile } from "./reconcile";
import {
  instructionSource,
  instructionTemplateRevision,
  isOlderTemplateRevision,
  toolEnvironmentOf,
} from "./render";
import {
  enabledTools,
  folderOrganizationSettings,
  instructionManifestSchema,
  parseFolderPreferences,
  parseInstructionManifest,
  parseOrganizationSettingsValues,
  toolNotes,
  withOrganizationSettings,
  withToolSelection,
} from "./state";
import { ownDataValue, stateFields } from "./state-fields";
import {
  type AgentVoice,
  editVoice,
  parseAgentVoice,
  parseVoiceEdit,
  type VoiceEdit,
} from "./voice";

// One request shape for CLI, Launchpad and a future typed owner request: the
// preset (absent means keep the current one) and the full profile. The Machine
// binding is never part of a request; it is immutable.
export type ProfileRequest = Readonly<{
  voice?: VoiceEdit;
  preset: PresetName | undefined;
  profile: FolderProfile;
}>;

export function parseProfileRequest(input: unknown): ProfileRequest {
  const withVoice = ownDataValue(input, "voice") !== undefined;
  const withPreset = ownDataValue(input, "preset") !== undefined;
  const value = stateFields(input, [
    "profile",
    ...(withPreset ? ["preset"] : []),
    ...(withVoice ? ["voice"] : []),
  ]);
  const profile = parseFolderProfile(value.profile);
  const voice = withVoice ? parseVoiceEdit(value.voice) : undefined;
  if (voice !== undefined && voice.locale !== profile.locale)
    throw new Error("Voice locale differs from the requested profile");
  return Object.freeze({
    ...(voice === undefined ? {} : { voice }),
    preset: withPreset ? parsePresetName(value.preset) : undefined,
    profile: parseFolderProfile(value.profile),
  });
}

// Shared profile-change planning. The caller reads trusted current state under
// the common lock and must revalidate before writing. This is not an apply token.
// A requested profile change keeps the recorded Machine binding, the
// recorded enabled tools and the operator's notes on them.
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
    {
      ...requested,
      ...(requested.voice === undefined
        ? {}
        : { agentVoice: editVoice(current.agentVoice, requested.voice) }),
      machine: current.machine,
      tools: enabledTools(current),
      notes: toolNotes(current),
      organizationSettings: folderOrganizationSettings(current),
    },
    inspect,
  );
}

// A requested change of the enabled catalog tools (decision F18): the full
// next selection at the expected revision, and optionally the full next set
// of the operator's notes (F18 addendum 2026-09-27). Without notes the
// recorded ones are carried forward for the tools that stay on, so disabling
// a tool removes its note in the same change. The recorded preset, profile
// and Machine binding are carried forward; the same selection and notes are
// `unchanged`. A tool the Organization does not allow here (decision F45)
// keeps the person's recorded choice: a selection that changes it is refused
// (`organization-governed`), whichever way, because the Organization decides
// it now; every other tool changes as requested.
export async function planToolsChange(
  currentPreferencesInput: unknown,
  currentManifestInput: unknown,
  expectedRevision: number,
  requestedInput: unknown,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
  requestedNotes?: unknown,
) {
  const current = parseFolderPreferences(currentPreferencesInput);
  const tools = parseEnabledTools(requestedInput);
  // A tool this Environment does not offer is never newly enabled (decision
  // F44: gogcli on a work Environment); one the selection already names
  // stays, so the stored selection is readable and can turn it off.
  const environment = toolEnvironmentOf(current.preset.name, current.profile);
  const recorded = enabledTools(current);
  if (
    tools.some(
      (name) =>
        !recorded.includes(name) &&
        activatableTools().some(
          (entry) => entry.name === name && !toolOffered(entry, environment),
        ),
    )
  )
    return { kind: "blocked", reason: "tool-not-offered" } as const;
  const settings = folderOrganizationSettings(current);
  const governed = forbiddenTools(settings).find(
    (tool) => tools.includes(tool) !== recorded.includes(tool),
  );
  if (governed !== undefined)
    return {
      kind: "blocked",
      reason: "organization-governed",
      tool: governed,
    } as const;
  return planFolderChange(
    current,
    currentManifestInput,
    expectedRevision,
    {
      preset: current.preset.name,
      profile: current.profile,
      machine: current.machine,
      tools,
      notes:
        requestedNotes === undefined
          ? keptNotes(toolNotes(current), tools)
          : parseToolNotes(requestedNotes, tools),
      organizationSettings: settings,
    },
    inspect,
  );
}

// The Organization's settings this Folder applies (root decision 0194 point
// 4, decision F45): the full next section, everything else carried forward,
// at the current revision (no caller holds one: the Launchpad applies what
// the Organization decided). An Environment no Organization governs records
// none; the same section is `unchanged`.
export async function planOrganizationSettingsChange(
  currentPreferencesInput: unknown,
  currentManifestInput: unknown,
  requestedInput: unknown,
  inspect: (path: OutputPath) => Promise<ObservedFile>,
) {
  const current = parseFolderPreferences(currentPreferencesInput);
  const settings = parseOrganizationSettingsValues(requestedInput);
  if (
    Object.keys(settings).length > 0 &&
    !organizationGoverns(current.preset.name)
  )
    return {
      kind: "blocked",
      reason: "organization-settings-not-governed",
    } as const;
  return planFolderChange(
    current,
    currentManifestInput,
    current.revision,
    {
      preset: current.preset.name,
      profile: current.profile,
      machine: current.machine,
      tools: enabledTools(current),
      notes: toolNotes(current),
      organizationSettings: settings,
    },
    inspect,
  );
}

// The recorded notes of the tools that are on in the next selection.
function keptNotes(notes: ToolNotes, tools: readonly string[]): ToolNotes {
  const on = activeTools(tools).map((entry) => entry.name);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(notes).filter(([name]) => on.includes(name)),
    ),
  );
}

// The one planner behind every change of the generated Folder: a requested
// profile change (the binding and the enabled tools carried forward), a
// requested change of the enabled tools and notes (everything else carried
// forward) and a refresh from the current handover (the recorded preset,
// profile, tools and notes carried forward, the binding of the same Machine
// re-projected). The Machine identity never changes here; the
// handover-derived rest of the binding (assignment, relationships, document
// digest, entry) follows the handover. A binding that renders the same bytes
// and declares the same entry is `unchanged` and is not recorded, so a
// re-apply that only rewrote `installed` never bumps the revision.
export type FolderChange = Readonly<{
  // Undefined keeps the record; null removes the last override.
  agentVoice?: AgentVoice | null;
  preset: PresetName | undefined;
  profile: FolderProfile;
  machine: MachineBinding | null;
  tools: readonly string[];
  notes: ToolNotes;
  organizationSettings: OrganizationSettingsValues;
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
  // An older template revision is upgraded by this change: its bytes cannot be
  // re-rendered by this product, so the recorded digests are the only proof of
  // ownership and every file must still match them (the preview refuses any
  // other with `drift`). A revision this product does not know, newer or of
  // another form, needs a product at least that new; it is never downgraded.
  const templateUpgrade =
    manifest.templateRevision !== instructionTemplateRevision;
  if (templateUpgrade && !isOlderTemplateRevision(manifest.templateRevision))
    return { kind: "blocked", reason: "template-upgrade-required" } as const;
  if (change.profile.os !== current.profile.os)
    return { kind: "blocked", reason: "execution-os-change" } as const;
  if (current.customInstructions !== "")
    return {
      kind: "blocked",
      reason: "custom-composition-unavailable",
    } as const;
  const nextVoice =
    change.agentVoice === undefined
      ? current.agentVoice
      : change.agentVoice === null
        ? undefined
        : parseAgentVoice(change.agentVoice);
  const machine = parseMachineBinding(change.machine);
  const tools = parseEnabledTools(change.tools);
  const notes = parseToolNotes(change.notes, tools);
  const settings = parseOrganizationSettingsValues(change.organizationSettings);
  if (
    JSON.stringify(machineIdentity(machine)) !==
    JSON.stringify(machineIdentity(current.machine))
  )
    return { kind: "blocked", reason: "binding-changed" } as const;
  // The preset may only change to one the handover offers as a new choice
  // (issue #107: the derived one when it states `owner.assignment`); the
  // recorded preset stays valid within the machine-kind allow-list. The fixed
  // axes of the profile must match the requested preset's composition.
  const presetName = change.preset ?? current.preset.name;
  if (!selectablePresets(machine, current.preset.name).includes(presetName))
    return { kind: "blocked", reason: "preset-not-allowed" } as const;
  const composition = workspacePreset(presetName).composition;
  if (
    change.profile.access !== composition.access ||
    change.profile.purpose !== composition.purpose
  )
    return { kind: "blocked", reason: "preset-composition" } as const;
  // An unchanged preset keeps its recorded reference: the choice was not made
  // again. A preset recorded as derived that the handover no longer derives
  // (the assignment changed) is not carried forward silently; the Operator
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
  // manifest that claims other bytes is incomplete state, not drift. Only this
  // template revision can be rendered again, so an upgrade skips the check.
  if (!templateUpgrade) {
    const expectedCurrent = outputDigests(
      desiredOutputs(instructionSource(current)),
    );
    if (JSON.stringify(expectedCurrent) !== JSON.stringify(manifest.outputs))
      return { kind: "blocked", reason: "incomplete-state" } as const;
  }

  const preview = await previewFolder(
    {
      ...(nextVoice === undefined ? {} : { agentVoice: nextVoice }),
      preset: preset.name,
      machine,
      profile: change.profile,
      tools,
      toolNotes: notes,
      organizationSettings: settings,
    },
    manifest.outputs,
    inspect,
  );
  if (preview.plan.kind === "blocked") return preview.plan;
  // Bound the full generated document, including the fence and other settings.
  // An oversized composition is never staged or silently truncated.
  if (
    (nextVoice !== undefined || change.agentVoice !== undefined) &&
    new TextEncoder().encode(preview.desired["AGENTS.md"].content).length >
      32 * 1024
  )
    return { kind: "blocked", reason: "voice-context-too-large" } as const;
  // The entry is the one part of the binding the product acts on, not only
  // renders: the Launchpad serves and admits from the recorded one. A changed
  // entry is recorded even when the Folder renders the same bytes. So is a
  // changed selection or note: a tool this Environment does not offer is not
  // rendered (decision F44), and switching it off changes only the record;
  // and so is a changed section of Organization settings, which Settings →
  // Tools and `lazurio tools` act on (decision F45).
  if (
    preview.plan.kind === "unchanged" &&
    JSON.stringify(nextVoice) === JSON.stringify(current.agentVoice) &&
    JSON.stringify(machine?.entry) === JSON.stringify(current.machine?.entry) &&
    JSON.stringify(tools) === JSON.stringify(enabledTools(current)) &&
    JSON.stringify(notes) === JSON.stringify(toolNotes(current)) &&
    JSON.stringify(settings) ===
      JSON.stringify(folderOrganizationSettings(current))
  )
    return { kind: "unchanged" } as const;
  if (current.revision === Number.MAX_SAFE_INTEGER)
    return { kind: "blocked", reason: "revision-exhausted" } as const;
  const { agentVoice: _previousVoice, ...currentFields } = current;
  const preferences = parseFolderPreferences(
    withOrganizationSettings(
      withToolSelection(
        {
          ...currentFields,
          schemaVersion:
            current.schemaVersion === 3 || nextVoice !== undefined ? 3 : 2,
          ...(nextVoice === undefined ? {} : { agentVoice: nextVoice }),
          revision: current.revision + 1,
          preset,
          machine,
          profile: change.profile,
        },
        tools,
        notes,
      ),
      settings,
    ),
  );
  // Every change writes the manifest of this product's outputs: an older
  // template revision recorded at schema 2 is upgraded with the outputs it
  // did not own, created where nothing was at their path (the preview
  // refuses anything there as `unowned-file`).
  const nextManifest = parseInstructionManifest({
    schemaVersion: instructionManifestSchema,
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
    files: preview.plan.kind === "write" ? preview.plan.files : [],
  };
}
