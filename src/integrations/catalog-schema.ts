import {
  type AppTool,
  appTools,
  type DirectAuth,
  directAuths,
  integrationIdPattern,
} from "./path";

// The shape of the Integrace catalog (plan DEV-6626 task 683, decision F42):
// the apps Lazurio offers to connect, one entry per app, merged from
// Composio's catalog and Executor's (integrations.sh) by
// `scripts/integrations-catalog.ts` and checked in as `catalog.json`. A maintainer refreshes it with that
// script and a pull request (docs/integrations.md "The catalog"). Executor's
// catalog is partly AI-generated: an entry carries a direct path only where
// the script's probe of the official endpoint verified it, with the date.
// Names and descriptions are curated in Czech and English; icons are bundled
// (simple-icons, CC0) so the page never asks a third party for a logo.

export const catalogSchema = "lazurio.integrations-catalog.v1";

/** An endpoint as it is shown and compared: scheme, host and path, never
 * userinfo or a query, which may carry a key; null where it is no http(s)
 * URL. Two servers are the same only at the same canonical endpoint. */
export function canonicalEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export const categories = [
  "mail",
  "chat",
  "docs",
  "projects",
  "crm",
  "dev",
  "marketing",
  "finance",
  "other",
] as const;
export type Category = (typeof categories)[number];

export type Localized = Readonly<{ cs: string; en: string }>;

/** The direct path of an app: its integration in Executor's catalog. */
export type CatalogDirect = Readonly<{
  /** The integration's slug in Executor's catalog (integrations.sh). */
  integration: string;
  /** `mcp`: an official remote MCP server at `endpoint`; `openapi`: an API
   * Executor describes from its spec, signed in with a company app. */
  kind: "mcp" | "openapi";
  /** The official MCP endpoint (`mcp` only). */
  endpoint?: string;
  auth: DirectAuth;
  /** When the probe last verified the endpoint's sign-in (YYYY-MM-DD). */
  verified: string;
}>;

export type CatalogIcon = Readonly<{
  /** The SVG path of a 24×24 viewBox, drawn in `hex`. */
  path: string;
  hex: string;
  /** Where it comes from: `simple-icons@<version>/<slug>` (CC0-1.0). */
  source: string;
}>;

export type CatalogApp = Readonly<{
  id: string;
  name: Localized;
  description: Localized;
  category: Category;
  /** Composio's toolkit slug, where Composio has the app. */
  composio?: string;
  direct?: CatalogDirect;
  /** The app's own tool in Settings → Tools. */
  tool?: AppTool;
  icon?: CatalogIcon;
  /** When the entry was last built from both catalogs (YYYY-MM-DD). */
  verified: string;
}>;

export type IntegrationsCatalog = Readonly<{
  schema: typeof catalogSchema;
  /** Bumped by every refresh that changes an entry. */
  version: number;
  generated: string;
  apps: readonly CatalogApp[];
}>;

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const slugPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function own(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Catalog value is not an object");
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = own(value);
  for (const key of Object.keys(record))
    if (!required.includes(key) && !optional.includes(key))
      throw new Error(`Unknown catalog key ${key}`);
  for (const key of required)
    if (!Object.hasOwn(record, key))
      throw new Error(`Missing catalog key ${key}`);
  return record;
}

const text = (value: unknown, max = 200): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max)
    throw new Error("Invalid catalog text");
  return value;
};

const localized = (value: unknown, max?: number): Localized => {
  const record = exact(value, ["cs", "en"]);
  return Object.freeze({ cs: text(record.cs, max), en: text(record.en, max) });
};

const date = (value: unknown): string => {
  if (typeof value !== "string" || !datePattern.test(value))
    throw new Error("Invalid catalog date");
  return value;
};

function parseDirect(value: unknown): CatalogDirect {
  const record = exact(
    value,
    ["integration", "kind", "auth", "verified"],
    ["endpoint"],
  );
  if (
    typeof record.integration !== "string" ||
    !slugPattern.test(record.integration)
  )
    throw new Error("Invalid integration slug");
  if (record.kind !== "mcp" && record.kind !== "openapi")
    throw new Error("Invalid direct kind");
  if (!(directAuths as readonly unknown[]).includes(record.auth))
    throw new Error("Invalid direct auth");
  const auth = record.auth as DirectAuth;
  const companyApp = auth.startsWith("company-app:");
  if (record.kind === "openapi" && !companyApp)
    throw new Error("An API integration signs in with a company app");
  let endpoint: string | undefined;
  if (record.kind === "mcp") {
    endpoint = text(record.endpoint, 500);
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid MCP endpoint");
  } else if (record.endpoint !== undefined)
    throw new Error("An API integration has no MCP endpoint");
  return Object.freeze({
    integration: record.integration,
    kind: record.kind,
    ...(endpoint === undefined ? {} : { endpoint }),
    auth,
    verified: date(record.verified),
  });
}

function parseIcon(value: unknown): CatalogIcon {
  const record = exact(value, ["path", "hex", "source"]);
  const path = text(record.path, 20_000);
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(path))
    throw new Error("Invalid icon path");
  if (typeof record.hex !== "string" || !/^[0-9A-F]{6}$/.test(record.hex))
    throw new Error("Invalid icon colour");
  return Object.freeze({
    path,
    hex: record.hex,
    source: text(record.source, 120),
  });
}

/** One validated catalog: exact keys, unique ids, every value of its shape. */
export function parseCatalog(value: unknown): IntegrationsCatalog {
  const record = exact(value, ["schema", "version", "generated", "apps"]);
  if (record.schema !== catalogSchema)
    throw new Error("Unknown catalog schema");
  if (
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1
  )
    throw new Error("Invalid catalog version");
  if (!Array.isArray(record.apps)) throw new Error("Invalid catalog apps");
  const ids = new Set<string>();
  // One app per Executor integration and per MCP endpoint: an integration is
  // a catalog app only at its endpoint (decision F42).
  const integrationSlugs = new Set<string>();
  const endpoints = new Set<string>();
  const apps = record.apps.map((entry): CatalogApp => {
    const app = exact(
      entry,
      ["id", "name", "description", "category", "verified"],
      ["composio", "direct", "tool", "icon"],
    );
    if (typeof app.id !== "string" || !integrationIdPattern.test(app.id))
      throw new Error("Invalid app id");
    if (ids.has(app.id)) throw new Error("Duplicate app id");
    ids.add(app.id);
    if (!(categories as readonly unknown[]).includes(app.category))
      throw new Error("Invalid category");
    if (
      app.composio !== undefined &&
      (typeof app.composio !== "string" || !slugPattern.test(app.composio))
    )
      throw new Error("Invalid Composio toolkit");
    if (
      app.tool !== undefined &&
      !(appTools as readonly unknown[]).includes(app.tool)
    )
      throw new Error("Invalid app tool");
    const direct =
      app.direct === undefined ? undefined : parseDirect(app.direct);
    if (direct !== undefined) {
      if (integrationSlugs.has(direct.integration))
        throw new Error("Duplicate integration slug");
      integrationSlugs.add(direct.integration);
      if (direct.endpoint !== undefined) {
        const endpoint = canonicalEndpoint(direct.endpoint) ?? "";
        if (endpoints.has(endpoint)) throw new Error("Duplicate MCP endpoint");
        endpoints.add(endpoint);
      }
    }
    if (
      app.composio === undefined &&
      direct === undefined &&
      app.tool === undefined
    )
      throw new Error("An app needs a path");
    return Object.freeze({
      id: app.id,
      name: localized(app.name, 60),
      description: localized(app.description, 160),
      category: app.category as Category,
      ...(app.composio === undefined
        ? {}
        : { composio: app.composio as string }),
      ...(direct === undefined ? {} : { direct }),
      ...(app.tool === undefined ? {} : { tool: app.tool as AppTool }),
      ...(app.icon === undefined ? {} : { icon: parseIcon(app.icon) }),
      verified: date(app.verified),
    });
  });
  return Object.freeze({
    schema: catalogSchema,
    version: record.version,
    generated: date(record.generated),
    apps: Object.freeze(apps),
  });
}
