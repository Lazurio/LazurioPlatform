import type { Catalog, CatalogOrganization } from "./catalog";

// The one rule that turns a name into a catalog Organization, shared by the
// CLI (`module list <Org>`) and the Launchpad page (`/o/<org>`). Pure and
// type-only, so the browser bundle can import it without the reader.

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
 * name under `organizations/`, exactly. */
export function selectCatalogOrganization(
  catalog: Catalog,
  name: string,
): CatalogOrganizationSelection {
  const key = name.toLowerCase();
  const bySlug = catalog.organizations.filter(
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
