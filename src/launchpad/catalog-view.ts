import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogTeam,
  ModuleReason,
  OrganizationReason,
  PersonalspaceReason,
} from "../organizations/catalog";
import {
  catalogOrganizationKey,
  selectCatalogOrganization,
} from "../organizations/catalog-selection";
import type { MessageKey } from "./messages";
import { modulePath, organizationPath, type PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Folder catalog (launchpad-parity B1) for the
// Launchpad home; the DOM lives in catalog-panel.ts. Every value from the
// server is shown as text, never as markup.

const reasonKeys: Readonly<
  Record<OrganizationReason | PersonalspaceReason | ModuleReason, MessageKey>
> = {
  "canonical-documents-required": "catalogReasonCanonical",
  "organization-conflict": "catalogReasonConflict",
  "organization-not-executable": "catalogReasonNotExecutable",
  "template-not-runtime": "catalogReasonTemplate",
  "organization-changed": "catalogReasonChanged",
  "organization-unavailable": "catalogReasonUnavailable",
  "organization-duplicate": "catalogReasonDuplicate",
  "personalspace-ambiguous": "catalogReasonPersonalspaceAmbiguous",
  "personalspace-unavailable": "catalogReasonPersonalspaceUnavailable",
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

/** Whether any module of the Organization takes its Teams from the legacy
 * alias (`workspaces` or `workspace`): the page and the CLI say it once per
 * Organization, never per module, to help migrate its manifest to the
 * canonical `module_slots[].teams`. */
export function usesLegacyTeamAlias(
  organization: Pick<CatalogOrganization, "modules">,
): boolean {
  return organization.modules.some(
    (module) => module.teamsSource === "legacy-alias",
  );
}

/** The Organization a route names, under the CLI's rule
 * (`selectCatalogOrganization`): its slug case-insensitively, otherwise its
 * directory name; undefined when missing or when the slug is ambiguous. */
export function routeOrganization(
  catalog: Catalog,
  name: string,
): CatalogOrganization | undefined {
  const selection = selectCatalogOrganization(catalog, name);
  return selection.kind === "found" ? selection.organization : undefined;
}

/** The route of one candidate: `/o/<name>` with the name that selects exactly
 * it (its slug, otherwise its directory name), or null when no name does,
 * so two candidates of one slug never share a link. */
export function organizationRoute(
  catalog: Catalog,
  organization: CatalogOrganization,
): string | null {
  const key = catalogOrganizationKey(catalog, organization);
  return key === null ? null : organizationPath(key);
}

/** The route of one module of a candidate, or null as above. */
export function moduleRoute(
  catalog: Catalog,
  organization: CatalogOrganization,
  module: CatalogModule,
): string | null {
  const key = catalogOrganizationKey(catalog, organization);
  return key === null ? null : modulePath(key, module.module);
}

/** What a catalog route shows; `ambiguous` when more than one candidate
 * declares the slug (their isolation, never one of them), `missing` when the
 * Folder does not have it. */
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
  | Readonly<{
      kind: "ambiguous";
      candidates: readonly CatalogOrganization[];
    }>
  | Readonly<{ kind: "missing" }> {
  if (route.view === "home" || route.view === "settings")
    return { kind: "overview" };
  const selection = selectCatalogOrganization(catalog, route.organization);
  if (selection.kind !== "found") return selection;
  const { organization } = selection;
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
    text(entry.teamsSource) &&
    Array.isArray(entry.apps) &&
    entry.apps.every(
      (app: unknown) =>
        !!app &&
        typeof app === "object" &&
        text((app as Record<string, unknown>).package) &&
        text((app as Record<string, unknown>).kind),
    ) &&
    orNull(entry.defaultApp) &&
    orNull(entry.state) &&
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
    value.organizations.every(isOrganization) &&
    (value.personalspace === undefined || isOrganization(value.personalspace))
    ? (value as Catalog)
    : null;
}
