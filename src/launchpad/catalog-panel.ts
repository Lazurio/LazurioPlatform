import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
} from "../organizations/catalog";
import {
  catalogSelection,
  catalogStatus,
  moduleRoute,
  organizationName,
  organizationRoute,
  parseCatalog,
  routeOrganization,
  teamGroups,
  usesLegacyTeamAlias,
} from "./catalog-view";
import type { MessageKey } from "./messages";
import type { PageRoute } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The Launchpad home (launchpad-parity B1) in T3 Code's sidebar pattern: the
// Organizations are the sidebar's groups (T3's projects), their modules its
// rows with a status dot (T3's threads), a subheader per Team; the main view
// shows every module (`/`), one Organization (`/o/<org>`) or one module
// (`/o/<org>/<module>`). Every value from the server is drawn with
// textContent. A row has no action in this slice: start, open, stop and logs
// come with the module lifecycle (P5), and their place is left empty, not
// filled with a disabled button.
export function createCatalogPanel(
  options: Readonly<{
    post: (
      path: string,
      body: unknown,
    ) => Promise<{ value: unknown; ok: boolean }>;
    copy: () => Copy;
    /** The route now shown. */
    route: () => PageRoute;
    /** The catalog changed: names in the heading may have changed. */
    loaded: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing catalog UI");
    return element;
  };
  const tree = find<HTMLDivElement>("#catalog-tree");
  const home = find<HTMLAnchorElement>("#catalog-home");
  const body = find<HTMLDivElement>("#catalog-body");
  const status = find<HTMLParagraphElement>("#catalog-status");
  const refreshButton = find<HTMLButtonElement>("#catalog-refresh");
  let catalog: Catalog | null = null;
  let state: "loading" | "loaded" | "failed" = "loading";

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
  const routeLink = (href: string, className: string, content?: string) => {
    const link = element("a", className, content);
    link.href = href;
    link.dataset.route = "";
    return link;
  };
  // A link where the candidate has a route of its own, plain text otherwise:
  // two candidates of one slug never share a link.
  const maybeLink = (
    href: string | null,
    className: string,
    content?: string,
  ): HTMLElement =>
    href === null
      ? element("span", className, content)
      : routeLink(href, className, content);
  const dot = (ready: boolean) => {
    const mark = element("span", "dot");
    mark.dataset.state = ready ? "ready" : "blocked";
    mark.setAttribute("aria-hidden", "true");
    return mark;
  };
  const statusLine = (entry: { executable: boolean; reason?: string }) => {
    const copy = options.copy();
    const view = catalogStatus(entry, copy);
    const line = element("p", "row-status catalog-status");
    line.dataset.state = view.state;
    line.append(dot(view.state === "ready"), view.text);
    if (view.code !== null) line.append(" ", element("code", "", view.code));
    return line;
  };
  const row = (title: Node | string, ...rest: Node[]) => {
    const item = element("div", "row");
    const main = element("div", "row-main");
    const copy = element("div", "row-copy");
    const heading = element("div", "row-title");
    heading.append(title);
    copy.append(heading, ...rest);
    // The place of the module's primary action (P5) stays empty.
    main.append(copy);
    item.append(main);
    return item;
  };
  const fact = (label: string, value: string | readonly string[]) => {
    const item = element("div", "row");
    const main = element("div", "row-main");
    const term = element("dt", "", label);
    const detail = element("dd");
    if (typeof value === "string") detail.textContent = value;
    else {
      const list = element("ul");
      list.replaceChildren(...value.map((line) => element("li", "", line)));
      detail.replaceChildren(list);
    }
    main.append(term, detail);
    item.append(main);
    return item;
  };
  const group = (heading: Node | string, ...children: Node[]) => {
    const section = element("section", "group");
    const head = element("div", "group-head");
    const title = element("h2");
    title.append(heading);
    head.append(title);
    section.append(head, ...children);
    return section;
  };
  const teamBadges = (
    module: CatalogModule,
    organization: CatalogOrganization,
  ) =>
    module.teams.map((slug) =>
      element(
        "span",
        "badge",
        organization.teams.find((team) => team.slug === slug)?.displayName ??
          slug,
      ),
    );

  // One module as a row of a card: name, Teams, default app, whether it runs.
  function moduleRow(
    value: Catalog,
    organization: CatalogOrganization,
    module: CatalogModule,
  ): HTMLElement {
    const copy = options.copy();
    const title = maybeLink(
      moduleRoute(value, organization, module),
      "",
      module.module,
    );
    const item = row(title, statusLine(module));
    item
      .querySelector(".row-title")
      ?.append(...teamBadges(module, organization));
    const app = element(
      "p",
      "row-desc",
      `${copy.catalogDefaultApp}: ${module.defaultApp ?? copy.catalogNone}`,
    );
    item.querySelector(".row-title")?.after(app);
    return item;
  }

  function modulesCard(
    value: Catalog,
    organization: CatalogOrganization,
    modules: readonly CatalogModule[],
  ) {
    const card = element("div", "card");
    card.append(
      ...modules.map((module) => moduleRow(value, organization, module)),
    );
    return card;
  }

  // The modules of one Organization under a subheader per Team.
  function organizationModules(
    value: Catalog,
    organization: CatalogOrganization,
  ): Node[] {
    const copy = options.copy();
    if (organization.modules.length === 0)
      return organization.reason === undefined
        ? [element("p", "intro", copy.catalogNoModules)]
        : [];
    return teamGroups(organization, copy).flatMap((entry) => [
      ...(entry.team === null
        ? []
        : [element("h3", "catalog-team", entry.team.displayName)]),
      modulesCard(value, organization, entry.modules),
    ]);
  }

  function organizationFacts(organization: CatalogOrganization) {
    const copy = options.copy();
    const facts = element("dl", "card");
    facts.append(
      fact(copy.catalogDirectory, organization.directory),
      fact(copy.catalogState, organization.state ?? copy.catalogNone),
      ...(organization.teams.length === 0
        ? []
        : [
            fact(
              copy.catalogTeams,
              organization.teams.map((team) => team.displayName),
            ),
          ]),
      // Once per Organization, never per module: it helps migrate the manifest.
      ...(usesLegacyTeamAlias(organization)
        ? [fact(copy.catalogTeamSource, copy.catalogLegacyTeamAlias)]
        : []),
      fact(
        copy.catalogIssues,
        organization.issues.length === 0
          ? copy.catalogNone
          : organization.issues,
      ),
    );
    return facts;
  }

  function overview(value: Catalog): Node[] {
    const copy = options.copy();
    if (value.organizations.length === 0)
      return [element("p", "callout", copy.catalogEmpty)];
    return value.organizations.map((organization) => {
      const name = organizationName(organization);
      const href = organizationRoute(value, organization);
      const heading = href === null ? name : routeLink(href, "", name);
      const section = group(heading);
      if (!organization.executable || organization.modules.length === 0)
        section.querySelector(".group-head")?.append(statusLine(organization));
      section.append(...organizationModules(value, organization));
      return section;
    });
  }

  function organizationView(
    value: Catalog,
    organization: CatalogOrganization,
  ): Node[] {
    const copy = options.copy();
    return [
      statusLine(organization),
      organizationFacts(organization),
      group(copy.catalogModules, ...organizationModules(value, organization)),
    ];
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
      ...candidates.map((organization) =>
        row(
          maybeLink(
            organizationRoute(value, organization),
            "",
            organization.directory,
          ),
          statusLine(organization),
        ),
      ),
    );
    return [element("p", "callout", copy.catalogReasonDuplicate), card];
  }

  function moduleView(
    organization: CatalogOrganization,
    module: CatalogModule,
  ): Node[] {
    const copy = options.copy();
    const facts = element("dl", "card");
    facts.append(
      fact(copy.catalogOrganization, organizationName(organization)),
      fact(
        copy.catalogTeams,
        module.teams.length === 0
          ? copy.catalogNone
          : module.teams.map(
              (slug) =>
                organization.teams.find((team) => team.slug === slug)
                  ?.displayName ?? slug,
            ),
      ),
      fact(
        copy.catalogApps,
        module.apps.length === 0
          ? copy.catalogNone
          : module.apps.map((app) =>
              app.package === module.defaultApp
                ? `${app.package} (${copy.catalogDefaultMark})`
                : app.package,
            ),
      ),
      fact(copy.catalogPath, module.path),
      fact(copy.catalogState, module.state),
      ...(module.issues === undefined || module.issues.length === 0
        ? []
        : [fact(copy.catalogIssues, module.issues)]),
    );
    return [statusLine(module), facts];
  }

  // The sidebar: every Organization as a group, its modules as rows with a
  // status dot under a subheader per Team. A module of two Teams is a row
  // under both. A candidate links to the route that selects exactly it (its
  // slug, otherwise its directory name); one that no name selects, such as
  // one of two candidates of a slug, is a group without a link, named with
  // its reason.
  function drawTree(value: Catalog, route: PageRoute) {
    const copy = options.copy();
    const selection = catalogSelection(value, route);
    tree.replaceChildren(
      ...value.organizations.map((organization) => {
        const section = element("div", "catalog-group");
        const name = organizationName(organization);
        const head = maybeLink(
          organizationRoute(value, organization),
          "menu-item catalog-org",
          name,
        );
        if (
          selection.kind === "organization" &&
          selection.organization === organization
        )
          head.setAttribute("aria-current", "page");
        if (organization.organization === null || !organization.executable) {
          head.prepend(dot(false));
          head.append(
            element(
              "span",
              "sr-only",
              `, ${catalogStatus(organization, copy).text}`,
            ),
          );
        }
        section.append(head);
        for (const entry of teamGroups(organization, copy)) {
          if (entry.team !== null)
            section.append(element("p", "catalog-sub", entry.team.displayName));
          const list = element("ul", "menu");
          list.append(
            ...entry.modules.map((module) => {
              const item = element("li");
              const link = maybeLink(
                moduleRoute(value, organization, module),
                "menu-item catalog-module",
              );
              const view = catalogStatus(module, copy);
              link.append(
                dot(view.state === "ready"),
                element("span", "catalog-name", module.module),
                element(
                  "span",
                  "sr-only",
                  `, ${view.state === "ready" ? copy.catalogReady : view.text}`,
                ),
              );
              if (selection.kind === "module" && selection.module === module)
                link.setAttribute("aria-current", "page");
              item.append(link);
              return item;
            }),
          );
          section.append(list);
        }
        return section;
      }),
    );
  }

  /** Draws the route now shown from the catalog last read. */
  function render(route: PageRoute = options.route()) {
    const copy = options.copy();
    if (route.view === "home") home.setAttribute("aria-current", "page");
    else home.removeAttribute("aria-current");
    status.textContent =
      state === "loading"
        ? copy.catalogLoading
        : state === "failed"
          ? copy.catalogLoadFailed
          : "";
    if (catalog === null) {
      tree.replaceChildren();
      body.replaceChildren();
      return;
    }
    drawTree(catalog, route);
    const selection = catalogSelection(catalog, route);
    if (selection.kind === "missing") {
      const missing = element("p", "callout");
      missing.append(
        copy.catalogNotFound,
        " ",
        routeLink("/", "", copy.catalogAll),
      );
      body.replaceChildren(missing);
    } else
      body.replaceChildren(
        ...(selection.kind === "overview"
          ? overview(catalog)
          : selection.kind === "organization"
            ? organizationView(catalog, selection.organization)
            : selection.kind === "ambiguous"
              ? ambiguousView(catalog, selection.candidates)
              : moduleView(selection.organization, selection.module)),
      );
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

  return {
    render,
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
