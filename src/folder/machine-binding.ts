import { ownDataValue, stateFields } from "./state-fields";

// The immutable part of a hosted Folder: a projection of the root-issued
// handover recorded at initialization. It is shown, never edited; the profile
// change flow carries it forward unchanged. A workstation Folder has none.
// Nothing here is a grant: owner, assignment, host and peers describe context
// only. Optional handover fields stay absent in the binding (never `null`) so
// that a Folder adopted from an older handover still matches it byte for byte.

// The assignment of an Organization work VM, copied by Machines from the owner
// Deployment Repo (schema v0.12.61) and never inferred. It is the one fact the
// two Organization presets differ on.
export type MachineAssignment =
  | Readonly<{ kind: "operator"; githubLogin: string; githubId: number }>
  | Readonly<{ kind: "team" }>;

export type MachineOwner =
  | Readonly<{ kind: "principal"; githubLogin: string; githubId: number }>
  | Readonly<{
      kind: "organization";
      organization: string;
      team: string | null;
      assignment?: MachineAssignment;
    }>;

// This Machine's tailnet peers from its own point of view, as Machines derives
// them from the home Conglomerate Host grants: names only, no node ids, keys,
// addresses or credentials. Rendered only when present; Headscale enforces it.
export type MachineZone = "personal" | "work";
export type MachinePeer = Readonly<{
  name: string;
  kind: "personal-vm" | "workspace-vm" | "client-device" | "conglomerate-host";
  zone: MachineZone | null;
  organization: string | null;
  ssh: Readonly<{
    host: string;
    user: string | null;
    direction: "outbound" | "inbound" | "both";
  }> | null;
  https: readonly string[];
}>;
export type MachineRelationships = Readonly<{
  zone: MachineZone;
  peers: readonly MachinePeer[];
}>;

export type MachineBinding = Readonly<{
  contextDigest: string;
  kind: "personal-vm" | "workspace-vm";
  name: string;
  owner: MachineOwner;
  network: Readonly<{ headscaleHostname: string }> | null;
  host: Readonly<{
    kind: "virtualization-host" | "provider-estate";
    id: string;
  }>;
  relationships?: MachineRelationships;
}>;

// Exactly the shapes the vendored lazurio.machine.v1 schema imposes on the
// handover, field by field and branch by branch, so that a stored binding accepts
// everything a valid handover projects and nothing a handover could not carry:
// slugs are hyphen-separated alphanumeric words (owner, host, tailnet identity;
// a personal Machine name at most 32, a GitHub login at most 39), a workspace
// Machine name is the schema's looser `^[a-z][a-z0-9-]{0,31}$`, a peer name is
// one DNS label.
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workspaceName = /^[a-z][a-z0-9-]{0,31}$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const hostname =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const osAccount = /^[a-z_][a-z0-9_-]{0,30}$/;
const zones: readonly MachineZone[] = ["personal", "work"];
const peerKinds: readonly MachinePeer["kind"][] = [
  "personal-vm",
  "workspace-vm",
  "client-device",
  "conglomerate-host",
];
const directions: readonly NonNullable<MachinePeer["ssh"]>["direction"][] = [
  "outbound",
  "inbound",
  "both",
];
const keys = ["contextDigest", "kind", "name", "owner", "network", "host"];

function isSlug(value: unknown): value is string {
  return typeof value === "string" && slug.test(value);
}
function isMachineName(kind: unknown, value: unknown): value is string {
  return kind === "workspace-vm"
    ? typeof value === "string" && workspaceName.test(value)
    : isSlug(value) && value.length <= 32;
}
function isDnsLabel(value: unknown): value is string {
  return typeof value === "string" && dnsLabel.test(value);
}
function isHostname(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 253 && hostname.test(value)
  );
}
function isGithubId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
function isGithubLogin(value: unknown): value is string {
  return isSlug(value) && value.length <= 39;
}
function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function assignment(input: unknown): MachineAssignment {
  if (ownDataValue(input, "kind") === "team") {
    stateFields(input, ["kind"]);
    return Object.freeze({ kind: "team" });
  }
  const value = stateFields(input, ["kind", "githubLogin", "githubId"]);
  if (
    value.kind !== "operator" ||
    !isGithubLogin(value.githubLogin) ||
    !isGithubId(value.githubId)
  )
    throw new Error("Invalid Machine assignment");
  return Object.freeze({
    kind: "operator",
    githubLogin: value.githubLogin,
    githubId: value.githubId,
  });
}

function owner(input: unknown): MachineOwner {
  if (ownDataValue(input, "kind") === "principal") {
    const value = stateFields(input, ["kind", "githubLogin", "githubId"]);
    if (!isGithubLogin(value.githubLogin) || !isGithubId(value.githubId))
      throw new Error("Invalid Machine owner");
    return Object.freeze({
      kind: "principal",
      githubLogin: value.githubLogin,
      githubId: value.githubId,
    });
  }
  const assigned = ownDataValue(input, "assignment") !== undefined;
  const value = stateFields(
    input,
    assigned
      ? ["kind", "organization", "team", "assignment"]
      : ["kind", "organization", "team"],
  );
  if (
    value.kind !== "organization" ||
    !isSlug(value.organization) ||
    (value.team !== null && !isSlug(value.team))
  )
    throw new Error("Invalid Machine owner");
  const bound = {
    kind: "organization" as const,
    organization: value.organization,
    team: value.team,
  };
  return Object.freeze(
    assigned ? { ...bound, assignment: assignment(value.assignment) } : bound,
  );
}

function peer(input: unknown): MachinePeer {
  const value = stateFields(input, [
    "name",
    "kind",
    "zone",
    "organization",
    "ssh",
    "https",
  ]);
  if (
    !isDnsLabel(value.name) ||
    !oneOf(peerKinds, value.kind) ||
    (value.zone !== null && !oneOf(zones, value.zone)) ||
    (value.organization !== null && !isGithubLogin(value.organization)) ||
    !Array.isArray(value.https) ||
    value.https.length > 64 ||
    !value.https.every(isHostname) ||
    new Set(value.https).size !== value.https.length
  )
    throw new Error("Invalid Machine peer");
  let ssh: MachinePeer["ssh"] = null;
  if (value.ssh !== null) {
    const link = stateFields(value.ssh, ["host", "user", "direction"]);
    if (
      !isHostname(link.host) ||
      (link.user !== null &&
        (typeof link.user !== "string" || !osAccount.test(link.user))) ||
      !oneOf(directions, link.direction)
    )
      throw new Error("Invalid Machine peer");
    ssh = Object.freeze({
      host: link.host,
      user: link.user,
      direction: link.direction,
    });
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    zone: value.zone,
    organization: value.organization,
    ssh,
    https: Object.freeze([...value.https]),
  });
}

function relationships(input: unknown): MachineRelationships {
  const value = stateFields(input, ["zone", "peers"]);
  if (
    !oneOf(zones, value.zone) ||
    !Array.isArray(value.peers) ||
    value.peers.length > 256
  )
    throw new Error("Invalid Machine relationships");
  return Object.freeze({
    zone: value.zone,
    peers: Object.freeze(value.peers.map(peer)),
  });
}

export function parseMachineBinding(input: unknown): MachineBinding | null {
  if (input === null) return null;
  const withRelationships = ownDataValue(input, "relationships") !== undefined;
  const value = stateFields(
    input,
    withRelationships ? [...keys, "relationships"] : keys,
  );
  const tailnet =
    value.network === null
      ? null
      : stateFields(value.network, ["headscaleHostname"]).headscaleHostname;
  const host = stateFields(value.host, ["kind", "id"]);
  if (
    typeof value.contextDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.contextDigest) ||
    (value.kind !== "personal-vm" && value.kind !== "workspace-vm") ||
    !isMachineName(value.kind, value.name) ||
    (tailnet !== null && !isSlug(tailnet)) ||
    (host.kind !== "virtualization-host" && host.kind !== "provider-estate") ||
    !isSlug(host.id)
  )
    throw new Error("Invalid Machine binding");
  const bound = owner(value.owner);
  // The two upstream branches never mix: a personal VM belongs to a Principal on
  // a provider estate; a workspace VM to an Organization on a virtualization host.
  const personalVm = value.kind === "personal-vm";
  if (
    (bound.kind === "principal") !== personalVm ||
    (host.kind === "provider-estate") !== personalVm
  )
    throw new Error("Machine binding mixes handover branches");
  if (personalVm && tailnet === null)
    throw new Error("Personal Machine binding requires its tailnet identity");
  const binding: MachineBinding = {
    contextDigest: value.contextDigest,
    kind: value.kind,
    name: value.name,
    owner: bound,
    network:
      tailnet === null ? null : Object.freeze({ headscaleHostname: tailnet }),
    host: Object.freeze({ kind: host.kind, id: host.id }),
  };
  if (!withRelationships) return Object.freeze(binding);
  const related = relationships(value.relationships);
  // The zone of the relationships is the zone of this Machine's branch.
  if ((related.zone === "personal") !== personalVm)
    throw new Error("Machine relationships zone mixes handover branches");
  return Object.freeze({ ...binding, relationships: related });
}
