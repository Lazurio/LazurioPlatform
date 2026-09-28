import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogTeam,
  ModuleReason,
  OrganizationReason,
} from "../organizations/catalog";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Folder catalog (launchpad-parity B1) for the
// Launchpad home; the DOM lives in catalog-panel.ts. Every value from the
// server is shown as text, never as markup.

const reasonKeys: Readonly<
  Record<OrganizationReason | ModuleReason, MessageKey>
> = {
  "canonical-documents-required": "catalogReasonCanonical",
  "organization-conflict": "catalogReasonConflict",
  "organization-not-executable": "catalogReasonNotExecutable",
  "template-not-runtime": "catalogReasonTemplate",
  "organization-changed": "catalogReasonChanged",
  "organization-unavailable": "catalogReasonUnavailable",
  "organization-duplicate": "catalogReasonDuplicate",
  "declaration-conflict": "catalogReasonDeclaration",
  "module-unavailable": "catalogReasonModuleUnavailable",
  "explicit-apps-required": "catalogReasonExplicitApps",
  "no-app": "catalogReasonNoApp",
  "default-app-invalid": "catalogReasonDefaultApp",
};

export type CatalogStatus = Readonly<{
  /** The status dot: `ready` runs, `blocked` does not. */
  state: "ready" | "blocked";
  /** The sentence shown next to it. */
  text: string;
  /** The stable reason code, shown as code next to the sentence. */
  code: string | null;
}>;

/** Whether an Organization or module can run, and why not, in words. An
 * unknown reason code is named by its code rather than guessed. */
export function catalogStatus(
  entry: Readonly<{ executable: boolean; reason?: string }>,
  copy: Copy,
): CatalogStatus {
  if (entry.executable)
    return { state: "ready", text: copy.catalogReady, code: null };
  const reason = entry.reason ?? "not-executable";
  const key = Object.hasOwn(reasonKeys, reason)
    ? reasonKeys[reason as keyof typeof reasonKeys]
    : undefined;
  return {
    state: "blocked",
    text: key === undefined ? reason : copy[key],
    code: reason,
  };
}

export type TeamGroup = Readonly<{
  /** The Team, or null for the modules of no Team. */
  team: CatalogTeam | null;
  modules: readonly CatalogModule[];
}>;

/** The modules of an Organization under a subheader per Team (T3 Code's
 * project groups): the declared Teams in declaration order, then Teams a
 * module names without a declaration, then the modules of no Team. A module
 * of two Teams is listed under both. Empty Teams are left out. */
export function teamGroups(
  organization: CatalogOrganization,
  copy: Copy,
): readonly TeamGroup[] {
  const declared = new Map(
    organization.teams.map((team) => [team.slug, team] as const),
  );
  const named = [
    ...new Set(organization.modules.flatMap((module) => module.teams)),
  ]
    .filter((slug) => !declared.has(slug))
    .sort();
  const teams = [
    ...organization.teams,
    ...named.map((slug) => ({ slug, displayName: slug })),
  ];
  const groups: TeamGroup[] = teams
    .map((team) => ({
      team,
      modules: organization.modules.filter((module) =>
        module.teams.includes(team.slug),
      ),
    }))
    .filter((group) => group.modules.length > 0);
  const other = organization.modules.filter(
    (module) => module.teams.length === 0,
  );
  if (other.length > 0) {
    // Without any Team there is nothing to group: no subheader at all.
    if (groups.length === 0) return [{ team: null, modules: other }];
    groups.push({
      team: { slug: "", displayName: copy.catalogOtherModules },
      modules: other,
    });
  }
  return groups;
}

/** The Organization a route names: its slug, as the catalog wrote it, or the
 * same slug in another case (GitHub slugs are case-insensitive). Only a
 * resolved Organization has a route. */
export function routeOrganization(
  catalog: Catalog,
  slug: string,
): CatalogOrganization | undefined {
  const matches = catalog.organizations.filter(
    (entry) => entry.organization?.toLowerCase() === slug.toLowerCase(),
  );
  return (
    matches.find((entry) => entry.organization === slug) ??
    (matches.length === 1 ? matches[0] : undefined)
  );
}

/** What a catalog route shows; `missing` when the Folder does not have it. */
export function catalogSelection(
  catalog: Catalog,
  route: PageRoute,
):
  | Readonly<{ kind: "overview" }>
  | Readonly<{ kind: "organization"; organization: CatalogOrganization }>
  | Readonly<{
      kind: "module";
      organization: CatalogOrganization;
      module: CatalogModule;
    }>
  | Readonly<{ kind: "missing" }> {
  if (route.view === "home" || route.view === "settings")
    return { kind: "overview" };
  const organization = routeOrganization(catalog, route.organization);
  if (organization === undefined) return { kind: "missing" };
  if (route.view === "organization")
    return { kind: "organization", organization };
  const module = organization.modules.find(
    (entry) => entry.module === route.module,
  );
  return module === undefined
    ? { kind: "missing" }
    : { kind: "module", organization, module };
}

/** The name an Organization is shown under: display name, slug, directory. */
export const organizationName = (organization: CatalogOrganization): string =>
  organization.displayName ??
  organization.organization ??
  organization.directory;

// The exact shape of the server's answer, before anything is drawn from it.
const text = (value: unknown): value is string => typeof value === "string";
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text);
const orNull = (value: unknown) => value === null || text(value);
function isModule(value: unknown): value is CatalogModule {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    text(entry.organization) &&
    text(entry.module) &&
    text(entry.path) &&
    texts(entry.teams) &&
    Array.isArray(entry.apps) &&
    entry.apps.every(
      (app: unknown) =>
        !!app &&
        typeof app === "object" &&
        text((app as Record<string, unknown>).package) &&
        text((app as Record<string, unknown>).kind),
    ) &&
    orNull(entry.defaultApp) &&
    text(entry.state) &&
    typeof entry.executable === "boolean" &&
    (entry.reason === undefined || text(entry.reason))
  );
}
function isOrganization(value: unknown): value is CatalogOrganization {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    text(entry.directory) &&
    orNull(entry.organization) &&
    orNull(entry.displayName) &&
    orNull(entry.state) &&
    texts(entry.issues) &&
    typeof entry.executable === "boolean" &&
    (entry.reason === undefined || text(entry.reason)) &&
    Array.isArray(entry.teams) &&
    entry.teams.every(
      (team: unknown) =>
        !!team &&
        typeof team === "object" &&
        text((team as Record<string, unknown>).slug) &&
        text((team as Record<string, unknown>).displayName),
    ) &&
    Array.isArray(entry.modules) &&
    entry.modules.every(isModule)
  );
}

/** The catalog, when the answer is one; null otherwise. */
export function parseCatalog(input: unknown): Catalog | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  return value.kind === "catalog" &&
    Array.isArray(value.organizations) &&
    value.organizations.every(isOrganization)
    ? (value as Catalog)
    : null;
}
