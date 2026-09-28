import type { MessageKey } from "./messages";
import { type PageRoute, pageRoute, routePath, routeTitle } from "./routes";

type Copy = Readonly<Record<MessageKey, string>>;

// The frame of the page in the pattern of T3 Code's settings: one sidebar
// that holds the settings navigation on a settings route, "Settings" or
// "Back" in its footer, a header with the breadcrumb, and one section shown
// at a time. The route is the path; the page never reloads to change it, so
// the credential held in page memory stays (docs/launchpad-development.md).
export function createShell(options: Readonly<{ copy: () => Copy }>) {
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

  function show() {
    const section = route.view === "settings" ? route.section : null;
    for (const view of views) view.hidden = view.dataset.view !== route.view;
    for (const element of sections)
      element.hidden = element.dataset.section !== section;
    for (const action of actions)
      action.hidden = action.dataset.sectionAction !== section;
    for (const link of navLinks)
      if (link.dataset.section === section)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    // The breadcrumb is a navigation landmark only inside Settings.
    if (route.view === "settings") crumbs.removeAttribute("role");
    else crumbs.setAttribute("role", "none");
    relabel();
  }

  function relabel() {
    const title = routeTitle(route, options.copy());
    heading.textContent = title.heading;
    document.title = title.document;
  }

  /** Moves to a route. `history` says what the address bar does; `focus`
   * moves the focus to the heading of the new view, so the next Tab starts
   * in it and a screen reader announces where the operator is. */
  function go(
    next: PageRoute,
    how: Readonly<{ history: "push" | "replace"; focus: boolean }>,
  ) {
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
    if (how.focus) heading.focus({ preventScroll: true });
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

  // Every link of the frame is a real link (it opens in a new tab as
  // itself); a plain click moves within the page instead.
  const links = [
    ...navLinks,
    ...document.querySelectorAll<HTMLAnchorElement>(
      "#settings-open, #settings-back, #wordmark, #crumb-settings",
    ),
  ];
  for (const link of links)
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
    /** The copy changed (the profile's language was loaded). */
    relabel,
  };
}
