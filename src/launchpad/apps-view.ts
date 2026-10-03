import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
} from "../organizations/catalog";
import { catalogOrganizationKey } from "../organizations/catalog-selection";
import { initialsOf } from "../shell/view";
import {
  type CatalogGroupEntry,
  type CatalogModuleEntry,
  type CatalogSectionLayout,
  catalogSelection,
  catalogTree,
  moduleRoute,
} from "./catalog-view";
import type { PublicEntry } from "./chat";
import { moduleOrigin } from "./hosted-entry";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Apps home and its left column (decision F36, the
// target shell's "Apps home"): one Organization at a time, its name on top
// (a picker when the Folder holds several), its modules and read-only
// repositories in the sections Organizace, Workspace and Productionspace of
// decision F32's addendum, each a pill with a count over a grid of tiles. A
// tile opens the module's app in a new tab; a module that has no app or
// cannot start opens its overview. The DOM lives in catalog-panel.ts.

/** The groups the Apps home offers (Organizations, then the Personalspace
 * group), in the catalog's order. */
export const appsScopes = (
  catalog: Catalog,
  copy: Copy,
): readonly CatalogGroupEntry[] => catalogTree(catalog, copy);

/** The group a route shows: the one an Organization or module route names,
 * otherwise the first. Null when the Folder has none, or when the route names
 * one that is not there (or is ambiguous). */
export function appsScope(
  catalog: Catalog,
  route: PageRoute,
  copy: Copy,
): CatalogGroupEntry | null {
  const groups = appsScopes(catalog, copy);
  const selection = catalogSelection(catalog, route);
  if (selection.kind === "organization" || selection.kind === "module")
    return (
      groups.find((group) => group.organization === selection.organization) ??
      null
    );
  if (selection.kind === "overview") return groups[0] ?? null;
  return null;
}

/** Where a module's tile leads. */
export type TileTarget =
  /** The module's own origin behind the gateway, in a new tab; the gateway
   * starts the app on open (`ensure`). */
  | Readonly<{ kind: "hosted"; href: string }>
  /** A workstation: start the app through the lifecycle, then open the link
   * it reports in a new tab. `start` is the request path. */
  | Readonly<{ kind: "start"; start: string; status: string; overview: string }>
  /** No app, or one that cannot start: the module's overview. */
  | Readonly<{ kind: "overview"; href: string }>
  /** Two candidates share the Organization's slug: nothing to link to. */
  | Readonly<{ kind: "none" }>;

/** The target of one module's tile. `entry` is the recorded hosted entry
 * (null on a workstation). */
export function tileTarget(
  catalog: Catalog,
  organization: CatalogOrganization,
  module: CatalogModule,
  entry: PublicEntry | null,
): TileTarget {
  const overview = moduleRoute(catalog, organization, module);
  const key = catalogOrganizationKey(catalog, organization);
  if (overview === null || key === null) return { kind: "none" };
  if (
    module.defaultApp === null ||
    !module.executable ||
    module.preparationRefused === true
  )
    return { kind: "overview", href: overview };
  if (entry !== null) {
    try {
      return {
        kind: "hosted",
        href: `${moduleOrigin(entry.moduleOriginTemplate, module.module)}/`,
      };
    } catch {
      return { kind: "overview", href: overview };
    }
  }
  const base = `/api/modules/${encodeURIComponent(key)}/${encodeURIComponent(module.module)}`;
  return {
    kind: "start",
    start: `${base}/start`,
    status: `${base}/status`,
    overview,
  };
}

/** The directory of an app, as its package names it (`app/v1/package.json`
 * is `app/v1`); the module's own directory is `.`. */
export const appDirectory = (app: string): string =>
  app.replace(/(^|\/)package\.json$/, "") || ".";

/** The Czech plural of a count (1, 2–4, 5 and more); English has two. */
export function pluralKey(
  count: number,
  keys: Readonly<{ one: MessageKey; few: MessageKey; many: MessageKey }>,
): MessageKey {
  if (count === 1) return keys.one;
  if (count >= 2 && count <= 4) return keys.few;
  return keys.many;
}

export type AppsTile =
  | Readonly<{
      kind: "module";
      entry: CatalogModuleEntry;
      name: string;
      description: string;
      mark: string;
      /** The exception the tile reports, or null: status only by
       * exception (the design system's `lz-status--plain`). */
      note: Readonly<{ tone: "warn"; text: string; title: string }> | null;
      target: TileTarget;
    }>
  | Readonly<{
      kind: "repository";
      repository: CatalogRepository;
      name: string;
      description: string;
      mark: string;
      note: Readonly<{ tone: "muted"; text: string; title: string }> | null;
      /** Its GitHub page, in a new tab, or null. */
      href: string | null;
    }>;

export type AppsSection = Readonly<{
  layout: CatalogSectionLayout | "personal";
  title: string;
  count: string;
  subtitle: string | null;
  tiles: readonly AppsTile[];
}>;

const countKeys = {
  modules: {
    one: "appsModulesOne",
    few: "appsModulesFew",
    many: "appsModulesMany",
  },
  repositories: {
    one: "appsRepositoriesOne",
    few: "appsRepositoriesFew",
    many: "appsRepositoriesMany",
  },
} as const;

/** The sections of one group, in order, each with what it holds; empty
 * sections are left out. The Personalspace group is one section. */
export function appsSections(
  catalog: Catalog,
  group: CatalogGroupEntry,
  copy: Copy,
  entry: PublicEntry | null,
): readonly AppsSection[] {
  const moduleTile = (item: CatalogModuleEntry): AppsTile => ({
    kind: "module",
    entry: item,
    name: item.module.module,
    description:
      item.module.defaultApp === null
        ? copy.appsNoApp
        : appDirectory(item.module.defaultApp),
    mark: initialsOf(item.module.module).slice(0, 2),
    // A module without an app is not one that cannot start: its tile says
    // "No app" and nothing more.
    note:
      item.status.state === "blocked" && item.module.reason !== "no-app"
        ? { tone: "warn", text: copy.appsCannotStart, title: item.status.text }
        : null,
    target: tileTarget(catalog, group.organization, item.module, entry),
  });
  const count = (tiles: number, kind: keyof typeof countKeys) =>
    copy[pluralKey(tiles, countKeys[kind])].replace("{count}", String(tiles));
  if (group.sections === null)
    return group.modules.length === 0
      ? []
      : [
          {
            layout: "personal",
            title: copy.appsPersonal,
            count: count(group.modules.length, "modules"),
            subtitle: null,
            tiles: group.modules.map(moduleTile),
          },
        ];
  return group.sections.map((section) => {
    const tiles: AppsTile[] = [
      ...section.modules.map(moduleTile),
      ...section.repositories.map(
        ({ repository, checkout }): AppsTile => ({
          kind: "repository",
          repository,
          name: repository.slug,
          description: repository.path,
          mark: initialsOf(repository.slug).slice(0, 2),
          note: repository.checkedOut
            ? null
            : { tone: "muted", text: checkout, title: checkout },
          href: repository.url,
        }),
      ),
    ];
    return {
      layout: section.layout,
      title: section.title,
      count: count(
        tiles.length,
        section.layout === "productionspace" ? "repositories" : "modules",
      ),
      subtitle:
        section.layout === "workspace"
          ? copy.appsWorkspaceSubtitle.replace("{name}", group.name)
          : section.layout === "productionspace"
            ? copy.appsProductionspaceSubtitle
            : null,
      tiles,
    };
  });
}

/** Whether a tile or column item matches the column's search. */
export const appsMatch = (name: string, query: string): boolean =>
  name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
