import { filesUrlPath, parseUrlPath } from "../files/rules";
import type { MessageKey } from "./messages";

// The page routes of the Launchpad: one document served under each path, the
// section chosen in the browser from the path alone. The server serves the
// same bundled page for exactly these paths and nothing else; the credential
// never travels in the path (decision F15 addendum 2026-09-28).

/** The sections of Settings, in the order of the settings navigation. */
export const settingsSections = [
  "general",
  "machine",
  "tools",
  "recovery",
] as const;
export type SettingsSection = (typeof settingsSections)[number];

/** The section `/settings` itself opens. */
export const defaultSettingsSection: SettingsSection = "general";

/** The catalog (launchpad-parity B1) is the Launchpad home: `/` is every
 * Organization's modules, `/o/<org>` one Organization, `/o/<org>/<module>` one
 * module. `<org>` is the Organization slug and `<module>` the module id, both
 * as the catalog names them; whether they exist is the catalog's answer, not
 * the route's. */
export type PageRoute =
  | Readonly<{ view: "home" }>
  | Readonly<{ view: "organization"; organization: string }>
  | Readonly<{ view: "module"; organization: string; module: string }>
  | Readonly<{ view: "settings"; section: SettingsSection }>
  /** A folder of the Documents folder (decision F35): `/files` is the
   * folder itself, `/files/<name>/<name>` one below it. */
  | Readonly<{ view: "files"; path: readonly string[] }>
  /** The Marketplace of the Environment, at the foot of the Apps column
   * (decision F36 addendum of 2026-10-04): for now it says it is coming. */
  | Readonly<{ view: "marketplace" }>;

/** The frames of the page: the Apps home (home, Organization, module), the
 * Files page and the Marketplace beside the same Apps column, and Settings
 * with its navigation. */
export type PageFrame = "catalog" | "files" | "marketplace" | "settings";
export const routeFrame = (route: PageRoute): PageFrame =>
  route.view === "settings"
    ? "settings"
    : route.view === "files"
      ? "files"
      : route.view === "marketplace"
        ? "marketplace"
        : "catalog";

/** Every path the server answers with the page. The two catalog patterns are
 * the server's route parameters; the page reads its segments itself. */
export const pagePaths: readonly string[] = [
  "/",
  "/o/:organization",
  "/o/:organization/:module",
  "/files",
  "/files/*",
  "/marketplace",
  "/settings",
  ...settingsSections.map((section) => `/settings/${section}`),
];

export function settingsPath(section: SettingsSection): string {
  return `/settings/${section}`;
}

export function organizationPath(organization: string): string {
  return `/o/${encodeURIComponent(organization)}`;
}

export function modulePath(organization: string, module: string): string {
  return `${organizationPath(organization)}/${encodeURIComponent(module)}`;
}

// One path segment, decoded; null when it is empty or not valid encoding.
function segment(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const value = decodeURIComponent(input);
    return value && !/[/\0\r\n]/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The route of a location path. `/settings` and an unknown section open the
 * default section (the caller rewrites the address to its canonical path);
 * `/o/<org>` and `/o/<org>/<module>` are the catalog; anything else is the
 * Launchpad home. */
export function pageRoute(pathname: string): PageRoute {
  // A Files path keeps its encoding until the rules decode it; one they
  // refuse (a hidden name, an encoded separator) opens the Documents
  // folder itself. The server checks every path again on its platform.
  if (pathname === "/files" || pathname.startsWith("/files/")) {
    const parsed = parseUrlPath(pathname.slice("/files".length), "linux");
    return { view: "files", path: "segments" in parsed ? parsed.segments : [] };
  }
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/marketplace") return { view: "marketplace" };
  if (path.startsWith("/o/")) {
    const parts = path.slice("/o/".length).split("/");
    const organization = segment(parts[0]);
    const module = parts.length === 2 ? segment(parts[1]) : null;
    if (organization === null || parts.length > 2) return { view: "home" };
    if (parts.length === 1) return { view: "organization", organization };
    return module === null
      ? { view: "home" }
      : { view: "module", organization, module };
  }
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
  if (route.view === "home") return "/";
  if (route.view === "organization")
    return organizationPath(route.organization);
  if (route.view === "module")
    return modulePath(route.organization, route.module);
  if (route.view === "files") return filesUrlPath(route.path);
  if (route.view === "marketplace") return "/marketplace";
  return settingsPath(route.section);
}

/** The label of each section: the same words in the navigation, the
 * breadcrumb and the document title. */
export const sectionLabels: Readonly<Record<SettingsSection, MessageKey>> = {
  general: "settingsGeneral",
  machine: "machineTitle",
  tools: "toolsTitle",
  recovery: "recoveryTitle",
};

/** What the page says it is: the heading of the view (the current crumb) and
 * the document title. An Organization is named by its display name once the
 * catalog knows it, by the slug of its route until then. */
export function routeTitle(
  route: PageRoute,
  copy: Readonly<Record<MessageKey, string>>,
  displayName: (organization: string) => string | undefined = () => undefined,
): Readonly<{ heading: string; document: string }> {
  if (route.view === "home")
    return { heading: copy.homeTitle, document: copy.title };
  if (route.view === "organization") {
    const heading = displayName(route.organization) ?? route.organization;
    return { heading, document: `${heading} — ${copy.title}` };
  }
  if (route.view === "module") {
    const organization = displayName(route.organization) ?? route.organization;
    return {
      heading: route.module,
      document: `${route.module} · ${organization} — ${copy.title}`,
    };
  }
  if (route.view === "marketplace")
    return {
      heading: copy.appsMarketplace,
      document: `${copy.appsMarketplace} — ${copy.title}`,
    };
  if (route.view === "files") {
    const folder = route.path.at(-1);
    return {
      heading: copy.filesTitle,
      document:
        folder === undefined
          ? `${copy.filesTitle} — ${copy.title}`
          : `${folder} · ${copy.filesTitle} — ${copy.title}`,
    };
  }
  const heading = copy[sectionLabels[route.section]];
  return {
    heading,
    document: `${heading} · ${copy.settingsTitle} — ${copy.title}`,
  };
}
