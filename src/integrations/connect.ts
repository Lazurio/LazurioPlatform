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
  type CustomServerInput,
  type CustomServerSettings,
  customProblems,
  envValues,
  keyHeaders,
  keysChange,
  keysMethod,
  keysTemplate,
  plainLine,
  remoteAuthOf,
  settingsOf,
  storedOf,
} from "./custom-server";
import {
  type ExecutorEndpoint,
  type ExecutorResult,
  executorCall,
  executorOAuthReturn,
  executorPort,
  type oauthReturnParameters,
} from "./executor-client";
import { healthState, readExecutor } from "./executor-source";
import {
  type AccountState,
  type ComposioSignIn,
  catalogAppOf,
  composioToolkitOf,
  shownEndpoint,
} from "./model";

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
//   then `POST /api/oauth/start` answers the authorization URL and
//   `GET /api/oauth/await/<state>` tells the outcome. On a Remote
//   Environment a client registered with the Launchpad's own address lets
//   the person sign in in their own browser: the authorization server
//   returns there and the Launchpad hands the return to Executor's callback
//   (`GET /api/oauth/callback`). Where the server registers no such client,
//   the person signs in where Executor's callback on localhost is reachable:
//   the Environment browser on a Remote Environment, their own browser on
//   their computer (decision F42, addendum of 2026-10-13);
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
/** Executor's callback exchanges the code with the authorization server. */
const oauthReturnMs = 60_000;
/** How long a return waits for the outcome Executor then tells the long
 * poll, which it wakes as it answers. */
const oauthSettleMs = 5_000;

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
  /** The Launchpad's own address an authorization server returns a direct
   * sign-in to, the person's own browser passing the gateway as it does to
   * the Launchpad (a Remote Environment); null or absent where Executor's
   * callback on localhost is the person's own (a workstation). */
  oauthCallback?: string | null;
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
  /** Composio works in no organization of this Environment's
   * Organization's name (decision F42, addendum of 2026-10-13). */
  | "composio-organization"
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

/** Why a custom server cannot be read or saved as one. */
export type CustomRefusal =
  /** No such server, or a catalog app's (edited only through its card). */
  "account-unknown" | "executor-unavailable" | "connect-failed";

/** Equal as JSON, whatever the order of an object's keys. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [
                key,
                canonical((value as Record<string, unknown>)[key]),
              ]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

type Session = {
  readonly id: string;
  readonly app: string;
  readonly expires: number;
  outcome: ConnectProgress;
  /** Composio: the toolkit and the pending account, or the active count
   * before a dashboard link; and the word ids of the toolkit's pending
   * accounts before the link (sign-ins left unfinished earlier, never the
   * one this link creates), null where they could not be read. */
  readonly composio?: Readonly<{
    toolkit: string;
    account: string | null;
    before: number;
    stale: readonly string[] | null;
  }>;
  /** Executor: the OAuth flow's state, and whether the authorization
   * server returns it to the Launchpad (the person's own browser) rather
   * than to Executor's callback on localhost. */
  readonly oauth?: Readonly<{ state: string; launchpad: boolean }>;
  /** The authorization server's return was handed to Executor once. */
  returned?: true;
};

/** An account name: plain text, one line, at most 64 characters. */
export function accountName(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  if (value.trim() === "") return null;
  return plainLine(value, 64) ?? "invalid";
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
   * and the flow. A client registered dynamically with the Launchpad's own
   * address comes first, so that the person signs in in their own browser;
   * where the authorization server refuses that address or registers no
   * client dynamically, Executor's client for its callback on localhost
   * (decision F42, addendum of 2026-10-13). */
  async function startOAuth(
    executor: ExecutorEndpoint,
    integration: string,
    endpoint: string,
    name: string | null,
    /** Signing an existing connection in again: its name in Executor. */
    again?: string,
  ): Promise<Readonly<{ url: string; oauth: NonNullable<Session["oauth"]> }>> {
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
    const registration =
      typeof probe.registrationEndpoint === "string"
        ? probe.registrationEndpoint
        : null;
    /** A client registered dynamically for `redirectUri`: its slug, or
     * null where the authorization server refused the registration. */
    const register = async (
      registrationEndpoint: string,
      redirectUri: string,
    ): Promise<string | null> => {
      const issuer = typeof probe.issuer === "string" ? probe.issuer : null;
      const answer = await executorCall(
        executor,
        "POST",
        "/oauth/clients/register-dynamic",
        {
          owner: "org",
          slug: `dcr-${slugify(hostOf(issuer ?? registrationEndpoint)) || "authorization-server"}`,
          issuer,
          registrationEndpoint,
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
          redirectUri,
          originIntegration: integration,
        },
      );
      // Executor's OAuthRegisterDynamicError: the server said no, often
      // to an address that is not loopback (RFC 8252).
      if (answer.kind === "answer" && answer.status === 400) return null;
      const registered = record(answerOf(answer, 200));
      if (typeof registered.client !== "string")
        throw new ConnectBlocked("connect-failed");
      return registered.client;
    };
    /** Executor's client for its callback on localhost: from its client ID
     * metadata document where the server reads one, else registered. */
    const localClient = async (): Promise<string> => {
      if (probe.clientIdMetadataDocumentSupported === true) {
        // A public client: the metadata document is its identity.
        const slug = `cimd-${slugify(hostOf(authorizationUrl)) || "authorization-server"}`;
        answerOf(
          await executorCall(executor, "POST", "/oauth/clients", {
            owner: "org",
            slug,
            authorizationUrl,
            tokenUrl,
            resource,
            grant: "authorization_code",
            clientId: executorClientMetadata,
            clientSecret: "",
          }),
          200,
        );
        return slug;
      }
      if (registration === null) throw new ConnectBlocked("path-unavailable");
      const registered = await register(registration, executorCallback);
      if (registered === null) throw new ConnectBlocked("connect-failed");
      return registered;
    };
    const callback = host().oauthCallback ?? null;
    const own =
      callback !== null && registration !== null
        ? await register(registration, callback)
        : null;
    const client = own ?? (await localClient());
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
          // The address the client was registered with; Executor's own
          // callback otherwise.
          ...(own === null ? {} : { redirectUri: callback }),
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
    return { url, oauth: { state, launchpad: own !== null } };
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

  /** Where the person signs in: their own browser where the authorization
   * server returns to the Launchpad or to Executor on their own computer;
   * the Environment browser where it returns to Executor on a Remote
   * Environment. */
  async function authorize(
    session: Session,
    url: string,
  ): Promise<ConnectStart> {
    const browser = host().environmentBrowser;
    if (session.oauth?.launchpad === true || browser === null)
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
    const started = await startOAuth(executor, slug, endpoint, name, againName);
    const session = open(app.id, { oauth: started.oauth });
    awaitOAuth(executor, session, started.oauth.state);
    return authorize(session, started.url);
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

  /** A custom server of Executor: its edit form, its config and the
   * template its account binds. Never a catalog app's integration, which
   * its card owns (decision F42). */
  async function customServerOf(
    executor: ExecutorEndpoint,
    id: string,
  ): Promise<
    | Readonly<{
        settings: CustomServerSettings;
        config: Record<string, unknown>;
        template: string | null;
      }>
    | Readonly<{ reason: CustomRefusal }>
  > {
    const slug = encodeURIComponent(id);
    const integration = await executorCall(
      executor,
      "GET",
      `/integrations/${slug}`,
    );
    if (integration.kind === "unavailable")
      return { reason: "executor-unavailable" };
    if (integration.kind === "answer" && integration.status === 404)
      return { reason: "account-unknown" };
    if (integration.kind !== "answer" || integration.status !== 200)
      return { reason: "connect-failed" };
    const described = record(integration.body);
    if (described.kind !== "mcp" || typeof described.name !== "string")
      return { reason: "account-unknown" };
    const server = await executorCall(executor, "GET", `/mcp/servers/${slug}`);
    if (server.kind === "unavailable")
      return { reason: "executor-unavailable" };
    if (server.kind !== "answer" || server.status !== 200)
      return { reason: "connect-failed" };
    if (server.body === null) return { reason: "account-unknown" };
    const config = record(record(server.body).config);
    if (
      config.transport === "remote" &&
      typeof config.endpoint === "string" &&
      catalogAppOf(catalog(), {
        kind: "remote",
        target: shownEndpoint(config.endpoint),
      }) !== undefined
    )
      return { reason: "account-unknown" };
    const account = await executorCall(
      executor,
      "GET",
      `/connections/org/${slug}/default`,
    );
    if (account.kind === "unavailable")
      return { reason: "executor-unavailable" };
    const template =
      account.kind === "answer" &&
      account.status === 200 &&
      typeof record(account.body).template === "string"
        ? (record(account.body).template as string)
        : null;
    const settings = settingsOf(
      id,
      described.name.trim() || id,
      config,
      template,
    );
    return settings === null
      ? { reason: "connect-failed" }
      : { settings, config, template };
  }

  // One Composio sign-in of a toolkit starts at a time: its check of the
  // names, its snapshot of the pending accounts, its link and its session, in
  // that order. So the sessions' order is the order of the links, by which
  // the reading weighs a pending account (`pendingOfSignIns`, decision F42,
  // addendum of 2026-10-12), also where two start at once.
  const composioStarts = new Map<string, Promise<void>>();
  async function oneAtATime<T>(
    toolkit: string,
    start: () => Promise<T>,
  ): Promise<T> {
    const mine = (composioStarts.get(toolkit) ?? Promise.resolve()).then(start);
    const done = mine.then(
      () => undefined,
      () => undefined,
    );
    composioStarts.set(toolkit, done);
    try {
      return await mine;
    } finally {
      if (composioStarts.get(toolkit) === done) composioStarts.delete(toolkit);
    }
  }

  async function connectComposio(
    app: CatalogApp,
    name: string | null,
  ): Promise<ConnectStart> {
    const composio = await host().composio();
    const toolkit = app.composio;
    if (composio === null || toolkit === undefined)
      return { kind: "blocked", reason: "composio-signed-out" };
    return oneAtATime(toolkit, () =>
      startComposio(app, name, composio, toolkit),
    );
  }

  async function startComposio(
    app: CatalogApp,
    name: string | null,
    composio: NonNullable<Awaited<ReturnType<ConnectHost["composio"]>>>,
    toolkit: string,
  ): Promise<ConnectStart> {
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
    // The toolkit's pending accounts before the link are sign-ins left
    // unfinished earlier: while this one waits, the reading lists only a
    // pending account that is none of them (decision F42, addendum of
    // 2026-10-12); unknown, it lists none.
    const earlier = await readComposioAccounts(composio.env, composio.command);
    const stale =
      earlier.state === "ok" &&
      earlier.accounts.every(
        (account) =>
          account.toolkit !== toolkit ||
          account.state !== "pending" ||
          account.wordId !== null,
      )
        ? earlier.accounts.flatMap((account) =>
            account.toolkit === toolkit &&
            account.state === "pending" &&
            account.wordId !== null
              ? [account.wordId]
              : [],
          )
        : null;
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
      composio: { toolkit, account: link.account, before: own.length, stale },
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

    /** The Composio sign-ins started here, by toolkit, in the order they
     * started (the sessions' own order), ended and cancelled ones too while
     * the sessions keep them: the reading weighs a pending account by them
     * (`pendingOfSignIns`, decision F42, addendum of 2026-10-12). A session
     * is kept a minute beyond its expiry, and every one lasts as long, so a
     * later sign-in outlives every earlier one. */
    signIns(): ReadonlyMap<string, readonly ComposioSignIn[]> {
      const byToolkit = new Map<string, ComposioSignIn[]>();
      for (const session of sessions.values()) {
        if (session.composio === undefined) continue;
        const { toolkit, stale } = session.composio;
        byToolkit.set(toolkit, [
          ...(byToolkit.get(toolkit) ?? []),
          Object.freeze({
            earlier: stale,
            waiting:
              session.outcome.kind === "pending" && now() < session.expires,
          }),
        ]);
      }
      return byToolkit;
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

    /** An authorization server's return to the Launchpad's own address
     * (decision F42, addendum of 2026-10-13): handed once to Executor's
     * callback, and only for a sign-in started here that returns here and
     * still waits; then how it went, as soon as Executor tells it. Null for
     * a state no such sign-in has. */
    async returned(
      parameters: Readonly<
        Partial<Record<(typeof oauthReturnParameters)[number], string>>
      >,
    ): Promise<Readonly<{ app: string; progress: ConnectProgress }> | null> {
      const session = [...sessions.values()].find(
        (item) =>
          item.oauth?.launchpad === true &&
          item.oauth.state === parameters.state,
      );
      if (session === undefined) return null;
      if (session.outcome.kind === "pending" && now() >= session.expires)
        session.outcome = { kind: "ended", reason: "expired" };
      // A second return of the same sign-in (a reload) is never handed on.
      if (session.outcome.kind === "pending" && session.returned !== true) {
        session.returned = true;
        const executor = host().executor;
        // Still waiting when the request goes out: a sign-in cancelled or
        // expired while Executor's listener and token are proven is never
        // handed on (Pablo's review of #368).
        const waiting = () =>
          session.outcome.kind === "pending" && now() < session.expires;
        const delivered =
          executor === null
            ? "unavailable"
            : await executorOAuthReturn(
                executor,
                parameters,
                oauthReturnMs,
                waiting,
              );
        if (delivered !== "delivered" && session.outcome.kind === "pending") {
          session.outcome =
            delivered === "withheld"
              ? { kind: "ended", reason: "expired" }
              : { kind: "ended", reason: "failed" };
          journal({
            event: "connect",
            app: session.app,
            outcome: delivered === "withheld" ? "expired" : "failed",
          });
        }
      }
      for (
        let waited = 0;
        session.outcome.kind === "pending" && waited < oauthSettleMs;
        waited += 50
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      return { app: session.app, progress: session.outcome };
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
      const toolkit = composioToolkitOf(catalog(), appId);
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

    /** Adds a custom MCP server to Executor (Vlastní), as the form has it
     * (decision F42, addendum of 2026-10-11). Its keys go only to Executor,
     * as the server's account: a command's environment variables, a remote
     * server's Bearer token and headers. */
    async addCustom(
      server: CustomServerInput,
    ): Promise<
      ConnectStart | Readonly<{ kind: "blocked"; reason: "name-taken" }>
    > {
      const executor = host().executor;
      if (executor === null)
        return { kind: "blocked", reason: "executor-unavailable" };
      try {
        if (server.type === "stdio") {
          const env = envValues(server);
          if (env === null)
            return { kind: "blocked", reason: "connect-failed" };
          // Executor creates the command's account at once: its variables
          // in its secret store, or none.
          const added = await executorCall(
            executor,
            "POST",
            "/mcp/servers",
            {
              transport: "stdio",
              name: server.name.trim(),
              command: server.command.trim(),
              args: [...server.args],
              ...(server.cwd === null ? {} : { cwd: server.cwd }),
              ...(Object.keys(env).length === 0 ? {} : { env }),
            },
            60_000,
          );
          if (added.kind === "answer" && added.status === 409)
            return { kind: "blocked", reason: "name-taken" };
          const slug = record(answerOf(added, 200)).slug;
          if (typeof slug !== "string")
            return { kind: "blocked", reason: "connect-failed" };
          journal({ event: "custom-add", app: slug, outcome: "connected" });
          return { kind: "connected", app: slug };
        }
        const keys = keysMethod(server);
        const endpoint = server.url.trim();
        const headers = keyHeaders(server) ?? {};
        const probe = record(
          answerOf(
            await executorCall(
              executor,
              "POST",
              "/mcp/probe",
              {
                endpoint,
                ...(Object.keys(headers).length === 0 ? {} : { headers }),
              },
              60_000,
            ),
            200,
          ),
        );
        const oauth = keys === null && probe.requiresOAuth === true;
        const added = await executorCall(executor, "POST", "/mcp/servers", {
          transport: "remote",
          name: server.name.trim(),
          endpoint,
          remoteTransport: "auto",
          ...(keys !== null
            ? { authenticationTemplate: [keys.input] }
            : { auth: oauth ? { kind: "oauth2" } : { kind: "none" } }),
        });
        if (added.kind === "answer" && added.status === 409)
          return { kind: "blocked", reason: "name-taken" };
        const slug = record(answerOf(added, 200)).slug;
        if (typeof slug !== "string")
          return { kind: "blocked", reason: "connect-failed" };
        if (oauth) {
          const { url, oauth } = await startOAuth(
            executor,
            slug,
            endpoint,
            null,
          );
          const session = open(slug, { oauth });
          awaitOAuth(executor, session, oauth.state);
          return authorize(session, url);
        }
        answerOf(
          await executorCall(executor, "POST", "/connections", {
            owner: "org",
            name: "default",
            integration: slug,
            ...(keys === null
              ? { template: "none", values: {} }
              : { template: keysTemplate, values: keys.values }),
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

    /** A custom server as its edit form opens: its configuration and the
     * names of its keys; never a value, never a catalog app's server. */
    async customSettings(
      id: string,
    ): Promise<
      | CustomServerSettings
      | Readonly<{ kind: "blocked"; reason: CustomRefusal }>
    > {
      const executor = host().executor;
      if (executor === null)
        return { kind: "blocked", reason: "executor-unavailable" };
      const found = await customServerOf(executor, id);
      return "reason" in found
        ? { kind: "blocked", reason: found.reason }
        : found.settings;
    },

    /** Saves a custom server's form in Executor, in place: its name, its
     * configuration and, where its keys change, its account anew, with
     * every key again (Executor keeps them together and never returns
     * them). A remote server that now needs a sign-in starts it. */
    async updateCustom(
      id: string,
      server: CustomServerInput,
    ): Promise<
      | ConnectStart
      | Readonly<{ kind: "saved"; app: string }>
      | Readonly<{
          kind: "blocked";
          reason:
            | CustomRefusal
            | "type-fixed"
            | "invalid-server"
            | "keys-required";
        }>
    > {
      const executor = host().executor;
      if (executor === null)
        return { kind: "blocked", reason: "executor-unavailable" };
      const found = await customServerOf(executor, id);
      if ("reason" in found) return { kind: "blocked", reason: found.reason };
      const { settings, config, template } = found;
      if (settings.type !== server.type)
        return { kind: "blocked", reason: "type-fixed" };
      const stored = storedOf(settings);
      // Refused before Executor is asked anything more: a stored key that
      // must come again (another key changed, or the address did) and did
      // not is `keys-required`; the server is never probed without it.
      const problems = customProblems(server, stored);
      if (problems.length > 0)
        return {
          kind: "blocked",
          reason: problems.some((item) => item.problem === "again")
            ? "keys-required"
            : "invalid-server",
        };
      const changed = keysChange(server, stored);
      const at = `/connections/org/${encodeURIComponent(id)}/default`;
      try {
        // A remote address is probed before anything changes: one that does
        // not answer keeps the server as it was. Its account is created anew
        // last, after the old one is removed (Executor's account name
        // `default` is the agents' address); should that fail, the server is
        // left without an account and the next save creates it.
        let next: Record<string, unknown>;
        let account:
          | Readonly<{ template: string; values: Record<string, string> }>
          | "oauth2"
          | null = null;
        let endpoint = "";
        if (server.type === "stdio") {
          const { args: _args, cwd: _cwd, ...rest } = config;
          const names = server.env.map((key) => key.name.trim());
          next = {
            ...rest,
            transport: "stdio",
            command: server.command.trim(),
            ...(server.args.length === 0 ? {} : { args: [...server.args] }),
            ...(server.cwd === null ? {} : { cwd: server.cwd }),
          };
          if (changed) {
            next.authenticationTemplate =
              names.length === 0
                ? [{ slug: "none", kind: "none" }]
                : [{ slug: "env", kind: "stdio_env", vars: names }];
            account =
              names.length === 0
                ? { template: "none", values: {} }
                : { template: "env", values: { ...envValues(server) } };
          }
        } else {
          const kept =
            settings.type === "http" && server.url.trim() === settings.url;
          endpoint = kept ? String(config.endpoint) : server.url.trim();
          const keys = changed ? keysMethod(server) : null;
          const withKeys = server.bearer !== null || server.headers.length > 0;
          const current = remoteAuthOf(config, template);
          // Without keys and with the address as it was, a server keeps how
          // it signs in; otherwise the probe of its address decides.
          const decide = !withKeys && (current.kind === "keys" || !kept);
          let method: Record<string, unknown> | null = null;
          if (!kept || decide || (withKeys && changed)) {
            const headers = keys === null ? {} : (keyHeaders(server) ?? {});
            const probe = record(
              answerOf(
                await executorCall(
                  executor,
                  "POST",
                  "/mcp/probe",
                  {
                    endpoint,
                    ...(Object.keys(headers).length === 0 ? {} : { headers }),
                  },
                  60_000,
                ),
                200,
              ),
            );
            if (decide) {
              const oauth = probe.requiresOAuth === true;
              method = oauth
                ? { slug: "oauth2", kind: "oauth2" }
                : { slug: "none", kind: "none" };
              account = oauth ? "oauth2" : { template: "none", values: {} };
            }
          }
          if (withKeys && changed && keys !== null) {
            method = { ...keys.stored };
            account = { template: keysTemplate, values: { ...keys.values } };
          }
          next = {
            ...config,
            transport: "remote",
            endpoint,
            remoteTransport: config.remoteTransport ?? "auto",
            ...(method === null ? {} : { authenticationTemplate: [method] }),
          };
        }
        if (server.name.trim() !== settings.name)
          answerOf(
            await executorCall(
              executor,
              "PATCH",
              `/integrations/${encodeURIComponent(id)}`,
              { name: server.name.trim() },
            ),
            200,
          );
        if (!sameJson(next, config))
          answerOf(
            await executorCall(
              executor,
              "POST",
              `/mcp/servers/${encodeURIComponent(id)}/config`,
              { config: next },
            ),
            200,
          );
        if (account !== null) {
          const removed = await executorCall(executor, "DELETE", at);
          if (
            removed.kind !== "answer" ||
            (removed.status !== 200 && removed.status !== 404)
          )
            throw new ConnectBlocked(
              removed.kind === "unavailable"
                ? "executor-unavailable"
                : "connect-failed",
            );
          if (account === "oauth2") {
            const { url, oauth } = await startOAuth(
              executor,
              id,
              endpoint,
              null,
            );
            const session = open(id, { oauth });
            awaitOAuth(executor, session, oauth.state);
            journal({ event: "custom-update", app: id, outcome: "pending" });
            return authorize(session, url);
          }
          answerOf(
            await executorCall(executor, "POST", "/connections", {
              owner: "org",
              name: "default",
              integration: id,
              template: account.template,
              values: account.values,
            }),
            200,
          );
        }
        journal({ event: "custom-update", app: id, outcome: "saved" });
        return { kind: "saved", app: id };
      } catch (error) {
        const reason =
          error instanceof ConnectBlocked ? error.reason : "connect-failed";
        journal({
          event: "custom-update",
          app: id,
          outcome: "blocked",
          reason,
        });
        return {
          kind: "blocked",
          reason: reason === "executor-unavailable" ? reason : "connect-failed",
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
