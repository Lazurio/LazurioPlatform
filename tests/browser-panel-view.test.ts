import { describe, expect, test } from "bun:test";
import {
  browserEntryOf,
  browserViewUrl,
  resolveBrowserView,
} from "../src/browser/view";
import {
  browserFrame,
  browserHandOverPath,
  browserPanelOrigin,
  browserViewAddress,
  browserViewDocumentPath,
  emptyStrip,
  panelChoice,
  reduceStrip,
  type StripEvent,
  type StripState,
  type StripTab,
  shownEntry,
  stripEntries,
  stripEveryMs,
  stripTabs,
  tabViewAddress,
  viewMessage,
  viewTabOf,
} from "../src/launchpad/browser-panel-view";
import { publicEntry } from "../src/launchpad/chat";
import { parseEntryAnswer } from "../src/launchpad/chat-view";
import { parseOverview } from "../src/launchpad/new-tab-view";
import {
  browserViewDocumentPath as serverDocumentPath,
  browserViewPath as serverHandOverPath,
} from "../src/launchpad/server";
import { bindings } from "./fixtures/machine-bindings";

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207; decision F47 point 9): offered only
// where the recorded entry routes the Environment browser's view, never on a
// workstation or in Recovery mode. Its strip lists every tab of the
// Environment from Nová karta's overview, "+" shows Nová karta, the first
// opening and the close of the last tab show it too, and a tab's view is
// framed only on exactly the recorded origin. What the view frame and Nová
// karta say is heard only from them. The DOM (browser-panel.ts) only draws
// this.

const origin = "https://browser.workspace.example.lazurio.io";
const page = "https://launchpad.workspace.example.lazurio.io";
const target = "0123456789ABCDEF".repeat(2);
const view = browserViewUrl(origin, null);

// The page's view of the recorded entry, as the server projects it and the
// page parses `GET /api/entry`.
const entryOf = (binding: { entry?: Parameters<typeof publicEntry>[0] }) =>
  parseEntryAnswer({
    kind: "entry",
    entry: publicEntry(binding.entry ?? null),
  });

test("offered only where the recorded entry routes the view: never on a workstation, without the browser's route, or in Recovery mode", () => {
  const withView = entryOf(bindings.organizationBrowser);
  expect(withView?.browserOrigin).toBe(origin);
  expect(browserPanelOrigin(withView, false)).toBe(origin);
  // The personal and the Team Environment the same way.
  expect(browserPanelOrigin(entryOf(bindings.personalBrowser), false)).toBe(
    "https://browser.example.lazurio.io",
  );
  expect(browserPanelOrigin(entryOf(bindings.teamBrowser), false)).toBe(origin);
  // An entry whose gateway routes no view, a workstation (no entry), and
  // Recovery mode.
  const withoutView = entryOf(bindings.organizationEntry);
  expect(withoutView).not.toBeNull();
  expect(browserPanelOrigin(withoutView, false)).toBeNull();
  expect(
    browserPanelOrigin(parseEntryAnswer({ kind: "entry", entry: null }), false),
  ).toBeNull();
  expect(browserPanelOrigin(withView, true)).toBeNull();
  // An entry whose browser origin is not an https origin is no entry at all.
  expect(
    parseEntryAnswer({
      kind: "entry",
      entry: {
        ...withView,
        browserOrigin: "http://browser.example.lazurio.io",
      },
    }),
  ).toBeNull();
});

test("the view only as an https URL on exactly the recorded origin, as written: the server's own answers pass, nothing else does", async () => {
  // What the server answers for the panel (no session: a new tab) and for a
  // thread's link (a session's tab): both are the view.
  expect(browserViewAddress({ available: true, view }, origin, page)).toBe(
    view,
  );
  const windowView = browserViewUrl(origin, target);
  expect(
    browserViewAddress(
      { available: true, view: windowView, session: "t3-a" },
      origin,
      page,
    ),
  ).toBe(windowView);
  // The server's resolution itself, from the fixture's recorded entry.
  const entry = browserEntryOf(bindings.organizationBrowser.entry);
  const answer = await resolveBrowserView(entry, null, {
    openWindow: async () => ({ targetId: target }),
  });
  expect(browserViewAddress(answer, origin, page)).toBe(view);

  for (const refused of [
    null,
    "view",
    [view],
    {},
    { available: false, reason: "not-declared" },
    { available: "true", view },
    { available: true },
    { available: true, view: 42 },
    { available: true, view: "/.lazurio/browser" },
    { available: true, view: "javascript:alert(1)" },
    // Not https, another origin, a sibling app, a port, credentials.
    { available: true, view: view.replace("https:", "http:") },
    { available: true, view: "https://elsewhere.example/" },
    { available: true, view: `${page}/` },
    { available: true, view: view.replace(origin, `${origin}:8443`) },
    { available: true, view: view.replace("https://", "https://user:secret@") },
    // Not as written: the browser would read another address.
    { available: true, view: view.replace("browser.", "BROWSER.") },
    { available: true, view: ` ${view}` },
  ])
    expect(browserViewAddress(refused, origin, page)).toBeNull();
  // Never a frame on the page's own origin, even where it is recorded so:
  // the sandbox keeps the view apart only while it is another origin.
  expect(
    browserViewAddress({ available: true, view }, origin, origin),
  ).toBeNull();
});

test("the panel and the server name the same two routes, and a tab's frame keeps the view's attributes", () => {
  expect(browserViewDocumentPath).toBe(serverDocumentPath);
  expect(browserHandOverPath).toBe(serverHandOverPath);
  // The sandbox of T3 Code's panel (Lazurio/t3code#41): the view keeps its
  // own origin, cookie and scripts, and cannot navigate this page.
  expect(browserFrame).toEqual({
    allow: "clipboard-read; clipboard-write; fullscreen",
    referrerpolicy: "no-referrer",
    sandbox:
      "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals",
  });
  expect(stripEveryMs).toBe(5_000);
});

const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");

test("a tab's frame is its view on exactly the recorded origin; a view address names its tab only there", () => {
  expect(tabViewAddress(origin, target, page)).toBe(`${origin}/t/${target}`);
  expect(tabViewAddress(origin, target.toLowerCase(), page)).toBe(
    `${origin}/t/${target}`,
  );
  for (const tab of ["", "not-a-tab", `${target}0`, "../t"])
    expect(tabViewAddress(origin, tab, page)).toBeNull();
  // Never a frame on the page's own origin.
  expect(tabViewAddress(origin, target, origin)).toBeNull();

  expect(viewTabOf(`${origin}/t/${target.toLowerCase()}`, origin)).toBe(target);
  expect(viewTabOf(`${origin}/t/${target}?from=link`, origin)).toBe(target);
  for (const address of [
    `${origin}/`,
    `${origin}/t/${target}/extra`,
    `https://browser.vm-02.example.lazurio.io/t/${target}`,
    `${origin.replace("https://", "https://a:b@")}/t/${target}`,
    `${origin}/t/${target}#${"x".repeat(512)}`,
    42,
    null,
  ])
    expect(viewTabOf(address, origin)).toBeNull();
});

// The strip: one tab as the overview lists it, and the panel's state after
// a run of events.
const listedTab = (n: number, extra: Partial<StripTab> = {}): StripTab => ({
  id: id(n),
  title: `Stránka ${n}`,
  url: `https://site-${n}.example.com/`,
  favicon: null,
  agents: [],
  holders: [],
  closing: false,
  ...extra,
});
const run = (events: readonly StripEvent[], from: StripState = emptyStrip) =>
  events.reduce(reduceStrip, from);
const keys = (state: StripState) =>
  stripEntries(state).map((entry) => (entry.kind === "new" ? "new" : entry.id));
const shown = (state: StripState) => {
  const entry = shownEntry(state);
  return entry.kind === "new" ? "new" : entry.id;
};
/** The panel opened and its first overview listed `tabs`. */
const openWith = (tabs: readonly StripTab[]) =>
  run([
    { kind: "opened" },
    { kind: "requested" },
    { kind: "listed", request: 1, tabs },
  ]);

describe("the strip (decision F47 point 9)", () => {
  test("the first opening shows Nová karta; before any list the strip is Nová karta alone, with no ×", () => {
    const opened = run([{ kind: "opened" }]);
    expect(stripEntries(opened)).toEqual([{ kind: "new", closable: false }]);
    expect(shown(opened)).toBe("new");
    // Opened again later, it shows what it showed.
    const later = run(
      [{ kind: "select", entry: id(2) }, { kind: "opened" }],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect(shown(later)).toBe(id(2));
  });

  test("every tab of the Environment in the hub's order, then Nová karta; a tab whose close counts down is not listed", () => {
    const state = openWith([
      listedTab(1, {
        agents: ["codex-a1"],
        favicon: "https://a.example/i.png",
      }),
      listedTab(2),
      listedTab(3, { closing: true }),
    ]);
    expect(keys(state)).toEqual([id(1), id(2), "new"]);
    expect(stripEntries(state)[0]).toMatchObject({
      kind: "tab",
      title: "Stránka 1",
      favicon: "https://a.example/i.png",
      working: true,
    });
    expect(stripEntries(state).at(-1)).toEqual({ kind: "new", closable: true });
    expect(shown(state)).toBe("new");
    // While the hub does not answer, the strip stays as it was.
    expect(
      run(
        [{ kind: "requested" }, { kind: "listed", request: 2, tabs: null }],
        state,
      ),
    ).toMatchObject({ listed: state.listed, overrides: state.overrides });
    expect(stripTabs(null)).toBeNull();
    expect(
      stripTabs(
        parseOverview({
          hub: "unreachable",
          tabs: null,
          memory: {},
          modules: null,
        }),
      ),
    ).toBeNull();
  });

  test("+ shows a fresh Nová karta; what is chosen in it shows, and Nová karta goes from the strip", () => {
    const state = openWith([listedTab(1), listedTab(2)]);
    const selected = run([{ kind: "select", entry: id(1) }], state);
    expect(shown(selected)).toBe(id(1));
    const fresh = run([{ kind: "new-tab" }], selected);
    expect([shown(fresh), fresh.generation]).toEqual(["new", 1]);
    const chosen = run([{ kind: "chosen", tab: id(2) }], fresh);
    expect([keys(chosen), shown(chosen)]).toEqual([[id(1), id(2)], id(2)]);
    // A page just opened shows before the overview lists it, after the
    // listed tabs; an overview begun before it does not drop it.
    const opened = run(
      [
        { kind: "requested" },
        { kind: "new-tab" },
        { kind: "chosen", tab: id(9) },
        { kind: "listed", request: 2, tabs: [listedTab(1), listedTab(2)] },
      ],
      chosen,
    );
    expect([keys(opened), shown(opened)]).toEqual([
      [id(1), id(2), id(9)],
      id(9),
    ]);
    expect(stripEntries(opened)[2]).toMatchObject({ tab: null, title: "" });
  });

  test("× closes for everyone: the tab goes at once, the shown one falls to the tab that took its place or the one before it, and after the last Nová karta shows", () => {
    const state = run(
      [{ kind: "chosen", tab: id(3) }],
      openWith([listedTab(1), listedTab(2), listedTab(3)]),
    );
    const third = run([{ kind: "closing", tab: id(3) }], state);
    expect([keys(third), shown(third)]).toEqual([[id(1), id(2)], id(2)]);
    const first = run(
      [
        { kind: "select", entry: id(1) },
        { kind: "closing", tab: id(1) },
      ],
      third,
    );
    expect([keys(first), shown(first)]).toEqual([[id(2)], id(2)]);
    const none = run([{ kind: "closing", tab: id(2) }], first);
    expect([stripEntries(none), shown(none)]).toEqual([
      [{ kind: "new", closable: false }],
      "new",
    ]);
    // With Nová karta in the strip, it takes the place of a closed tab.
    const beside = run(
      [
        { kind: "new-tab" },
        { kind: "select", entry: id(2) },
        { kind: "closing", tab: id(2) },
      ],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect([keys(beside), shown(beside)]).toEqual([[id(1), "new"], "new"]);
  });

  test("an overview begun before a close does not bring the tab back; a later one is the hub's word", () => {
    const state = run(
      [
        { kind: "requested" },
        { kind: "closing", tab: id(1) },
        { kind: "listed", request: 2, tabs: [listedTab(1), listedTab(2)] },
      ],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect(keys(state)).toEqual([id(2), "new"]);
    const later = run(
      [
        { kind: "requested" },
        {
          kind: "listed",
          request: 3,
          tabs: [listedTab(1, { closing: true }), listedTab(2)],
        },
      ],
      state,
    );
    expect([keys(later), later.overrides]).toEqual([[id(2), "new"], []]);
    // A close that failed puts the tab back.
    const failed = run(
      [
        { kind: "closing", tab: id(2) },
        { kind: "close-failed", tab: id(2) },
      ],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect(keys(failed)).toEqual([id(1), id(2), "new"]);
  });

  test("Vrátit brings the tab back, shown again where it was shown when closed, while an older overview still says it closes", () => {
    const closed = run(
      [
        { kind: "chosen", tab: id(2) },
        { kind: "closing", tab: id(2) },
        {
          kind: "listed",
          request: 1,
          tabs: [listedTab(1), listedTab(2, { closing: true })],
        },
      ],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect([keys(closed), shown(closed)]).toEqual([[id(1)], id(1)]);
    const back = run([{ kind: "restored", tab: id(2), show: true }], closed);
    expect([keys(back), shown(back)]).toEqual([[id(1), id(2)], id(2)]);
    const quiet = run([{ kind: "restored", tab: id(2), show: false }], closed);
    expect([keys(quiet), shown(quiet)]).toEqual([[id(1), id(2)], id(1)]);
  });

  test("the view's tab ended: it goes, and the panel falls back; × on Nová karta among tabs shows the tab before it", () => {
    const ended = run(
      [
        { kind: "chosen", tab: id(1) },
        { kind: "ended", tab: id(1) },
      ],
      openWith([listedTab(1)]),
    );
    expect([stripEntries(ended), shown(ended)]).toEqual([
      [{ kind: "new", closable: false }],
      "new",
    ]);
    const closedNew = run(
      [{ kind: "close-new-tab" }],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect([keys(closedNew), shown(closedNew)]).toEqual([
      [id(1), id(2)],
      id(2),
    ]);
    // Alone, Nová karta stays: the strip is never empty.
    const alone = run([{ kind: "opened" }, { kind: "close-new-tab" }]);
    expect([keys(alone), shown(alone)]).toEqual([["new"], "new"]);
  });

  test("a page's new tab viewed here shows at once with its address, its title follows the view, and the overview takes over", () => {
    const state = run(
      [
        { kind: "show", tab: id(9), url: "https://accounts.example.com/" },
        {
          kind: "info",
          tab: id(9),
          title: "Přihlášení",
          url: "https://accounts.example.com/signin",
        },
      ],
      openWith([listedTab(1)]),
    );
    expect(shown(state)).toBe(id(9));
    expect(stripEntries(state)[1]).toMatchObject({
      kind: "tab",
      id: id(9),
      title: "Přihlášení",
      url: "https://accounts.example.com/signin",
      tab: null,
    });
    const listed = run(
      [
        { kind: "requested" },
        {
          kind: "listed",
          request: 2,
          tabs: [listedTab(1), listedTab(9, { title: "Sign in" })],
        },
      ],
      state,
    );
    expect(stripEntries(listed)[1]).toMatchObject({
      id: id(9),
      title: "Sign in",
      tab: { id: id(9) },
    });
    expect([listed.live, listed.overrides]).toEqual([[], []]);
  });
});

describe("what the frames say", () => {
  const event = (data: unknown, extra = {}) => ({
    data,
    origin,
    fromFrame: true,
    ...extra,
  });
  const at = `${origin}/t/${target}`;

  test("the view frame: a page's new tab, its tab's end and where it is, only from that frame on the view's origin", () => {
    expect(
      viewMessage(
        event({
          type: "lazurio-browser:new-tab",
          view: `${origin}/t/${id(9)}`,
          url: "https://accounts.example.com/",
        }),
        origin,
      ),
    ).toEqual({
      kind: "new-tab",
      tab: id(9),
      url: "https://accounts.example.com/",
    });
    expect(
      viewMessage(event({ type: "lazurio-browser:closed", view: at }), origin),
    ).toEqual({ kind: "closed", tab: target });
    expect(
      viewMessage(
        event({
          type: "lazurio-browser:info",
          view: at,
          title: "Faktury",
          url: "x".repeat(3_000),
        }),
        origin,
      ),
    ).toEqual({
      kind: "info",
      tab: target,
      title: "Faktury",
      url: "x".repeat(2_048),
    });
    const closed = { type: "lazurio-browser:closed", view: at };
    for (const [data, extra, viewOrigin] of [
      [closed, { fromFrame: false }, origin],
      [closed, { origin: page }, origin],
      [closed, {}, null],
      [
        {
          ...closed,
          view: `https://browser.vm-02.example.lazurio.io/t/${target}`,
        },
        {},
        origin,
      ],
      [{ ...closed, view: `${origin}/` }, {}, origin],
      [{ ...closed, type: "lazurio-browser:navigate" }, {}, origin],
      [{ type: "lazurio-browser:new-tab", view: at }, {}, origin],
      [
        { type: "lazurio-browser:info", view: at, url: "https://a.example/" },
        {},
        origin,
      ],
      ["lazurio-browser:closed", {}, origin],
      [[closed], {}, origin],
    ] as const)
      expect(viewMessage(event(data, extra), viewOrigin)).toBeNull();
  });

  test("Nová karta's choice in the Launchpad: a page or a tab shows that tab, framed on the recorded origin; the Launchpad has no tools, and anything else is nothing", () => {
    for (const kind of ["page", "tab"])
      expect(panelChoice({ kind, tab: target.toLowerCase(), view: at })).toBe(
        target,
      );
    // Only the tab is taken: its frame is the recorded view's, whatever
    // address the choice carried.
    const elsewhere = panelChoice({
      kind: "tab",
      tab: target,
      view: `https://elsewhere.example/t/${target}`,
    });
    expect(elsewhere).toBe(target);
    expect(tabViewAddress(origin, elsewhere ?? "", page)).toBe(at);
    for (const detail of [
      { kind: "tool", id: "terminal" },
      { kind: "link", tab: target },
      { kind: "tab", tab: target },
      null,
      "tab",
    ])
      expect(panelChoice(detail)).toBeNull();
  });
});
