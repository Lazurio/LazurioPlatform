import type {
  RuntimeSecretFinding,
  RuntimeSecretReason,
} from "../modules/runtime-secrets";
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
import {
  type CatalogService,
  isCatalogService,
  type ServiceKind,
} from "../organizations/server-services";
import type { MessageKey } from "./messages";
import {
  modulePath,
  organizationPath,
  type PageRoute,
  repositoryPath,
} from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Folder catalog (launchpad-parity B1) for the
// Launchpad home; the DOM lives in catalog-panel.ts. Every value from the
// server is shown as text, never as markup. Teams are not shown at all
// (decision F32): the catalog still carries them for the CLI. An
// Organization has two sections: Workspace, every module of it that is on
// this Environment (F32 addendum of 2026-10-15), and Productionspace, its
// production repositories read-only (F32 addendum of 2026-10-03, final).

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
  "personalspace-foreign": "catalogReasonPersonalspaceForeign",
  "personalspace-not-owned": "catalogReasonPersonalspaceNotOwned",
  "personalspace-public": "catalogReasonPersonalspacePublic",
  "github-signed-out": "catalogReasonGithubSignedOut",
  "github-unavailable": "catalogReasonGithubUnavailable",
  "github-identity-mismatch": "catalogReasonGithubIdentityMismatch",
  "personalspace-unverified": "catalogReasonPersonalspaceUnverified",
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
  "preparation-lockfile-unused": "preparationReasonLockfileUnused",
  "preparation-package-manager-unsupported": "preparationReasonPackageManager",
  "preparation-workspace-unqualified": "preparationReasonWorkspace",
  "preparation-applications-overlap": "preparationReasonApplicationsOverlap",
  "preparation-dependency-outside-owner": "preparationReasonDependencyOutside",
  "preparation-dependency-missing": "preparationReasonDependencyMissing",
  "preparation-toolchain-mismatch": "preparationReasonToolchainMismatch",
  "preparation-install-failed": "preparationReasonInstallFailed",
  "preparation-script-failed": "preparationReasonScriptFailed",
  "runtime-secret-unavailable": "moduleReasonRuntimeSecretUnavailable",
};

const secretReasonKeys: Readonly<Record<RuntimeSecretReason, MessageKey>> = {
  personalspace: "runtimeSecretPersonalspace",
  "personal-environment": "runtimeSecretPersonalEnvironment",
  workstation: "runtimeSecretWorkstation",
  "no-vault-identity": "runtimeSecretNoVaultIdentity",
  "other-organization": "runtimeSecretOtherOrganization",
  "not-connected": "runtimeSecretNotConnected",
  locked: "runtimeSecretLocked",
  busy: "runtimeSecretBusy",
  unreachable: "runtimeSecretUnreachable",
  "vault-failed": "runtimeSecretVaultFailed",
  missing: "runtimeSecretMissing",
  ambiguous: "runtimeSecretAmbiguous",
  empty: "runtimeSecretEmpty",
};

/** Declared runtime secrets without a value in words: the names of each
 * reason, then why, `A, B: why; C: why`. An unknown reason is named by its
 * code. */
export function runtimeSecretsText(
  secrets: readonly RuntimeSecretFinding[] | undefined,
  copy: Copy,
): string {
  const byReason = new Map<string, string[]>();
  for (const entry of secrets ?? [])
    byReason.set(entry.reason, [
      ...(byReason.get(entry.reason) ?? []),
      entry.name,
    ]);
  return [...byReason]
    .map(([reason, names]) => {
      const key = Object.hasOwn(secretReasonKeys, reason)
        ? secretReasonKeys[reason as RuntimeSecretReason]
        : undefined;
      return `${names.join(", ")}: ${key === undefined ? reason : copy[key]}`;
    })
    .join("; ");
}

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
  entry: Readonly<{
    executable: boolean;
    reason?: string;
    file?: string;
    secrets?: readonly RuntimeSecretFinding[];
  }>,
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
    text:
      key === undefined
        ? reason
        : withFile(copy[key], entry.file).replace(
            "{secrets}",
            runtimeSecretsText(entry.secrets, copy),
          ),
    code: reason,
  };
}

// When the page reads the catalog again for a Personalspace group whose
// holder is not decided yet.
const personalspaceRereads = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** How long the page waits before it reads the catalog again because its
 * Personalspace group is not decided yet (#186), for the `attempt`-th time
 * in a row; null when it is decided or there is none, or after the last
 * attempt. The catalog never waits for GitHub: before the Launchpad's first
 * answer whose Personalspace this is the group is `personalspace-unverified`,
 * and where GitHub did not answer it is asked again behind the next read. */
export function personalspaceRereadMs(
  catalog: Catalog,
  attempt: number,
): number | null {
  const reason = catalog.personalspace?.reason;
  return reason === "personalspace-unverified" ||
    reason === "github-unavailable"
    ? (personalspaceRereads[attempt] ?? null)
    : null;
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

/** The page of one service repository of a candidate (root decision 0209
 * point 6), or null as above, and for a repository without a service: a
 * production repository has no page of its own (F32's final addendum). */
export function repositoryRoute(
  catalog: Catalog,
  organization: CatalogOrganization,
  repository: CatalogRepository,
): string | null {
  const key = catalogOrganizationKey(catalog, organization);
  return key === null || repository.services === undefined
    ? null
    : repositoryPath(key, repository.slug);
}

/** The services of a repository that have a page, in their order. */
export const servicePages = (
  repository: CatalogRepository,
): readonly (CatalogService & { page: string })[] =>
  (repository.services ?? []).flatMap((service) =>
    service.page === null ? [] : [{ ...service, page: service.page }],
  );

/** The page of the service `id` of this Environment (root decision 0209
 * point 6): its loopback address, or null where no repository of the
 * catalog lists exactly one service of that id, or it has no page. */
export function servicePageOf(catalog: Catalog, id: string): string | null {
  const found = catalogGroups(catalog).flatMap((organization) =>
    organization.repositories.flatMap((repository) =>
      (repository.services ?? []).filter((service) => service.id === id),
    ),
  );
  const [service] = found;
  return found.length === 1 && service !== undefined ? service.page : null;
}

const serviceKindKeys: Readonly<Record<ServiceKind, MessageKey>> = {
  "ai-pool": "serviceKindAiPool",
  "ai-gateway": "serviceKindAiGateway",
  http: "serviceKindHttp",
  diagnostics: "serviceKindDiagnostics",
  "public-entry": "serviceKindPublicEntry",
  dns01: "serviceKindDns01",
};

/** What a service is, in a person's words: "AI pool Organizace". */
export const serviceKindText = (service: CatalogService, copy: Copy): string =>
  copy[serviceKindKeys[service.kind]];

/** A service repository's one line: what its services are, each kind once,
 * in their order ("Brána AI · AI pool Organizace"). */
export const servicesText = (
  services: readonly CatalogService[],
  copy: Copy,
): string =>
  [...new Set(services.map((service) => serviceKindText(service, copy)))].join(
    " · ",
  );

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
  /** A service repository's page (root decision 0209 point 6). */
  | Readonly<{
      kind: "repository";
      organization: CatalogOrganization;
      repository: CatalogRepository;
    }>
  | Readonly<{
      kind: "ambiguous";
      candidates: readonly CatalogOrganization[];
    }>
  | Readonly<{ kind: "missing" }> {
  if (
    route.view === "home" ||
    route.view === "settings" ||
    route.view === "files" ||
    route.view === "integrations" ||
    route.view === "vault" ||
    route.view === "marketplace"
  )
    return { kind: "overview" };
  const selection = selectCatalogOrganization(catalog, route.organization);
  if (selection.kind !== "found") return selection;
  const { organization } = selection;
  if (route.view === "organization")
    return { kind: "organization", organization };
  if (route.view === "repository") {
    // Only a repository with a service has a page, and only one entry of
    // that slug may be it.
    const found = organization.repositories.filter(
      (entry) =>
        entry.slug === route.repository && entry.services !== undefined,
    );
    const [repository] = found;
    return repository === undefined || found.length !== 1
      ? { kind: "missing" }
      : { kind: "repository", organization, repository };
  }
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

/** One production repository as the page lists it: no status dot, no
 * action, no page (F32 addendum of 2026-10-03); in Služby serveru one with
 * the services of this Environment, whose page it opens and which has a
 * page of its own (root decision 0209 point 6, F32's addendum of
 * 2026-10-24). */
export type CatalogRepositoryEntry = Readonly<{
  repository: CatalogRepository;
  /** "Checked out" or "Not checked out", in words. */
  checkout: string;
}>;

/** One of the two sections of an Organization, in this order (F32 addendum
 * of 2026-10-03, final): Workspace, every module of it that is on this
 * Environment in the catalog's order (F32 addendum of 2026-10-15);
 * Productionspace, its production repositories read-only in
 * declaration order. Nothing else: where a module's repository sits in the
 * Organization is not something the Operator acts on. */
export type CatalogSection =
  | Readonly<{
      kind: "workspace";
      title: string;
      modules: readonly CatalogModuleEntry[];
      /** The Organization's own tabs (decision F32's addendum of
       * 2026-10-16), null when it shows none. */
      tabs: readonly CatalogWorkspaceTab[] | null;
    }>
  | Readonly<{
      kind: "productionspace";
      title: string;
      repositories: readonly CatalogRepositoryEntry[];
    }>;
export type CatalogSectionKind = CatalogSection["kind"];

/** One tab of an Organization's Workspace: its name and its modules that
 * are on this Environment, in the catalog's order. */
export type CatalogWorkspaceTab = Readonly<{
  name: string;
  modules: readonly CatalogModuleEntry[];
}>;

/** The Workspace's tabs as the page shows them (decision F32's addendum of
 * 2026-10-16): the Organization's tabs in its order, each with its modules
 * that are here in the catalog's order; a module the Organization put in no
 * tab, or in a tab it named twice, is in the first tab. A tab without a
 * module here is left out, and fewer than two tabs show none: the plain
 * Workspace. Module ids the Organization names that are not here make no
 * tile. */
export function workspaceTabs(
  declared: CatalogOrganization["workspaceTabs"],
  modules: readonly CatalogModuleEntry[],
): readonly CatalogWorkspaceTab[] | null {
  if (declared === undefined || declared.length === 0) return null;
  const tabOf = new Map<string, number>();
  declared.forEach((tab, index) => {
    for (const id of tab.modules) if (!tabOf.has(id)) tabOf.set(id, index);
  });
  const tabs = declared
    .map((tab, index) => ({
      name: tab.name,
      modules: modules.filter(
        (entry) => (tabOf.get(entry.module.module) ?? 0) === index,
      ),
    }))
    .filter((tab) => tab.modules.length > 0);
  return tabs.length < 2 ? null : tabs;
}

/** One group as the sidebar and the overview list it: an Organization, or
 * the Personalspace group after the Organizations (B11). */
export type CatalogGroupEntry = Readonly<{
  organization: CatalogOrganization;
  name: string;
  href: string | null;
  status: CatalogStatus;
  /** Every module of the group that is on this Environment exactly once, in
   * the catalog's order (the declaration order of `module_slots`), whatever
   * Teams declare it: an Environment is one workspace, and Teams are no
   * presentation axis of the Launchpad (decision F32). A declared module
   * that was never materialized here (`absent`: this Environment's GitHub
   * identity cannot read it, or it is not synchronized yet) is not listed:
   * nobody sees a module they cannot open (F32 addendum of 2026-10-15, root
   * decision 0179 point 5). */
  modules: readonly CatalogModuleEntry[];
  /** An Organization's sections that have something in them, in the order
   * Workspace, Productionspace: every module in Workspace, every production
   * repository in Productionspace. Null for the Personalspace group, which
   * stays one list. */
  sections: readonly CatalogSection[] | null;
}>;

/** One group of the catalog with its modules, as the page lists it. */
export function catalogGroupEntry(
  catalog: Catalog,
  organization: CatalogOrganization,
  copy: Copy,
): CatalogGroupEntry {
  const modules = organization.modules.flatMap((module) =>
    module.absent === true
      ? []
      : [
          {
            module,
            href: moduleRoute(catalog, organization, module),
            status: catalogStatus(module, copy),
          },
        ],
  );
  const repositories = organization.repositories.map((repository) => ({
    repository,
    checkout: repository.checkedOut
      ? copy.catalogCheckedOut
      : copy.catalogNotCheckedOut,
  }));
  const sections =
    organization === catalog.personalspace
      ? null
      : [
          ...(modules.length === 0
            ? []
            : [
                {
                  kind: "workspace" as const,
                  title: copy.catalogSectionWorkspace,
                  modules,
                  tabs: workspaceTabs(organization.workspaceTabs, modules),
                },
              ]),
          ...(repositories.length === 0
            ? []
            : [
                {
                  kind: "productionspace" as const,
                  title: copy.catalogSectionProductionspace,
                  repositories,
                },
              ]),
        ];
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
 * Team membership the CLI's JSON still carries, nor the catalog's resolution
 * state, which tells a person nothing (F36's addendum of 2026-10-16). */
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
  ];
}

/** What a service repository's page says of it, "O repozitáři" (the
 * wireframe's `RepositoryPage`, prototypes-lazurio #71): read-only, and its
 * folder in the Organization where the Organization declares it; its GitHub
 * page is the page's link beside these. */
export function repositoryFacts(
  repository: CatalogRepository,
  copy: Copy,
): readonly CatalogFact[] {
  return [
    [copy.appsRepositoryAccess, copy.appsRepositoryReadOnly],
    ...(repository.path === null
      ? []
      : ([[copy.appsRepositoryFolder, repository.path]] as CatalogFact[])),
  ];
}

/** What a service's card says of it, "Služba": its name and what it is,
 * where it runs (`environment`, this Environment's name as the shell names
 * it, "Služby serveru"; null before the shell document is read) and the
 * address of its page where it has one, without the scheme. */
export function serviceFacts(
  service: CatalogService,
  environment: string | null,
  copy: Copy,
): readonly CatalogFact[] {
  return [
    [copy.appsServiceName, service.id],
    [copy.appsServiceKind, serviceKindText(service, copy)],
    ...(environment === null
      ? []
      : ([[copy.appsServiceRunsIn, environment]] as CatalogFact[])),
    ...(service.page === null
      ? []
      : ([
          [copy.appsServicePage, service.page.replace(/^http:\/\//, "")],
        ] as CatalogFact[])),
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
    (entry.display === undefined || isDisplay(entry.display)) &&
    (entry.url === undefined ||
      (text(entry.url) && entry.url.startsWith("https://github.com/"))) &&
    (entry.absent === undefined || entry.absent === true)
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
    orNull(entry.path) &&
    typeof entry.checkedOut === "boolean" &&
    (entry.url === null ||
      (text(entry.url) && entry.url.startsWith("https://github.com/"))) &&
    // Služby serveru's services (root decision 0209 point 6): at most the
    // schema's 32, each with a loopback page or none.
    (entry.services === undefined ||
      (Array.isArray(entry.services) &&
        entry.services.length > 0 &&
        entry.services.length <= 32 &&
        entry.services.every(isCatalogService)))
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
    entry.repositories.every(isRepository) &&
    (entry.workspaceTabs === undefined ||
      (Array.isArray(entry.workspaceTabs) &&
        entry.workspaceTabs.length <= 12 &&
        entry.workspaceTabs.every(isWorkspaceTab)))
  );
}
function isWorkspaceTab(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return (
    text(tab.name) &&
    tab.name.length > 0 &&
    [...tab.name].length <= 40 &&
    Array.isArray(tab.modules) &&
    tab.modules.length <= 500 &&
    tab.modules.every(
      (id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id),
    )
  );
}

/** Služby serveru's services group as the core writes it: in the shape of an
 * Organization with a slug, an empty directory, no GitHub binding (so nobody
 * is offered to found a module in it) and no modules, every repository a
 * service repository. */
function isServicesGroup(value: unknown): value is CatalogOrganization {
  if (!isOrganization(value)) return false;
  return (
    value.directory === "" &&
    value.organization !== null &&
    value.organization.length > 0 &&
    value.forgeLogin === undefined &&
    value.modules.length === 0 &&
    value.repositories.length > 0 &&
    value.repositories.every((entry) => entry.services !== undefined)
  );
}

/** The catalog, when the answer is one; null otherwise. */
export function parseCatalog(input: unknown): Catalog | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  return value.kind === "catalog" &&
    Array.isArray(value.organizations) &&
    value.organizations.every(isOrganization) &&
    (value.personalspace === undefined ||
      isOrganization(value.personalspace)) &&
    // Služby serveru's services group (root decision 0209 point 6): no
    // directory, no modules, only service repositories.
    (value.serverServices === undefined ||
      isServicesGroup(value.serverServices))
    ? (value as Catalog)
    : null;
}
