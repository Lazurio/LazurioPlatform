// A synthetic Executor 1.6.10 for the Integrace contract (decision F42): the
// subset of its typed API under `/api` that the Launchpad uses, with the
// shapes of its source (docs/integrations.md "Executor API"), on a loopback
// port of its own (never 4789). Every `/api` call but `/api/health` and the
// OAuth callback needs `Authorization: Bearer <token>`; anything else is 401
// in plain text, as Executor answers. It reaches nothing outside the test.

export type FakeIntegration = {
  slug: string;
  name: string;
  kind: "mcp" | "openapi";
  transport: "remote" | "stdio";
  endpoint?: string;
  command?: string;
  args?: string[];
  auth: "none" | "oauth2" | "header";
  tools: number;
  /** The config Executor stores (`GET /api/mcp/servers/<slug>`), as an add
   * or an edit made it; a seeded integration without one answers the
   * shape derived from the fields above. */
  config?: Record<string, unknown>;
  /** The server does not answer as it should: Executor's tool sync and its
   * liveness check fail. As in Executor 1.6.10, its connections then read
   * `degraded`, stamped `tool_sync_failed` by a sync and `probe_failed` by a
   * check, whose verdict replaces the sync's. */
  broken?: boolean;
};

export type FakeConnection = {
  owner: "org" | "user";
  name: string;
  integration: string;
  template: string;
  identityLabel: string | null;
  health: null | "healthy" | "expired" | "misconfigured" | "degraded";
  /** Why a `degraded` verdict was given (Executor's `reason`). */
  reason?: "tool_sync_failed" | "probe_failed";
  /** What the connection was created with (a key, the command's
   * environment): kept only here, where Executor keeps it. */
  secret?: string;
  /** Its values by input (`values` of `POST /api/connections`). */
  values?: Record<string, string>;
};

export type FakeExecutor = Readonly<{
  port: number;
  integrations: FakeIntegration[];
  connections: FakeConnection[];
  /** Endpoints the probe knows: whether each needs OAuth, and whether it
   * refuses a probe without this exact Authorization header. */
  probes: Map<string, { requiresOAuth: boolean; authorization?: string }>;
  /** Every call: method, path and whether it carried the right token. */
  calls: { method: string; path: string; authorized: boolean; body: unknown }[];
  /** The OAuth flows started and not finished: state → connection. */
  flows: Map<
    string,
    { integration: string; name: string; label: string | null }
  >;
  /** The person signs in (or not) at the authorization URL of `state`. */
  finish: (state: string, ok: boolean) => void;
  stop: () => Promise<void>;
}>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const tagged = (tag: string, status: number) => json({ _tag: tag }, status);

/** A connection as Executor answers it, in the list and alone. */
const shapeOf = (item: FakeConnection) => ({
  owner: item.owner,
  name: item.name,
  integration: item.integration,
  template: item.template,
  provider: "file",
  address: `tools.${item.integration}.${item.owner}.${item.name}`,
  identityLabel: item.identityLabel,
  description: null,
  expiresAt: null,
  oauthClient: null,
  oauthClientOwner: null,
  oauthScope: null,
  missingOAuthScopes: [],
  lastHealth:
    item.health === null
      ? null
      : {
          status: item.health,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
          checkedAt: 1,
          // Upstream data the Launchpad must never pass on.
          responseSample: [{ path: "x", value: "upstream-sample" }],
        },
});

/** An auth method of `POST /api/mcp/servers` as Executor stores it: the
 * request-shaped apikey dialect as canonical placements. */
function canonicalMethod(method: Record<string, unknown>) {
  if (method.type !== "apiKey") return method;
  const placements = Object.entries(
    (method.headers ?? {}) as Record<string, unknown[]>,
  ).map(([name, parts]) => {
    const prefix = parts.filter((part) => typeof part === "string").join("");
    const variable = (
      parts.find((part) => typeof part !== "string") as
        | { name: string }
        | undefined
    )?.name;
    return {
      carrier: "header",
      name,
      ...(prefix === "" ? {} : { prefix }),
      ...(variable === undefined || variable === "token" ? {} : { variable }),
    };
  });
  return { slug: method.slug ?? "apikey", kind: "apikey", placements };
}

export async function startFakeExecutor(
  token: string,
  seed: Partial<Pick<FakeExecutor, "integrations" | "connections">> = {},
  /** The preview's stand-in for a person: every OAuth flow signs in by
   * itself after this long. */
  autoFinishMs?: number,
): Promise<FakeExecutor> {
  const integrations: FakeIntegration[] = seed.integrations ?? [];
  const connections: FakeConnection[] = seed.connections ?? [];
  const probes: FakeExecutor["probes"] = new Map();
  const calls: FakeExecutor["calls"] = [];
  const flows: FakeExecutor["flows"] = new Map();
  const results = new Map<string, unknown>();
  let nextState = 1;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized =
        request.headers.get("authorization") === `Bearer ${token}`;
      let body: unknown = null;
      if (request.method === "POST" || request.method === "PATCH")
        body = await request.json().catch(() => null);
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorized,
        body,
      });
      if (url.pathname === "/api/health") return new Response("ok");
      if (!authorized)
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="executor"' },
        });
      const path = url.pathname.slice("/api".length);
      const input = (body ?? {}) as Record<string, unknown>;
      if (request.method === "GET" && path === "/integrations")
        return json(
          integrations.map((item) => ({
            slug: item.slug,
            name: item.name,
            description: item.name,
            kind: item.kind,
            canRemove: true,
            canRefresh: true,
            authMethods: [],
            ...(item.transport === "remote" && item.endpoint !== undefined
              ? { displayUrl: item.endpoint }
              : {}),
          })),
        );
      const integration = /^\/integrations\/([^/]+)$/.exec(path);
      if (request.method === "PATCH" && integration !== null) {
        const item = integrations.find(
          (entry) => entry.slug === integration[1],
        );
        if (item === undefined) return tagged("IntegrationNotFoundError", 404);
        if (typeof input.name === "string") item.name = input.name;
        return json({ slug: item.slug, name: item.name, kind: item.kind });
      }
      if (request.method === "GET" && integration !== null) {
        const item = integrations.find(
          (entry) => entry.slug === integration[1],
        );
        if (item === undefined) return tagged("IntegrationNotFoundError", 404);
        return json({
          slug: item.slug,
          name: item.name,
          description: item.name,
          kind: item.kind,
          canRemove: true,
          canRefresh: true,
          authMethods:
            item.auth === "oauth2"
              ? [
                  {
                    id: "oauth2",
                    label: "OAuth",
                    kind: "oauth",
                    template: "oauth2",
                    oauth: { discoveryUrl: item.endpoint },
                  },
                ]
              : [],
        });
      }
      if (request.method === "GET" && path === "/connections")
        return json(connections.map(shapeOf));
      if (request.method === "POST" && path === "/connections") {
        if (!integrations.some((item) => item.slug === input.integration))
          return tagged("IntegrationNotFoundError", 404);
        if (
          connections.some(
            (item) =>
              item.integration === input.integration &&
              item.name === input.name,
          )
        )
          return tagged("ConnectionAlreadyExistsError", 409);
        const broken = integrations.some(
          (item) => item.slug === input.integration && item.broken === true,
        );
        const connection: FakeConnection = {
          owner: input.owner === "user" ? "user" : "org",
          name: String(input.name),
          integration: String(input.integration),
          template: String(input.template),
          identityLabel: null,
          // Executor syncs the tools at once; a broken server fails it.
          health: broken ? "degraded" : null,
          ...(broken ? { reason: "tool_sync_failed" as const } : {}),
          ...(typeof input.value === "string" ? { secret: input.value } : {}),
          ...(typeof input.values === "object" &&
          input.values !== null &&
          Object.keys(input.values).length > 0
            ? {
                values: input.values as Record<string, string>,
                secret: Object.values(
                  input.values as Record<string, string>,
                ).join(","),
              }
            : {}),
        };
        connections.push(connection);
        return json({ owner: connection.owner, name: connection.name });
      }
      const connection = /^\/connections\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
        path,
      );
      if (request.method === "GET" && connection !== null) {
        const found = connections.find(
          (item) =>
            item.owner === connection[1] &&
            item.integration === connection[2] &&
            item.name === connection[3],
        );
        return found === undefined
          ? tagged("ConnectionNotFoundError", 404)
          : json(shapeOf(found));
      }
      // Re-syncing a connection's tools, and its liveness check: both dial
      // the server, so a broken one fails and its verdict stays failing.
      const action =
        /^\/connections\/([^/]+)\/([^/]+)\/([^/]+)\/(refresh|health)$/.exec(
          path,
        );
      if (request.method === "POST" && action !== null) {
        const found = connections.find(
          (item) =>
            item.owner === action[1] &&
            item.integration === action[2] &&
            item.name === action[3],
        );
        if (found === undefined) return tagged("ConnectionNotFoundError", 404);
        const broken = integrations.some(
          (item) => item.slug === found.integration && item.broken === true,
        );
        if (action[4] === "refresh") {
          // A failed sync stamps its verdict; a sync that works clears only
          // that stamp.
          if (broken) {
            found.health = "degraded";
            found.reason = "tool_sync_failed";
            return tagged("InternalError", 500);
          }
          if (found.reason === "tool_sync_failed") {
            found.health = null;
            delete found.reason;
          }
          return json([]);
        }
        found.health = broken ? "degraded" : "healthy";
        if (broken) found.reason = "probe_failed";
        else delete found.reason;
        return json({
          status: found.health,
          ...(found.reason === undefined ? {} : { reason: found.reason }),
          checkedAt: Date.now(),
        });
      }
      if (request.method === "DELETE" && connection !== null) {
        const index = connections.findIndex(
          (item) =>
            item.owner === connection[1] &&
            item.integration === connection[2] &&
            item.name === connection[3],
        );
        if (index < 0) return tagged("ConnectionNotFoundError", 404);
        connections.splice(index, 1);
        return json({ removed: true });
      }
      if (request.method === "POST" && path === "/mcp/probe") {
        const endpoint = String(input.endpoint);
        const known = probes.get(endpoint);
        if (known === undefined) return tagged("McpConnectionError", 400);
        // An endpoint that refuses a probe without its key.
        const headers = (input.headers ?? {}) as Record<string, string>;
        if (
          known.authorization !== undefined &&
          headers.Authorization !== known.authorization
        )
          return tagged("McpConnectionError", 400);
        return json({
          connected: !known.requiresOAuth,
          requiresAuthentication: known.requiresOAuth,
          requiresOAuth: known.requiresOAuth,
          supportsDynamicRegistration: known.requiresOAuth,
          name: "Probed",
          slug: "probed",
          toolCount: known.requiresOAuth ? null : 3,
          serverName: null,
          instructions: null,
        });
      }
      if (request.method === "POST" && path === "/mcp/servers") {
        const slug =
          typeof input.slug === "string"
            ? input.slug
            : String(input.name)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_");
        if (integrations.some((item) => item.slug === slug))
          return tagged("IntegrationAlreadyExistsError", 409);
        const stdio = input.transport === "stdio";
        const auth = (input.auth as { kind?: string } | undefined)?.kind;
        const template = input.authenticationTemplate as
          | Record<string, unknown>[]
          | undefined;
        const env = input.env as Record<string, string> | undefined;
        integrations.push({
          slug,
          name: String(input.name),
          kind: "mcp",
          transport: stdio ? "stdio" : "remote",
          ...(stdio
            ? {
                command: String(input.command),
                args: (input.args as string[]) ?? [],
              }
            : { endpoint: String(input.endpoint) }),
          auth:
            auth === "oauth2"
              ? "oauth2"
              : auth === "header" || template !== undefined
                ? "header"
                : "none",
          tools: 3,
          config: stdio
            ? {
                transport: "stdio",
                command: input.command,
                ...(Array.isArray(input.args) && input.args.length > 0
                  ? { args: input.args }
                  : {}),
                ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
                // A legacy plaintext environment the page must never see.
                env: { LEGACY: "legacy-env-value" },
                authenticationTemplate:
                  env === undefined
                    ? [{ slug: "none", kind: "none" }]
                    : [
                        {
                          slug: "env",
                          kind: "stdio_env",
                          vars: Object.keys(env),
                        },
                      ],
              }
            : {
                transport: "remote",
                endpoint: input.endpoint,
                remoteTransport: input.remoteTransport ?? "auto",
                authenticationTemplate:
                  template !== undefined
                    ? template.map(canonicalMethod)
                    : auth === "header"
                      ? [
                          {
                            slug: "header",
                            kind: "apikey",
                            placements: [
                              {
                                carrier: "header",
                                name: (input.auth as { headerName: string })
                                  .headerName,
                              },
                            ],
                          },
                        ]
                      : [{ slug: auth ?? "none", kind: auth ?? "none" }],
              },
        });
        // A command server gets its connection at once, as Executor does.
        if (stdio)
          connections.push({
            owner: "org",
            name: "default",
            integration: slug,
            template: env === undefined ? "none" : "env",
            identityLabel: null,
            health: null,
            ...(env === undefined
              ? {}
              : { secret: Object.values(env).join(","), values: env }),
          });
        return json({ slug });
      }
      const server = /^\/mcp\/servers\/([^/]+)$/.exec(path);
      if (server !== null) {
        const index = integrations.findIndex((item) => item.slug === server[1]);
        if (request.method === "DELETE") {
          if (index < 0) return tagged("IntegrationNotFoundError", 404);
          const slug = integrations[index]?.slug;
          integrations.splice(index, 1);
          for (let at = connections.length - 1; at >= 0; at -= 1)
            if (connections[at]?.integration === slug)
              connections.splice(at, 1);
          return json({ removed: true });
        }
        const item = integrations[index];
        if (item === undefined) return json(null);
        return json({
          slug: item.slug,
          description: item.name,
          kind: "mcp",
          canRemove: true,
          canRefresh: true,
          config:
            item.config ??
            (item.transport === "stdio"
              ? {
                  transport: "stdio",
                  command: item.command,
                  args: item.args,
                  // A legacy plaintext environment the page must never see.
                  env: { LEGACY: "legacy-env-value" },
                  authenticationTemplate: [],
                }
              : {
                  transport: "remote",
                  endpoint: item.endpoint,
                  authenticationTemplate: [],
                }),
        });
      }
      // Executor's configureServer: the whole config is replaced.
      const configure = /^\/mcp\/servers\/([^/]+)\/config$/.exec(path);
      if (request.method === "POST" && configure !== null) {
        const item = integrations.find((entry) => entry.slug === configure[1]);
        if (item === undefined) return tagged("IntegrationNotFoundError", 404);
        const config = input.config as Record<string, unknown>;
        item.config = config;
        if (config.transport === "remote")
          item.endpoint = String(config.endpoint);
        else {
          item.command = String(config.command);
          item.args = (config.args as string[] | undefined) ?? [];
        }
        return json({ config });
      }
      if (request.method === "GET" && path === "/tools") {
        const slug = url.searchParams.get("integration");
        const item = integrations.find((entry) => entry.slug === slug);
        return json(
          Array.from({ length: item?.tools ?? 0 }, (_, index) => ({
            address: `tools.${slug}.org.default.t${index}`,
            name: `t${index}`,
          })),
        );
      }
      if (request.method === "POST" && path === "/oauth/probe")
        return json({
          issuer: "https://auth.example.test",
          authorizationUrl: "https://auth.example.test/authorize",
          tokenUrl: "https://auth.example.test/token",
          registrationEndpoint: "https://auth.example.test/register",
          scopesSupported: ["read"],
        });
      if (
        request.method === "POST" &&
        path === "/oauth/clients/register-dynamic"
      )
        return json({ client: input.slug });
      if (request.method === "POST" && path === "/oauth/clients")
        return json({ client: { slug: input.slug } });
      if (request.method === "POST" && path === "/oauth/start") {
        const state = `state${nextState++}`;
        flows.set(state, {
          integration: String(input.integration),
          name: String(input.name),
          label:
            typeof input.identityLabel === "string"
              ? input.identityLabel
              : null,
        });
        if (autoFinishMs !== undefined)
          setTimeout(() => {
            if (flows.has(state)) finish(state, true);
          }, autoFinishMs);
        return json({
          status: "redirect",
          authorizationUrl: `https://auth.example.test/authorize?state=${state}`,
          state,
        });
      }
      if (request.method === "POST" && path === "/oauth/cancel") {
        flows.delete(String(input.state));
        return json({});
      }
      const awaited = /^\/oauth\/await\/([^/]+)$/.exec(path);
      if (request.method === "GET" && awaited !== null) {
        const state = awaited[1] as string;
        // A long poll: up to a moment here, then null (still pending).
        for (let tries = 0; tries < 10 && !results.has(state); tries += 1)
          await Bun.sleep(20);
        const result = results.get(state) ?? null;
        results.delete(state);
        return json(result);
      }
      return tagged("NotFound", 404);
    },
  });
  function finish(state: string, ok: boolean) {
    const flow = flows.get(state);
    if (flow === undefined) throw new Error(`No flow ${state}`);
    flows.delete(state);
    if (ok)
      connections.push({
        owner: "org",
        name: flow.name,
        integration: flow.integration,
        template: "oauth2",
        identityLabel: flow.label ?? "person@example.test",
        health: "healthy",
      });
    results.set(
      state,
      ok
        ? { type: "executor:oauth-result", ok: true, sessionId: state }
        : {
            type: "executor:oauth-result",
            ok: false,
            sessionId: state,
            error: "access_denied",
          },
    );
  }
  return {
    port: server.port as number,
    integrations,
    connections,
    probes,
    calls,
    flows,
    finish,
    stop: async () => {
      await server.stop(true);
    },
  };
}
