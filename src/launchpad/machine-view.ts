import { isFixed, visitorPreset } from "../folder/presets";
import type { MessageKey } from "./messages";
import type { EntryAudience } from "./public-environment";
import { fill } from "./update-view";

// The recorded assignment of an Organization work VM as the Launchpad's
// "This Environment" shows it, in the words the Folder renders it with
// (src/folder/render.ts assignmentLine). `automation` is the Automated
// Environment of an Organization persona (decision 0169), named by its
// responsible operator; `services` the services Environment of a server,
// named Služby serveru (root decision 0209), which names nobody.
export type AssignmentView =
  | Readonly<{
      kind: "operator" | "automation";
      githubLogin: string;
      githubId: number;
    }>
  | Readonly<{ kind: "team" | "services" }>;

/** The guard of every match on an assignment's kind here: what is left
 * after every kind is handled is `never`, so a kind added to
 * `AssignmentView` fails to compile until it is (src/folder/machine-binding.ts
 * `unknownAssignment`, which this page script cannot import). */
function unknownAssignment(_assignment: never): never {
  throw new Error("Unknown assignment");
}

export function assignmentText(
  assignment: AssignmentView,
  copy: Readonly<
    Record<
      Extract<
        MessageKey,
        | "machineAssignmentTeam"
        | "machineAssignmentAutomation"
        | "serverServicesName"
      >,
      string
    >
  >,
): string {
  switch (assignment.kind) {
    case "team":
      return copy.machineAssignmentTeam;
    case "services":
      return copy.serverServicesName;
    case "operator":
      return `${assignment.githubLogin} (GitHub id ${assignment.githubId})`;
    case "automation":
      return fill(copy.machineAssignmentAutomation, {
        operator: `${assignment.githubLogin} (GitHub id ${assignment.githubId})`,
      });
    default:
      return unknownAssignment(assignment);
  }
}

/** Whether a recorded binding is the services Environment of a server,
 * Služby serveru (root decision 0209): it has the Team preset, and people
 * read it as a work Environment set apart by the server's services. */
export const isServerServicesView = (machine: MachineView | null): boolean =>
  machine?.owner.kind === "organization" &&
  machine.owner.assignment?.kind === "services";

const presetLabels: Readonly<Record<string, MessageKey>> = {
  local: "presetLocal",
  "hosted-personal": "presetHostedPersonal",
  "hosted-organization-personal": "presetHostedOrganizationPersonal",
  "hosted-organization-team": "presetHostedOrganizationTeam",
  "hosted-organization-steward": "presetHostedOrganizationSteward",
};

/** The words of one preset in Obecné's choice (decision F28's addendum of
 * 2026-10-18: the kinds as `kindDetail` says them); a preset this release
 * does not know is the plain "preset". The Team preset of Služby serveru is
 * said as their kind, never Týmové. On a public Environment the Try overlay
 * lies over whatever preset is recorded, and Obecné names the overlay: a
 * Team Environment for trying Lazurio (decision F55's addendum of
 * 2026-10-20). */
export function presetLabel(
  preset: string,
  machine: MachineView | null,
): MessageKey {
  if (visitorPreset(machine) !== null) return "machineKindTry";
  if (preset === "hosted-organization-team" && isServerServicesView(machine))
    return "machineKindServices";
  return presetLabels[preset] ?? "preset";
}

/** Obecné's preset choice: one option per preset a change may end on
 * (`allowedPresets` of `POST /api/profile`), the recorded one selected, in
 * the words of `presetLabel`; `fixed` where the Try overlay fixes the
 * preset, so a public Environment shows its one option and nobody changes
 * it. A disabled choice is not in the form's data, and the page then sends
 * the recorded preset. */
export function presetChoice(
  input: Readonly<{
    allowedPresets: readonly string[];
    preset: string;
    machine: MachineView | null;
  }>,
  copy: Readonly<Record<MessageKey, string>>,
): Readonly<{
  options: readonly Readonly<{
    value: string;
    label: string;
    selected: boolean;
  }>[];
  fixed: boolean;
}> {
  return {
    options: input.allowedPresets.map((value) => ({
      value,
      label: copy[presetLabel(value, input.machine)],
      selected: value === input.preset,
    })),
    fixed: isFixed(input.machine, "preset"),
  };
}

/** One recorded peer of the handover's relationships. */
export type MachinePeer = Readonly<{
  name: string;
  kind: string;
  zone: string | null;
  organization: string | null;
  ssh: Readonly<{
    host: string;
    user: string | null;
    direction: string;
  }> | null;
  https: readonly string[];
}>;

/** The recorded Machine binding as `POST /api/profile` answers it. */
export type MachineView = Readonly<{
  kind: string;
  name: string;
  owner:
    | Readonly<{ kind: "principal"; githubLogin: string; githubId: number }>
    | Readonly<{
        kind: "organization";
        organization: string;
        team: string | null;
        assignment?: AssignmentView;
      }>;
  network: Readonly<{ headscaleHostname: string }> | null;
  host: Readonly<{ kind: string; id: string }>;
  relationships?: Readonly<{ zone: string; peers: readonly MachinePeer[] }>;
  /** Of the recorded entry, only what the page decides by: the audience of
   * a public Environment (decision F55). */
  entry?: Readonly<{ audience?: EntryAudience }>;
}>;

type FactsCopy = Readonly<Record<MessageKey, string>>;
export type Fact = readonly [label: string, value: string | readonly string[]];

/** One compact read-only line per recorded peer, in the handover's words. */
export function peerText(peer: MachinePeer, copy: FactsCopy): string {
  const who = [peer.kind, peer.zone, peer.organization]
    .filter((part) => part !== null)
    .join(", ");
  const ssh =
    peer.ssh === null
      ? copy.machineNoSsh
      : `SSH ${peer.ssh.direction} ${peer.ssh.user === null ? "" : `${peer.ssh.user}@`}${peer.ssh.host}`;
  const https =
    peer.https.length === 0
      ? copy.machineNoHttps
      : `HTTPS ${peer.https.join(", ")}`;
  return `${peer.name} (${who}): ${ssh}; ${https}`;
}

// One of the three kinds, or your computer, which has none (decision F28's
// addendum of 2026-10-18): an automated Environment is a work one and says
// its automations here. A preset this release does not know names no kind.
const kindLabels: Readonly<Record<string, MessageKey>> = {
  local: "machineKindWorkstation",
  "hosted-personal": "machineKindPersonal",
  "hosted-organization-personal": "machineKindWork",
  "hosted-organization-team": "machineKindTeam",
  "hosted-organization-steward": "machineKindAutomated",
};

/** Settings → Toto Prostředí (root decision 0188; the wireframe's
 * `ThisEnvironment`, Matěj 2026-10-04: no technical filler): what a person
 * needs, in its words (what kind of Environment it is, whom it belongs to,
 * who works in it), and folded under "Pro podporu" the recorded technical
 * facts (its technical name and kind, the owner and the assignment as
 * recorded, the tailnet node, the host, the relationships). `organization`
 * names an Organization's GitHub login by its display name when the page
 * knows it; `team` is the Team Environment's name ("Team Sales") when the
 * shell document gives one. A workstation only says it is your computer. */
export function environmentFacts(
  input: Readonly<{
    preset: string;
    machine: MachineView | null;
    organization: (login: string) => string | null;
    team: string | null;
  }>,
  copy: FactsCopy,
): Readonly<{ facts: readonly Fact[]; support: readonly Fact[] }> {
  const binding = input.machine;
  // Služby serveru (root decision 0209) have the Team preset and are a work
  // Environment set apart by the server's services, as an automated one is
  // by its automations; a public Environment is a Team one for trying
  // Lazurio, whatever its recorded preset (the Try overlay, F55's addendum
  // of 2026-10-20).
  const kind =
    copy[
      visitorPreset(binding) !== null
        ? "machineKindTry"
        : isServerServicesView(binding)
          ? "machineKindServices"
          : (kindLabels[input.preset] ?? "machineKindUnknown")
    ];
  if (binding === null || input.preset === "local")
    return {
      facts: [[copy.machineKind, kind]],
      support: binding === null ? [] : supportFacts(binding, copy),
    };
  const owner = binding.owner;
  const belongs =
    owner.kind === "principal"
      ? fill(copy.machineBelongsYou, { login: owner.githubLogin })
      : (input.organization(owner.organization) ?? owner.organization);
  const assignment =
    owner.kind === "organization" ? owner.assignment : undefined;
  const teamName =
    input.team ??
    (owner.kind === "organization" && owner.team !== null
      ? fill(copy.machineWorksTeam, { team: owner.team })
      : null);
  // A personal Environment says so by its kind; "only you" would repeat it
  // (root decision 0170 addendum 2026-10-15, "Druh Prostředí stačí").
  const works =
    owner.kind === "principal" ? null : worksText(assignment, teamName, copy);
  return {
    facts: [
      [copy.machineKind, kind],
      [copy.machineBelongs, belongs],
      ...(works === null ? [] : ([[copy.machineWorks, works]] as Fact[])),
    ],
    support: supportFacts(binding, copy),
  };
}

/** Who works in an Organization's Environment, by its assignment: the
 * assigned operator, an automation and its responsible operator, the Team
 * (also where the handover states no assignment), or the Organization's
 * Owners and Admins in Služby serveru. */
function worksText(
  assignment: AssignmentView | undefined,
  teamName: string | null,
  copy: FactsCopy,
): string | null {
  if (assignment === undefined) return teamName;
  switch (assignment.kind) {
    case "operator":
      return `@${assignment.githubLogin}`;
    case "automation":
      return fill(copy.machineWorksAutomation, {
        login: assignment.githubLogin,
      });
    case "team":
      return teamName;
    case "services":
      return copy.machineWorksServices;
    default:
      return unknownAssignment(assignment);
  }
}

function supportFacts(binding: MachineView, copy: FactsCopy): Fact[] {
  const owner =
    binding.owner.kind === "principal"
      ? `${binding.owner.githubLogin} (GitHub id ${binding.owner.githubId})`
      : binding.owner.organization;
  const assignment =
    binding.owner.kind === "organization" &&
    binding.owner.assignment !== undefined
      ? assignmentText(binding.owner.assignment, copy)
      : null;
  return [
    [copy.machineName, binding.name],
    [copy.machineTechnicalKind, binding.kind],
    [copy.machineOwner, owner],
    ...(binding.owner.kind === "organization" && binding.owner.team !== null
      ? ([[copy.machineTeam, binding.owner.team]] as Fact[])
      : []),
    ...(assignment === null
      ? []
      : ([[copy.machineAssignment, assignment]] as Fact[])),
    [
      copy.machineTailnet,
      binding.network?.headscaleHostname ?? copy.machineNone,
    ],
    [copy.machineHost, `${binding.host.kind} ${binding.host.id}`],
    ...(binding.relationships === undefined
      ? []
      : ([
          [
            copy.machineRelationships,
            binding.relationships.peers.length === 0
              ? copy.machineNoPeers
              : binding.relationships.peers.map((peer) => peerText(peer, copy)),
          ],
        ] as Fact[])),
  ];
}
