import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
  ModuleReason,
  OrganizationReason,
  PersonalspaceReason,
} from "../organizations/catalog";
import {
  catalogGroups,
  catalogOrganizationKey,
  selectCatalogOrganization,
} from "../organizations/catalog-selection";
import type { MessageKey } from "./messages";
import { modulePath, organizationPath, type PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Folder catalog (launchpad-parity B1) for the
// Launchpad home; the DOM lives in catalog-panel.ts. Every value from the
// server is shown as text, never as markup. Teams are not shown at all
// (decision F32): the catalog still carries them for the CLI. An
// Organization's modules and read-only repositories are grouped by where they
// live in its layout (F32 addendum of 2026-10-03).

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
  "declaration-not-regular": "catalogReasonDeclarationNotRegular",
  "declaration-owner": "catalogReasonDeclarationOwner",
  "declaration-too-large": "catalogReasonDeclarationTooLarge",
  "directory-not-regular": "catalogReasonDirectoryNotRegular",
  "directory-owner": "catalogReasonDirectoryOwner",
  "preparation-owner-invalid": "preparationReasonOwnerInvalid",
  "preparation-script-missing": "preparationReasonScriptMissing",
  "preparation-lockfile-missing": "preparationReasonLockfileMissing",
  "preparation-lockfile-ambiguous": "preparationReasonLockfileAmbiguous",
  "preparation-package-manager-unsupported": "preparationReasonPackageManager",
  "preparation-workspace-unqualified": "preparationReasonWorkspace",
  "preparation-applications-overlap": "preparationReasonApplicationsOverlap",
  "preparation-dependency-outside-owner": "preparationReasonDependencyOutside",
  "preparation-dependency-missing": "preparationReasonDependencyMissing",
  "preparation-toolchain-mismatch": "preparationReasonToolchainMismatch",
  "preparation-install-failed": "preparationReasonInstallFailed",
  "preparation-script-failed": "preparationReasonScriptFailed",
};

/** A reason's sentence with the refused file in it (decision F23), when the
 * reason names one; the file is text, never markup. */
export function withFile(sentence: string, file: string | undefined): string {
  return sentence.replace("{file}", file ?? "?");
}

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
  entry: Readonly<{ executable: boolean; reason?: string; file?: string }>,
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
    text: key === undefined ? reason : withFile(copy[key], entry.file),
    code: reason,
  };
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
  if (
    route.view === "home" ||
    route.view === "settings" ||
    route.view === "files"
  )
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

/** One module as the sidebar and the overview list it. */
export type CatalogModuleEntry = Readonly<{
  module: CatalogModule;
  /** Its route, or null where no name selects its candidate. */
  href: string | null;
  status: CatalogStatus;
}>;

/** One read-only repository as the page lists it: no status dot, no action,
 * no page (F32 addendum of 2026-10-03). */
export type CatalogRepositoryEntry = Readonly<{
  repository: CatalogRepository;
  /** "Checked out" or "Not checked out", in words. */
  checkout: string;
}>;

/** The layout groups of an Organization, in this order (F32 addendum of
 * 2026-10-03, root decision 0179 point 5). */
export const catalogLayouts = [
  "organization",
  "workspace",
  "productionspace",
] as const;
export type CatalogSectionLayout = (typeof catalogLayouts)[number];

/** One layout group of an Organization: its heading, its modules in the
 * catalog's order, then its read-only repositories in declaration order. */
export type CatalogSection = Readonly<{
  layout: CatalogSectionLayout;
  title: string;
  modules: readonly CatalogModuleEntry[];
  repositories: readonly CatalogRepositoryEntry[];
}>;

const layoutTitles: Readonly<Record<CatalogSectionLayout, MessageKey>> = {
  organization: "catalogLayoutOrganization",
  workspace: "catalogLayoutWorkspace",
  productionspace: "catalogLayoutProductionspace",
};

/** One group as the sidebar and the overview list it: an Organization, or
 * the Personalspace group after the Organizations (B11). */
export type CatalogGroupEntry = Readonly<{
  organization: CatalogOrganization;
  name: string;
  href: string | null;
  status: CatalogStatus;
  /** Every module of the group exactly once, in the catalog's order (the
   * declaration order of `module_slots`), whatever Teams declare it: an
   * Environment is one workspace, and Teams are no presentation axis of the
   * Launchpad (decision F32). */
  modules: readonly CatalogModuleEntry[];
  /** An Organization's layout groups that have something in them, in the
   * order of `catalogLayouts`: every module and read-only repository in
   * exactly one. Null for the Personalspace group, which stays one list. */
  sections: readonly CatalogSection[] | null;
}>;

/** One group of the catalog with its modules, as the page lists it. */
export function catalogGroupEntry(
  catalog: Catalog,
  organization: CatalogOrganization,
  copy: Copy,
): CatalogGroupEntry {
  const modules = organization.modules.map((module) => ({
    module,
    href: moduleRoute(catalog, organization, module),
    status: catalogStatus(module, copy),
  }));
  const sections =
    organization === catalog.personalspace
      ? null
      : catalogLayouts.flatMap((layout): CatalogSection[] => {
          const own = {
            layout,
            title: copy[layoutTitles[layout]],
            modules: modules.filter((entry) => entry.module.layout === layout),
            repositories: organization.repositories
              .filter((repository) => repository.layout === layout)
              .map((repository) => ({
                repository,
                checkout: repository.checkedOut
                  ? copy.catalogCheckedOut
                  : copy.catalogNotCheckedOut,
              })),
          };
          return own.modules.length + own.repositories.length === 0
            ? []
            : [own];
        });
  return {
    organization,
    name: organizationName(organization),
    href: organizationRoute(catalog, organization),
    status: catalogStatus(organization, copy),
    modules,
    sections,
  };
}

/** The groups the sidebar and the overview list, in the catalog's order. */
export function catalogTree(
  catalog: Catalog,
  copy: Copy,
): readonly CatalogGroupEntry[] {
  return catalogGroups(catalog).map((organization) =>
    catalogGroupEntry(catalog, organization, copy),
  );
}

/** One fact of an Organization's or a module's page: its label and a line
 * or a list. */
export type CatalogFact = readonly [
  label: string,
  value: string | readonly string[],
];

/** What the Organization page says of it. Its Teams are not among them:
 * Teams and access are managed in the Dashboard (decision F32). */
export function organizationFacts(
  organization: CatalogOrganization,
  copy: Copy,
): readonly CatalogFact[] {
  return [
    [copy.catalogDirectory, organization.directory],
    [copy.catalogState, organization.state ?? copy.catalogNone],
    [
      copy.catalogIssues,
      organization.issues.length === 0 ? copy.catalogNone : organization.issues,
    ],
  ];
}

/** What the module page says of it, its Teams not among them (F32), nor
 * the module's `issues`, whose one code is `teams-invalid`: a defect of the
 * Team membership the CLI's JSON still carries. */
export function moduleFacts(
  organization: CatalogOrganization,
  module: CatalogModule,
  copy: Copy,
): readonly CatalogFact[] {
  return [
    [copy.catalogOrganization, organizationName(organization)],
    [
      copy.catalogApps,
      module.apps.length === 0
        ? copy.catalogNone
        : module.apps.map((app) =>
            app.package === module.defaultApp
              ? `${app.package} (${copy.catalogDefaultMark})`
              : app.package,
          ),
    ],
    [copy.catalogPath, module.path],
    [copy.catalogState, module.state ?? copy.catalogNone],
  ];
}

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
    (entry.layout === "organization" || entry.layout === "workspace") &&
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
    (entry.reason === undefined || text(entry.reason)) &&
    (entry.file === undefined || text(entry.file)) &&
    (entry.preparationRefused === undefined ||
      entry.preparationRefused === true) &&
    (entry.display === undefined || isDisplay(entry.display))
  );
}
// The default app's display text (decision F36): bounded strings only.
function isDisplay(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const bounded = (item: unknown, max: number) =>
    text(item) && item.length > 0 && [...item].length <= max;
  return (
    bounded(entry.id, 128) &&
    bounded(entry.title, 120) &&
    (entry.description === undefined || bounded(entry.description, 240)) &&
    (entry.icon === undefined ||
      (text(entry.icon) && /^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.icon))) &&
    texts(entry.tags) &&
    entry.tags.length <= 20 &&
    entry.tags.every((tag) => bounded(tag, 128))
  );
}
function isRepository(value: unknown): value is CatalogRepository {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    text(entry.slug) &&
    (entry.layout === "organization" || entry.layout === "productionspace") &&
    text(entry.path) &&
    typeof entry.checkedOut === "boolean" &&
    (entry.url === null ||
      (text(entry.url) && entry.url.startsWith("https://github.com/")))
  );
}
function isOrganization(value: unknown): value is CatalogOrganization {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    text(entry.directory) &&
    orNull(entry.organization) &&
    orNull(entry.displayName) &&
    (entry.forgeLogin === undefined ||
      (text(entry.forgeLogin) &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(
          entry.forgeLogin,
        ))) &&
    orNull(entry.state) &&
    texts(entry.issues) &&
    typeof entry.executable === "boolean" &&
    (entry.reason === undefined || text(entry.reason)) &&
    (entry.file === undefined || text(entry.file)) &&
    Array.isArray(entry.teams) &&
    entry.teams.every(
      (team: unknown) =>
        !!team &&
        typeof team === "object" &&
        text((team as Record<string, unknown>).slug) &&
        text((team as Record<string, unknown>).displayName),
    ) &&
    Array.isArray(entry.modules) &&
    entry.modules.every(isModule) &&
    Array.isArray(entry.repositories) &&
    entry.repositories.every(isRepository)
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
