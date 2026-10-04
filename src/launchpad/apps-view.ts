import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
} from "../organizations/catalog";
import { catalogOrganizationKey } from "../organizations/catalog-selection";
import {
  appBaseTitle,
  type StoneKey,
  semanticAppIconKey,
  stoneOf,
} from "../shell/stones";
import {
  type CatalogGroupEntry,
  type CatalogModuleEntry,
  type CatalogSectionKind,
  catalogSelection,
  catalogTree,
  moduleRoute,
} from "./catalog-view";
import type { PublicEntry } from "./chat";
import {
  favoritesFirst,
  moduleFavorite,
  repositoryFavorite,
} from "./favorites";
import { moduleOrigin } from "./hosted-entry";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Apps home and its column (decision F36 and its
// addendum of 2026-10-04): one Organization at a time, its name on top and
// the Environment under it, its modules in the section Workspace and its
// production repositories in Productionspace (decision F32's final
// addendum), each a pill with a count over a grid of clean tiles: stone,
// name, a short description, a star when favourite. A module's tile opens its
// app in a new tab; one without an app, one that cannot start and a
// repository only say so in a short message. Its "⋯" menu stars it and leads
// to the module's overview (a repository's GitHub page). Favourites come
// first, in the column's order. The DOM lives in catalog-panel.ts.

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

/** The name a module is shown under: its default app's title without a
 * trailing version (the root Launchpad's `appBaseTitle`), otherwise its id. */
export const moduleName = (module: CatalogModule): string =>
  module.display === undefined
    ? module.module
    : appBaseTitle(module.display.title);

/** A module's stone, by the generic semantic key of its default app (its
 * declared `icon`, else the org-agnostic fallback from the module id, the
 * app id and the tags); never by an Organization or a module's name. */
export const moduleStone = (module: CatalogModule) =>
  stoneOf(
    semanticAppIconKey({
      module: module.module,
      id: module.display?.id ?? null,
      tags: module.display?.tags ?? [],
      icon: module.display?.icon ?? null,
    }),
  );

const descriptionKeys: Readonly<Record<StoneKey, MessageKey>> = {
  control: "appsDescriptionControl",
  book: "appsDescriptionBook",
  pen: "appsDescriptionPen",
  palette: "appsDescriptionPalette",
  deal: "appsDescriptionDeal",
  warehouse: "appsDescriptionWarehouse",
  product: "appsDescriptionProduct",
  datasheet: "appsDescriptionDatasheet",
  pricebook: "appsDescriptionPricebook",
  invoice: "appsDescriptionInvoice",
  installation: "appsDescriptionInstallation",
  dashboard: "appsDescriptionDashboard",
  profitability: "appsDescriptionProfitability",
  marketing: "appsDescriptionMarketing",
  website: "appsDescriptionWebsite",
  examples: "appsDescriptionExamples",
  database: "appsDescriptionDatabase",
  app: "appsDescriptionApp",
  system: "appsDescriptionSystem",
};

/** A module's one line: its app's declared description, otherwise the
 * org-agnostic sentence of its stone's key; "No app" without an app. */
export function moduleDescription(module: CatalogModule, copy: Copy): string {
  if (module.defaultApp === null) return copy.appsNoApp;
  const declared = module.display?.description?.trim();
  if (declared) return declared;
  const key = descriptionKeys[moduleStone(module).key];
  return key === undefined
    ? copy.appsDescriptionDefault.replace("{module}", moduleName(module))
    : copy[key];
}

/** The Czech plural of a count (1, 2–4, 5 and more); English has two. */
export function pluralKey(
  count: number,
  keys: Readonly<{ one: MessageKey; few: MessageKey; many: MessageKey }>,
): MessageKey {
  if (count === 1) return keys.one;
  if (count >= 2 && count <= 4) return keys.few;
  return keys.many;
}

/** What a click on a tile does: open the module's app (hosted on its own
 * origin, locally through the lifecycle), or say in a short message why
 * there is nothing to open. */
export type TileAction =
  | Readonly<{
      kind: "open";
      target: Extract<TileTarget, { kind: "hosted" } | { kind: "start" }>;
    }>
  | Readonly<{ kind: "say"; text: string }>;

export type AppsTile =
  | Readonly<{
      kind: "module";
      /** Its favourite key (`m:<id>`). */
      key: string;
      entry: CatalogModuleEntry;
      name: string;
      description: string;
      /** Its Lazurio stone (decision F36). */
      stone: Readonly<{ key: StoneKey; src: string; accent: string }>;
      action: TileAction;
      /** The module's overview, from its menu ("Informace o modulu"). */
      info: string | null;
      favorite: boolean;
    }>
  /** A production repository: read-only, no app, no page of its own
   * (decision F32's final addendum); its menu leads to its GitHub page. */
  | Readonly<{
      kind: "repository";
      key: string;
      repository: CatalogRepository;
      name: string;
      description: string;
      action: TileAction;
      info: string | null;
      favorite: boolean;
    }>;

export type AppsSection = Readonly<{
  kind: CatalogSectionKind | "personal";
  title: string;
  count: string;
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

/** What a click on a module's tile does. */
export function moduleAction(
  target: TileTarget,
  module: CatalogModule,
  copy: Copy,
): TileAction {
  if (target.kind === "hosted" || target.kind === "start")
    return { kind: "open", target };
  return {
    kind: "say",
    text: (module.defaultApp === null
      ? copy.appsSayNoApp
      : copy.appsSayCannotStart
    ).replace("{name}", moduleName(module)),
  };
}

/** Every tile of one group, in the catalog's order: its modules, then its
 * production repositories. */
export function appsTiles(
  catalog: Catalog,
  group: CatalogGroupEntry,
  copy: Copy,
  entry: PublicEntry | null,
  favorites: readonly string[],
): Readonly<{
  modules: readonly AppsTile[];
  repositories: readonly AppsTile[];
}> {
  const moduleTile = (item: CatalogModuleEntry): AppsTile => {
    const target = tileTarget(catalog, group.organization, item.module, entry);
    const key = moduleFavorite(item.module.module);
    return {
      kind: "module",
      key,
      entry: item,
      name: moduleName(item.module),
      description: moduleDescription(item.module, copy),
      stone: moduleStone(item.module),
      action: moduleAction(target, item.module, copy),
      info: item.href,
      favorite: favorites.includes(key),
    };
  };
  const modules =
    group.sections === null
      ? group.modules
      : group.sections.flatMap((section) =>
          section.kind === "workspace" ? section.modules : [],
        );
  const repositories =
    group.sections === null
      ? []
      : group.sections.flatMap((section) =>
          section.kind === "productionspace" ? section.repositories : [],
        );
  return {
    modules: modules.map(moduleTile),
    repositories: repositories.map(({ repository }): AppsTile => {
      const key = repositoryFavorite(repository.slug);
      return {
        kind: "repository",
        key,
        repository,
        name: repository.slug,
        description: repository.path,
        action: {
          kind: "say",
          text: copy.appsSayRepository.replace("{name}", repository.slug),
        },
        info: repository.url,
        favorite: favorites.includes(key),
      };
    }),
  };
}

/** The sections of one group, in order, favourites first in each; empty
 * sections are left out. The Personalspace group is one section. */
export function appsSections(
  catalog: Catalog,
  group: CatalogGroupEntry,
  copy: Copy,
  entry: PublicEntry | null,
  favorites: readonly string[] = [],
): readonly AppsSection[] {
  const tiles = appsTiles(catalog, group, copy, entry, favorites);
  const count = (length: number, kind: keyof typeof countKeys) =>
    copy[pluralKey(length, countKeys[kind])].replace("{count}", String(length));
  if (group.sections === null)
    return tiles.modules.length === 0
      ? []
      : [
          {
            kind: "personal",
            title: copy.appsPersonal,
            count: count(tiles.modules.length, "modules"),
            tiles: favoritesFirst(tiles.modules, favorites),
          },
        ];
  return group.sections.map(
    (section): AppsSection =>
      section.kind === "workspace"
        ? {
            kind: section.kind,
            title: section.title,
            count: count(tiles.modules.length, "modules"),
            tiles: favoritesFirst(tiles.modules, favorites),
          }
        : {
            kind: section.kind,
            title: section.title,
            count: count(tiles.repositories.length, "repositories"),
            tiles: favoritesFirst(tiles.repositories, favorites),
          },
  );
}

/** The favourites of the Apps column, in their order, only those this
 * Environment's catalog has. */
export function favoriteTiles(
  catalog: Catalog,
  group: CatalogGroupEntry,
  copy: Copy,
  entry: PublicEntry | null,
  favorites: readonly string[],
): readonly AppsTile[] {
  const tiles = appsTiles(catalog, group, copy, entry, favorites);
  return favoritesFirst(
    [...tiles.modules, ...tiles.repositories],
    favorites,
  ).filter((tile) => tile.favorite);
}

/** The prompt "+ Nový modul" hands to Chat (the wireframe's
 * `newModulePrompt`): the agent first asks what the module is for, then
 * founds it by the Lazurio Module Standard with the scaffold, never by
 * hand, and hands it over as a pull request. */
export const newModulePrompt = (
  name: string,
  login: string,
  copy: Copy,
): string =>
  copy.appsNewModulePrompt
    .replaceAll("{name}", name)
    .replaceAll("{login}", login);
