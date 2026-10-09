import { randomBytes } from "node:crypto";
import { integrationsCatalog } from "./catalog";
import type { CatalogApp, IntegrationsCatalog } from "./catalog-schema";
import {
  activeComposioAccounts,
  type ComposioEnvironment,
  linkComposio,
  readComposioAccounts,
  removeComposioAccount,
} from "./composio-source";
import {
  type ExecutorEndpoint,
  type ExecutorResult,
  executorCall,
  executorPort,
} from "./executor-client";
import { healthState, readExecutor } from "./executor-source";
import { type AccountState, catalogAppOf, shownEndpoint } from "./model";

// Connecting and disconnecting an Integrace from the Launchpad (decision
// F42): the server drives the Environment's Executor or the person's
// Composio; the page only opens what the person signs in to. Executor's
// typed API is the one its own console uses (Executor 1.6.10, read from its
// source; docs/integrations.md "Executor API"):
// - an official MCP server is added once (`POST /api/mcp/servers`, the
//   catalog's integration slug), probed first (`POST /api/mcp/probe`);
// - without sign-in its connection is created at once (`POST
//   /api/connections`, template `none`) and read back (`GET
//   /api/connections/<owner>/<integration>/<name>`); signing such an account
//   in again re-syncs its tools (`POST …/refresh`) and checks its health
//   (`POST …/health`), and answers connected only when Executor then reads
//   it as working;
// - with OAuth, Executor's client for the authorization server is created
//   from its client ID metadata document (`POST /api/oauth/clients`) or
//   registered dynamically (`POST /api/oauth/clients/register-dynamic`),
//   then `POST /api/oauth/start` answers the authorization URL; the person
//   signs in where Executor's callback on localhost is reachable (the
//   Environment browser on a Remote Environment, their own browser on their
//   computer) and `GET /api/oauth/await/<state>` tells the outcome;
// - a key (a custom server's header or variable) goes only from this server
//   to Executor (`POST /api/connections` with the value, or the command's
//   environment), never back, never logged.
// Composio links with `composio link <toolkit> --no-wait`; its link URL is
// answered only to the request that started it. Every session lives ten
// minutes and is kept in this process only.

export const connectSessionMs = 10 * 60_000;
/** Executor's OAuth callback, as its daemon registers it (`executor
 * install`: http://localhost:4789). */
export const executorCallback = `http://localhost:${executorPort}/api/oauth/callback`;
/** Executor's client ID metadata document for a local daemon (served by
 * executor.sh, loopback redirect URIs on any port). */
export const executorClientMetadata =
  "https://executor.sh/api/oauth/client-id-metadata/local.json";
/** The client name an authorization server shows on its consent screen. */
const clientName = "Lazurio";
const oauthAwaitMs = 30_000;

export type ConnectHost = Readonly<{
  executor: ExecutorEndpoint | null;
  /** Composio's CLI (`~/.local/bin/composio` or wherever PATH has it) and
   * the environment it runs in; null where it is not installed. */
  composio: () => Promise<Readonly<{
    env: ComposioEnvironment;
    command: string;
  }> | null>;
  /** Opens a URL in the Environment browser and answers the address of its
   * view, or null where this Environment has none (a workstation). */
  environmentBrowser:
    | ((url: string) => Promise<Readonly<{ view: string }> | null>)
    | null;
  catalog?: IntegrationsCatalog;
  now?: () => number;
  /** The journal: the operation, the app and the outcome; never a value. */
  journal?: (entry: Readonly<Record<string, string>>) => void;
}>;

export type ConnectStart =
  /** The person signs in at `url` in a window of their own browser. */
  | Readonly<{ kind: "authorize"; session: string; url: string }>
  /** The person signs in in the Environment browser, shown at `view`. */
  | Readonly<{ kind: "authorize"; session: string; view: string }>
  | Readonly<{ kind: "connected"; app: string }>
  | Readonly<{ kind: "blocked"; reason: ConnectRefusal }>;

export type ConnectRefusal =
  | "app-unknown"
  | "account-unknown"
  | "path-unavailable"
  | "composio-signed-out"
  | "name-required"
  | "name-taken"
  | "name-invalid"
  | "executor-unavailable"
  | "browser-unavailable"
  /** Executor holds the app's slug for another server: never reused under
   * the app's card; the person removes it in Vlastní first. */
  | "integration-conflict"
  /** A retried account that Executor still cannot use. */
  | "still-failing"
  | "connect-failed";

export type ConnectProgress =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "connected"; app: string }>
  | Readonly<{ kind: "ended"; reason: "failed" | "expired" | "cancelled" }>;

type Session = {
  readonly id: string;
  readonly app: string;
  readonly expires: number;
  outcome: ConnectProgress;
  /** Composio: the toolkit and the pending account, or the active count
   * before a dashboard link. */
  readonly composio?: Readonly<{
    toolkit: string;
    account: string | null;
    before: number;
  }>;
  /** Executor: the OAuth flow's state. */
  readonly oauth?: Readonly<{ state: string }>;
};

/** An account name: plain text, one line, at most 64 characters. */
export function accountName(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (
    Array.from(trimmed).length > 64 ||
    /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(trimmed)
  )
    return "invalid";
  return trimmed;
}

/** Executor's connection name for an account name: a camelCase identifier
 * (Executor rewrites any other to one), `default` without a name. */
export function connectionName(name: string | null): string {
  if (name === null) return "default";
  const words = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const [first = "", ...rest] = words;
  const identifier = [
    first.toLowerCase(),
    ...rest.map(
      (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    ),
  ].join("");
  return /^[a-z]/.test(identifier)
    ? identifier.slice(0, 64)
    : `account${identifier}`.slice(0, 64);
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

function answerOf(result: ExecutorResult, ...ok: number[]): unknown {
  if (result.kind === "unavailable")
    throw new ConnectBlocked("executor-unavailable");
  if (result.kind !== "answer" || !ok.includes(result.status))
    throw new ConnectBlocked("connect-failed");
  return result.body;
}

class ConnectBlocked extends Error {
  constructor(readonly reason: ConnectRefusal) {
    super(reason);
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The Integrace connect sessions of one Launchpad. */
export function createConnectSessions(host: () => ConnectHost) {
  const sessions = new Map<string, Session>();
  const now = () => (host().now ?? Date.now)();
  const catalog = () => host().catalog ?? integrationsCatalog;
  const journal = (entry: Record<string, string>) =>
    host().journal?.({ scope: "integrations", ...entry });

  // A session is forgotten a minute after it expired, whatever its outcome.
  function sweep() {
    for (const [id, session] of sessions)
      if (session.expires < now() - 60_000) sessions.delete(id);
  }

  function open(app: string, extra: Partial<Session>): Session {
    sweep();
    const session: Session = {
      id: randomBytes(16).toString("hex"),
      app,
      expires: now() + connectSessionMs,
      outcome: { kind: "pending" },
      ...extra,
    };
    sessions.set(session.id, session);
    return session;
  }

  /** The integration of a catalog app in Executor, added once: the remote
   * MCP server at the catalog's endpoint, whatever its slug. Another server
   * that holds the app's slug is never reused, and while it holds it the
   * connect refuses, even where the app's server is also there under
   * another slug: agents find Executor's integrations by slug, so the
   * squatter is removed first (decision F42). */
  async function ensureIntegration(
    executor: ExecutorEndpoint,
    app: CatalogApp,
  ): Promise<Readonly<{ slug: string; oauth: boolean }>> {
    const direct = app.direct;
    if (direct?.kind !== "mcp" || direct.endpoint === undefined)
      throw new ConnectBlocked("path-unavailable");
    const listed = answerOf(
      await executorCall(executor, "GET", "/integrations"),
      200,
    );
    const items = (Array.isArray(listed) ? listed : []).map(record);
    const apps = (item: Record<string, unknown>): boolean => {
      if (item.kind !== "mcp" || typeof item.slug !== "string") return false;
      // Executor shows a remote server's endpoint; a command server none.
      const target =
        typeof item.displayUrl === "string"
          ? shownEndpoint(item.displayUrl)
          : null;
      return (
        catalogAppOf(catalog(), {
          kind: target === null ? "command" : "remote",
          target,
        })?.id === app.id
      );
    };
    // Checked before anything else and on its own: nothing is probed,
    // added or connected while the app's slug is another server's.
    if (items.some((item) => item.slug === direct.integration && !apps(item)))
      throw new ConnectBlocked("integration-conflict");
    const present = items.find(apps);
    const probe = record(
      answerOf(
        await executorCall(
          executor,
          "POST",
          "/mcp/probe",
          { endpoint: direct.endpoint },
          60_000,
        ),
        200,
      ),
    );
    const oauth = probe.requiresOAuth === true;
    if (present !== undefined) return { slug: present.slug as string, oauth };
    const added = record(
      answerOf(
        await executorCall(executor, "POST", "/mcp/servers", {
          transport: "remote",
          name: app.name.en,
          endpoint: direct.endpoint,
          slug: direct.integration,
          remoteTransport: "auto",
          auth: oauth ? { kind: "oauth2" } : { kind: "none" },
        }),
        200,
      ),
    );
    if (typeof added.slug !== "string")
      throw new ConnectBlocked("connect-failed");
    return { slug: added.slug, oauth };
  }

  /** Starts Executor's OAuth for one integration: the authorization URL
   * and the flow's state. */
  async function startOAuth(
    executor: ExecutorEndpoint,
    integration: string,
    endpoint: string,
    name: string | null,
    /** Signing an existing connection in again: its name in Executor. */
    again?: string,
  ): Promise<Readonly<{ url: string; state: string }>> {
    const described = record(
      answerOf(
        await executorCall(
          executor,
          "GET",
          `/integrations/${encodeURIComponent(integration)}`,
        ),
        200,
      ),
    );
    const method = (
      Array.isArray(described.authMethods) ? described.authMethods : []
    )
      .map(record)
      .find((item) => item.kind === "oauth");
    const template =
      typeof method?.template === "string" ? method.template : "oauth2";
    const declared = record(method?.oauth);
    const discovery =
      typeof declared.discoveryUrl === "string"
        ? declared.discoveryUrl
        : endpoint;
    const probe = record(
      answerOf(
        await executorCall(
          executor,
          "POST",
          "/oauth/probe",
          { url: discovery },
          60_000,
        ),
        200,
      ),
    );
    const authorizationUrl = probe.authorizationUrl;
    const tokenUrl = probe.tokenUrl;
    if (typeof authorizationUrl !== "string" || typeof tokenUrl !== "string")
      throw new ConnectBlocked("connect-failed");
    const resource =
      typeof probe.resource === "string" ? probe.resource : endpoint;
    const scopes =
      Array.isArray(declared.scopes) && declared.scopes.length > 0
        ? declared.scopes
        : Array.isArray(probe.scopesSupported)
          ? probe.scopesSupported
          : [];
    let client: string;
    if (probe.clientIdMetadataDocumentSupported === true) {
      // A public client: the metadata document is its identity.
      client = `cimd-${slugify(hostOf(authorizationUrl)) || "authorization-server"}`;
      answerOf(
        await executorCall(executor, "POST", "/oauth/clients", {
          owner: "org",
          slug: client,
          authorizationUrl,
          tokenUrl,
          resource,
          grant: "authorization_code",
          clientId: executorClientMetadata,
          clientSecret: "",
        }),
        200,
      );
    } else if (typeof probe.registrationEndpoint === "string") {
      const issuer = typeof probe.issuer === "string" ? probe.issuer : null;
      const registered = record(
        answerOf(
          await executorCall(
            executor,
            "POST",
            "/oauth/clients/register-dynamic",
            {
              owner: "org",
              slug: `dcr-${slugify(hostOf(issuer ?? probe.registrationEndpoint)) || "authorization-server"}`,
              issuer,
              registrationEndpoint: probe.registrationEndpoint,
              authorizationUrl,
              tokenUrl,
              resource,
              scopes,
              ...(Array.isArray(probe.tokenEndpointAuthMethodsSupported)
                ? {
                    tokenEndpointAuthMethodsSupported:
                      probe.tokenEndpointAuthMethodsSupported,
                  }
                : {}),
              clientName,
              redirectUri: executorCallback,
              originIntegration: integration,
            },
          ),
          200,
        ),
      );
      if (typeof registered.client !== "string")
        throw new ConnectBlocked("connect-failed");
      client = registered.client;
    } else throw new ConnectBlocked("path-unavailable");
    const started = record(
      answerOf(
        await executorCall(executor, "POST", "/oauth/start", {
          client,
          clientOwner: "org",
          owner: "org",
          name: again ?? connectionName(name),
          integration,
          template,
          // A new account gets a free name; signing in again keeps its own.
          ...(again === undefined ? { newConnection: true } : {}),
          ...(name === null ? {} : { identityLabel: name }),
        }),
        200,
      ),
    );
    const url = started.authorizationUrl;
    const state = started.state;
    if (
      started.status !== "redirect" ||
      typeof url !== "string" ||
      typeof state !== "string" ||
      !/^https:\/\//.test(url)
    )
      throw new ConnectBlocked("connect-failed");
    return { url, state };
  }

  /** Waits for Executor's OAuth outcome in the background, one long poll
   * after another, until it is known or the session ends. */
  function awaitOAuth(
    executor: ExecutorEndpoint,
    session: Session,
    state: string,
  ) {
    void (async () => {
      while (session.outcome.kind === "pending" && now() < session.expires) {
        const result = await executorCall(
          executor,
          "GET",
          `/oauth/await/${encodeURIComponent(state)}`,
          undefined,
          oauthAwaitMs,
        );
        if (session.outcome.kind !== "pending") return;
        if (
          result.kind === "answer" &&
          result.status === 200 &&
          result.body !== null
        ) {
          const ok = record(result.body).ok === true;
          session.outcome = ok
            ? { kind: "connected", app: session.app }
            : { kind: "ended", reason: "failed" };
          journal({
            event: "connect",
            app: session.app,
            outcome: ok ? "connected" : "failed",
          });
          return;
        }
        if (result.kind === "unavailable") {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        if (result.kind === "failed" && result.reason !== "timeout")
          await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (session.outcome.kind === "pending")
        session.outcome = { kind: "ended", reason: "expired" };
    })();
  }

  /** Where the person signs in: the Environment browser on a Remote
   * Environment, their own browser on their computer. */
  async function authorize(
    session: Session,
    url: string,
  ): Promise<ConnectStart> {
    const browser = host().environmentBrowser;
    if (browser === null)
      return { kind: "authorize", session: session.id, url };
    const opened = await browser(url).catch(() => null);
    if (opened === null) {
      session.outcome = { kind: "ended", reason: "failed" };
      return { kind: "blocked", reason: "browser-unavailable" };
    }
    return { kind: "authorize", session: session.id, view: opened.view };
  }

  async function connectDirect(
    app: CatalogApp,
    name: string | null,
    again: string | undefined,
  ): Promise<ConnectStart> {
    const executor = host().executor;
    if (executor === null)
      return { kind: "blocked", reason: "executor-unavailable" };
    const { slug, oauth } = await ensureIntegration(executor, app);
    // Signing an account in again: only one of this app's integration.
    let againName: string | undefined;
    if (again !== undefined) {
      const [owner, integration, connection] = again.split("/");
      if (owner !== "org" || integration !== slug || connection === undefined)
        return { kind: "blocked", reason: "account-unknown" };
      againName = connection;
    }
    if (!oauth) {
      // Without sign-in "again" is a retry of that account itself.
      if (againName !== undefined)
        return retryDirect(executor, app, slug, againName);
      const created = await executorCall(executor, "POST", "/connections", {
        owner: "org",
        name: connectionName(name),
        integration: slug,
        template: "none",
        values: {},
      });
      if (created.kind === "answer" && created.status === 409)
        // The default account is there already: retried, never taken for
        // working as it is; a named one is another account's name.
        return name === null
          ? retryDirect(executor, app, slug, connectionName(null))
          : { kind: "blocked", reason: "name-taken" };
      answerOf(created, 200);
      const state = await connectionState(executor, slug, connectionName(name));
      const working = state === "connected";
      journal({
        event: "connect",
        app: app.id,
        outcome: working ? "connected" : "failed",
      });
      return working
        ? { kind: "connected", app: app.id }
        : { kind: "blocked", reason: "still-failing" };
    }
    const endpoint = app.direct?.endpoint as string;
    const { url, state } = await startOAuth(
      executor,
      slug,
      endpoint,
      name,
      againName,
    );
    const session = open(app.id, { oauth: { state } });
    awaitOAuth(executor, session, state);
    return authorize(session, url);
  }

  /** One account of an integration as Executor reads it now; null where it
   * is gone or cannot be read. */
  async function connectionState(
    executor: ExecutorEndpoint,
    slug: string,
    name: string,
  ): Promise<AccountState | null> {
    const answer = await executorCall(
      executor,
      "GET",
      `/connections/org/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`,
    );
    if (answer.kind !== "answer" || answer.status !== 200) return null;
    try {
      return healthState(record(answer.body).lastHealth);
    } catch {
      return null;
    }
  }

  /** Signs an account without sign-in in again, for real: Executor re-syncs
   * its tools and checks its health, and only an account it then reads as
   * working answers connected; anything else is said, never a success. */
  async function retryDirect(
    executor: ExecutorEndpoint,
    app: CatalogApp,
    slug: string,
    name: string,
  ): Promise<ConnectStart> {
    const at = `/connections/org/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`;
    // Both dial the server: bounded so that the probe before them and both
    // stay within the connect route's time.
    const refreshed = await executorCall(
      executor,
      "POST",
      `${at}/refresh`,
      undefined,
      45_000,
    );
    if (refreshed.kind === "unavailable")
      return { kind: "blocked", reason: "executor-unavailable" };
    if (refreshed.kind === "answer" && refreshed.status === 404)
      return { kind: "blocked", reason: "account-unknown" };
    // A fresh verdict for the card; the read below decides.
    await executorCall(executor, "POST", `${at}/health`, undefined, 45_000);
    const state = await connectionState(executor, slug, name);
    const working =
      refreshed.kind === "answer" &&
      refreshed.status === 200 &&
      state === "connected";
    journal({
      event: "connect",
      app: app.id,
      outcome: working ? "connected" : "failed",
    });
    return working
      ? { kind: "connected", app: app.id }
      : { kind: "blocked", reason: "still-failing" };
  }

  async function connectComposio(
    app: CatalogApp,
    name: string | null,
  ): Promise<ConnectStart> {
    const composio = await host().composio();
    const toolkit = app.composio;
    if (composio === null || toolkit === undefined)
      return { kind: "blocked", reason: "composio-signed-out" };
    // The CLI asks for a name only after it created a link: the Launchpad
    // asks first (a second account needs one, and a name in use is refused).
    const own = await activeComposioAccounts(
      composio.env,
      composio.command,
      toolkit,
    );
    if (own === null) {
      const accounts = await readComposioAccounts(
        composio.env,
        composio.command,
      );
      return {
        kind: "blocked",
        reason:
          accounts.state === "signed-out"
            ? "composio-signed-out"
            : "connect-failed",
      };
    }
    if (own.length > 0 && name === null)
      return { kind: "blocked", reason: "name-required" };
    if (
      name !== null &&
      own.some((account) => account.alias?.toLowerCase() === name.toLowerCase())
    )
      return { kind: "blocked", reason: "name-taken" };
    const link = await linkComposio(
      composio.env,
      composio.command,
      toolkit,
      name,
    );
    if (link.kind === "refused")
      return {
        kind: "blocked",
        reason:
          link.reason === "signed-out"
            ? "composio-signed-out"
            : link.reason === "link-failed"
              ? "connect-failed"
              : link.reason,
      };
    const session = open(app.id, {
      composio: { toolkit, account: link.account, before: own.length },
    });
    journal({ event: "link", app: app.id, outcome: "pending" });
    // A Composio link opens in the person's own browser: it is Composio's page.
    return { kind: "authorize", session: session.id, url: link.url };
  }

  return Object.freeze({
    /** Starts connecting `appId` the way `path` says (the page's card). */
    async start(
      appId: string,
      path: "direct" | "composio",
      name: string | null,
      /** Signs this account in again (an expired or failed one). */
      again?: string,
    ): Promise<ConnectStart> {
      const app = catalog().apps.find((item) => item.id === appId);
      if (app === undefined) return { kind: "blocked", reason: "app-unknown" };
      try {
        return path === "direct"
          ? await connectDirect(app, name, again)
          : await connectComposio(app, name);
      } catch (error) {
        const reason =
          error instanceof ConnectBlocked ? error.reason : "connect-failed";
        journal({ event: "connect", app: appId, outcome: "blocked", reason });
        return { kind: "blocked", reason };
      }
    },

    /** How a session goes. */
    async poll(id: string): Promise<ConnectProgress | null> {
      const session = sessions.get(id);
      if (session === undefined) return null;
      if (session.outcome.kind === "pending" && now() >= session.expires)
        session.outcome = { kind: "ended", reason: "expired" };
      if (session.outcome.kind !== "pending" || session.composio === undefined)
        return session.outcome;
      const composio = await host().composio();
      if (composio === null) return session.outcome;
      const { toolkit, account, before } = session.composio;
      const active = await activeComposioAccounts(
        composio.env,
        composio.command,
        toolkit,
      );
      if (
        active !== null &&
        (account === null
          ? active.length > before
          : active.some((item) => item.id === account))
      ) {
        session.outcome = { kind: "connected", app: session.app };
        journal({ event: "link", app: session.app, outcome: "connected" });
      }
      return session.outcome;
    },

    /** Ends a session; an OAuth flow is cancelled in Executor too. */
    async cancel(id: string): Promise<boolean> {
      const session = sessions.get(id);
      if (session === undefined) return false;
      if (session.outcome.kind === "pending") {
        session.outcome = { kind: "ended", reason: "cancelled" };
        const executor = host().executor;
        if (session.oauth !== undefined && executor !== null)
          await executorCall(executor, "POST", "/oauth/cancel", {
            state: session.oauth.state,
          }).catch(() => undefined);
      }
      return true;
    },

    /** Disconnects one account of an app, named as the reading names it. */
    async disconnect(
      appId: string,
      path: "direct" | "composio",
      selector: string,
    ): Promise<
      | Readonly<{ kind: "disconnected" }>
      | Readonly<{
          kind: "blocked";
          reason:
            | "account-unknown"
            | "disconnect-unsupported"
            | "executor-unavailable"
            | "disconnect-failed";
        }>
    > {
      if (path === "direct") {
        const executor = host().executor;
        if (executor === null)
          return { kind: "blocked", reason: "executor-unavailable" };
        const reading = await readExecutor(executor, catalog());
        if (reading.state === "unavailable")
          return { kind: "blocked", reason: "executor-unavailable" };
        if (reading.state !== "ok")
          return { kind: "blocked", reason: "disconnect-failed" };
        const connection = reading.connections.find(
          (item) => item.id === selector,
        );
        const integration = reading.integrations.find(
          (item) => item.slug === connection?.integration,
        );
        const owner =
          integration === undefined
            ? undefined
            : integration.kind === "api"
              ? undefined
              : catalogAppOf(catalog(), integration);
        // An app's account, or a custom server's (its slug is its id).
        if (
          connection === undefined ||
          (owner?.id !== appId && integration?.slug !== appId)
        )
          return { kind: "blocked", reason: "account-unknown" };
        const [ownerName, slug, name] = selector.split("/") as [
          string,
          string,
          string,
        ];
        const removed = await executorCall(
          executor,
          "DELETE",
          `/connections/${encodeURIComponent(ownerName)}/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`,
        );
        const ok =
          removed.kind === "answer" &&
          removed.status === 200 &&
          record(removed.body).removed === true;
        journal({
          event: "disconnect",
          app: appId,
          outcome: ok ? "disconnected" : "failed",
        });
        return ok
          ? { kind: "disconnected" }
          : { kind: "blocked", reason: "disconnect-failed" };
      }
      const composio = await host().composio();
      const app = catalog().apps.find((item) => item.id === appId);
      const toolkit = app?.composio ?? appId;
      if (composio === null)
        return { kind: "blocked", reason: "disconnect-failed" };
      const before = await readComposioAccounts(composio.env, composio.command);
      if (
        before.state !== "ok" ||
        !before.accounts.some(
          (account) =>
            account.toolkit === toolkit && account.wordId === selector,
        )
      )
        return { kind: "blocked", reason: "account-unknown" };
      if (
        !(await removeComposioAccount(composio.env, composio.command, selector))
      )
        return { kind: "blocked", reason: "disconnect-unsupported" };
      const after = await readComposioAccounts(composio.env, composio.command);
      const gone =
        after.state === "ok" &&
        !after.accounts.some((account) => account.wordId === selector);
      journal({
        event: "disconnect",
        app: appId,
        outcome: gone ? "disconnected" : "failed",
      });
      return gone
        ? { kind: "disconnected" }
        : { kind: "blocked", reason: "disconnect-failed" };
    },

    /** Adds a custom MCP server to Executor (Vlastní). A key goes only to
     * Executor: the remote server's header, or the command's variable. */
    async addCustom(
      server: Readonly<{
        name: string;
        kind: "url" | "command";
        target: string;
        secret: Readonly<{ name: string; value: string }> | null;
      }>,
    ): Promise<
      ConnectStart | Readonly<{ kind: "blocked"; reason: "name-taken" }>
    > {
      const executor = host().executor;
      if (executor === null)
        return { kind: "blocked", reason: "executor-unavailable" };
      try {
        if (server.kind === "command") {
          const [command, ...args] = splitCommand(server.target);
          if (command === undefined)
            return { kind: "blocked", reason: "connect-failed" };
          const added = await executorCall(
            executor,
            "POST",
            "/mcp/servers",
            {
              transport: "stdio",
              name: server.name,
              command,
              args,
              ...(server.secret === null
                ? {}
                : { env: { [server.secret.name]: server.secret.value } }),
            },
            60_000,
          );
          if (added.kind === "answer" && added.status === 409)
            return { kind: "blocked", reason: "name-taken" };
          const slug = record(answerOf(added, 200)).slug;
          journal({
            event: "custom-add",
            app: typeof slug === "string" ? slug : "",
            outcome: "connected",
          });
          return {
            kind: "connected",
            app: typeof slug === "string" ? slug : server.name,
          };
        }
        const probe = record(
          answerOf(
            await executorCall(
              executor,
              "POST",
              "/mcp/probe",
              {
                endpoint: server.target,
                ...(server.secret === null
                  ? {}
                  : { headers: { [server.secret.name]: server.secret.value } }),
              },
              60_000,
            ),
            200,
          ),
        );
        const oauth = server.secret === null && probe.requiresOAuth === true;
        const added = await executorCall(executor, "POST", "/mcp/servers", {
          transport: "remote",
          name: server.name,
          endpoint: server.target,
          remoteTransport: "auto",
          auth:
            server.secret !== null
              ? { kind: "header", headerName: server.secret.name }
              : oauth
                ? { kind: "oauth2" }
                : { kind: "none" },
        });
        if (added.kind === "answer" && added.status === 409)
          return { kind: "blocked", reason: "name-taken" };
        const slug = record(answerOf(added, 200)).slug;
        if (typeof slug !== "string")
          return { kind: "blocked", reason: "connect-failed" };
        if (oauth) {
          const { url, state } = await startOAuth(
            executor,
            slug,
            server.target,
            null,
          );
          const session = open(slug, { oauth: { state } });
          awaitOAuth(executor, session, state);
          return authorize(session, url);
        }
        answerOf(
          await executorCall(executor, "POST", "/connections", {
            owner: "org",
            name: "default",
            integration: slug,
            ...(server.secret === null
              ? { template: "none", values: {} }
              : { template: "header", value: server.secret.value }),
          }),
          200,
        );
        journal({ event: "custom-add", app: slug, outcome: "connected" });
        return { kind: "connected", app: slug };
      } catch (error) {
        return {
          kind: "blocked",
          reason:
            error instanceof ConnectBlocked ? error.reason : "connect-failed",
        };
      }
    },

    /** Removes a custom MCP server (never a catalog app's integration). */
    async removeCustom(id: string): Promise<
      | Readonly<{ kind: "removed" }>
      | Readonly<{
          kind: "blocked";
          reason: "account-unknown" | "executor-unavailable" | "remove-failed";
        }>
    > {
      const executor = host().executor;
      if (executor === null)
        return { kind: "blocked", reason: "executor-unavailable" };
      const reading = await readExecutor(executor, catalog());
      if (reading.state !== "ok")
        return {
          kind: "blocked",
          reason:
            reading.state === "unavailable"
              ? "executor-unavailable"
              : "remove-failed",
        };
      const integration = reading.integrations.find((item) => item.slug === id);
      if (
        integration === undefined ||
        integration.kind === "api" ||
        catalogAppOf(catalog(), integration) !== undefined
      )
        return { kind: "blocked", reason: "account-unknown" };
      const removed = await executorCall(
        executor,
        "DELETE",
        `/mcp/servers/${encodeURIComponent(id)}`,
      );
      const ok =
        removed.kind === "answer" &&
        removed.status === 200 &&
        record(removed.body).removed === true;
      journal({
        event: "custom-remove",
        app: id,
        outcome: ok ? "removed" : "failed",
      });
      return ok
        ? { kind: "removed" }
        : { kind: "blocked", reason: "remove-failed" };
    },
  });
}

/** A command line as words: spaces separate, single and double quotes keep
 * a word together; no expansion, no shell. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const char of line.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += char;
    started = true;
  }
  if (started) words.push(word);
  return words;
}
