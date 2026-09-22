import { ownDataValue, stateFields } from "./state-fields";

// The immutable part of a hosted Folder: a projection of the root-issued
// handover recorded at initialization. It is shown, never edited; the profile
// change flow carries it forward unchanged. A workstation Folder has none.
// Nothing here is a grant: owner, team and host describe context only.
export type MachineOwner =
  | Readonly<{ kind: "principal"; githubLogin: string; githubId: number }>
  | Readonly<{
      kind: "organization";
      organization: string;
      team: string | null;
    }>;

// Rendered only when present. The upstream handover has no relationships field
// yet; this shape follows the zones of upstream decision 0155 so a future pin
// maps onto it without changing the renderer.
export type MachineRelationship = Readonly<{
  machine: string;
  kind: "personal-client" | "personal-vm" | "workspace-vm" | "work-laptop";
  access: "inbound" | "outbound" | "both";
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
  relationships?: readonly MachineRelationship[];
}>;

const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const keys = ["contextDigest", "kind", "name", "owner", "network", "host"];

function isSlug(value: unknown): value is string {
  return typeof value === "string" && slug.test(value);
}

function owner(input: unknown): MachineOwner {
  if (ownDataValue(input, "kind") === "principal") {
    const value = stateFields(input, ["kind", "githubLogin", "githubId"]);
    if (
      !isSlug(value.githubLogin) ||
      value.githubLogin.length > 39 ||
      typeof value.githubId !== "number" ||
      !Number.isSafeInteger(value.githubId) ||
      value.githubId < 1
    )
      throw new Error("Invalid Machine owner");
    return Object.freeze({
      kind: "principal",
      githubLogin: value.githubLogin,
      githubId: value.githubId,
    });
  }
  const value = stateFields(input, ["kind", "organization", "team"]);
  if (
    value.kind !== "organization" ||
    !isSlug(value.organization) ||
    (value.team !== null && !isSlug(value.team))
  )
    throw new Error("Invalid Machine owner");
  return Object.freeze({
    kind: "organization",
    organization: value.organization,
    team: value.team,
  });
}

function relationships(input: unknown): readonly MachineRelationship[] {
  if (!Array.isArray(input)) throw new Error("Invalid Machine relationships");
  return Object.freeze(
    input.map((entry) => {
      const value = stateFields(entry, ["machine", "kind", "access"]);
      if (
        !isSlug(value.machine) ||
        ![
          "personal-client",
          "personal-vm",
          "workspace-vm",
          "work-laptop",
        ].includes(value.kind as string) ||
        !["inbound", "outbound", "both"].includes(value.access as string)
      )
        throw new Error("Invalid Machine relationship");
      return Object.freeze({
        machine: value.machine,
        kind: value.kind as MachineRelationship["kind"],
        access: value.access as MachineRelationship["access"],
      });
    }),
  );
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
    !isSlug(value.name) ||
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
  return Object.freeze(
    withRelationships
      ? { ...binding, relationships: relationships(value.relationships) }
      : binding,
  );
}
