import { filesUrlPath, parseUrlPath } from "../files/rules";
import { customServerIdPattern } from "../integrations/custom-server";
import { integrationIdPattern } from "../integrations/path";
import { isServiceId } from "../organizations/server-services";
import { isSecretRequestId, secretRequestPath } from "../vault/request-id";
import { offerById } from "./marketplace";
import type { MessageKey } from "./messages";

// The page routes of the Launchpad: one document served under each path, the
// section chosen in the browser from the path alone. The server serves the
// same bundled page for exactly these paths and nothing else; the credential
// never travels in the path (decision F15 addendum 2026-09-28).

/** The sections of Settings, in the order of the settings navigation.
 * `start` is Nastavení → Začínáme, the Environment's onboarding from live
 * facts (root decision 0201 point 1), first where the Environment has it.
 * `buddy` is Nastavení → Buddy (decision F65), only on an Osobní Prostředí
 * with Buddy, last as the wireframe has it. Trezor is no section: it is a
 * page of the Apps column (F53's addendum of 2026-10-18), whose old
 * addresses here still lead to it. */
export const settingsSections = [
  "start",
  "general",
  "communication",
  "machine",
  "tools",
  "ssh",
  "recovery",
  "buddy",
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
  /** A service repository's page, "Informace o repozitáři" (root decision
   * 0209 point 6, decision F32's addendum of 2026-10-24):
   * `/o/<org>/productionspace/<repository>`, `<repository>` its slug in the
   * catalog. A production repository without a service of this Environment
   * has no page (F32's final addendum). */
  | Readonly<{
      view: "repository";
      organization: string;
      repository: string;
    }>
  /** A section of Settings. */
  | Readonly<{ view: "settings"; section: SettingsSection }>
  /** Trezor, the way into the Environment's own vault (root decision 0198
   * point 5), a page of the Apps column under Integrace (F53's addendum of
   * 2026-10-18): `/vault`, and `/vault/requests/<id>` the page of one
   * agent's secret request (`request`, decision F54). */
  | Readonly<{ view: "vault"; request?: string }>
  /** A folder of the Documents folder (decision F35): `/files` is the
   * folder itself, `/files/<name>/<name>` one below it. */
  | Readonly<{ view: "files"; path: readonly string[] }>
  /** The Marketplace of the Environment, at the foot of the Apps column
   * (decision F36 addendum of 2026-10-04, plan DEV-6593): `/marketplace`
   * is its catalog, `/marketplace/<offer>` one offer's detail. Whether the
   * offer exists is the catalog's answer (marketplace.ts), not the
   * route's. */
  | Readonly<{ view: "marketplace"; offer?: string }>
  /** Integrace of the Environment (decision F42): `/integrations` is the tab
   * Vše, `/integrations/connected` and `/integrations/custom` the two others,
   * and `/integrations/app/<id>` one app's card in Vše, the link an agent
   * sends. A card lives under `app/`, so no app id is ever a tab's name.
   * In Vlastní, `/integrations/custom/new` is the page that connects a
   * custom MCP server and `/integrations/custom/server/<id>` the same page
   * for one that exists (`form`, its id null for a new one; F42's addendum
   * of 2026-10-11). */
  | Readonly<{
      view: "integrations";
      tab: IntegrationsTab;
      app?: string;
      form?: Readonly<{ server: string | null }>;
    }>;

/** The tabs of Integrace: Vše · Připojené · Vlastní. */
export const integrationsTabs = ["all", "connected", "custom"] as const;
export type IntegrationsTab = (typeof integrationsTabs)[number];

/** The frames of the page: the Apps home (home, Organization, module), the
 * Files page, Integrace, Trezor and the Marketplace beside the same Apps
 * column, and Settings with its navigation. */
export type PageFrame =
  | "catalog"
  | "files"
  | "integrations"
  | "vault"
  | "marketplace"
  | "settings";
export const routeFrame = (route: PageRoute): PageFrame =>
  route.view === "settings"
    ? "settings"
    : route.view === "files"
      ? "files"
      : route.view === "integrations"
        ? "integrations"
        : route.view === "vault"
          ? "vault"
          : route.view === "marketplace"
            ? "marketplace"
            : "catalog";

/** Trezor's old addresses in Settings (F54 as amended on 2026-10-18): what
 * `lazurio vault request` printed into agents' threads before, which keep
 * them, so the server answers them for good and the page shows Trezor
 * there, rewriting the address to its own. */
export const legacyVaultPaths: readonly string[] = [
  "/settings/vault",
  "/settings/vault/requests/:id",
];

/** Every path the server answers with the page. The two catalog patterns are
 * the server's route parameters; the page reads its segments itself. */
export const pagePaths: readonly string[] = [
  "/",
  "/o/:organization",
  "/o/:organization/:module",
  "/o/:organization/productionspace/:repository",
  // A service's page, opened in the Environment browser and dropped from
  // the address (`serviceRequest`).
  "/service/:id",
  "/files",
  "/files/*",
  "/integrations",
  "/integrations/*",
  "/vault",
  "/vault/requests/:id",
  "/marketplace",
  "/marketplace/:offer",
  "/settings",
  ...settingsSections.map((section) => `/settings/${section}`),
  ...legacyVaultPaths,
];

export function settingsPath(section: SettingsSection): string {
  return `/settings/${section}`;
}

/** Trezor's page in the Apps column. */
export const vaultPath = "/vault";

export function organizationPath(organization: string): string {
  return `/o/${encodeURIComponent(organization)}`;
}

export function modulePath(organization: string, module: string): string {
  return `${organizationPath(organization)}/${encodeURIComponent(module)}`;
}

/** A service repository's page (root decision 0209 point 6). */
export function repositoryPath(
  organization: string,
  repository: string,
): string {
  return `${organizationPath(organization)}/productionspace/${encodeURIComponent(repository)}`;
}

/** The link of a service's page (root decision 0209 point 6, decision F32's
 * addendum of 2026-10-24): `/service/<id>` on this Launchpad opens the page
 * of this Environment's service `<id>` in its Environment browser. No route
 * of its own: the page takes the link once (`serviceRequest`) and shows the
 * Apps home under `/`, so the link leaves the address and Back never opens
 * the page again. Another Environment's Launchpad can link here (DEV-6674
 * phase 2). */
export function servicePath(service: string): string {
  return `/service/${encodeURIComponent(service)}`;
}

/** The service a location path asks to open (`servicePath`), or null: only
 * one segment that is a service's id, with or without a trailing slash. */
export function serviceRequest(pathname: string): string | null {
  const match = /^\/service\/([^/]+)\/?$/.exec(pathname);
  const service = segment(match?.[1]);
  return service !== null && isServiceId(service) ? service : null;
}

/** The path of an Integrace tab, or of one app's card. */
export function integrationsPath(
  tab: IntegrationsTab = "all",
  app?: string,
): string {
  if (app !== undefined) return `/integrations/app/${encodeURIComponent(app)}`;
  return tab === "all" ? "/integrations" : `/integrations/${tab}`;
}

/** The page of a custom MCP server: a new one (null), or one that exists. */
export function customServerPath(server: string | null): string {
  return server === null
    ? "/integrations/custom/new"
    : `/integrations/custom/server/${encodeURIComponent(server)}`;
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

/** Trezor's route below its page, `rest` the path after `/vault` (or after
 * the old `/settings/vault`): an agent's secret request has its own page;
 * anything else opens Trezor itself. */
function vaultRoute(rest: string): PageRoute {
  if (rest === "/requests" || rest.startsWith("/requests/")) {
    const request = segment(rest.slice("/requests/".length));
    if (request !== null && isSecretRequestId(request))
      return { view: "vault", request };
  }
  return { view: "vault" };
}

/** The route of a location path. `/settings` and an unknown section open the
 * default section (the caller rewrites the address to its canonical path);
 * `/o/<org>`, `/o/<org>/<module>` and `/o/<org>/productionspace/<repository>`
 * are the catalog; anything else, a service's link (`servicePath`) among
 * it, is the Launchpad home. */
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
  if (path.startsWith("/marketplace/")) {
    const parts = path.slice("/marketplace/".length).split("/");
    const offer = parts.length === 1 ? segment(parts[0]) : null;
    return offer === null
      ? { view: "marketplace" }
      : { view: "marketplace", offer };
  }
  // Trezor (F53's addendum of 2026-10-18): its page, and below it.
  if (path === "/vault" || path.startsWith("/vault/"))
    return vaultRoute(path.slice("/vault".length));
  // Its old addresses in Settings, kept for good (F54 as amended on
  // 2026-10-18): Trezor itself and an agent's secret request, the address
  // rewritten to the new one (`routePath`).
  if (
    path === "/settings/vault" ||
    path === "/settings/vault/requests" ||
    path.startsWith("/settings/vault/requests/")
  )
    return vaultRoute(path.slice("/settings/vault".length));
  // Integrace: a tab, or one app's card; anything else below opens Vše.
  if (path === "/integrations" || path.startsWith("/integrations/")) {
    const parts = path.slice("/integrations".length).split("/").slice(1);
    if (
      parts.length === 1 &&
      (parts[0] === "connected" || parts[0] === "custom")
    )
      return { view: "integrations", tab: parts[0] };
    if (parts[0] === "custom") {
      if (parts.length === 2 && parts[1] === "new")
        return { view: "integrations", tab: "custom", form: { server: null } };
      const server =
        parts.length === 3 && parts[1] === "server" ? segment(parts[2]) : null;
      return server !== null && customServerIdPattern.test(server)
        ? { view: "integrations", tab: "custom", form: { server } }
        : { view: "integrations", tab: "custom" };
    }
    const app =
      parts.length === 2 && parts[0] === "app" ? segment(parts[1]) : null;
    return app !== null && integrationIdPattern.test(app)
      ? { view: "integrations", tab: "all", app }
      : { view: "integrations", tab: "all" };
  }
  if (path.startsWith("/o/")) {
    const parts = path.slice("/o/".length).split("/");
    const organization = segment(parts[0]);
    const module = parts.length === 2 ? segment(parts[1]) : null;
    // A service repository's page (root decision 0209 point 6).
    const repository =
      parts.length === 3 && parts[1] === "productionspace"
        ? segment(parts[2])
        : null;
    if (organization !== null && repository !== null)
      return { view: "repository", organization, repository };
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

/** The frame of a location path and, in Settings, its section: what the
 * page shows before any of its modules runs (F36's addendum of 2026-10-08).
 * The inline script at the top of `index.html` computes the same from
 * `location.pathname` and writes it to `<html data-frame data-section>`;
 * `tests/launchpad-first-paint.test.ts` keeps the two equal. */
export function pageFrame(
  pathname: string,
): Readonly<{ frame: PageFrame; section: SettingsSection | null }> {
  const route = pageRoute(pathname);
  return {
    frame: routeFrame(route),
    section: route.view === "settings" ? route.section : null,
  };
}

/** The canonical path of a route: what the address bar shows for it. */
export function routePath(route: PageRoute): string {
  if (route.view === "home") return "/";
  if (route.view === "organization")
    return organizationPath(route.organization);
  if (route.view === "module")
    return modulePath(route.organization, route.module);
  if (route.view === "repository")
    return repositoryPath(route.organization, route.repository);
  if (route.view === "files") return filesUrlPath(route.path);
  if (route.view === "integrations")
    return route.form !== undefined
      ? customServerPath(route.form.server)
      : integrationsPath(route.tab, route.app);
  if (route.view === "marketplace")
    return route.offer === undefined
      ? "/marketplace"
      : `/marketplace/${encodeURIComponent(route.offer)}`;
  if (route.view === "vault")
    return route.request === undefined
      ? vaultPath
      : secretRequestPath(route.request);
  return settingsPath(route.section);
}

/** The label of each section: the same words in the navigation, the
 * breadcrumb and the document title. */
export const sectionLabels: Readonly<Record<SettingsSection, MessageKey>> = {
  start: "startTitle",
  general: "settingsGeneral",
  communication: "voiceTitle",
  machine: "machineTitle",
  tools: "toolsTitle",
  ssh: "sshTitle",
  recovery: "recoveryTitle",
  buddy: "buddyTitle",
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
  if (route.view === "repository") {
    const organization = displayName(route.organization) ?? route.organization;
    return {
      heading: route.repository,
      document: `${route.repository} · ${organization} — ${copy.title}`,
    };
  }
  if (route.view === "marketplace") {
    const offer =
      route.offer === undefined
        ? null
        : (offerById(route.offer)?.title ?? null);
    return offer === null
      ? {
          heading: copy.appsMarketplace,
          document: `${copy.appsMarketplace} — ${copy.title}`,
        }
      : {
          heading: offer,
          document: `${offer} · ${copy.appsMarketplace} — ${copy.title}`,
        };
  }
  if (route.view === "integrations")
    return {
      heading: copy.integrationsTitle,
      document:
        route.form === undefined
          ? `${copy.integrationsTitle} — ${copy.title}`
          : `${
              route.form.server === null
                ? copy.integrationsMcpPageTitle
                : copy.integrationsMcpEditTitle
            } · ${copy.integrationsTitle} — ${copy.title}`,
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
  if (route.view === "vault")
    return {
      heading: copy.vaultPageTitle,
      document:
        route.request === undefined
          ? `${copy.vaultPageTitle} — ${copy.title}`
          : `${copy.vaultRequestTitle} · ${copy.vaultPageTitle} — ${copy.title}`,
    };
  const heading = copy[sectionLabels[route.section]];
  return {
    heading,
    document: `${heading} · ${copy.settingsTitle} — ${copy.title}`,
  };
}
