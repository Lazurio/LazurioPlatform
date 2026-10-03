import type { ModuleAnswer, ModuleBlocked } from "../modules/module-operations";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
} from "../organizations/catalog";
import { catalogOrganizationKey } from "../organizations/catalog-selection";
import { initialsOf } from "../shell/view";
import {
  type AppsSection,
  type AppsTile,
  appsMatch,
  appsScope,
  appsScopes,
  appsSections,
  moduleDescription,
  moduleName,
  moduleStone,
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
import type { MessageKey } from "./messages";
import {
  moduleLink,
  moduleResultMessage,
  moduleSettling,
  moduleStatusView,
  parseModuleResult,
} from "./module-view";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The Apps home of the Lazurio shell (decision F36; the target shell's "Apps
// home"): the left column lists one Organization's modules under the section
// Workspace and its production repositories, read-only, under the section
// Productionspace (F32 addendum of 2026-10-03, final), with a search; the
// main view shows that
// Organization's name on top (a picker when the Folder holds several) and
// the same sections as pills with counts over grids of tiles. A tile opens
// the module's app in a new tab: hosted on the module's own origin, where the
// gateway starts it; locally through the lifecycle (start, then open the link
// it reports). A module with no app, or one that cannot start, opens its
// overview, and so does choosing it in the column. The overview carries the
// module lifecycle (slice P5): the status of its app with a dot, the one
// primary action (Start or Stop) and Open while the app reports a link, over
// `/api/modules/<org>/<module>/…`, the same core as `lazurio module`. A
// production repository has no dot, no action and no page: its tile is its
// GitHub page when known, else plain text. Teams are shown nowhere (decision
// F32). Every value from the server is drawn with textContent.
export function createCatalogPanel(
  options: Readonly<{
    post: (
      path: string,
      body: unknown,
    ) => Promise<{ value: unknown; ok: boolean }>;
    /** A read-only GET with the page's credential. */
    get: (path: string) => Promise<{ value: unknown; ok: boolean }>;
    copy: () => Copy;
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
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing catalog UI");
    return element;
  };
  const tree = find<HTMLDivElement>("#catalog-tree");
  const home = find<HTMLAnchorElement>("#catalog-home");
  const search = find<HTMLInputElement>("#catalog-search");
  const head = find<HTMLElement>("#catalog-head");
  const headName = find<HTMLDivElement>("#catalog-head-name");
  const body = find<HTMLDivElement>("#catalog-body");
  const status = find<HTMLParagraphElement>("#catalog-status");
  const refreshButton = find<HTMLButtonElement>("#catalog-refresh");
  let catalog: Catalog | null = null;
  let state: "loading" | "loaded" | "failed" = "loading";
  // A sentence about the last tile opened on a workstation (starting,
  // failed), shown in the status line until the next move.
  let notice: string | null = null;
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
  // is none or it does not load.
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
  const tileMark = (stone: Readonly<{ src: string }> | null) => {
    if (stone !== null) return stoneImage(stone.src, 48, "tile-stone");
    const mark = element("span", "tile-mark");
    mark.dataset.kind = "repository";
    mark.append(svg("folder"));
    mark.setAttribute("aria-hidden", "true");
    return mark;
  };
  const scopeRoute = (value: Catalog, group: CatalogGroupEntry | null) =>
    group === null || group === appsScopes(value, options.copy())[0]
      ? "/"
      : (organizationRoute(value, group.organization) ?? "/");

  // --- Opening a module's app -------------------------------------------

  // A workstation: start the app through the lifecycle, then open the link
  // it reports in the tab opened at the click (a tab opened later would be
  // a blocked pop-up). Anything else closes that tab and shows the overview,
  // which says why.
  async function openLocal(
    target: Extract<TileTarget, { kind: "start" }>,
    name: string,
  ) {
    const copy = options.copy();
    const tab = window.open("about:blank", "_blank");
    notice = copy.appsStarting.replace("{name}", name);
    render();
    let link: string | null = null;
    try {
      let result = parseModuleResult(
        (await options.post(target.start, {})).value,
      );
      for (let attempt = 0; attempt < 30; attempt++) {
        if (result?.kind === "module" && result.healthy) {
          link = moduleLink(result.runtime?.url);
          break;
        }
        if (
          result === null ||
          (result.kind === "module" &&
            !moduleSettling(result) &&
            !result.outcome.endsWith("-pending"))
        )
          break;
        await new Promise((done) => setTimeout(done, 1000));
        result = parseModuleResult((await options.get(target.status)).value);
      }
    } catch {
      link = null;
    }
    if (link !== null && tab !== null) {
      tab.opener = null;
      tab.location.href = link;
      notice = null;
      render();
      return;
    }
    tab?.close();
    notice = copy.appsStartFailed.replace("{name}", name);
    options.navigate(target.overview);
  }

  // The tile's or the overview button's link for a target.
  function targetLink(
    target: TileTarget,
    name: string,
    className: string,
  ): HTMLElement {
    const copy = options.copy();
    if (target.kind === "none") return element("div", className);
    if (target.kind === "overview") {
      const link = routeLink(target.href, className);
      link.title = copy.appsOverviewNamed.replace("{name}", name);
      return link;
    }
    const link = element("a", className);
    link.title = copy.appsOpenAppNamed.replace("{name}", name);
    if (target.kind === "hosted") {
      link.href = target.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
    // Without the script it is the overview; with it, a plain click starts.
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

  function tile(item: AppsTile): HTMLElement {
    const copy = options.copy();
    let node: HTMLElement;
    if (item.kind === "module")
      node = targetLink(item.target, item.name, "tile");
    else if (item.href !== null) {
      const link = element("a", "tile");
      link.href = item.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = copy.appsRepositoryNamed.replace("{name}", item.name);
      node = link;
    } else node = element("div", "tile");
    node.dataset.kind = item.kind;
    const text = element("span", "tile-body");
    text.append(
      element("span", "tile-name", item.name),
      element("span", "tile-desc", item.description),
    );
    if (item.note !== null) {
      const note = element("span", "tile-note", item.note.text);
      note.dataset.tone = item.note.tone;
      note.title = item.note.title;
      // A status dot only on a module: a production repository has none.
      if (item.kind === "module") note.prepend(dot("blocked-warn"));
      text.append(note);
    }
    node.append(tileMark(item.kind === "module" ? item.stone : null), text);
    if (item.kind === "module")
      node.style.setProperty("--stone-accent", item.stone.accent);
    const opensTab =
      (item.kind === "module" &&
        (item.target.kind === "hosted" || item.target.kind === "start")) ||
      (item.kind === "repository" && item.href !== null);
    if (opensTab) node.append(svg("external", "icon tile-open"));
    return node;
  }

  function section(value: AppsSection): HTMLElement {
    const part = element("section", "apps-section");
    part.dataset.section = value.kind;
    const top = element("div", "section-head");
    const title = element("h2", "section-pill", value.title);
    top.append(title, element("span", "section-count", value.count));
    part.append(top);
    if (value.subtitle !== null)
      part.append(element("p", "section-subtitle", value.subtitle));
    const grid = element("div", "tile-grid");
    grid.append(...value.tiles.map(tile));
    part.append(grid);
    return part;
  }

  // --- The head: the Organization's name, or a picker -------------------

  function drawHead(value: Catalog, group: CatalogGroupEntry | null) {
    const copy = options.copy();
    const groups = appsScopes(value, copy);
    if (group === null) {
      const heading = element("h1", "apps-title", copy.homeTitle);
      heading.tabIndex = -1;
      heading.dataset.pageHeading = "";
      headName.replaceChildren(heading);
      return;
    }
    const heading = element("h1", "apps-title", group.name);
    heading.tabIndex = -1;
    heading.dataset.pageHeading = "";
    if (groups.length < 2) {
      headName.replaceChildren(orgMark(group, "org-mark"), heading);
      return;
    }
    // Several Organizations in this Folder: the name opens a list of them.
    const picker = element("details", "org-picker");
    const summary = element("summary");
    summary.setAttribute(
      "aria-label",
      `${group.name}, ${copy.appsOrganizationPick}`,
    );
    summary.append(heading, svg("chevron-down", "icon org-picker-chevron"));
    const list = element("ul", "org-picker-list");
    list.append(
      ...groups.map((entry) => {
        const item = element("li");
        const href = scopeRoute(value, entry);
        const link = routeLink(href, "org-picker-item");
        link.append(
          orgMark(entry, "org-mark small"),
          element("span", "", entry.name),
        );
        if (entry === group) link.setAttribute("aria-current", "true");
        link.addEventListener("click", () => picker.removeAttribute("open"));
        item.append(link);
        return item;
      }),
    );
    picker.append(summary, list);
    headName.replaceChildren(orgMark(group, "org-mark"), picker);
  }

  // --- The main views -----------------------------------------------------

  function appsHome(value: Catalog, group: CatalogGroupEntry | null): Node[] {
    const copy = options.copy();
    if (group === null) return [element("p", "callout", copy.catalogEmpty)];
    const parts: Node[] = [];
    if (
      !group.organization.executable &&
      group.organization.reason !== undefined
    )
      parts.push(statusLine(group.status));
    const sections = appsSections(value, group, copy, options.entry());
    if (sections.length === 0 && group.organization.reason === undefined)
      parts.push(element("p", "intro", copy.catalogNoModules));
    parts.push(...sections.map(section));
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
      const open = targetLink(
        target,
        moduleName(module),
        "button primary module-open",
      );
      open.append(svg("external"), copy.appsOpenApp);
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
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.setAttribute(
        "aria-label",
        copy.moduleOpenNamed.replace("{name}", moduleName(module)),
      );
      control.append(open);
    }
    main.append(text, control);
    item.append(main);
    card.append(item);
    return card;
  }

  // --- The left column ----------------------------------------------------

  // One Organization's modules and production repositories in the column,
  // under the section labels Workspace and Productionspace, filtered by the
  // search; the current module is marked.
  function drawTree(
    value: Catalog,
    scope: CatalogGroupEntry | null,
    route: PageRoute,
  ) {
    const copy = options.copy();
    const query = search.value;
    const selection = catalogSelection(value, route);
    if (scope === null) {
      tree.replaceChildren();
      return;
    }
    tree.setAttribute(
      "aria-label",
      copy.appsColumn.replace("{name}", scope.name),
    );
    const sections = appsSections(value, scope, copy, options.entry());
    const parts = sections.flatMap((part) => {
      const items = part.tiles.filter((item) => appsMatch(item.name, query));
      if (items.length === 0) return [];
      const box = element("div", "column-group");
      box.dataset.section = part.kind;
      const label = element("p", "column-label", part.title);
      label.id = `column-${part.kind}`;
      const list = element("ul", "menu");
      list.setAttribute("aria-labelledby", label.id);
      list.append(
        ...items.map((item) => {
          const entry = element("li");
          let link: HTMLElement;
          if (item.kind === "module") {
            link =
              item.entry.href === null
                ? element("span", "menu-item")
                : routeLink(item.entry.href, "menu-item");
            if (
              selection.kind === "module" &&
              selection.module === item.entry.module
            )
              link.setAttribute("aria-current", "page");
          } else if (item.href !== null) {
            const anchor = element("a", "menu-item");
            anchor.href = item.href;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.title = copy.appsRepositoryNamed.replace(
              "{name}",
              item.name,
            );
            link = anchor;
          } else link = element("span", "menu-item");
          let mark: HTMLElement;
          if (item.kind === "module")
            mark = stoneImage(item.stone.src, 20, "menu-stone");
          else {
            mark = element("span", "menu-mark");
            mark.dataset.kind = "repository";
            mark.append(svg("folder"));
          }
          link.append(mark, element("span", "menu-name", item.name));
          if (item.note !== null) {
            // A status dot only on a module: a production repository has
            // none, its state is said in words.
            if (item.kind === "module") {
              const tail = dot("blocked-warn");
              tail.classList.add("menu-tail");
              link.append(tail);
            }
            link.append(element("span", "sr-only", `, ${item.note.text}`));
          }
          entry.append(link);
          return entry;
        }),
      );
      box.append(label, list);
      return [box];
    });
    tree.replaceChildren(
      ...(parts.length === 0 && query.trim() !== ""
        ? [element("p", "column-empty", copy.appsNoMatch)]
        : parts),
    );
  }

  /** Draws the route now shown from the catalog last read. */
  function render(route: PageRoute = options.route()) {
    const copy = options.copy();
    search.placeholder = copy.appsSearch;
    search.setAttribute("aria-label", copy.appsSearchLabel);
    status.textContent =
      notice ??
      (state === "loading"
        ? copy.catalogLoading
        : state === "failed"
          ? copy.catalogLoadFailed
          : "");
    if (catalog === null) {
      tree.replaceChildren();
      body.replaceChildren();
      drawHeadless();
      return;
    }
    const scope = appsScope(catalog, route, copy);
    const selection = catalogSelection(catalog, route);
    home.href = scopeRoute(catalog, scope);
    if (
      (route.view === "home" || route.view === "organization") &&
      (selection.kind === "overview" || selection.kind === "organization")
    )
      home.setAttribute("aria-current", "page");
    else home.removeAttribute("aria-current");
    drawTree(catalog, scope, route);
    if (
      route.view !== "home" &&
      route.view !== "organization" &&
      route.view !== "module"
    )
      return;
    if (selection.kind === "missing") {
      head.hidden = false;
      drawHead(catalog, null);
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
    if (selection.kind !== "module") drawHead(catalog, scope);
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

  // Before the catalog is read: the head names the Launchpad.
  function drawHeadless() {
    const heading = element("h1", "apps-title", options.copy().homeTitle);
    heading.tabIndex = -1;
    heading.dataset.pageHeading = "";
    headName.replaceChildren(heading);
    head.hidden = false;
  }

  /** Reads the catalog again (on load, Refresh and a language change). */
  async function refresh() {
    refreshButton.disabled = true;
    state = catalog === null ? "loading" : state;
    render();
    try {
      const { value, ok } = await options.post("/api/catalog", {});
      const parsed = ok ? parseCatalog(value) : null;
      if (parsed === null) throw new Error("Catalog unavailable");
      catalog = parsed;
      state = "loaded";
    } catch {
      state = "failed";
    } finally {
      refreshButton.disabled = false;
      render();
      options.loaded();
    }
  }
  refreshButton.addEventListener("click", () => void refresh());
  search.addEventListener("input", () => render());

  return {
    render(route?: PageRoute) {
      // A move ends the sentence about the last tile, unless it is the move
      // to the overview that sentence explains.
      if (route !== undefined && route.view !== "module") notice = null;
      render(route);
    },
    refresh,
    /** The display name of an Organization slug, once known. */
    displayName(slug: string): string | undefined {
      const organization =
        catalog === null ? undefined : routeOrganization(catalog, slug);
      return organization === undefined
        ? undefined
        : organizationName(organization);
    },
  };
}
