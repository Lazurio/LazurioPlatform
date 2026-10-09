import type { CatalogApp, IntegrationsCatalog } from "./catalog-schema";
import type { ComposioAccount } from "./composio-source";
import {
  type AppTool,
  choosePath,
  type Path,
  type PathApp,
  type PathChoice,
  type Rules,
} from "./path";
import type { ComposioPolicy } from "./policy";

// The Integrace of one Environment (decision F42): one list for people and
// agents, every catalog app with its one path and its accounts, the apps a
// connected tool connects, the apps connected in Executor or Composio that
// the catalog does not know, and the custom MCP servers. Pure: three sources
// go in, each with its own state, and one source down never hides the others
// (a missing source stays explicit as its state, never as "nothing
// connected").

/** The state of one source of the reading. */
export type SourceState =
  | "ok"
  /** Not there to ask: not installed, not running, not this account's. */
  | "unavailable"
  /** It answered something this product does not understand. */
  | "unreadable"
  /** Installed but not signed in (Composio). */
  | "signed-out"
  /** Composio is not allowed here (decision 0194). */
  | "not-allowed";

export type AccountState = "connected" | "expired" | "pending" | "failed";

/** One connection of an app as Executor holds it. */
export type ExecutorConnection = Readonly<{
  /** What names it to disconnect it: `<owner>/<integration>/<name>`. */
  id: string;
  /** The integration (Executor source) it belongs to. */
  integration: string;
  /** The account as a person knows it: the name given when connecting, the
   * account the provider names, or none. */
  label: string | null;
  state: AccountState;
}>;

/** One integration (a source of tools) Executor holds. */
export type ExecutorIntegration = Readonly<{
  /** Executor's id of the source: its slug. */
  slug: string;
  name: string;
  kind: "remote" | "command" | "api";
  /** The remote MCP endpoint, or the command line of a command server. */
  target: string | null;
  /** How many tools it offers, once known. */
  tools: number | null;
}>;

export type ExecutorReading =
  | Readonly<{
      state: "ok";
      integrations: readonly ExecutorIntegration[];
      connections: readonly ExecutorConnection[];
    }>
  | Readonly<{ state: "unavailable" | "unreadable" }>;

export type ComposioReadingState =
  | Readonly<{ state: "ok"; accounts: readonly ComposioAccount[] }>
  | Readonly<{ state: "unavailable" | "unreadable" | "signed-out" }>;

/** What the tools say: which tools for one app are connected here. */
export type ToolsReading =
  | Readonly<{ state: "ok"; connected: readonly AppTool[] }>
  | Readonly<{ state: "unavailable" | "unreadable" }>;

export type IntegrationAccount = Readonly<{
  path: Path;
  /** What disconnects it: Executor's connection id, Composio's word id;
   * null where this account cannot be named from here. */
  selector: string | null;
  /** The name the person gave it, Composio's alias or Executor's name. */
  label: string | null;
  state: AccountState;
  /** On another way than the app's one path: not used by the agents. */
  spare: boolean;
}>;

export type IntegrationApp = Readonly<{
  id: string;
  name: string;
  /** The app's one path here, or what is missing and who acts. Computed
   * for a person who is not the Organization's Admin; `forAdmin` turns it
   * for one who is. */
  path: PathChoice;
  /** Connected: through its tool, or an active account on its path. */
  connected: boolean;
  accounts: readonly IntegrationAccount[];
  /** Whether the app is in the catalog (otherwise only connected here). */
  catalog: boolean;
  /** The app's card in the Launchpad (`<origin>/integrations/app/<id>`), the
   * link an agent sends; null where no browser reaches the Launchpad. */
  link: string | null;
}>;

export type CustomServer = Readonly<{
  /** Executor's slug of the server. */
  id: string;
  name: string;
  kind: "remote" | "command";
  /** The address of a remote server; a command server's is not shown. */
  target: string | null;
  state: AccountState | "ready";
  tools: number | null;
}>;

export type IntegrationsOverview = Readonly<{
  kind: "integrations";
  locale: "cs" | "en";
  scope: Rules["scope"];
  /** Apps → Integrace of this Environment; null where no browser reaches
   * the Launchpad (a workstation names the page instead). */
  page: string | null;
  composio: Readonly<{
    allowed: boolean;
    source: ComposioPolicy["source"];
    /** Installed, signed in and on for agents here. */
    ready: boolean;
  }>;
  sources: Readonly<{
    tools: SourceState;
    executor: SourceState;
    composio: SourceState;
  }>;
  /** The tools for one app that are connected here. */
  tools: readonly AppTool[];
  apps: readonly IntegrationApp[];
  custom: readonly CustomServer[];
  /** When the sources were read (ISO 8601). */
  readAt: string;
}>;

export type MergeInput = Readonly<{
  catalog: IntegrationsCatalog;
  locale: "cs" | "en";
  scope: Rules["scope"];
  /** The Launchpad's external origin from the Machine handover, if any. */
  origin: string | null;
  policy: ComposioPolicy;
  /** Composio installed, signed in and on for agents. */
  composioReady: boolean;
  tools: ToolsReading;
  executor: ExecutorReading;
  composio: ComposioReadingState;
  readAt: string;
}>;

/** The tools for one app connected here, as the rule counts them: gogcli
 * only on a personal Environment (root decision 0162, addendum of
 * 2026-10-09, point 5). */
export function countedTools(
  connected: readonly AppTool[],
  scope: Rules["scope"],
): AppTool[] {
  return connected.filter((tool) => tool !== "gogcli" || scope === "personal");
}

const pathAppOf = (app: CatalogApp): PathApp => ({
  id: app.id,
  ...(app.direct === undefined ? {} : { direct: { auth: app.direct.auth } }),
  composio: app.composio !== undefined,
  ...(app.tool === undefined ? {} : { tool: app.tool }),
});

/** An endpoint as the page shows it and as two are compared: scheme, host
 * and path, never userinfo or a query, which may carry a key. */
export function shownEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Which catalog app an Executor integration is: the catalog's integration
 * slug, or the same MCP endpoint. */
export function catalogAppOf(
  catalog: IntegrationsCatalog,
  integration: Pick<ExecutorIntegration, "slug" | "target">,
): CatalogApp | undefined {
  return catalog.apps.find(
    (app) =>
      app.direct !== undefined &&
      (app.direct.integration === integration.slug ||
        (app.direct.endpoint !== undefined &&
          integration.target !== null &&
          shownEndpoint(app.direct.endpoint) ===
            shownEndpoint(integration.target))),
  );
}

/** The one list (decision F42). */
export function mergeIntegrations(input: MergeInput): IntegrationsOverview {
  const { catalog, locale, scope, policy } = input;
  const rules: Rules = {
    scope,
    composio: policy.allowed,
    // The Organization's company apps arrive with plan DEV-6626 task 685.
    companyApps: [],
  };
  const tools =
    input.tools.state === "ok"
      ? countedTools(input.tools.connected, scope)
      : [];
  // Direct accounts by app id; integrations the catalog does not know are
  // the custom servers.
  const direct = new Map<string, IntegrationAccount[]>();
  const custom: CustomServer[] = [];
  if (input.executor.state === "ok") {
    const connections = input.executor.connections;
    for (const integration of input.executor.integrations) {
      const own = connections.filter(
        (connection) => connection.integration === integration.slug,
      );
      const app = catalogAppOf(catalog, integration);
      if (app === undefined) {
        if (integration.kind === "api") continue;
        custom.push(
          Object.freeze({
            id: integration.slug,
            name: integration.name,
            kind: integration.kind,
            target: integration.kind === "remote" ? integration.target : null,
            state: serverState(own),
            tools: integration.tools,
          }),
        );
        continue;
      }
      const accounts = direct.get(app.id) ?? [];
      for (const connection of own)
        accounts.push({
          path: "direct",
          selector: connection.id,
          label: connection.label,
          state: connection.state,
          spare: false,
        });
      direct.set(app.id, accounts);
    }
  }
  // Composio's accounts count only where Composio is allowed and ready.
  const composioUsable =
    policy.allowed && input.composioReady && input.composio.state === "ok";
  const viaComposio = new Map<string, IntegrationAccount[]>();
  if (composioUsable && input.composio.state === "ok")
    for (const account of input.composio.accounts) {
      const accounts = viaComposio.get(account.toolkit) ?? [];
      accounts.push({
        path: "composio",
        selector: account.wordId,
        label: account.alias,
        state: account.state,
        spare: false,
      });
      viaComposio.set(account.toolkit, accounts);
    }
  const entry = (
    app: PathApp,
    name: string,
    accounts: IntegrationAccount[],
    inCatalog: boolean,
  ): IntegrationApp => {
    const path = choosePath({
      app,
      rules,
      signedIn: input.composioReady,
      admin: false,
      tools,
      connected: [...new Set(accounts.map((account) => account.path))],
    });
    const marked = accounts.map((account) =>
      Object.freeze({
        ...account,
        spare:
          path.path !== null &&
          path.path !== "tool" &&
          account.path !== path.path,
      }),
    );
    const connected =
      path.path === "tool" ||
      ((path.path === "direct" || path.path === "composio") &&
        marked.some(
          (account) =>
            !account.spare &&
            (account.state === "connected" || account.state === "expired"),
        ));
    return Object.freeze({
      id: app.id,
      name,
      path,
      connected,
      accounts: Object.freeze(marked),
      catalog: inCatalog,
      link:
        input.origin === null
          ? null
          : `${input.origin}/integrations/app/${encodeURIComponent(app.id)}`,
    });
  };
  const known = new Set<string>();
  const apps: IntegrationApp[] = catalog.apps.map((app) => {
    const toolkit = app.composio;
    if (toolkit !== undefined) known.add(toolkit);
    return entry(
      pathAppOf(app),
      app.name[locale],
      [
        ...(direct.get(app.id) ?? []),
        ...(toolkit === undefined ? [] : (viaComposio.get(toolkit) ?? [])),
      ],
      true,
    );
  });
  // Composio's accounts of toolkits the catalog does not know.
  for (const [toolkit, accounts] of viaComposio)
    if (!known.has(toolkit))
      apps.push(
        entry({ id: toolkit, composio: true }, toolkit, accounts, false),
      );
  return Object.freeze({
    kind: "integrations",
    locale,
    scope,
    page: input.origin === null ? null : `${input.origin}/integrations`,
    composio: Object.freeze({
      allowed: policy.allowed,
      source: policy.source,
      ready: input.composioReady,
    }),
    sources: Object.freeze({
      tools: input.tools.state,
      executor: input.executor.state,
      composio: !policy.allowed ? "not-allowed" : input.composio.state,
    }),
    tools: Object.freeze(tools),
    apps: Object.freeze(apps),
    custom: Object.freeze(custom),
    readAt: input.readAt,
  });
}

function serverState(
  connections: readonly ExecutorConnection[],
): CustomServer["state"] {
  if (connections.length === 0) return "ready";
  if (connections.some((connection) => connection.state === "connected"))
    return "connected";
  return connections[0]?.state ?? "ready";
}

/** The path as a person who is the Organization's Admin or Owner sees it:
 * they set up a company app and allow Composio themselves. */
export function forAdmin(choice: PathChoice, admin: boolean): PathChoice {
  if (!admin || choice.path !== null) return choice;
  if (choice.missing === "company-app" && choice.action === "ask-admin")
    return { ...choice, action: "set-up" };
  if (choice.missing === "composio" && choice.action === "ask-admin")
    return { ...choice, action: "allow" };
  return choice;
}
