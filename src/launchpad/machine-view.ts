import type { MessageKey } from "./messages";
import { fill } from "./update-view";

// The recorded assignment of an Organization work VM as the Launchpad's
// "This Environment" shows it, in the words the Folder renders it with
// (src/folder/render.ts assignmentLine). `automation` is the Automated
// Environment of an Organization persona (decision 0169), named by its
// responsible operator.
export type AssignmentView =
  | Readonly<{
      kind: "operator" | "automation";
      githubLogin: string;
      githubId: number;
    }>
  | Readonly<{ kind: "team" }>;

export function assignmentText(
  assignment: AssignmentView,
  copy: Readonly<
    Record<
      Extract<
        MessageKey,
        "machineAssignmentTeam" | "machineAssignmentAutomation"
      >,
      string
    >
  >,
): string {
  if (assignment.kind === "team") return copy.machineAssignmentTeam;
  const operator = `${assignment.githubLogin} (GitHub id ${assignment.githubId})`;
  return assignment.kind === "automation"
    ? fill(copy.machineAssignmentAutomation, { operator })
    : operator;
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

const kindLabels: Readonly<Record<string, MessageKey>> = {
  local: "machineKindWorkstation",
  "hosted-personal": "machineKindPersonal",
  "hosted-organization-personal": "machineKindWork",
  "hosted-organization-team": "machineKindTeam",
  "hosted-organization-steward": "machineKindAutomated",
};

/** Settings → Tento Environment (root decision 0188; the wireframe's
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
  const kind = copy[kindLabels[input.preset] ?? "machineKindWorkstation"];
  const binding = input.machine;
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
  const works =
    owner.kind === "principal"
      ? copy.machineWorksOnlyYou
      : assignment?.kind === "operator"
        ? `@${assignment.githubLogin}`
        : assignment?.kind === "automation"
          ? fill(copy.machineWorksAutomation, {
              login: assignment.githubLogin,
            })
          : teamName;
  return {
    facts: [
      [copy.machineKind, kind],
      [copy.machineBelongs, belongs],
      ...(works === null ? [] : ([[copy.machineWorks, works]] as Fact[])),
    ],
    support: supportFacts(binding, copy),
  };
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
