import type {
  MachineAssignment,
  MachineBinding,
  MachinePeer,
  MachineRelationships,
} from "../folder/machine-binding";
import type {
  MachinePeer as HandoverPeer,
  MachineRelationships as HandoverRelationships,
  MachineContext,
  OrganizationAssignment,
  PersonalMachineContext,
} from "./context";

// The whole document is one branch; machine.kind names it.
function isPersonal(
  context: MachineContext,
): context is PersonalMachineContext {
  return context.machine.kind === "personal-vm";
}

function assignment(input: OrganizationAssignment): MachineAssignment {
  return input.kind === "team"
    ? Object.freeze({ kind: "team" })
    : Object.freeze({
        kind: "operator",
        githubLogin: input.github_login,
        githubId: input.github_id,
      });
}

function peer(input: HandoverPeer): MachinePeer {
  return Object.freeze({
    name: input.name,
    kind: input.kind,
    zone: input.zone,
    organization: input.organization,
    ssh:
      input.ssh === null
        ? null
        : Object.freeze({
            host: input.ssh.host,
            user: input.ssh.user,
            direction: input.ssh.direction,
          }),
    https: Object.freeze([...input.https]),
  });
}

function relationships(input: HandoverRelationships): MachineRelationships {
  return Object.freeze({
    zone: input.zone,
    peers: Object.freeze(input.peers.map(peer)),
  });
}

// The projection of a validated handover that the Folder records and renders.
// Paths, release inventory and custody repositories stay in the handover file;
// the binding keeps what identifies the Machine, whose it is, how it is
// assigned and which peers it has. Optional handover fields that are absent
// stay absent here, so a binding recorded from an older handover is unchanged.
export function machineBinding(
  context: MachineContext,
  contextDigest: string,
): MachineBinding {
  const network =
    context.network === undefined
      ? null
      : Object.freeze({
          headscaleHostname: context.network.headscale_hostname,
        });
  const related =
    context.relationships === undefined
      ? {}
      : { relationships: relationships(context.relationships) };
  if (isPersonal(context))
    return Object.freeze({
      contextDigest,
      kind: "personal-vm",
      name: context.machine.name,
      owner: Object.freeze({
        kind: "principal",
        githubLogin: context.owner.github_login,
        githubId: context.owner.github_id,
      }),
      network,
      host: Object.freeze({
        kind: "provider-estate",
        id: context.host.estate_id,
      }),
      ...related,
    });
  return Object.freeze({
    contextDigest,
    kind: "workspace-vm",
    name: context.machine.name,
    owner: Object.freeze({
      kind: "organization",
      organization: context.owner.organization,
      team: context.owner.team ?? null,
      ...(context.owner.assignment === undefined
        ? {}
        : { assignment: assignment(context.owner.assignment) }),
    }),
    network,
    host: Object.freeze({
      kind: "virtualization-host",
      id: context.host.machine_id,
    }),
    ...related,
  });
}
