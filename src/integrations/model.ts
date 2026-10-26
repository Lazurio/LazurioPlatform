import {
  type CatalogApp,
  canonicalEndpoint,
  type IntegrationsCatalog,
} from "./catalog-schema";
import {
  type ComposioAccount,
  composioAppsUrl,
  composioManageUrl,
  composioSelector,
} from "./composio-source";
import type { Microsoft365Here } from "./microsoft365";
// The card from its own module, made for the page: the rest of the company
// app hashes with `node:crypto`, whose browser stand-in the page's script
// must not carry (plan DEV-6656).
import {
  microsoft365Card,
  microsoft365ReplacedApps,
  microsoft365Slug,
} from "./microsoft365-card";
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
  /** Not there to ask: not installed (a tool, Composio), not running, not
   * this account's. */
  | "unavailable"
  /** Executor is no part of this Environment: Settings → Tools does not
   * offer it here or it is not installed (decision F44), so nothing connects
   * directly. */
  | "absent"
  /** It answered something this product does not understand. */
  | "unreadable"
  /** Installed but not signed in (Composio). */
  | "signed-out"
  /** Signed in, but off for agents here: its "Používají agenti" in
   * Settings → Tools is off, so nothing connects through it (Composio;
   * decision F42, note of 2026-10-19). */
  | "off"
  /** Signed in, but not working in the Composio organization of this
   * Environment's Organization's name (decision F42, addendum of
   * 2026-10-13): nothing of it counts, nothing connects through it. */
  | "organization"
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
  | Readonly<{ state: "unavailable" | "unreadable" | "absent" }>;

export type ComposioReadingState =
  | Readonly<{ state: "ok"; accounts: readonly ComposioAccount[] }>
  | Readonly<{
      state:
        | "unavailable"
        | "unreadable"
        | "signed-out"
        | "off"
        | "organization";
    }>;

/** What the tools say: which tools for one app are connected here. */
export type ToolsReading =
  | Readonly<{ state: "ok"; connected: readonly AppTool[] }>
  | Readonly<{ state: "unavailable" | "unreadable" }>;

export type IntegrationAccount = Readonly<{
  path: Path;
  /** What disconnects it: Executor's connection id; Composio's id where its
   * list prints one (Lazurio's build of the CLI, decision F42 addendum (3)),
   * else its word id; null where this account cannot be named from here. */
  selector: string | null;
  /** Its name: Executor's name, or Composio's alias, else the provider's
   * identity Composio knows for it (a mail address, a login, where the
   * list prints one); null where it has none ("účet"). */
  label: string | null;
  state: AccountState;
  /** On another way than the app's one path: not used by the agents. */
  spare: boolean;
  /** Where the person sees and changes a Composio account: the app's page in
   * their Composio organization (`composioManageUrl`; Composio has no page
   * of one account). Null for an account in Executor. */
  manage: string | null;
}>;

export type IntegrationApp = Readonly<{
  id: string;
  name: string;
  /** The app's one path here, or what is missing and who acts. Computed
   * for a person who is not the Organization's Admin; `forAdmin` turns it
   * for one who is. */
  path: PathChoice;
  /** Connected: through its tool, or an active account on its path; an
   * account whose sign-in expired or failed does not connect it. */
  connected: boolean;
  accounts: readonly IntegrationAccount[];
  /** Whether the app is in the catalog (otherwise only connected here,
   * named from its toolkit by `toolkitName`). */
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
    /** Whether "Odpojit" removes a Composio account here: the CLI removes
     * one without a prompt (`connections remove --yes`). */
    disconnect: boolean;
    /** Whether the page offers Composio's update (decision F42, addendum
     * (b) of 2026-10-14): Composio is on here (`ready`) but the installed
     * CLI is not the build Lazurio pins, and its update can work, as
     * Settings → Tools reads it (`pinnedUpdateOffered`), and the CLI does
     * not remove an account without a prompt yet: the line promises
     * disconnecting and names, which an earlier Lazurio build already has
     * (note of 2026-10-19). The update is Settings → Tools' own
     * (`/api/tools/upgrade`). */
    update: boolean;
    /** "Aplikace v Composiu" (decision F42, addendum of 2026-10-14): the
     * Apps section of the Composio organization this Environment works in,
     * where the person connects an app the catalog does not list; its
     * accounts then show here. Only where Composio's accounts count here
     * (allowed, ready, and its source read); null elsewhere. */
    apps: string | null;
    /** The Composio organization of this Environment's Organization's name
     * and how the person's account stands to it (decision F42, addendum (2)
     * of 2026-10-13): current; missing or there more than once, where
     * Composio works in the person's current organization with a notice;
     * there but not made current, or `unverified` where the Organization's
     * name (null) cannot be read, where nothing of Composio counts. On a
     * person's own Environment the account's default organization
     * (`default`, addendum of 2026-10-26), named as Composio names it:
     * current, or not made current. Null where the person chooses the
     * organization (a computer, or a personal Environment whose
     * organizations the CLI does not date) or it was not read. */
    organization: Readonly<{
      name: string | null;
      state: "matches" | "missing" | "ambiguous" | "elsewhere" | "unverified";
      default?: true;
    }> | null;
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
  /** The organization of the person's Composio sign-in (`current_org_name`
   * of `composio whoami`, read by the sign-in probe of Settings → Tools);
   * null where it is not known. */
  composioOrganization: string | null;
  /** The Composio organization of this Environment's Organization's name,
   * as `IntegrationsOverview.composio.organization`. */
  composioTarget?: IntegrationsOverview["composio"]["organization"];
  tools: ToolsReading;
  executor: ExecutorReading;
  composio: ComposioReadingState;
  /** The Composio sign-ins started in this Launchpad, by toolkit, in the
   * order they started, ended ones too while the Launchpad keeps them. A
   * pending account is listed only where a waiting one of them may be it
   * (`pendingOfSignIns`); any other is a sign-in nobody finishes. */
  composioSignIns?: ReadonlyMap<string, readonly ComposioSignIn[]>;
  /** The CLI removes an account without a prompt (`connections remove
   * --yes`). */
  composioDisconnect?: boolean;
  /** The installed CLI is not the build Lazurio pins and its update can
   * work here (`pinnedUpdateOffered` of its row in Settings → Tools). */
  composioUpdate?: boolean;
  /** The Organization's Microsoft 365 company app on this Environment
   * (decision F42 addendum (c) of 2026-10-14): its one card stands for
   * Outlook, OneDrive and SharePoint. Null or absent where none is set up. */
  microsoft365?: Microsoft365Here | null;
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
export const shownEndpoint = canonicalEndpoint;

/** The Composio toolkit of an app: the catalog's, or the app's own id for a
 * toolkit the catalog does not know (listed under its toolkit). */
export function composioToolkitOf(
  catalog: IntegrationsCatalog,
  appId: string,
): string {
  return catalog.apps.find((app) => app.id === appId)?.composio ?? appId;
}

/** The name of a Composio toolkit the catalog does not know, from its slug
 * alone (decision F42, addendum of 2026-10-14): its words, split at `_` and
 * `-`, each capitalised (`wispr_flow` is "Wispr Flow"). Nothing is asked
 * for it; the slug stays the app's id for agents. */
export function toolkitName(toolkit: string): string {
  const words = toolkit.split(/[_-]+/).filter((word) => word !== "");
  return words.length === 0
    ? toolkit
    : words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/** Which catalog app an Executor integration is: only a remote MCP server
 * at the catalog's own endpoint (the same scheme, host and path), whatever
 * its slug. A slug is never enough: an integration that holds an app's slug
 * and points elsewhere, or runs a command, is another server. It is listed
 * as custom, never under the app's card, and connecting the app refuses
 * (`integration-conflict`) rather than reusing it (decision F42). */
export function catalogAppOf(
  catalog: IntegrationsCatalog,
  integration: Pick<ExecutorIntegration, "kind" | "target">,
): CatalogApp | undefined {
  if (integration.kind !== "remote" || integration.target === null)
    return undefined;
  const target = canonicalEndpoint(integration.target);
  if (target === null) return undefined;
  return catalog.apps.find(
    (app) =>
      app.direct?.kind === "mcp" &&
      app.direct.endpoint !== undefined &&
      canonicalEndpoint(app.direct.endpoint) === target,
  );
}

/** A Composio sign-in started in this Launchpad, as the reading weighs its
 * toolkit's pending accounts (decision F42, addendum of 2026-10-12). */
export type ComposioSignIn = Readonly<{
  /** The word ids of the toolkit's pending accounts just before its link;
   * null where they could not be read. */
  earlier: readonly string[] | null;
  /** It still waits: not connected, ended, cancelled or expired. */
  waiting: boolean;
}>;

/** The pending accounts of one toolkit that a waiting sign-in started here
 * may be: one that appeared after the sign-in started and before the next
 * one of the toolkit did (or by now, after the last). The CLI names a
 * pending account only by its word id, so the sign-ins in their order are
 * the only correlation: an account older than every sign-in is one nobody
 * waits for, and one that appeared after a sign-in that has ended is no
 * longer waited for. Where any sign-in's earlier accounts are unknown,
 * none. */
export function pendingOfSignIns(
  signIns: readonly ComposioSignIn[] | undefined,
  pendingNow: ReadonlySet<string>,
): ReadonlySet<string> {
  const listed = new Set<string>();
  if (
    signIns === undefined ||
    signIns.some((signIn) => signIn.earlier === null)
  )
    return listed;
  signIns.forEach((signIn, index) => {
    if (!signIn.waiting) return;
    const earlier = new Set(signIn.earlier ?? []);
    const next = signIns[index + 1];
    const until = next === undefined ? pendingNow : (next.earlier ?? []);
    for (const wordId of until) if (!earlier.has(wordId)) listed.add(wordId);
  });
  return listed;
}

/** The one list (decision F42). */
export function mergeIntegrations(input: MergeInput): IntegrationsOverview {
  const { catalog, locale, scope, policy } = input;
  const microsoft365 = input.microsoft365 ?? null;
  const rules: Rules = {
    scope,
    composio: policy.allowed,
    // The Organization's company apps (decision F42 addendum (c) of
    // 2026-10-14): Microsoft 365 where its setting is recorded.
    companyApps: microsoft365 === null ? [] : ["microsoft"],
    // Where Executor is no part of the Environment, an app's way is the one
    // that connects here (Composio, or its tool), never a dead end.
    direct: input.executor.state !== "absent",
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
      // The company app's one integration: its accounts on its card.
      const app =
        integration.kind === "api" && integration.slug === microsoft365Slug
          ? microsoft365Card
          : catalogAppOf(catalog, integration);
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
          manage: null,
        });
      direct.set(app.id, accounts);
    }
  }
  // Composio's accounts count only where Composio is allowed and ready.
  const composioUsable =
    policy.allowed && input.composioReady && input.composio.state === "ok";
  const viaComposio = new Map<string, IntegrationAccount[]>();
  // A pending account is listed only where a waiting sign-in started here
  // may be it (decision F42, addendum of 2026-10-12).
  const pendingNow = new Map<string, Set<string>>();
  if (input.composio.state === "ok")
    for (const account of input.composio.accounts)
      if (account.state === "pending" && account.wordId !== null) {
        const wordIds = pendingNow.get(account.toolkit) ?? new Set<string>();
        wordIds.add(account.wordId);
        pendingNow.set(account.toolkit, wordIds);
      }
  const awaited = (toolkit: string) =>
    pendingOfSignIns(
      input.composioSignIns?.get(toolkit),
      pendingNow.get(toolkit) ?? new Set(),
    );
  if (composioUsable && input.composio.state === "ok")
    for (const account of input.composio.accounts) {
      if (
        account.state === "pending" &&
        (account.wordId === null ||
          !awaited(account.toolkit).has(account.wordId))
      )
        continue;
      const accounts = viaComposio.get(account.toolkit) ?? [];
      accounts.push({
        path: "composio",
        selector: composioSelector(account),
        label: account.alias ?? account.displayName ?? null,
        state: account.state,
        spare: false,
        manage: composioManageUrl(input.composioOrganization, account.toolkit),
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
    // An account on another way than the app's is spare, a direct or a
    // Composio one beside the app's own tool too: the tool connects the
    // app, so the account is not used (the end-to-end test of 2026-10-19).
    const marked = accounts.map((account) =>
      Object.freeze({
        ...account,
        spare: path.path !== null && account.path !== path.path,
      }),
    );
    const connected =
      path.path === "tool" ||
      ((path.path === "direct" || path.path === "composio") &&
        marked.some(
          (account) => !account.spare && account.state === "connected",
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
  // Where the company app is set up, its one card takes the place of
  // Outlook's, and OneDrive's and SharePoint's go. Where it no longer is but
  // accounts of it remain, its card stays at the end, so that "Odpojit"
  // still reaches them.
  const listed =
    microsoft365 === null
      ? (direct.get(microsoft365Card.id) ?? []).length > 0
        ? [...catalog.apps, microsoft365Card]
        : catalog.apps
      : catalog.apps.flatMap((app) =>
          app.id === "outlook"
            ? [microsoft365Card]
            : microsoft365ReplacedApps.includes(app.id)
              ? []
              : [app],
        );
  const apps: IntegrationApp[] = listed.map((app) => {
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
        entry(
          { id: toolkit, composio: true },
          toolkitName(toolkit),
          accounts,
          false,
        ),
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
      disconnect: composioUsable && input.composioDisconnect === true,
      // Not where the CLI already removes without a prompt: an earlier
      // Lazurio build has what the line promises, so only Settings → Tools
      // offers its update (decision F42, note of 2026-10-19).
      update:
        policy.allowed &&
        input.composioReady &&
        input.composioUpdate === true &&
        input.composioDisconnect !== true,
      apps: composioUsable ? composioAppsUrl(input.composioOrganization) : null,
      organization: input.composioTarget ?? null,
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
