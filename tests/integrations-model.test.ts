import { expect, test } from "bun:test";
import type { IntegrationsCatalog } from "../src/integrations/catalog-schema";
import {
  type ComposioAccount,
  composioManageUrl,
  composioState,
  composioTimeoutMs,
  nameComposioAccounts,
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
import type { ToolProcessResult, ToolRunner } from "../src/tools/status";

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
  composioOrganization: null,
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
    composioOrganization: "First",
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
        manage: "https://dashboard.composio.dev/First/~/connect/apps/todoist",
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

// A Composio account's place in Composio's dashboard (decision F42, addendum
// of 2026-10-11, #312): the app's page in the person's Composio
// organization, which the dashboard has instead of a page of one account.
test("a Composio account links to its app's page in the person's Composio organization; an Executor account to none", () => {
  expect(composioManageUrl("First", "gmail")).toBe(
    "https://dashboard.composio.dev/First/~/connect/apps/gmail",
  );
  // The organization's name is one encoded path segment: spaces,
  // diacritics and what would end a segment or start a query.
  expect(composioManageUrl("Žluťoučký kůň", "gmail")).toBe(
    "https://dashboard.composio.dev/%C5%BDlu%C5%A5ou%C4%8Dk%C3%BD%20k%C5%AF%C5%88/~/connect/apps/gmail",
  );
  expect(composioManageUrl("R&D / Sales?#1", "slack")).toBe(
    "https://dashboard.composio.dev/R%26D%20%2F%20Sales%3F%231/~/connect/apps/slack",
  );
  // Unknown: the person's current organization, the dashboard's `~/org/`.
  expect(composioManageUrl(null, "gmail")).toBe(
    "https://dashboard.composio.dev/~/org/connect/apps/gmail",
  );
  // Never the CLI's `?open=true`, which connects another account.
  for (const organization of ["First", "Žluťoučký kůň", null]) {
    const url = new URL(composioManageUrl(organization, "gmail"));
    expect(url.origin).toBe("https://dashboard.composio.dev");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  }
  // The model gives it to every Composio account, by its toolkit (not the
  // catalog's id of the app), and none to an Executor account.
  const overview = mergeIntegrations({
    ...base,
    catalog: {
      ...catalog,
      apps: [...catalog.apps, app("calendar", { composio: "googlecalendar" })],
    },
    composioOrganization: "Žluťoučký kůň",
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
          toolkit: "googlecalendar",
          state: "connected",
          alias: "Work",
          wordId: "castle",
        },
      ],
    },
  });
  const accounts = (id: string) =>
    overview.apps
      .find((item) => item.id === id)
      ?.accounts.map((account) => [account.path, account.manage]);
  expect(accounts("calendar")).toEqual([
    [
      "composio",
      "https://dashboard.composio.dev/%C5%BDlu%C5%A5ou%C4%8Dk%C3%BD%20k%C5%AF%C5%88/~/connect/apps/googlecalendar",
    ],
  ]);
  expect(accounts("notion")).toEqual([["direct", null]]);
});

// `link <toolkit> --list` as a fake runner answers it: the accounts of each
// toolkit (or a failure or a timeout), every call recorded.
function listRunner(
  answers: Readonly<
    Record<string, readonly Record<string, unknown>[] | "fail" | "timeout">
  >,
  onCall: () => void = () => {},
) {
  const calls: (readonly string[])[] = [];
  let open = 0;
  let most = 0;
  const run: ToolRunner = async (command, timeoutMs, env) => {
    calls.push(command);
    open += 1;
    most = Math.max(most, open);
    onCall();
    expect(timeoutMs).toBe(composioTimeoutMs);
    expect(Object.keys(env).sort()).toEqual(["HOME", "NO_COLOR", "PATH"]);
    await Promise.resolve();
    open -= 1;
    const [, toolkit, flag] = command.slice(1);
    const answer = toolkit === undefined ? undefined : answers[toolkit];
    if (flag !== "--list" || answer === undefined || answer === "fail")
      return { exitCode: 1, stdout: "", stderr: "" } as ToolProcessResult;
    if (answer === "timeout") return "timeout";
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ toolkit, total: answer.length, items: answer }, null, 2)}\n`,
      stderr: "",
    };
  };
  return {
    env: { path: "/fake/bin", home: "/fake/home", run },
    calls,
    most: () => most,
  };
}

const account = (
  toolkit: string,
  extra: Partial<ComposioAccount> = {},
): ComposioAccount => ({
  toolkit,
  state: "connected",
  alias: null,
  wordId: `${toolkit}-word`,
  ...extra,
});
const item = (alias: string | null, wordId: string) => ({
  id: `ca_${wordId}`,
  word_id: wordId,
  alias,
  status: "ACTIVE",
});

test("a toolkit's only active account is named by `link <toolkit> --list`, and nothing is guessed", async () => {
  const runner = listRunner({
    gmail: [item("Work", "gmail-word")],
    // A name only where its word id is the same one, or one side has none.
    zoom: [item("Calls", "zoom-other")],
    // Two active accounts for one in `connections list`: which is which?
    outlook: [item("Office", "outlook-word"), item("Home", "outlook-2")],
    linear: [item("Product", "linear-other")],
    // Active without a name: still none.
    notion: [item(null, "notion-word")],
    todoist: "fail",
    github: "timeout",
    // None active any more.
    trello: [],
  });
  const accounts = [
    account("gmail"),
    account("zoom", { wordId: null }),
    account("outlook"),
    account("linear"),
    account("notion"),
    account("todoist"),
    account("github"),
    account("trello"),
    // Several accounts: `connections list` names them itself.
    account("slack", { alias: "Team" }),
    account("slack", { alias: null, wordId: "slack-2" }),
    // Not active: `--list` lists only active accounts.
    account("salesforce", { state: "expired" }),
    account("hubspot", { state: "pending" }),
  ];
  const named = await nameComposioAccounts(
    runner.env,
    "/fake/bin/composio",
    accounts,
  );
  expect(named.map((item) => [item.toolkit, item.alias])).toEqual([
    ["gmail", "Work"],
    ["zoom", "Calls"],
    ["outlook", null],
    ["linear", null],
    ["notion", null],
    ["todoist", null],
    ["github", null],
    ["trello", null],
    ["slack", "Team"],
    ["slack", null],
    ["salesforce", null],
    ["hubspot", null],
  ]);
  // The rest of each account is what `connections list` said.
  expect(named[0]).toEqual({ ...account("gmail"), alias: "Work" });
  expect(named.slice(2)).toEqual(accounts.slice(2));
  // One call per toolkit that needs it, none for any other.
  expect(runner.calls.map((call) => call.slice(1)).sort()).toEqual(
    [
      "github",
      "gmail",
      "linear",
      "notion",
      "outlook",
      "todoist",
      "trello",
      "zoom",
    ].map((toolkit) => ["link", toolkit, "--list"]),
  );
  expect(runner.calls.every((call) => call[0] === "/fake/bin/composio")).toBe(
    true,
  );
  // Nothing to name: no call at all, the same accounts back.
  const quiet = listRunner({});
  const none = [
    account("slack", { alias: "Team" }),
    account("x", { state: "expired" }),
  ];
  expect(await nameComposioAccounts(quiet.env, "composio", none)).toBe(none);
  expect(quiet.calls).toEqual([]);
});

test("naming runs four calls at a time and starts none after one Composio budget", async () => {
  const toolkits = Array.from({ length: 10 }, (_, index) => `app${index}`);
  const answers = Object.fromEntries(
    toolkits.map((toolkit) => [
      toolkit,
      [item(`Name ${toolkit}`, `${toolkit}-word`)],
    ]),
  );
  // Quick answers: every toolkit named, never more than four at once.
  let clock = 0;
  const quick = listRunner(answers, () => {
    clock += 1_000;
  });
  const named = await nameComposioAccounts(
    quick.env,
    "composio",
    toolkits.map((toolkit) => account(toolkit)),
    () => clock,
  );
  expect(named.map((item) => item.alias)).toEqual(
    toolkits.map((toolkit) => `Name ${toolkit}`),
  );
  expect(quick.calls).toHaveLength(10);
  expect(quick.most()).toBe(4);
  // Slow answers: the first four use up the budget, and no call starts
  // after it; those toolkits stay unnamed.
  clock = 0;
  const slow = listRunner(answers, () => {
    clock += composioTimeoutMs / 3;
  });
  const partly = await nameComposioAccounts(
    slow.env,
    "composio",
    toolkits.map((toolkit) => account(toolkit)),
    () => clock,
  );
  expect(slow.calls).toHaveLength(4);
  expect(partly.map((item) => item.alias)).toEqual([
    ...toolkits.slice(0, 4).map((toolkit) => `Name ${toolkit}`),
    ...toolkits.slice(4).map(() => null),
  ]);
});
