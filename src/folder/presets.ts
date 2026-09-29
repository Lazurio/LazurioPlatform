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
  "hosted-organization-steward",
] as const;
export type PresetName = (typeof presetNames)[number];
export const presetVersion = 1;
type MachineKind = "workstation" | MachineBinding["kind"];

// The bot team an Environment runs in Lazurio MausBot (the Lazurio fork of
// OpenMausBot, decision 0169), declared as the defaults its service starts
// with. The service that installs and runs Lazurio MausBot owns applying them
// (its environment variables); the preset only states them, and the operator
// may change them in Lazurio MausBot. None of it grants access: the persona
// account's live GitHub rights are the limit.
export type BotTeam = Readonly<{
  runtime: "openmausbot";
  /** `OMB_DEFAULT_BOT_CWD`: every new bot starts in the Lazurio Folder. */
  workingFolder: "lazurio-folder";
  /** The team imported from the installed Lazurio MausBot release, by its
   * path in the release. */
  team: "lazurio/teams/steward.openmaus.json";
  /** The model-free GitHub intake (`OMB_GITHUB_INTAKE=1`). */
  githubIntake: Readonly<{
    /** `OMB_GITHUB_INTAKE_BOT`: the leader of the imported team, by its name. */
    bot: "team-leader";
    /** `OMB_GITHUB_INTAKE_SCOPE`. */
    scope: "organization";
    /** `OMB_GITHUB_INTAKE_OWNERS`: the Organization of the handover. */
    owners: "machine-organization";
    /** `OMB_GITHUB_INTAKE_EXCLUDE`: that Organization's repositories of these
     * kinds, as its declaration names them. */
    exclude: readonly ("infra" | "productionspace")[];
  }>;
}>;

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
  // `persona-account`: the persona's own machine GitHub user account, signed
  // in by the Environment's responsible operator (decision 0169).
  providerIdentity: "own-sign-in" | "brokered-organization" | "persona-account";
  surfaces: readonly ("launchpad" | "hosted-entry" | "openmausbot")[];
  supervision: "session" | "os-service-manager";
  botTeam: BotTeam | null;
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
    botTeam: null,
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
    botTeam: null,
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
    botTeam: null,
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
    botTeam: null,
  }),
  // Decision 0169: the Automated Environment of an Organization persona. An
  // Organization work VM with one responsible operator (an Owner or Admin)
  // whose GitHub identity is the persona's own account; Lazurio MausBot runs
  // the persona's bot team as a service next to the Launchpad and T3 Code.
  // `purpose` stays `human`: a person answers for every Machine (0169), and
  // the vocabulary sweep of decision 0156 is a separate step.
  "hosted-organization-steward": Object.freeze({
    name: "hosted-organization-steward",
    version: presetVersion,
    machineKinds: Object.freeze(["workspace-vm"] as const),
    composition: Object.freeze({ access: "remote", purpose: "human" } as const),
    defaults,
    personalspace: "never",
    providerIdentity: "persona-account",
    surfaces: Object.freeze([
      "launchpad",
      "hosted-entry",
      "openmausbot",
    ] as const),
    supervision: "os-service-manager",
    botTeam: Object.freeze({
      runtime: "openmausbot",
      workingFolder: "lazurio-folder",
      team: "lazurio/teams/steward.openmaus.json",
      githubIntake: Object.freeze({
        bot: "team-leader",
        scope: "organization",
        owners: "machine-organization",
        exclude: Object.freeze(["infra", "productionspace"] as const),
      }),
    } as const),
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

// The one fact the Organization presets differ on: is the work VM assigned
// to ONE operator, shared by a Team, or the Automated Environment of a persona
// with one responsible operator (decision 0169)? Since Machines v0.12.61 the
// handover states it as `owner.assignment` ({kind: "operator", github_login,
// github_id} | {kind: "team"}), copied from the reviewed owner overlay and
// never inferred; when present it is the only selector and nothing else is
// read. `automation` is accepted in a stored binding ahead of the Machines
// schema that will carry it. A handover
// without it (an older release, or an owner that declares none) proves only
// one side: a workspace VM without `owner.team` is assigned to one operator. A
// Team alone is NOT a fact about assignment: an Organization may model one
// operator's work VM as a GitHub Team named after them (found on the first real
// canary, 2026-09-22). So a Team-bearing handover without assignment has none
// (`null`) and the preset must be passed explicitly. Never guess from the Team
// name, the Machine name, the hostname or the operator account.
export type MachineAssignment = "operator" | "team" | "automation";
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
    automation: "hosted-organization-steward",
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
