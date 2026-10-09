import type { CatalogApp } from "../integrations/catalog-schema";
import type {
  CustomServer,
  IntegrationAccount,
  IntegrationApp,
  IntegrationsOverview,
  SourceState,
} from "../integrations/model";
import { forAdmin } from "../integrations/model";
import {
  type AppTool,
  appTools,
  integrationIdPattern,
  type PathChoice,
} from "../integrations/path";
import { pluralKey } from "./apps-view";
import type { MessageKey } from "./messages";
import type { IntegrationsTab } from "./routes";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Apps → Integrace (decision F42), what the page shows: pure, so it is tested
// without a DOM; integrations-panel.ts draws it. The approved wireframe
// (prototypes-lazurio `screens/Integrations.tsx`): the tabs Vše · Připojené
// (N) · Vlastní, cards with the app's mark, one line about it, the action and
// its accounts; a connected card says quietly which way it goes; where
// nothing connects an app, one line says why and one action follows.

/** Without a search, Vše shows this many cards before "Zobrazit všech". */
export const appsPreview = 24;

/** The documentation behind "Jak to funguje". */
export function integrationsHelp(locale: "cs" | "en"): string {
  return `https://documentation.lazurio.ai/${locale}/environment-app-connections/?utm_source=launchpad&utm_medium=product&utm_campaign=app-connections`;
}

const states = new Set(["connected", "expired", "pending", "failed"]);
const sourceStates = new Set([
  "ok",
  "unavailable",
  "absent",
  "unreadable",
  "signed-out",
  "not-allowed",
]);

function isChoice(value: unknown): value is PathChoice {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as Record<string, unknown>;
  if (choice.path === "direct") return true;
  if (choice.path === "composio") return typeof choice.signIn === "boolean";
  if (choice.path === "tool")
    return (appTools as readonly unknown[]).includes(choice.tool);
  if (choice.path !== null) return false;
  if (choice.missing === "path") return true;
  if (choice.missing === "tool")
    return (appTools as readonly unknown[]).includes(choice.tool);
  if (choice.missing === "company-app")
    return (
      typeof choice.provider === "string" &&
      (choice.action === "set-up" || choice.action === "ask-admin")
    );
  if (choice.missing === "composio")
    return choice.action === "allow" || choice.action === "ask-admin";
  return false;
}

function isAccount(value: unknown): value is IntegrationAccount {
  if (typeof value !== "object" || value === null) return false;
  const account = value as Record<string, unknown>;
  return (
    (account.path === "direct" || account.path === "composio") &&
    (account.selector === null || typeof account.selector === "string") &&
    (account.label === null || typeof account.label === "string") &&
    states.has(account.state as string) &&
    typeof account.spare === "boolean"
  );
}

function isApp(value: unknown): value is IntegrationApp {
  if (typeof value !== "object" || value === null) return false;
  const app = value as Record<string, unknown>;
  return (
    typeof app.id === "string" &&
    integrationIdPattern.test(app.id) &&
    typeof app.name === "string" &&
    isChoice(app.path) &&
    typeof app.connected === "boolean" &&
    Array.isArray(app.accounts) &&
    app.accounts.every(isAccount) &&
    typeof app.catalog === "boolean" &&
    (app.link === null || typeof app.link === "string")
  );
}

function isServer(value: unknown): value is CustomServer {
  if (typeof value !== "object" || value === null) return false;
  const server = value as Record<string, unknown>;
  return (
    typeof server.id === "string" &&
    typeof server.name === "string" &&
    (server.kind === "remote" || server.kind === "command") &&
    (server.target === null || typeof server.target === "string") &&
    (server.state === "ready" || states.has(server.state as string)) &&
    (server.tools === null ||
      (typeof server.tools === "number" && Number.isSafeInteger(server.tools)))
  );
}

/** `GET /api/integrations` as the page takes it, or null for any other
 * answer (a refusal, a shape of another version). */
export function parseIntegrations(value: unknown): IntegrationsOverview | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as Record<string, unknown>;
  const composio = answer.composio as Record<string, unknown> | null;
  const sources = answer.sources as Record<string, unknown> | null;
  if (
    answer.kind !== "integrations" ||
    (answer.locale !== "cs" && answer.locale !== "en") ||
    (answer.scope !== "organization" && answer.scope !== "personal") ||
    (answer.page !== null && typeof answer.page !== "string") ||
    typeof composio !== "object" ||
    composio === null ||
    typeof composio.allowed !== "boolean" ||
    (composio.source !== "organization" && composio.source !== "environment") ||
    typeof composio.ready !== "boolean" ||
    typeof sources !== "object" ||
    sources === null ||
    !["tools", "executor", "composio"].every((name) =>
      sourceStates.has(sources[name] as string),
    ) ||
    !Array.isArray(answer.tools) ||
    !answer.tools.every((tool) =>
      (appTools as readonly unknown[]).includes(tool),
    ) ||
    !Array.isArray(answer.apps) ||
    !answer.apps.every(isApp) ||
    !Array.isArray(answer.custom) ||
    !answer.custom.every(isServer) ||
    typeof answer.readAt !== "string"
  )
    return null;
  return answer as IntegrationsOverview;
}

/** Search without case and diacritics: "kalendar" finds Google Kalendář. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** The labels of the tabs: Připojené and Vlastní with their counts. */
export function tabLabels(
  overview: IntegrationsOverview | null,
  copy: Copy,
): Readonly<Record<IntegrationsTab, string>> {
  const connected = overview?.apps.filter((app) => app.connected).length ?? 0;
  const custom = overview?.custom.length ?? 0;
  const count = (label: string, n: number) => (n > 0 ? `${label} ${n}` : label);
  return {
    all: copy.integrationsTabAll,
    connected: count(copy.integrationsTabConnected, connected),
    custom: count(copy.integrationsTabCustom, custom),
  };
}

/** Accounts that need the person: expired sign-ins on an app's path. */
export function attentionCount(overview: IntegrationsOverview | null): number {
  return (
    overview?.apps.reduce(
      (sum, app) =>
        sum +
        app.accounts.filter(
          (account) => !account.spare && account.state === "expired",
        ).length,
      0,
    ) ?? 0
  );
}

/** What the catalog lists without a search (the wireframe's
 * `offeredApps`): every app where Composio is allowed, otherwise the apps
 * with a direct path here (on a personal Environment the one-click ones);
 * always the apps a connected tool connects and the apps connected here. */
export function offered(app: IntegrationApp): boolean {
  if (app.connected || app.accounts.length > 0) return true;
  // An Organization's company app is offered for its Admin to set up.
  return app.path.path !== null || app.path.missing === "company-app";
}

/** The apps of a tab, in the order the page shows them: connected first,
 * then what connects here, then what cannot yet; each group in catalog
 * order. A search finds every app; Vše without one lists what is offered. */
export function visibleApps(
  overview: IntegrationsOverview,
  catalog: readonly CatalogApp[],
  tab: IntegrationsTab,
  search: string,
): IntegrationApp[] {
  const wanted = normalize(search.trim());
  const describe = (app: IntegrationApp) => {
    const entry = catalog.find((item) => item.id === app.id);
    return [
      app.name,
      app.id,
      entry?.name.cs,
      entry?.name.en,
      entry?.description.cs,
      entry?.description.en,
    ];
  };
  const pool =
    tab === "connected"
      ? overview.apps.filter((app) => app.connected || app.accounts.length > 0)
      : wanted === ""
        ? overview.apps.filter(offered)
        : overview.apps;
  const matching =
    wanted === ""
      ? pool
      : pool.filter((app) =>
          describe(app).some(
            (text) => text !== undefined && normalize(text).includes(wanted),
          ),
        );
  const rank = (app: IntegrationApp) =>
    app.connected ? 0 : app.path.path !== null ? 1 : 2;
  return matching
    .map((app, index) => ({ app, index }))
    .sort((a, b) => rank(a.app) - rank(b.app) || a.index - b.index)
    .map(({ app }) => app);
}

/** The quiet label of a connected card: přímo, přes Composio, přes <tool>. */
export function pathLabel(choice: PathChoice, copy: Copy): string | null {
  if (choice.path === "direct") return copy.integrationsPathDirect;
  if (choice.path === "composio") return copy.integrationsPathComposio;
  if (choice.path === "tool")
    return fill(copy.integrationsPathTool, { tool: choice.tool });
  return null;
}

/** The company apps by the names a card says. */
const providerNames: Readonly<Record<string, string>> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** What a card offers: connect (or another account), what is missing with
 * its one action, or nothing (through its tool it is just there). */
export type CardAction =
  | Readonly<{ kind: "connect"; label: string; path: "direct" | "composio" }>
  | Readonly<{ kind: "open-tools"; label: string }>
  | Readonly<{ kind: "set-up"; label: string }>
  | Readonly<{ kind: "allow"; label: string }>
  | Readonly<{ kind: "ask-admin"; label: string }>
  | Readonly<{ kind: "none" }>;

export type CardView = Readonly<{
  /** The line under the name: the app's sentence, why nothing connects it,
   * or that a connection waits for the browser. */
  line: string;
  connected: boolean;
  pathLabel: string | null;
  action: CardAction;
  /** Whether connecting goes through Composio, a third party: the form
   * says so in one sentence. */
  composio: boolean;
}>;

export function cardView(
  app: IntegrationApp,
  entry: CatalogApp | undefined,
  options: Readonly<{
    locale: "cs" | "en";
    scope: IntegrationsOverview["scope"];
    admin: boolean;
    copy: Copy;
  }>,
): CardView {
  const { copy } = options;
  const choice = forAdmin(app.path, options.admin);
  const about = entry?.description[options.locale] ?? app.name;
  const own = app.accounts.filter((account) => !account.spare);
  const waiting =
    !app.connected &&
    own.length > 0 &&
    own.every((account) => account.state === "pending");
  const label = pathLabel(choice, copy);
  if (choice.path === "tool")
    return {
      line: about,
      connected: true,
      pathLabel: label,
      action: { kind: "none" },
      composio: false,
    };
  if (choice.path === "direct" || choice.path === "composio")
    return {
      line: waiting ? copy.integrationsFinishInBrowser : about,
      connected: app.connected,
      pathLabel: app.connected ? label : null,
      action: {
        kind: "connect",
        label: own.some(
          (account) =>
            account.state === "connected" || account.state === "expired",
        )
          ? copy.integrationsAddAccount
          : copy.integrationsConnect,
        path: choice.path,
      },
      composio: choice.path === "composio",
    };
  if (choice.missing === "path")
    return {
      line: copy.integrationsMissingPath,
      connected: false,
      pathLabel: null,
      action: { kind: "none" },
      composio: false,
    };
  if (choice.missing === "tool")
    return {
      line: fill(copy.integrationsMissingTool, { tool: choice.tool }),
      connected: false,
      pathLabel: null,
      action: { kind: "open-tools", label: copy.integrationsOpenTools },
      composio: false,
    };
  const line =
    choice.missing === "company-app"
      ? fill(copy.integrationsMissingCompanyApp, {
          provider: providerNames[choice.provider] ?? app.name,
        })
      : options.scope === "organization"
        ? copy.integrationsComposioOffOrganization
        : copy.integrationsComposioOffHere;
  const action: CardAction =
    choice.action === "ask-admin"
      ? { kind: "ask-admin", label: copy.integrationsAskAdmin }
      : choice.missing === "company-app"
        ? { kind: "set-up", label: copy.integrationsSetUpInDashboard }
        : { kind: "allow", label: copy.integrationsAllowComposio };
  return { line, connected: false, pathLabel: null, action, composio: false };
}

export type AccountView = Readonly<{
  name: string;
  /** Why it is not active, or that it is on another way; none when ok. */
  line: string | null;
  /** "Přihlásit znovu" or "Zkusit znovu"; none when ok, spare or waiting. */
  retry: string | null;
  disconnect: boolean;
}>;

export function accountView(
  account: IntegrationAccount,
  copy: Copy,
): AccountView {
  const name = account.label ?? copy.integrationsAccountUnnamed;
  if (account.spare)
    return {
      name,
      line:
        account.path === "direct"
          ? copy.integrationsAccountSpareDirect
          : copy.integrationsAccountSpareComposio,
      retry: null,
      disconnect: account.selector !== null,
    };
  const line =
    account.state === "expired"
      ? copy.integrationsAccountExpired
      : account.state === "pending"
        ? copy.integrationsAccountPending
        : account.state === "failed"
          ? copy.integrationsAccountFailed
          : null;
  const retry =
    account.state === "expired"
      ? copy.integrationsSignInAgain
      : account.state === "failed"
        ? copy.integrationsRetry
        : null;
  return { name, line, retry, disconnect: account.selector !== null };
}

/** The one consequence the disconnect dialog names. */
export function disconnectText(
  app: IntegrationApp,
  account: IntegrationAccount,
  composioAccount: string | null,
  copy: Copy,
): string {
  if (account.state === "pending")
    return fill(copy.integrationsDisconnectPending, { app: app.name });
  if (account.path === "direct") return copy.integrationsDisconnectDirect;
  return composioAccount === null
    ? copy.integrationsDisconnectComposioAny
    : fill(copy.integrationsDisconnectComposio, { account: composioAccount });
}

/** One line per source that could not be read, so a missing source is
 * never taken for "nothing connected". */
export function sourceLines(
  overview: IntegrationsOverview,
  copy: Copy,
): string[] {
  const lines: string[] = [];
  const executor: SourceState = overview.sources.executor;
  if (executor === "unavailable")
    lines.push(copy.integrationsExecutorUnavailable);
  if (executor === "absent") lines.push(copy.integrationsExecutorAbsent);
  if (executor === "unreadable")
    lines.push(copy.integrationsExecutorUnreadable);
  if (overview.sources.composio === "unreadable" && overview.composio.ready)
    lines.push(copy.integrationsComposioUnreadable);
  if (overview.sources.tools !== "ok")
    lines.push(copy.integrationsToolsUnreadable);
  return lines;
}

/** "Připojeno · 5 nástrojů", "Nepodařilo se spustit", "Spouštím…". */
export function serverLine(server: CustomServer, copy: Copy): string {
  if (server.state === "failed" || server.state === "expired")
    return copy.integrationsMcpFailed;
  if (server.state === "pending") return copy.integrationsMcpPending;
  if (server.tools === null) return copy.integrationsMcpReady;
  return fill(copy.integrationsMcpTools, {
    tools: fill(
      copy[
        pluralKey(server.tools, {
          one: "integrationsToolsOne",
          few: "integrationsToolsFew",
          many: "integrationsToolsMany",
        })
      ],
      { count: String(server.tools) },
    ),
  });
}

/** The monogram of an app without a bundled icon: its first letter. */
export function monogram(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** The tools a person can open for an app only its tool connects. */
export function toolOf(choice: PathChoice): AppTool | null {
  return choice.path === null && choice.missing === "tool" ? choice.tool : null;
}
