import { filesUrlPath } from "../files/rules";
import type {
  Catalog,
  CatalogGuestModule,
  CatalogModule,
  CatalogOrganization,
  CatalogRepository,
} from "../organizations/catalog";
import { catalogOrganizationKey } from "../organizations/catalog-selection";
import {
  type AccountSharedApplication,
  dashboardSlug,
  environmentIdOf,
  isEnvironmentId,
  isShellUrl,
  type ShellEnvironment,
} from "../shell/contract";
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
  guestRoute,
  moduleRoute,
  repositoryRoute,
  servicePages,
  servicesText,
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
import { integrationsPath, type PageRoute, servicePath } from "./routes";

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
// page) and, for Organization Owners and Module Maintainers, to the
// module's access in the Dashboard. Favourites come first, in the column's order. In
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
  if (
    selection.kind === "organization" ||
    selection.kind === "module" ||
    selection.kind === "repository"
  )
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
  automation: "appsDescriptionAutomation",
  knowledge: "appsDescriptionKnowledge",
  wiki: "appsDescriptionWiki",
  guide: "appsDescriptionGuide",
  book: "appsDescriptionBook",
  presentation: "appsDescriptionPresentation",
  prototype: "appsDescriptionPrototype",
  legal: "appsDescriptionLegal",
  finance: "appsDescriptionFinance",
  export: "appsDescriptionExport",
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
 * there is nothing to open. A service repository in Služby serveru (root
 * decision 0209 point 6) opens its service's page in the Environment
 * browser, or where more than one of its services has a page, its own page
 * to choose from. */
export type TileAction =
  | Readonly<{
      kind: "open";
      target: Extract<TileTarget, { kind: "hosted" } | { kind: "start" }>;
    }>
  | Readonly<{ kind: "say"; text: string }>
  /** The page of the service `service`; `href` its link (`servicePath`),
   * which opens it in a new tab of the person's browser as well. */
  | Readonly<{ kind: "service"; service: string; href: string }>
  /** A route of this page: a service repository's page. */
  | Readonly<{ kind: "route"; href: string }>;

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
   * (decision F32's final addendum); its menu leads to its GitHub page. A
   * service repository of Služby serveru (root decision 0209 point 6) says
   * what its services are and opens its service's page; its menu leads to
   * its own page, a route of this page (`info` then starts with `/`). */
  | Readonly<{
      kind: "repository";
      key: string;
      repository: CatalogRepository;
      name: string;
      description: string;
      action: TileAction;
      info: string | null;
      favorite: boolean;
    }>
  /** A guest Module of another Organization (decision F67's addendum of
   * 2026-11-01): drawn like a module, never opened or started here; a click
   * says so, and its menu leads to its GitHub page. No favourite: the
   * person's favourites are the Organization's own. */
  | Readonly<{
      kind: "guest";
      key: string;
      guest: CatalogGuestModule;
      name: string;
      description: string;
      stone: Readonly<{ key: StoneKey; src: string; accent: string }>;
      action: TileAction;
      info: string | null;
      favorite: false;
    }>;

export type AppsSection = Readonly<{
  kind: CatalogSectionKind | "personal";
  title: string;
  /** A quiet badge beside the flag with its explanation as a tooltip: the
   * guest section's "hostující" (decision F67's addendum of 2026-11-01);
   * null for every other section. */
  badge: Readonly<{ text: string; hint: string }> | null;
  count: string;
  tiles: readonly AppsTile[];
  /** Workspace's tabs, each with its tiles, favourites first (decision F32's
   * addendum of 2026-10-16); null where the Organization shows none. */
  tabs: readonly AppsTab[] | null;
}>;

/** One tab of an Organization's Workspace, as Apps draws it. */
export type AppsTab = Readonly<{ name: string; tiles: readonly AppsTile[] }>;

/** A section's head as Apps draws it, in order (decision F32's addenda of
 * 2026-10-16 and 2026-10-19): the flag first, flush on the section's rule,
 * then the count; or, where the Workspace shows the Organization's tabs, no
 * count but the tabs' switch at the head's right end, with "Upravit karty"
 * after it where the Organization Owner is led to arrange them (`edit`, from
 * `workspaceTabsTarget`). */
export type AppsSectionHead = Readonly<{
  flag: string;
  badge: AppsSection["badge"];
  end:
    | Readonly<{ kind: "count"; count: string }>
    | Readonly<{
        kind: "tabs";
        tabs: readonly [AppsTab, ...AppsTab[]];
        edit: string | null;
      }>;
}>;

export function appsSectionHead(
  section: AppsSection,
  edit: string | null,
): AppsSectionHead {
  const [first, ...rest] = section.tabs ?? [];
  return {
    flag: section.title,
    badge: section.badge,
    end:
      first === undefined
        ? { kind: "count", count: section.count }
        : { kind: "tabs", tabs: [first, ...rest], edit },
  };
}

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
 * production repositories. The Personalspace group's only repositories are
 * those that carry this Environment's services: a Personal Environment's own
 * AI pool (root decision 0181, addendum of 2026-11-05), shown as Služby
 * serveru's are. */
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
  const personal = group.sections === null;
  const repositories =
    group.sections === null
      ? group.organization.repositories.flatMap((repository) =>
          repository.services === undefined ? [] : [{ repository }],
        )
      : group.sections.flatMap((section) =>
          section.kind === "productionspace" ? section.repositories : [],
        );
  return {
    modules: modules.map(moduleTile),
    repositories: repositories.map(({ repository }): AppsTile => {
      const key = repositoryFavorite(repository.slug);
      const services = repository.services;
      return {
        kind: "repository",
        key,
        repository,
        name: repository.slug,
        description:
          services === undefined
            ? (repository.path ?? "")
            : servicesText(services, copy, personal),
        action: repositoryAction(catalog, group, repository, copy),
        // A service repository's own page; any other's GitHub page.
        info:
          services === undefined
            ? repository.url
            : repositoryRoute(catalog, group.organization, repository),
        favorite: favorites.includes(key),
      };
    }),
  };
}

/** The stone of a Module known here by its slug alone (a guest Module, a
 * shared application): the org-agnostic fallback of its id, never an
 * Organization's or a Module's name. */
const slugStone = (module: string) =>
  stoneOf(semanticAppIconKey({ module, id: null, tags: [], icon: null }));

/** A guest Module's tile: its slot id as GitHub names the repository, the
 * org-agnostic sentence of its stone, and a click that opens its read-only
 * overview (decision F67's addendum of 2026-11-01). Its own
 * `lazurio.module.json` stays unread (decision F67 point 5). */
/** A guest Module's stone and one line, from its slot id alone: the
 * org-agnostic sentence of its stone. */
export function guestLook(
  guest: CatalogGuestModule,
  copy: Copy,
): Readonly<{
  stone: Readonly<{ key: StoneKey; src: string; accent: string }>;
  description: string;
}> {
  const stone = slugStone(guest.module);
  const key = descriptionKeys[stone.key];
  return {
    stone,
    description:
      key === undefined
        ? copy.appsDescriptionDefault.replace("{module}", guest.module)
        : copy[key],
  };
}

export function guestTile(
  catalog: Catalog,
  organization: CatalogOrganization,
  guest: CatalogGuestModule,
  copy: Copy,
): AppsTile {
  const route = guestRoute(catalog, organization, guest);
  const { stone, description } = guestLook(guest, copy);
  return {
    kind: "guest",
    key: `g:${guest.homeOrganization.toLowerCase()}/${guest.module}`,
    guest,
    name: guest.module,
    description,
    stone,
    // Its overview, a route of this page; never an app.
    action:
      route === null
        ? { kind: "say", text: copy.appsGuestApp }
        : { kind: "route", href: route },
    info: route,
    favorite: false,
  };
}

/** What a click on a repository's tile does: the one page of its services
 * opens in the Environment browser; with more than one, its own page lets
 * the person choose; anything else says that it has no app (root decision
 * 0209 point 6, decision F32's addenda). */
export function repositoryAction(
  catalog: Catalog,
  group: CatalogGroupEntry,
  repository: CatalogRepository,
  copy: Copy,
): TileAction {
  const pages = servicePages(repository);
  const [page] = pages;
  if (page !== undefined && pages.length === 1)
    return { kind: "service", service: page.id, href: servicePath(page.id) };
  const own =
    pages.length > 1
      ? repositoryRoute(catalog, group.organization, repository)
      : null;
  return own === null
    ? {
        kind: "say",
        text: copy.appsSayRepository.replace("{name}", repository.slug),
      }
    : { kind: "route", href: own };
}

/** The sections of one group, in order, favourites first in each; empty
 * sections are left out. The Personalspace group is one section,
 * "Workspace", which stays without a module where `owner` says its verified
 * holder is this Environment's GitHub account (root decision 0185's
 * addendum of 2026-10-13) or where it carries a Personal Environment's own
 * AI pool, whose repository tile follows its modules (root decision 0181,
 * addendum of 2026-11-05). An
 * Organization's Workspace stays, even without a module, where `owner` is
 * GitHub's live answer that this Environment's identity is an
 * Organization Owner (false until it comes), or an Organization Member's
 * muted offer:
 * "+ Nový modul" ends every Workspace of theirs, so before the first module
 * it is its only tile (#376), and the page tells no Organization Owner to ask the Organization Admin
 * for access. */
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
    return tiles.modules.length === 0 &&
      tiles.repositories.length === 0 &&
      !owner
      ? []
      : [
          {
            kind: "personal",
            title: copy.catalogSectionWorkspace,
            badge: null,
            count: count(tiles.modules.length, "modules"),
            tiles: favoritesFirst(
              [...tiles.modules, ...tiles.repositories],
              favorites,
            ),
            tabs: null,
          },
        ];
  const sections: readonly CatalogSection[] =
    owner && !group.sections.some((section) => section.kind === "workspace")
      ? [
          {
            kind: "workspace",
            title: copy.catalogSectionWorkspace,
            modules: [],
            tabs: null,
          },
          ...group.sections,
        ]
      : group.sections;
  return sections.map(
    (section): AppsSection =>
      section.kind === "guest"
        ? {
            kind: section.kind,
            title: section.title,
            badge: { text: copy.appsGuestBadge, hint: copy.appsGuestHint },
            count: count(section.guests.length, "modules"),
            tiles: section.guests.map((guest) =>
              guestTile(catalog, group.organization, guest, copy),
            ),
            tabs: null,
          }
        : section.kind === "workspace"
          ? {
              kind: section.kind,
              title: section.title,
              badge: null,
              count: count(tiles.modules.length, "modules"),
              tiles: favoritesFirst(tiles.modules, favorites),
              tabs:
                section.tabs === null
                  ? null
                  : section.tabs.map((tab) => ({
                      name: tab.name,
                      tiles: favoritesFirst(
                        tiles.modules.filter(
                          (tile) =>
                            tile.kind === "module" &&
                            tab.modules.includes(tile.entry),
                        ),
                        favorites,
                      ),
                    })),
            }
          : {
              kind: section.kind,
              title: section.title,
              badge: null,
              count: count(tiles.repositories.length, "repositories"),
              tiles: favoritesFirst(tiles.repositories, favorites),
              tabs: null,
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
 * the plain sentence of an empty space, the sections with the Organization's
 * shared applications right after its Workspace (before any other section
 * where it has none), and in the personal space its holder sees, the starts
 * after everything else, never between tiles (root decision 0185's addendum
 * of 2026-10-13). */
export type AppsHomePart =
  | Readonly<{ kind: "empty"; text: string }>
  | Readonly<{
      kind: "section";
      section: AppsSection;
      /** "+ Nový modul" as this section's last tile: the group's offer on
       * its Workspace (an Organization's or the personal one), else null. */
      offer: NewModuleOffer | null;
    }>
  | Readonly<{ kind: "shared"; section: AppsSharedSection }>
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
     * an Organization Owner (false until it comes): an Organization Owner's
     * Workspace
     * shows even before its first module (#376). */
    owner?: boolean;
    /** GitHub's live answer that it is an active member of the Organization
     * and no Organization Owner (false until it comes): its Workspace ends
     * with the
     * muted tile (F36's addendum of 2026-11-05). */
    member?: boolean;
    /** The group's shared applications (`sharedApplicationsSection`): null
     * or absent while the account is not read, cannot be read or shares
     * nothing here, so the home then says nothing about them. */
    shared?: AppsSharedSection | null;
  }>,
): readonly AppsHomePart[] {
  const offer = newModuleOffer(group, {
    owner: input.owner ?? false,
    member: input.member ?? false,
    holder: input.holder ?? null,
  });
  // Whoever gets the offer sees the Workspace it ends, even before the first
  // module: an Organization Owner (#376), the personal space's holder (root
  // decision 0185's addendum of 2026-10-13), and an Organization Member, for
  // whom the muted
  // tile is the one way to ask for a first module.
  const sections = appsSections(
    catalog,
    group,
    copy,
    input.entry,
    input.favorites,
    offer !== null,
  );
  // A member without a module keeps the plain sentence over it: how to get
  // access stays the first thing said.
  const waiting =
    offer?.variant === "member" &&
    !sections.some(
      (section) => section.kind === "workspace" && section.tiles.length > 0,
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
    ...((sections.length === 0 || waiting) && quiet
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
    ...withShared(
      sections.map((section) => ({
        kind: "section" as const,
        section,
        offer:
          section.kind === "workspace" || section.kind === "personal"
            ? offer
            : null,
      })),
      input.shared ?? null,
    ),
    ...(starts.length === 0
      ? []
      : [{ kind: "starts" as const, title: copy.appsStartsTitle, starts }]),
  ];
}

/** The sections with the shared applications placed in them: right after
 * the Workspace, or first where there is none. */
function withShared(
  parts: readonly Extract<AppsHomePart, { kind: "section" }>[],
  shared: AppsSharedSection | null,
): readonly AppsHomePart[] {
  if (shared === null) return parts;
  const at = parts.findIndex((part) => part.section.kind === "workspace") + 1;
  return [
    ...parts.slice(0, at),
    { kind: "shared", section: shared },
    ...parts.slice(at),
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

/** Where an Organization Owner arranges its Workspace tabs (decision F32's
 * addendum of 2026-10-16): its modules in the Organization's Dashboard,
 * where the Dashboard writes the setting `workspace.tabs` with the Organization
 * Owner's own GitHub rights (root decision 0194 point 2). From a tile's menu
 * ("Přesunout do karty") with that module, from the tabs ("Upravit karty")
 * without one. Null for anyone but an Organization Owner (GitHub's live answer, false
 * until it comes), for the Personalspace group and a production repository,
 * and where the shell document names no Dashboard page. Like "Přístup k
 * modulu", it grants nothing: the Dashboard decides again. */
export function workspaceTabsTarget(
  tile: AppsTile | null,
  group: CatalogGroupEntry,
  dashboard: (slug: string) => string | null,
  owner: boolean,
): string | null {
  const slug = group.organization.organization;
  if (
    !owner ||
    group.sections === null ||
    slug === null ||
    group.organization.forgeLogin === undefined ||
    (tile !== null && tile.kind !== "module")
  )
    return null;
  const base = moduleAccessUrl(
    dashboard(slug),
    tile === null || tile.kind !== "module" ? "" : tile.entry.module.module,
  );
  if (base === null) return null;
  const url = new URL(base);
  if (tile === null) url.searchParams.delete("module");
  url.searchParams.set("focus", "workspace-tabs");
  return url.href;
}

/** Where a tile's "Přístup k modulu" leads, or null when the menu offers
 * none: only a module of an Organization bound to a GitHub login (never a
 * production repository or the Personalspace group), only for its Organization
 * Owners and Module Maintainers (`owner`, `maintainer`: GitHub's live answers, false until they
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

// --- Shared applications (decision 0231, plan LZD-0009 M6) ---------------

/** One application colleagues made available to the person, as Apps draws
 * it in "Sdílené aplikace": its name, who shares it and the person's
 * application role, opened at its origin with one click. Never a Module: no
 * menu, no favourite, no overview, no source, Chat or entry into the hosting
 * Environment. The list is display only; the hosting Environment's gateway
 * decides every request. */
export type SharedApplicationTile = Readonly<{
  /** Its origin, unique in the section. */
  key: string;
  name: string;
  /** The application's address: its origin, at its root. */
  href: string;
  /** Who shares it: "Sdílí Bob Novák". */
  host: string;
  /** The person's role by its name of decision 0234: "Admin aplikace",
   * "Uživatel aplikace". */
  role: string;
  /** The account's value of that role. */
  roleKey: AccountSharedApplication["role"];
  stone: Readonly<{ key: StoneKey; src: string; accent: string }>;
}>;

/** "Sdílené aplikace" of one Organization's Apps home: never empty. */
export type AppsSharedSection = Readonly<{
  title: string;
  count: string;
  tiles: readonly [SharedApplicationTile, ...SharedApplicationTile[]];
}>;

const sharedCountKeys = {
  one: "appsSharedOne",
  few: "appsSharedFew",
  many: "appsSharedMany",
} as const;

/** The pattern of an Organization's Dashboard page path, `/orgs/<slug>`. */
const organizationPagePath = /^\/orgs\/([a-z0-9-]+)$/;

/** The Dashboard's slug of a group's Organization: the last segment of its
 * Dashboard page as the shell document names it (`…/orgs/<slug>`), which is
 * the Dashboard's own even where it disambiguated two of a person's
 * Organizations; without such a page, the slug the Dashboard derives from
 * the manifest's (`dashboardSlug`). Null for the personal space and an
 * Organization the Folder cannot read. */
export function groupDashboardSlug(
  group: CatalogGroupEntry,
  dashboard: (slug: string) => string | null,
): string | null {
  const slug = group.organization.organization;
  if (group.sections === null || slug === null) return null;
  const page = dashboard(slug);
  if (page !== null)
    try {
      const own = organizationPagePath.exec(new URL(page).pathname)?.[1];
      if (own !== undefined) return own;
    } catch {}
  return dashboardSlug(slug);
}

/** The shared applications an Organization's Apps home lists (decision
 * 0231): those of the account's `sharedApplications` that name this
 * Organization, in the account's order, each origin once, without any of
 * this Environment's own (`current`), whose Modules are its tiles already.
 * Null, so nothing is said, while the account is unknown or invalid
 * (`shared` null), for the personal space, and where none is left: the home
 * never claims that nothing is shared. An Organization this Folder does not
 * hold lists its own in the person's Lazurio account (the Dashboard). */
export function sharedApplicationsSection(
  group: CatalogGroupEntry,
  shared: readonly AccountSharedApplication[] | null,
  copy: Copy,
  input: Readonly<{
    /** The Dashboard page of an Organization slug, as the shell document
     * names it. */
    dashboard: (slug: string) => string | null;
    /** The id of this Environment (the shell document's `current`). */
    current: string | null;
  }>,
): AppsSharedSection | null {
  const slug =
    shared === null ? null : groupDashboardSlug(group, input.dashboard);
  if (shared === null || slug === null) return null;
  const seen = new Set<string>();
  const tiles: SharedApplicationTile[] = [];
  for (const application of shared) {
    if (
      application.organization.toLowerCase() !== slug ||
      seen.has(application.url) ||
      (input.current !== null &&
        environmentIdOf(application.url) === input.current)
    )
      continue;
    seen.add(application.url);
    const who = application.host.name ?? application.host.login;
    tiles.push({
      key: application.url,
      name: application.name,
      href: `${application.url}/`,
      host:
        who === null
          ? copy.appsSharedBySomeone
          : copy.appsSharedBy.replace("{name}", () => who),
      role:
        application.role === "admin" ? copy.appsRoleAdmin : copy.appsRoleUser,
      roleKey: application.role,
      stone: slugStone(application.module),
    });
  }
  const [first, ...rest] = tiles;
  if (first === undefined) return null;
  return {
    title: copy.appsSharedTitle,
    count: copy[pluralKey(tiles.length, sharedCountKeys)].replace(
      "{count}",
      String(tiles.length),
    ),
    tiles: [first, ...rest],
  };
}

// --- Zpřístupnit kolegům (decision 0231, plan LZD-0009 M6) ----------------

/** The Dashboard's page "Zpřístupnit aplikaci" (HumanAndMachine-ai/Dashboard#499,
 * plan LZD-0009 M4), on the Dashboard's origin: a Module's application on one
 * Work Environment, by the Organization's Dashboard slug, the Environment's
 * id (the shell's `current`, the base host of its Apps address,
 * `<machine>.<org>`) and the Module's slug as Auth records it, with the
 * address back to this Launchpad as `return`. The Dashboard's route table
 * and its validation of `return` are the authority; `availabilityUrl` fills
 * this and nothing else knows it. */
export const availabilityPageTemplate =
  "/orgs/{organization}/environments/{environment}/applications/{module}?return={return}";

/** The longest `return` the Dashboard keeps (its `RETURN_MAX`); a longer one,
 * like any it refuses, leads back to the bare Launchpad. */
export const availabilityReturnMax = 256;

/** A Module's slug as Auth records it and the Dashboard's route takes it:
 * one lowercase DNS label. */
const moduleSlug = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The Dashboard's page where the Assigned User of the Work Environment
 * `environment` (its id, `<machine>.<org>`) makes the application of
 * `module` available to the Organization (decision 0231), and from which
 * `returnTo`, an address of this Launchpad, brings them back. Its origin and
 * the Organization's slug are those of `organizationPage`, the
 * Organization's Dashboard page as the shell document names it
 * (`https://…/orgs/<slug>`). Null (fail closed) for anything else: another
 * page, an Environment id or Module slug the route does not take, or a
 * `returnTo` the Dashboard would not keep (no https URL without credentials
 * and fragment, or longer than `availabilityReturnMax`). Each value is
 * encoded into its place of `availabilityPageTemplate`. */
export function availabilityUrl(
  organizationPage: string | null,
  environment: string,
  module: string,
  returnTo: string,
): string | null {
  if (
    organizationPage === null ||
    !isEnvironmentId(environment) ||
    !moduleSlug.test(module) ||
    !isShellUrl(returnTo) ||
    returnTo.length > availabilityReturnMax
  )
    return null;
  let page: URL;
  try {
    page = new URL(organizationPage);
  } catch {
    return null;
  }
  const organization = organizationPagePath.exec(page.pathname)?.[1];
  if (
    page.protocol !== "https:" ||
    page.search !== "" ||
    page.hash !== "" ||
    organization === undefined
  )
    return null;
  const values: Readonly<Record<string, string>> = {
    organization,
    environment,
    module,
    return: returnTo,
  };
  const path = availabilityPageTemplate.replace(
    /\{(organization|environment|module|return)\}/g,
    (_, name: string) => encodeURIComponent(values[name] ?? ""),
  );
  return new URL(path, page.origin).href;
}

/** This Environment as "Zpřístupnit kolegům" needs it: the current
 * Environment of the shell document. */
export type ShareHere = Pick<
  ShellEnvironment,
  "id" | "kind" | "assignee" | "organizations" | "apps"
>;

/** What "Zpřístupnit kolegům" needs besides the Module. */
export type ShareInput = Readonly<{
  here: ShareHere | null;
  /** The person at the browser: the account's login, null when unknown. */
  viewer: string | null;
  /** The Dashboard page of an Organization slug, as the shell document
   * names it. */
  dashboard: (slug: string) => string | null;
}>;

/** Where "Zpřístupnit kolegům" leads for one Module, or null where it is
 * not offered (decision 0231: only the Assigned User of a Work Environment
 * makes an application of it available). Offered only on a Work
 * Environment (`here`, kind `work`) whose Assigned User is the person at the
 * browser (`viewer`, the account's login: unknown is nobody), only for a
 * Module of an Organization this Environment holds (never the personal
 * space, a guest Module or a production repository), only for an
 * application that runs here (its tile opens it on its own origin, so never
 * a Module without an app or one that cannot start), and only where the
 * shell document names the Organization's Dashboard page. The way back is
 * short, as the Dashboard keeps it: this Launchpad's origin with `page`, the
 * Module's page here (`/o/<org>/<module>`, a path without query or
 * fragment), or the Launchpad's root where there is none or it would be
 * longer than `availabilityReturnMax`. It grants nothing: the Dashboard and
 * Auth decide again. */
export function shareTarget(
  group: CatalogGroupEntry | null,
  module: CatalogModule,
  target: TileTarget,
  page: string | null,
  input: ShareInput,
): string | null {
  const { here, viewer } = input;
  const slug = group?.organization.organization ?? null;
  if (
    group === null ||
    group.sections === null ||
    slug === null ||
    target.kind !== "hosted" ||
    here === null ||
    here.kind !== "work" ||
    here.assignee === null ||
    viewer === null ||
    here.assignee.toLowerCase() !== viewer.toLowerCase() ||
    !here.organizations.some(
      (entry) => entry.toLowerCase() === slug.toLowerCase(),
    ) ||
    !isShellUrl(here.apps.apps)
  )
    return null;
  const origin = new URL(here.apps.apps).origin;
  const own =
    page !== null && /^\/(?!\/)[^?#\\]*$/.test(page)
      ? `${origin}${page}`
      : null;
  return availabilityUrl(
    input.dashboard(slug),
    here.id,
    module.module,
    own !== null && own.length <= availabilityReturnMax ? own : `${origin}/`,
  );
}

/** "Zpřístupnit kolegům" of a tile (`shareTarget`): only a Module's tile
 * that opens its application here, back to the Module's page (`info`). */
export function tileShareTarget(
  tile: AppsTile,
  group: CatalogGroupEntry | null,
  input: ShareInput,
): string | null {
  return tile.kind === "module" && tile.action.kind === "open"
    ? shareTarget(
        group,
        tile.entry.module,
        tile.action.target,
        tile.info,
        input,
      )
    : null;
}

/** The person's description in a prompt, last and word for word: nothing in
 * it is taken for a token or a replacement pattern. */
const described = (text: string, description: string): string =>
  text.replaceAll("{description}", () => description);

/** The prompt "+ Nový modul" hands to Chat (the wireframe's `moduleBrief`,
 * F36 addendum of 2026-10-14): the person's own words "Chci postavit nový
 * modul do Workspace Lazuria.", the Organization it goes to, what they
 * described in the dialog ("Moje představa:", decision F36's addendum of
 * 2026-11-05) and the Folder's skill `new-module`, which holds everything
 * else: what a module is, the interview about its purpose, the technical
 * choices, the plan to confirm and the steps. The brief carries no procedure
 * of its own. */
export const newModulePrompt = (
  name: string,
  login: string,
  copy: Copy,
  description: string | null = null,
): string =>
  described(
    (description === null
      ? copy.appsNewModulePrompt
      : copy.appsNewModulePromptDescribed
    )
      .replaceAll("{name}", name)
      .replaceAll("{login}", login),
    description ?? "",
  );

/** The prompt of an Organization Member's "+ Nový modul" (decision F36's addendum of
 * 2026-11-05): the Organization Admin founds a module, so the agent prepares a request to
 * the Organization Admin with the Folder's skill `admin-request` and sends it only with
 * the person's consent. */
export const newModuleRequestPrompt = (
  name: string,
  login: string,
  copy: Copy,
  description: string | null = null,
): string =>
  described(
    (description === null
      ? copy.appsNewModuleRequestPrompt
      : copy.appsNewModuleRequestPromptDescribed
    )
      .replaceAll("{name}", name)
      .replaceAll("{login}", login),
    description ?? "",
  );

/** The prompt "+ Nový modul" hands to Chat in the personal space (the
 * wireframe's `moduleBrief`, root decision 0185's addendum of 2026-10-13,
 * F36 addendum of 2026-10-14): the same opening, the personal space as a
 * private repository on the person's account, and the skill `new-module`,
 * which holds the steps of `lazurio module create personalspace/<slug>`
 * (decision F52). In Czech it is the person's own words to the agent, so in
 * tykání (root decision 0199). */
export const newPersonalModulePrompt = (
  login: string,
  copy: Copy,
  description: string | null = null,
): string =>
  described(
    (description === null
      ? copy.appsNewPersonalModulePrompt
      : copy.appsNewPersonalModulePromptDescribed
    ).replaceAll("{login}", login),
    description ?? "",
  );

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

/** What "+ Nový modul" offers: the prompt's id and the GitHub login its link
 * names, and whom it speaks to. `name` is the Organization's, null in the
 * personal space. The dialog builds the text with the person's description
 * (new-module-view.ts). */
export type NewModuleOffer = Readonly<{
  id: "new-module" | "new-module-request" | "new-personal-module";
  /** The Organization Admin founds it, an Organization Member asks the Organization Admin for it, the
   * personal space's holder founds it there. */
  variant: "admin" | "member" | "personal";
  organization: string;
  name: string | null;
}>;

/** Who gets "+ Nový modul" in a group, and with which prompt: in an
 * Organization bound to a GitHub login, an identity GitHub's live answer
 * says is its Organization Owner (`owner`, F36's Organization-rail
 * addendum, point 8), the prompt `new-module`, or an active Organization
 * Member (`member`, a Module Maintainer too), the muted tile and the prompt `new-module-request` (F36's addendum of
 * 2026-11-05); in the personal space listed without a reason, its verified
 * holder (`holder`, the login of the `present` personalspace item, #186), the
 * prompt `new-personal-module`. Everyone else, a Team Environment among them:
 * null. The prompt route decides again on every request, so a tile drawn
 * from an answer that has since changed opens nothing it should not. */
export function newModuleOffer(
  group: CatalogGroupEntry,
  input: Readonly<{
    owner: boolean;
    member?: boolean;
    holder: string | null;
  }>,
): NewModuleOffer | null {
  if (group.sections === null)
    return group.organization.reason === undefined &&
      input.holder !== null &&
      githubLogin.test(input.holder)
      ? {
          id: "new-personal-module",
          variant: "personal",
          organization: input.holder,
          name: null,
        }
      : null;
  const login = group.organization.forgeLogin;
  if (login === undefined) return null;
  if (input.owner)
    return {
      id: "new-module",
      variant: "admin",
      organization: login,
      name: group.name,
    };
  return input.member === true
    ? {
        id: "new-module-request",
        variant: "member",
        organization: login,
        name: group.name,
      }
    : null;
}
