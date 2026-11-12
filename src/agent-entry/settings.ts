import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import type { AgentEntryAnswer } from "../launchpad/agent-entry-view";
import type { RelayTransport } from "../organization-settings/relay";
import { createAgentEntryRelay } from "./relay";
import { agentEntrySwitchPage } from "./switch-page";

/** The presets of an Environment that acts for its person in colleagues'
 * applications (Lazurio Auth docs/agent-application-entry.md, decided 2):
 * the person's Work Environment and Personal Environment. A Team
 * Environment is out of the contract's scope. */
export const actingPresets: readonly PresetName[] = Object.freeze([
  "hosted-personal",
  "hosted-organization-personal",
]);

/** The switch of this Environment as Settings → Tento Environment shows it:
 * the Dashboard's statement of it, read through the relay as the
 * Environment (the same read as `lazurio apps shared`, whose `agentEntry`
 * the issuer signed), and the page where the person switches it. No switch
 * where the Environment cannot act: another preset, or no relay, which
 * only an Environment with its own identity at Lazurio Auth has. A read
 * that fails is unknown with its refusal code, never "off". Reads only;
 * nothing on the Environment can switch it. */
export async function readAgentEntry(
  input: Readonly<{
    preset: PresetName;
    machine: MachineBinding | null;
    ownerKey: () => Promise<string | null>;
    transport: (socket: string) => RelayTransport;
  }>,
): Promise<AgentEntryAnswer> {
  const socket = input.machine?.entry?.environmentRelaySocket;
  if (!actingPresets.includes(input.preset) || socket === undefined)
    return Object.freeze({ available: false });
  const [read, ownerKey] = await Promise.all([
    createAgentEntryRelay(input.transport(socket)).sharedApplications(),
    input.ownerKey().catch(() => null),
  ]);
  const page = agentEntrySwitchPage(input.machine, ownerKey);
  return Object.freeze(
    read.kind === "listed"
      ? { available: true, agentEntry: read.agentEntry, page }
      : { available: true, agentEntry: null, reason: read.reason, page },
  );
}
