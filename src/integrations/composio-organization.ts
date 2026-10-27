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
// name Composio accepts (`composioOrganizationName`); a personal Environment
// and a computer work in the one the person chose (by advice the account's
// default, the one Composio made when they signed up). The CLI's `orgs list`
// prints `[{id, name, is_selected_global_org}]` and `orgs switch --org-id
// <id>` makes one current; Composio has no way to create an organization
// outside its dashboard (its API lists them only), so a missing one is
// created there by the person. Server only: the page draws what the reading
// says.

/** What decides an Environment's Composio organization: the name of its
 * Organization, or the person's own choice where it has none. An
 * Organization's Environment whose Organization's name cannot be read is
 * `unverified`: nothing is guessed, and Composio does not write there
 * (Pablo's review of #372). */
export type ComposioOrganizationRule =
  | Readonly<{ kind: "named"; name: string }>
  | Readonly<{ kind: "chosen" }>
  | Readonly<{ kind: "unverified" }>;
type NamedRule = Extract<ComposioOrganizationRule, { kind: "named" }>;
/** A rule that decides: by the name, or by the person. */
type DecidingRule = Exclude<ComposioOrganizationRule, { kind: "unverified" }>;

/** An Environment's Composio organization as its account's list reads. */
export type ComposioOrganizationVerdict =
  /** The person chooses (a personal Environment, a computer). */
  | Readonly<{ kind: "chosen"; current: string | null }>
  /** The organization of the Organization's name is the current one. */
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

/** The verdict of the rule over the account's organizations: those whose
 * name has a key of the Organization's (`organizationKeys`). */
export function composioOrganizationVerdict(
  rule: NamedRule,
  organizations: readonly ComposioOrganization[],
): NamedVerdict;
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
 * with; the person's choice where no Organization owns it.
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
  if (machine?.owner.kind !== "organization") return { kind: "chosen" };
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
 * names the organization brings anything: a person's choice is never
 * changed. */
export async function convergeComposioOrganization(
  input: ComposioEnvironment,
  command: string,
  rule: NamedRule,
  journal: (entry: Readonly<Record<string, string>>) => void = () => {},
): Promise<Readonly<{
  verdict: NamedVerdict;
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
