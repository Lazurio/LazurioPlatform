import { filesUrlPath } from "../files/rules";
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
import type { SwitchTab } from "../shell/view";
import {
  type CatalogGroupEntry,
  type CatalogModuleEntry,
  type CatalogSection,
  type CatalogSectionKind,
  catalogSelection,
  catalogTree,
  moduleRoute,
} from "./catalog-view";
import type { PublicEntry } from "./chat";
import type { ContentList } from "./content-client";
import {
  favoritesFirst,
  moduleFavorite,
  repositoryFavorite,
} from "./favorites";
import { moduleOrigin } from "./hosted-entry";
import type { MessageKey } from "./messages";
import { integrationsPath, type PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// Pure presentation of the Apps home and its column (decision F36 and its
// addendum of 2026-10-04): one Organization at a time, its name on top and
// the Environment under it, its modules in the section Workspace and its
// production repositories in Productionspace (decision F32's final
// addendum), each a pill with a count over a grid of clean tiles: stone,
// name, a short description, a star when favourite. A module's tile opens its
// app (where the person's account says, app-opening.ts); one without an app,
// one that cannot start and a repository only say so in a short message. Its
// "⋯" menu stars it, leads to the module's overview (a repository's GitHub
// page) and, for the Organization's Owners and Stewards, to the module's
// access in the Dashboard. Favourites come first, in the column's order. In
// the personal space its holder sees, a quiet section of links into Chat,
// Automate, Integrace and Soubory follows everything else (root decision
// 0185's addendum of 2026-10-13). The DOM lives in catalog-panel.ts.

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
/** The space the Apps home shows, for the rail: the personal space, or the
 * Organization by its slug. An Organization the Folder cannot read has no
 * slug; it is not the personal space either, so this is null and the rail
 * takes the space from this Environment's document, its owning Organization
 * (Matěj 2026-10-05: a work Environment showed as "Osobní"). */
export const appsSpaceOf = (scope: CatalogGroupEntry): string | null =>
  scope.sections === null ? "personal" : scope.organization.organization;

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
 * sections are left out. The Personalspace group is one section,
 * "Workspace", which stays without a module where `owner` says its verified
 * holder is this Environment's GitHub account (root decision 0185's
 * addendum of 2026-10-13). An
 * Organization's Workspace stays, even without a module, where `owner` is
 * GitHub's live answer that this Environment's identity is the
 * Organization's Owner (false until it comes): "+ Nový modul" ends every
 * Workspace of an Owner, so before the first module it is its only tile
 * (#376), and the page tells no Owner to ask the Admin for access. */
export function appsSections(
  catalog: Catalog,
  group: CatalogGroupEntry,
  copy: Copy,
  entry: PublicEntry | null,
  favorites: readonly string[] = [],
  owner = false,
): readonly AppsSection[] {
  const tiles = appsTiles(catalog, group, copy, entry, favorites);
  const count = (length: number, kind: keyof typeof countKeys) =>
    length === 0 && kind === "modules"
      ? copy.appsModulesNone
      : copy[pluralKey(length, countKeys[kind])].replace(
          "{count}",
          String(length),
        );
  // The personal space's one section is its Workspace (the wireframe,
  // root decision 0185's addendum of 2026-10-13); `owner` here is its
  // verified holder, for whom it stays without a module.
  if (group.sections === null)
    return tiles.modules.length === 0 && !owner
      ? []
      : [
          {
            kind: "personal",
            title: copy.catalogSectionWorkspace,
            count: count(tiles.modules.length, "modules"),
            tiles: favoritesFirst(tiles.modules, favorites),
          },
        ];
  const sections: readonly CatalogSection[] =
    owner && !group.sections.some((section) => section.kind === "workspace")
      ? [
          {
            kind: "workspace",
            title: copy.catalogSectionWorkspace,
            modules: [],
          },
          ...group.sections,
        ]
      : group.sections;
  return sections.map(
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

/** One way into what the personal Environment does, in the app that owns it
 * (root decision 0185's addendum of 2026-10-13, the wireframe's
 * `personalStarts`, prototypes-lazurio c0fa0e92): a link, never a copy of
 * that app's interface. */
export type PersonalStart = Readonly<{
  /** Which one; the order is fixed. */
  key: "chat" | "automate" | "integrations" | "files";
  /** Its name, the words of the place it is reached from otherwise: the
   * switch's tab, the column's item. */
  name: string;
  /** What to do there; where the app does not run here, the switch's own
   * sentence why. */
  text: string;
  /** An app of the switch, whose plain click announces `lazurio-app` as its
   * tab does (ui.ts pairs the browser on the way); a route of this page, as
   * the column's item; null where the app does not run here (muted). */
  target:
    | Readonly<{ kind: "app"; app: "chat" | "automate"; href: string }>
    | Readonly<{ kind: "route"; href: string }>
    | null;
}>;

/** The starts of the personal space, in their order: Chat and Automate as
 * the switch of this Environment has them (`switchTabs`, the column head's
 * own), so a start never leads elsewhere than its tab, and is muted with
 * the tab's words where the app does not run here; Integrace and Soubory as
 * the column's items, by their routes and words. None until the switch is
 * known (the shell document is not read yet). */
export function personalStarts(
  tabs: readonly SwitchTab[],
  copy: Copy,
): readonly PersonalStart[] {
  const app = (
    key: "chat" | "automate",
    text: string,
  ): PersonalStart | null => {
    const tab = tabs.find((entry) => entry.app === key);
    if (tab === undefined) return null;
    return tab.href === null
      ? { key, name: tab.label, text: tab.missing ?? "", target: null }
      : {
          key,
          name: tab.label,
          text,
          target: { kind: "app", app: key, href: tab.href },
        };
  };
  const chat = app("chat", copy.appsStartsChat);
  const automate = app("automate", copy.appsStartsAutomate);
  if (chat === null || automate === null) return [];
  return [
    chat,
    automate,
    {
      key: "integrations",
      name: copy.integrationsTitle,
      text: copy.appsStartsIntegrations,
      target: { kind: "route", href: integrationsPath() },
    },
    {
      key: "files",
      name: copy.filesTitle,
      text: copy.appsStartsFiles,
      target: { kind: "route", href: filesUrlPath([]) },
    },
  ];
}

/** What the Apps home of one group shows under its head, the first run's
 * line and the group's status, in this order (catalog-panel.ts draws it):
 * the plain sentence of an empty space, the sections, and in the personal
 * space its holder sees, the starts after everything else, never between
 * tiles (root decision 0185's addendum of 2026-10-13). */
export type AppsHomePart =
  | Readonly<{ kind: "empty"; text: string }>
  | Readonly<{
      kind: "section";
      section: AppsSection;
      /** "+ Nový modul" as this section's last tile: the group's offer on
       * its Workspace (an Organization's or the personal one), else null. */
      offer: NewModuleOffer | null;
    }>
  | Readonly<{
      kind: "starts";
      title: string;
      starts: readonly PersonalStart[];
    }>;

export function appsHomeParts(
  catalog: Catalog,
  group: CatalogGroupEntry,
  copy: Copy,
  input: Readonly<{
    entry: PublicEntry | null;
    favorites: readonly string[];
    /** The login of the personal space's verified holder: the `present`
     * personalspace item of `GET /api/content` (#186), null or absent
     * until the page has it. */
    holder?: string | null;
    /** Whether the first run's line shows (root decision 0188): it says
     * what is next, so neither the sentence nor the starts do. */
    setup: boolean;
    /** The switch of this Environment (`switchTabs`); empty until the shell
     * document is read. */
    tabs: readonly SwitchTab[];
    /** GitHub's live answer that this Environment's identity is the
     * Organization's Owner (false until it comes): an Owner's Workspace
     * shows even before its first module (#376). */
    owner?: boolean;
  }>,
): readonly AppsHomePart[] {
  const offer = newModuleOffer(group, copy, {
    owner: input.owner ?? false,
    holder: input.holder ?? null,
  });
  // Whoever gets the offer sees the Workspace it ends, even before the
  // first module: an Organization's Owner (#376) and the personal space's
  // holder (root decision 0185's addendum of 2026-10-13).
  const sections = appsSections(
    catalog,
    group,
    copy,
    input.entry,
    input.favorites,
    offer !== null,
  );
  // A group listed with a reason says it in its status line, and the
  // catalog lists the personal space without one only where this
  // Environment's GitHub account holds it (#186).
  const quiet = group.organization.reason === undefined && !input.setup;
  const starts =
    group.sections === null && quiet ? personalStarts(input.tabs, copy) : [];
  return [
    // Plain words for an empty space (the wireframe, Matěj and Anička
    // 2026-10-04): the personal space is simply empty; in an Organization
    // the person has no module here yet and whom to ask.
    ...(sections.length === 0 && quiet
      ? [
          {
            kind: "empty" as const,
            text:
              group.sections === null
                ? copy.catalogPersonalspaceEmpty
                : copy.catalogNoModules,
          },
        ]
      : []),
    ...sections.map((section) => ({
      kind: "section" as const,
      section,
      offer:
        section.kind === "workspace" || section.kind === "personal"
          ? offer
          : null,
    })),
    ...(starts.length === 0
      ? []
      : [{ kind: "starts" as const, title: copy.appsStartsTitle, starts }]),
  ];
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

/** The head of the Apps home (F36's addendum of 2026-10-06; the wireframe's
 * `LaunchpadHome`, prototypes-lazurio 1acd615): the Organization's name, a
 * link to its Dashboard page as the shell document names it (`dashboard`,
 * looked up by the Organization slug), since the Environment picker no longer
 * leads there. The personal space ("Osobní"), the home without a group
 * ("Launchpad", in Czech "Apps") and an Organization without such a page
 * stay plain text. */
export function appsHeading(
  group: CatalogGroupEntry | null,
  copy: Copy,
  dashboard: (slug: string) => string | null,
): Readonly<{ text: string; link: { href: string; title: string } | null }> {
  if (group === null) return { text: copy.homeTitle, link: null };
  if (group.sections === null) return { text: copy.appsPersonal, link: null };
  const slug = group.organization.organization;
  const href = slug === null ? null : dashboard(slug);
  return {
    text: group.name,
    link:
      href === null ? null : { href, title: copy.appsOrganizationDashboard },
  };
}

/** "Přístup k modulu" (root decision 0185 S15, issue #151): the module in
 * its Organization's Dashboard, Nastavení Organizace → Moduly → the module
 * (`<Organization page>/settings?tab=modules&module=<id>`), opened in this
 * window. `dashboard` is the Organization's page as the shell document names
 * it (`https://…/orgs/<slug>`); anything else has no such page, and the menu
 * offers no item (fail closed). */
export function moduleAccessUrl(
  dashboard: string | null,
  module: string,
): string | null {
  if (dashboard === null) return null;
  let url: URL;
  try {
    url = new URL(dashboard);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/orgs\/[a-z0-9-]+$/.test(url.pathname)
  )
    return null;
  url.pathname = `${url.pathname}/settings`;
  url.searchParams.set("tab", "modules");
  url.searchParams.set("module", module);
  return url.href;
}

/** Where a tile's "Přístup k modulu" leads, or null when the menu offers
 * none: only a module of an Organization bound to a GitHub login (never a
 * production repository or the Personalspace group), only for its Owners and
 * Stewards (`owner`, `maintainer`: GitHub's live answers, false until they
 * come), and only where the shell document names the Organization's
 * Dashboard page. `dashboard` looks that page up by the Organization slug. */
export function moduleAccessTarget(
  tile: AppsTile,
  group: CatalogGroupEntry,
  dashboard: (slug: string) => string | null,
  roles: Readonly<{ owner: boolean; maintainer: boolean }>,
): string | null {
  const slug = group.organization.organization;
  if (
    tile.kind !== "module" ||
    group.sections === null ||
    slug === null ||
    group.organization.forgeLogin === undefined ||
    !(roles.owner || roles.maintainer)
  )
    return null;
  return moduleAccessUrl(dashboard(slug), tile.entry.module.module);
}

/** The prompt "+ Nový modul" hands to Chat (the wireframe's `moduleBrief`,
 * F36 addendum of 2026-10-14): the person's own words "Chci postavit nový
 * modul do Workspace Lazuria.", the Organization it goes to, and the Folder's
 * skill `new-module`, which holds everything else: what a module is, the
 * interview about its purpose, the technical choices, the plan to confirm
 * and the steps. The brief carries no procedure of its own. */
export const newModulePrompt = (
  name: string,
  login: string,
  copy: Copy,
): string =>
  copy.appsNewModulePrompt
    .replaceAll("{name}", name)
    .replaceAll("{login}", login);

/** The prompt "+ Nový modul" hands to Chat in the personal space (the
 * wireframe's `moduleBrief`, root decision 0185's addendum of 2026-10-13,
 * F36 addendum of 2026-10-14): the same opening, the personal space as a
 * private repository on the person's account, and the skill `new-module`,
 * which holds the steps of `lazurio module create personalspace/<slug>`
 * (decision F52). In Czech it is the person's own words to the agent, so in
 * tykání (root decision 0199). */
export const newPersonalModulePrompt = (login: string, copy: Copy): string =>
  copy.appsNewPersonalModulePrompt.replaceAll("{login}", login);

const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** The login of the personal space's verified holder in the content
 * routes' answer (`GET /api/content`): its personalspace item when it is
 * `present`, which the content core says only where this Environment's
 * GitHub account holds it (#186); null otherwise and before the answer. */
export function personalHolderOf(list: ContentList | null): string | null {
  const item = list?.items.find((entry) => entry.kind === "personalspace");
  return item?.kind === "personalspace" &&
    item.state === "present" &&
    item.login !== null &&
    githubLogin.test(item.login)
    ? item.login
    : null;
}

/** What "+ Nový modul" hands to Chat (ui.ts `handOver`): the prompt's id
 * and the GitHub login its link names, and its text for the clipboard. */
export type NewModuleOffer = Readonly<{
  id: "new-module" | "new-personal-module";
  organization: string;
  text: string;
}>;

/** Who gets "+ Nový modul" in a group, and with which prompt: in an
 * Organization bound to a GitHub login, an identity GitHub's live answer
 * says is its Owner (`owner`, F36's Organization-rail addendum, point 8),
 * the prompt `new-module`; in the personal space listed without a reason,
 * its verified holder (`holder`, the login of the `present` personalspace
 * item, #186), the prompt `new-personal-module`. Everyone else: null. The
 * prompt route decides again on every request, so a tile drawn from an
 * answer that has since changed opens nothing it should not. */
export function newModuleOffer(
  group: CatalogGroupEntry,
  copy: Copy,
  input: Readonly<{ owner: boolean; holder: string | null }>,
): NewModuleOffer | null {
  if (group.sections === null)
    return group.organization.reason === undefined &&
      input.holder !== null &&
      githubLogin.test(input.holder)
      ? {
          id: "new-personal-module",
          organization: input.holder,
          text: newPersonalModulePrompt(input.holder, copy),
        }
      : null;
  const login = group.organization.forgeLogin;
  return input.owner && login !== undefined
    ? {
        id: "new-module",
        organization: login,
        text: newModulePrompt(group.name, login, copy),
      }
    : null;
}
