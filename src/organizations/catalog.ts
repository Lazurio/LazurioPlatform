import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectCheckoutDirectory,
  inspectOwnedDirectory,
} from "../folder/owned-directory";
import { inspectPreparationShape } from "../modules/preparation-binding";
import {
  type PreparationReason,
  preparationRefusal,
} from "../modules/preparation-refusal";
import {
  type CheckoutReason,
  checkoutRefusal,
} from "../providers/checkout-custody";
import { catalogGroups, selectCatalogOrganization } from "./catalog-selection";
import {
  folderHasPersonalspace,
  locatePersonalspace,
  observePersonalspaceModule,
  personalspaceModuleIds,
  personalspaceName,
} from "./personalspace";
import { observeOrganizationApplications } from "./read-applications";
import type { OrganizationRootState } from "./root-resolution";

// The catalog of a Lazurio Folder (launchpad-parity B1): every directory in
// `<Folder>/organizations/` is one candidate, resolved by the canonical reader
// of `read-applications` and `root-resolution`. No allowlist, no planned slots,
// no `launchpad.gen3*.json`, no state: it is recomputed on every read. A
// candidate that cannot be read is isolated with its typed reason and never
// breaks the list. Executable here means the declarations admit a start of the
// module's default app; it is not provider permission, readiness or a lease,
// and every operation resolves its selection again.

/** Why an Organization's modules cannot run. */
export type OrganizationReason =
  /** Neither canonical nor legacy documents, or only the legacy projection. */
  | "canonical-documents-required"
  /** Unreadable, malformed or divergent documents (root state `conflict`). */
  | "organization-conflict"
  /** Resolved, but the admission rule does not execute this state. */
  | "organization-not-executable"
  /** A template root is never runtime. */
  | "template-not-runtime"
  /** The documents changed during the observation; read again. */
  | "organization-changed"
  /** Not a real, caller-owned, stable directory (decision F23: write bits
   * are not a reason), or unreadable. */
  | "organization-unavailable"
  /** Another candidate declares the same Organization slug (GitHub slugs are
   * case-insensitive): `<Org>/<Module>` would be ambiguous. */
  | "organization-duplicate"
  /** One of its documents is not a file of the operator's checkout: not a
   * regular file, another account's or too large (decision F23); `file`
   * names it. */
  | CheckoutReason;

/** Why the Personalspace group's modules cannot be listed (launchpad-parity
 * B11). */
export type PersonalspaceReason =
  /** More than one directory in `personalspace/`: which one is the
   * Principal's is not guessed, and none of them is read (decision 0091). */
  | "personalspace-ambiguous"
  /** `personalspace/` or its owner directory is not a caller-owned,
   * stable directory (decision F23), or unreadable. */
  | "personalspace-unavailable";

/** Why one module cannot run, when its Organization can. */
export type ModuleReason =
  | "declaration-conflict"
  | "module-unavailable"
  | "explicit-apps-required"
  | "no-app"
  | "default-app-invalid"
  /** `lazurio.module.json` or the default app's `package.json` is not a file
   * of the operator's checkout (decision F23); `file` names it. */
  | CheckoutReason
  /** The default app's preparation cannot run for a reason known without
   * running anything (decision F25); `file` names the package it concerns. */
  | PreparationReason;

export type CatalogApp = Readonly<{
  package: string;
  kind: "runtime-declared" | "invalid-runtime";
  /** Why an `invalid-runtime` app's declaration was refused, and which
   * module-relative file (decision F23). */
  reason?: CheckoutReason;
  file?: string;
}>;

/** Where a module's Team membership comes from: the canonical
 * `module_slots[].teams`, the legacy alias (`workspaces`, then the singular
 * `workspace`) read for compatibility, or neither (the default Team). A
 * Personalspace module has no Teams at all (`none`). */
export type TeamsSource = "teams" | "legacy-alias" | "default" | "none";

/** The Team of a workspace module that declares none (decision 0041). */
export const defaultTeam = "workspace";

export type CatalogModule = Readonly<{
  organization: string;
  module: string;
  path: string;
  /** Team slugs, N:M, in declaration order; never empty for an Organization
   * module (see `teamsSource`), empty for a Personalspace module. */
  teams: readonly string[];
  teamsSource: TeamsSource;
  apps: readonly CatalogApp[];
  defaultApp: string | null;
  /** The Organization root's state; null for a Personalspace module, which
   * has no Organization documents. */
  state: OrganizationRootState | null;
  executable: boolean;
  reason?: OrganizationReason | ModuleReason;
  /** With a refused declaration: the file, relative to the module (or to the
   * Organization root for an Organization document). Never absolute. */
  file?: string;
  /** `teams-invalid` when the declared membership is not a list of slugs. */
  issues?: readonly string[];
}>;

export type CatalogTeam = Readonly<{ slug: string; displayName: string }>;

export type CatalogOrganization = Readonly<{
  /** The candidate's directory name under `organizations/`; for the
   * Personalspace group the literal `personalspace`, never the owner's
   * directory. */
  directory: string;
  /** The canonical slug; null when the root could not be read. */
  organization: string | null;
  displayName: string | null;
  state: OrganizationRootState | null;
  issues: readonly string[];
  executable: boolean;
  reason?: OrganizationReason | PersonalspaceReason;
  /** With a refused Organization document: its file, relative to the
   * Organization root. */
  file?: string;
  teams: readonly CatalogTeam[];
  modules: readonly CatalogModule[];
}>;

export type Catalog = Readonly<{
  kind: "catalog";
  organizations: readonly CatalogOrganization[];
  /** The Personalspace group (launchpad-parity B11), in the shape of an
   * Organization named `personalspace`: only on a preset that has a
   * Personalspace, and only when `personalspace/` holds an owner directory.
   * Kept apart from `organizations` so that no reader of Organizations (the
   * Doctor, `organization list`) ever lists its modules by accident. */
  personalspace?: CatalogOrganization;
}>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);
const teamSlug = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

// Declared Teams of the canonical manifest, in declaration order. The parser
// already validated them; anything else is skipped rather than guessed.
function declaredTeams(canonical: Data): CatalogTeam[] {
  if (!Array.isArray(canonical.teams)) return [];
  return canonical.teams.flatMap((team: unknown) =>
    isRecord(team) &&
    typeof team.slug === "string" &&
    typeof team.display_name === "string"
      ? [Object.freeze({ slug: team.slug, displayName: team.display_name })]
      : [],
  );
}

// Team membership of one slot, resolved as the resident's read model does
// (`organizationSlotTeams`, legacy root `lazurio/core/organization-slot-scope-lib.mjs`):
// the canonical `teams` array; without it the legacy alias, the `workspaces`
// array, then the singular `workspace`; blank, non-text and `productionspace`
// entries are dropped, and nothing left means the default Team. Display only:
// a value that is not a list of Team slugs is reported on the module
// (`teams-invalid`), never guessed and never blocks it.
function slotTeams(slot: unknown): {
  teams: string[];
  source: TeamsSource;
  invalid: boolean;
} {
  const value = isRecord(slot) ? slot : {};
  const canonical = Array.isArray(value.teams);
  const plural = !canonical && Array.isArray(value.workspaces);
  const declared: unknown[] = canonical
    ? (value.teams as unknown[])
    : plural
      ? (value.workspaces as unknown[])
      : value.workspace === undefined
        ? []
        : [value.workspace];
  const teams = [
    ...new Set(
      declared.flatMap((team) =>
        typeof team === "string" &&
        team.trim() !== "" &&
        team.trim() !== "productionspace"
          ? [team.trim()]
          : [],
      ),
    ),
  ];
  const invalid =
    (value.teams !== undefined && !canonical) ||
    (!canonical &&
      value.workspaces !== undefined &&
      !Array.isArray(value.workspaces)) ||
    declared.some(
      (team) =>
        typeof team !== "string" ||
        !teamSlug.test(team) ||
        team === "productionspace",
    );
  return teams.length === 0
    ? { teams: [defaultTeam], source: "default", invalid }
    : { teams, source: canonical ? "teams" : "legacy-alias", invalid };
}

// Whether the default app's preparation can run as far as is known without
// running anything (decision F25): the preparation in effect, its owner's
// package, Bun and lockfile, its own local dependencies and declared
// scripts. The install inputs' contents are the start's to refuse (decision
// F23 point 6). Never throws.
async function preparationReason(
  moduleDirectory: string,
  app: string,
  organizationDirectory: string,
): Promise<Readonly<{ reason?: ModuleReason; file?: string }>> {
  try {
    await inspectPreparationShape(moduleDirectory, app, organizationDirectory);
    return {};
  } catch (error) {
    // Named relative to the module, else to the Organization root, as the
    // start names them (a dependency may lie in the Organization's root
    // repository, decision F25).
    const bases = [moduleDirectory, organizationDirectory];
    return (
      preparationRefusal(error, bases) ??
      checkoutRefusal(error, bases) ?? {
        reason: "module-unavailable",
      }
    );
  }
}

// Whether a module's own declaration admits a start of its default app: the
// reader's kind, then a default app that is declared with a valid runtime,
// then its preparation. A refused declaration keeps its rule and file
// (decision F23).
async function moduleReason(
  observed: Readonly<{ kind: ModuleReason | "module-observed"; file?: string }>,
  defaultApp: string | null,
  apps: readonly CatalogApp[],
  moduleDirectory: string,
  organizationDirectory: string,
): Promise<Readonly<{ reason?: ModuleReason; file?: string }>> {
  if (observed.kind !== "module-observed")
    return observed.file === undefined
      ? { reason: observed.kind }
      : { reason: observed.kind, file: observed.file };
  if (defaultApp === null) return { reason: "no-app" };
  const app = apps.find((entry) => entry.package === defaultApp);
  if (app?.kind === "runtime-declared")
    return preparationReason(
      moduleDirectory,
      defaultApp,
      organizationDirectory,
    );
  return app?.reason !== undefined && app.file !== undefined
    ? { reason: app.reason, file: app.file }
    : { reason: "default-app-invalid" };
}

// An app of the catalog: its package, its kind and, when its declaration was
// refused, the rule and file (decision F23).
const catalogApp = (app: CatalogApp): CatalogApp =>
  Object.freeze({
    package: app.package,
    kind: app.kind,
    ...(app.reason === undefined || app.file === undefined
      ? {}
      : { reason: app.reason, file: app.file }),
  });

function failed(
  directory: string,
  reason: OrganizationReason,
  resolution?: Readonly<{
    state: OrganizationRootState;
    issues: readonly string[];
  }>,
  file?: string,
): CatalogOrganization {
  return Object.freeze({
    directory,
    organization: null,
    displayName: null,
    state: resolution?.state ?? null,
    issues: Object.freeze([...(resolution?.issues ?? [])]),
    executable: false,
    reason,
    ...(file === undefined ? {} : { file }),
    teams: Object.freeze([]),
    modules: Object.freeze([]),
  });
}

/** One candidate directory, resolved read-only. Never throws. */
export async function readCatalogOrganization(
  directory: string,
  name: string,
): Promise<CatalogOrganization> {
  const { result, documents } = await observeOrganizationApplications(
    directory,
  ).catch(() => ({
    result: { kind: "unavailable" as const },
    documents: null,
  }));
  if (result.kind !== "applications-observed" || documents === null) {
    if (
      result.kind === "unavailable" ||
      result.kind === "applications-observed"
    )
      return failed(name, "organization-unavailable");
    if (result.kind === "organization-changed")
      return failed(name, "organization-changed");
    if (result.kind === "checkout-refused")
      return failed(
        name,
        result.refused.reason,
        undefined,
        result.refused.file,
      );
    if (result.kind === "organization-conflict" && "refused" in result)
      return failed(
        name,
        result.refused.reason,
        result.resolution,
        result.refused.file,
      );
    return failed(name, result.kind, result.resolution);
  }
  const canonical = documents.canonical as Data;
  const organization = canonical.organization as Data;
  const slots = Array.isArray(documents.modules.module_slots)
    ? (documents.modules.module_slots as unknown[])
    : [];
  const bySlotPath = new Map<string, unknown>();
  for (const slot of slots)
    if (isRecord(slot) && typeof slot.path === "string")
      if (!bySlotPath.has(slot.path))
        // A duplicated path is a declaration conflict already; the first wins
        // for display only.
        bySlotPath.set(slot.path, slot);
  const executable = result.admission === "executable";
  const state = result.resolution.state;
  const modules = (
    await Promise.all(
      result.entries.map(async (entry) => {
        if (entry.module === null) return [];
        const { teams, source, invalid } = slotTeams(
          bySlotPath.get(entry.path),
        );
        const apps =
          entry.kind === "module-observed" ? entry.apps.map(catalogApp) : [];
        const defaultApp =
          entry.kind === "module-observed" ? entry.defaultApp : null;
        // The Organization's gate comes first: it applies before any module,
        // and its modules' preparation is not inspected.
        const own = executable
          ? await moduleReason(
              entry,
              defaultApp,
              apps,
              join(directory, entry.path),
              directory,
            )
          : {};
        const reason = executable ? own.reason : "organization-not-executable";
        const file = executable ? own.file : undefined;
        return [
          Object.freeze({
            organization: result.company,
            module: entry.module,
            path: entry.path,
            teams: Object.freeze(teams),
            teamsSource: source,
            apps: Object.freeze(apps),
            defaultApp,
            state,
            executable: reason === undefined,
            ...(reason === undefined ? {} : { reason }),
            ...(file === undefined ? {} : { file }),
            ...(invalid ? { issues: Object.freeze(["teams-invalid"]) } : {}),
          } satisfies CatalogModule),
        ];
      }),
    )
  ).flat();
  return Object.freeze({
    directory: name,
    organization: result.company,
    displayName:
      typeof organization.display_name === "string"
        ? organization.display_name
        : result.company,
    state,
    // The root's issues, then the inventory's (a slot without a usable id is
    // not a module row, but its conflict stays visible here).
    issues: Object.freeze([
      ...new Set([
        ...result.resolution.issues,
        ...result.issues.map((issue) => issue.code),
      ]),
    ]),
    executable,
    ...(executable ? {} : { reason: "organization-not-executable" as const }),
    teams: Object.freeze(declaredTeams(canonical)),
    modules: Object.freeze(modules),
  });
}

// Two candidates declaring one slug make `<Org>/<Module>` ambiguous: both stay
// listed with their modules and neither executes.
function isolateDuplicates(
  organizations: CatalogOrganization[],
): CatalogOrganization[] {
  const counts = new Map<string, number>();
  for (const entry of organizations)
    if (entry.organization !== null) {
      const key = entry.organization.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return organizations.map((entry) =>
    entry.organization === null ||
    (counts.get(entry.organization.toLowerCase()) ?? 0) < 2
      ? entry
      : Object.freeze({
          ...entry,
          executable: false,
          reason: "organization-duplicate" as const,
          modules: Object.freeze(
            entry.modules.map((module) =>
              Object.freeze({
                ...module,
                executable: false,
                reason: "organization-duplicate" as const,
              }),
            ),
          ),
        }),
  );
}

// The Personalspace group, in the shape of an Organization named
// `personalspace` (launchpad-parity B11): no Organization documents, so no
// state, Teams or issues; executable means the module's own declaration
// admits a start of its default app. Never throws.
async function readCatalogPersonalspace(
  folder: string,
): Promise<CatalogOrganization | undefined> {
  if (!(await folderHasPersonalspace(folder))) return undefined;
  const located = await locatePersonalspace(folder);
  if (located.kind === "absent") return undefined;
  const group = (
    modules: readonly CatalogModule[],
    reason?: PersonalspaceReason,
  ): CatalogOrganization =>
    Object.freeze({
      directory: personalspaceName,
      organization: personalspaceName,
      displayName: "Personalspace",
      state: null,
      issues: Object.freeze([]),
      executable: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      teams: Object.freeze([]),
      modules: Object.freeze(modules),
    });
  if (located.kind === "blocked") return group([], located.reason);
  let ids: string[];
  try {
    ids = await personalspaceModuleIds(located.directory);
  } catch {
    return group([], "personalspace-unavailable");
  }
  const modules = await Promise.all(
    ids.map(async (id): Promise<CatalogModule> => {
      const moduleDirectory = join(located.directory, "workspace", id);
      const observed = await observePersonalspaceModule(located.directory, id)
        .then((read) => read.observed)
        .catch((error: unknown) => {
          // A refused directory of the module (decision F23), by its rule.
          const refused = checkoutRefusal(error, [
            moduleDirectory,
            located.directory,
          ]);
          return refused === null
            ? { kind: "module-unavailable" as const }
            : { kind: refused.reason, file: refused.file };
        });
      const apps =
        observed.kind === "module-observed"
          ? observed.apps.map(catalogApp)
          : [];
      const defaultApp =
        observed.kind === "module-observed" ? observed.defaultApp : null;
      const { reason, file } = await moduleReason(
        observed,
        defaultApp,
        apps,
        moduleDirectory,
        located.directory,
      );
      return Object.freeze({
        organization: personalspaceName,
        module: id,
        path: `workspace/${id}`,
        teams: Object.freeze([]),
        teamsSource: "none",
        apps: Object.freeze(apps),
        defaultApp,
        state: null,
        executable: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
        ...(file === undefined ? {} : { file }),
      });
    }),
  );
  return group(modules);
}

/** The catalog of one Folder. Throws only when the Folder itself is not a
 * caller-owned, non-shared directory; a Folder without `organizations/` has
 * no Organizations, and every candidate below it fails on its own. On a
 * preset that has a Personalspace the catalog also carries its group. */
export async function readFolderCatalog(folder: string): Promise<Catalog> {
  await inspectOwnedDirectory(folder);
  const root = join(folder, "organizations");
  const present = await lstat(root).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  const personalspace = await readCatalogPersonalspace(folder);
  const withPersonalspace =
    personalspace === undefined ? {} : { personalspace };
  if (!present)
    return Object.freeze({
      kind: "catalog",
      organizations: Object.freeze([]),
      ...withPersonalspace,
    });
  // `organizations/` holds the operator's checkouts and is the operator's own
  // (decision F23); the Folder above keeps the strict rule.
  await inspectCheckoutDirectory(root);
  const names = (await readdir(root, { withFileTypes: true }))
    // A directory, or a link that may name one (the reader refuses links and
    // so isolates it); files are not candidates. Hidden entries are not
    // candidates, as the resident's glob `organizations/*` never matched them;
    // `.cache`, `.git` and editor folders are the normal case.
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const organizations = await Promise.all(
    names.map((name) => readCatalogOrganization(join(root, name), name)),
  );
  return Object.freeze({
    kind: "catalog",
    organizations: Object.freeze(isolateDuplicates(organizations)),
    ...withPersonalspace,
  });
}

/** Every module of the catalog, the Personalspace's last, optionally of one
 * Organization or of the Personalspace group. */
export function catalogModules(
  catalog: Catalog,
  organization?: CatalogOrganization,
): readonly CatalogModule[] {
  return (organization ? [organization] : catalogGroups(catalog)).flatMap(
    (entry) => entry.modules,
  );
}

/** The Organization a person names, under the one rule the Launchpad's routes
 * share (`selectCatalogOrganization`): its slug (case-insensitive, as GitHub),
 * otherwise its directory name exactly; undefined when neither matches or the
 * slug is ambiguous. */
export function findCatalogOrganization(
  catalog: Catalog,
  name: string,
): CatalogOrganization | undefined {
  const selection = selectCatalogOrganization(catalog, name);
  return selection.kind === "found" ? selection.organization : undefined;
}
