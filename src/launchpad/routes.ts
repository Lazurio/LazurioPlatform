import type { MessageKey } from "./messages";

// The page routes of the Launchpad: one document served under each path, the
// section chosen in the browser from the path alone. The server serves the
// same bundled page for exactly these paths and nothing else; the credential
// never travels in the path (decision F15 addendum 2026-09-28).

/** The sections of Settings, in the order of the settings navigation. */
export const settingsSections = ["general", "machine", "tools"] as const;
export type SettingsSection = (typeof settingsSections)[number];

/** The section `/settings` itself opens. */
export const defaultSettingsSection: SettingsSection = "general";

export type PageRoute =
  | Readonly<{ view: "home" }>
  | Readonly<{ view: "settings"; section: SettingsSection }>;

/** Every path the server answers with the page. */
export const pagePaths: readonly string[] = [
  "/",
  "/settings",
  ...settingsSections.map((section) => `/settings/${section}`),
];

export function settingsPath(section: SettingsSection): string {
  return `/settings/${section}`;
}

/** The route of a location path. `/settings` and an unknown section open the
 * default section (the caller rewrites the address to its canonical path);
 * anything else is the Launchpad home. */
export function pageRoute(pathname: string): PageRoute {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path !== "/settings" && !path.startsWith("/settings/"))
    return { view: "home" };
  const section = path.slice("/settings/".length);
  return {
    view: "settings",
    section: (settingsSections as readonly string[]).includes(section)
      ? (section as SettingsSection)
      : defaultSettingsSection,
  };
}

/** The canonical path of a route: what the address bar shows for it. */
export function routePath(route: PageRoute): string {
  return route.view === "home" ? "/" : settingsPath(route.section);
}

/** The label of each section: the same words in the navigation, the
 * breadcrumb and the document title. */
export const sectionLabels: Readonly<Record<SettingsSection, MessageKey>> = {
  general: "settingsGeneral",
  machine: "machineTitle",
  tools: "toolsTitle",
};

/** What the page says it is: the heading of the view (the current crumb) and
 * the document title. */
export function routeTitle(
  route: PageRoute,
  copy: Readonly<Record<MessageKey, string>>,
): Readonly<{ heading: string; document: string }> {
  if (route.view === "home")
    return { heading: copy.homeTitle, document: copy.title };
  const heading = copy[sectionLabels[route.section]];
  return {
    heading,
    document: `${heading} · ${copy.settingsTitle} — ${copy.title}`,
  };
}
