import {
  isEntryPort,
  isHttpsOrigin,
  isModuleOriginTemplate,
} from "../launchpad/hosted-entry";
import { type HostedEntry, parseHostedEntry } from "../launchpad/hosted-trust";
import {
  type EntryAudience,
  isEntryAudience,
} from "../launchpad/public-environment";
import { environmentIdOf, isShellBuddyOrigin } from "../shell/contract";
import { ownDataValue, stateFields } from "./state-fields";

// The handover part of a hosted Folder: a projection of the root-issued
// handover recorded at initialization. It is shown, never edited by the
// Operator; the profile change flow carries it forward unchanged. Its
// identity (machineIdentity) is immutable; the rest follows the current
// handover through `machine folder-refresh`. A workstation Folder has none.
// Nothing here is a grant: owner, assignment, host and peers describe context
// only. Optional handover fields stay absent in the binding (never `null`) so
// that a Folder adopted from an older handover still matches it byte for byte.

// The assignment of an Organization work VM, copied by Machines from the owner
// Deployment Repo (schema v0.12.61) and never inferred. It is the one fact the
// Organization presets differ on. `automation` is the Henry Environment
// of decision 0169: the work VM of an Organization persona, with the one
// responsible operator (an Owner or Admin of the Organization) named exactly
// like `operator`; the handover carries it since Machines #277. `services` is
// the services Environment of a Proxmox server, Služby serveru (root decision
// 0209, Machines docs/server-services.md §2): a work Environment of the
// Organization that only its Owners and Admins enter and that, like `team`,
// names nobody. Any other kind fails closed.
export type MachineAssignment =
  | Readonly<{
      kind: "operator" | "automation";
      githubLogin: string;
      githubId: number;
    }>
  | Readonly<{ kind: "team" | "services" }>;

/** The guard of every match on an assignment's kind: each match handles every
 * kind and passes what is left here, which only `never` may be, so a kind
 * added to `MachineAssignment` fails to compile wherever it is not handled.
 * At run time it refuses, without echoing the value (it may name a person). */
export function unknownAssignment(_assignment: never): never {
  throw new Error("Invalid Machine assignment");
}

/** The person an assignment names, with their immutable GitHub id: the
 * assigned operator, or the responsible operator of a Henry
 * Environment. A Team Environment and the services Environment of a server
 * name nobody, and neither does a handover without an assignment. */
export function assignedPerson(
  assignment: MachineAssignment | undefined,
): Readonly<{ githubLogin: string; githubId: number }> | null {
  if (assignment === undefined) return null;
  switch (assignment.kind) {
    case "operator":
    case "automation":
      return assignment;
    case "team":
    case "services":
      return null;
    default:
      return unknownAssignment(assignment);
  }
}

/** Whether the binding is the services Environment of a Proxmox server,
 * Služby serveru (root decision 0209): on GitHub it is the Organization's
 * brokered identity, as a Team Environment is, and to people it is a work
 * Environment by that name (0207: no fourth kind). */
export const isServerServices = (
  machine: Readonly<{ owner: MachineOwner }> | null | undefined,
): boolean =>
  machine?.owner.kind === "organization" &&
  machine.owner.assignment?.kind === "services";

export type MachineOwner =
  | Readonly<{ kind: "principal"; githubLogin: string; githubId: number }>
  | Readonly<{
      kind: "organization";
      organization: string;
      team: string | null;
      assignment?: MachineAssignment;
    }>;

// This Machine's tailnet peers from its own point of view, as Machines derives
// them from the home Conglomerate Host grants: names and public identity only,
// no node ids, machine keys, addresses, private keys or credentials. Rendered
// only when present; Headscale enforces it.
//
// A peer whose edge a rule opens, not a reviewed device grant, says so (root
// decision 0192, addendum of 2026-10-26; Machines #948): a work VM of an
// Organization assigned to this personal Machine's owner carries `access:
// "assigned"`, its Environment id `environment` (`<machine>.<organization>`)
// and, on its outbound SSH link under a named account, the host keys
// `hostKeys` from the Organization's records (the handover's `host_keys`).
// The three come together or not at all, and absent they stay absent, so a
// peer recorded without them keeps its bytes. They are context, not
// authority: recorded and carried forward exactly, used by nothing here yet.
export type MachineZone = "personal" | "work";
export type MachinePeerHostKey = Readonly<{ type: "ssh-ed25519"; key: string }>;
export type MachinePeer = Readonly<{
  name: string;
  kind: "personal-vm" | "workspace-vm" | "client-device" | "conglomerate-host";
  zone: MachineZone | null;
  organization: string | null;
  environment?: string;
  access?: "assigned";
  ssh: Readonly<{
    host: string;
    user: string | null;
    direction: "outbound" | "inbound" | "both";
    hostKeys?: readonly MachinePeerHostKey[];
  }> | null;
  https: readonly string[];
}>;
export type MachineRelationships = Readonly<{
  zone: MachineZone;
  peers: readonly MachinePeer[];
}>;

// The hosted entry of this Machine (decision F16), projected from the
// handover's `entry` (Machines 0.12.93) one member to one: the Launchpad's four
// values that hosted admission reads (`entry.launchpad`), T3 Code's origin
// (`entry.t3code.external_origin`) and the module origin rule
// (`entry.modules.origin_template`). Finished values from the same rendering as
// the gateway; declaration, not identity. Lazurio MausBot's origin and loopback
// port (`entry.mausbot`, DEV-6632) are recorded only when the handover carries
// them, both or neither, so an entry recorded from an older handover is
// unchanged byte for byte. The Environment browser's view (`entry.browser`,
// root decision 0191, F38) follows the same rule, and so do the socket of the
// Environment's relay to the Dashboard (`entry.environment_relay.socket`, root
// decision 0194, DEV-6653 contract C3), the path of the person's sign-out
// on the shell's origins (`entry.sign_out.path`, Machines#358) and the
// audience of a public Environment (`entry.audience`, root decision 0204,
// Machines #560). The origin of Buddy's frame (`buddyOrigin`, root decision
// 0210, decision F60) is recorded only on a personal VM whose gateway routes
// it, `https://buddy.<slug>.lazurio.io` of the same base host as its
// Launchpad; the Launchpad names it in its shell document and pairs Buddy's
// own T3 Code on it (F61's addendum of 2026-10-22). It is projected from the
// handover's `entry.buddy.external_origin` (Machines v0.12.191, #811), which
// Machines write only for a Platform that reads it.
export type MachineEntry = HostedEntry &
  Readonly<{
    t3codeOrigin: string;
    moduleOriginTemplate: string;
    mausbotOrigin?: string;
    mausbotListenPort?: number;
    browserOrigin?: string;
    browserListenPort?: number;
    environmentRelaySocket?: string;
    signOutPath?: string;
    audience?: EntryAudience;
    buddyOrigin?: string;
  }>;

/** The socket of the Environment's relay, by the wire schema's rule: one
 * directory under `/run` and a `.sock` file, at most 100 characters. */
export const isEnvironmentRelaySocket = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 100 &&
  /^\/run\/[a-z0-9-]+\/[a-z0-9-]+\.sock$/.test(value);

/** The path of the person's sign-out, by the wire schema's rule: exactly the
 * one path the gateway serves on the shell's origins (Machines#358). */
export const signOutPath = "/.lazurio/sign-out";
export const isSignOutPath = (value: unknown): value is string =>
  value === signOutPath;

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
  /** The hosted entry of this Machine (decision F16): finished URLs written by
   * Machines from the same rendering as the gateway; declaration, not identity. */
  entry?: MachineEntry;
}>;

// Exactly the shapes the vendored lazurio.machine.v1 schema imposes on the
// handover, field by field and branch by branch, so that a stored binding accepts
// everything a valid handover projects and nothing a handover could not carry:
// slugs are hyphen-separated alphanumeric words (owner, host, tailnet identity;
// a personal Machine name at most 32, a GitHub login at most 39), a workspace
// Machine name is the schema's looser `^[a-z][a-z0-9-]{0,31}$`, a peer name is
// one DNS label, an assigned peer's Environment id is two slugs joined by a
// dot (at most 96) and its host key the base64 blob of one ed25519 public
// key, without type or comment.
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workspaceName = /^[a-z][a-z0-9-]{0,31}$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const hostname =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const osAccount = /^[a-z_][a-z0-9_-]{0,30}$/;
const environmentId = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ed25519PublicKey = /^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
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
function isEnvironmentId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 96 && environmentId.test(value)
  );
}
function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

// Every kind of the union, so that a stored binding accepts exactly the kinds
// it can hold: keyed by the type, a kind added to it fails to compile here
// until it is listed.
const assignmentKinds: Readonly<Record<MachineAssignment["kind"], true>> =
  Object.freeze({
    operator: true,
    automation: true,
    team: true,
    services: true,
  });
const isAssignmentKind = (value: unknown): value is MachineAssignment["kind"] =>
  typeof value === "string" && Object.hasOwn(assignmentKinds, value);

function assignment(input: unknown): MachineAssignment {
  const kind = ownDataValue(input, "kind");
  if (!isAssignmentKind(kind)) throw new Error("Invalid Machine assignment");
  switch (kind) {
    case "team":
    case "services":
      stateFields(input, ["kind"]);
      return Object.freeze({ kind });
    case "operator":
    case "automation": {
      const value = stateFields(input, ["kind", "githubLogin", "githubId"]);
      if (!isGithubLogin(value.githubLogin) || !isGithubId(value.githubId))
        throw new Error("Invalid Machine assignment");
      return Object.freeze({
        kind,
        githubLogin: value.githubLogin,
        githubId: value.githubId,
      });
    }
    default:
      return unknownAssignment(kind);
  }
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

// The host keys of an assigned peer, by the wire schema's rule: one to four
// distinct closed `{type, key}` items, each one ed25519 public key.
function hostKeys(input: unknown): readonly MachinePeerHostKey[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4)
    throw new Error("Invalid Machine peer");
  const keys = Array.from(input, (item: unknown) => {
    const value = stateFields(item, ["type", "key"]);
    if (
      value.type !== "ssh-ed25519" ||
      typeof value.key !== "string" ||
      !ed25519PublicKey.test(value.key)
    )
      throw new Error("Invalid Machine peer");
    return Object.freeze({ type: value.type, key: value.key });
  });
  if (new Set(keys.map(({ key }) => key)).size !== keys.length)
    throw new Error("Invalid Machine peer");
  return Object.freeze(keys);
}

function peer(input: unknown): MachinePeer {
  // With `access` the peer is assigned and `environment` is required with
  // it; without it neither is allowed (the schema's dependentRequired). The
  // exact field list refuses either alone.
  const assigned = ownDataValue(input, "access") !== undefined;
  const value = stateFields(input, [
    "name",
    "kind",
    "zone",
    "organization",
    ...(assigned ? ["environment", "access"] : []),
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
  // An assigned peer is a work VM of an Organization, reached over SSH.
  let membership: Readonly<{ environment: string; access: "assigned" }> | null =
    null;
  if (assigned) {
    if (
      value.access !== "assigned" ||
      !isEnvironmentId(value.environment) ||
      value.kind !== "workspace-vm" ||
      value.zone !== "work" ||
      value.organization === null ||
      value.ssh === null
    )
      throw new Error("Invalid Machine peer");
    membership = { environment: value.environment, access: value.access };
  }
  let ssh: MachinePeer["ssh"] = null;
  if (value.ssh !== null) {
    // Host keys exactly on an assigned peer's link (required there, unknown
    // elsewhere), which goes outbound under a named account.
    const link = stateFields(value.ssh, [
      "host",
      "user",
      "direction",
      ...(assigned ? ["hostKeys"] : []),
    ]);
    if (
      !isHostname(link.host) ||
      (link.user !== null &&
        (typeof link.user !== "string" || !osAccount.test(link.user))) ||
      !oneOf(directions, link.direction) ||
      (assigned && (link.user === null || link.direction !== "outbound"))
    )
      throw new Error("Invalid Machine peer");
    ssh = Object.freeze({
      host: link.host,
      user: link.user,
      direction: link.direction,
      ...(assigned ? { hostKeys: hostKeys(link.hostKeys) } : {}),
    });
  }
  return Object.freeze({
    name: value.name,
    kind: value.kind,
    zone: value.zone,
    organization: value.organization,
    ...(membership ?? {}),
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

// All six members or none, each by the rule of the wire schema, as written;
// Lazurio MausBot's two members and the Environment browser's two members are
// optional, each pair only together, and so are the relay's socket, the
// sign-out's path, the audience and Buddy's origin (of the Launchpad's own
// base host).
export function parseMachineEntry(input: unknown): MachineEntry {
  const withMausbot = ownDataValue(input, "mausbotOrigin") !== undefined;
  const withBrowser = ownDataValue(input, "browserOrigin") !== undefined;
  const withRelay = ownDataValue(input, "environmentRelaySocket") !== undefined;
  const withSignOut = ownDataValue(input, "signOutPath") !== undefined;
  const withAudience = ownDataValue(input, "audience") !== undefined;
  const withBuddy = ownDataValue(input, "buddyOrigin") !== undefined;
  const {
    t3codeOrigin,
    moduleOriginTemplate,
    mausbotOrigin,
    mausbotListenPort,
    browserOrigin,
    browserListenPort,
    environmentRelaySocket,
    signOutPath: signOut,
    audience,
    buddyOrigin,
    ...launchpad
  }: Record<string, unknown> = stateFields(input, [
    "externalOrigin",
    "authCheckUrl",
    "authCookieName",
    "listenPort",
    "t3codeOrigin",
    "moduleOriginTemplate",
    ...(withMausbot ? ["mausbotOrigin", "mausbotListenPort"] : []),
    ...(withBrowser ? ["browserOrigin", "browserListenPort"] : []),
    ...(withRelay ? ["environmentRelaySocket"] : []),
    ...(withSignOut ? ["signOutPath"] : []),
    ...(withAudience ? ["audience"] : []),
    ...(withBuddy ? ["buddyOrigin"] : []),
  ]);
  const hosted = parseHostedEntry(launchpad);
  if (!isHttpsOrigin(t3codeOrigin))
    throw new Error("Invalid hosted entry T3 Code origin");
  if (!isModuleOriginTemplate(moduleOriginTemplate))
    throw new Error("Invalid hosted entry module origin template");
  let entry: MachineEntry = { ...hosted, t3codeOrigin, moduleOriginTemplate };
  if (withMausbot) {
    if (!isHttpsOrigin(mausbotOrigin))
      throw new Error("Invalid hosted entry Lazurio MausBot origin");
    if (!isEntryPort(mausbotListenPort))
      throw new Error("Invalid hosted entry Lazurio MausBot port");
    entry = { ...entry, mausbotOrigin, mausbotListenPort };
  }
  if (withBrowser) {
    if (!isHttpsOrigin(browserOrigin))
      throw new Error("Invalid hosted entry Environment browser origin");
    if (!isEntryPort(browserListenPort))
      throw new Error("Invalid hosted entry Environment browser port");
    entry = { ...entry, browserOrigin, browserListenPort };
  }
  if (withRelay) {
    if (!isEnvironmentRelaySocket(environmentRelaySocket))
      throw new Error("Invalid hosted entry Environment relay socket");
    entry = { ...entry, environmentRelaySocket };
  }
  if (withSignOut) {
    if (!isSignOutPath(signOut))
      throw new Error("Invalid hosted entry sign-out path");
    entry = { ...entry, signOutPath: signOut };
  }
  if (withAudience) {
    if (!isEntryAudience(audience))
      throw new Error("Invalid hosted entry audience");
    entry = { ...entry, audience };
  }
  if (withBuddy) {
    if (
      !isShellBuddyOrigin(buddyOrigin) ||
      environmentIdOf(buddyOrigin) !== environmentIdOf(entry.externalOrigin)
    )
      throw new Error("Invalid hosted entry Buddy origin");
    entry = { ...entry, buddyOrigin };
  }
  return Object.freeze(entry);
}

export function parseMachineBinding(input: unknown): MachineBinding | null {
  if (input === null) return null;
  const withRelationships = ownDataValue(input, "relationships") !== undefined;
  const withEntry = ownDataValue(input, "entry") !== undefined;
  const value = stateFields(input, [
    ...keys,
    ...(withRelationships ? ["relationships" as const] : []),
    ...(withEntry ? ["entry" as const] : []),
  ]);
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
  // The two upstream branches never mix: a personal VM belongs to a person on
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
  const entry = withEntry ? parseMachineEntry(value.entry) : undefined;
  // Buddy's frame is served by the person's Osobní Prostředí alone.
  if (entry?.buddyOrigin !== undefined && !personalVm)
    throw new Error("Only a personal Machine binding routes Buddy's frame");
  if (!withRelationships)
    return Object.freeze(entry ? { ...binding, entry } : binding);
  const related = relationships(value.relationships);
  // The zone of the relationships is the zone of this Machine's branch.
  if ((related.zone === "personal") !== personalVm)
    throw new Error("Machine relationships zone mixes handover branches");
  return Object.freeze(
    entry
      ? { ...binding, relationships: related, entry }
      : { ...binding, relationships: related },
  );
}

// The part of a binding that names the Machine: kind, name, Owner (Organization
// and Team, or a person), tailnet node and host. Machines rewrites the handover
// on every apply (`installed`, and since v0.12.61 the declared assignment and the
// derived relationships), so the document digest is not identity; a re-apply of
// the same Machine must not turn an adopted Folder into a blocked one. Everything
// outside the identity follows the current handover through the refresh.
export function machineIdentity(machine: MachineBinding | null) {
  if (machine === null) return null;
  const { assignment: _, ...owner } = machine.owner as MachineBinding["owner"] &
    Readonly<{ assignment?: unknown }>;
  return {
    kind: machine.kind,
    name: machine.name,
    owner,
    network: machine.network,
    host: machine.host,
  };
}
