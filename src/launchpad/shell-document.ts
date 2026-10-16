import { hostname } from "node:os";
import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { readMachineContext } from "../machine/context";
import { type Catalog, readFolderCatalog } from "../organizations/catalog";
import type { PersonalspaceHolderRead } from "../organizations/personalspace";
import {
  dashboardSlug,
  environmentIdOf,
  isEnvironmentId,
  isShellSlug,
  parseShell,
  type Shell,
  type ShellEnvironmentKind,
  type ShellOrganization,
  type ShellSetup,
  shellSchema,
  workstationId,
} from "../shell/contract";
import { initialsOf } from "../shell/view";

// The Dashboard's slug lives with the contract, where the shell's merge of
// the account reads it too (F37).
export { dashboardSlug };

// The producer of `/.lazurio/shell.json` (decision F36 and its addendum of
// 2026-10-04): what this Environment knows about itself today, in the shape
// of `lazurio.shell.v1`. One Environment, its own, keyed by its base host
// (unique across Organizations) and named by what it is for (its Team, its
// persona, or its kind), never by the machine's name; its
// Organizations from the catalog of this Folder, each with its Dashboard;
// its apps from the recorded hosted entry. Nothing here is a grant: the
// document names places, and every place admits by its own rules. The
// Dashboard fills the other Environments later through the Lazurio account.

/** The Lazurio Dashboard: the personal one, the account settings, adding an
 * Organization, and an Organization's page `/orgs/<slug>`. The personal one
 * is the Dashboard's home `/home`, which never redirects (root decision 0185:
 * `/` is the landing, which may send the person on to an Environment), and
 * the account settings are `/settings/account`; both addresses are the same
 * in the Dashboard's current interface and in its v2 (DEV-6645). */
export const dashboardUrl = "https://dashboard.lazurio.ai/home";
export const accountUrl = "https://dashboard.lazurio.ai/settings/account";
export const addOrganizationUrl =
  "https://dashboard.lazurio.ai/add-organization";

/** An Organization's page in the Dashboard; its home when the slug reduces
 * to nothing. */
export const organizationDashboardUrl = (slug: string): string => {
  const canonical = dashboardSlug(slug);
  return canonical === null
    ? dashboardUrl
    : `https://dashboard.lazurio.ai/orgs/${canonical}`;
};

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
      // The slug by its own rule, never the GitHub login's: the two may
      // differ, and only `forgeLogin` is a login.
      !isShellSlug(slug)
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

/** A workstation's name: the computer's host name without its domain
 * (`MacBook-Pro.local` is `MacBook-Pro`), as the person named the computer;
 * null when there is none. Only a workstation is named so: a hosted
 * Environment is never named by its machine. */
export function computerLabel(name: string | undefined): string | null {
  const host = (name ?? "").split(".")[0]?.trim() ?? "";
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/.test(host) ? host : null;
}

/** This Environment's id in the document (F37's addendum of 2026-10-04).
 * Hosted (it has an entry): its base host by `environmentIdOf`, the one
 * derivation of it; an entry whose address yields none has no id, and this
 * throws, so the document fails closed (`/.lazurio/shell.json` answers
 * `operation-failed` and the rail stays empty) rather than fall back to the
 * Machine name, which repeats across Organizations. A workstation, as
 * before: its Machine name, or `local` without one. */
export function environmentId(machine: MachineBinding | null): string {
  const entry = machine?.entry;
  if (entry !== undefined) {
    const hosted = environmentIdOf(entry.externalOrigin);
    if (hosted === null)
      throw new Error("The hosted entry's origin has no base host");
    return hosted;
  }
  return isEnvironmentId(machine?.name) ? machine.name : workstationId;
}

/** The Organization that owns a hosted work, Team or Automated Environment,
 * by its handover's owner slug, whether or not the Folder holds that
 * Organization or can read it: such an Environment is never put in the
 * person's own space (Matěj 2026-10-05: a work Environment whose Organization
 * was not readable yet showed as "Osobní"). Null for a personal Environment,
 * a workstation, or an owner slug the shell contract does not take. */
export function ownerOrganization(
  machine: MachineBinding | null,
  kind: ShellEnvironmentKind,
): string | null {
  if (kind === "personal" || kind === "workstation" || machine === null)
    return null;
  if (machine.owner.kind !== "organization") return null;
  return isShellSlug(machine.owner.organization)
    ? machine.owner.organization
    : null;
}

/** This Environment's shell document. `computer` is the host name of the
 * computer a workstation runs on; `setup` what the Environment still lacks
 * (root decision 0188, setup-state.ts), when the server knows it;
 * `ownerKey` the owning Organization's own slug as the Machine handover
 * names it (`owner.organization_key`), when it does. */
export function shellDocument(
  input: Readonly<{
    preset: PresetName;
    machine: MachineBinding | null;
    locale: "cs" | "en";
    catalog: Catalog;
    computer?: string;
    setup?: ShellSetup;
    ownerKey?: string | null;
  }>,
): Shell {
  const { machine } = input;
  const entry = machine?.entry;
  const kind = presetKinds[input.preset];
  const held = shellOrganizations(input.catalog);
  // The owning Organization first.
  const owner = ownerOrganization(machine, kind);
  // The handover names the owner by its lowercased GitHub login
  // (`examplelazurio`) and, where it carries one, by its own slug
  // (`owner.organization_key`, `Example`); the Folder by its own slug
  // (`example`): the catalog entry bound to that login or carrying that
  // slug is the same Organization, never a second one.
  const key =
    owner !== null && isShellSlug(input.ownerKey) ? input.ownerKey : null;
  const same = (left: string | null | undefined, right: string) =>
    typeof left === "string" && left.toLowerCase() === right.toLowerCase();
  const ownerSlug =
    owner === null
      ? null
      : (input.catalog.organizations.find(
          (entry) =>
            entry.organization !== null &&
            (same(entry.forgeLogin, owner) ||
              same(entry.organization, owner) ||
              (key !== null && same(entry.organization, key))),
        )?.organization ?? owner);
  // Until the Folder holds it readable, the owner is known by the handover's
  // own slug where it names one, the slug the Dashboard reduces to as well,
  // so the rail's merge with the person's account finds it and never shows
  // it twice; else by the login. Its logo is the GitHub Organization's of
  // that login either way.
  const ownerEntry =
    owner === null || ownerSlug === null
      ? undefined
      : (held.find((entry) => same(entry.slug, ownerSlug)) ??
        Object.freeze({
          slug: key ?? owner,
          name: key ?? owner,
          dashboard: organizationDashboardUrl(key ?? owner),
          avatar: githubPhoto(owner),
        }));
  const organizations =
    ownerEntry === undefined
      ? held
      : [ownerEntry, ...held.filter((entry) => entry !== ownerEntry)];
  const login = operatorLogin(machine);
  const id = environmentId(machine);
  const document = {
    schema: shellSchema,
    locale: input.locale,
    current: id,
    ...(input.setup === undefined ? {} : { setup: input.setup }),
    operator: {
      initials: login === null ? null : initialsOf(login).slice(0, 2) || null,
      login,
      avatar: login === null ? null : githubPhoto(login),
    },
    environments: [
      {
        id,
        label:
          kind === "workstation"
            ? computerLabel(input.computer)
            : teamLabel(machine, kind, input.catalog),
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
    // The person's sign-out where the gateway serves it on the shell's
    // origins (Machines#358): a path, so the elements on T3 Code's and
    // MausBot's origins open it on their own origin too. Without it the
    // shell offers none.
    ...(entry?.signOutPath === undefined ? {} : { signOut: entry.signOutPath }),
  };
  // The producer's own output passes the same parser as every consumer's.
  const parsed = parseShell(document);
  if (parsed === null) throw new Error("Invalid shell document");
  return parsed;
}

/** The owning Organization's own slug the Machine handover names
 * (`owner.organization_key`); none for a personal Machine, a handover that
 * names none, or no readable handover, as on a workstation. */
export async function handoverOwnerKey(): Promise<string | null> {
  try {
    const { owner } = (await readMachineContext()).context;
    return owner.kind === "organization"
      ? (owner.organization_key ?? null)
      : null;
  } catch {
    return null;
  }
}

/** What `shellDocument` takes from the Folder, this computer and the Machine
 * handover; `setup` stays the Launchpad's own. */
export type ShellInputs = Readonly<{
  preset: PresetName;
  machine: MachineBinding | null;
  locale: "cs" | "en";
  catalog: Catalog;
  computer: string;
  ownerKey: string | null;
}>;

/** This Environment's inputs of `shellDocument`, read as every producer of
 * its document reads them: the Folder's preset, Machine binding and language
 * under one read of its state (waiting at most `lockWaitMs` for the Folder's
 * lock), its catalog, this computer's name and the owner's own slug the
 * handover names (`ownerKey`, by default `handoverOwnerKey`). The
 * Launchpad's `/.lazurio/shell.json`, its page's boot document and its
 * offline guide read them here, and so does the Environment browser's view
 * for its own name (decision F39's addendum of 2026-10-12): one read, so the
 * view and the switcher cannot drift apart. */
export async function readShellInputs(
  folder: string,
  options: Readonly<{
    ownerKey?: (() => Promise<string | null>) | undefined;
    lockWaitMs?: number | undefined;
    /** Whose Personalspace this Environment holds (#186), for the
     * catalog's Personalspace group: the page's boot document gives the
     * Launchpad's last decision, never waiting for GitHub. */
    personalspace?: PersonalspaceHolderRead | undefined;
  }> = {},
): Promise<ShellInputs> {
  const state = join(folder, ".lazurio");
  const current = await withFolderReadLock(
    state,
    () => readFolderState(state),
    options.lockWaitMs,
  );
  const [catalog, ownerKey] = await Promise.all([
    readFolderCatalog(folder, options.personalspace),
    (options.ownerKey ?? handoverOwnerKey)(),
  ]);
  return Object.freeze({
    preset: current.preferences.preset.name,
    machine: current.preferences.machine,
    locale: current.preferences.profile.locale === "cs" ? "cs" : "en",
    catalog,
    computer: hostname(),
    ownerKey,
  });
}
