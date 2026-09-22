import type { MachineBinding } from "./machine-binding";
import type { FolderProfile } from "./profile";
import { stateFields } from "./state-fields";

// Workspace presets are data shipped with a release: no scripts, infrastructure
// or authority. A preset composes the fixed profile axes (access, purpose),
// defaults for the communication axes the Principal may change, the
// Personalspace policy, the provider identity mode, the offered surfaces and
// the supervision policy. Only whole presets are supported; editing a field
// does not create a new supported composition.
export const presetNames = [
  "local",
  "hosted-personal",
  "hosted-organization-personal",
  "hosted-organization-team",
] as const;
export type PresetName = (typeof presetNames)[number];
export const presetVersion = 1;
type MachineKind = "workstation" | MachineBinding["kind"];

export type WorkspacePreset = Readonly<{
  name: PresetName;
  version: typeof presetVersion;
  machineKinds: readonly MachineKind[];
  composition: Readonly<{
    access: FolderProfile["access"];
    purpose: FolderProfile["purpose"];
  }>;
  defaults: Readonly<{
    locale: FolderProfile["locale"];
    detail: FolderProfile["detail"];
    coordination: FolderProfile["coordination"];
  }>;
  personalspace: "present" | "never";
  providerIdentity: "own-sign-in" | "brokered-organization";
  surfaces: readonly ("launchpad" | "hosted-entry")[];
  supervision: "session" | "os-service-manager";
}>;

const defaults = Object.freeze({
  locale: "en",
  detail: "concise",
  coordination: "direct",
} as const);
const hosted = Object.freeze(["launchpad", "hosted-entry"] as const);

const presets: Readonly<Record<PresetName, WorkspacePreset>> = Object.freeze({
  local: Object.freeze({
    name: "local",
    version: presetVersion,
    machineKinds: Object.freeze(["workstation"] as const),
    composition: Object.freeze({ access: "local", purpose: "human" } as const),
    defaults,
    personalspace: "present",
    providerIdentity: "own-sign-in",
    surfaces: Object.freeze(["launchpad"] as const),
    supervision: "session",
  }),
  "hosted-personal": Object.freeze({
    name: "hosted-personal",
    version: presetVersion,
    machineKinds: Object.freeze(["personal-vm"] as const),
    composition: Object.freeze({ access: "remote", purpose: "human" } as const),
    defaults,
    personalspace: "present",
    providerIdentity: "own-sign-in",
    surfaces: hosted,
    supervision: "os-service-manager",
  }),
  "hosted-organization-personal": Object.freeze({
    name: "hosted-organization-personal",
    version: presetVersion,
    machineKinds: Object.freeze(["workspace-vm"] as const),
    composition: Object.freeze({ access: "remote", purpose: "human" } as const),
    defaults,
    personalspace: "never",
    providerIdentity: "own-sign-in",
    surfaces: hosted,
    supervision: "os-service-manager",
  }),
  "hosted-organization-team": Object.freeze({
    name: "hosted-organization-team",
    version: presetVersion,
    machineKinds: Object.freeze(["workspace-vm"] as const),
    composition: Object.freeze({ access: "remote", purpose: "human" } as const),
    defaults,
    personalspace: "never",
    providerIdentity: "brokered-organization",
    surfaces: hosted,
    supervision: "os-service-manager",
  }),
});

// The stored reference. `selection` records whether the Principal chose a
// preset other than the one derived from the handover at the time of choice;
// on a handover that derives none, every choice is `explicit`.
export type PresetReference = Readonly<{
  name: PresetName;
  version: typeof presetVersion;
  selection: "derived" | "explicit";
}>;

export function parsePresetName(input: unknown): PresetName {
  if (
    typeof input !== "string" ||
    !(presetNames as readonly string[]).includes(input)
  )
    throw new Error("Unknown workspace preset");
  return input as PresetName;
}

export function workspacePreset(name: PresetName): WorkspacePreset {
  return presets[parsePresetName(name)];
}

export function parsePresetReference(input: unknown): PresetReference {
  const value = stateFields(input, ["name", "version", "selection"]);
  const name = parsePresetName(value.name);
  if (value.version !== presetVersion)
    throw new Error("Unsupported workspace preset version");
  if (value.selection !== "derived" && value.selection !== "explicit")
    throw new Error("Invalid workspace preset selection");
  return Object.freeze({
    name,
    version: presetVersion,
    selection: value.selection,
  });
}

// The one fact the two Organization presets differ on: is the work VM assigned
// to ONE operator or shared by a Team? Since Machines v0.12.61 the handover
// states it as `owner.assignment` ({kind: "operator", github_login, github_id}
// | {kind: "team"}), copied from the reviewed owner overlay and never inferred;
// when present it is the only selector and nothing else is read. A handover
// without it (an older release, or an owner that declares none) proves only
// one side: a workspace VM without `owner.team` is assigned to one operator. A
// Team alone is NOT a fact about assignment: an Organization may model one
// operator's work VM as a GitHub Team named after them (found on the first real
// canary, 2026-09-22). So a Team-bearing handover without assignment has none
// (`null`) and the preset must be passed explicitly. Never guess from the Team
// name, the Machine name, the hostname or the operator account.
export type MachineAssignment = "operator" | "team";
export function machineAssignment(
  machine: MachineBinding,
): MachineAssignment | null {
  if (machine.owner.kind !== "organization") return "operator";
  if (machine.owner.assignment !== undefined)
    return machine.owner.assignment.kind;
  return machine.owner.team === null ? "operator" : null;
}

const organizationPresets: Readonly<Record<MachineAssignment, PresetName>> =
  Object.freeze({
    operator: "hosted-organization-personal",
    team: "hosted-organization-team",
  });

// The preset the handover derives, or `null` when the handover does not decide
// it (a workspace VM whose assignment is unknown). Derived only from
// machine.kind and the assignment above.
export function derivePreset(
  machine: MachineBinding | null,
): PresetName | null {
  if (machine === null) return "local";
  if (machine.kind === "personal-vm") return "hosted-personal";
  const assignment = machineAssignment(machine);
  return assignment === null ? null : organizationPresets[assignment];
}

// What the handover allows: a personal VM never takes an Organization preset
// and vice versa; a workstation is always `local`.
export function allowedPresets(
  machine: MachineBinding | null,
): readonly PresetName[] {
  const kind: MachineKind = machine === null ? "workstation" : machine.kind;
  return presetNames.filter((name) =>
    presets[name].machineKinds.includes(kind),
  );
}

export function presetReference(
  name: PresetName,
  machine: MachineBinding | null,
): PresetReference {
  if (!allowedPresets(machine).includes(name))
    throw new Error("Workspace preset is not allowed by the Machine handover");
  return Object.freeze({
    name,
    version: presetVersion,
    selection: name === derivePreset(machine) ? "derived" : "explicit",
  });
}

// Validates a stored or requested composition as a whole, before any mutation.
export function validatePresetComposition(
  reference: PresetReference,
  machine: MachineBinding | null,
  profile: FolderProfile,
): WorkspacePreset {
  const preset = workspacePreset(reference.name);
  if (!allowedPresets(machine).includes(preset.name))
    throw new Error("Workspace preset is not allowed by the Machine handover");
  if (
    profile.access !== preset.composition.access ||
    profile.purpose !== preset.composition.purpose
  )
    throw new Error("Profile does not match the workspace preset composition");
  return preset;
}

// Profile defaults a preset supplies for initialization; the Principal may
// change the communication axes afterwards through the ordinary profile change.
export function presetProfile(
  name: PresetName,
  os: FolderProfile["os"],
  choices: Partial<WorkspacePreset["defaults"]> = {},
): FolderProfile {
  const preset = workspacePreset(name);
  return Object.freeze({
    os,
    ...preset.composition,
    locale: choices.locale ?? preset.defaults.locale,
    detail: choices.detail ?? preset.defaults.detail,
    coordination: choices.coordination ?? preset.defaults.coordination,
  });
}
