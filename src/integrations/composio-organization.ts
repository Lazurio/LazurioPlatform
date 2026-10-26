import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import type { MachineBinding } from "../folder/machine-binding";
import { readFolderState } from "../folder/read-state";
import { readFolderCatalog } from "../organizations/catalog";
import { selectOwnerOrganization } from "../organizations/catalog-selection";
import {
  type ComposioOrganization,
  parseComposioOrganizations,
} from "../tools/login";
import {
  organizationKey,
  organizationKeys,
} from "./composio-organization-name";
import { type ComposioEnvironment, runComposio } from "./composio-source";

// The Composio organization of an Environment (decision F42, addendum of
// 2026-10-13; root decision 0162, addendum of 2026-10-13): each person has
// one Composio account and in it one organization of their own for each
// Lazurio Organization, named as the Organization is, with nobody else in
// it. An Organization's Environment works in the organization of its
// Organization's name, matched by its letters and digits alone
// (`organizationKey`, note of 2026-10-17), which the person creates under the
// name Composio accepts (`composioOrganizationName`). A person's own
// Environment works in the account's default organization, the one Composio
// made when they signed up and so the oldest (root decision 0162, addendum of
// 2026-10-13, point 2; decision F42, addendum of 2026-10-26); a computer in
// the one the person chose. The CLI's `orgs list` prints `[{id, name,
// is_selected_global_org}]`, Lazurio's build with each one's `created_at`,
// and `orgs switch --org-id <id>` makes one current; Composio has no way to
// create an organization outside its dashboard (its API lists them only), so
// a missing one is created there by the person. Server only: the page draws
// what the reading says.

/** What decides an Environment's Composio organization: the name of its
 * Organization; on a person's own Environment the account's default
 * organization; on a computer the person's own choice. An Organization's
 * Environment whose Organization's name cannot be read is `unverified`:
 * nothing is guessed, and Composio does not write there (Pablo's review of
 * #372). */
export type ComposioOrganizationRule =
  | Readonly<{ kind: "named"; name: string }>
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "chosen" }>
  | Readonly<{ kind: "unverified" }>;
type NamedRule = Extract<ComposioOrganizationRule, { kind: "named" }>;
type DefaultRule = Extract<ComposioOrganizationRule, { kind: "default" }>;
/** A rule the Launchpad brings current: by the name, or the default. */
type ConvergingRule = NamedRule | DefaultRule;
/** A rule that decides: by the name, the default, or the person. */
type DecidingRule = Exclude<ComposioOrganizationRule, { kind: "unverified" }>;

/** An Environment's Composio organization as its account's list reads. */
export type ComposioOrganizationVerdict =
  /** The person chooses: on a computer, or on a person's own Environment
   * where the account's default organization cannot be told. */
  | Readonly<{ kind: "chosen"; current: string | null }>
  /** The organization the rule names is the current one. */
  | Readonly<{ kind: "matches"; organization: ComposioOrganization }>
  /** It exists, and another one is current. */
  | Readonly<{
      kind: "elsewhere";
      organization: ComposioOrganization;
      current: string | null;
    }>
  /** The account has none of that name. */
  | Readonly<{ kind: "missing"; name: string; current: string | null }>
  /** It has more than one of that name: which one is not guessed. */
  | Readonly<{ kind: "ambiguous"; name: string; current: string | null }>;
/** The verdict of a rule that names the organization. */
export type NamedVerdict = Exclude<
  ComposioOrganizationVerdict,
  { kind: "chosen" }
>;
/** The verdict of the default rule: the account's default organization
 * current or not; `chosen` where it cannot be told. */
export type DefaultVerdict = Extract<
  ComposioOrganizationVerdict,
  { kind: "chosen" | "matches" | "elsewhere" }
>;

/** How many organizations `orgs list` prints at most: one page of
 * Composio's list (its API allows 50), the newest first; the CLI does not
 * page further. */
export const composioOrganizationsPage = 50;

/** The account's default organization: the one Composio made when the
 * account signed up, which is its oldest (`created_at`). Composio's list
 * marks none as the default and lists the newest first, so only the dates
 * tell (an account read on 2026-10-26: its default organization made at the
 * sign-up, each Organization's one weeks later). Null where an organization
 * has no date (a CLI build that does not print it), where two are equally
 * old, where there is none, or where the list is a full page, which may
 * leave out the oldest ones (Pablo's review of Lazurio/composio#4): which
 * one it is, is not guessed. */
export function defaultComposioOrganization(
  organizations: readonly ComposioOrganization[],
): ComposioOrganization | null {
  if (organizations.length >= composioOrganizationsPage) return null;
  let oldest: ComposioOrganization | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  let tie = false;
  for (const organization of organizations) {
    const at =
      organization.createdAt === undefined
        ? Number.NaN
        : Date.parse(organization.createdAt);
    if (Number.isNaN(at)) return null;
    if (at < oldestAt) {
      oldest = organization;
      oldestAt = at;
      tie = false;
    } else if (at === oldestAt) tie = true;
  }
  return tie ? null : oldest;
}

/** The verdict of the rule over the account's organizations: those whose
 * name has a key of the Organization's (`organizationKeys`), or the
 * account's default one (`defaultComposioOrganization`). */
export function composioOrganizationVerdict(
  rule: NamedRule,
  organizations: readonly ComposioOrganization[],
): NamedVerdict;
export function composioOrganizationVerdict(
  rule: DefaultRule,
  organizations: readonly ComposioOrganization[],
): DefaultVerdict;
export function composioOrganizationVerdict(
  rule: DecidingRule,
  organizations: readonly ComposioOrganization[],
): ComposioOrganizationVerdict;
export function composioOrganizationVerdict(
  rule: DecidingRule,
  organizations: readonly ComposioOrganization[],
): ComposioOrganizationVerdict {
  const current =
    organizations.find((organization) => organization.current)?.name ?? null;
  if (rule.kind === "chosen") return { kind: "chosen", current };
  if (rule.kind === "default") {
    const organization = defaultComposioOrganization(organizations);
    if (organization === null) return { kind: "chosen", current };
    return organization.current
      ? { kind: "matches", organization }
      : { kind: "elsewhere", organization, current };
  }
  const keys = organizationKeys(rule.name);
  const named = organizations.filter((organization) =>
    keys.includes(organizationKey(organization.name)),
  );
  if (named.length === 0) return { kind: "missing", name: rule.name, current };
  if (named.length > 1) return { kind: "ambiguous", name: rule.name, current };
  const [organization] = named as [ComposioOrganization];
  return organization.current
    ? { kind: "matches", organization }
    : { kind: "elsewhere", organization, current };
}

/** The rule of an Environment: the name of the Organization that owns it
 * (its Machine binding's Organization, named as the Organization's manifest
 * names it); `unverified` where an Organization owns it but its name cannot
 * be read, or has no letter or digit Composio could name an organization
 * with; the account's default organization on a person's own Environment
 * (a binding whose owner is a person, the personal Environment); the
 * person's choice on a computer, which has no binding.
 *
 * The owning Organization is the one Organization settings select (F45):
 * `selectOwnerOrganization` with the handover's owner, a GitHub login,
 * matched against the login its manifest binds whatever the case (the
 * handover names `example`, a manifest binds `Example`), never against the
 * slug of an Organization bound to another login. Composio and the
 * Organization's settings, which say whether Composio is allowed there, so
 * never disagree on the owner. Missing or ambiguous: `unverified`. */
export async function composioOrganizationRule(
  folder: string,
  machine: MachineBinding | null,
): Promise<ComposioOrganizationRule> {
  if (machine === null) return { kind: "chosen" };
  if (machine.owner.kind !== "organization") return { kind: "default" };
  try {
    const selection = selectOwnerOrganization(
      await readFolderCatalog(folder),
      machine.owner.organization,
    );
    const name =
      selection.kind === "found" ? selection.organization.displayName : null;
    return typeof name === "string" && organizationKey(name) !== ""
      ? { kind: "named", name }
      : { kind: "unverified" };
  } catch {
    return { kind: "unverified" };
  }
}

/** The rule of the Environment of a Folder, by its Machine binding. */
export async function folderComposioOrganizationRule(
  folder: string,
): Promise<ComposioOrganizationRule> {
  const state = join(folder, ".lazurio");
  const { preferences } = await withFolderReadLock(state, () =>
    readFolderState(state),
  );
  return composioOrganizationRule(folder, preferences.machine);
}

/** The person's Composio organizations, the current one marked (`composio
 * orgs list`, its JSON array); null where they cannot be read. */
export async function listComposioOrganizations(
  input: ComposioEnvironment,
  command: string,
): Promise<readonly ComposioOrganization[] | null> {
  const result = await runComposio(input, command, ["orgs", "list"]);
  if (result === null || result.exitCode !== 0) return null;
  return parseComposioOrganizations(result.stdout) ?? null;
}

/** Makes one of the person's Composio organizations the current one
 * (`composio orgs switch --org-id`); whether the CLI did. */
export async function switchComposioOrganization(
  input: ComposioEnvironment,
  command: string,
  id: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return false;
  const result = await runComposio(input, command, [
    "orgs",
    "switch",
    "--org-id",
    id,
  ]);
  return result !== null && result.exitCode === 0;
}

/** Brings an Environment's Composio to the organization its rule names:
 * where it exists and another one is current, it is made current (`composio
 * orgs switch`, journaled). The verdict as it then stands, with the
 * account's organizations; null where they cannot be read. Only a rule that
 * names the organization, by its name or as the account's default, brings
 * anything: a person's choice is never changed, nor is anything where the
 * default cannot be told. */
export async function convergeComposioOrganization(
  input: ComposioEnvironment,
  command: string,
  rule: NamedRule,
  journal?: (entry: Readonly<Record<string, string>>) => void,
): Promise<Readonly<{
  verdict: NamedVerdict;
  organizations: readonly ComposioOrganization[];
}> | null>;
export async function convergeComposioOrganization(
  input: ComposioEnvironment,
  command: string,
  rule: DefaultRule,
  journal?: (entry: Readonly<Record<string, string>>) => void,
): Promise<Readonly<{
  verdict: DefaultVerdict;
  organizations: readonly ComposioOrganization[];
}> | null>;
export async function convergeComposioOrganization(
  input: ComposioEnvironment,
  command: string,
  rule: ConvergingRule,
  journal?: (entry: Readonly<Record<string, string>>) => void,
): Promise<Readonly<{
  verdict: ComposioOrganizationVerdict;
  organizations: readonly ComposioOrganization[];
}> | null>;
export async function convergeComposioOrganization(
  input: ComposioEnvironment,
  command: string,
  rule: ConvergingRule,
  journal: (entry: Readonly<Record<string, string>>) => void = () => {},
): Promise<Readonly<{
  verdict: ComposioOrganizationVerdict;
  organizations: readonly ComposioOrganization[];
}> | null> {
  const organizations = await listComposioOrganizations(input, command);
  if (organizations === null) return null;
  const verdict = composioOrganizationVerdict(rule, organizations);
  if (verdict.kind !== "elsewhere") return { verdict, organizations };
  const switched = await switchComposioOrganization(
    input,
    command,
    verdict.organization.id,
  );
  journal({
    scope: "integrations",
    event: "composio-organization",
    outcome: switched ? "switched" : "failed",
  });
  if (!switched) return { verdict, organizations };
  const now = organizations.map((organization) =>
    Object.freeze({
      ...organization,
      current: organization.id === verdict.organization.id,
    }),
  );
  return {
    verdict: composioOrganizationVerdict(rule, now),
    organizations: now,
  };
}
