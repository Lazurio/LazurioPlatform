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
  composioTrip,
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
  composio: {
    allowed: true,
    source: "environment",
    ready: true,
    disconnect: true,
    apps: "https://dashboard.composio.dev/First/~/connect/apps",
    organization: null,
  },
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
            manage: null,
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
        manage: null,
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
            manage: null,
          },
        ],
      }),
      entry("linear"),
      options(en),
    ).line,
  ).toBe("Finish the connection in the browser");
});

// An agent's card link names any app of the catalog (review of
// 2026-10-09): WhatsApp without wacli is not offered in Vše, yet its link
// lists its card, with the line and the action of what is missing.
test("a card link lists the app it names even where nothing connects it, with what is missing", () => {
  const whatsapp = app("whatsapp", {
    path: { path: null, missing: "tool", tool: "wacli" },
    link: "https://launchpad.example.test/integrations/app/whatsapp",
  });
  const value = overview([app("linear"), whatsapp]);
  expect(
    visibleApps(value, integrationsCatalog.apps, "all", "").map(
      (item) => item.id,
    ),
  ).toEqual(["linear"]);
  expect(
    visibleApps(value, integrationsCatalog.apps, "all", "", "whatsapp").map(
      (item) => item.id,
    ),
  ).toEqual(["linear", "whatsapp"]);
  // A link to an app the Environment does not know adds nothing.
  expect(
    visibleApps(value, integrationsCatalog.apps, "all", "", "unknown-app").map(
      (item) => item.id,
    ),
  ).toEqual(["linear"]);
  expect(
    cardView(
      whatsapp,
      integrationsCatalog.apps.find((item) => item.id === "whatsapp"),
      options(cs),
    ),
  ).toMatchObject({
    line: "Připojí ji nástroj wacli.",
    action: { kind: "open-tools", label: "Otevřít Nástroje" },
  });
  expect(pageRoute("/integrations/app/whatsapp")).toEqual({
    view: "integrations",
    tab: "all",
    app: "whatsapp",
  });
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

const manageGmail = "https://dashboard.composio.dev/First/~/connect/apps/gmail";

test("accounts: one line when they need the person or are spare, and what disconnecting reaches", () => {
  const notion = app("notion");
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
    manage: path === "direct" ? null : manageGmail,
  });
  expect(accountView(notion, account("connected"), cs, true)).toEqual({
    name: "účet",
    line: null,
    retry: null,
    disconnect: true,
    menu: null,
  });
  expect(accountView(notion, account("expired"), cs, true)).toMatchObject({
    line: "Přihlášení vypršelo — zkus to znovu",
    retry: "Přihlásit znovu",
  });
  expect(accountView(notion, account("failed"), en, true)).toMatchObject({
    retry: "Try again",
  });
  expect(accountView(notion, account("pending"), cs, true).retry).toBeNull();
  expect(
    accountView(notion, account("connected", "composio", true), cs, true),
  ).toMatchObject({
    line: "Navíc přes Composio, nepoužívá se",
    retry: null,
  });
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

// A Composio account's "⋯" menu (decision F42, addendum of 2026-10-11,
// #312): "Spravovat v Composiu" to the app's page in the person's Composio
// organization and "Odpojit", moved out of the row; "Přihlásit znovu" stays
// in the row; an Executor account has no menu and keeps "Odpojit".
test("a Composio account's menu: manage it in Composio and disconnect it; signing in again stays in the row", () => {
  const gmail = app("gmail", {
    path: { path: "composio", signIn: false },
    connected: true,
  });
  const composio = (
    state: "connected" | "expired" | "pending" | "failed",
    extra: Partial<IntegrationApp["accounts"][number]> = {},
  ) => ({
    path: "composio" as const,
    selector: "castle",
    label: "Práce",
    state,
    spare: false,
    manage: manageGmail,
    ...extra,
  });
  expect(accountView(gmail, composio("connected"), cs, true)).toEqual({
    name: "Práce",
    line: null,
    retry: null,
    disconnect: false,
    menu: {
      label: "Další volby pro Práce v aplikaci Gmail",
      manage: manageGmail,
      disconnect: true,
    },
  });
  expect(accountView(gmail, composio("connected"), en, true).menu?.label).toBe(
    "More options for Práce in Gmail",
  );
  expect(cs.integrationsManageInComposio).toBe("Spravovat v Composiu");
  expect(en.integrationsManageInComposio).toBe("Manage in Composio");
  // A CLI that removes only after a prompt: the menu leads to Composio,
  // without "Odpojit".
  expect(accountView(gmail, composio("connected"), cs, false).menu).toEqual({
    label: "Další volby pro Práce v aplikaci Gmail",
    manage: manageGmail,
    disconnect: false,
  });
  // An expired account: "Přihlásit znovu" in the row, the rest in the menu.
  expect(accountView(gmail, composio("expired"), cs, true)).toMatchObject({
    retry: "Přihlásit znovu",
    disconnect: false,
    menu: { manage: manageGmail, disconnect: true },
  });
  // Unnamed, and with no word id to disconnect it by: the menu still leads
  // to Composio, without "Odpojit".
  expect(
    accountView(
      gmail,
      composio("connected", { label: null, selector: null }),
      cs,
      true,
    ),
  ).toMatchObject({
    name: "účet",
    disconnect: false,
    menu: {
      label: "Další volby pro účet v aplikaci Gmail",
      disconnect: false,
    },
  });
  // A spare Composio account has its menu too.
  expect(
    accountView(gmail, composio("connected", { spare: true }), cs, true).menu,
  ).not.toBeNull();
  // Executor's account: no menu, "Odpojit" in the row, as before.
  expect(
    accountView(
      app("notion"),
      {
        path: "direct",
        selector: "org/notion-com/default",
        label: "person@example.test",
        state: "connected",
        spare: false,
        manage: null,
      },
      cs,
      true,
    ),
  ).toEqual({
    name: "person@example.test",
    line: null,
    retry: null,
    disconnect: true,
    menu: null,
  });
  // The page takes a link to Composio's dashboard only.
  const value = overview([gmail]);
  const withManage = (manage: unknown) => ({
    ...value,
    apps: [{ ...gmail, accounts: [{ ...composio("connected"), manage }] }],
  });
  expect(parseIntegrations(withManage(manageGmail))).not.toBeNull();
  expect(parseIntegrations(withManage(null))).not.toBeNull();
  for (const manage of [
    "javascript:alert(1)",
    "https://dashboard.composio.dev.example.test/First",
    "http://dashboard.composio.dev/First/~/connect/apps/gmail",
    "https://example.test/",
    3,
  ])
    expect(parseIntegrations(withManage(manage))).toBeNull();
  expect(
    parseIntegrations({
      ...value,
      apps: [
        {
          ...gmail,
          accounts: [{ ...composio("connected"), manage: undefined }],
        },
      ],
    }),
  ).toBeNull();
});

// "Aplikace v Composiu" (decision F42, addendum of 2026-10-14): the page
// takes the link the server built only to Composio's dashboard, reads the
// Integrace once when the person comes back from it, and an app connected
// there that the catalog does not know is under Připojené by its name.
test("Aplikace v Composiu: only a link to Composio's dashboard, none where Composio does not count", () => {
  const value = overview([app("notion")]);
  const withApps = (apps: unknown) => ({
    ...value,
    composio: { ...value.composio, apps },
  });
  expect(parseIntegrations(withApps(null))?.composio.apps).toBeNull();
  expect(
    parseIntegrations(
      withApps("https://dashboard.composio.dev/~/org/connect/apps"),
    )?.composio.apps,
  ).toBe("https://dashboard.composio.dev/~/org/connect/apps");
  for (const apps of [
    "javascript:alert(1)",
    "https://dashboard.composio.dev.example.test/First/~/connect/apps",
    "http://dashboard.composio.dev/First/~/connect/apps",
    "https://dashboard.composio.dev",
    "https://example.test/",
    undefined,
    3,
  ])
    expect(parseIntegrations(withApps(apps))).toBeNull();
  expect(en.integrationsComposioApps).toBe("Apps in Composio");
  expect(cs.integrationsComposioApps).toBe("Aplikace v Composiu");
  expect(
    `${cs.integrationsComposioMissing} ${cs.integrationsComposioConnectThere}`,
  ).toBe("Aplikaci tu nenajdete? Připojte ji v Composiu");
  expect(
    `${en.integrationsComposioMissing} ${en.integrationsComposioConnectThere}`,
  ).toBe("Can't find an app here? Connect it in Composio");
});

test("coming back from Composio's Apps reads the Integrace once, only after the page lost the person", () => {
  // Opened, left for Composio's tab, back: one reading.
  let state = composioTrip("idle", "opened");
  expect(state).toEqual({ trip: "opened", refresh: false });
  state = composioTrip(state.trip, "left");
  expect(state).toEqual({ trip: "away", refresh: false });
  // Blur and a hidden tab both say "left".
  expect(composioTrip(state.trip, "left")).toEqual({
    trip: "away",
    refresh: false,
  });
  state = composioTrip(state.trip, "back");
  expect(state).toEqual({ trip: "idle", refresh: true });
  // Focus and a visible tab both say "back": the second reads nothing.
  expect(composioTrip(state.trip, "back")).toEqual({
    trip: "idle",
    refresh: false,
  });
  // Opened in the background: the page never lost the person, nothing yet;
  // once they leave and come back, it reads.
  expect(composioTrip("opened", "back")).toEqual({
    trip: "opened",
    refresh: false,
  });
  expect(
    composioTrip(composioTrip("opened", "left").trip, "back").refresh,
  ).toBe(true);
  // Leaving and coming back without the link reads nothing.
  expect(composioTrip("idle", "left")).toEqual({
    trip: "idle",
    refresh: false,
  });
  expect(composioTrip("idle", "back")).toEqual({
    trip: "idle",
    refresh: false,
  });
});

test("an app connected in Composio that the catalog does not know is under Připojené by its name", () => {
  const wispr = app("wispr_flow", {
    name: "Wispr Flow",
    catalog: false,
    connected: true,
    path: { path: "composio", signIn: false },
    accounts: [
      {
        path: "composio",
        selector: "castle",
        label: null,
        state: "connected",
        spare: false,
        manage:
          "https://dashboard.composio.dev/First/~/connect/apps/wispr_flow",
      },
    ],
  });
  const value = overview([app("linear"), wispr]);
  // The server's answer, as the page takes it.
  expect(parseIntegrations(JSON.parse(JSON.stringify(value)))).toEqual(value);
  const ids = (tab: "all" | "connected", search: string) =>
    visibleApps(value, integrationsCatalog.apps, tab, search).map(
      (item) => item.id,
    );
  expect(ids("connected", "")).toEqual(["wispr_flow"]);
  expect(ids("all", "")).toEqual(["wispr_flow", "linear"]);
  // Found by its name and by its toolkit.
  expect(ids("connected", "wispr fl")).toEqual(["wispr_flow"]);
  expect(ids("all", "wispr_flow")).toEqual(["wispr_flow"]);
  for (const copy of [cs, en])
    expect(cardView(wispr, undefined, options(copy))).toEqual({
      line: copy.integrationsOutsideCatalog,
      connected: true,
      pathLabel: copy.integrationsPathComposio,
      action: {
        kind: "connect",
        label: copy.integrationsAddAccount,
        path: "composio",
      },
      composio: true,
    });
  expect(cs.integrationsOutsideCatalog).toBe(
    "Z Composia, mimo katalog Lazuria.",
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
