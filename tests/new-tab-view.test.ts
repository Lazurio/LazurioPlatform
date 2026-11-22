import { describe, expect, test } from "bun:test";
import {
  type AddressTarget,
  browserTimes,
  addressBarTarget as resolveAddress,
} from "../src/browser/contract/pure";
import { guestName, guestStone } from "../src/launchpad/apps-view";
import type { PublicEntry } from "../src/launchpad/chat";
import { messages } from "../src/launchpad/messages";
import {
  actionFailure,
  afterRestart,
  ago,
  catalogModuleLook,
  closeOutcome,
  closeWarning,
  coresText,
  cpuModel,
  cpuTone,
  diskModel,
  diskTone,
  fill,
  formatDisk,
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
  parseUpdateJob,
  replacesUndo,
  settleOverrides,
  sortTabs,
  startedLazurio,
  suggestions,
  type TabOverride,
  tabRows,
  tabStatus,
  toastModel,
  toolForKey,
  type UpdateJob,
  undoDeadline,
  updateView,
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
import { createUpdateJobs, updateEverything } from "../src/update/everything";

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
        {
          org: "example",
          module: "knowledgebase",
          app: "app/v2/package.json",
          unit: "lazurio-app-example-knowledgebase.service",
          memory: 7 * MiB,
          mode: "built",
          commit: "a03dd7c5f1e2b3c4d5e6f708192a3b4c5d6e7f80",
          source: "main",
        },
        {
          org: "example",
          module: "website",
          app: "app/v1/package.json",
          unit: "lazurio-app-example-website.service",
          memory: null,
          mode: "built",
          commit: "../not a commit",
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
    expect(
      read?.modules?.map((module) => [module.module, module.commit]),
    ).toEqual([
      ["deals", null],
      ["knowledgebase", "a03dd7c5f1e2b3c4d5e6f708192a3b4c5d6e7f80"],
      // A commit that is no hex object name is not shown.
      ["website", null],
    ]);
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
  test("the words that name Apps say it in the page's language: Aplikace in Czech (F36's addendum of 2026-11-06)", () => {
    // Zastavit's title and the panel's close for a tab Apps holds name the
    // place the switch names: Aplikace, in its cases.
    expect(cs.stopTitle).toBe(
      "Uvolní paměť; otevřením z Aplikací se Modul spustí znovu",
    );
    expect(cs.closeInLaunchpad).toBe("Zavřít v Aplikacích");
    expect(newTabCopy("en").stopTitle).toBe(
      "Frees memory; opening it from Apps starts the Module again",
    );
    // No Czech word of the page still says Apps.
    expect(Object.values(cs).filter((text) => /\bApps\b/.test(text))).toEqual(
      [],
    );
  });
  test("Spuštěné Moduly: the heaviest first, named as Apps names them from the boot catalog, else by id, with Zastavit's route", () => {
    const unit = (module: string, memory: number | null) => ({
      org: "example",
      module,
      app: "app/v1/package.json",
      unit: `lazurio-app-example-${module}.service`,
      memory,
      mode: "dev",
      source: "main",
      commit: null,
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
    // A built app names the commit its build is of, shortened as Git does
    // (root decision 0212 point 7): the person sees it is the build, and
    // of which commit.
    const built = moduleRows(
      [
        {
          ...unit("knowledgebase", 7 * MiB),
          mode: "built",
          commit: "a03dd7c5f1e2b3c4d5e6f708192a3b4c5d6e7f80",
        },
      ],
      catalogModuleLook(catalog),
      cs,
      "cs",
    );
    expect(built[0]?.line).toBe("Sestavená verze · main · a03dd7c");
    expect(
      moduleRows(
        [{ ...unit("knowledgebase", 7 * MiB), mode: "built" }],
        catalogModuleLook(catalog),
        cs,
        "cs",
      )[0]?.line,
    ).toBe("Sestavená verze · main");
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

// Aktualizovat (root decision 0212 point 7): the run of `lazurio update` as
// `GET /api/update/everything` answers it, one row per module named from the
// boot catalog, and Lazurio itself, each state in plain words.
describe("Aktualizovat: the run's rows per module", () => {
  const sha = (letter: string) => letter.repeat(40);
  const where = (path: string) => ({
    part: "content",
    organization: "Example",
    root: "organizations/example_GEN3",
    path,
    kind: path === "." ? "root" : "module",
    branch: "main",
  });
  const job = (lines: unknown[], state = "running") =>
    parseUpdateJob({
      kind: "update-everything",
      job: { id: "a1", state, lines },
    }) as UpdateJob;
  const rows = (read: UpdateJob, copy = cs) =>
    updateView(read, catalog, copy).rows.map((row) => [
      row.name,
      row.state,
      row.text,
    ]);

  test("the answer read field by field: none yet, another shape, and lines it does not know left out", () => {
    expect(parseUpdateJob({ kind: "update-everything", job: null })).toBeNull();
    expect(parseUpdateJob({ kind: "other", job: null })).toBeUndefined();
    expect(
      parseUpdateJob({
        kind: "update-everything",
        job: { id: 1, state: "running", lines: [] },
      }),
    ).toBeUndefined();
    const read = job([
      { ...where("workspace/deals"), step: "checking", secret: "x" },
      { part: "tools", result: "not-run" },
      { part: "content", path: "workspace/deals" },
      "line",
    ]);
    expect(read).toEqual({
      id: "a1",
      running: true,
      lines: [
        {
          part: "content",
          root: "organizations/example_GEN3",
          path: "workspace/deals",
          kind: "module",
          step: "checking",
        },
      ],
    });
  });

  test("a module goes from checking through a newer version found and fetched to building and done, named as Apps names it; Lazurio last", () => {
    const deals = where("workspace/deals");
    expect(rows(job([{ ...deals, step: "checking" }]))).toEqual([
      ["Deals", "checking", "Kontroluje se"],
    ]);
    expect(
      rows(job([{ ...deals, step: "fetching", to: sha("b") }]), en),
    ).toEqual([["Deals", "fetching", "Newer version bbbbbbb found, fetching"]]);
    const moved = {
      ...deals,
      result: "fast-forwarded",
      from: sha("a"),
      to: sha("b"),
    };
    expect(rows(job([moved]))).toEqual([
      ["Deals", "fetched", "Stažena novější verze bbbbbbb"],
    ]);
    const building = {
      part: "build",
      organization: "example",
      module: "deals",
      app: "app/v1/package.json",
      step: "building",
      commit: sha("b"),
    };
    expect(rows(job([moved, building]))).toEqual([
      ["Deals", "building", "Sestavuje se verze bbbbbbb"],
    ]);
    const built = { ...building, step: undefined, result: "built" };
    expect(
      rows(
        job(
          [
            moved,
            built,
            { part: "product", result: "current", version: "0.1.12" },
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      ["Deals", "done", "Hotovo, verze bbbbbbb"],
      ["Lazurio", "current", "Aktuální, verze 0.1.12"],
    ]);
    // A module without a built app is done once the builds' part ended.
    expect(rows(job([moved, { part: "product", step: "checking" }]))).toEqual([
      ["Deals", "done", "Hotovo, verze bbbbbbb"],
      ["Lazurio", "checking", "Kontroluje se"],
    ]);
  });

  test("up to date, a data mount folded into its module, a module not in the catalog by its path, an absent one left out", () => {
    expect(
      rows(
        job(
          [
            { ...where("."), result: "current" },
            { ...where("workspace/knowledgebase"), result: "current" },
            {
              ...where("workspace/knowledgebase/db"),
              kind: "data",
              result: "fast-forwarded",
              to: sha("c"),
            },
            { ...where("workspace/orders"), result: "current" },
            { ...where("workspace/gone"), result: "absent" },
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      ["knowledgebase", "done", "Hotovo, verze ccccccc"],
      // Never by the last segment of its path (F67's addendum of 2026-11-21).
      ["workspace/orders", "current", "Aktuální"],
    ]);
  });

  // The kinds of repository (the Module Standard, decision F67's addendum of
  // 2026-11-21), on the lines a run of this Environment's shape gives: its
  // own Mission Control with its data and its own Knowledgebase beside the
  // shared Modules of HumanAndMachine-ai, one of them absent here.
  const home = "HumanAndMachine-ai";
  const shared = (slug: string) => `workspace/${home}_GEN3/${slug}`;
  const sharedGuest = (slug: string) => ({
    organization: "example",
    module: slug,
    path: shared(slug),
    homeOrganization: home,
    guest: true as const,
    checkedOut: true,
    url: null,
  });
  const hosting: Catalog = {
    kind: "catalog",
    organizations: [
      {
        ...example,
        modules: [
          catalogModule("mission-control", {
            path: "mission-control",
            display: {
              id: "mission-control",
              title: "Mission Control",
              tags: [],
            },
          }),
          ...example.modules,
        ],
        guests: ["deals", "knowledgebase", "mission-control", "clients"].map(
          sharedGuest,
        ),
      },
    ],
  };
  // A line as `lazurio update --json` gives it: a data repository with its
  // Module (`parent`), a shared Module's and its data's with their home and
  // slot slug.
  const own = (path: string, extra: Record<string, unknown> = {}) => ({
    ...where(path),
    ...extra,
  });
  const data = (parent: string, extra: Record<string, unknown> = {}) => ({
    ...where(`${parent}/db`),
    kind: "data",
    branch: "v3",
    parent,
    ...extra,
  });
  const sharedModule = (slug: string, extra: Record<string, unknown> = {}) => ({
    ...where(shared(slug)),
    home,
    module: slug,
    ...extra,
  });
  const sharedData = (slug: string, extra: Record<string, unknown> = {}) =>
    data(shared(slug), { home, module: slug, ...extra });
  const shown = (read: UpdateJob, copy = cs, from: Catalog = hosting) =>
    updateView(read, from, copy).rows.map((row) => [
      row.name,
      row.state,
      row.text,
      row.badge?.text ?? null,
    ]);

  test("three data repositories (the own Mission Control's, a shared Mission Control's, a shared Clients') make no row \"db\": each stands in its Module's row", () => {
    const run = job(
      [
        own(".", { result: "current" }),
        own("mission-control", { result: "current" }),
        own("workspace/knowledgebase", { result: "current" }),
        sharedModule("deals", {
          result: "absent",
          reason: "repository-denied",
        }),
        sharedModule("knowledgebase", { result: "current" }),
        sharedModule("mission-control", { result: "current" }),
        sharedModule("clients", { result: "current" }),
        data("mission-control", { result: "fast-forwarded", to: sha("c") }),
        sharedData("deals", { result: "absent" }),
        sharedData("mission-control", {
          result: "fast-forwarded",
          to: sha("d"),
        }),
        sharedData("clients", { result: "fast-forwarded", to: sha("e") }),
      ],
      "succeeded",
    );
    const view = shown(run);
    expect(view.map(([name]) => name)).not.toContain("db");
    expect(view).toEqual([
      ["Mission Control", "done", "Hotovo, verze ccccccc", null],
      ["knowledgebase", "current", "Aktuální", null],
      [`${home} / knowledgebase`, "current", "Aktuální", "nasdílený"],
      [
        `${home} / mission-control`,
        "done",
        "Hotovo, verze ddddddd",
        "nasdílený",
      ],
      [`${home} / clients`, "done", "Hotovo, verze eeeeeee", "nasdílený"],
    ]);
    // The keys are all different: no two repositories of different Modules
    // share a row.
    const keys = updateView(run, hosting, cs).rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('an own Module and a shared Module with the same slug are two rows, the shared one "HumanAndMachine-ai / mission-control" with the badge', () => {
    const lines = [
      own("mission-control", { step: "fetching", to: sha("a") }),
      sharedModule("mission-control", { result: "current" }),
    ];
    expect(shown(job(lines))).toEqual([
      [
        "Mission Control",
        "fetching",
        "Nalezena novější verze aaaaaaa, stahuje se",
        null,
      ],
      [`${home} / mission-control`, "current", "Aktuální", "nasdílený"],
    ]);
    const row = updateView(job(lines), hosting, en).rows[1];
    expect(row?.badge).toEqual({
      text: "shared",
      hint: "A Module of another Organization, read here only. Changes belong to its home Organization, and GitHub decides who can read it.",
    });
    // The badge is Apps' own word, in both languages.
    expect(cs.updateShared).toBe(messages("cs").appsGuestBadge);
    expect(en.updateShared).toBe(messages("en").appsGuestBadge);
    expect(cs.updateSharedHint).toBe(messages("cs").appsGuestHint);
    expect(en.updateSharedHint).toBe(messages("en").appsGuestHint);
    // The line alone names it where the catalog does not list the shared
    // Module; the catalog's guest names it for a line that does not say its
    // home (an older run's).
    expect(shown(job(lines), cs, catalog)[1]).toEqual([
      `${home} / mission-control`,
      "current",
      "Aktuální",
      "nasdílený",
    ]);
    expect(
      shown(job([{ ...where(shared("mission-control")), result: "current" }])),
    ).toEqual([
      [`${home} / mission-control`, "current", "Aktuální", "nasdílený"],
    ]);
  });

  test('a shared Module whose declaration the catalog read is named and drawn as Apps draws it: "HumanAndMachine-ai / Mission Control" (F67, addendum of 2026-11-22)', () => {
    const named: Catalog = {
      kind: "catalog",
      organizations: [
        {
          ...example,
          guests: [
            {
              ...sharedGuest("mission-control"),
              display: {
                id: "humanandmachine-ai-mission-control-v3",
                title: "Mission Control v3",
                icon: "control",
                tags: [],
              },
            },
            sharedGuest("clients"),
          ],
        },
      ],
    };
    const lines = [
      sharedModule("mission-control", { result: "current" }),
      sharedData("mission-control", { result: "fast-forwarded", to: sha("d") }),
      sharedModule("clients", { result: "current" }),
    ];
    expect(shown(job(lines, "succeeded"), cs, named)).toEqual([
      [
        `${home} / Mission Control`,
        "done",
        "Hotovo, verze ddddddd",
        "nasdílený",
      ],
      // Without its declaration read, still its slot's id.
      [`${home} / clients`, "current", "Aktuální", "nasdílený"],
    ]);
    const [row] = updateView(job(lines, "succeeded"), named, cs).rows;
    const guest = named.organizations[0]?.guests?.[0];
    if (guest === undefined) throw new Error("no guest");
    expect(row?.stone).toBe(guestStone(guest).src);
    // The same name and stone as its tile in Apps.
    expect(guestName(guest)).toBe("Mission Control");
  });

  // Every line of a row: its first and its further findings (the review of
  // #1184).
  const said = (read: UpdateJob, copy = cs) =>
    updateView(read, hosting, copy).rows.map((row) => [
      row.name,
      row.state,
      [row.text, ...(row.more ?? [])],
    ]);
  const buildFailed = (module: string) => ({
    part: "build",
    organization: "example",
    module,
    app: "app/v1/package.json",
    result: "failed",
    reason: "build-script-failed",
  });

  test("a data repository whose state differs from its Module's says so on its Module's row as \"Data: …\"; the Module's own finding and its data's are both said", () => {
    const dirty = { result: "blocked", reason: "dirty" };
    expect(
      shown(
        job(
          [
            own("mission-control", { result: "current" }),
            data("mission-control", dirty),
            sharedModule("clients", { result: "current" }),
            sharedData("clients", {
              result: "denied",
              reason: "repository-denied",
            }),
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      [
        "Mission Control",
        "finding",
        "Data: Hlavní verze má rozpracované změny, a tak se sama neaktualizuje",
        null,
      ],
      [
        `${home} / clients`,
        "finding",
        "Data: GitHub k němu toto Prostředí nepustil",
        "nasdílený",
      ],
    ]);
    expect(
      shown(
        job(
          [
            own("mission-control", { result: "current" }),
            data("mission-control", {
              result: "unavailable",
              reason: "remote-unavailable",
            }),
          ],
          "succeeded",
        ),
        en,
      ),
    ).toEqual([
      [
        "Mission Control",
        "finding",
        "Data: GitHub is not answering; try again in a moment",
        null,
      ],
    ]);
    // The Module's own finding first, its data's on a line of its own.
    expect(
      said(
        job(
          [
            own("mission-control", {
              result: "blocked",
              reason: "wrong-branch",
            }),
            data("mission-control", dirty),
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      [
        "Mission Control",
        "finding",
        [
          "Hlavní verze je na jiné větvi, a tak se sama neaktualizuje",
          "Data: Hlavní verze má rozpracované změny, a tak se sama neaktualizuje",
        ],
      ],
    ]);
  });

  test("a data finding never hides a failed build: both are said, each on a line of its own", () => {
    expect(
      said(
        job(
          [
            own("mission-control", { result: "current" }),
            data("mission-control", { result: "blocked", reason: "dirty" }),
            buildFailed("mission-control"),
          ],
          "succeeded",
        ),
        en,
      ),
    ).toEqual([
      [
        "Mission Control",
        "finding",
        [
          "Data: Its main version has unfinished changes, so it does not update by itself",
          "The new version could not be built; the previous one keeps running",
        ],
      ],
    ]);
  });

  test("the Module's own finding, its data's and a failed build together: three lines in that order", () => {
    const lines = [
      sharedModule("clients", { result: "blocked", reason: "wrong-branch" }),
      sharedData("clients", { result: "denied", reason: "repository-denied" }),
      own("mission-control", { result: "denied", reason: "repository-denied" }),
      data("mission-control", {
        result: "denied",
        reason: "repository-denied",
      }),
      buildFailed("mission-control"),
    ];
    expect(said(job(lines, "succeeded"))).toEqual([
      [
        `${home} / clients`,
        "finding",
        [
          "Hlavní verze je na jiné větvi, a tak se sama neaktualizuje",
          "Data: GitHub k němu toto Prostředí nepustil",
        ],
      ],
      [
        "Mission Control",
        "finding",
        [
          "GitHub k němu toto Prostředí nepustil",
          "Data: GitHub k němu toto Prostředí nepustil",
          "Novou verzi se nepodařilo sestavit; dál běží předchozí",
        ],
      ],
    ]);
    // Progress stays the row's one line while a repository is under way.
    expect(
      said(
        job([
          ...lines,
          own("mission-control", { step: "fetching", to: sha("f") }),
        ]),
      )[1],
    ).toEqual([
      "Mission Control",
      "fetching",
      ["Nalezena novější verze fffffff, stahuje se"],
    ]);
  });

  test("each line keeps its repository as declared, and a row lists its repositories for its tooltip, never in its name", () => {
    const repository = (name: string) => ({ repository: name });
    const read = job(
      [
        own(".", { result: "blocked", reason: "dirty" }),
        own("mission-control", {
          result: "current",
          ...repository("Example/mission-control"),
        }),
        data("mission-control", {
          result: "current",
          ...repository("Example/mission-control-data"),
        }),
        sharedModule("mission-control", {
          result: "current",
          ...repository(`${home}/mission-control`),
        }),
        sharedData("mission-control", {
          result: "current",
          ...repository(`${home}/mission-control-data`),
        }),
      ].map((line, index) =>
        index === 0 ? { ...line, ...repository("Example/example_GEN3") } : line,
      ),
      "succeeded",
    );
    expect(
      read.lines.map((line) =>
        line.part === "content" ? line.repository : undefined,
      ),
    ).toEqual([
      "Example/example_GEN3",
      "Example/mission-control",
      "Example/mission-control-data",
      `${home}/mission-control`,
      `${home}/mission-control-data`,
    ]);
    expect(
      updateView(read, hosting, cs).rows.map((row) => [
        row.name,
        row.repositories,
      ]),
    ).toEqual([
      ["Example Company", ["Example/example_GEN3"]],
      [
        "Mission Control",
        ["Example/mission-control", "Example/mission-control-data"],
      ],
      [
        `${home} / mission-control`,
        [`${home}/mission-control`, `${home}/mission-control-data`],
      ],
    ]);
  });

  test("an absent shared Module and its data are left out as an absent Module is, never folded into the own Module of its slug", () => {
    expect(
      shown(
        job(
          [
            own("workspace/deals", { result: "current" }),
            sharedModule("deals", {
              result: "absent",
              reason: "repository-denied",
            }),
            sharedModule("clients", { result: "current" }),
            sharedData("deals", { result: "absent" }),
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      ["Deals", "current", "Aktuální", null],
      [`${home} / clients`, "current", "Aktuální", "nasdílený"],
    ]);
    // The other way round: the own Deals absent here, the shared one
    // present, is the shared one's row alone.
    expect(
      shown(
        job(
          [
            own("workspace/deals", { result: "absent" }),
            sharedModule("deals", { result: "current" }),
          ],
          "succeeded",
        ),
      ),
    ).toEqual([[`${home} / deals`, "current", "Aktuální", "nasdílený"]]);
  });

  test("findings in plain words, never a code: unfinished work, another branch, GitHub refusing or silent, a failed build; a blocked root by its Organization", () => {
    const finding = (line: Record<string, unknown>, copy = cs) =>
      updateView(job([line], "succeeded"), catalog, copy).rows[0]?.text;
    const deals = where("workspace/deals");
    expect(finding({ ...deals, result: "blocked", reason: "dirty" })).toBe(
      "Hlavní verze má rozpracované změny, a tak se sama neaktualizuje",
    );
    expect(
      finding({ ...deals, result: "blocked", reason: "wrong-branch" }, en),
    ).toBe(
      "Its main version is on another branch, so it does not update by itself",
    );
    expect(
      finding({ ...deals, result: "denied", reason: "repository-denied" }),
    ).toBe("GitHub k němu toto Prostředí nepustil");
    expect(
      finding({
        ...deals,
        result: "unavailable",
        reason: "remote-unavailable",
      }),
    ).toBe("GitHub teď neodpovídá; zkuste to za chvíli znovu");
    expect(
      finding({
        part: "build",
        organization: "example",
        module: "deals",
        app: "app/v1/package.json",
        result: "failed",
        reason: "build-script-failed",
      }),
    ).toBe("Novou verzi se nepodařilo sestavit; dál běží předchozí");
    expect(
      rows(
        job(
          [{ ...where("."), result: "blocked", reason: "ahead" }],
          "succeeded",
        ),
      ),
    ).toEqual([
      [
        "Example Company",
        "finding",
        "Hlavní verze má rozpracované změny, a tak se sama neaktualizuje",
      ],
    ]);
    // Another update holding the content: one sentence for the run.
    expect(
      updateView(
        job(
          [{ part: "content", result: "not-run", reason: "content-busy" }],
          "succeeded",
        ),
        catalog,
        en,
      ),
    ).toEqual({
      rows: [],
      note: "This Environment is already being updated elsewhere; try again in a moment.",
    });
    // Nothing to do here at all: no rows and no note.
    expect(
      updateView(
        job(
          [
            {
              part: "content",
              result: "not-run",
              reason: "not-for-this-environment",
            },
          ],
          "succeeded",
        ),
        catalog,
        cs,
      ),
    ).toEqual({ rows: [], note: null });
    for (const [copy, words] of [
      [
        cs,
        [cs.updateBlockedChanges, cs.updateBuildFailed, cs.updateLazurioFailed],
      ],
      [
        en,
        [en.updateBlockedChanges, en.updateBuildFailed, en.updateLazurioFailed],
      ],
    ] as const)
      for (const sentence of words) {
        expect(sentence).not.toMatch(/[a-z]+-[a-z]+-?[a-z]*|\//);
        expect(copy.update).not.toBe("");
      }
  });

  test("the Organization's tools: each one's step while it runs, then installed, raised, or a finding that names its stage and reason and links its official installation", () => {
    const tool = (line: Record<string, unknown>) => ({
      part: "organization-tools",
      minimum: "1.89.0",
      ...line,
    });
    const cargoFailed = tool({
      tool: "cargo",
      result: "failed",
      stage: "install",
      reason: "exit-1",
      detail: "curl: (6) Could not resolve host",
      source: "https://rustup.rs",
    });
    // A failed installation survives the parser with what the row needs.
    expect(job([cargoFailed], "succeeded").lines).toEqual([
      {
        part: "organization-tools",
        tool: "cargo",
        minimum: "1.89.0",
        result: "failed",
        stage: "install",
        reason: "exit-1",
        source: "https://rustup.rs",
      },
    ]);
    const view = updateView(
      job(
        [
          { ...where("."), result: "current" },
          cargoFailed,
          tool({
            tool: "pnpm",
            minimum: "11.0.0",
            result: "installed",
            version: "12.21.0",
            onPath: true,
          }),
          { part: "product", result: "current", version: "0.1.22" },
        ],
        "succeeded",
      ),
      catalog,
      cs,
    );
    expect(
      view.rows.map((row) => [row.name, row.state, row.text, row.link]),
    ).toEqual([
      [
        "cargo",
        "finding",
        "Instalace nedoběhla: skončila s chybovým kódem 1",
        { href: "https://rustup.rs", text: "Oficiální instalace" },
      ],
      ["pnpm", "done", "Nainstalována verze 12.21.0", undefined],
      ["Lazurio", "current", "Aktuální, verze 0.1.22", undefined],
    ]);
    // While it runs: its step.
    expect(rows(job([tool({ tool: "cargo", step: "updating" })]), en)).toEqual([
      ["cargo", "building", "Raising to minimum 1.89.0"],
    ]);
    expect(
      rows(
        job([tool({ tool: "pnpm", minimum: "11.0.0", step: "installing" })]),
      ),
    ).toEqual([["pnpm", "building", "Instaluje se, minimum 11.0.0"]]);
    const text = (line: Record<string, unknown>, copy = en) =>
      updateView(job([line], "succeeded"), catalog, copy).rows.map(
        (row) => row.text,
      );
    // At the minimum on the PATH: nothing to say.
    expect(
      text(tool({ tool: "cargo", result: "current", version: "1.90.0" })),
    ).toEqual([]);
    expect(
      text(
        tool({
          tool: "cargo",
          result: "current",
          version: "1.90.0",
          onPath: false,
        }),
      ),
    ).toEqual([
      "Version 1.90.0 is installed, but ~/.local/bin is not on this PATH, so commands do not find it",
    ]);
    expect(
      text(
        tool({
          tool: "cargo",
          result: "updated",
          from: "1.80.0",
          version: "1.92.0",
          onPath: true,
        }),
      ),
    ).toEqual(["Raised from version 1.80.0 to 1.92.0"]);
    expect(
      text(
        tool({
          tool: "cargo",
          result: "below-minimum",
          version: "1.70.0",
          reason: "foreign-installation",
          path: "/usr/bin/cargo",
          source: "https://rustup.rs",
        }),
      ),
    ).toEqual([
      "Version 1.70.0 at /usr/bin/cargo was installed another way and is below minimum 1.89.0; Lazurio leaves it as it is. Update it where it came from",
    ]);
    expect(
      text(
        tool({
          tool: "cargo",
          minimum: "1.95.0",
          result: "failed",
          stage: "update",
          reason: "stable-below-minimum:1.90.0",
          source: "https://rustup.rs",
        }),
        cs,
      ),
    ).toEqual([
      "Aktualizace nedoběhla: nejnovější stable je 1.90.0, pod minimem 1.95.0; zvolený toolchain zůstal",
    ]);
    expect(
      text(
        tool({
          tool: "pnpm",
          minimum: "11.0.0",
          result: "failed",
          stage: "verify",
          reason: "below-minimum-after:10.0.0",
          source: "https://pnpm.io/installation",
        }),
      ),
    ).toEqual([
      "It did not pass the check: afterwards version 10.0.0 is still below minimum 11.0.0",
    ]);
    expect(
      text(
        tool({
          tool: "pnpm",
          result: "failed",
          stage: "install",
          reason: "something-new",
        }),
      ),
    ).toEqual(["The installation did not finish: reason something-new"]);
    // An entry in ~/.local/bin that does not run it: named, never "not on this PATH" (#1030).
    expect(
      text(
        tool({
          tool: "cargo",
          minimum: "1.89.0",
          result: "failed",
          stage: "link",
          reason: "link-occupied",
          source: "https://rustup.rs",
        }),
        cs,
      ),
    ).toEqual([
      "Nepodařilo se ho propojit do ~/.local/bin: ~/.local/bin/cargo už existuje a nástroj nespouští; Lazurio ho nechává, jak je. Odstraňte ho a příští aktualizace nástroj propojí",
    ]);
    // The part as a whole: why it did not check, or that it failed.
    expect(
      rows(
        job(
          [
            {
              part: "organization-tools",
              result: "not-run",
              reason: "not-published",
            },
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      [
        "Nástroje Organizace",
        "finding",
        "Nezkontrolovány: kořen Organizace není na verzi, kterou publikovala, a instaluje se jen publikovaná deklarace",
      ],
    ]);
    expect(
      text({
        part: "organization-tools",
        result: "failed",
        reason: "operation-failed",
      }),
    ).toEqual(["They could not be checked"]);
    // A link is only ever an https address.
    expect(
      updateView(
        job(
          [
            tool({
              tool: "cargo",
              result: "failed",
              stage: "install",
              reason: "timeout",
              source: "javascript:alert(1)",
            }),
          ],
          "succeeded",
        ),
        catalog,
        en,
      ).rows[0]?.link,
    ).toBeUndefined();
  });

  test("Lazurio: started, then updated once the restarted Launchpad runs that version; busy and failed in words", () => {
    const lazurio = (line: Record<string, unknown>, copy = cs) =>
      updateView(job([line], "succeeded"), catalog, copy).rows.at(-1)?.text;
    expect(lazurio({ part: "product", result: "started", to: "0.1.13" })).toBe(
      "Instaluje se verze 0.1.13; Lazurio se pak restartuje",
    );
    expect(
      lazurio({ part: "product", result: "failed", code: "busy" }, en),
    ).toBe("Lazurio is already being updated");
    expect(
      lazurio({
        part: "product",
        result: "failed",
        code: "network-unavailable",
      }),
    ).toBe("Lazurio se nepodařilo aktualizovat");
    expect(
      updateView(
        job([{ part: "product", result: "not-run", reason: "not-installed" }]),
        catalog,
        cs,
      ).rows,
    ).toEqual([]);
    const started = job([
      { ...where("workspace/deals"), result: "current" },
      { part: "product", result: "started", to: "0.1.13" },
    ]);
    expect(startedLazurio(started)).toBe("0.1.13");
    expect(startedLazurio(job([]))).toBeNull();
    // The Launchpad came back on another version: the run's rows stay, and
    // Lazurio is not said to be updated.
    expect(rows(afterRestart(started, "0.1.12")).at(-1)).toEqual([
      "Lazurio",
      "building",
      "Instaluje se verze 0.1.13; Lazurio se pak restartuje",
    ]);
    const after = afterRestart(started, "0.1.13");
    expect(after.running).toBe(false);
    expect(rows(after)).toEqual([
      ["Deals", "current", "Aktuální"],
      ["Lazurio", "done", "Aktualizováno na verzi 0.1.13"],
    ]);
  });

  test("joining a run under way: the rows of the run another click started, as read", () => {
    const joined = job([
      { ...where("workspace/deals"), step: "fetching", to: sha("d") },
      { ...where("workspace/knowledgebase"), result: "current" },
    ]);
    expect(joined.running).toBe(true);
    expect(rows(joined, en)).toEqual([
      ["Deals", "fetching", "Newer version ddddddd found, fetching"],
      ["knowledgebase", "current", "Up to date"],
    ]);
  });

  test("the Bun a moved module pins: a row while it is fetched and once it is, after the modules and before Lazurio; one that was there already says nothing", () => {
    const deals = {
      ...where("workspace/deals"),
      result: "fast-forwarded",
      from: sha("a"),
      to: sha("b"),
    };
    const pin = (line: Record<string, unknown>) => ({
      part: "tools",
      packageManager: "bun@1.4.3",
      ...line,
    });
    expect(rows(job([deals, pin({ step: "fetching" })]))).toEqual([
      ["Deals", "fetched", "Stažena novější verze bbbbbbb"],
      ["Bun", "fetching", "Stahuje se verze 1.4.3"],
    ]);
    expect(
      rows(
        job(
          [
            deals,
            pin({ result: "fetched" }),
            {
              part: "tools",
              packageManager: "bun@1.4.2",
              result: "cached",
            },
            { part: "product", result: "current", version: "0.1.12" },
          ],
          "succeeded",
        ),
        en,
      ),
    ).toEqual([
      ["Deals", "done", "Done, version bbbbbbb"],
      ["Bun", "done", "Version 1.4.3 fetched"],
      ["Lazurio", "current", "Up to date, version 0.1.12"],
    ]);
    // The tools part as a whole failed (pins that could not be read): one
    // finding of its own after the pins' rows, never a pin it does not have.
    expect(
      rows(
        job(
          [
            deals,
            pin({ result: "fetched" }),
            { part: "tools", result: "failed", reason: "operation-failed" },
          ],
          "succeeded",
        ),
      ),
    ).toEqual([
      ["Deals", "done", "Hotovo, verze bbbbbbb"],
      ["Bun", "done", "Stažena verze 1.4.3"],
      [
        "Bun",
        "finding",
        "U některých aplikací se nepodařilo zjistit, jakou verzi potřebují",
      ],
    ]);
  });

  test("the real job answer of a run whose moved module's pin cannot be read shows a finding, never a clean update", async () => {
    // The composition of `lazurio update` as the Launchpad runs it: Deals
    // moved, its app's pin could not be read and nobody opened it, so no
    // build line warns either.
    const jobs = createUpdateJobs({
      run: (onChange) =>
        updateEverything(
          {
            content: async () => ({
              kind: "content-sync",
              at: "2026-10-25T12:00:00.000Z",
              organizations: ["Example"],
              entries: [
                {
                  organization: "Example",
                  root: "organizations/example_GEN3",
                  path: "workspace/deals",
                  kind: "module",
                  branch: "main",
                  result: "fast-forwarded",
                  from: sha("a"),
                  to: sha("b"),
                  at: "2026-10-25T12:00:00.000Z",
                },
              ],
            }),
            tools: {
              pins: async () => ({ pins: [], unreadable: 1 }),
              resolve: async () => {
                throw new Error("Not asked");
              },
            },
            builds: async () => [],
            product: async () => ({
              part: "product",
              result: "current",
              version: "0.1.12",
            }),
          },
          onChange,
        ),
    });
    jobs.start();
    await jobs.settled();
    // As `GET /api/update/everything` sends it.
    const answer = JSON.parse(
      JSON.stringify({ kind: "update-everything", job: jobs.latest() }),
    );
    const read = parseUpdateJob(answer);
    if (read === null || read === undefined) throw new Error("No job read");
    expect(rows(read)).toEqual([
      ["Deals", "done", "Hotovo, verze bbbbbbb"],
      [
        "Bun",
        "finding",
        "U některých aplikací se nepodařilo zjistit, jakou verzi potřebují",
      ],
      ["Lazurio", "current", "Aktuální, verze 0.1.12"],
    ]);
    expect(rows(read, en)[1]).toEqual([
      "Bun",
      "finding",
      "For some apps, the version they need could not be determined",
    ]);
  });

  test("a Bun that could not be had in plain words, never a code: offline and not tried, a download that did not verify, a full disk, anything else", () => {
    const bun = (line: Record<string, unknown>, copy = cs) =>
      updateView(
        job(
          [{ part: "tools", packageManager: "bun@1.4.3", ...line }],
          "succeeded",
        ),
        catalog,
        copy,
      ).rows.map((row) => [row.name, row.state, row.text]);
    const offline = [
      "Bun",
      "finding",
      "Verzi 1.4.3 se teď nepodařilo stáhnout; zkuste to za chvíli znovu",
    ];
    expect(bun({ result: "refused", reason: "runtime-unavailable" })).toEqual([
      offline,
    ]);
    expect(
      bun({ result: "not-fetched", reason: "runtime-unavailable" }),
    ).toEqual([offline]);
    expect(
      bun({
        result: "refused",
        reason: "runtime-integrity-failed",
        warning: true,
      }),
    ).toEqual([
      [
        "Bun",
        "finding",
        "Stažená verze 1.4.3 neprošla kontrolou, a tak se nepoužije",
      ],
    ]);
    expect(bun({ result: "refused", reason: "runtime-disk-full" }, en)).toEqual(
      [["Bun", "finding", "There is no room on the disk for version 1.4.3"]],
    );
    for (const reason of [
      "runtime-version-unknown",
      "runtime-unsupported-platform",
      "operation-failed",
    ])
      expect(bun({ result: "refused", reason })).toEqual([
        ["Bun", "finding", "Verzi 1.4.3 se nepodařilo připravit"],
      ]);
    for (const copy of [cs, en])
      for (const sentence of [
        copy.updateBunFetching,
        copy.updateBunFetched,
        copy.updateBunOffline,
        copy.updateBunTampered,
        copy.updateBunDiskFull,
        copy.updateBunFailed,
      ]) {
        expect(sentence).toContain("{version}");
        expect(sentence).not.toMatch(/[a-z]+-[a-z]+|\//);
      }
    for (const copy of [cs, en])
      expect(copy.updateBunUnknown).not.toMatch(/[a-z]+-[a-z]+|\/|\{/);
  });
});

// ---- Disk and processor (F47 point 7, its addendum of 2026-11-12) ----------

describe("the disk and the processor of Přehled", () => {
  const cs = newTabCopy("cs");
  const en = newTabCopy("en");
  const GiB = 1024 * 1024 * 1024;
  const disk = (total: number, free: number) => ({
    total: total * GiB,
    used: (total - free) * GiB,
    free: free * GiB,
  });

  test("a disk warns under 15 % or 8 GiB free and is bad under 5 % or 2 GiB, whichever comes first", () => {
    const tones = (total: number, frees: number[]) =>
      frees.map((free) => diskTone(disk(total, free)));
    // 60 GB, one slot: the share comes first.
    expect(tones(60, [30, 9.1, 8.9, 3.1, 2.9, 0])).toEqual([
      "ok",
      "ok",
      "warn",
      "warn",
      "bad",
      "bad",
    ]);
    // A big disk by its share too, with 8 GiB and 2 GiB far below.
    expect(tones(1000, [200, 140, 49])).toEqual(["ok", "warn", "bad"]);
    // A small one by its gigabytes.
    expect(tones(20, [9, 7.9, 1.9])).toEqual(["ok", "warn", "bad"]);
    // The 40 MB that started this.
    expect(
      diskTone({ total: 60 * GiB, used: 60 * GiB, free: 40 * 1024 * 1024 }),
    ).toBe("bad");
  });

  test("a disk's size reads like the memory up to 100 GB, then whole gigabytes and terabytes", () => {
    expect(formatDisk(59.6 * GiB, "cs")).toBe("59,6 GB");
    expect(formatDisk(745.3 * GiB, "cs")).toBe("745 GB");
    expect(formatDisk(1900 * GiB, "cs")).toBe("1,9 TB");
    expect(formatDisk(1900 * GiB, "en")).toBe("1.9 TB");
    expect(formatDisk(40 * 1024 * 1024, "en")).toBe("40 MB");
  });

  test("the disk block: used of total, the bar, Volno, the home folder on a disk of its own, and the hint by its tone", () => {
    expect(diskModel({ ...disk(60, 30), home: null }, cs, "cs")).toEqual({
      title: "Disk Prostředí",
      value: { strong: "30 GB", rest: "z 60 GB", title: null },
      percent: 50,
      tone: "ok",
      parts: [{ text: "Volno 30 GB", title: cs.diskFreeTitle }],
      hint: null,
    });
    const warn = diskModel({ ...disk(60, 6), home: null }, en, "en");
    expect(warn).toMatchObject({
      title: "Environment disk",
      value: { strong: "54 GB", rest: "of 60 GB" },
      percent: 90,
      tone: "warn",
      hint: en.diskHint,
    });
    // The home folder on its own disk: a part, and its tone counts.
    const home = diskModel({ ...disk(60, 30), home: disk(100, 1) }, cs, "cs");
    expect(home?.parts.map((part) => part.text)).toEqual([
      "Volno 30 GB",
      "Domovská složka: volno 1 GB",
    ]);
    expect(home?.tone).toBe("bad");
    expect(home?.hint).toBe(cs.diskFullHint);
    expect(diskModel(null, cs, "cs")).toBeNull();
  });

  test("the processor warns from a 5-minute average of 90 %, never bad, and an unknown average never warns", () => {
    const cpu = (percent: number | null) => ({ percent, cores: 4, load: 1 });
    expect([0, 89, 90, 100].map((percent) => cpuTone(cpu(percent)))).toEqual([
      "ok",
      "ok",
      "warn",
      "warn",
    ]);
    expect(cpuTone(cpu(null))).toBe("ok");
  });

  test("the processor block: its 5-minute average said as such, its cores, and the hint", () => {
    expect(cpuModel({ percent: 23, cores: 4, load: 0.8 }, cs)).toEqual({
      title: "Procesor Prostředí",
      value: {
        strong: "23 %",
        rest: "průměr za 5 min",
        title:
          "Zátěž procesoru za posledních 5 minut vůči počtu jader. Je to vážený průměr a počítá i úlohy, které čekají na disk.",
      },
      percent: 23,
      tone: "ok",
      parts: [{ text: "4 jádra", title: null }],
      hint: null,
    });
    expect(cpuModel({ percent: 97, cores: 8, load: 9.1 }, en)).toMatchObject({
      title: "Environment CPU",
      value: { strong: "97%", rest: "5-min average" },
      tone: "warn",
      parts: [{ text: "8 cores" }],
      hint: en.cpuHint,
    });
    // Only the cores known: no value, no bar.
    expect(cpuModel({ percent: null, cores: 2, load: null }, cs)).toMatchObject(
      {
        value: { strong: "", rest: null },
        percent: null,
        parts: [{ text: "2 jádra" }],
      },
    );
    expect(cpuModel({ percent: null, cores: null, load: 1 }, cs)).toBeNull();
    expect(cpuModel(null, cs)).toBeNull();
    expect([1, 2, 4, 5, 24].map((n) => coresText(n, cs))).toEqual([
      "1 jádro",
      "2 jádra",
      "4 jádra",
      "5 jader",
      "24 jader",
    ]);
    expect([1, 2].map((n) => coresText(n, en))).toEqual(["1 core", "2 cores"]);
  });

  test("the answer's disk and processor are read field by field; anything else, or none at all, is unknown", () => {
    const memory = {
      total: 8 * GiB,
      used: 4 * GiB,
      browser: null,
      core: { launchpad: null, t3code: null },
      modules: 0,
      rest: null,
    };
    const read = (extra: Record<string, unknown>) =>
      parseOverview({
        hub: "connected",
        tabs: [],
        memory,
        modules: [],
        ...extra,
      });
    expect(
      read({
        disk: { ...disk(60, 30), home: disk(100, 50) },
        cpu: { percent: 23.4, cores: 4, load: 0.8 },
      }),
    ).toMatchObject({
      disk: { ...disk(60, 30), home: disk(100, 50) },
      cpu: { percent: 23, cores: 4, load: 0.8 },
    });
    // A Launchpad that does not read them, and values of another shape.
    expect(read({})).toMatchObject({ disk: null, cpu: null });
    expect(
      read({
        disk: { total: 0, used: 0, free: 0 },
        cpu: { percent: "a lot", cores: 0, load: -1 },
      }),
    ).toMatchObject({ disk: null, cpu: null });
    expect(
      read({
        disk: { ...disk(60, 30), home: "elsewhere" },
        cpu: { cores: 4.5, percent: 130 },
      }),
    ).toMatchObject({
      disk: { home: null },
      cpu: { percent: 100, cores: null, load: null },
    });
  });
});
