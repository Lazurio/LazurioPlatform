import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import type { Catalog } from "../organizations/catalog";
import {
  parseShell,
  type Shell,
  type ShellEnvironmentKind,
  type ShellOrganization,
  shellSchema,
} from "../shell/contract";
import { initialsOf } from "../shell/view";

// The producer of `/.lazurio/shell.json` (decision F36): what this
// Environment knows about itself today, in the shape of `lazurio.shell.v1`.
// One Environment, its own; its Organizations from the catalog of this
// Folder; its apps from the recorded hosted entry. Nothing here is a grant:
// the document names places, and every place admits by its own rules. The
// Dashboard fills the other Environments later through the Lazurio account.

/** The Lazurio Dashboard and its account settings (root decision 0179). */
export const dashboardUrl = "https://dashboard.lazurio.ai/";
export const accountUrl = "https://dashboard.lazurio.ai/settings";

/** The kind of Environment a preset sets up (decisions 0165, 0169). */
export const presetKinds: Readonly<Record<PresetName, ShellEnvironmentKind>> = {
  local: "workstation",
  "hosted-personal": "personal",
  "hosted-organization-personal": "work",
  "hosted-organization-team": "team",
  "hosted-organization-steward": "automated",
};

/** The GitHub login of the one person the Environment belongs to, when it
 * records one: the owner of a personal Remote Environment, the assigned
 * operator of a work one, the responsible operator of an Automated one. A
 * Team Environment and a workstation name nobody. */
export function operatorLogin(machine: MachineBinding | null): string | null {
  if (machine === null) return null;
  if (machine.owner.kind === "principal") return machine.owner.githubLogin;
  const assignment = machine.owner.assignment;
  return assignment !== undefined && assignment.kind !== "team"
    ? assignment.githubLogin
    : null;
}

/** The Organizations of the catalog the shell names: every candidate with a
 * slug that is not refused as a template or as a duplicate of another, once
 * per slug, in catalog order. Its avatar is the GitHub Organization's, by
 * the slug (an Organization's slug is its GitHub login); the Dashboard will
 * replace it with the avatar it caches on each GitHub sync. */
export function shellOrganizations(
  catalog: Catalog,
): readonly ShellOrganization[] {
  const seen = new Set<string>();
  return catalog.organizations.flatMap((organization): ShellOrganization[] => {
    const slug = organization.organization;
    if (
      slug === null ||
      organization.reason === "template-not-runtime" ||
      organization.reason === "organization-duplicate" ||
      seen.has(slug.toLowerCase()) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(slug)
    )
      return [];
    seen.add(slug.toLowerCase());
    return [
      Object.freeze({
        slug,
        name: organization.displayName ?? slug,
        accent: null,
        avatar: `https://github.com/${encodeURIComponent(slug)}.png?size=96`,
      }),
    ];
  });
}

const origin = (value: string) => `${value}/`;

/** This Environment's shell document. */
export function shellDocument(
  input: Readonly<{
    preset: PresetName;
    machine: MachineBinding | null;
    locale: "cs" | "en";
    catalog: Catalog;
  }>,
): Shell {
  const { machine } = input;
  const entry = machine?.entry;
  const kind = presetKinds[input.preset];
  const organizations = shellOrganizations(input.catalog);
  const login = operatorLogin(machine);
  const id = machine?.name ?? "local";
  const document = {
    schema: shellSchema,
    locale: input.locale,
    current: id,
    operator: {
      initials: login === null ? null : initialsOf(login).slice(0, 2) || null,
      login,
    },
    environments: [
      {
        id,
        label: machine?.name ?? null,
        kind,
        // A personal Environment belongs to no Organization, whatever its
        // Folder holds.
        organizations:
          kind === "personal"
            ? []
            : organizations.map((organization) => organization.slug),
        apps:
          entry === undefined
            ? { apps: "/", chat: null, automate: null }
            : {
                apps: origin(entry.externalOrigin),
                chat: origin(entry.t3codeOrigin),
                automate:
                  entry.mausbotOrigin === undefined
                    ? null
                    : origin(entry.mausbotOrigin),
              },
      },
    ],
    organizations,
    dashboard: dashboardUrl,
    account: accountUrl,
  };
  // The producer's own output passes the same parser as every consumer's.
  const parsed = parseShell(document);
  if (parsed === null) throw new Error("Invalid shell document");
  return parsed;
}
