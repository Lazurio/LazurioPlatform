import { expect, test } from "bun:test";
import type { IntegrationsCatalog } from "../src/integrations/catalog-schema";
import {
  composioState,
  parseComposioConnections,
} from "../src/integrations/composio-source";
import {
  catalogAppOf,
  forAdmin,
  type MergeInput,
  mergeIntegrations,
} from "../src/integrations/model";
import { executorHere, scopeOf } from "../src/integrations/read";
import type { ToolOverview, ToolsOverview } from "../src/tools/overview";

// The one list of an Environment's Integrace (decision F42): three sources
// merged, one path per app, accounts on another way marked spare, every
// source's own state kept, Composio only where it is allowed.

const app = (
  id: string,
  extra: Partial<IntegrationsCatalog["apps"][number]> = {},
): IntegrationsCatalog["apps"][number] => ({
  id,
  name: { cs: `${id} cs`, en: `${id} en` },
  description: { cs: "Popis.", en: "About." },
  category: "other",
  composio: id,
  verified: "2026-10-09",
  ...extra,
});

const catalog: IntegrationsCatalog = {
  schema: "lazurio.integrations-catalog.v1",
  version: 1,
  generated: "2026-10-09",
  apps: [
    app("notion", {
      direct: {
        integration: "notion-com",
        kind: "mcp",
        endpoint: "https://mcp.notion.example/mcp",
        auth: "dcr",
        verified: "2026-10-09",
      },
    }),
    app("gmail", {
      direct: {
        integration: "google-gmail",
        kind: "openapi",
        auth: "company-app:google",
        verified: "2026-10-09",
      },
      tool: "gogcli",
    }),
    app("github", {
      direct: {
        integration: "github-com",
        kind: "mcp",
        endpoint: "https://api.github.example/mcp/",
        auth: "needs-app",
        verified: "2026-10-09",
      },
      tool: "gh",
    }),
    app("salesforce"),
    {
      id: "whatsapp",
      name: { cs: "WhatsApp", en: "WhatsApp" },
      description: { cs: "Zprávy.", en: "Messages." },
      category: "chat",
      tool: "wacli",
      verified: "2026-10-09",
    },
  ],
};

const base: MergeInput = {
  catalog,
  locale: "en",
  scope: "personal",
  origin: null,
  policy: { allowed: true, source: "environment" },
  composioReady: true,
  tools: { state: "ok", connected: [] },
  executor: { state: "ok", integrations: [], connections: [] },
  composio: { state: "ok", accounts: [] },
  readAt: "2026-10-09T12:00:00.000Z",
};

const find = (input: Partial<MergeInput>, id: string) =>
  mergeIntegrations({ ...base, ...input }).apps.find((item) => item.id === id);

test("a tool connected for its app is its one path, and gogcli counts only on a personal Environment", () => {
  expect(
    find({ tools: { state: "ok", connected: ["gh"] } }, "github"),
  ).toMatchObject({
    path: { path: "tool", tool: "gh" },
    connected: true,
  });
  expect(
    find({ tools: { state: "ok", connected: ["gogcli"] } }, "gmail"),
  ).toMatchObject({
    path: { path: "tool", tool: "gogcli" },
    connected: true,
  });
  const work = mergeIntegrations({
    ...base,
    scope: "organization",
    tools: { state: "ok", connected: ["gogcli", "gh"] },
  });
  expect(work.tools).toEqual(["gh"]);
  expect(work.apps.find((item) => item.id === "gmail")?.path).toEqual({
    path: "composio",
    signIn: false,
  });
  // WhatsApp: only its tool connects it.
  expect(find({}, "whatsapp")).toMatchObject({
    path: { path: null, missing: "tool", tool: "wacli" },
    connected: false,
  });
});

test("Executor's connections belong to their catalog app by slug or endpoint; the rest are custom servers", () => {
  const overview = mergeIntegrations({
    ...base,
    executor: {
      state: "ok",
      integrations: [
        // Added by an agent under another slug, the same endpoint.
        {
          slug: "notion_mcp",
          name: "Notion",
          kind: "remote",
          target: "https://mcp.notion.example/mcp",
          tools: null,
        },
        {
          slug: "invoices",
          name: "Invoices",
          kind: "remote",
          target: "https://invoices.example/mcp",
          tools: 4,
        },
        {
          slug: "files",
          name: "Files",
          kind: "command",
          target: null,
          tools: null,
        },
        // A company app's API that is no catalog app here: not custom.
        {
          slug: "other-api",
          name: "Other",
          kind: "api",
          target: null,
          tools: null,
        },
      ],
      connections: [
        {
          id: "org/notion_mcp/default",
          integration: "notion_mcp",
          label: "me@example.test",
          state: "connected",
        },
        {
          id: "org/invoices/default",
          integration: "invoices",
          label: null,
          state: "failed",
        },
      ],
    },
  });
  expect(overview.apps.find((item) => item.id === "notion")).toMatchObject({
    path: { path: "direct" },
    connected: true,
    accounts: [
      {
        path: "direct",
        selector: "org/notion_mcp/default",
        label: "me@example.test",
        spare: false,
      },
    ],
  });
  expect(overview.custom).toEqual([
    {
      id: "invoices",
      name: "Invoices",
      kind: "remote",
      target: "https://invoices.example/mcp",
      state: "failed",
      tools: 4,
    },
    {
      id: "files",
      name: "Files",
      kind: "command",
      target: null,
      state: "ready",
      tools: null,
    },
  ]);
});

// A slug is never an app's identity (review of 2026-10-09): an integration
// that holds Notion's slug but points elsewhere, or runs a command, is
// another server. It is listed as custom, its account never shows under
// Notion's card, and the catalog app is only ever the server at its endpoint.
test("an integration with an app's slug and another target is a custom server, never the app", () => {
  const overview = mergeIntegrations({
    ...base,
    executor: {
      state: "ok",
      integrations: [
        {
          slug: "notion-com",
          name: "Notion",
          kind: "remote",
          target: "https://evil.example/mcp",
          tools: 2,
        },
        {
          slug: "github-com",
          name: "GitHub",
          kind: "command",
          target: null,
          tools: 1,
        },
      ],
      connections: [
        {
          id: "org/notion-com/default",
          integration: "notion-com",
          label: "victim@example.test",
          state: "connected",
        },
      ],
    },
  });
  expect(overview.apps.find((item) => item.id === "notion")).toMatchObject({
    connected: false,
    accounts: [],
  });
  expect(overview.custom.map((server) => [server.id, server.target])).toEqual([
    ["notion-com", "https://evil.example/mcp"],
    ["github-com", null],
  ]);
  for (const integration of [
    { kind: "remote", target: "https://evil.example/mcp" },
    { kind: "remote", target: null },
    { kind: "command", target: null },
    { kind: "api", target: null },
  ] as const)
    expect(catalogAppOf(catalog, integration)).toBeUndefined();
  // The same server whatever its slug, query or trailing slash.
  expect(
    catalogAppOf(catalog, {
      kind: "remote",
      target: "https://MCP.notion.example/mcp/?key=1",
    })?.id,
  ).toBe("notion");
});

test("one app, one path: an older Composio account next to a direct one is spare and does not connect the card", () => {
  const notion = find(
    {
      executor: {
        state: "ok",
        integrations: [
          {
            slug: "notion-com",
            name: "Notion",
            kind: "remote",
            target: "https://mcp.notion.example/mcp",
            tools: null,
          },
        ],
        connections: [
          {
            id: "org/notion-com/default",
            integration: "notion-com",
            label: null,
            state: "connected",
          },
        ],
      },
      composio: {
        state: "ok",
        accounts: [
          {
            toolkit: "notion",
            state: "connected",
            alias: null,
            wordId: "castle",
          },
        ],
      },
    },
    "notion",
  );
  expect(notion?.path).toEqual({ path: "direct" });
  expect(
    notion?.accounts.map((account) => [account.path, account.spare]),
  ).toEqual([
    ["direct", false],
    ["composio", true],
  ]);
  // Only a spare Composio account: Composio keeps the app's way.
  expect(
    find(
      {
        composio: {
          state: "ok",
          accounts: [
            {
              toolkit: "notion",
              state: "connected",
              alias: null,
              wordId: "castle",
            },
          ],
        },
      },
      "notion",
    )?.path,
  ).toEqual({ path: "composio", signIn: false });
});

test("Composio not allowed: its accounts do not count, the source says why, and Composio-only apps say what is missing", () => {
  const overview = mergeIntegrations({
    ...base,
    scope: "organization",
    policy: { allowed: false, source: "organization" },
    composio: {
      state: "ok",
      accounts: [
        {
          toolkit: "salesforce",
          state: "connected",
          alias: null,
          wordId: "castle",
        },
      ],
    },
  });
  expect(overview.sources.composio).toBe("not-allowed");
  expect(overview.composio).toEqual({
    allowed: false,
    source: "organization",
    ready: true,
  });
  const salesforce = overview.apps.find((item) => item.id === "salesforce");
  expect(salesforce).toMatchObject({
    connected: false,
    accounts: [],
    path: { path: null, missing: "composio", action: "ask-admin" },
  });
  // The company app comes first in an Organization; the Admin sets it up.
  const gmail = overview.apps.find((item) => item.id === "gmail");
  expect(gmail?.path).toEqual({
    path: null,
    missing: "company-app",
    provider: "google",
    action: "ask-admin",
  });
  expect(forAdmin(gmail?.path ?? { path: "direct" }, true)).toEqual({
    path: null,
    missing: "company-app",
    provider: "google",
    action: "set-up",
  });
  expect(forAdmin(salesforce?.path ?? { path: "direct" }, true)).toMatchObject({
    action: "allow",
  });
  expect(forAdmin({ path: "direct" }, true)).toEqual({ path: "direct" });
});

test("a source that cannot be read stays explicit and hides nothing else", () => {
  const overview = mergeIntegrations({
    ...base,
    tools: { state: "unreadable" },
    executor: { state: "unavailable" },
    composio: { state: "signed-out" },
    composioReady: false,
  });
  expect(overview.sources).toEqual({
    tools: "unreadable",
    executor: "unavailable",
    composio: "signed-out",
  });
  expect(overview.apps.map((item) => item.id)).toEqual([
    "notion",
    "gmail",
    "github",
    "salesforce",
    "whatsapp",
  ]);
  expect(overview.apps.every((item) => !item.connected)).toBe(true);
  // Signed out: the Composio path asks for its sign-in first.
  expect(overview.apps.find((item) => item.id === "salesforce")?.path).toEqual({
    path: "composio",
    signIn: true,
  });
});

// An Environment without Executor (no console token: never installed or
// started here) says so, and its apps go the way that connects here; an
// Executor that is only down keeps the direct path (decision F42).
test("Executor absent from the Environment: said so, and a direct app goes through Composio", () => {
  const absent = mergeIntegrations({ ...base, executor: { state: "absent" } });
  expect(absent.sources.executor).toBe("absent");
  expect(absent.apps.find((item) => item.id === "notion")?.path).toEqual({
    path: "composio",
    signIn: false,
  });
  expect(
    find(
      {
        executor: { state: "absent" },
        policy: { allowed: false, source: "environment" },
      },
      "notion",
    )?.path,
  ).toEqual({ path: null, missing: "composio", action: "allow" });
  expect(find({ executor: { state: "unavailable" } }, "notion")?.path).toEqual({
    path: "direct",
  });
  expect(find({ executor: { state: "unreadable" } }, "notion")?.path).toEqual({
    path: "direct",
  });
});

// Executor is part of an Environment where Lazurio sets it up (decision
// F44's context, else its Tools row's `offered`) and its row in Settings →
// Tools says it is installed. Tools that cannot be read leave it to
// Executor's own reading to say why nothing answers.
test("Executor is part of the Environment where F44 sets it up and it is installed", () => {
  const tools = (executor?: Partial<ToolOverview>): ToolsOverview =>
    ({
      kind: "tools-status",
      tools:
        executor === undefined
          ? []
          : [{ name: "executor", offered: true, installed: true, ...executor }],
    }) as unknown as ToolsOverview;
  expect(executorHere(tools({}))).toBe(true);
  expect(executorHere(tools({ installed: false }))).toBe(false);
  expect(executorHere(tools({ offered: false }))).toBe(false);
  expect(executorHere(tools())).toBe(false);
  expect(executorHere(null)).toBe(true);
  // F44's context decides where Lazurio sets Executor up: its operator's
  // Remote Environment, never a workstation or another account yet.
  const supported = { kind: "supported" } as const;
  const workstation = { kind: "unsupported", reason: "workstation" } as const;
  expect(executorHere(tools({ offered: false }), supported)).toBe(true);
  expect(executorHere(tools({ installed: false }), supported)).toBe(false);
  expect(executorHere(tools({}), workstation)).toBe(false);
  expect(
    executorHere(tools({}), { kind: "unsupported", reason: "not-operator" }),
  ).toBe(false);
});

test("Composio's toolkits the catalog does not know are listed, and links follow the Launchpad's origin", () => {
  const overview = mergeIntegrations({
    ...base,
    origin: "https://launchpad.example.lazurio.io",
    composio: {
      state: "ok",
      accounts: [
        {
          toolkit: "todoist",
          state: "expired",
          alias: "Home",
          wordId: "stone",
        },
      ],
    },
  });
  expect(overview.page).toBe(
    "https://launchpad.example.lazurio.io/integrations",
  );
  expect(overview.apps.find((item) => item.id === "todoist")).toEqual({
    id: "todoist",
    name: "todoist",
    path: { path: "composio", signIn: false },
    connected: true,
    accounts: [
      {
        path: "composio",
        selector: "stone",
        label: "Home",
        state: "expired",
        spare: false,
      },
    ],
    catalog: false,
    link: "https://launchpad.example.lazurio.io/integrations/app/todoist",
  });
});

test("the scope of a preset, and Composio's statuses and answers read exactly", () => {
  expect(scopeOf("local")).toBe("personal");
  expect(scopeOf("hosted-personal")).toBe("personal");
  expect(scopeOf("hosted-organization-personal")).toBe("organization");
  expect(scopeOf("hosted-organization-team")).toBe("organization");
  expect(scopeOf("hosted-organization-steward")).toBe("organization");
  expect(
    [
      "ACTIVE",
      "EXPIRED",
      "REVOKED",
      "INITIATED",
      "INITIALIZING",
      "FAILED",
      "INACTIVE",
      "NEW",
    ].map(composioState),
  ).toEqual([
    "connected",
    "expired",
    "expired",
    "pending",
    "pending",
    "failed",
    "failed",
    "failed",
  ]);
  expect(
    parseComposioConnections(
      JSON.stringify({
        gmail: [
          {
            status: "ACTIVE",
            alias: "Work",
            word_id: "castle",
            permission_group: null,
          },
          {
            status: "EXPIRED",
            alias: null,
            word_id: "river",
            permission_group: null,
          },
        ],
      }),
    ),
  ).toEqual([
    { toolkit: "gmail", state: "connected", alias: "Work", wordId: "castle" },
    { toolkit: "gmail", state: "expired", alias: null, wordId: "river" },
  ]);
  for (const malformed of [
    "You are not logged in",
    "[]",
    JSON.stringify({ "Bad Slug": [] }),
    JSON.stringify({ gmail: {} }),
    JSON.stringify({ gmail: [{ alias: "x" }] }),
    JSON.stringify({ gmail: [{ status: "ACTIVE", alias: 3 }] }),
  ])
    expect(parseComposioConnections(malformed)).toBeNull();
});
