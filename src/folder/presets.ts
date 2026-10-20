import type { EntryAudience } from "../launchpad/public-environment";
import type { ShellEnvironmentKind } from "../shell/contract";
import type {
  MachineAssignment as BindingAssignment,
  MachineBinding,
} from "./machine-binding";
import type { FolderProfile } from "./profile";
import { stateFields } from "./state-fields";

// Workspace presets are data shipped with a release: no scripts, infrastructure
// or authority. A preset composes the fixed profile axes (access, purpose),
// defaults for the communication axes the Operator may change, the
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
  runtime: "mausbot";
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
  surfaces: readonly ("launchpad" | "hosted-entry" | "mausbot")[];
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
    surfaces: Object.freeze(["launchpad", "hosted-entry", "mausbot"] as const),
    supervision: "os-service-manager",
    botTeam: Object.freeze({
      runtime: "mausbot",
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

// The stored reference. `selection` records whether the Operator chose a
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

// The Try overlay preset (decision F55's addendum of 2026-10-20, plan
// DEV-6668 slice 4; root decision 0204's addendum of 2026-10-18 (b)): what
// public means inside the app, as one frozen record a reviewer reads in one
// place. It is not one of `presetNames`. A preset says how an Environment is
// assigned and composes its Folder; this record lies over the preset the
// Folder records (Team on try-01, or the Work it may have recorded earlier),
// which stays underneath with every rule of its own. It is never recorded,
// never chosen and never passed as `--preset`. One switch selects it: the
// handover's `entry.audience: "public"`, which Machines writes from the
// gateway's `public-account` admission (F55 point 1). The same kind of
// nullable record as the Steward preset's `botTeam`.
export type VisitorPreset = Readonly<{
  /** Its name in documents, never a `PresetName`. */
  name: "try";
  /** Začínáme's demo instead of a person's basics (F55 point 3). */
  onboarding: "demo";
  /** No broker, no App and no person's sign-in (F55's addendum of
   * 2026-10-17, decision 0191 point 39). */
  githubIdentity: "none";
  /** What a visitor does not have, its pages and its API: Integrace and
   * Nastavení → Nástroje (F55 point 5). Not the vault: it follows the vault
   * core, which decides whether this Environment has one. Until plan slice 6
   * (#499) lists Trezor by that answer, `withheldInPublic` still withholds
   * it. */
  withheld: readonly ("integrations" | "tools")[];
  /** The visitor's terms and privacy pages on lazurio.ai, by language. The
   * gateway's entry card, Machines' own, shows them before entry; the app
   * only reminds of them. */
  notice: Readonly<{
    terms: Readonly<Record<FolderProfile["locale"], string>>;
    privacy: Readonly<Record<FolderProfile["locale"], string>>;
  }>;
  /** The section of the generated instructions for visitors' agents (plan
   * slice 5): AGENTS.md and `manual/this-machine.md` render it where this is
   * `visitors` (`visitorsOf` in `src/folder/render.ts`). */
  instructions: "visitors";
  /** What nobody changes here, since every visitor shares it: the preset
   * (one fixed option in Settings → Obecné, a change refused as
   * `preset-fixed`) and the theme (root decision 0208 point 6). */
  fixed: readonly ("preset" | "theme")[];
  /** The kind people are shown, whatever the recorded preset: a Team
   * Environment, set apart by its words, never a fourth kind (root decision
   * 0207). */
  shownKind: Extract<ShellEnvironmentKind, "team">;
}>;

export const tryPreset: VisitorPreset = Object.freeze({
  name: "try",
  onboarding: "demo",
  githubIdentity: "none",
  withheld: Object.freeze(["integrations", "tools"] as const),
  notice: Object.freeze({
    terms: Object.freeze({
      en: "https://lazurio.ai/try/terms/",
      cs: "https://lazurio.ai/cs/vyzkouset/podminky/",
    }),
    privacy: Object.freeze({
      en: "https://lazurio.ai/try/privacy/",
      cs: "https://lazurio.ai/cs/vyzkouset/ochrana-soukromi/",
    }),
  }),
  instructions: "visitors",
  fixed: Object.freeze(["preset", "theme"] as const),
  shownKind: "team",
});

/** The Try overlay preset where the Environment is public, else null: the
 * one reader of `entry.audience`, of a binding, of `POST /api/profile`'s
 * machine or of the public parts of the entry the page reads. Pure and free
 * of Node, so the page and the server share it. */
export function visitorPreset(
  machine:
    | Readonly<{
        entry?: Readonly<{ audience?: EntryAudience }> | null | undefined;
      }>
    | null
    | undefined,
): VisitorPreset | null {
  return machine?.entry?.audience === "public" ? tryPreset : null;
}

/** Whether nobody may change `setting` in this Environment: only where the
 * Try overlay fixes it. */
export function isFixed(
  machine: Parameters<typeof visitorPreset>[0],
  setting: VisitorPreset["fixed"][number],
): boolean {
  return visitorPreset(machine)?.fixed.includes(setting) === true;
}

/** The GitHub identity an Environment has: its preset's `providerIdentity`,
 * or the Try overlay's `none` on a public Environment (root decision 0204
 * point 5, decision F55's addendum of 2026-10-17), whatever its preset: no
 * broker, no App and no person's sign-in. Its Organization's public
 * repositories are read anonymously and nothing is published from it. The
 * one rule for the content install's scope, the generated texts and the
 * wording of the tools. */
export type GithubIdentity =
  | WorkspacePreset["providerIdentity"]
  | VisitorPreset["githubIdentity"];

export function githubIdentity(
  preset: PresetName,
  machine: Readonly<{ entry?: MachineBinding["entry"] }> | null | undefined,
): GithubIdentity {
  return (
    visitorPreset(machine)?.githubIdentity ??
    workspacePreset(preset).providerIdentity
  );
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
// to ONE operator, shared by a Team, the Automated Environment of a persona
// with one responsible operator (decision 0169), or the services Environment
// of a server (root decision 0209)? Since Machines v0.12.61 the handover
// states it as `owner.assignment` ({kind: "operator", github_login,
// github_id} | {kind: "team"}, since Machines #277 {kind: "automation",
// github_login, github_id}, and since DEV-6674 {kind: "services"}), copied
// from the reviewed owner overlay and never inferred; when present it is the
// only selector and nothing else is read. A
// handover without it (an older release, or an owner that declares none)
// proves only one side: a workspace VM without `owner.team` is assigned to one
// operator. A Team alone is NOT a fact about assignment: an Organization may
// model one operator's work VM as a GitHub Team named after them (found on the
// first real canary, 2026-09-22). So a Team-bearing handover without assignment has none
// (`null`) and the preset must be passed explicitly. Never guess from the Team
// name, the Machine name, the hostname or the operator account.
export type MachineAssignment = BindingAssignment["kind"];
export function machineAssignment(
  machine: MachineBinding,
): MachineAssignment | null {
  if (machine.owner.kind !== "organization") return "operator";
  if (machine.owner.assignment !== undefined)
    return machine.owner.assignment.kind;
  return machine.owner.team === null ? "operator" : null;
}

// Keyed by every assignment kind, so a kind added to the binding fails to
// compile here until it derives a preset. Služby serveru (`services`, root
// decision 0209 addendum (c)) act on GitHub only as the Organization's
// brokered identity and publish through a named person, exactly as a Team
// Environment does, so they take the Team preset. To people they are a work
// Environment named Služby serveru, never a Team one (0207); the words follow
// the binding, not the preset (`environmentKind` in
// src/launchpad/shell-document.ts).
const organizationPresets: Readonly<Record<MachineAssignment, PresetName>> =
  Object.freeze({
    operator: "hosted-organization-personal",
    team: "hosted-organization-team",
    automation: "hosted-organization-steward",
    services: "hosted-organization-team",
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
// and vice versa; a workstation is always `local`. A recorded preset is valid
// within this allow-list, so no Folder becomes invalid when the choices
// below narrow.
export function allowedPresets(
  machine: MachineBinding | null,
): readonly PresetName[] {
  const kind: MachineKind = machine === null ? "workstation" : machine.kind;
  return presetNames.filter((name) =>
    presets[name].machineKinds.includes(kind),
  );
}

// What a NEW choice may take (issue #107). When the handover states
// `owner.assignment`, the assignment decides the preset and nothing else is
// offered: a Team Environment works in GitHub only through the Organization
// bot (decision 0168), so an explicit Work or Steward preset there would
// re-open a user-account sign-in, and likewise for the other two. Without a
// stated assignment the choice stays the allow-list. `recorded`, the preset a
// Folder already has, stays selectable when the allow-list admits it:
// keeping it is not a new choice.
export function selectablePresets(
  machine: MachineBinding | null,
  recorded: PresetName | null = null,
): readonly PresetName[] {
  const allowed = allowedPresets(machine);
  if (
    machine === null ||
    machine.owner.kind !== "organization" ||
    machine.owner.assignment === undefined
  )
    return allowed;
  const derived = derivePreset(machine);
  return allowed.filter((name) => name === derived || name === recorded);
}

// Records a new choice, which must be selectable.
export function presetReference(
  name: PresetName,
  machine: MachineBinding | null,
): PresetReference {
  if (!selectablePresets(machine).includes(name))
    throw new Error("Workspace preset is not allowed by the Machine handover");
  return Object.freeze({
    name,
    version: presetVersion,
    selection: name === derivePreset(machine) ? "derived" : "explicit",
  });
}

// Validates a stored or requested composition as a whole, before any mutation.
// A stored preset is checked against the allow-list, never the narrower
// selectable set: a Folder keeps the preset it recorded.
export function validatePresetComposition(
  name: PresetName,
  machine: MachineBinding | null,
  profile: FolderProfile,
): WorkspacePreset {
  const preset = workspacePreset(name);
  if (!allowedPresets(machine).includes(preset.name))
    throw new Error("Workspace preset is not allowed by the Machine handover");
  if (
    profile.access !== preset.composition.access ||
    profile.purpose !== preset.composition.purpose
  )
    throw new Error("Profile does not match the workspace preset composition");
  return preset;
}

// Profile defaults a preset supplies for initialization; the Operator may
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
