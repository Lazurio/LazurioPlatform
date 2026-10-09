// The maintainer's refresh of the Integrace catalog (plan DEV-6626 task 683,
// docs/integrations.md "The catalog"): `bun scripts/integrations-catalog.ts
// --composio <toolkits.json> --executor <integrations.json> --icons
// <simple-icons package directory> [--out <catalog.json>] [--date
// YYYY-MM-DD]`. It reads the curated apps (scripts/integrations-apps.ts),
// checks every entry against the two public catalogs (Composio's CLI cache
// `~/.composio/toolkits.json` and Executor's cache of integrations.sh,
// `~/.executor/cache/integrations.json`), probes each official MCP endpoint
// for how it signs in, and writes `src/integrations/catalog.json`. A direct
// path is written only where the probe verified it: Executor's catalog is
// partly AI-generated. The probe sends one MCP `initialize` without
// credentials and reads public OAuth metadata; it signs in nowhere. The
// result is reviewed and published by a pull request.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type CatalogApp,
  type CatalogDirect,
  type CatalogIcon,
  catalogSchema,
  type IntegrationsCatalog,
  parseCatalog,
} from "../src/integrations/catalog-schema";
import type { DirectAuth } from "../src/integrations/path";
import { type CuratedApp, curatedApps } from "./integrations-apps";

/** What the probe learned of an official MCP endpoint. */
export type ProbeResult =
  | "none"
  | "dcr"
  | "cimd"
  | "needs-app"
  | "unreachable"
  | "unknown";

export type ProbeFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "headers" | "text">>;

const probeTimeoutMs = 8_000;

/** The two well-known addresses of a metadata document for `base`: with the
 * base's path inserted (RFC 8414 / RFC 9728), then at the root. */
function wellKnown(base: string, name: string): string[] {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, "");
  const root = `${url.protocol}//${url.host}/.well-known/${name}`;
  return path === "" ? [root] : [`${root}${path}`, root];
}

async function json(
  fetcher: ProbeFetch,
  url: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    if (response.status !== 200) return null;
    const value: unknown = JSON.parse(
      (await response.text()).slice(0, 200_000),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** How an official MCP endpoint signs in: no sign-in (`initialize` answers),
 * OAuth with dynamic client registration or a client ID metadata document
 * (one click through Executor), OAuth that needs a registered app, or it
 * could not be told. The port of the pilot's probe of 2026-10-09. */
export async function probeEndpoint(
  endpoint: string,
  fetcher: ProbeFetch,
): Promise<ProbeResult> {
  let status: number;
  let authenticate: string;
  try {
    const answer = await fetcher(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "user-agent": "lazurio-catalog-probe",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "lazurio-catalog-probe", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    status = answer.status;
    authenticate = answer.headers.get("www-authenticate") ?? "";
  } catch {
    return "unreachable";
  }
  if (status === 200) return "none";
  if (status !== 401 && status !== 403) return "unknown";
  const named = /resource_metadata="([^"]+)"/.exec(authenticate)?.[1];
  const resources = named
    ? [named]
    : wellKnown(endpoint, "oauth-protected-resource");
  let server: string | null = null;
  for (const candidate of resources) {
    const document = await json(fetcher, candidate);
    const servers = document?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      server = servers[0];
      break;
    }
  }
  const base = server ?? new URL(endpoint).origin;
  for (const candidate of [
    ...wellKnown(base, "oauth-authorization-server"),
    ...wellKnown(base, "openid-configuration"),
  ]) {
    const metadata = await json(fetcher, candidate);
    if (metadata === null) continue;
    if (typeof metadata.registration_endpoint === "string") return "dcr";
    if (metadata.client_id_metadata_document_supported === true) return "cimd";
    return "needs-app";
  }
  return "unknown";
}

type ComposioToolkit = Readonly<{ slug: string; name?: unknown }>;
type ExecutorItem = Readonly<{
  slug?: unknown;
  kind?: unknown;
  connectUrl?: unknown;
  feeds?: unknown;
}>;

/** The icons this build may bundle: simple-icons' data and SVGs. */
export type IconSource = Readonly<{
  version: string;
  data: readonly Readonly<{ slug: string; hex: string; license?: unknown }>[];
  svg: (slug: string) => Promise<string | null>;
}>;

export type BuildInput = Readonly<{
  curated: readonly CuratedApp[];
  composio: readonly ComposioToolkit[];
  executor: readonly ExecutorItem[];
  icons: IconSource;
  probe: (endpoint: string) => Promise<ProbeResult>;
  date: string;
  previous: IntegrationsCatalog | null;
  /** Where the build says what it did with each app. */
  report?: (line: string) => void;
}>;

async function iconOf(
  slug: string | undefined,
  icons: IconSource,
): Promise<CatalogIcon | undefined> {
  if (slug === undefined) return undefined;
  const entry = icons.data.find((item) => item.slug === slug);
  // Only icons simple-icons releases under its own CC0 (no license of their
  // own): anything else stays a monogram.
  if (entry === undefined || entry.license !== undefined) return undefined;
  const svg = await icons.svg(slug);
  const path = svg === null ? undefined : /<path d="([^"]+)"/.exec(svg)?.[1];
  if (path === undefined) return undefined;
  return {
    path,
    hex: entry.hex.toUpperCase(),
    source: `simple-icons@${icons.version}/${slug}`,
  };
}

const authOf: Readonly<Record<ProbeResult, DirectAuth | null>> = {
  none: "none",
  dcr: "dcr",
  cimd: "cimd",
  "needs-app": "needs-app",
  unreachable: null,
  unknown: null,
};

/** The catalog of the curated apps as both catalogs and the probe have them
 * today. Throws for an entry the catalogs no longer back: the maintainer
 * changes the curation, never the build. */
export async function buildCatalog(
  input: BuildInput,
): Promise<IntegrationsCatalog> {
  const report = input.report ?? (() => {});
  const toolkits = new Map(input.composio.map((item) => [item.slug, item]));
  const apps: CatalogApp[] = [];
  for (const curated of input.curated) {
    const toolkit =
      curated.composio === null ? undefined : (curated.composio ?? curated.id);
    if (toolkit !== undefined && !toolkits.has(toolkit))
      throw new Error(
        `Composio no longer lists the toolkit ${toolkit} of ${curated.id}`,
      );
    let direct: CatalogDirect | undefined;
    if (curated.executor !== undefined) {
      const { slug, kind } = curated.executor;
      const item = input.executor.find(
        (entry) => entry.slug === slug && entry.kind === kind,
      );
      if (item === undefined)
        throw new Error(
          `Executor no longer lists the ${kind} integration ${slug} of ${curated.id}`,
        );
      if (kind === "openapi") {
        // A company app's API: only Executor's own curated specs.
        if (curated.companyApp === undefined)
          throw new Error(
            `The API integration of ${curated.id} needs a company app`,
          );
        if (!Array.isArray(item.feeds) || !item.feeds.includes("curated"))
          throw new Error(
            `The integration ${slug} of ${curated.id} is not curated`,
          );
        direct = {
          integration: slug,
          kind,
          auth: `company-app:${curated.companyApp}`,
          verified: input.date,
        };
        report(
          `${curated.id}: direct through the company app (${curated.companyApp})`,
        );
      } else {
        const endpoint = item.connectUrl;
        if (typeof endpoint !== "string" || !endpoint.startsWith("https://"))
          throw new Error(
            `The integration ${slug} of ${curated.id} has no https endpoint`,
          );
        const result = await input.probe(endpoint);
        const auth = authOf[result];
        report(`${curated.id}: probe ${result}`);
        if (auth !== null)
          direct = {
            integration: slug,
            kind,
            endpoint,
            auth,
            verified: input.date,
          };
      }
    }
    const icon = await iconOf(curated.icon, input.icons);
    if (curated.icon !== undefined && icon === undefined)
      report(`${curated.id}: no bundled icon (${curated.icon}), a monogram`);
    apps.push({
      id: curated.id,
      name: curated.name,
      description: curated.about,
      category: curated.category,
      ...(toolkit === undefined ? {} : { composio: toolkit }),
      ...(direct === undefined ? {} : { direct }),
      ...(curated.tool === undefined ? {} : { tool: curated.tool }),
      ...(icon === undefined ? {} : { icon }),
      verified: input.date,
    });
  }
  // A new version only when an entry changed beyond its dates.
  const undated = (list: readonly CatalogApp[]) =>
    JSON.stringify(
      list.map(({ verified: _, direct, ...rest }) => ({
        ...rest,
        ...(direct === undefined
          ? {}
          : { direct: { ...direct, verified: "" } }),
      })),
    );
  const previous = input.previous;
  const version =
    previous === null
      ? 1
      : undated(previous.apps) === undated(apps)
        ? previous.version
        : previous.version + 1;
  return parseCatalog({
    schema: catalogSchema,
    version,
    generated: input.date,
    apps,
  });
}

/** simple-icons from an unpacked package directory (`npm pack
 * simple-icons@<version>`, then its `package/`). */
export async function readIcons(directory: string): Promise<IconSource> {
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ) as { version?: unknown };
  const data = JSON.parse(
    await readFile(join(directory, "data", "simple-icons.json"), "utf8"),
  ) as IconSource["data"];
  if (typeof manifest.version !== "string" || !Array.isArray(data))
    throw new Error("Not a simple-icons package directory");
  return {
    version: manifest.version,
    data,
    svg: async (slug) => {
      if (!/^[a-z0-9]+$/.test(slug)) return null;
      return readFile(join(directory, "icons", `${slug}.svg`), "utf8").catch(
        () => null,
      );
    },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      composio: { type: "string" },
      executor: { type: "string" },
      icons: { type: "string" },
      out: { type: "string" },
      date: { type: "string" },
    },
    strict: true,
  });
  if (!values.composio || !values.executor || !values.icons) {
    console.error(
      "Usage: bun scripts/integrations-catalog.ts --composio <toolkits.json> --executor <integrations.json> --icons <simple-icons package directory> [--out <catalog.json>] [--date YYYY-MM-DD]",
    );
    process.exit(2);
  }
  const out =
    values.out ??
    join(import.meta.dir, "..", "src", "integrations", "catalog.json");
  const composio = JSON.parse(
    await readFile(values.composio, "utf8"),
  ) as unknown;
  const executor = JSON.parse(await readFile(values.executor, "utf8")) as {
    data?: unknown;
  };
  if (!Array.isArray(composio) || !Array.isArray(executor.data))
    throw new Error("Unexpected catalog cache shape");
  const previous = await readFile(out, "utf8")
    .then((text) => parseCatalog(JSON.parse(text)))
    .catch(() => null);
  const catalog = await buildCatalog({
    curated: curatedApps,
    composio: composio as ComposioToolkit[],
    executor: executor.data as ExecutorItem[],
    icons: await readIcons(values.icons),
    probe: (endpoint) =>
      probeEndpoint(endpoint, (url, init) => fetch(url, init)),
    date: values.date ?? new Date().toISOString().slice(0, 10),
    previous,
    report: (line) => console.error(line),
  });
  await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`);
  const direct = catalog.apps.filter((app) => app.direct !== undefined).length;
  console.log(
    JSON.stringify({
      out,
      version: catalog.version,
      apps: catalog.apps.length,
      direct,
    }),
  );
}
