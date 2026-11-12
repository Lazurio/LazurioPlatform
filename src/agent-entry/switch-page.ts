import type { MachineBinding } from "../folder/machine-binding";
import {
  dashboardSlug,
  dashboardUrl,
  organizationDashboardUrl,
} from "../launchpad/shell-document";
import { isShellSlug } from "../shell/contract";

/** Where the Assigned User switches agents in colleagues' applications on or
 * off for this Environment (Lazurio Auth docs/agent-application-entry.md,
 * "The switch"): in the Dashboard, with their own sign-in in their own
 * browser, never from the Environment. For an Organization's Environment
 * that is the Organization's Prostředí page (`/orgs/<slug>/environments`),
 * the Organization named as the shell names its Dashboard page (its own
 * slug `owner.organization_key` where the handover carries it, else the
 * handover's Organization); for a Personal Environment, and wherever no
 * Organization is known, the person's Dashboard home. */
export function agentEntrySwitchPage(
  machine: MachineBinding | null,
  ownerKey: string | null,
): string {
  const owner =
    machine?.owner.kind === "organization" &&
    isShellSlug(machine.owner.organization)
      ? machine.owner.organization
      : null;
  if (owner === null) return dashboardUrl;
  const slug = isShellSlug(ownerKey) ? ownerKey : owner;
  return dashboardSlug(slug) === null
    ? dashboardUrl
    : `${organizationDashboardUrl(slug)}/environments`;
}
