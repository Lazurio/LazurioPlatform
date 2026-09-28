import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { selectCatalogOrganization } from "./catalog-selection";
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
  /** Not a caller-owned, non-shared, stable directory, or unreadable. */
  | "organization-unavailable"
  /** Another candidate declares the same Organization slug (GitHub slugs are
   * case-insensitive): `<Org>/<Module>` would be ambiguous. */
  | "organization-duplicate";

/** Why one module cannot run, when its Organization can. */
export type ModuleReason =
  | "declaration-conflict"
  | "module-unavailable"
  | "explicit-apps-required"
  | "no-app"
  | "default-app-invalid";

export type CatalogApp = Readonly<{
  package: string;
  kind: "runtime-declared" | "invalid-runtime";
}>;

/** Where a module's Team membership comes from: the canonical
 * `module_slots[].teams`, the legacy alias (`workspaces`, then the singular
 * `workspace`) read for compatibility, or neither (the default Team). */
export type TeamsSource = "teams" | "legacy-alias" | "default";

/** The Team of a workspace module that declares none (decision 0041). */
export const defaultTeam = "workspace";

export type CatalogModule = Readonly<{
  organization: string;
  module: string;
  path: string;
  /** Team slugs, N:M, in declaration order; never empty (see `teamsSource`). */
  teams: readonly string[];
  teamsSource: TeamsSource;
  apps: readonly CatalogApp[];
  defaultApp: string | null;
  state: OrganizationRootState;
  executable: boolean;
  reason?: OrganizationReason | ModuleReason;
  /** `teams-invalid` when the declared membership is not a list of slugs. */
  issues?: readonly string[];
}>;

export type CatalogTeam = Readonly<{ slug: string; displayName: string }>;

export type CatalogOrganization = Readonly<{
  /** The candidate's directory name under `organizations/`. */
  directory: string;
  /** The canonical slug; null when the root could not be read. */
  organization: string | null;
  displayName: string | null;
  state: OrganizationRootState | null;
  issues: readonly string[];
  executable: boolean;
  reason?: OrganizationReason;
  teams: readonly CatalogTeam[];
  modules: readonly CatalogModule[];
}>;

export type Catalog = Readonly<{
  kind: "catalog";
  organizations: readonly CatalogOrganization[];
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

function failed(
  directory: string,
  reason: OrganizationReason,
  resolution?: Readonly<{
    state: OrganizationRootState;
    issues: readonly string[];
  }>,
): CatalogOrganization {
  return Object.freeze({
    directory,
    organization: null,
    displayName: null,
    state: resolution?.state ?? null,
    issues: Object.freeze([...(resolution?.issues ?? [])]),
    executable: false,
    reason,
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
  const modules = result.entries.flatMap((entry) => {
    if (entry.module === null) return [];
    const { teams, source, invalid } = slotTeams(bySlotPath.get(entry.path));
    const apps =
      entry.kind === "module-observed"
        ? entry.apps.map((app) =>
            Object.freeze({ package: app.package, kind: app.kind }),
          )
        : [];
    const defaultApp =
      entry.kind === "module-observed" ? entry.defaultApp : null;
    const own: ModuleReason | undefined =
      entry.kind !== "module-observed"
        ? entry.kind
        : defaultApp === null
          ? "no-app"
          : apps.find((app) => app.package === defaultApp)?.kind !==
              "runtime-declared"
            ? "default-app-invalid"
            : undefined;
    // The Organization's gate comes first: it applies before any module.
    const reason = executable ? own : "organization-not-executable";
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
        ...(invalid ? { issues: Object.freeze(["teams-invalid"]) } : {}),
      } satisfies CatalogModule),
    ];
  });
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

/** The catalog of one Folder. Throws only when the Folder itself is not a
 * caller-owned, non-shared directory; a Folder without `organizations/` has
 * an empty catalog, and every candidate below it fails on its own. */
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
  if (!present)
    return Object.freeze({ kind: "catalog", organizations: Object.freeze([]) });
  await inspectOwnedDirectory(root);
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
  });
}

/** Every module of the catalog, optionally of one Organization. */
export function catalogModules(
  catalog: Catalog,
  organization?: CatalogOrganization,
): readonly CatalogModule[] {
  return (organization ? [organization] : catalog.organizations).flatMap(
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
