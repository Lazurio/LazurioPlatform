import { describe, expect, test } from "bun:test";
import {
  type AddressTarget,
  browserTimes,
  addressBarTarget as resolveAddress,
} from "../src/browser/contract/pure";
import type { PublicEntry } from "../src/launchpad/chat";
import {
  actionFailure,
  ago,
  catalogModuleLook,
  closeOutcome,
  closeWarning,
  fill,
  formatMemory,
  hideAnswered,
  hideAsked,
  inThisStrip,
  isNoBrowser,
  memoryModel,
  memoryTone,
  moduleRows,
  type NewTabMemory,
  type NewTabTab,
  newTabCopy,
  openerLabel,
  overviewFailure,
  pageStrip,
  parseOverview,
  replacesUndo,
  settleOverrides,
  sortTabs,
  suggestions,
  type TabOverride,
  tabRows,
  tabStatus,
  toastModel,
  toolForKey,
  undoDeadline,
  viewOriginOf,
  visibleTabs,
  withOverride,
  withoutOverride,
} from "../src/launchpad/new-tab-view";
import type {
  Catalog,
  CatalogModule,
  CatalogOrganization,
} from "../src/organizations/catalog";

// Nová karta without a DOM (decision F47 points 1-3 and 6-9, the approved
// wireframe prototypes-lazurio #27: NewTab.tsx and browser.ts): what the page
// `/new-tab` and the Launchpad's panel decide before they draw. The address
// bar's resolution, the memory and its tone, "when last used", who opened a
// tab, "v tomto vlákně", Přehled's order, values nobody knows, the warning
// before closing a tab an agent works in, Vrátit, the running Modules, the
// suggestions and the notes, in the wireframe's Czech and in English.

const cs = newTabCopy("cs");
const en = newTabCopy("en");
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const view = "https://browser.vm-01.example.lazurio.io";
const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");
const now = Date.parse("2026-10-11T12:00:00.000Z");
const minutesAgo = (count: number) =>
  new Date(now - count * 60_000).toISOString();

describe("the address bar (the wireframe's resolveAddress)", () => {
  test("a link to a tab of this Environment's view is that tab, its id in either case, typed with or without its scheme", () => {
    const tab: AddressTarget = {
      kind: "tab",
      tab: id(10),
      view: `${view}/t/${id(10)}`,
    };
    // A slash after the id was this tab too before decision F50 point 2; the
    // next test refuses it.
    for (const typed of [
      `${view}/t/${id(10)}`,
      `${view}/t/${id(10).toLowerCase()}`,
      `browser.vm-01.example.lazurio.io/t/${id(10)}`,
      `  ${view}/t/${id(10)}  `,
      `http://browser.vm-01.example.lazurio.io/t/${id(10)}`,
    ])
      expect(resolveAddress(typed, view)).toEqual(tab);
  });

  // The address bar is Chrome's (F50 point 2, Address bars): like the scheme,
  // the spaces and http above, a written default port and dot segments are
  // the address they stand for, and the view-host rule applies to that
  // address. So they open this tab or a new one, never a view inside the
  // Environment browser. A link read elsewhere (`viewAddressOf`) is taken
  // only as written.
  test("the address bar reads a typed view address as Chrome does: a default port and dot segments are the address they stand for", () => {
    const tab: AddressTarget = {
      kind: "tab",
      tab: id(10),
      view: `${view}/t/${id(10)}`,
    };
    for (const typed of [
      `https://browser.vm-01.example.lazurio.io:443/t/${id(10)}`,
      `${view}/t/../t/${id(10)}`,
      `${view}/x/../t/${id(10)}`,
    ])
      expect(resolveAddress(typed, view)).toEqual(tab);
    expect(
      resolveAddress("https://browser.vm-01.example.lazurio.io:443/", view),
    ).toEqual({ kind: "new-tab" });
    // Another port is another address, and on a view host it is refused.
    expect(
      resolveAddress(
        `https://browser.vm-01.example.lazurio.io:8443/t/${id(10)}`,
        view,
      ),
    ).toEqual({ kind: "refused", reason: "view" });
  });

  test("an address of another Environment's view is never opened here: the notice names it and links there", () => {
    const other = `https://browser.vm-02.example.lazurio.io/t/${id(10)}`;
    // Even with an id this Environment has (a tab is its browser and its id
    // together).
    expect(resolveAddress(other, view)).toEqual({
      kind: "foreign",
      href: other,
      where: "vm-02.example",
    });
    // Typed without a scheme or over http, the link is the view's own https.
    expect(
      resolveAddress(`browser.vm-02.example.lazurio.io/t/${id(10)}`, view),
    ).toEqual({ kind: "foreign", href: other, where: "vm-02.example" });
    expect(
      resolveAddress(other.replace("https:", "http:"), view),
    ).toMatchObject({ kind: "foreign", href: other });
    // A personal Environment, and its view's root.
    expect(resolveAddress("https://browser.someone.lazurio.io/", view)).toEqual(
      {
        kind: "foreign",
        href: "https://browser.someone.lazurio.io/",
        where: "someone",
      },
    );
    // Without a known view origin no view link is opened as a page here.
    expect(resolveAddress(`${view}/t/${id(10)}`, null)).toMatchObject({
      kind: "foreign",
    });
  });

  test("on the view host of an Environment, only a view address opens, and never as a page: its bare origin as a new tab, any other address is refused (decision F50 point 2)", () => {
    for (const typed of [
      `${view}/t/${id(10)}/`,
      `${view}/t/${id(10)}?x=1`,
      `${view}/t/${id(10)}#top`,
      `${view}/assets/view.js`,
      `https://browser.vm-02.example.lazurio.io/t/${id(10)}/`,
      `https://browser.a.b.c.lazurio.io/t/${id(10)}`,
      `https://browser.-vm.example.lazurio.io/t/${id(10)}`,
      `https://browser.vm-01.example.lazurio.io:8443/t/${id(10)}`,
      "https://browser.lazurio.io/",
    ])
      expect(resolveAddress(typed, view)).toEqual({
        kind: "refused",
        reason: "view",
      });
    // The bare origin opens a new remote tab, as it does in a browser, never
    // the view inside the Environment browser.
    for (const typed of [view, `${view}/`, "browser.vm-01.example.lazurio.io"])
      expect(resolveAddress(typed, view)).toEqual({ kind: "new-tab" });
    // Another Environment's tab by a lower-case id is that Environment's,
    // written as the contract writes it.
    expect(
      resolveAddress(
        `https://browser.vm-02.example.lazurio.io/t/${id(10).toLowerCase()}`,
        view,
      ),
    ).toEqual({
      kind: "foreign",
      href: `https://browser.vm-02.example.lazurio.io/t/${id(10)}`,
      where: "vm-02.example",
    });
    // A host named so elsewhere is a page like any other.
    expect(resolveAddress("https://browser.example.com/t/x", view)).toEqual({
      kind: "page",
      url: "https://browser.example.com/t/x",
    });
  });

  test("an address with its scheme, or host-like with a dot and no spaces, opens as a page", () => {
    const page = (url: string): AddressTarget => ({ kind: "page", url });
    expect(resolveAddress("https://example.com/a?b=c#d", view)).toEqual(
      page("https://example.com/a?b=c#d"),
    );
    expect(resolveAddress("http://example.com", view)).toEqual(
      page("http://example.com/"),
    );
    expect(resolveAddress("example.com", view)).toEqual(
      page("https://example.com/"),
    );
    expect(resolveAddress("docs.example.co.uk/guide?x=1", view)).toEqual(
      page("https://docs.example.co.uk/guide?x=1"),
    );
    // An IP address over http, as Chrome opens it (F50 point 2).
    expect(resolveAddress("192.168.1.10:8080/status", view)).toEqual(
      page("http://192.168.1.10:8080/status"),
    );
    expect(resolveAddress("příklad.cz", view)).toEqual(
      page(new URL("https://příklad.cz").href),
    );
    // A host of the domain that is no view is a page like any other.
    expect(resolveAddress("crm.vm-02.example.lazurio.io", view)).toEqual(
      page("https://crm.vm-02.example.lazurio.io/"),
    );
  });

  test("anything else is a search, an e-mail address and a number included", () => {
    const search = (words: string): AddressTarget => ({
      kind: "page",
      url: `https://www.google.com/search?q=${encodeURIComponent(words)}`,
    });
    for (const typed of [
      "nová karta lazurio",
      "3.14",
      "a.b",
      "someone@example.com",
      "example.com/with a space",
    ])
      expect(resolveAddress(typed, view)).toEqual(search(typed));
    expect(resolveAddress("  ", view)).toEqual({ kind: "none" });
  });

  // A search would send the view's address to the search engine (Pablo's
  // reviews of #407): the same host in another spelling is refused, while a
  // text with a space stays a search, as in Chrome.
  test("a text that mentions a view host is never a search, in any spelling", () => {
    // Never a page: neither searched for nor loaded in the Environment
    // browser. Most are refused; a spelling the URL parser reads as the
    // strict view address (full-width letters) is that tab.
    for (const typed of [
      `browser.vm-01.example.lazurio.io./t/${id(10)}`,
      "browser.vm-01.example.lazurio.io.",
      `BROWSER.VM-01.EXAMPLE.LAZURIO.IO./t/${id(10)}`,
      `browser.vm-01.example.lazurio.io.:443/t/${id(10)}`,
      `browser.vm_01.example.lazurio.io/t/${id(10)}`,
      `browser%2Evm-01.example.lazurio.io/t/${id(10)}`,
      `browser\uFF0Evm-01\uFF0Eexample\uFF0Elazurio\uFF0Eio/t/${id(10)}`,
      `https://browser.vm-01.example.lazurio.io:99999/t/${id(10)}`,
      `user@browser.vm-01.example.lazurio.io/t/${id(10)}`,
      `//browser.vm-01.example.lazurio.io/t/${id(10)}`,
      "//browser.vm-01.example.lazurio.io",
      `\\\\browser.vm-01.example.lazurio.io\\t\\${id(10)}`,
      `/\\browser.vm-01.example.lazurio.io/t/${id(10)}`,
      `browser.vm-01.example.lazurio.io%2Ft%2F${id(10)}`,
      `https:browser.vm-01.example.lazurio.io:99999/t/${id(10)}`,
      `\uFF42\uFF52\uFF4F\uFF57\uFF53\uFF45\uFF52.vm-01.example.lazurio.io/t/${id(10)}`,
      `browser\u3002vm-01\u3002example\u3002lazurio\u3002io/t/${id(10)}`,
      `brow\u00ADser.vm-01.example.lazurio.io/t/${id(10)}`,
      `browser.vm-01.example.lazu\u00ADrio.io/t/${id(10)}`,
      `//brow\u00ADser.vm-01.example.lazurio.io/t/${id(10)}`,
      `browser\u200B.vm-01.example.lazurio.io/t/${id(10)}`,
    ])
      expect([typed, resolveAddress(typed, view).kind]).not.toEqual([
        typed,
        "page",
      ]);
    expect(
      resolveAddress("browser.vm-01.example.lazurio.io nefunguje", view),
    ).toEqual({
      kind: "page",
      url: "https://www.google.com/search?q=browser.vm-01.example.lazurio.io%20nefunguje",
    });
  });

  // Chrome's address bar (F50 point 2): localhost and a one-label name with
  // a port or a path over http, and another scheme refused. Before, Nová
  // karta searched for these.
  test("localhost and a one-label name with a port or a path open over http, and another scheme is refused", () => {
    expect(resolveAddress("localhost:3000", view)).toEqual({
      kind: "page",
      url: "http://localhost:3000/",
    });
    expect(resolveAddress("intranet/wiki", view)).toEqual({
      kind: "page",
      url: "http://intranet/wiki",
    });
    for (const typed of ["javascript:alert(1)", "file:///etc/passwd"])
      expect(resolveAddress(typed, view)).toEqual({
        kind: "refused",
        reason: "scheme",
      });
  });
});

describe("memory (the wireframe's formatMemory and memoryTone)", () => {
  test("bytes as people read them, in binary units and the page's language", () => {
    expect(formatMemory(180 * MiB, "cs")).toBe("180 MB");
    expect(formatMemory(0, "cs")).toBe("0 MB");
    // A part that takes anything is never "0 MB".
    expect(formatMemory(0.3 * MiB, "cs")).toBe("1 MB");
    expect(formatMemory(1000 * MiB, "cs")).toBe("1 GB");
    expect(formatMemory(1.4 * GiB, "cs")).toBe("1,4 GB");
    expect(formatMemory(1.4 * GiB, "en")).toBe("1.4 GB");
    expect(formatMemory(8 * GiB, "en")).toBe("8 GB");
  });

  test("the Dashboard's thresholds: 80 % warns, 90 % is bad", () => {
    expect(
      [0, 79, 80, 89, 90, 100, 130].map((percent) => memoryTone(percent)),
    ).toEqual(["ok", "ok", "warn", "warn", "bad", "bad", "bad"]);
  });

  const known: NewTabMemory = {
    total: 8 * GiB,
    used: 6963 * MiB,
    browser: 2150 * MiB,
    core: { launchpad: 180 * MiB, t3code: 620 * MiB },
    modules: 1190 * MiB,
    rest: 2823 * MiB,
  };

  test("the block: used of total, the bar, Záložky, Moduly, Ostatní with the protected core, and the hint once it warns", () => {
    expect(memoryModel(known, cs, "cs")).toEqual({
      value: { used: "6,8 GB", total: "8 GB" },
      percent: 85,
      tone: "warn",
      parts: [
        { text: "Záložky 2,1 GB", title: null },
        { text: "Moduly 1,2 GB", title: null },
        {
          text: "Ostatní 3,5 GB",
          title: "Lazurio, T3 Code, brána Prostředí, agenti a systém",
        },
      ],
      hint: "Paměť je skoro plná. Zavřete těžké záložky a zastavte Moduly, které nepotřebujete.",
    });
    const calm = memoryModel({ ...known, used: 4 * GiB }, en, "en");
    expect([calm?.tone, calm?.percent, calm?.hint]).toEqual(["ok", 50, null]);
    // Past the total the bar is full and the tone bad.
    const over = memoryModel({ ...known, used: 9 * GiB }, cs, "cs");
    expect([over?.percent, over?.tone]).toEqual([100, "bad"]);
  });

  test("a value nobody knows is left out, never shown as 0", () => {
    const unknownTotal = memoryModel({ ...known, total: null }, cs, "cs");
    expect(unknownTotal).toMatchObject({
      value: null,
      percent: null,
      tone: "ok",
      hint: null,
    });
    expect(unknownTotal?.parts).toHaveLength(3);
    const parts = (memory: NewTabMemory) =>
      memoryModel(memory, cs, "cs")?.parts.map((part) => part.text);
    expect(parts({ ...known, browser: null })).toEqual([
      "Moduly 1,2 GB",
      "Ostatní 3,5 GB",
    ]);
    // Ostatní holds the core: without one of its parts it is not known.
    expect(
      parts({ ...known, core: { launchpad: null, t3code: 620 * MiB } }),
    ).toEqual(["Záložky 2,1 GB", "Moduly 1,2 GB"]);
    expect(
      memoryModel(
        {
          total: null,
          used: null,
          browser: null,
          core: { launchpad: null, t3code: null },
          modules: null,
          rest: null,
        },
        cs,
        "cs",
      ),
    ).toBeNull();
  });
});

// One tab as the Launchpad's overview lists it (new-tab-routes.ts).
const fact = (n: number, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  url: `https://site-${n}.example.com/`,
  title: `Stránka ${n}`,
  favicon: null,
  openedAt: minutesAgo(300),
  usedAt: minutesAgo(0),
  opener: { kind: "unknown" },
  agents: [],
  holders: [],
  viewers: 0,
  closing: null,
  grace: null,
  heap: null,
  who: {},
  ...extra,
});
const memory = {
  total: 8 * GiB,
  used: 4 * GiB,
  browser: GiB,
  core: { launchpad: 180 * MiB, t3code: 620 * MiB },
  modules: 0,
  rest: GiB,
};
const overviewOf = (tabs: unknown[] | null, extra = {}) =>
  parseOverview({ hub: "connected", tabs, memory, modules: [], ...extra });
const tabsOf = (tabs: unknown[]): readonly NewTabTab[] =>
  overviewOf(tabs)?.tabs ?? [];

describe("the tabs of Přehled", () => {
  test("when last used, after the wireframe's ago", () => {
    const minute = 60_000;
    expect(
      [0, 59_000, 3 * minute, 59 * minute, 2 * 60 * minute, 25 * 60 * minute]
        .concat([49 * 60 * minute, 5 * 24 * 60 * minute, -minute])
        .map((elapsed) => ago(elapsed, cs)),
    ).toEqual([
      "teď",
      "teď",
      "před 3 min",
      "před 59 min",
      "před 2 h",
      "včera",
      "před 2 dny",
      "před 5 dny",
      "teď",
    ]);
    expect(
      [3 * minute, 2 * 60 * minute, 25 * 60 * minute, 49 * 60 * minute].map(
        (elapsed) => ago(elapsed, en),
      ),
    ).toEqual(["3 min ago", "2 h ago", "yesterday", "2 days ago"]);
  });

  test("the status: an agent at work, else in use now or when last used; nothing for a time nobody gave", () => {
    const at = (usedAt: number | null, agents: string[] = []) =>
      tabStatus({ agents, usedAt }, now, cs);
    expect(at(now, ["codex-a1"])).toEqual({
      text: "agent tu pracuje",
      working: true,
    });
    expect(at(now - 30_000)).toEqual({ text: "používaná teď", working: false });
    expect(at(now - 3 * 60_000)).toEqual({
      text: "naposledy před 3 min",
      working: false,
    });
    expect(
      tabStatus({ agents: [], usedAt: now - 3 * 60_000 }, now, en),
    ).toEqual({ text: "last used 3 min ago", working: false });
    expect(at(null)).toBeNull();
  });

  test("who opened a tab: an agent by its app and a T3 Code thread's title, a user never by name", () => {
    expect(
      openerLabel({ app: "t3code", thread: "Faktury za září" }, cs),
    ).toEqual({ text: "Agent · T3 Code · Faktury za září", icon: "bot" });
    expect(openerLabel({ app: "t3code", thread: null }, cs)?.text).toBe(
      "Agent · T3 Code",
    );
    expect(openerLabel({ app: "codex" }, cs)?.text).toBe("Agent · Codex");
    expect(openerLabel({ app: "claude" }, cs)?.text).toBe(
      "Agent · Claude Code",
    );
    // Uživatel, as the Launchpad names the people who use it (Matěj
    // 2026-10-12); a MausBot bot will be "Bot" once it is an app here.
    expect(openerLabel({ person: true }, cs)).toEqual({
      text: "Uživatel",
      icon: "user",
    });
    expect(openerLabel({ person: true }, en)?.text).toBe("User");
    expect(openerLabel({ page: id(3) }, cs)).toEqual({
      text: "Otevřela ji stránka",
      icon: "page",
    });
    expect(openerLabel({}, cs)).toBeNull();
    // The overview's answer passes a person's name nowhere.
    const [tab] = tabsOf([fact(1, { who: { person: true, name: "Jana" } })]);
    expect(tab?.who).toEqual({ person: true });
  });

  test("v tomto vlákně: the host's strip holds the tab, and it is a thread's, never the Launchpad's", () => {
    const holders = [
      { strip: "t3-x", label: "Faktury za září" },
      { strip: "launchpad", label: "Launchpad" },
    ];
    expect(inThisStrip({ holders }, "t3-x")).toBe(true);
    expect(inThisStrip({ holders }, "t3-y")).toBe(false);
    expect(inThisStrip({ holders }, "launchpad")).toBe(false);
    expect(inThisStrip({ holders }, null)).toBe(false);
  });

  test("Přehled's order: the heaviest first, an unknown heap after every known one, then the most recently used", () => {
    const tabs = [
      { id: "a", heap: 10 * MiB, usedAt: 1 },
      { id: "b", heap: null, usedAt: 9 },
      { id: "c", heap: 600 * MiB, usedAt: 1 },
      { id: "d", heap: null, usedAt: 20 },
      { id: "e", heap: 10 * MiB, usedAt: 5 },
    ];
    expect(sortTabs(tabs).map((tab) => tab.id)).toEqual([
      "c",
      "e",
      "a",
      "d",
      "b",
    ]);
  });

  test("the overview's answer is read field by field: a tab or Module of another shape goes, an unknown value stays unknown", () => {
    const read = parseOverview({
      hub: "connected",
      tabs: [
        fact(1, {
          id: id(1).toLowerCase(),
          favicon: "https://site-1.example.com/favicon.ico",
          agents: ["codex-a1", "not a session"],
          holders: [{ strip: "t3-x", label: "Faktury" }, { strip: "../x" }],
          closing: "2026-10-11T12:00:08.000Z",
          heap: { used: 236 * MiB, total: 512 * MiB },
          who: { app: "codex" },
        }),
        fact(2, { favicon: "http://insecure.example.com/icon.png" }),
        { id: "not a tab", url: "https://x.example.com/", title: "" },
        "a tab",
      ],
      memory: { ...memory, browser: -1, modules: "1 GB" },
      modules: [
        {
          org: "example",
          module: "deals",
          app: "app/v1/package.json",
          unit: "lazurio-app-example-deals.service",
          memory: 780 * MiB,
          mode: "dev",
          source: "main",
        },
        { org: "example", module: "broken" },
      ],
    });
    expect(read?.tabs).toEqual([
      {
        id: id(1),
        url: "https://site-1.example.com/",
        title: "Stránka 1",
        favicon: "https://site-1.example.com/favicon.ico",
        usedAt: now,
        agents: ["codex-a1"],
        holders: [{ strip: "t3-x", label: "Faktury" }],
        closing: true,
        heap: 236 * MiB,
        who: { app: "codex" },
      },
      {
        id: id(2),
        url: "https://site-2.example.com/",
        title: "Stránka 2",
        favicon: null,
        usedAt: now,
        agents: [],
        holders: [],
        closing: false,
        heap: null,
        who: {},
      },
    ]);
    expect(read?.memory).toMatchObject({ browser: null, modules: null });
    expect(read?.modules?.map((module) => module.module)).toEqual(["deals"]);
    // The hub not answering, and which Modules run not known.
    expect(
      parseOverview({ hub: "unreachable", tabs: null, memory, modules: null }),
    ).toMatchObject({ hub: "unreachable", tabs: null, modules: null });
    for (const answer of [null, [], "overview", { hub: "down", tabs: [] }])
      expect(parseOverview(answer)).toBeNull();
  });

  test("a row: its title else its address, who opened it, its status, the heap marked ≈, its view and the right words", () => {
    const tabs = tabsOf([
      fact(1, {
        title: "",
        url: "https://example.org/reports/q3.pdf",
        usedAt: minutesAgo(3),
        heap: { used: 64 * MiB, total: 128 * MiB },
      }),
      fact(2, {
        title: "Faktury za září",
        agents: ["t3-x"],
        holders: [{ strip: "t3-x", label: "Faktury za září" }],
        heap: { used: 612 * MiB, total: 1024 * MiB },
        who: { app: "t3code", thread: "Faktury za září" },
      }),
      fact(3, { usedAt: "yesterday" }),
    ]);
    const rows = (strip: string | null, viewOrigin: string | null = view) =>
      tabRows(tabs, {
        now,
        strip,
        viewOrigin,
        overrides: [],
        copy: cs,
        locale: "cs",
      });
    expect(rows("t3-x")).toEqual([
      {
        id: id(2),
        title: "Faktury za září",
        url: "https://site-2.example.com/",
        favicon: null,
        who: { text: "Agent · T3 Code · Faktury za září", icon: "bot" },
        status: { text: "agent tu pracuje", working: true },
        here: true,
        memory: "≈ 612 MB",
        heavy: true,
        view: `${view}/t/${id(2)}`,
        openTitle: "Otevřít záložku",
        closeTitle: "Pracuje v ní agent: zavře se pro všechny až po varování",
      },
      {
        id: id(1),
        title: "https://example.org/reports/q3.pdf",
        url: "https://example.org/reports/q3.pdf",
        favicon: null,
        who: null,
        status: { text: "naposledy před 3 min", working: false },
        here: false,
        memory: "≈ 64 MB",
        heavy: false,
        view: `${view}/t/${id(1)}`,
        openTitle: "Otevřít v tomto vlákně; zůstane sdílená",
        closeTitle: "Zavře záložku pro všechny",
      },
      {
        id: id(3),
        title: "Stránka 3",
        url: "https://site-3.example.com/",
        favicon: null,
        who: null,
        status: null,
        here: false,
        memory: null,
        heavy: false,
        view: `${view}/t/${id(3)}`,
        openTitle: "Otevřít v tomto vlákně; zůstane sdílená",
        closeTitle: "Zavře záložku pro všechny",
      },
    ]);
    // In the Launchpad every tab is opened as it is, and nothing is "here".
    expect(rows("launchpad").map((row) => [row.here, row.openTitle])).toEqual([
      [false, "Otevřít záložku"],
      [false, "Otevřít záložku"],
      [false, "Otevřít záložku"],
    ]);
    // Without the view's origin a row has no view to choose yet.
    expect(rows(null, null).map((row) => row.view)).toEqual([null, null, null]);
  });
});

describe("closing for everyone, and Vrátit", () => {
  test("a tab closed here goes at once; an overview requested before the close does not bring it back, a later one is the hub's word", () => {
    const tabs = tabsOf([fact(1), fact(2)]);
    // Closed while the 4th overview was the last one requested.
    let overrides = withOverride([], id(1), "hidden", 4);
    expect(visibleTabs(tabs, overrides).map((tab) => tab.id)).toEqual([id(2)]);
    // The 4th overview's answer, begun before the close, still lists it.
    overrides = settleOverrides(overrides, 4);
    expect(visibleTabs(tabs, overrides).map((tab) => tab.id)).toEqual([id(2)]);
    // The 5th, begun after it, says the close counts down: still hidden.
    overrides = settleOverrides(overrides, 5);
    expect(overrides).toEqual([]);
    const counting = tabsOf([
      fact(1, { closing: "2026-10-11T12:00:08.000Z" }),
      fact(2),
    ]);
    expect(visibleTabs(counting, overrides).map((tab) => tab.id)).toEqual([
      id(2),
    ]);
    // Vrátit shows it again even while an older overview says it closes.
    overrides = withOverride(overrides, id(1), "shown", 5);
    expect(visibleTabs(counting, overrides).map((tab) => tab.id)).toEqual([
      id(1),
      id(2),
    ]);
    expect(withoutOverride(overrides, id(1))).toEqual([]);
  });

  test("the warning before closing a tab an agent works in names the agent, in the wireframe's words; keeping it is the answer offered first", () => {
    const tab = {
      title: "Faktury",
      url: "https://invoices.example.com/",
      agents: ["t3-x"],
      holders: [{ strip: "t3-x", label: "Faktury za září" }],
    };
    expect(closeWarning(tab, cs)).toEqual({
      title: "Zavřít záložku, ve které pracuje agent?",
      text: "V záložce „Faktury“ právě pracuje agent z vlákna „Faktury za září“ (T3 Code). Po zavření přijde o rozdělanou stránku a bude ji muset otevřít znovu.",
      keep: "Nechat otevřenou",
      close: "Zavřít i tak",
    });
    expect(closeWarning({ ...tab, agents: ["codex-a1"] }, cs).text).toBe(
      "V záložce „Faktury“ právě pracuje agent (Codex). Po zavření přijde o rozdělanou stránku a bude ji muset otevřít znovu.",
    );
    expect(
      closeWarning({ ...tab, title: "", agents: ["other-1"] }, cs).text,
    ).toBe(
      "V záložce „https://invoices.example.com/“ právě pracuje agent. Po zavření přijde o rozdělanou stránku a bude ji muset otevřít znovu.",
    );
    expect(closeWarning(tab, en)).toMatchObject({
      title: "Close a tab an agent is working in?",
      keep: "Keep it open",
      close: "Close anyway",
    });
  });

  test("the toast keeps Vrátit for the whole grace: a later message shows above it and never takes it away", () => {
    expect(browserTimes.releaseGraceMs).toBe(8_000);
    const pending = {
      tabs: [id(1)],
      text: cs.closing,
      shown: null,
      ends: true,
    };
    expect(toastModel(pending, null, cs)).toEqual({
      note: null,
      text: "Záložka se zavře v Prostředí.",
      undo: "Vrátit",
    });
    expect(
      toastModel({ ...pending, text: cs.closingAgent }, null, cs)?.text,
    ).toBe("Záložka se zavře v Prostředí i agentovi.");
    expect(
      toastModel(pending, "Modul Deals se zastavil a uvolnil 780 MB.", cs),
    ).toEqual({
      note: "Modul Deals se zastavil a uvolnil 780 MB.",
      text: "Záložka se zavře v Prostředí.",
      undo: "Vrátit",
    });
    expect(toastModel(null, "Záložku se nepodařilo zavřít.", cs)).toEqual({
      note: "Záložku se nepodařilo zavřít.",
      text: null,
      undo: null,
    });
    expect(toastModel(null, null, cs)).toBeNull();
    // One command's Vrátit, for every tab it let go of, is one line.
    expect(
      toastModel(
        { ...pending, tabs: [id(1), id(2)], text: cs.closingTabs },
        null,
        cs,
      ),
    ).toEqual({
      note: null,
      text: "Záložky se zavřou v Prostředí.",
      undo: "Vrátit",
    });
  });

  test("one Vrátit at a time, the last command's, but a command that ends no tab never takes the Vrátit of one that ends (the review of #27)", () => {
    const ending = {
      tabs: [id(1)],
      text: cs.closing,
      shown: null,
      ends: true,
    };
    const staying = {
      tabs: [id(2)],
      text: cs.releasedAgent,
      shown: id(2),
      ends: false,
    };
    // Nothing offered: any command's Vrátit.
    expect(replacesUndo(null, staying)).toBe(true);
    expect(replacesUndo(null, ending)).toBe(true);
    // A tab that ends would be lost if a command that ends none took its
    // Vrátit away; that command says its line above it instead.
    expect(replacesUndo(ending, staying)).toBe(false);
    // Otherwise the last command's Vrátit, as before.
    expect(replacesUndo(ending, { ...ending, tabs: [id(3)] })).toBe(true);
    expect(replacesUndo(staying, ending)).toBe(true);
    expect(replacesUndo(staying, { ...staying, tabs: [id(4)] })).toBe(true);
    // A command of several tabs ends one if any of them ends.
    expect(
      replacesUndo(ending, { ...staying, tabs: [id(2), id(5)], ends: true }),
    ).toBe(true);
  });

  test("Zavřít keeps the tab gone while the close is on its way, whatever an overview read before says; once accepted, only an overview requested after gives the hub's word; a failed close brings it back", () => {
    const open = tabsOf([fact(1), fact(2)]);
    const counting = tabsOf([
      fact(1, { closing: "2026-10-11T12:00:08.000Z" }),
      fact(2),
    ]);
    const shown = (tabs: readonly NewTabTab[], overrides: TabOverride[]) =>
      visibleTabs(tabs, overrides).map((tab) => tab.id);
    // Four overviews requested so far; Zavřít is clicked.
    let overrides = [...hideAsked([], id(1))];
    expect(shown(open, overrides)).toEqual([id(2)]);
    // The 5th overview begins before the hub accepted the close and still
    // lists the tab open (Pablo's review of #324): it stays gone.
    overrides = [...settleOverrides(overrides, 5)];
    expect(shown(open, overrides)).toEqual([id(2)]);
    // The hub accepts it while the 5th is the last one requested.
    overrides = [...hideAnswered(overrides, id(1), true, 5)];
    overrides = [...settleOverrides(overrides, 5)];
    expect(shown(open, overrides)).toEqual([id(2)]);
    // The 6th, begun after, is the hub's word: closing, so still gone.
    overrides = [...settleOverrides(overrides, 6)];
    expect(overrides).toEqual([]);
    expect(shown(counting, overrides)).toEqual([id(2)]);
    // A close that fails brings the tab back at once.
    const failed = hideAnswered(hideAsked([], id(2)), id(2), false, 7);
    expect(failed).toEqual([]);
    expect(shown(open, [...failed])).toEqual([id(1), id(2)]);
  });

  test("Vrátit lasts until the hub's deadline as the close's answer measured it, counted from when the request was sent: a late answer leaves less, a passed or missing deadline none", () => {
    const accepted = (value: unknown) => ({ status: 202, value });
    const sentAt = 10_000;
    // 7 s left when the Launchpad answered, received 400 ms after sending.
    expect(
      closeOutcome(accepted({ closing: "x", left: 7_000 }), sentAt, 10_400),
    ).toEqual({ kind: "accepted", undoUntil: 17_000 });
    // The answer came after the deadline: no Vrátit.
    expect(
      closeOutcome(accepted({ closing: "x", left: 7_000 }), sentAt, 17_500),
    ).toEqual({ kind: "accepted", undoUntil: null });
    // Never longer than the grace; without a usable `left`, no Vrátit.
    expect(undoDeadline({ left: 60_000 }, sentAt)).toBe(18_000);
    for (const value of [
      {},
      { left: -1 },
      { left: "7000" },
      { left: NaN },
      null,
    ])
      expect(undoDeadline(value, sentAt)).toBeNull();
    expect(closeOutcome(accepted({ closing: "x" }), sentAt, 10_400)).toEqual({
      kind: "accepted",
      undoUntil: null,
    });
    // A tab the hub no longer lists is gone as surely; anything else failed.
    expect(
      closeOutcome({ status: 404, value: { error: "not-found" } }, sentAt, 1),
    ).toEqual({ kind: "accepted", undoUntil: null });
    for (const answer of [
      { status: 404, value: { error: "no-browser" } },
      { status: 503, value: { error: "hub-unreachable" } },
      { status: 0, value: null },
      { status: 200, value: { closing: "x", left: 7_000 } },
    ])
      expect(closeOutcome(answer, sentAt, 10_400)).toEqual({ kind: "failed" });
  });

  test("a tab the Launchpad let go of stays in Přehled while it lives: its release's grace is no close for everyone", () => {
    const released = tabsOf([
      fact(1, {
        holders: [],
        grace: { kind: "release", endsAt: "2026-10-11T12:00:08.000Z" },
      }),
    ]);
    expect(
      tabRows(released, {
        now,
        strip: "launchpad",
        viewOrigin: view,
        overrides: [],
        copy: cs,
        locale: "cs",
      }).map((row) => row.id),
    ).toEqual([id(1)]);
  });
});

const catalogModule = (
  id: string,
  extra: Partial<CatalogModule> = {},
): CatalogModule => ({
  organization: "example",
  module: id,
  path: `workspace/${id}`,
  teams: ["workspace"],
  teamsSource: "default",
  apps: [{ package: "app/v1/package.json", kind: "runtime-declared" }],
  defaultApp: "app/v1/package.json",
  state: "current",
  executable: true,
  ...extra,
});
const example: CatalogOrganization = {
  directory: "example_GEN3",
  organization: "example",
  displayName: "Example Company",
  state: "current",
  issues: [],
  executable: true,
  teams: [],
  modules: [
    catalogModule("deals", {
      display: { id: "deals", title: "Deals v2", tags: [] },
    }),
    catalogModule("knowledgebase"),
    catalogModule("notes", {
      apps: [],
      defaultApp: null,
      executable: false,
      reason: "no-app",
    }),
  ],
  repositories: [],
};
const catalog: Catalog = { kind: "catalog", organizations: [example] };
const entry: PublicEntry = {
  launchpadOrigin: "https://launchpad.vm-01.example.lazurio.io",
  t3codeOrigin: "https://t3code.vm-01.example.lazurio.io",
  moduleOriginTemplate: "https://{module}.vm-01.example.lazurio.io",
  browserOrigin: view,
};

describe("running Modules, Navrhované and the notes", () => {
  test("Spuštěné Moduly: the heaviest first, named as Apps names them from the boot catalog, else by id, with Zastavit's route", () => {
    const unit = (module: string, memory: number | null) => ({
      org: "example",
      module,
      app: "app/v1/package.json",
      unit: `lazurio-app-example-${module}.service`,
      memory,
      mode: "dev",
      source: "main",
    });
    const rows = moduleRows(
      [unit("knowledgebase", 410 * MiB), unit("deals", 780 * MiB)].concat(
        unit("orders", null),
      ),
      catalogModuleLook(catalog),
      cs,
      "cs",
    );
    expect(rows.map((row) => [row.name, row.memory, row.heavy])).toEqual([
      ["Deals", "780 MB", true],
      ["knowledgebase", "410 MB", false],
      ["orders", null, false],
    ]);
    expect(rows[0]).toMatchObject({
      line: "Vývojový server · main",
      stop: "/api/modules/example/deals/stop",
      app: "app/v1/package.json",
      unit: "lazurio-app-example-deals.service",
    });
    expect(rows[0]?.stone).toEqual(expect.any(String));
    // Without a catalog every Module keeps its id.
    expect(catalogModuleLook(null)("example", "deals")).toBeNull();
    expect(catalogModuleLook(catalog)("other", "deals")).toBeNull();
  });

  test("Navrhované: the Environment's apps on their own origins, in the catalog's order; none on a workstation", () => {
    expect(
      suggestions(catalog, entry).map(({ key, name, href }) => ({
        key,
        name,
        href,
      })),
    ).toEqual([
      {
        key: "example/deals",
        name: "Deals",
        href: "https://deals.vm-01.example.lazurio.io/",
      },
      {
        key: "example/knowledgebase",
        name: "knowledgebase",
        href: "https://knowledgebase.vm-01.example.lazurio.io/",
      },
    ]);
    expect(suggestions(catalog, null)).toEqual([]);
    expect(suggestions(null, entry)).toEqual([]);
  });

  test("no sign-in note on any Environment: the Environment says who shares them, not its browser", () => {
    // Matěj 2026-10-12: both notes went, the Team's too (#340).
    for (const copy of [cs, en]) {
      expect(Object.keys(copy)).not.toContain("note");
      expect(Object.keys(copy)).not.toContain("noteTeam");
    }
  });
});

describe("where things are, the tools' letters and what failed", () => {
  // Root decision 0191 point 29: a page opened from the page /new-tab is
  // held by its host's strip; standalone (Codex Desktop's browser) nobody
  // holds it, where the Launchpad held it before (point 27).
  test("a page opened from the Nová karta page is for its host's strip, and standalone for none", () => {
    expect(pageStrip("hosted", "t3-a")).toBe("t3-a");
    expect(pageStrip("standalone", null)).toBeNull();
    expect(pageStrip("standalone", "t3-a")).toBeNull();
    expect(pageStrip("waiting", "t3-a")).toBeNull();
  });

  test("the view's origin is that of a view address in the contract's strict form (decision F50 point 2)", () => {
    const page = "https://launchpad.vm-01.example.lazurio.io";
    for (const address of [
      "https://elsewhere.example/",
      `${view}/elsewhere`,
      `${view}/t/${id(10)}/`,
      "https://browser.a.b.c.lazurio.io/",
    ])
      expect(viewOriginOf({ available: true, view: address }, page)).toBeNull();
  });

  test("the view's origin from /.lazurio/browser.json: an https origin that is not the page's own", () => {
    const page = "https://launchpad.vm-01.example.lazurio.io";
    expect(viewOriginOf({ available: true, view: `${view}/` }, page)).toBe(
      view,
    );
    expect(
      viewOriginOf({ available: true, view: `${view}/t/${id(1)}` }, page),
    ).toBe(view);
    for (const answer of [
      null,
      "view",
      { available: false, reason: "not-declared" },
      { available: true, view: view.replace("https:", "http:") },
      { available: true, view: `${page}/` },
      { available: true, view: view.replace("https://", "https://a:b@") },
      { available: true, view: 42 },
    ])
      expect(viewOriginOf(answer, page)).toBeNull();
  });

  test("a letter chooses the tool with that key while nobody types and no dialog is open", () => {
    const tools = [
      { id: "terminal", key: "T" },
      { id: "files", key: "F" },
      { id: "agents" },
    ];
    const press = (key: string, extra = {}) =>
      toolForKey(
        {
          key,
          meta: false,
          ctrl: false,
          alt: false,
          composing: false,
          handled: false,
          ...extra,
        },
        tools,
        { typing: false, dialog: false },
      );
    expect([press("t"), press("T"), press("f"), press("x")]).toEqual([
      "terminal",
      "terminal",
      "files",
      null,
    ]);
    for (const modifier of ["meta", "ctrl", "alt", "composing", "handled"])
      expect(press("t", { [modifier]: true })).toBeNull();
    expect(press("Enter")).toBeNull();
    const key = {
      key: "t",
      meta: false,
      ctrl: false,
      alt: false,
      composing: false,
      handled: false,
    };
    expect(toolForKey(key, tools, { typing: true, dialog: false })).toBeNull();
    expect(toolForKey(key, tools, { typing: false, dialog: true })).toBeNull();
  });

  test("a failure says its cause where the answer names it: no browser, the browser not answering, the Launchpad not answering", () => {
    const answer = (status: number, value: unknown = null) => ({
      status,
      value,
    });
    expect(isNoBrowser(answer(404, { error: "no-browser" }))).toBe(true);
    expect(isNoBrowser(answer(404, { error: "not-found" }))).toBe(false);
    expect([0, 502, 503, 504].map(overviewFailure)).toEqual([
      "unreachable",
      "unreachable",
      "unreachable",
      "unreachable",
    ]);
    expect([200, 400, 401, 404, 500].map(overviewFailure)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    const fallback = cs.closeFailed;
    expect(
      [
        answer(404, { error: "no-browser" }),
        answer(503, { error: "hub-unreachable" }),
        answer(0),
        answer(502),
        answer(409, { error: "nothing-to-restore" }),
        answer(404, { error: "not-found" }),
        answer(503, { error: "closing" }),
        answer(503, { error: "holder-unavailable" }),
      ].map((failed) => actionFailure(failed, fallback, cs)),
    ).toEqual([
      "Toto Prostředí nemá prohlížeč.",
      "Prohlížeč Prostředí teď neodpovídá, zkuste to za chvíli znovu.",
      "Lazurio teď neodpovídá, zkuste to za chvíli znovu.",
      "Lazurio teď neodpovídá, zkuste to za chvíli znovu.",
      "Záložku se nepodařilo zavřít.",
      "Záložku se nepodařilo zavřít.",
      // A Launchpad that closes does not answer for long; any other reason
      // it gives is the action's own failure.
      "Lazurio teď neodpovídá, zkuste to za chvíli znovu.",
      "Záložku se nepodařilo zavřít.",
    ]);
  });

  test("the page's beats and its words: Přehled every 5 s, standalone after 1.5 s, every Czech word with its English one", () => {
    expect([
      browserTimes.overviewEveryMs,
      browserTimes.standaloneAfterMs,
    ]).toEqual([5_000, 1_500]);
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
    for (const words of [cs, en])
      for (const value of Object.values(words))
        expect(value.trim()).not.toBe("");
    expect(newTabCopy("de")).toBe(en);
    expect(fill("{a} and {b}", { a: "one" })).toBe("one and {b}");
  });
});
