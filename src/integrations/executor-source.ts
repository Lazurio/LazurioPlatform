import type { IntegrationsCatalog } from "./catalog-schema";
import {
  type ExecutorEndpoint,
  type ExecutorResult,
  executorCall,
} from "./executor-client";
import {
  type AccountState,
  catalogAppOf,
  type ExecutorConnection,
  type ExecutorIntegration,
  type ExecutorReading,
  shownEndpoint,
} from "./model";

// What the Environment's Executor holds (decision F42), read over its typed
// API (Executor 1.6.10, docs/integrations.md "Executor API"):
// - `GET /api/integrations`: `[{slug, name, kind, displayUrl?, …}]`, `kind`
//   the owning plugin (`mcp`, `openapi`, `graphql`; static namespaces such as
//   Executor's own tools are left out);
// - `GET /api/connections`: `[{owner, name, integration, identityLabel,
//   lastHealth: null | {status, identity?}}]`, keyed by owner, integration
//   and name; `lastHealth.status` is `healthy`, `expired`, `misconfigured`,
//   `degraded` or `unknown`;
// - `GET /api/mcp/servers/<slug>`: a custom server's transport, endpoint or
//   command; `GET /api/tools?integration=<slug>`: its tools.
// Only the fields named here are read; an answer of another shape makes the
// source `unreadable`, never a guess. A connection's health detail and
// response samples (upstream data) are never read.

const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const labelMax = 120;

class Unreadable extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Unreadable();
  return value as Record<string, unknown>;
}

function list(result: ExecutorResult): unknown[] {
  if (result.kind !== "answer") throw result;
  if (result.status !== 200 || !Array.isArray(result.body))
    throw new Unreadable();
  return result.body;
}

const label = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Unreadable();
  const text = value
    .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "")
    .trim();
  return text === "" ? null : Array.from(text).slice(0, labelMax).join("");
};

/** Executor's health verdict as an account's state; a connection never
 * checked counts as connected. */
export function healthState(lastHealth: unknown): AccountState {
  if (lastHealth === null || lastHealth === undefined) return "connected";
  const status = object(lastHealth).status;
  if (status === "expired") return "expired";
  if (status === "misconfigured") return "failed";
  if (status === "healthy" || status === "degraded" || status === "unknown")
    return "connected";
  throw new Unreadable();
}

export function parseConnections(values: unknown[]): ExecutorConnection[] {
  return values.map((value) => {
    const connection = object(value);
    const { owner, name, integration } = connection;
    if (
      (owner !== "org" && owner !== "user") ||
      typeof name !== "string" ||
      !namePattern.test(name) ||
      typeof integration !== "string" ||
      !slugPattern.test(integration)
    )
      throw new Unreadable();
    const health = connection.lastHealth;
    const identity =
      health === null || health === undefined
        ? null
        : label(object(health).identity);
    return Object.freeze({
      id: `${owner}/${integration}/${name}`,
      integration,
      label:
        label(connection.identityLabel) ??
        identity ??
        (name === "default" ? null : name),
      state: healthState(health),
    });
  });
}

type Listed = Readonly<{
  slug: string;
  name: string;
  kind: "mcp" | "api";
  displayUrl: string | null;
}>;

export function parseIntegrationList(values: unknown[]): Listed[] {
  const listed: Listed[] = [];
  for (const value of values) {
    const integration = object(value);
    const { slug, name, kind, displayUrl } = integration;
    if (
      typeof slug !== "string" ||
      typeof name !== "string" ||
      typeof kind !== "string"
    )
      throw new Unreadable();
    // Executor's own tools and other static namespaces are no Integrace.
    if (kind !== "mcp" && kind !== "openapi" && kind !== "graphql") continue;
    if (!slugPattern.test(slug)) throw new Unreadable();
    if (displayUrl !== undefined && typeof displayUrl !== "string")
      throw new Unreadable();
    listed.push({
      slug,
      name: label(name) ?? slug,
      kind: kind === "mcp" ? "mcp" : "api",
      displayUrl: typeof displayUrl === "string" ? displayUrl : null,
    });
  }
  return listed;
}

/** A custom MCP server's transport and target (`GET /api/mcp/servers/<slug>`). */
async function serverOf(
  host: ExecutorEndpoint,
  slug: string,
): Promise<Pick<ExecutorIntegration, "kind" | "target">> {
  const result = await executorCall(
    host,
    "GET",
    `/mcp/servers/${encodeURIComponent(slug)}`,
  );
  if (result.kind !== "answer") throw result;
  if (result.status !== 200) throw new Unreadable();
  const config = object(object(result.body).config);
  if (config.transport === "remote" && typeof config.endpoint === "string")
    return { kind: "remote", target: shownEndpoint(config.endpoint) };
  if (config.transport === "stdio" && typeof config.command === "string")
    // The command line is the person's own; its environment never leaves.
    return { kind: "command", target: null };
  throw new Unreadable();
}

async function toolCount(
  host: ExecutorEndpoint,
  slug: string,
): Promise<number | null> {
  const result = await executorCall(
    host,
    "GET",
    `/tools?integration=${encodeURIComponent(slug)}`,
  );
  return result.kind === "answer" &&
    result.status === 200 &&
    Array.isArray(result.body)
    ? result.body.length
    : null;
}

/** Everything the Environment's Executor holds, or why it cannot be told. */
export async function readExecutor(
  host: ExecutorEndpoint | null,
  catalog: IntegrationsCatalog,
): Promise<ExecutorReading> {
  // No Executor to ask: none is part of this Environment.
  if (host === null) return { state: "absent" };
  try {
    const listed = parseIntegrationList(
      list(await executorCall(host, "GET", "/integrations")),
    );
    const connections = parseConnections(
      list(await executorCall(host, "GET", "/connections")),
    );
    const integrations: ExecutorIntegration[] = [];
    for (const item of listed) {
      if (item.kind === "api") {
        integrations.push({
          slug: item.slug,
          name: item.name,
          kind: "api",
          target: null,
          tools: null,
        });
        continue;
      }
      const shown =
        item.displayUrl === null ? null : shownEndpoint(item.displayUrl);
      if (
        catalogAppOf(catalog, { slug: item.slug, target: shown }) !== undefined
      ) {
        integrations.push({
          slug: item.slug,
          name: item.name,
          kind: "remote",
          target: shown,
          tools: null,
        });
        continue;
      }
      const server = await serverOf(host, item.slug);
      integrations.push({
        slug: item.slug,
        name: item.name,
        ...server,
        tools: await toolCount(host, item.slug),
      });
    }
    return Object.freeze({
      state: "ok",
      integrations: Object.freeze(integrations),
      connections: Object.freeze(connections),
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { kind?: unknown }).kind === "unavailable"
    )
      return { state: "unavailable" };
    return { state: "unreadable" };
  }
}
