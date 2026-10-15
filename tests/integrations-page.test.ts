import { expect, test } from "bun:test";
import { integrationsCatalog } from "../src/integrations/catalog";
import { microsoft365Card } from "../src/integrations/microsoft365-card";
import type {
  IntegrationAccount,
  IntegrationApp,
  IntegrationsOverview,
} from "../src/integrations/model";
import {
  accountView,
  attentionCount,
  cardView,
  composioTrip,
  composioUpdated,
  composioUpdateLine,
  disconnectFailure,
  disconnectText,
  monogram,
  normalize,
  noticeIcon,
  parseIntegrations,
  type Removals,
  refusalNote,
  removalKey,
  removalRechecks,
  removalStep,
  removalsRead,
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
    update: false,
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

const options = (copy: typeof en, admin = false, dashboard = true) => ({
  locale: copy === cs ? ("cs" as const) : ("en" as const),
  scope: "organization" as const,
  admin,
  dashboard,
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
    line: "Připojuje se nástrojem wacli.",
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
    action: { kind: "set-up", label: "Nastavit v Přehledu Organizace" },
  });
  const salesforce = app("salesforce", {
    path: { path: null, missing: "composio", action: "ask-admin" },
  });
  expect(cardView(salesforce, entry("salesforce"), options(cs))).toMatchObject({
    line: "Composio je v Organizaci vypnuté.",
    action: { kind: "ask-admin" },
  });
  expect(
    cardView(salesforce, entry("salesforce"), options(cs, true)),
  ).toMatchObject({
    action: { kind: "allow", label: "Povolit Composio" },
  });
  // Where the Organization's Dashboard link is not known here, the Admin
  // gets one sentence saying where to find it, never a dead button; anyone
  // else still asks the Admin.
  for (const card of [outlook, salesforce]) {
    const id = card.id;
    expect(cardView(card, entry(id), options(cs, true, false)).action).toEqual({
      kind: "where",
      text: "Nastavíte to v Přehledu Organizace, v jejím nastavení.",
    });
    expect(cardView(card, entry(id), options(en, true, false)).action).toEqual({
      kind: "where",
      text: "You set this up in the Dashboard, in the Organization's settings.",
    });
    expect(cardView(card, entry(id), options(cs, false, false)).action).toEqual(
      { kind: "ask-admin", label: "Požádat Admina" },
    );
  }
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
    line: "Připojuje se nástrojem wacli.",
    action: { kind: "open-tools", label: "Otevřít Nástroje" },
  });
  expect(
    cardView(
      app("x", { path: { path: null, missing: "path" } }),
      undefined,
      options(cs),
    ),
  ).toMatchObject({
    line: "Tady se zatím připojit nedá.",
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
    busy: false,
    failed: false,
  });
  expect(accountView(notion, account("expired"), cs, true)).toMatchObject({
    line: "Přihlášení vypršelo",
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
    "Odpojí se jen v tomto Prostředí.",
  );
  expect(
    disconnectText(
      notion,
      account("connected", "composio"),
      "op@example.test",
      cs,
    ),
  ).toBe(
    "Odpojí se z účtu Composia op@example.test, takže ve všech Prostředích, které ho používají.",
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
    busy: false,
    failed: false,
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
    busy: false,
    failed: false,
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
    "Executor v tomto Prostředí teď neběží, takže nic nejde připojit přímo.",
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

// "Odpojit" took a few seconds before the page changed, and nothing said it
// was happening (the Organization Admin, 2026-10-14). From the person's
// confirmation until the reading after the removal the account's row says
// "Odpojuji…" (the panel dims it, puts a spinner before the words and waits
// its buttons); a removal that fails brings the row back with why (decision
// F42, addendum (b) of 2026-10-14).
test("Odpojit: the row says Odpojuji… from the confirmation until the reading after it, and why it failed", () => {
  const gmail = app("gmail", {
    path: { path: "composio", signIn: false },
    connected: true,
  });
  const work = {
    path: "composio" as const,
    selector: "ca_1",
    label: "Práce",
    state: "connected" as const,
    spare: false,
    manage: manageGmail,
  };
  const home = { ...work, selector: "ca_2", label: "Doma" };
  const notion = app("notion", { connected: true });
  const direct = {
    path: "direct" as const,
    selector: "org/notion-com/default",
    label: "person@example.test",
    state: "connected" as const,
    spare: false,
    manage: null,
  };
  // One key per account: its app, its path and what names it.
  expect(removalKey(gmail, work)).not.toBe(removalKey(gmail, home));
  expect(removalKey(gmail, work)).not.toBe(
    removalKey(notion, { ...work, path: "direct" }),
  );
  const row = (account: IntegrationAccount, removals: Removals) =>
    accountView(
      account.path === "direct" ? notion : gmail,
      account,
      cs,
      true,
      removals.get(
        removalKey(account.path === "direct" ? notion : gmail, account),
      ),
    );
  // Confirmed: busy, "Odpojuji…", nothing to retry; the menu and "Odpojit"
  // stay drawn for the panel to wait them.
  let removals: Removals = new Map();
  removals = removalStep(removals, removalKey(gmail, work), {
    kind: "confirmed",
  });
  expect(row(work, removals)).toMatchObject({
    name: "Práce",
    line: "Odpojuji…",
    busy: true,
    failed: false,
    retry: null,
    menu: { disconnect: true },
  });
  // The other account of the app is untouched.
  expect(row(home, removals)).toMatchObject({ line: null, busy: false });
  // The readings: with both accounts, and after "Práce" went.
  const both = overview([{ ...gmail, accounts: [work, home] }]);
  const without = overview([{ ...gmail, accounts: [home] }]);
  // A reading while the removal still runs keeps the row busy, whatever it
  // lists, and asks for nothing.
  for (const reading of [both, without, null]) {
    const read = removalsRead(removals, reading);
    expect(read.again).toBe(false);
    expect(row(work, read.removals).busy).toBe(true);
  }
  // The removal answered: still "Odpojuji…" until a reading without it.
  removals = removalStep(removals, removalKey(gmail, work), {
    kind: "answered",
    failure: null,
  });
  expect(row(work, removals)).toMatchObject({
    line: "Odpojuji…",
    busy: true,
  });
  // That reading no longer lists the account; nothing of it is kept.
  expect(removalsRead(removals, without)).toEqual({
    removals: new Map(),
    again: false,
  });
  // An Executor account's "Odpojit" in the row goes the same way, and a
  // failure brings the row back with why, its "Odpojit" again.
  removals = removalStep(removals, removalKey(notion, direct), {
    kind: "confirmed",
  });
  expect(row(direct, removals)).toMatchObject({
    line: "Odpojuji…",
    busy: true,
    disconnect: true,
  });
  removals = removalStep(removals, removalKey(notion, direct), {
    kind: "answered",
    failure: cs.integrationsDisconnectFailed,
  });
  expect(row(direct, removals)).toEqual({
    name: "person@example.test",
    line: "Účet se nepodařilo odpojit.",
    retry: null,
    disconnect: true,
    menu: null,
    busy: false,
    failed: true,
  });
  // An expired account that failed to disconnect still offers its sign-in.
  const expired = { ...direct, state: "expired" as const };
  expect(row(expired, removals)).toMatchObject({
    line: "Účet se nepodařilo odpojit.",
    retry: "Přihlásit znovu",
    failed: true,
  });
  // The next successful reading shows the account as it is; a failed one
  // keeps why.
  const withDirect = overview([{ ...notion, accounts: [direct] }]);
  expect(
    row(direct, removalsRead(removals, withDirect).removals),
  ).toMatchObject({
    line: null,
    failed: false,
    busy: false,
  });
  expect(row(direct, removalsRead(removals, null).removals).failed).toBe(true);
  expect(
    accountView(notion, direct, en, true, { state: "removing" }).line,
  ).toBe("Disconnecting…");
  // What the route answered, as the row says it.
  const value = overview([gmail]);
  expect(disconnectFailure({ kind: "disconnected" }, value, cs)).toBeNull();
  expect(
    disconnectFailure(
      { kind: "blocked", reason: "disconnect-unsupported" },
      value,
      cs,
    ),
  ).toBe(cs.integrationsDisconnectUnsupported);
  expect(
    disconnectFailure(
      { kind: "blocked", reason: "composio-organization" },
      value,
      cs,
    ),
  ).toBe(cs.integrationsComposioOrganizationChanged);
  expect(
    disconnectFailure(
      { kind: "blocked", reason: "composio-organization" },
      overview([gmail], {
        composio: {
          ...value.composio,
          organization: { name: "Example Company", state: "elsewhere" },
        },
      }),
      cs,
    ),
  ).toBe(
    cs.integrationsComposioOrganizationElsewhere.replace(
      "{name}",
      "Example Company",
    ),
  );
  for (const answer of [null, "nope", { error: "operation-failed" }, {}])
    expect(disconnectFailure(answer, value, en)).toBe(
      "The account could not be disconnected.",
    );
});

// "I'd like the switch to Lazurio's Composio build to show in the Integrace
// page too, so that ideally everyone switches; short and to the point" (the
// Organization Admin, 2026-10-14). One line where the reading says Composio
// is on here but not the build Lazurio pins and its update can work; its
// button runs the update of Settings → Tools, then the page reads again
// (decision F42, addendum (b) of 2026-10-14).
test("the line about Composio's update: only where the reading offers it, busy until the reading after it, a failure said", () => {
  const offered = overview([], {
    composio: { ...overview([]).composio, update: true },
  });
  // The page takes a reading with its exact shape: `update` a boolean.
  expect(parseIntegrations(JSON.parse(JSON.stringify(offered)))).toEqual(
    offered,
  );
  for (const update of [undefined, "yes", null]) {
    const broken = JSON.parse(JSON.stringify(offered));
    if (update === undefined) delete broken.composio.update;
    else broken.composio.update = update;
    expect(parseIntegrations(broken)).toBeNull();
  }
  // Not offered (Composio off, not installed, signed out, elsewhere on the
  // PATH or already the build: the reading says false): no line.
  expect(composioUpdateLine(overview([]), "idle", cs)).toBeNull();
  expect(composioUpdateLine(overview([]), "failed", cs)).toBeNull();
  expect(composioUpdateLine(offered, "idle", cs)).toEqual({
    text: "Aktualizujte Composio, ať tu můžete účty odpojovat a vidět jejich jména.",
    action: "Aktualizovat",
    busy: false,
  });
  expect(composioUpdateLine(offered, "idle", en)).toEqual({
    text: "Update Composio to disconnect accounts here and see their names.",
    action: "Update",
    busy: false,
  });
  // The click: busy from it until the reading after a finished update.
  expect(composioUpdateLine(offered, "updating", cs)).toEqual({
    text: "Aktualizuji Composio…",
    action: "Aktualizovat",
    busy: true,
  });
  expect(composioUpdateLine(offered, "updating", en)?.text).toBe(
    "Updating Composio…",
  );
  // An update that did not finish says so, and the button tries again.
  expect(composioUpdateLine(offered, "failed", cs)).toEqual({
    text: "Aktualizace nedoběhla. Zkuste to znovu.",
    action: "Aktualizovat",
    busy: false,
  });
  expect(composioUpdateLine(offered, "failed", en)?.text).toBe(
    "The update did not finish. Try again.",
  );
  // What `/api/tools/upgrade` answered: only `tool-updated` is the update.
  expect(
    composioUpdated({
      kind: "tool-updated",
      tool: "composio",
      after: { version: "0.4.3-lazurio.1" },
    }),
  ).toBe(true);
  for (const answer of [
    { kind: "tool-update-failed", tool: "composio", output: "verify" },
    { kind: "blocked", reason: "busy", tool: "composio" },
    { kind: "blocked", reason: "update-unavailable", tool: "composio" },
    { error: "forbidden" },
    null,
  ])
    expect(composioUpdated(answer)).toBe(false);
  // The texts say nothing a person would have to decode.
  for (const locale of [cs, en])
    for (const key of [
      "integrationsComposioUpdate",
      "integrationsComposioUpdating",
      "integrationsComposioUpdated",
      "integrationsComposioUpdateFailed",
    ] as const)
      expect(locale[key]).not.toMatch(/build|sestaven|fork|CLI|pin|verz/i);
  expect(cs.integrationsComposioUpdated).toBe("Composio je aktualizované.");
  expect(en.integrationsComposioUpdated).toBe("Composio is updated.");
});

// Pablo's review of #417: only a successful reading that no longer lists the
// account ends "Odpojit". A refresh that fails, a reading that still lists
// the account (Composio's list may lag) and a reading that overlaps the
// removal keep the row waiting; the page reads again at most twice, then a
// stale list draws the row as it is with a plain line.
// A reading may answer with one source unreadable, and it then leaves that
// source's accounts out: never "nothing connected". So a removal ends only
// with a reading whose source of the account's path was read (Pablo's
// review of #417), for Composio's accounts and Executor's alike.
test("Odpojit ends only where the account's own source was read", () => {
  const gmail = app("gmail", {
    path: { path: "composio", signIn: false },
    connected: true,
  });
  const notion = app("notion", { connected: true });
  const cases: ReadonlyArray<
    readonly [IntegrationApp, IntegrationAccount, "composio" | "executor"]
  > = [
    [
      gmail,
      {
        path: "composio",
        selector: "ca_1",
        label: "Práce",
        state: "connected",
        spare: false,
        manage: manageGmail,
      },
      "composio",
    ],
    [
      notion,
      {
        path: "direct",
        selector: "org/notion-com/default",
        label: "person@example.test",
        state: "connected",
        spare: false,
        manage: null,
      },
      "executor",
    ],
  ];
  for (const [shownApp, account, source] of cases) {
    const key = removalKey(shownApp, account);
    const answered = removalStep(
      removalStep(new Map(), key, { kind: "confirmed" }),
      key,
      { kind: "answered", failure: null },
    );
    // The source is unreadable and the account is left out: still waiting,
    // read again; after the rechecks, still waiting, never "gone".
    const outage = overview([{ ...shownApp, accounts: [] }], {
      sources: {
        tools: "ok",
        executor: source === "executor" ? "unreadable" : "ok",
        composio: source === "composio" ? "unreadable" : "ok",
      },
    });
    let removals: Removals = answered;
    for (const expected of [true, true, false]) {
      const read = removalsRead(removals, outage);
      expect(read.again).toBe(expected);
      removals = read.removals;
      expect(removals.get(key)?.state).toBe("removed");
      expect(
        accountView(shownApp, account, cs, true, removals.get(key)),
      ).toMatchObject({ line: "Odpojuji…", busy: true });
    }
    // The source recovers: a reading without the account ends it; one that
    // still lists it draws the row as it is.
    expect(
      removalsRead(removals, overview([{ ...shownApp, accounts: [] }])).removals
        .size,
    ).toBe(0);
    expect(
      removalsRead(
        removals,
        overview([{ ...shownApp, accounts: [account] }]),
      ).removals.get(key),
    ).toEqual({ state: "listed" });
  }
});

test("Odpojit waits for a successful reading without the account: a failed, a stale and an overlapping refresh", () => {
  const gmail = app("gmail", {
    path: { path: "composio", signIn: false },
    connected: true,
  });
  const work: IntegrationAccount = {
    path: "composio",
    selector: "ca_1",
    label: "Práce",
    state: "connected",
    spare: false,
    manage: manageGmail,
  };
  const key = removalKey(gmail, work);
  const listing = overview([{ ...gmail, accounts: [work] }]);
  const gone = overview([{ ...gmail, accounts: [] }]);
  const row = (removals: Removals) =>
    accountView(gmail, work, cs, true, removals.get(key));
  const answered = removalStep(
    removalStep(new Map(), key, { kind: "confirmed" }),
    key,
    { kind: "answered", failure: null },
  );
  expect(answered.get(key)).toEqual({ state: "removed", checks: 0 });
  expect(removalRechecks).toBe(2);

  // A failed refresh: the row keeps waiting, and the page reads again,
  // twice at most; then it waits for a reading that succeeds (the page says
  // the Integrace could not be read), which ends it once the account is
  // gone.
  let removals: Removals = answered;
  for (const expected of [true, true, false]) {
    const read = removalsRead(removals, null);
    expect(read.again).toBe(expected);
    removals = read.removals;
    expect(row(removals)).toMatchObject({ line: "Odpojuji…", busy: true });
  }
  expect(removalsRead(removals, gone).removals.size).toBe(0);

  // A stale refresh: a successful reading that still lists the account
  // keeps "Odpojuji…" and reads again; after two more such readings the row
  // is drawn as it is, with its actions and one plain line.
  removals = answered;
  for (const expected of [true, true]) {
    const read = removalsRead(removals, listing);
    expect(read.again).toBe(expected);
    removals = read.removals;
    expect(row(removals).busy).toBe(true);
  }
  const stale = removalsRead(removals, listing);
  expect(stale.again).toBe(false);
  expect(row(stale.removals)).toEqual({
    name: "Práce",
    line: "Odpojeno, ale ještě se tu ukazuje. Za chvíli zkontrolujte připojení.",
    retry: null,
    disconnect: false,
    menu: {
      label: "Další volby pro Práce v aplikaci Gmail",
      manage: manageGmail,
      disconnect: true,
    },
    busy: false,
    failed: false,
  });
  expect(accountView(gmail, work, en, true, stale.removals.get(key)).line).toBe(
    "Disconnected, but it still shows here. Check connections in a moment.",
  );
  // It stays so while readings list it or fail, and goes with a reading
  // without it; "Odpojit" again starts over.
  expect(removalsRead(stale.removals, listing).removals.get(key)).toEqual({
    state: "listed",
  });
  expect(removalsRead(stale.removals, null).removals.get(key)).toEqual({
    state: "listed",
  });
  expect(removalsRead(stale.removals, gone).removals.size).toBe(0);
  expect(
    removalStep(stale.removals, key, { kind: "confirmed" }).get(key),
  ).toEqual({ state: "removing" });

  // A refresh overlapping the removal: a reading that completes while it
  // runs, with the account or already without it, changes nothing; only the
  // reading after its answer counts.
  let overlapping: Removals = removalStep(new Map(), key, {
    kind: "confirmed",
  });
  for (const reading of [listing, gone, null]) {
    const read = removalsRead(overlapping, reading);
    expect(read).toEqual({ removals: overlapping, again: false });
  }
  overlapping = removalStep(overlapping, key, {
    kind: "answered",
    failure: null,
  });
  expect(row(overlapping).busy).toBe(true);
  expect(removalsRead(overlapping, gone)).toEqual({
    removals: new Map(),
    again: false,
  });
  // A failed removal goes with a successful reading, whatever it lists.
  const failed = removalStep(
    removalStep(new Map(), key, { kind: "confirmed" }),
    key,
    { kind: "answered", failure: cs.integrationsDisconnectFailed },
  );
  expect(removalsRead(failed, listing).removals.size).toBe(0);
  expect(removalsRead(failed, null).removals.get(key)).toEqual({
    state: "failed",
    text: "Účet se nepodařilo odpojit.",
  });
});

test("the Microsoft 365 card: found by Outlook, OneDrive, SharePoint and Microsoft, Připojit and then Přidat účet", () => {
  const card = app(microsoft365Card.id, { name: "Microsoft 365" });
  const value = overview([card, app("notion")]);
  const catalog = [...integrationsCatalog.apps, microsoft365Card];
  for (const search of ["outlook", "OneDrive", "sharepoint", "Microsoft"])
    expect(
      visibleApps(value, catalog, "all", search).map((item) => item.id),
      search,
    ).toContain(microsoft365Card.id);
  expect(cardView(card, microsoft365Card, options(cs))).toMatchObject({
    line: "Outlook (pošta a kalendář), OneDrive a SharePoint přes firemní aplikaci.",
    action: { kind: "connect", label: "Připojit", path: "direct" },
    composio: false,
  });
  // A second account beside the first: "Přidat účet", each with Odpojit.
  const connected = app(microsoft365Card.id, {
    connected: true,
    accounts: [
      {
        path: "direct",
        selector: "org/m365/default",
        label: "ada@contoso.example",
        state: "connected",
        spare: false,
        manage: null,
      },
    ],
  });
  expect(cardView(connected, microsoft365Card, options(cs))).toMatchObject({
    connected: true,
    pathLabel: "přímo",
    action: { kind: "connect", label: "Přidat účet", path: "direct" },
  });
  expect(
    accountView(
      connected,
      connected.accounts[0] as IntegrationAccount,
      cs,
      false,
    ),
  ).toMatchObject({ name: "ada@contoso.example", disconnect: true });
});

test("every notice has a tone the page draws: a refused connect says why as an error, a name asked for or Composio's sign-in guide, Composio's organization is a state", () => {
  for (const reason of [
    "name-taken",
    "browser-unavailable",
    "executor-unavailable",
    "integration-conflict",
    "still-failing",
    "something-new",
    undefined,
  ])
    expect(refusalNote(reason, null, cs).tone).toBe("danger");
  expect(refusalNote("still-failing", null, en)).toEqual({
    text: en.integrationsStillFailing,
    tone: "danger",
  });
  expect(refusalNote("something-new", null, cs).text).toBe(
    cs.integrationsConnectFailed,
  );
  expect(refusalNote("name-required", null, cs)).toEqual({
    text: cs.integrationsAccountNameHint,
    tone: "info",
  });
  expect(refusalNote("composio-signed-out", null, cs)).toEqual({
    text: cs.integrationsComposioSignIn,
    tone: "info",
  });
  // Without a reading, the organization's line is the general one.
  expect(refusalNote("composio-organization", null, cs)).toEqual({
    text: cs.integrationsComposioOrganizationChanged,
    tone: "warning",
  });
  expect(noticeIcon("success")).toBe("i-check");
  expect(noticeIcon("info")).toBe("i-info");
  expect(noticeIcon("warning")).toBe("i-warning");
  expect(noticeIcon("danger")).toBe("i-warning");
});

test("Czech notices about an app hold for any app's name: no adjective that takes the name's gender, no declined name", () => {
  // "Microsoft 365 je připojená" would be wrong for Slack or Zoom; the
  // texts say "Připojeno: …" or name the app after "aplikace".
  for (const key of [
    "integrationsConnectedNow",
    "integrationsReturnConnected",
    "integrationsReturnFailed",
    "integrationsReturnPending",
  ] as const) {
    const text = cs[key];
    expect(text).toContain("{app}");
    expect(text).not.toMatch(/\{app\} je /);
    expect(text).not.toMatch(/\bdo \{app\}/);
  }
  expect(cs.integrationsConnectedNow).toBe("Připojeno: {app}.");
  // A card's line says nothing that takes the app's gender either.
  expect(cs.integrationsMissingPath).not.toMatch(/\bji\b/);
  expect(cs.integrationsMissingTool).not.toMatch(/\bji\b/);
  // The return pages send the person back to Lazurio, not to an internal
  // part's name; the Organization is the Organization, not "firma"; and the
  // Czech page says "tento", never "tenhle".
  const integrace = Object.entries(cs).filter(
    ([key]) =>
      key.startsWith("integrations") || key.startsWith("composioModel"),
  );
  for (const [key, text] of integrace) {
    expect([key, text]).not.toEqual([key, expect.stringMatching(/Launchpad/)]);
    expect([key, text]).not.toEqual([
      key,
      expect.stringMatching(/\bfirm[ěa]\b/),
    ]);
    expect([key, text]).not.toEqual([
      key,
      expect.stringMatching(
        /\b(t[eě]nhle|t[aáoéuyí]hle|t[oí]mhle|t[eě]chhle|tímhle|téhle|tuhle|tohohle)\b/i,
      ),
    ]);
  }
  for (const key of [
    "integrationsReturnConnected",
    "integrationsReturnFailed",
    "integrationsReturnPending",
    "integrationsReturnUnknown",
  ] as const) {
    expect(cs[key]).toMatch(/Lazuri/);
    expect(en[key]).toContain("Lazurio");
    expect(en[key]).not.toContain("Launchpad");
  }
  expect(en.integrationsComposioOffOrganization).toBe(
    "Composio is off in the Organization.",
  );
  // An account's row says its state once; its button says what to do.
  expect(cs.integrationsAccountExpired).toBe("Přihlášení vypršelo");
  expect(en.integrationsAccountFailed).toBe("The connection failed");
});
