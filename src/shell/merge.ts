import {
  dashboardSlug,
  type Shell,
  type ShellAccount,
  type ShellEnvironment,
  type ShellOrganization,
} from "./contract";

// The rail of the person signed in at the browser (F37 point 4 and its
// addendum of 2026-10-04): the shell document of this Environment
// (`/.lazurio/shell.json`, the same for everyone who may open it) merged with
// the person's account (`/.lazurio/account/environments`, theirs only). Pure:
// the elements call it whenever either document arrives. Without the account
// the result is the local document itself, so the rail is exactly F36's.
//
// - This Environment is the local document's: `current`, its entry and its
//   apps. An account entry with the id of a local one is not added; the local
//   entry stands in its place and takes only the account's display name,
//   its "who" line and `offline`, which the local document never carries.
// - The account adds the other Environments and spaces, in its order (the
//   same in every Environment the person opens); local Environments the
//   account does not list come first.
// - Organizations: the account's spaces in its order, each local
//   Organization in the place of the account's with the same Dashboard slug
//   (`dashboardSlug`; the account names Organizations by it, the local
//   document by the manifest's slug), then local ones the account does not
//   list. The local entry wins. An account Environment names the merged
//   slug.
// - The operator is the account's: the person signed in at the browser,
//   whom a Team or another person's work Environment does not know.
// - The locale and the Dashboard's addresses stay the local document's.

const canonical = (slug: string): string =>
  dashboardSlug(slug) ?? slug.toLowerCase();

export function mergeAccount(
  local: Shell,
  account: ShellAccount | null,
): Shell {
  if (account === null) return local;

  // Organizations: the account's order, the local entry in its place.
  const localBySlug = new Map<string, ShellOrganization>();
  for (const organization of local.organizations) {
    const key = canonical(organization.slug);
    if (!localBySlug.has(key)) localBySlug.set(key, organization);
  }
  const organizations: ShellOrganization[] = [];
  const byKey = new Map<string, ShellOrganization>();
  // An account slug (lowercased) to the slug it has in the merged document.
  const slugOf = new Map<string, string>();
  for (const organization of account.organizations) {
    const key = canonical(organization.slug);
    let chosen = byKey.get(key);
    if (chosen === undefined) {
      chosen = localBySlug.get(key) ?? organization;
      byKey.set(key, chosen);
      organizations.push(chosen);
    }
    slugOf.set(organization.slug.toLowerCase(), chosen.slug);
  }
  const onlyLocal = local.organizations.filter(
    (entry) => !organizations.includes(entry),
  );

  // Environments: the account's order, a local entry in its place.
  const localById = new Map(
    local.environments.map((entry) => [entry.id, entry]),
  );
  const listed = new Set<string>();
  const environments: ShellEnvironment[] = [];
  for (const entry of account.environments) {
    const own = localById.get(entry.id);
    if (own !== undefined) {
      listed.add(own.id);
      environments.push(described(own, entry));
      continue;
    }
    environments.push(
      Object.freeze({
        ...entry,
        organizations: Object.freeze(
          entry.organizations.map(
            (slug) => slugOf.get(slug.toLowerCase()) ?? slug,
          ),
        ),
      }),
    );
  }
  const unlisted = local.environments.filter((entry) => !listed.has(entry.id));

  return Object.freeze({
    ...local,
    operator: account.operator,
    environments: Object.freeze([...unlisted, ...environments]),
    organizations: Object.freeze([...organizations, ...onlyLocal]),
  });
}

/** A local entry with the account's words for it: its display name, its
 * "who" line and whether it is off, where the local entry has none. */
function described(
  own: ShellEnvironment,
  account: ShellEnvironment,
): ShellEnvironment {
  const name = own.name ?? account.name;
  const who = own.who ?? account.who;
  const offline = own.offline ?? account.offline;
  if (name === own.name && who === own.who && offline === own.offline)
    return own;
  return Object.freeze({
    ...own,
    ...(name === undefined ? {} : { name }),
    ...(who === undefined ? {} : { who }),
    ...(offline === undefined ? {} : { offline }),
  });
}

/** The last Environment the account remembers for each space of a merged
 * document, by the space's id there (`personal` or the merged Organization
 * slug): only Environments the merged document lists. Empty without the
 * account. */
export function accountLastBySpace(
  merged: Shell,
  account: ShellAccount | null,
): ReadonlyMap<string, string> {
  const last = new Map<string, string>();
  if (account === null) return last;
  const ids = new Set(merged.environments.map((entry) => entry.id));
  for (const [space, visit] of Object.entries(account.lastBySpace)) {
    if (!ids.has(visit.environment)) continue;
    if (space === "personal") {
      last.set(space, visit.environment);
      continue;
    }
    const organization = merged.organizations.find(
      (entry) => canonical(entry.slug) === canonical(space),
    );
    if (organization !== undefined && !last.has(organization.slug))
      last.set(organization.slug, visit.environment);
  }
  return last;
}
