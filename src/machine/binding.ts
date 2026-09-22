import type { MachineBinding } from "../folder/machine-binding";
import type { MachineContext, PersonalMachineContext } from "./context";

// The whole document is one branch; machine.kind names it.
function isPersonal(
  context: MachineContext,
): context is PersonalMachineContext {
  return context.machine.kind === "personal-vm";
}

// The projection of a validated handover that the Folder records and renders.
// Paths, release inventory and custody repositories stay in the handover file;
// the binding keeps what identifies the Machine and whose it is.
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
    });
  return Object.freeze({
    contextDigest,
    kind: "workspace-vm",
    name: context.machine.name,
    owner: Object.freeze({
      kind: "organization",
      organization: context.owner.organization,
      team: context.owner.team ?? null,
    }),
    network,
    host: Object.freeze({
      kind: "virtualization-host",
      id: context.host.machine_id,
    }),
  });
}
