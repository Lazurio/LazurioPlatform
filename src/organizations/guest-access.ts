import type { Catalog, CatalogOrganization } from "./catalog";

// The last access decision on a guest Module (decision F67's addenda of
// 2026-11-01 and 2026-11-22), shared by every consumer of the catalog: the
// Launchpad's `/api/catalog` and boot document, the page and `lazurio module
// list`. Type-only imports, so the page's bundle can carry it.

/** What `withGuestAccess` reads of the last synchronization's record
 * (src/content/sync-record.ts): each repository's last answer; null without
 * a record. */
export type GuestAccessRecord =
  | readonly Readonly<{
      organization: string;
      root: string;
      path: string;
      result: string;
      unreadable?: true;
    }>[]
  | null;

/** The catalog with each guest whose remote GitHub refused at its last
 * read marked `revoked` (decision F67's addendum of 2026-11-01): a guest
 * stays checked out after its access is lost, and Apps must not show it.
 * The refusal stands through runs that never read the remote (a blocked
 * root, a checkout blocked by its own state, GitHub not answering) until a
 * synchronization reads it again. Its name and icon fall back to its slot's
 * id (`display` left out). Every consumer of the catalog applies it: the
 * Launchpad's `/api/catalog` and boot document and `lazurio module list`.
 * Reads nothing itself. */
export function withGuestAccess(
  catalog: Catalog,
  record: GuestAccessRecord,
): Catalog {
  if (record === null) return catalog;
  // GitHub's last answer was a refusal: `denied`, or a later answer that
  // never read the remote (`unreadable`); a run that reads it clears both.
  const denied = new Set(
    record
      .filter((entry) => entry.result === "denied" || entry.unreadable === true)
      .map((entry) => `${entry.root}\0${entry.path}`),
  );
  if (denied.size === 0) return catalog;
  const mark = (organization: CatalogOrganization): CatalogOrganization =>
    organization.guests === undefined
      ? organization
      : {
          ...organization,
          guests: organization.guests.map((guest) => {
            if (
              !denied.has(
                `organizations/${organization.directory}\0${guest.path}`,
              )
            )
              return guest;
            // Without access its name and icon fall back to its slot's id: the
            // checkout left on disk is no longer what GitHub lets this
            // Environment read (F67's addendum of 2026-11-22, the review of
            // #1187).
            const { display: _left, ...rest } = guest;
            return { ...rest, revoked: true as const };
          }),
        };
  return { ...catalog, organizations: catalog.organizations.map(mark) };
}
