import { expect, test } from "bun:test";
import type { CuratedApp } from "../scripts/integrations-apps";
import {
  buildCatalog,
  type IconSource,
  type ProbeFetch,
  probeEndpoint,
} from "../scripts/integrations-catalog";
import { integrationsCatalog } from "../src/integrations/catalog";
import { parseCatalog } from "../src/integrations/catalog-schema";

// The Integrace catalog (plan DEV-6626 task 683): the maintainer's build
// merges the curated apps with Composio's and Executor's catalogs and writes
// a direct path only where the probe of the official endpoint verified it.

const curated: CuratedApp[] = [
  {
    id: "notion",
    name: { cs: "Notion", en: "Notion" },
    about: { cs: "Poznámky.", en: "Notes." },
    category: "docs",
    executor: { slug: "notion-com", kind: "mcp" },
    icon: "notion",
  },
  {
    id: "gmail",
    name: { cs: "Gmail", en: "Gmail" },
    about: { cs: "Pošta.", en: "Mail." },
    category: "mail",
    executor: { slug: "google-gmail", kind: "openapi" },
    companyApp: "google",
    tool: "gogcli",
  },
  {
    id: "slack",
    name: { cs: "Slack", en: "Slack" },
    about: { cs: "Chat.", en: "Chat." },
    category: "chat",
    executor: { slug: "slack-com", kind: "mcp" },
    icon: "slack",
  },
  {
    id: "quickbooks",
    name: { cs: "QuickBooks", en: "QuickBooks" },
    about: { cs: "Účetnictví.", en: "Accounting." },
    category: "finance",
    executor: { slug: "quickbooks", kind: "mcp" },
  },
  {
    id: "whatsapp",
    name: { cs: "WhatsApp", en: "WhatsApp" },
    about: { cs: "Zprávy.", en: "Messages." },
    category: "chat",
    composio: null,
    tool: "wacli",
  },
];

const composio = [
  { slug: "notion" },
  { slug: "gmail" },
  { slug: "slack" },
  { slug: "quickbooks" },
];
const executor = [
  {
    slug: "notion-com",
    kind: "mcp",
    connectUrl: "https://mcp.notion.example/mcp",
    feeds: ["curated"],
  },
  // A slug that repeats under another kind is not the MCP server.
  { slug: "slack-com", kind: "cli", feeds: ["discovered"] },
  {
    slug: "slack-com",
    kind: "mcp",
    connectUrl: "https://mcp.slack.example/mcp",
    feeds: ["curated"],
  },
  {
    slug: "google-gmail",
    kind: "openapi",
    url: "https://integrations.example/specs/google-gmail.json",
    feeds: ["curated"],
  },
  {
    slug: "quickbooks",
    kind: "mcp",
    connectUrl: "https://mcp.quickbooks.example/mcp",
    feeds: ["claude"],
  },
];
const icons: IconSource = {
  version: "1.0.0",
  data: [
    { slug: "notion", hex: "000000" },
    { slug: "slack", hex: "4a154b", license: { type: "custom" } },
  ],
  svg: async (slug) =>
    slug === "notion"
      ? '<svg role="img" viewBox="0 0 24 24"><title>Notion</title><path d="M4 4h16v16H4z"/></svg>'
      : null,
};
const probes: Record<string, "dcr" | "needs-app" | "unknown"> = {
  "https://mcp.notion.example/mcp": "dcr",
  "https://mcp.slack.example/mcp": "needs-app",
  "https://mcp.quickbooks.example/mcp": "unknown",
};

test("the build merges both catalogs, the probe decides the direct paths, and the icons are bundled", async () => {
  const lines: string[] = [];
  const catalog = await buildCatalog({
    curated,
    composio,
    executor,
    icons,
    probe: async (endpoint) => probes[endpoint] ?? "unreachable",
    date: "2026-10-09",
    previous: null,
    report: (line) => lines.push(line),
  });
  expect(catalog).toEqual({
    schema: "lazurio.integrations-catalog.v1",
    version: 1,
    generated: "2026-10-09",
    apps: [
      {
        id: "notion",
        name: { cs: "Notion", en: "Notion" },
        description: { cs: "Poznámky.", en: "Notes." },
        category: "docs",
        composio: "notion",
        direct: {
          integration: "notion-com",
          kind: "mcp",
          endpoint: "https://mcp.notion.example/mcp",
          auth: "dcr",
          verified: "2026-10-09",
        },
        icon: {
          path: "M4 4h16v16H4z",
          hex: "000000",
          source: "simple-icons@1.0.0/notion",
        },
        verified: "2026-10-09",
      },
      {
        id: "gmail",
        name: { cs: "Gmail", en: "Gmail" },
        description: { cs: "Pošta.", en: "Mail." },
        category: "mail",
        composio: "gmail",
        direct: {
          integration: "google-gmail",
          kind: "openapi",
          auth: "company-app:google",
          verified: "2026-10-09",
        },
        tool: "gogcli",
        verified: "2026-10-09",
      },
      {
        // An icon with a license of its own stays a monogram.
        id: "slack",
        name: { cs: "Slack", en: "Slack" },
        description: { cs: "Chat.", en: "Chat." },
        category: "chat",
        composio: "slack",
        direct: {
          integration: "slack-com",
          kind: "mcp",
          endpoint: "https://mcp.slack.example/mcp",
          auth: "needs-app",
          verified: "2026-10-09",
        },
        verified: "2026-10-09",
      },
      {
        // The probe could not tell: no direct path.
        id: "quickbooks",
        name: { cs: "QuickBooks", en: "QuickBooks" },
        description: { cs: "Účetnictví.", en: "Accounting." },
        category: "finance",
        composio: "quickbooks",
        verified: "2026-10-09",
      },
      {
        id: "whatsapp",
        name: { cs: "WhatsApp", en: "WhatsApp" },
        description: { cs: "Zprávy.", en: "Messages." },
        category: "chat",
        tool: "wacli",
        verified: "2026-10-09",
      },
    ],
  });
  expect(lines).toContain("quickbooks: probe unknown");
  expect(lines).toContain("slack: no bundled icon (slack), a monogram");
  // A refresh that changes only dates keeps the version; a change bumps it.
  const again = await buildCatalog({
    curated,
    composio,
    executor,
    icons,
    probe: async (endpoint) => probes[endpoint] ?? "unreachable",
    date: "2026-11-01",
    previous: catalog,
  });
  expect(again.version).toBe(1);
  expect(again.generated).toBe("2026-11-01");
  const changed = await buildCatalog({
    curated,
    composio,
    executor,
    icons,
    probe: async () => "unreachable",
    date: "2026-11-01",
    previous: catalog,
  });
  expect(changed.version).toBe(2);
  expect(changed.apps.filter((app) => app.direct?.kind === "mcp")).toEqual([]);
});

test("an entry the catalogs no longer back fails the build instead of shipping", async () => {
  const build = (input: Partial<Parameters<typeof buildCatalog>[0]>) =>
    buildCatalog({
      curated,
      composio,
      executor,
      icons,
      probe: async () => "dcr",
      date: "2026-10-09",
      previous: null,
      ...input,
    });
  await expect(
    build({ composio: composio.filter((item) => item.slug !== "slack") }),
  ).rejects.toThrow("Composio no longer lists the toolkit slack of slack");
  await expect(
    build({
      executor: executor.filter((item) => item.slug !== "notion-com"),
    }),
  ).rejects.toThrow("Executor no longer lists the mcp integration notion-com");
  // A company app's API only from Executor's own curated specs.
  await expect(
    build({
      executor: executor.map((item) =>
        item.slug === "google-gmail"
          ? { ...item, feeds: ["discovered"] }
          : item,
      ),
    }),
  ).rejects.toThrow("is not curated");
});

/** A fake of the public endpoints the probe asks. */
function endpoints(
  answers: Record<string, { status: number; body?: unknown; www?: string }>,
): ProbeFetch {
  return async (url) => {
    const answer = answers[url];
    if (answer === undefined)
      return { status: 404, headers: new Headers(), text: async () => "" };
    return {
      status: answer.status,
      headers: new Headers(
        answer.www === undefined ? {} : { "www-authenticate": answer.www },
      ),
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
}

test("the probe tells no sign-in, dynamic registration, a client metadata document and a registered app apart", async () => {
  const endpoint = "https://mcp.example.test/mcp";
  expect(
    await probeEndpoint(endpoint, endpoints({ [endpoint]: { status: 200 } })),
  ).toBe("none");
  // The resource names its metadata, which names the authorization server.
  const dcr = endpoints({
    [endpoint]: {
      status: 401,
      www: 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    },
    "https://mcp.example.test/.well-known/oauth-protected-resource/mcp": {
      status: 200,
      body: { authorization_servers: ["https://auth.example.test"] },
    },
    "https://auth.example.test/.well-known/oauth-authorization-server": {
      status: 200,
      body: { registration_endpoint: "https://auth.example.test/register" },
    },
  });
  expect(await probeEndpoint(endpoint, dcr)).toBe("dcr");
  // Without a named document: the well-known one, then the server's
  // OpenID configuration.
  const cimd = endpoints({
    [endpoint]: { status: 401 },
    "https://mcp.example.test/.well-known/oauth-protected-resource/mcp": {
      status: 200,
      body: { authorization_servers: ["https://auth.example.test/tenant"] },
    },
    "https://auth.example.test/.well-known/openid-configuration/tenant": {
      status: 200,
      body: { client_id_metadata_document_supported: true },
    },
  });
  expect(await probeEndpoint(endpoint, cimd)).toBe("cimd");
  const app = endpoints({
    [endpoint]: { status: 403 },
    "https://mcp.example.test/.well-known/oauth-authorization-server": {
      status: 200,
      body: { authorization_endpoint: "https://mcp.example.test/authorize" },
    },
  });
  expect(await probeEndpoint(endpoint, app)).toBe("needs-app");
  expect(
    await probeEndpoint(endpoint, endpoints({ [endpoint]: { status: 401 } })),
  ).toBe("unknown");
  expect(
    await probeEndpoint(endpoint, endpoints({ [endpoint]: { status: 500 } })),
  ).toBe("unknown");
  expect(
    await probeEndpoint(endpoint, async () => {
      throw new Error("offline");
    }),
  ).toBe("unreachable");
});

test("the shipped catalog is valid, and every direct path is verified", () => {
  // The module checks it as it loads; parsing it again is the same.
  expect(parseCatalog(JSON.parse(JSON.stringify(integrationsCatalog)))).toEqual(
    integrationsCatalog,
  );
  expect(integrationsCatalog.apps.length).toBeGreaterThanOrEqual(40);
  expect(integrationsCatalog.apps.length).toBeLessThanOrEqual(80);
  for (const app of integrationsCatalog.apps) {
    if (app.direct?.kind === "mcp")
      expect(app.direct.endpoint?.startsWith("https://")).toBe(true);
    if (app.direct?.kind === "openapi")
      expect(app.direct.auth.startsWith("company-app:")).toBe(true);
  }
  // The tools for one app map to their apps.
  const byTool = Object.fromEntries(
    integrationsCatalog.apps
      .filter((app) => app.tool !== undefined)
      .map((app) => [app.id, app.tool]),
  );
  expect(byTool).toMatchObject({
    github: "gh",
    whatsapp: "wacli",
    gmail: "gogcli",
    neon: "neon",
  });
});

test("a catalog of another shape is refused", () => {
  const valid = JSON.parse(JSON.stringify(integrationsCatalog));
  for (const broken of [
    { ...valid, extra: true },
    { ...valid, schema: "other" },
    { ...valid, apps: [...valid.apps, valid.apps[0]] },
    {
      ...valid,
      apps: [{ ...valid.apps[0], id: "Not An Id" }],
    },
    {
      ...valid,
      apps: [
        {
          ...valid.apps[0],
          direct: {
            integration: "x",
            kind: "mcp",
            endpoint: "http://insecure.example/mcp",
            auth: "dcr",
            verified: "2026-10-09",
          },
        },
      ],
    },
    {
      ...valid,
      apps: [
        {
          id: "orphan",
          name: { cs: "A", en: "A" },
          description: { cs: "A.", en: "A." },
          category: "other",
          verified: "2026-10-09",
        },
      ],
    },
  ])
    expect(() => parseCatalog(broken)).toThrow();
  // One app per Executor integration and per MCP endpoint (an integration is
  // a catalog app only at its endpoint): a second app on either is refused.
  const notion = valid.apps.find(
    (entry: { id: string }) => entry.id === "notion",
  );
  for (const twin of [
    {
      ...notion,
      id: "notion-twin",
      direct: {
        ...notion.direct,
        integration: "notion-twin",
        endpoint: `${notion.direct.endpoint}/`,
      },
    },
    {
      ...notion,
      id: "notion-twin",
      direct: {
        ...notion.direct,
        endpoint: "https://mcp.notion-twin.example/mcp",
      },
    },
  ])
    expect(() =>
      parseCatalog({ ...valid, apps: [...valid.apps, twin] }),
    ).toThrow(/Duplicate (MCP endpoint|integration slug)/);
});
