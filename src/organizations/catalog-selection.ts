import type { Catalog, CatalogOrganization } from "./catalog";

// The one rule that turns a name into a catalog Organization, shared by the
// CLI (`module list <Org>`) and the Launchpad page (`/o/<org>`). Pure and
// type-only, so the browser bundle can import it without the reader.

/** The catalog's groups in the order they are shown: the Organizations, then
 * the Personalspace group when there is one (launchpad-parity B11). */
export function catalogGroups(
  catalog: Catalog,
): readonly CatalogOrganization[] {
  return catalog.personalspace === undefined
    ? catalog.organizations
    : [...catalog.organizations, catalog.personalspace];
}

export type CatalogOrganizationSelection =
  | Readonly<{ kind: "found"; organization: CatalogOrganization }>
  /** Two or more candidates declare the slug (GitHub slugs are
   * case-insensitive): none of them is chosen. */
  | Readonly<{
      kind: "ambiguous";
      candidates: readonly CatalogOrganization[];
    }>
  | Readonly<{ kind: "missing" }>;

/** The Organization a name selects: its slug, compared case-insensitively as
 * GitHub does; a slug that more than one candidate declares, in the same case
 * or another, selects none of them. Only when no slug matches, the directory
 * name under `organizations/`, exactly. The Personalspace group takes part
 * under its name `personalspace`, so an Organization whose slug is
 * `personalspace` is ambiguous with it. */
export function selectCatalogOrganization(
  catalog: Catalog,
  name: string,
): CatalogOrganizationSelection {
  const key = name.toLowerCase();
  const bySlug = catalogGroups(catalog).filter(
    (entry) => entry.organization?.toLowerCase() === key,
  );
  if (bySlug.length === 1)
    return { kind: "found", organization: bySlug[0] as CatalogOrganization };
  if (bySlug.length > 1) return { kind: "ambiguous", candidates: bySlug };
  const byDirectory = catalog.organizations.find(
    (entry) => entry.directory === name,
  );
  return byDirectory === undefined
    ? { kind: "missing" }
    : { kind: "found", organization: byDirectory };
}

/** The Organization that owns a Machine, by the owner its handover names: a
 * GitHub login (`owner.organization`), compared case-insensitively as GitHub
 * does. An Organization whose manifest binds a GitHub login (`forgeLogin`) is
 * the owner only by that login, never by its slug: its slug may be another
 * Organization's login (slug `Example`, login `ExampleCo`; slug `ExampleCo`,
 * login `Other`). An Organization that binds none takes part by its slug, as
 * before. Exactly one candidate selects it; two or more, such as two manifests
 * binding the login or one binding it and another unbound one with it as its
 * slug, select none. Only when none answers, the directory name under
 * `organizations/` of an Organization that binds no login, exactly. The
 * Personalspace group is never a Machine's owning Organization.
 *
 * Organization settings (F45) and Composio's organization rule both read
 * the owner through this one rule, so they never disagree on it. Routes and
 * the CLI name an Organization by `selectCatalogOrganization` instead. */
export function selectOwnerOrganization(
  catalog: Catalog,
  owner: string,
): CatalogOrganizationSelection {
  const key = owner.toLowerCase();
  const candidates = catalog.organizations.filter((entry) =>
    entry.forgeLogin === undefined
      ? entry.organization?.toLowerCase() === key
      : entry.forgeLogin.toLowerCase() === key,
  );
  if (candidates.length === 1)
    return {
      kind: "found",
      organization: candidates[0] as CatalogOrganization,
    };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  const byDirectory = catalog.organizations.find(
    (entry) => entry.forgeLogin === undefined && entry.directory === owner,
  );
  return byDirectory === undefined
    ? { kind: "missing" }
    : { kind: "found", organization: byDirectory };
}

/** The name that selects exactly this candidate under the same rule: its slug,
 * otherwise its directory name, otherwise null (a duplicated slug whose
 * directory is also taken by a slug has no name that cannot be confused). */
export function catalogOrganizationKey(
  catalog: Catalog,
  organization: CatalogOrganization,
): string | null {
  for (const name of [organization.organization, organization.directory]) {
    if (name === null) continue;
    const selection = selectCatalogOrganization(catalog, name);
    if (selection.kind === "found" && selection.organization === organization)
      return name;
  }
  return null;
}
