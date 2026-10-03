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

// The producer of `/.lazurio/shell.json` (decision F36 and its addendum of
// 2026-10-04): what this Environment knows about itself today, in the shape
// of `lazurio.shell.v1`. One Environment, its own, named by what it is for
// (its Team, its persona, or its kind) and never by the machine's name; its
// Organizations from the catalog of this Folder, each with its Dashboard;
// its apps from the recorded hosted entry. Nothing here is a grant: the
// document names places, and every place admits by its own rules. The
// Dashboard fills the other Environments later through the Lazurio account.

/** The Lazurio Dashboard: the personal one, the account settings, adding an
 * Organization, and an Organization's page `/orgs/<slug>` (by the
 * Organization's slug, the Dashboard's canonical `org_slug`). */
export const dashboardUrl = "https://dashboard.lazurio.ai/";
export const accountUrl = "https://dashboard.lazurio.ai/settings";
export const addOrganizationUrl =
  "https://dashboard.lazurio.ai/add-organization";
export const organizationDashboardUrl = (slug: string): string =>
  `https://dashboard.lazurio.ai/orgs/${encodeURIComponent(slug)}`;

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
 * per slug, in catalog order. Its avatar is the GitHub Organization's of the
 * login its manifest binds it to (`forge_binding.locator`), never derived
 * from the slug, which may differ; without a bound login there is none and
 * the elements show its initials. The Dashboard will replace it with the
 * avatar it caches on each GitHub sync. */
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
        name: shellName(organization.displayName, slug),
        dashboard: organizationDashboardUrl(slug),
        avatar:
          organization.forgeLogin === undefined
            ? null
            : `https://github.com/${encodeURIComponent(organization.forgeLogin)}.png?size=96`,
      }),
    ];
  });
}

/** An Organization's name as the shell contract takes it: its manifest
 * admits any nonblank display name, the contract at most 128 UTF-16 units
 * (`String.length`) without control characters, so the name is cut to fit
 * rather than the whole document refused, never inside a character; the slug
 * when nothing is left. */
export function shellName(name: string | null, slug: string): string {
  const clean = [...(name ?? "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .trim();
  let cut = "";
  for (const character of clean) {
    if (cut.length + character.length > 128) break;
    cut += character;
  }
  return cut.trim() || slug;
}

const origin = (value: string) => `${value}/`;
const githubPhoto = (login: string) =>
  `https://github.com/${encodeURIComponent(login)}.png?size=96`;

/** The name of a Team-bound Environment: a Team Environment is its Team's
 * ("Team Sales"), an Automated Environment its persona's Team ("Steward"),
 * by the Team's display name in the catalog of the Organization that owns
 * the Environment. Null when the binding names no Team or the catalog does
 * not know it: the elements then name it by its kind. */
export function teamLabel(
  machine: MachineBinding | null,
  kind: ShellEnvironmentKind,
  catalog: Catalog,
): string | null {
  if (machine === null || machine.owner.kind !== "organization") return null;
  const { organization, team } = machine.owner;
  if (team === null || (kind !== "team" && kind !== "automated")) return null;
  const same = (left: string | null | undefined, right: string) =>
    typeof left === "string" && left.toLowerCase() === right.toLowerCase();
  const owner = catalog.organizations.find(
    (entry) =>
      same(entry.forgeLogin, organization) ||
      same(entry.organization, organization),
  );
  const declared = owner?.teams.find((entry) => same(entry.slug, team));
  if (declared === undefined) return null;
  const name = shellName(declared.displayName, declared.slug);
  return kind === "team" && !/^team\b/i.test(name)
    ? shellName(`Team ${name}`, declared.slug)
    : name;
}

/** The person a work Environment is assigned to, for its "who" line. */
export function assigneeLogin(
  machine: MachineBinding | null,
  kind: ShellEnvironmentKind,
): string | null {
  if (kind !== "work" || machine === null) return null;
  if (machine.owner.kind !== "organization") return null;
  const assignment = machine.owner.assignment;
  return assignment !== undefined && assignment.kind === "operator"
    ? assignment.githubLogin
    : null;
}

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
      avatar: login === null ? null : githubPhoto(login),
    },
    environments: [
      {
        id,
        label: teamLabel(machine, kind, input.catalog),
        kind,
        // A personal Environment belongs to no Organization, whatever its
        // Folder holds.
        organizations:
          kind === "personal"
            ? []
            : organizations.map((organization) => organization.slug),
        assignee: assigneeLogin(machine, kind),
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
    addOrganization: addOrganizationUrl,
  };
  // The producer's own output passes the same parser as every consumer's.
  const parsed = parseShell(document);
  if (parsed === null) throw new Error("Invalid shell document");
  return parsed;
}
