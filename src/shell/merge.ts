import {
  type AccountVisit,
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
// - An ambiguous Dashboard slug (two local Organizations, or two of the
//   account's, that reduce to the same one, such as `Example Org` and
//   `example-org`) cannot be placed safely: for it the local entries stay as
//   they are, and the account's Organization, its Environments and its last
//   Environment are left out. Never a guess, never two spaces of one slug.
// - The account's words (`name`, `who`) are shown only when the account
//   speaks the local document's language: the Dashboard words them by the
//   browser's `Accept-Language`, the elements by the profile's locale. In
//   another language every Environment is named as without the account (its
//   label or kind, in the local language); ids, apps, spaces, `offline` and
//   the last Environments stay.
// - The operator is the account's: the person signed in at the browser,
//   whom a Team or another person's work Environment does not know.
// - The locale and the Dashboard's addresses stay the local document's.

const canonical = (slug: string): string =>
  dashboardSlug(slug) ?? slug.toLowerCase();

/** The Dashboard slugs more than one entry of a list reduces to. */
function ambiguousSlugs(
  ...lists: readonly (readonly ShellOrganization[])[]
): ReadonlySet<string> {
  const ambiguous = new Set<string>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const entry of list) {
      const key = canonical(entry.slug);
      if (seen.has(key)) ambiguous.add(key);
      seen.add(key);
    }
  }
  return ambiguous;
}

/** An Environment without the account's words for it. */
function unworded(entry: ShellEnvironment): ShellEnvironment {
  if (entry.name === undefined && entry.who === undefined) return entry;
  const { name: _name, who: _who, ...rest } = entry;
  return Object.freeze(rest);
}

export function mergeAccount(
  local: Shell,
  account: ShellAccount | null,
): Shell {
  if (account === null) return local;

  const ambiguous = ambiguousSlugs(local.organizations, account.organizations);
  const sameLanguage = account.locale === local.locale;

  // Organizations: the account's order, the local entry in its place.
  const localBySlug = new Map<string, ShellOrganization>();
  for (const organization of local.organizations)
    localBySlug.set(canonical(organization.slug), organization);
  const organizations: ShellOrganization[] = [];
  // An account slug (lowercased) to the slug it has in the merged document;
  // absent for an ambiguous one.
  const slugOf = new Map<string, string>();
  for (const organization of account.organizations) {
    const key = canonical(organization.slug);
    if (ambiguous.has(key)) continue;
    const chosen = localBySlug.get(key) ?? organization;
    organizations.push(chosen);
    slugOf.set(organization.slug.toLowerCase(), chosen.slug);
  }
  const onlyLocal = local.organizations.filter(
    (entry) => !organizations.includes(entry),
  );

  // Environments: the account's order, a local entry in its place. An
  // account entry in an Organization left out (ambiguous) is left out too;
  // a local one of the same id then stands as the local document has it.
  const localById = new Map(
    local.environments.map((entry) => [entry.id, entry]),
  );
  const listed = new Set<string>();
  const environments: ShellEnvironment[] = [];
  for (const read of account.environments) {
    if (read.organizations.some((slug) => !slugOf.has(slug.toLowerCase())))
      continue;
    const entry = sameLanguage ? read : unworded(read);
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

/** The last visit the account remembers for each space of a merged
 * document, by the space's id there (`personal` or the merged Organization
 * slug): the Environment and the app it was in (a page that is no
 * Environment's opens that app, F36's addendum of 2026-10-05; an
 * Environment's page keeps its own). Only Environments the merged document
 * lists, never for a Dashboard slug that is ambiguous among the local or the
 * account's Organizations, and only for a slug that names one space there.
 * Empty without the account. */
export function accountLastBySpace(
  merged: Shell,
  account: ShellAccount | null,
): ReadonlyMap<string, AccountVisit> {
  const last = new Map<string, AccountVisit>();
  if (account === null) return last;
  const ids = new Set(merged.environments.map((entry) => entry.id));
  // The merged document holds every local Organization, so a local
  // collision shows in it; an account collision only in the account.
  const ambiguous = ambiguousSlugs(merged.organizations, account.organizations);
  for (const [space, visit] of Object.entries(account.lastBySpace)) {
    if (!ids.has(visit.environment)) continue;
    if (space === "personal") {
      last.set(space, visit);
      continue;
    }
    // Never for an ambiguous Dashboard slug, on either side: the account's
    // Organizations of it were left out, and their last Environment must not
    // land on a local Organization of the same slug. Otherwise only a space
    // the slug names once in the merged document.
    const key = canonical(space);
    if (ambiguous.has(key)) continue;
    const organizations = merged.organizations.filter(
      (entry) => canonical(entry.slug) === key,
    );
    const organization = organizations[0];
    if (organizations.length === 1 && organization !== undefined)
      last.set(organization.slug, visit);
  }
  return last;
}
