import type { ModuleAnswer, ModuleBlocked } from "../modules/module-operations";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
} from "../organizations/catalog";
import { catalogOrganizationKey } from "../organizations/catalog-selection";
import { initialsOf } from "../shell/view";
import {
  type Account,
  type AccountFavourites,
  createAccountFavourites,
  type OpenApps,
} from "./account";
import { appLinkTarget, startThenOpen } from "./app-opening";
import {
  type AppsSection,
  type AppsTile,
  appsHeading,
  appsScope,
  appsScopes,
  appsSections,
  appsSpaceOf,
  favoriteTiles,
  moduleAccessTarget,
  moduleDescription,
  moduleName,
  moduleStone,
  newModulePrompt,
  type TileTarget,
  tileTarget,
} from "./apps-view";
import {
  type CatalogFact,
  type CatalogGroupEntry,
  type CatalogStatus,
  catalogSelection,
  catalogStatus,
  moduleFacts,
  organizationName,
  organizationRoute,
  parseCatalog,
  routeOrganization,
} from "./catalog-view";
import type { PublicEntry } from "./chat";
import type { PromptLink } from "./chat-view";
import { favoritesKey, parseFavorites, toggleFavorite } from "./favorites";
import type { SetupAction, SetupLine } from "./first-run";
import type { MessageKey } from "./messages";
import {
  moduleLink,
  moduleResultMessage,
  moduleSettling,
  moduleStatusView,
  parseModuleResult,
} from "./module-view";
import { createOwnerAnswers } from "./owner-answer";
import { type PageRoute, settingsPath } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

/** The prompt "+ Nový modul" hands to Chat: its id and the Organization's
 * GitHub login for the link (Lazurio/t3code#35), its text for the
 * clipboard. */
export type NewModulePrompt = PromptLink & Readonly<{ text: string }>;

/** What "+ Nový modul" did: Chat opened with the prompt in its composer,
 * the prompt went to the clipboard, or neither. */
export type NewModuleOutcome = "handed-over" | "copied" | "failed";

const newModuleSay: Readonly<Record<NewModuleOutcome, MessageKey>> = {
  "handed-over": "appsNewModuleOpened",
  copied: "appsNewModuleCopied",
  failed: "appsNewModuleCopyFailed",
};

/** The current Environment as the Apps home names it under the
 * Organization: its name by what it is for and its kind's icon. */
export type HomeEnvironment = Readonly<{
  name: string;
  icon: "laptop" | "user" | "users" | "bot";
}>;

// The Apps home of the Lazurio shell (decision F36 and its addendum of
// 2026-10-04): the left column holds "Všechny moduly", "Soubory", your
// favourite modules and, at its foot, the Marketplace; no module list and no
// search. The main view names the Organization and, under it, the
// Environment, then the sections Workspace (every module) and
// Productionspace (production repositories, read-only, decision F32's final
// addendum) as pills with counts over grids of clean tiles: stone, name, a
// short description, a star when favourite. A tile opens the module's app
// where the person's account says (root decision 0185 S18; a new tab without
// the account): hosted on the module's own origin, where the gateway starts
// it; locally through the lifecycle (start, then open the link it reports). A
// module without an app, one that cannot start and a repository only say so
// in a short message. The "⋯" menu at a tile's top right stars it, leads to
// the module's overview (a repository's GitHub page), which carries the
// module lifecycle (slice P5) over `/api/modules/<org>/<module>/…`, the same
// core as `lazurio module`, and for the Organization's Owners and Stewards
// to the module's access in the Organization's Dashboard (S15). Favourites
// are the account's (S12) when it can be read, else this browser's. Where this
// Environment's GitHub identity is an Owner of the Organization, Workspace
// ends with "+ Nový modul". Teams are shown nowhere (decision F32). Every
// value from the server is drawn with textContent.
export function createCatalogPanel(
  options: Readonly<{
    post: (
      path: string,
      body: unknown,
    ) => Promise<{ value: unknown; ok: boolean }>;
    /** A read-only GET with the page's credential. */
    get: (path: string) => Promise<{ value: unknown; ok: boolean }>;
    copy: () => Copy;
    /** The line until the Environment is usable (first-run.ts), or null. */
    setupLine: () => SetupLine | null;
    /** A button of that line: a start request for Settings, which the page
     * takes on arrival, or "Vyřešit v Chatu". */
    setupAction: (action: SetupAction) => void;
    /** The route now shown. */
    route: () => PageRoute;
    /** Moves the page to a route path (history push, focus on its head). */
    navigate: (path: string) => void;
    /** The catalog changed: names in the heading may have changed. */
    loaded: () => void;
    /** The recorded hosted entry, or null on a workstation. */
    entry: () => PublicEntry | null;
    /** The avatar of an Organization slug, as the shell document names it. */
    avatar: (slug: string) => string | null;
    /** The current Environment's name and icon, once the shell document is
     * read. */
    environment: () => HomeEnvironment | null;
    /** The Organization (or `personal`) the Apps home now shows: the shell
     * marks it as the space you are in. Null: not known here (an
     * Organization the Folder cannot read); the shell takes this
     * Environment's own space. */
    space: (space: string | null) => void;
    /** "+ Nový modul": hands the prepared prompt to Chat, by link where
     * Chat takes it, otherwise through the clipboard; resolves to what
     * happened. */
    newModule: (prompt: NewModulePrompt) => Promise<NewModuleOutcome>;
    /** Reads the person's account once (account.ts): null when it is
     * unavailable. */
    readAccount: () => Promise<Account | null>;
    /** One write of the account; resolves whether it was taken. */
    writeAccount: (method: "PUT" | "DELETE", path: string) => Promise<boolean>;
    /** The Dashboard page of an Organization slug, as the shell document
     * names it, or null. */
    dashboard: (slug: string) => string | null;
    /** The catalog the page already carries (its boot document, F36's
     * addendum of 2026-10-08): drawn at once, without a first read. */
    catalog?: Catalog | null;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing catalog UI");
    return element;
  };
  const home = find<HTMLAnchorElement>("#catalog-home");
  const favoritesBox = find<HTMLDivElement>("#catalog-favorites");
  const head = find<HTMLElement>("#catalog-head");
  const headName = find<HTMLDivElement>("#catalog-head-name");
  const body = find<HTMLDivElement>("#catalog-body");
  const status = find<HTMLParagraphElement>("#catalog-status");
  const toastRegion = find<HTMLDivElement>("#toast");
  let catalog: Catalog | null = options.catalog ?? null;
  let state: "loading" | "loaded" | "failed" =
    catalog === null ? "loading" : "loaded";
  // A sentence about the last tile opened on a workstation (starting,
  // failed), shown in the status line until the next move.
  let notice: string | null = null;
  // Whether this Environment's GitHub identity is an Owner of an
  // Organization, by its route key: read once per page, never assumed.
  // The Owner answers this page holds (owner-answer.ts); a catalog read
  // drops them all.
  const owners = createOwnerAnswers();
  // Whether it may maintain a module's repository (a Steward's "Přístup k
  // modulu"), by the Organization's route key and the module id: asked only
  // when the person reaches for a module's menu, never for every tile.
  const maintainers = createOwnerAnswers();
  // The person's account (root decision 0185 S12, S18): undefined until it
  // is read once, null when it is unavailable (today's behaviour stays:
  // favourites in this browser, apps in a new tab).
  let account:
    | Readonly<{ openApps: OpenApps; favourites: AccountFavourites }>
    | null
    | undefined;
  void options
    .readAccount()
    .then((value) => {
      account =
        value === null
          ? null
          : {
              openApps: value.openApps,
              favourites: createAccountFavourites(
                value.favourites,
                options.writeAccount,
              ),
            };
    })
    .catch(() => {
      account = null;
    })
    .finally(() => render());
  const openMode = (): OpenApps => account?.openApps ?? "tab";
  // The lifecycle of the module the page shows: its last status, the
  // sentence after the last action, and whether a request is under way.
  // Nothing of it is kept beyond the page; the service manager is the truth.
  let lifecycle: {
    key: string;
    status: ModuleAnswer | ModuleBlocked | null;
    message: string | null;
    busy: boolean;
    // After Start or Stop the keyboard focus returns to the primary action
    // once it can take it again (it is disabled while the request runs).
    focus: boolean;
  } | null = null;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    content?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const svg = (name: string, className = "icon") => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", className);
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };
  const routeLink = (href: string, className: string, content?: string) => {
    const link = element("a", className, content);
    link.href = href;
    link.dataset.route = "";
    return link;
  };
  const dot = (state: string) => {
    const mark = element("span", "dot");
    mark.dataset.state = state;
    mark.setAttribute("aria-hidden", "true");
    return mark;
  };
  const statusLine = (view: CatalogStatus) => {
    const line = element("p", "row-status catalog-status");
    line.dataset.state = view.state;
    line.append(dot(view.state === "ready" ? "ready" : "blocked"), view.text);
    if (view.code !== null) line.append(" ", element("code", "", view.code));
    return line;
  };
  // An Organization's mark: its GitHub avatar, or its initials when there
  // is none or it does not load; the Personalspace group's is round.
  const orgMark = (group: CatalogGroupEntry, className: string) => {
    const mark = element("span", className);
    const initials = () => mark.replaceChildren(initialsOf(group.name));
    const slug = group.organization.organization;
    const avatar =
      slug === null || group.sections === null ? null : options.avatar(slug);
    if (avatar === null) {
      initials();
      if (group.sections === null) mark.dataset.personal = "";
      return mark;
    }
    const image = element("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.src = avatar;
    image.addEventListener("error", initials, { once: true });
    mark.append(image);
    return mark;
  };
  // A module's Lazurio stone (decision F36), or a repository's folder.
  const stoneImage = (src: string, size: number, className: string) => {
    const image = element("img", className);
    image.src = src;
    image.alt = "";
    image.width = size;
    image.height = size;
    image.decoding = "async";
    image.setAttribute("aria-hidden", "true");
    return image;
  };
  const tileMark = (tile: AppsTile, size: number) => {
    if (tile.kind === "module")
      return stoneImage(
        tile.stone.src,
        size,
        size > 24 ? "tile-stone" : "menu-stone",
      );
    const mark = element("span", size > 24 ? "tile-mark" : "menu-mark");
    mark.append(svg("folder"));
    mark.setAttribute("aria-hidden", "true");
    return mark;
  };
  const scopeRoute = (value: Catalog, group: CatalogGroupEntry | null) =>
    group === null || group === appsScopes(value, options.copy())[0]
      ? "/"
      : (organizationRoute(value, group.organization) ?? "/");
  // An Organization's favourites belong to the person's account, keyed by
  // the Organization slug (S12), whenever the account can be read. The
  // Personalspace group, an Organization without a slug, and every group
  // while the account is unavailable keep them per Organization in this
  // browser (favorites.ts): never in the Folder, which a Team Environment
  // shares. Old browser favourites are not copied into the account.
  const scopeKey = (group: CatalogGroupEntry) =>
    group.sections === null
      ? "personalspace"
      : (group.organization.organization ?? group.organization.directory);
  const accountSlug = (group: CatalogGroupEntry) =>
    group.sections === null ? null : group.organization.organization;
  const favoritesPending = (group: CatalogGroupEntry) =>
    accountSlug(group) !== null && account === undefined;
  const favoritesOf = (group: CatalogGroupEntry): readonly string[] => {
    const slug = accountSlug(group);
    if (slug !== null && account === undefined) return [];
    if (slug !== null && account) return account.favourites.list(slug);
    try {
      return parseFavorites(
        localStorage.getItem(favoritesKey(scopeKey(group))),
      );
    } catch {
      return [];
    }
  };
  const toggle = async (group: CatalogGroupEntry, key: string) => {
    // A pending account is not a known empty list: never queue blind toggles.
    if (favoritesPending(group)) return;
    const slug = accountSlug(group);
    if (slug !== null && account) {
      // At once; once its writes are done the favourite shows what the
      // account holds, with a short message when the last click was not
      // taken (account.ts).
      const favourites = account.favourites;
      const written = favourites.toggle(slug, key);
      render();
      const shown = favourites.list(slug).join("\n");
      const taken = await written;
      if (!taken) say(options.copy().appsFavoriteFailed);
      if (!taken || favourites.list(slug).join("\n") !== shown) render();
      return;
    }
    try {
      localStorage.setItem(
        favoritesKey(scopeKey(group)),
        JSON.stringify(toggleFavorite(favoritesOf(group), key)),
      );
    } catch {}
    render();
  };

  // --- A short message at the foot of the page (the wireframe's toast) --
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function say(text: string) {
    clearTimeout(toastTimer);
    const toast = element("div", "toast");
    toast.append(svg("info"), text);
    toastRegion.replaceChildren(toast);
    toastTimer = setTimeout(() => toastRegion.replaceChildren(), 3500);
  }

  // --- Opening a module's app -------------------------------------------

  // Starts a workstation's app through the lifecycle: the link it reports
  // once healthy, or null.
  async function started(
    target: Extract<TileTarget, { kind: "start" }>,
  ): Promise<string | null> {
    let result = parseModuleResult(
      (await options.post(target.start, {})).value,
    );
    for (let attempt = 0; attempt < 30; attempt++) {
      if (result?.kind === "module" && result.healthy)
        return moduleLink(result.runtime?.url);
      if (
        result === null ||
        (result.kind === "module" &&
          !moduleSettling(result) &&
          !result.outcome.endsWith("-pending"))
      )
        return null;
      await new Promise((done) => setTimeout(done, 1000));
      result = parseModuleResult((await options.get(target.status)).value);
    }
    return null;
  }

  // A workstation: start the app through the lifecycle, then open the link
  // it reports where the account says (app-opening.ts): in the tab opened at
  // the click (a tab opened later would be a blocked pop-up), or this window
  // once the start succeeded. Anything else closes that tab and shows the
  // overview, which says why.
  async function openLocal(
    target: Extract<TileTarget, { kind: "start" }>,
    name: string,
  ) {
    const copy = options.copy();
    const mode = openMode();
    notice = copy.appsStarting.replace("{name}", name);
    render();
    const opened = await startThenOpen(mode, () => started(target), {
      open: () => {
        const tab = window.open("about:blank", "_blank");
        return tab === null
          ? null
          : {
              close: () => tab.close(),
              navigate: (href) => {
                tab.opener = null;
                tab.location.href = href;
              },
            };
      },
      assign: (href) => location.assign(href),
    });
    if (opened) {
      notice = null;
      if (mode === "tab") render();
      return;
    }
    notice = copy.appsStartFailed.replace("{name}", name);
    options.navigate(target.overview);
  }

  // A link that opens a module's app where the account says (a new tab,
  // or this window; never a frame): the module's own origin hosted; locally
  // a plain click starts it first (without the script the link is the
  // overview).
  function openLink(
    target: Extract<TileTarget, { kind: "hosted" } | { kind: "start" }>,
    name: string,
    className: string,
  ): HTMLAnchorElement {
    const copy = options.copy();
    const link = element("a", className);
    const mode = openMode();
    link.title = (
      mode === "same" ? copy.appsOpenAppNamedSame : copy.appsOpenAppNamed
    ).replace("{name}", name);
    if (target.kind === "hosted") {
      link.href = target.href;
      const where = appLinkTarget(mode);
      if (where.target !== null) link.target = where.target;
      link.rel = where.rel;
      return link;
    }
    link.href = target.overview;
    link.dataset.route = "";
    link.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void openLocal(target, name);
    });
    return link;
  }

  // What a tile, or a favourite in the column, is: a link that opens the
  // app, or a button that says why there is nothing to open.
  function actionNode(item: AppsTile, className: string): HTMLElement {
    if (item.action.kind === "open")
      return openLink(item.action.target, item.name, className);
    const text = item.action.text;
    const button = element("button", `${className} is-button`);
    button.type = "button";
    button.addEventListener("click", () => say(text));
    return button;
  }

  // --- The "⋯" menu of a tile -------------------------------------------

  let openMenu: (() => void) | null = null;
  document.addEventListener("click", (event) => {
    if (openMenu === null) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".tile-menu")) return;
    openMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openMenu !== null) {
      event.preventDefault();
      openMenu();
    }
  });

  // "Přístup k modulu" (root decision 0185 S15, issue #151): the module in
  // its Organization's Dashboard, in this window, for the Organization's
  // Owners (the Owner answer of "+ Nový modul") and Stewards (GitHub's
  // `maintain` on the module's repository); moduleAccessTarget says where
  // and whether. The Dashboard decides again with its own live read: the item
  // grants nothing. A Steward's answer is asked once it is older than the
  // server's cache; `settled` runs when it arrives.
  function askMaintainer(
    group: CatalogGroupEntry,
    item: AppsTile,
    settled: () => void,
  ) {
    if (catalog === null || item.kind !== "module") return;
    const organization = catalogOrganizationKey(catalog, group.organization);
    if (organization === null) return;
    const module = item.entry.module.module;
    const { ask } = maintainers.read(organization, module);
    if (ask === null) return;
    void options
      .get(
        `/api/organizations/${encodeURIComponent(organization)}/modules/${encodeURIComponent(module)}/maintain`,
      )
      .then(({ value, ok }) =>
        maintainers.settle(
          organization,
          module,
          ask,
          ok &&
            !!value &&
            typeof value === "object" &&
            (value as { maintain?: unknown }).maintain === true,
        ),
      )
      .catch(() => maintainers.settle(organization, module, ask, false))
      .finally(settled);
  }
  const maintainerOf = (group: CatalogGroupEntry, item: AppsTile) => {
    if (catalog === null || item.kind !== "module") return false;
    const organization = catalogOrganizationKey(catalog, group.organization);
    return (
      organization !== null &&
      maintainers.peek(organization, item.entry.module.module)
    );
  };

  function tileMenu(
    item: AppsTile,
    group: CatalogGroupEntry,
    owner: boolean,
  ): HTMLElement {
    const copy = options.copy();
    const box = element("div", "tile-menu");
    const button = element("button", "tile-menu-button");
    button.type = "button";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute(
      "aria-label",
      copy.appsMore.replace("{name}", item.name),
    );
    button.append(svg("more"));
    const list = element("div", "tile-menu-list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const close = () => {
      list.hidden = true;
      box.classList.remove("is-open");
      button.setAttribute("aria-expanded", "false");
      openMenu = null;
    };
    const star = element("button", "tile-menu-item");
    star.type = "button";
    star.setAttribute("role", "menuitem");
    star.disabled = favoritesPending(group);
    if (item.favorite) star.classList.add("is-favorite");
    star.append(
      svg(item.favorite ? "star-filled" : "star"),
      star.disabled
        ? copy.appsFavoritesLoading
        : item.favorite
          ? copy.appsFavoriteRemove
          : copy.appsFavoriteAdd,
    );
    star.addEventListener("click", () => {
      close();
      void toggle(group, item.key);
    });
    list.append(star);
    if (item.info !== null) {
      const info =
        item.kind === "module"
          ? routeLink(item.info, "tile-menu-item")
          : element("a", "tile-menu-item");
      if (item.kind === "repository") {
        info.href = item.info;
        info.target = "_blank";
        info.rel = "noopener noreferrer";
      }
      info.setAttribute("role", "menuitem");
      info.append(
        svg("info"),
        item.kind === "module" ? copy.appsInfoModule : copy.appsInfoRepository,
      );
      info.addEventListener("click", close);
      list.append(info);
    }
    // Whether the menu could ever offer it (a module, a Dashboard page),
    // before any Steward answer.
    const reachable =
      moduleAccessTarget(item, group, options.dashboard, {
        owner: true,
        maintainer: true,
      }) !== null;
    let accessShown = false;
    const showAccess = () => {
      const access = accessShown
        ? null
        : moduleAccessTarget(item, group, options.dashboard, {
            owner,
            maintainer: maintainerOf(group, item),
          });
      if (access === null) return;
      accessShown = true;
      // A plain link: the same window, no new-tab arrow.
      const link = element("a", "tile-menu-item");
      link.href = access;
      link.setAttribute("role", "menuitem");
      link.append(svg("users"), copy.appsModuleAccess);
      link.addEventListener("click", close);
      list.append(link);
    };
    showAccess();
    // A Steward's answer is asked when the person reaches for the menu, and
    // the item joins the open menu when it comes.
    const reach = () => {
      if (reachable && !owner)
        askMaintainer(group, item, () => {
          if (!list.hidden) showAccess();
        });
    };
    button.addEventListener("pointerenter", reach);
    button.addEventListener("focus", reach);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!list.hidden) {
        close();
        return;
      }
      reach();
      showAccess();
      openMenu?.();
      list.hidden = false;
      box.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      openMenu = close;
      list
        .querySelector<HTMLElement>(".tile-menu-item:not(:disabled)")
        ?.focus();
    });
    box.append(button, list);
    return box;
  }

  function tile(
    item: AppsTile,
    group: CatalogGroupEntry,
    owner: boolean,
  ): HTMLElement {
    const copy = options.copy();
    const wrap = element("div", "tile-wrap");
    const node = actionNode(item, "tile");
    node.dataset.kind = item.kind;
    if (item.kind === "module")
      node.style.setProperty("--stone-accent", item.stone.accent);
    const name = element("span", "tile-name", item.name);
    if (item.favorite) {
      const star = element("span", "tile-star");
      star.title = copy.appsFavoriteMark;
      star.append(
        svg("star-filled"),
        element("span", "sr-only", copy.appsFavoriteMark),
      );
      name.append(star);
    }
    const text = element("span", "tile-body");
    text.append(name, element("span", "tile-desc", item.description));
    node.append(tileMark(item, 48), text);
    wrap.append(node, tileMenu(item, group, owner));
    return wrap;
  }

  // "+ Nový modul" (2026-10-04): the last tile of Workspace, only where this
  // Environment's GitHub identity is an Owner of the Organization. It hands
  // the wireframe's prompt to Chat: where Chat takes a prompt by link
  // (Lazurio/t3code#35) it opens with the prompt in a new thread's composer,
  // not sent; otherwise the prompt goes to the clipboard and Chat opens,
  // where the person pastes it into a new chat (ui.ts `handOver`).
  function newModuleTile(group: CatalogGroupEntry): HTMLElement {
    const copy = options.copy();
    const button = element("button", "tile tile--new is-button");
    button.type = "button";
    const mark = element("span", "tile-mark tile-mark--new");
    mark.append(svg("plus"));
    const text = element("span", "tile-body");
    text.append(
      element("span", "tile-name", copy.appsNewModule),
      element("span", "tile-desc", copy.appsNewModuleSub),
    );
    button.append(mark, text);
    const login = group.organization.forgeLogin;
    button.addEventListener("click", async () => {
      if (login === undefined) return;
      const outcome = await options.newModule({
        id: "new-module",
        organization: login,
        text: newModulePrompt(group.name, login, copy),
      });
      say(options.copy()[newModuleSay[outcome]]);
    });
    return button;
  }

  // Whether this Environment may found modules in an Organization: GitHub's
  // own answer through the Launchpad, fail closed, asked again once it is
  // older than the server's cache or the bound login changed.
  function ownerOf(value: Catalog, group: CatalogGroupEntry): boolean {
    const login = group.organization.forgeLogin;
    if (group.sections === null || login === undefined) return false;
    const organization = catalogOrganizationKey(value, group.organization);
    if (organization === null) return false;
    const { owner, ask } = owners.read(organization, login);
    if (ask !== null)
      void options
        .get(`/api/organizations/${encodeURIComponent(organization)}/owner`)
        .then(({ value: answer, ok }) =>
          owners.settle(
            organization,
            login,
            ask,
            ok &&
              !!answer &&
              typeof answer === "object" &&
              (answer as { owner?: unknown }).owner === true,
          ),
        )
        .catch(() => owners.settle(organization, login, ask, false))
        .finally(() => {
          wakeForOwners();
          // Drawn again only when the answer changes what is shown.
          if (owners.peek(organization, login) !== owner) render();
        });
    return owner;
  }

  // Wakes the page when the earliest Owner answer expires, so that a shown
  // "+ Nový modul" is asked again without any navigation.
  let ownerWake: ReturnType<typeof setTimeout> | undefined;
  function wakeForOwners() {
    clearTimeout(ownerWake);
    const next = owners.nextExpiry();
    if (next === null) return;
    ownerWake = setTimeout(
      () => {
        render();
        wakeForOwners();
      },
      Math.max(1000, next - Date.now()),
    );
  }

  function section(
    value: AppsSection,
    group: CatalogGroupEntry,
    owner: boolean,
  ): HTMLElement {
    const part = element("section", "apps-section");
    part.dataset.section = value.kind;
    const top = element("div", "section-head");
    const title = element("h2", "section-pill", value.title);
    top.append(title, element("span", "section-count", value.count));
    const grid = element("div", "tile-grid");
    grid.append(...value.tiles.map((item) => tile(item, group, owner)));
    if (value.kind === "workspace" && owner) grid.append(newModuleTile(group));
    part.append(top, grid);
    return part;
  }

  // --- The column: favourites -------------------------------------------

  function drawFavorites(value: Catalog, group: CatalogGroupEntry | null) {
    const copy = options.copy();
    if (group === null) {
      favoritesBox.replaceChildren();
      return;
    }
    const label = element("p", "column-label", copy.appsFavorites);
    label.id = "column-favorites";
    // A first account read can need bounded recovery. Show that it is pending
    // instead of presenting an empty list or silently queueing star clicks.
    if (favoritesPending(group)) {
      const loading = element("p", "column-hint", copy.appsFavoritesLoading);
      loading.setAttribute("role", "status");
      favoritesBox.replaceChildren(label, loading);
      return;
    }
    const items = favoriteTiles(
      value,
      group,
      copy,
      options.entry(),
      favoritesOf(group),
    );
    if (items.length === 0) {
      favoritesBox.replaceChildren(
        label,
        element("p", "column-hint", copy.appsFavoritesHint),
      );
      return;
    }
    const list = element("ul", "menu");
    list.setAttribute("aria-labelledby", label.id);
    list.append(
      ...items.map((item) => {
        const entry = element("li");
        // A favourite opens the app straight away, like its tile.
        const link = actionNode(item, "menu-item");
        link.append(
          tileMark(item, 20),
          element("span", "menu-name", item.name),
        );
        if (item.action.kind === "open" && openMode() === "tab")
          link.append(svg("external", "icon menu-external"));
        entry.append(link);
        return entry;
      }),
    );
    favoritesBox.replaceChildren(label, list);
  }

  // --- The head: the Organization, and the Environment under it ---------

  function drawHead(group: CatalogGroupEntry | null) {
    const copy = options.copy();
    // The Organization's name opens its Dashboard (F36's addendum of
    // 2026-10-06): in this window, as "Přístup k modulu" does.
    const name = appsHeading(group, copy, options.dashboard);
    const heading = element("h1", "apps-title");
    if (name.link === null) heading.textContent = name.text;
    else {
      const link = element("a", "apps-title-link", name.text);
      link.href = name.link.href;
      link.title = name.link.title;
      heading.append(link);
    }
    heading.tabIndex = -1;
    heading.dataset.pageHeading = "";
    const where = element("div", "apps-where");
    where.append(heading);
    const environment = options.environment();
    if (environment !== null) {
      const line = element("span", "apps-environment");
      line.append(svg(environment.icon), environment.name);
      where.append(line);
    }
    headName.replaceChildren(
      ...(group === null ? [] : [orgMark(group, "org-mark")]),
      where,
    );
  }

  // --- The main views -----------------------------------------------------

  // The line until the Environment is usable (root decision 0188): one
  // sentence and its buttons under the head. A button leads to Settings and
  // tells the page what to start there; "Vyřešit v Chatu" hands the prompt
  // over. No empty cards beside it.
  const setupStarts: Readonly<Record<SetupAction, string | null>> = {
    "sign-in-gh": settingsPath("tools"),
    "install-content": settingsPath("machine"),
    "resolve-in-chat": null,
  };
  function setupLineNode(line: SetupLine): HTMLElement {
    const box = element("div", "setup-line");
    box.dataset.tone = line.tone;
    box.setAttribute("role", "status");
    const actions = element("div", "setup-line-actions");
    line.actions.forEach(({ action, label }, index) => {
      const className = index === 0 ? "button primary" : "button";
      const path = setupStarts[action];
      const control =
        path === null
          ? element("button", className.replace("button", "").trim(), label)
          : routeLink(`${path}#lazurio-start=${action}`, className, label);
      if (control instanceof HTMLButtonElement) control.type = "button";
      control.dataset.setupAction = action;
      control.addEventListener("click", (event) => {
        const click = event as MouseEvent;
        if (
          click.button !== 0 ||
          click.metaKey ||
          click.ctrlKey ||
          click.shiftKey ||
          click.altKey
        )
          return;
        options.setupAction(action);
      });
      actions.append(control);
    });
    box.append(
      svg(line.icon),
      element("span", "setup-line-text", line.text),
      actions,
    );
    return box;
  }

  function appsHome(value: Catalog, group: CatalogGroupEntry | null): Node[] {
    const copy = options.copy();
    const parts: Node[] = [];
    const setup = options.setupLine();
    if (setup !== null) parts.push(setupLineNode(setup));
    if (group === null)
      return setup === null
        ? [element("p", "callout", copy.catalogEmpty)]
        : parts;
    if (
      !group.organization.executable &&
      group.organization.reason !== undefined
    )
      parts.push(statusLine(group.status));
    const sections = appsSections(
      value,
      group,
      copy,
      options.entry(),
      favoritesOf(group),
    );
    const owner = ownerOf(value, group);
    if (
      sections.length === 0 &&
      group.organization.reason === undefined &&
      setup === null
    )
      // Plain words for an empty space (the wireframe, Matěj and Anička
      // 2026-10-04): the personal space is simply empty; in an
      // Organization the person has no module here yet and whom to ask.
      parts.push(
        element(
          "p",
          "intro",
          group.sections === null
            ? copy.catalogPersonalspaceEmpty
            : copy.catalogNoModules,
        ),
      );
    parts.push(...sections.map((part) => section(part, group, owner)));
    return parts;
  }

  // A slug more than one candidate declares: their isolation, never one of
  // them. Each candidate is named by its directory, linked only where a name
  // selects exactly it.
  function ambiguousView(
    value: Catalog,
    candidates: readonly CatalogOrganization[],
  ): Node[] {
    const copy = options.copy();
    const card = element("div", "card");
    card.append(
      ...candidates.map((organization) => {
        const item = element("div", "row");
        const href = organizationRoute(value, organization);
        const title = element("div", "row-title");
        title.append(
          href === null
            ? organization.directory
            : routeLink(href, "", organization.directory),
        );
        item.append(title, statusLine(catalogStatus(organization, copy)));
        return item;
      }),
    );
    return [element("p", "callout", copy.catalogReasonDuplicate), card];
  }

  const factsCard = (entries: readonly CatalogFact[]) => {
    const list = element("dl", "card");
    list.append(
      ...entries.map(([label, value]) => {
        const item = element("div", "row");
        const main = element("div", "row-main");
        const detail = element("dd");
        if (typeof value === "string") detail.textContent = value;
        else {
          const lines = element("ul");
          lines.replaceChildren(
            ...value.map((line) => element("li", "", line)),
          );
          detail.replaceChildren(lines);
        }
        main.append(element("dt", "", label), detail);
        item.append(main);
        return item;
      }),
    );
    return list;
  };
  const group = (title: string, ...children: Node[]) => {
    const part = element("section", "group");
    const top = element("div", "group-head");
    top.append(element("h2", "", title));
    part.append(top, ...children);
    return part;
  };

  function moduleView(
    value: Catalog,
    scope: CatalogGroupEntry | null,
    organization: CatalogOrganization,
    module: CatalogModule,
  ): Node[] {
    const copy = options.copy();
    const back = routeLink(scopeRoute(value, scope), "back");
    back.append(svg("chevron-left"), copy.appsAll);
    const top = element("div", "module-head");
    const heading = element("h1", "module-title", moduleName(module));
    heading.tabIndex = -1;
    heading.dataset.pageHeading = "";
    const text = element("div", "module-head-text");
    text.append(
      heading,
      element("p", "module-meta", moduleDescription(module, copy)),
    );
    top.append(stoneImage(moduleStone(module).src, 64, "module-stone"), text);
    const target = tileTarget(value, organization, module, options.entry());
    if (target.kind === "hosted" || target.kind === "start") {
      const open = openLink(
        target,
        moduleName(module),
        "button primary module-open",
      );
      if (openMode() === "tab") open.append(svg("external"));
      open.append(copy.appsOpenApp);
      top.append(open);
    }
    const key = catalogOrganizationKey(value, organization);
    const log = element("div", "card");
    const logRow = element("div", "row");
    logRow.append(
      element("p", "row-desc", copy.appsLogHint),
      element(
        "code",
        "command",
        `lazurio module logs ${key ?? organization.directory}/${module.module}`,
      ),
    );
    log.append(logRow);
    return [
      back,
      top,
      ...(module.executable ? [] : [statusLine(catalogStatus(module, copy))]),
      // A module refused only by its preparation (decision F25) keeps its
      // card: its running app is read and stopped; Start answers the reason.
      ...(module.executable || module.preparationRefused
        ? [group(copy.moduleApplication, lifecycleCard(organization, module))]
        : []),
      group(copy.appsAbout, factsCard(moduleFacts(organization, module, copy))),
      group(copy.appsLog, log),
    ];
  }

  // The request path of one module: the name that selects exactly its
  // Organization, as its route uses, and the module id, each URL-encoded.
  function modulePathOf(
    organization: CatalogOrganization,
    module: CatalogModule,
    verb: "start" | "stop" | "status",
  ): string | null {
    const key =
      catalog === null ? null : catalogOrganizationKey(catalog, organization);
    return key === null
      ? null
      : `/api/modules/${encodeURIComponent(key)}/${encodeURIComponent(module.module)}/${verb}`;
  }
  const lifecycleKey = (
    organization: CatalogOrganization,
    module: CatalogModule,
  ) => modulePathOf(organization, module, "status") ?? "";

  // Reads the status of the module now shown; `settle` keeps reading while
  // a just-started app is not yet healthy (about half a minute at most).
  async function readStatus(
    organization: CatalogOrganization,
    module: CatalogModule,
    settle = false,
  ) {
    const path = modulePathOf(organization, module, "status");
    if (path === null || lifecycle === null) return;
    const key = lifecycle.key;
    for (let attempt = 0; attempt < (settle ? 30 : 1); attempt++) {
      if (attempt > 0) await new Promise((done) => setTimeout(done, 1000));
      if (lifecycle?.key !== key) return;
      let status: ModuleAnswer | ModuleBlocked | null = null;
      try {
        status = parseModuleResult((await options.get(path)).value);
      } catch {
        status = null;
      }
      if (lifecycle?.key !== key) return;
      lifecycle.status = status;
      render();
      if (!moduleSettling(status)) return;
    }
  }

  async function act(
    organization: CatalogOrganization,
    module: CatalogModule,
    verb: "start" | "stop",
  ) {
    const path = modulePathOf(organization, module, verb);
    if (path === null || lifecycle === null || lifecycle.busy) return;
    const key = lifecycle.key;
    lifecycle.busy = true;
    lifecycle.focus = true;
    lifecycle.message = options.copy().moduleBusy;
    render();
    let result: ModuleAnswer | ModuleBlocked | null = null;
    try {
      result = parseModuleResult((await options.post(path, {})).value);
    } catch {
      result = null;
    }
    if (lifecycle?.key !== key) return;
    lifecycle.busy = false;
    lifecycle.message = moduleResultMessage(result, options.copy());
    if (result?.kind === "module") lifecycle.status = result;
    render();
    await readStatus(organization, module, verb === "start");
  }

  // The module's app: its status with a dot, who keeps it running, why a
  // healthy app has no link, the result of the last action, and on the right
  // the one primary action and Open.
  function lifecycleCard(
    organization: CatalogOrganization,
    module: CatalogModule,
  ): HTMLElement {
    const copy = options.copy();
    const key = lifecycleKey(organization, module);
    if (lifecycle?.key !== key) {
      lifecycle = {
        key,
        status: null,
        message: null,
        busy: false,
        focus: false,
      };
      void readStatus(organization, module);
    }
    const current = lifecycle;
    const view = moduleStatusView(current.status, copy);
    const card = element("div", "card module-lifecycle");
    const item = element("div", "row");
    const main = element("div", "row-main");
    const text = element("div", "row-copy");
    const line = element("p", "row-title catalog-status module-status");
    line.dataset.state = view.dot;
    line.append(dot(view.dot), view.text);
    if (view.code !== null) line.append(" ", element("code", "", view.code));
    text.append(line);
    if (view.ownership !== null)
      text.append(element("p", "row-desc", view.ownership));
    if (view.noLink !== null)
      text.append(element("p", "row-desc", view.noLink));
    const message = element("p", "row-status", current.message ?? "");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    text.append(message);
    const control = element("div", "row-control");
    if (view.action !== null) {
      const action = view.action;
      const button = element(
        "button",
        action === "start" ? "primary" : "",
        action === "start" ? copy.moduleStart : copy.moduleStop,
      );
      button.type = "button";
      button.dataset.moduleAction = action;
      button.disabled = current.busy;
      button.addEventListener(
        "click",
        () => void act(organization, module, action),
      );
      control.append(button);
    }
    if (view.link !== null) {
      const open = element("a", "button", copy.moduleOpen);
      open.href = view.link;
      const mode = openMode();
      const where = appLinkTarget(mode);
      if (where.target !== null) open.target = where.target;
      open.rel = where.rel;
      open.setAttribute(
        "aria-label",
        (mode === "same"
          ? copy.moduleOpenNamedSame
          : copy.moduleOpenNamed
        ).replace("{name}", moduleName(module)),
      );
      control.append(open);
    }
    main.append(text, control);
    item.append(main);
    card.append(item);
    return card;
  }

  // --- The left column ----------------------------------------------------

  /** Draws the route now shown from the catalog last read. */
  function render(route: PageRoute = options.route()) {
    const copy = options.copy();
    openMenu?.();
    status.textContent =
      notice ??
      (state === "loading"
        ? copy.catalogLoading
        : state === "failed"
          ? copy.catalogLoadFailed
          : "");
    if (catalog === null) {
      favoritesBox.replaceChildren();
      body.replaceChildren();
      drawHead(null);
      head.hidden = false;
      return;
    }
    const scope = appsScope(catalog, route, copy);
    const selection = catalogSelection(catalog, route);
    if (scope !== null) options.space(appsSpaceOf(scope));
    home.href = scopeRoute(catalog, scope);
    if (
      (route.view === "home" || route.view === "organization") &&
      (selection.kind === "overview" || selection.kind === "organization")
    )
      home.setAttribute("aria-current", "page");
    else home.removeAttribute("aria-current");
    drawFavorites(catalog, scope);
    if (
      route.view !== "home" &&
      route.view !== "organization" &&
      route.view !== "module"
    )
      return;
    if (selection.kind === "missing") {
      head.hidden = false;
      drawHead(null);
      const missing = element("p", "callout");
      missing.append(
        copy.catalogNotFound,
        " ",
        routeLink("/", "", copy.appsAll),
      );
      body.replaceChildren(missing);
      return;
    }
    // The primary action is drawn again after every answer: keep the
    // keyboard focus on it.
    const focused =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.moduleAction !== undefined;
    if (selection.kind !== "module") lifecycle = null;
    head.hidden = selection.kind === "module";
    if (selection.kind !== "module") drawHead(scope);
    body.replaceChildren(
      ...(selection.kind === "ambiguous"
        ? ambiguousView(catalog, selection.candidates)
        : selection.kind === "module"
          ? moduleView(catalog, scope, selection.organization, selection.module)
          : appsHome(catalog, scope)),
    );
    const action = body.querySelector<HTMLButtonElement>(
      "[data-module-action]",
    );
    if ((focused || lifecycle?.focus) && action && !action.disabled) {
      action.focus();
      if (lifecycle) lifecycle.focus = false;
    }
  }

  /** Reads the catalog again (on load, on the way back to "Všechny moduly"
   * and on a language change). */
  async function refresh() {
    owners.clear();
    maintainers.clear();
    // Only the first read shows that it is reading; a later one keeps the
    // page as it is until its answer.
    if (catalog === null) {
      state = "loading";
      render();
    }
    try {
      const { value, ok } = await options.post("/api/catalog", {});
      const parsed = ok ? parseCatalog(value) : null;
      if (parsed === null) throw new Error("Catalog unavailable");
      catalog = parsed;
      state = "loaded";
    } catch {
      state = "failed";
    } finally {
      render();
      options.loaded();
    }
  }

  return {
    render(route?: PageRoute) {
      // A move ends the sentence about the last tile, unless it is the move
      // to the overview that sentence explains.
      if (route !== undefined && route.view !== "module") notice = null;
      render(route);
    },
    refresh,
    /** Whether the catalog is being read for the first time. */
    reading: () => state === "loading",
    /** The display name of an Organization slug, once known. */
    displayName(slug: string): string | undefined {
      const organization =
        catalog === null ? undefined : routeOrganization(catalog, slug);
      return organization === undefined
        ? undefined
        : organizationName(organization);
    },
    /** A short message at the foot of the page. */
    say,
    /** The display name of the Organization of the Folder bound to a
     * GitHub login (or of that slug), once the catalog knows it. */
    organizationName(login: string): string | null {
      const key = login.toLowerCase();
      const found = catalog?.organizations.find(
        (organization) =>
          organization.forgeLogin?.toLowerCase() === key ||
          organization.organization?.toLowerCase() === key,
      );
      return found === undefined ? null : organizationName(found);
    },
    /** How many modules an Organization of the Folder has, by the GitHub
     * login its manifest binds it to; null when the Folder has none such. */
    modulesOf(login: string): number | null {
      const key = login.toLowerCase();
      const found = catalog?.organizations.find(
        (organization) => organization.forgeLogin?.toLowerCase() === key,
      );
      return found === undefined ? null : found.modules.length;
    },
    /** The key of the Folder's one Organization (a work Environment's),
     * for its Owner question; null with none or several. */
    soleOrganization(): string | null {
      if (catalog === null || catalog.organizations.length !== 1) return null;
      const [organization] = catalog.organizations;
      return organization === undefined
        ? null
        : catalogOrganizationKey(catalog, organization);
    },
    /** The Organization a route shows, for the Marketplace's sentence. */
    scopeName(route: PageRoute): string | null {
      if (catalog === null) return null;
      const scope = appsScope(catalog, route, options.copy());
      return scope === null || scope.sections === null ? null : scope.name;
    },
  };
}
