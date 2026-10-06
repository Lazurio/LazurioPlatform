import {
  type MachineAssignment,
  type MachineBinding,
  type MachineEntry,
  type MachinePeer,
  type MachineRelationships,
  parseMachineEntry,
} from "../folder/machine-binding";
import {
  type MachineEntry as HandoverEntry,
  type MachinePeer as HandoverPeer,
  type MachineRelationships as HandoverRelationships,
  type MachineContext,
  MachineContextError,
  type OrganizationAssignment,
  type PersonalMachineContext,
} from "./context";

// The whole document is one branch; machine.kind names it.
function isPersonal(
  context: MachineContext,
): context is PersonalMachineContext {
  return context.machine.kind === "personal-vm";
}

// One member to one; `operator` and `automation` (the responsible operator of
// an Automated Environment, decision 0169) keep their own kind.
function assignment(input: OrganizationAssignment): MachineAssignment {
  return input.kind === "team"
    ? Object.freeze({ kind: "team" })
    : Object.freeze({
        kind: input.kind,
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

// One member to one (docs/machine-handover.md#the-hosted-entry-decision-f16).
// The binding's own parser checks every value by the wire rules again, so a
// projection that would not read back refuses the handover instead of being
// recorded.
function entry(input: HandoverEntry): MachineEntry {
  try {
    return parseMachineEntry({
      externalOrigin: input.launchpad.external_origin,
      authCheckUrl: input.launchpad.auth_check_url,
      authCookieName: input.launchpad.auth_cookie_name,
      listenPort: input.launchpad.listen_port,
      t3codeOrigin: input.t3code.external_origin,
      moduleOriginTemplate: input.modules.origin_template,
      ...(input.mausbot === undefined
        ? {}
        : {
            mausbotOrigin: input.mausbot.external_origin,
            mausbotListenPort: input.mausbot.listen_port,
          }),
      ...(input.browser === undefined
        ? {}
        : {
            browserOrigin: input.browser.external_origin,
            browserListenPort: input.browser.listen_port,
          }),
    });
  } catch {
    throw new MachineContextError("machine-context-invalid");
  }
}

// The projection of a validated handover that the Folder records and renders.
// Paths, release inventory and custody repositories stay in the handover file;
// the binding keeps what identifies the Machine, whose it is, how it is
// assigned, which peers it has and how it is entered. Optional handover fields
// that are absent stay absent here, so a binding recorded from an older
// handover is unchanged.
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
  const related = {
    ...(context.relationships === undefined
      ? {}
      : { relationships: relationships(context.relationships) }),
    ...(context.entry === undefined ? {} : { entry: entry(context.entry) }),
  };
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
