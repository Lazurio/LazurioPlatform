import type { MessageKey } from "./messages";
import {
  organizationPath,
  type PageRoute,
  pageRoute,
  routeFrame,
  routePath,
  routeTitle,
} from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The frame of the page in the Lazurio shell (decision F36): beside the rail,
// one left column that holds the Apps column (search, all modules, Files and
// one Organization's modules) on the Apps home and the Files page and the
// settings navigation on a settings route with "Back" at its foot, a header
// with the breadcrumb on Settings and Files only, and one view shown at a
// time. The route is the path; the page never reloads to change it, so the
// credential held in page memory stays (docs/launchpad-development.md).
export function createShell(
  options: Readonly<{
    copy: () => Copy;
    /** The display name of an Organization slug, once the catalog knows it. */
    displayName?: (organization: string) => string | undefined;
    /** Called after every move, with the route now shown. */
    onRoute?: (route: PageRoute) => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing shell UI");
    return element;
  };
  const app = find<HTMLDivElement>("#app");
  const page = find<HTMLDivElement>("#page");
  const sidebar = find<HTMLElement>("#sidebar");
  const toggle = find<HTMLButtonElement>("#nav-toggle");
  const backdrop = find<HTMLDivElement>("#backdrop");
  const heading = find<HTMLHeadingElement>("#page-heading");
  const crumbs = find<HTMLElement>("#crumbs");
  const crumbsLabel = find<HTMLElement>("#crumbs-label");
  const crumbOrganization = find<HTMLLIElement>("#crumb-organization");
  const crumbOrganizationLink = find<HTMLAnchorElement>("#crumb-org");
  const navLinks = [
    ...document.querySelectorAll<HTMLAnchorElement>("#settings-nav a"),
  ];
  const views = [...document.querySelectorAll<HTMLElement>("[data-view]")];
  const sections = [
    ...document.querySelectorAll<HTMLElement>("main [data-section]"),
  ];
  const actions = [
    ...document.querySelectorAll<HTMLElement>("[data-section-action]"),
  ];
  const narrow = window.matchMedia("(max-width: 767px)");

  let route: PageRoute = pageRoute(location.pathname);
  // Recovery mode pins the page to one route: nothing else can be served.
  let pinned = false;

  function show() {
    const frame = routeFrame(route);
    const section = route.view === "settings" ? route.section : null;
    // An element names every frame it belongs to: the catalog's sidebar
    // also stands beside the Files page.
    for (const view of views)
      view.hidden = !(view.dataset.view ?? "").split(" ").includes(frame);
    for (const element of sections)
      element.hidden = element.dataset.section !== section;
    // A page action belongs to a settings section or to the whole catalog.
    for (const action of actions)
      action.hidden = action.dataset.sectionAction !== (section ?? frame);
    for (const link of navLinks)
      if (link.dataset.section === section)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    // A module sits under its Organization in the breadcrumb.
    crumbOrganization.hidden = route.view !== "module";
    if (route.view === "module")
      crumbOrganizationLink.href = organizationPath(route.organization);
    // The breadcrumb is a navigation landmark only where it has a parent.
    if (route.view === "settings" || route.view === "module")
      crumbs.removeAttribute("role");
    else crumbs.setAttribute("role", "none");
    relabel();
    options.onRoute?.(route);
  }

  function relabel() {
    const copy = options.copy();
    const title = routeTitle(route, copy, options.displayName);
    heading.textContent = title.heading;
    document.title = title.document;
    crumbsLabel.textContent =
      routeFrame(route) === "settings"
        ? copy.settingsBreadcrumb
        : copy.catalogBreadcrumb;
    if (route.view === "module")
      crumbOrganizationLink.textContent =
        options.displayName?.(route.organization) ?? route.organization;
  }

  /** Moves to a route. `history` says what the address bar does; `focus`
   * moves the focus to the heading of the new view, so the next Tab starts
   * in it and a screen reader announces where the operator is. */
  function go(
    next: PageRoute,
    how: Readonly<{ history: "push" | "replace"; focus: boolean }>,
  ) {
    if (pinned) next = route;
    const path = routePath(next);
    const moved = routePath(route) !== path;
    if (moved)
      // A dialog belongs to the section it was opened from; closing it ends
      // what it was doing (a running sign-in is cancelled).
      for (const dialog of document.querySelectorAll("dialog"))
        if (dialog.open) dialog.close();
    // The address bar always shows the canonical path of the route.
    if (location.pathname !== path)
      if (how.history === "push") history.pushState(null, "", path);
      else history.replaceState(null, "", path);
    route = next;
    show();
    if (moved) window.scrollTo(0, 0);
    if (how.focus) focusHeading();
  }

  // The heading of the view now shown: the Apps home and a module's
  // overview draw their own (`data-page-heading`), Settings and Files have
  // the one in the header.
  function focusHeading() {
    const own = document.querySelector<HTMLElement>(
      "main:not([hidden]) [data-page-heading]",
    );
    (own ?? heading).focus({ preventScroll: true });
  }

  function openSheet() {
    app.dataset.navOpen = "";
    toggle.setAttribute("aria-expanded", "true");
    page.inert = true;
    (
      sidebar.querySelector<HTMLElement>('[aria-current="page"]') ??
      sidebar.querySelector<HTMLElement>(".menu-item:not([hidden])") ??
      sidebar.querySelector<HTMLElement>("a")
    )?.focus();
  }
  function closeSheet(returnFocus: boolean) {
    if (!("navOpen" in app.dataset)) return;
    delete app.dataset.navOpen;
    toggle.setAttribute("aria-expanded", "false");
    page.inert = false;
    if (returnFocus) toggle.focus();
  }
  toggle.addEventListener("click", () =>
    "navOpen" in app.dataset ? closeSheet(true) : openSheet(),
  );
  backdrop.addEventListener("click", () => closeSheet(true));
  narrow.addEventListener("change", () => closeSheet(false));

  // Every link to a route (`data-route`: the frame's links, the catalog's
  // rows, drawn later) is a real link that opens in a new tab as itself; a
  // plain click moves within the page instead.
  document.addEventListener("click", (event) => {
    const target = event.target;
    const link =
      target instanceof Element
        ? target.closest<HTMLAnchorElement>("a[data-route]")
        : null;
    if (
      link === null ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const sheet = "navOpen" in app.dataset;
    closeSheet(false);
    // Within the settings navigation the focus stays on the chosen item,
    // as in T3 Code; everything else lands on the heading of the view.
    const withinNavigation = navLinks.includes(link) && !sheet;
    go(pageRoute(new URL(link.href).pathname), {
      history: "push",
      focus: !withinNavigation,
    });
    if (withinNavigation) link.focus();
  });
  // A link of the shell elements (the rail's gear, the current
  // Environment, the switch's Apps) on this origin: the same move, without
  // a reload (src/shell/elements.ts).
  document.addEventListener("lazurio-navigate", (event) => {
    const href = (event as CustomEvent<{ href?: unknown }>).detail?.href;
    if (
      typeof href !== "string" ||
      !href.startsWith("/") ||
      href.startsWith("//")
    )
      return;
    event.preventDefault();
    closeSheet(false);
    go(pageRoute(new URL(href, location.origin).pathname), {
      history: "push",
      focus: true,
    });
  });
  window.addEventListener("popstate", () =>
    go(pageRoute(location.pathname), { history: "replace", focus: true }),
  );

  // Escape leaves Settings (T3 Code's useEscapeToGoBack) unless something
  // else already took it: an open dialog, the open sheet, a form field.
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing
    )
      return;
    if ("navOpen" in app.dataset) {
      event.preventDefault();
      closeSheet(true);
      return;
    }
    const target = event.target;
    if (
      route.view !== "settings" ||
      document.querySelector("dialog[open]") !== null ||
      (target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)))
    )
      return;
    event.preventDefault();
    go({ view: "home" }, { history: "push", focus: true });
  });

  go(route, { history: "replace", focus: false });
  return {
    /** The copy or the catalog's names changed. */
    relabel,
    /** The route now shown. */
    route: () => route,
    /** Moves to the route of a path, as a click on its link does. */
    navigate(path: string) {
      closeSheet(false);
      go(pageRoute(path), { history: "push", focus: true });
    },
    /** Shows `next` and stays there: Recovery mode (docs/recovery.md). */
    pin(next: PageRoute) {
      go(next, { history: "replace", focus: false });
      pinned = true;
    },
  };
}
