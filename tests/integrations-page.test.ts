import { expect, test } from "bun:test";
import { integrationsCatalog } from "../src/integrations/catalog";
import type {
  IntegrationApp,
  IntegrationsOverview,
} from "../src/integrations/model";
import {
  accountView,
  attentionCount,
  cardView,
  disconnectText,
  monogram,
  normalize,
  parseIntegrations,
  serverLine,
  sourceLines,
  tabLabels,
  visibleApps,
} from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";
import {
  integrationsPath,
  pageFrame,
  pageRoute,
  routePath,
  routeTitle,
} from "../src/launchpad/routes";

// Apps → Integrace (decision F42), the page as the approved wireframe draws
// it: its routes, the tabs Vše · Připojené (N) · Vlastní, one path label per
// connected card, one line and one action where nothing connects an app, the
// Composio disclaimer, the accounts and what disconnecting reaches.

const en = messages("en");
const cs = messages("cs");

test("the routes: the tabs, an app's card under app/, and anything else opens Vše", () => {
  expect(pageRoute("/integrations")).toEqual({
    view: "integrations",
    tab: "all",
  });
  expect(pageRoute("/integrations/")).toEqual({
    view: "integrations",
    tab: "all",
  });
  expect(pageRoute("/integrations/connected")).toEqual({
    view: "integrations",
    tab: "connected",
  });
  expect(pageRoute("/integrations/custom/")).toEqual({
    view: "integrations",
    tab: "custom",
  });
  expect(pageRoute("/integrations/app/notion")).toEqual({
    view: "integrations",
    tab: "all",
    app: "notion",
  });
  // An app may be called like a tab: its card is still its card.
  expect(pageRoute("/integrations/app/connected")).toEqual({
    view: "integrations",
    tab: "all",
    app: "connected",
  });
  for (const path of [
    "/integrations/app/Not%20An%20Id",
    "/integrations/app/",
    "/integrations/elsewhere",
    "/integrations/app/notion/extra",
  ])
    expect(pageRoute(path)).toEqual({ view: "integrations", tab: "all" });
  expect(pageRoute("/integrationsx")).toEqual({ view: "home" });
  for (const route of [
    { view: "integrations", tab: "all" },
    { view: "integrations", tab: "connected" },
    { view: "integrations", tab: "custom" },
    { view: "integrations", tab: "all", app: "microsoft_teams" },
  ] as const)
    expect(pageRoute(routePath(route))).toEqual(route);
  expect(integrationsPath("all", "gmail")).toBe("/integrations/app/gmail");
  expect(pageFrame("/integrations/app/gmail")).toEqual({
    frame: "integrations",
    section: null,
  });
  expect(routeTitle({ view: "integrations", tab: "all" }, en)).toEqual({
    heading: "Integrations",
    document: "Integrations — Lazurio Launchpad",
  });
  expect(routeTitle({ view: "integrations", tab: "custom" }, cs).heading).toBe(
    "Integrace",
  );
});

const app = (
  id: string,
  extra: Partial<IntegrationApp> = {},
): IntegrationApp => ({
  id,
  name:
    integrationsCatalog.apps.find((entry) => entry.id === id)?.name.en ?? id,
  path: { path: "direct" },
  connected: false,
  accounts: [],
  catalog: true,
  link: null,
  ...extra,
});

const overview = (
  apps: IntegrationApp[],
  extra: Partial<IntegrationsOverview> = {},
): IntegrationsOverview => ({
  kind: "integrations",
  locale: "en",
  scope: "organization",
  page: null,
  composio: { allowed: true, source: "environment", ready: true },
  sources: { tools: "ok", executor: "ok", composio: "ok" },
  tools: [],
  apps,
  custom: [],
  readAt: "2026-10-09T12:00:00.000Z",
  ...extra,
});

test("the page takes the route's answer of its exact shape only", () => {
  const value = overview([app("notion")]);
  expect(parseIntegrations(JSON.parse(JSON.stringify(value)))).toEqual(value);
  for (const broken of [
    null,
    { ...value, kind: "other" },
    { ...value, sources: { ...value.sources, executor: "fine" } },
    { ...value, apps: [{ ...app("notion"), path: { path: "elsewhere" } }] },
    { ...value, apps: [{ ...app("notion"), id: "Bad Id" }] },
    {
      ...value,
      custom: [
        {
          id: "x",
          name: "x",
          kind: "ftp",
          target: null,
          state: "ready",
          tools: null,
        },
      ],
    },
  ])
    expect(parseIntegrations(broken)).toBeNull();
});

test("the tabs count what is connected and the custom servers; expired sign-ins need the person", () => {
  expect(tabLabels(null, cs)).toEqual({
    all: "Vše",
    connected: "Připojené",
    custom: "Vlastní",
  });
  const value = overview(
    [
      app("notion", {
        connected: true,
        accounts: [
          {
            path: "direct",
            selector: "org/notion-com/default",
            label: null,
            state: "expired",
            spare: false,
          },
        ],
      }),
      app("github", { path: { path: "tool", tool: "gh" }, connected: true }),
      app("linear"),
    ],
    {
      custom: [
        {
          id: "invoices",
          name: "invoices",
          kind: "remote",
          target: "https://x.example/mcp",
          state: "connected",
          tools: 5,
        },
      ],
    },
  );
  expect(tabLabels(value, en)).toEqual({
    all: "All",
    connected: "Connected 2",
    custom: "Custom 1",
  });
  expect(attentionCount(value)).toBe(1);
});

test("the list: connected first, then what connects here, then the rest; a search finds every app without diacritics", () => {
  const apps = [
    app("salesforce", {
      path: { path: null, missing: "composio", action: "ask-admin" },
    }),
    app("linear"),
    app("github", { path: { path: "tool", tool: "gh" }, connected: true }),
    app("googlecalendar", {
      name: "Google Kalendář",
      path: {
        path: null,
        missing: "company-app",
        provider: "google",
        action: "ask-admin",
      },
    }),
  ];
  const value = overview(apps);
  // Without a search, Vše lists what connects here (or is connected) and an
  // Organization's company apps; an app only Composio connects waits for a
  // search where Composio is off.
  expect(
    visibleApps(value, integrationsCatalog.apps, "all", "").map(
      (item) => item.id,
    ),
  ).toEqual(["github", "linear", "googlecalendar"]);
  expect(
    visibleApps(value, integrationsCatalog.apps, "connected", "").map(
      (item) => item.id,
    ),
  ).toEqual(["github"]);
  // A search finds everything, connected first and blocked last.
  expect(
    visibleApps(value, integrationsCatalog.apps, "all", "kalendar").map(
      (item) => item.id,
    ),
  ).toEqual(["googlecalendar"]);
  expect(
    visibleApps(value, integrationsCatalog.apps, "all", "a").map(
      (item) => item.id,
    ),
  ).toEqual(["github", "linear", "salesforce", "googlecalendar"]);
  expect(normalize("Kalendář")).toBe("kalendar");
});

const options = (copy: typeof en, admin = false) => ({
  locale: copy === cs ? ("cs" as const) : ("en" as const),
  scope: "organization" as const,
  admin,
  copy,
});

test("a connected card says its one way quietly; Composio's form says who makes the connection", () => {
  const entry = (id: string) =>
    integrationsCatalog.apps.find((item) => item.id === id);
  expect(
    cardView(
      app("github", { path: { path: "tool", tool: "gh" }, connected: true }),
      entry("github"),
      options(cs),
    ),
  ).toEqual({
    line: "Kód, issues a pull requesty.",
    connected: true,
    pathLabel: "přes gh",
    action: { kind: "none" },
    composio: false,
  });
  const notion = app("notion", {
    connected: true,
    accounts: [
      {
        path: "direct",
        selector: "org/notion-com/default",
        label: null,
        state: "connected",
        spare: false,
      },
    ],
  });
  expect(cardView(notion, entry("notion"), options(cs))).toMatchObject({
    connected: true,
    pathLabel: "přímo",
    action: { kind: "connect", label: "Přidat účet", path: "direct" },
    composio: false,
  });
  const salesforce = app("salesforce", {
    path: { path: "composio", signIn: false },
  });
  expect(cardView(salesforce, entry("salesforce"), options(en))).toEqual({
    line: "A CRM for sales, service and marketing.",
    connected: false,
    pathLabel: null,
    action: { kind: "connect", label: "Connect", path: "composio" },
    composio: true,
  });
  expect(cs.integrationsComposioNote).toContain("server třetí strany");
  expect(en.integrationsComposioNote).toContain("third-party");
  // A connection waiting for the browser says so instead of the sentence.
  expect(
    cardView(
      app("linear", {
        accounts: [
          {
            path: "direct",
            selector: "org/linear-app/work",
            label: "Work",
            state: "pending",
            spare: false,
          },
        ],
      }),
      entry("linear"),
      options(en),
    ).line,
  ).toBe("Finish the connection in the browser");
});

test("where nothing connects an app: one line and one action, the Admin's or anyone's", () => {
  const entry = (id: string) =>
    integrationsCatalog.apps.find((item) => item.id === id);
  const outlook = app("outlook", {
    path: {
      path: null,
      missing: "company-app",
      provider: "microsoft",
      action: "ask-admin",
    },
  });
  expect(cardView(outlook, entry("outlook"), options(cs))).toMatchObject({
    line: "Firemní aplikace Microsoft ještě není nastavená.",
    action: { kind: "ask-admin", label: "Požádat Admina" },
  });
  expect(cardView(outlook, entry("outlook"), options(cs, true))).toMatchObject({
    action: { kind: "set-up", label: "Nastavit v Dashboardu" },
  });
  const salesforce = app("salesforce", {
    path: { path: null, missing: "composio", action: "ask-admin" },
  });
  expect(cardView(salesforce, entry("salesforce"), options(cs))).toMatchObject({
    line: "Composio je ve firmě vypnuté.",
    action: { kind: "ask-admin" },
  });
  expect(
    cardView(salesforce, entry("salesforce"), options(cs, true)),
  ).toMatchObject({
    action: { kind: "allow", label: "Povolit Composio" },
  });
  expect(
    cardView(salesforce, entry("salesforce"), {
      ...options(cs),
      scope: "personal",
    }).line,
  ).toBe("Composio je tu vypnuté.");
  expect(
    cardView(
      app("whatsapp", { path: { path: null, missing: "tool", tool: "wacli" } }),
      entry("whatsapp"),
      options(cs),
    ),
  ).toMatchObject({
    line: "Připojí ji nástroj wacli.",
    action: { kind: "open-tools", label: "Otevřít Nástroje" },
  });
  expect(
    cardView(
      app("x", { path: { path: null, missing: "path" } }),
      undefined,
      options(cs),
    ),
  ).toMatchObject({
    line: "Tady ji zatím nejde připojit.",
    action: { kind: "none" },
  });
});

test("accounts: one line when they need the person or are spare, and what disconnecting reaches", () => {
  const account = (
    state: "connected" | "expired" | "pending" | "failed",
    path: "direct" | "composio" = "direct",
    spare = false,
  ) => ({
    path,
    selector: path === "direct" ? "org/notion-com/default" : "castle",
    label: null,
    state,
    spare,
  });
  expect(accountView(account("connected"), cs)).toEqual({
    name: "účet",
    line: null,
    retry: null,
    disconnect: true,
  });
  expect(accountView(account("expired"), cs)).toMatchObject({
    line: "Přihlášení vypršelo — zkus to znovu",
    retry: "Přihlásit znovu",
  });
  expect(accountView(account("failed"), en)).toMatchObject({
    retry: "Try again",
  });
  expect(accountView(account("pending"), cs).retry).toBeNull();
  expect(accountView(account("connected", "composio", true), cs)).toMatchObject(
    {
      line: "Navíc přes Composio, nepoužívá se",
      retry: null,
    },
  );
  const notion = app("notion");
  expect(disconnectText(notion, account("connected"), null, cs)).toBe(
    "Odpojí se jen v tomto Environmentu.",
  );
  expect(
    disconnectText(
      notion,
      account("connected", "composio"),
      "op@example.test",
      cs,
    ),
  ).toBe(
    "Odpojí se z Composio účtu op@example.test, takže ve všech Environmentech, které ho používají.",
  );
  expect(disconnectText(notion, account("pending"), null, en)).toBe(
    "Only this account is withdrawn; the other accounts of Notion stay connected.",
  );
});

test("a source that cannot be read says so on the page; custom servers count their tools", () => {
  expect(
    sourceLines(
      overview([], {
        sources: {
          tools: "unreadable",
          executor: "unavailable",
          composio: "unreadable",
        },
      }),
      cs,
    ),
  ).toEqual([
    "Executor v tomhle Environmentu teď neběží, takže nic nejde připojit přímo.",
    "Připojení přes Composio se nepodařilo načíst.",
    "Nástroje se nepodařilo načíst.",
  ]);
  // An Environment without Executor says why nothing is direct.
  expect(
    sourceLines(
      overview([], {
        sources: { tools: "ok", executor: "absent", composio: "ok" },
      }),
      en,
    ),
  ).toEqual([
    "This Environment has no Executor, so apps connect here through Composio or their tool.",
  ]);
  const server = (
    tools: number | null,
    state: "connected" | "failed" | "ready" = "connected",
  ) => ({
    id: "x",
    name: "x",
    kind: "remote" as const,
    target: null,
    state,
    tools,
  });
  expect(serverLine(server(1), cs)).toBe("Připojeno · 1 nástroj");
  expect(serverLine(server(3), cs)).toBe("Připojeno · 3 nástroje");
  expect(serverLine(server(7), cs)).toBe("Připojeno · 7 nástrojů");
  expect(serverLine(server(null, "ready"), en)).toBe("Added");
  expect(serverLine(server(2, "failed"), en)).toBe("Could not start");
  expect(monogram("  ďábel")).toBe("Ď");
});
