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
  heldByLaunchpad,
  holdFailure,
  holdSucceeded,
  panelChoice,
  reduceStrip,
  releaseSucceeded,
  releaseText,
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
import { newTabCopy, parseOverview } from "../src/launchpad/new-tab-view";
import {
  browserViewDocumentPath as serverDocumentPath,
  browserViewPath as serverHandOverPath,
} from "../src/launchpad/server";
import { bindings } from "./fixtures/machine-bindings";

const cs = newTabCopy("cs");
const en = newTabCopy("en");

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207; decision F47 point 9 and its addendum
// of 2026-10-12): offered only where the recorded entry routes the
// Environment browser's view, never on a workstation or in Recovery mode. Its
// strip lists the tabs the Launchpad holds, from Nová karta's overview; "+"
// shows Nová karta, as do the first opening and the strip once its last tab
// goes; × lets go of the Launchpad's hold with Vrátit; a tab shows here only
// once the Launchpad holds it; a view is framed only on exactly the recorded
// origin. What the view frame and Nová karta say is heard only from them.
// The DOM (browser-panel.ts) only draws this.

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

// The strip: one tab as the overview lists it, held by the Launchpad unless
// said otherwise, and the panel's state after a run of events.
const launchpad = { strip: "launchpad", label: "Launchpad" };
const listedTab = (n: number, extra: Partial<StripTab> = {}): StripTab => ({
  id: id(n),
  title: `Stránka ${n}`,
  url: `https://site-${n}.example.com/`,
  favicon: null,
  agents: [],
  holders: [launchpad],
  closing: false,
  ...extra,
});
/** A tab of the Environment the Launchpad does not hold. */
const otherTab = (n: number, extra: Partial<StripTab> = {}) =>
  listedTab(n, { holders: [], ...extra });
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
/** The next overview, requested and answered with `tabs`. */
const relist = (state: StripState, tabs: readonly StripTab[]) =>
  run(
    [
      { kind: "requested" },
      { kind: "listed", request: state.requests + 1, tabs },
    ],
    state,
  );

describe("the strip (decision F47 point 9 and its addendum of 2026-10-12)", () => {
  test("the strip shows the tabs the Launchpad holds, in the order it first had them; every other tab is in Přehled only", () => {
    const state = openWith([
      otherTab(1, { agents: ["codex-a1"] }),
      listedTab(2, { favicon: "https://a.example/i.png", agents: ["t3-x"] }),
      otherTab(3, { holders: [{ strip: "t3-x", label: "Vlákno" }] }),
      listedTab(4),
    ]);
    expect(keys(state)).toEqual([id(2), id(4), "new"]);
    expect(stripEntries(state)[0]).toMatchObject({
      kind: "tab",
      title: "Stránka 2",
      favicon: "https://a.example/i.png",
      working: true,
    });
    expect(heldByLaunchpad(listedTab(2))).toBe(true);
    expect(heldByLaunchpad(otherTab(1))).toBe(false);
    // The hub's order changes, the strip's does not; a tab held later
    // comes last.
    const later = relist(state, [listedTab(5), listedTab(4), listedTab(2)]);
    expect(keys(later)).toEqual([id(2), id(4), id(5), "new"]);
    // A tab whose close for everyone counts down leaves the strip.
    expect(
      keys(relist(later, [listedTab(2), listedTab(4, { closing: true })])),
    ).toEqual([id(2), "new"]);
    // While the hub does not answer, the strip stays as it was.
    expect(
      run(
        [{ kind: "requested" }, { kind: "listed", request: 3, tabs: null }],
        later,
      ),
    ).toMatchObject({ listed: later.listed, overrides: later.overrides });
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

  test("the first opening shows Nová karta, and so does the strip once its last tab goes; before any list the strip is Nová karta alone, with no ×", () => {
    const opened = run([{ kind: "opened" }]);
    expect(stripEntries(opened)).toEqual([{ kind: "new", closable: false }]);
    expect(shown(opened)).toBe("new");
    // The Launchpad holds nothing yet: only Nová karta, whatever Přehled lists.
    expect(stripEntries(openWith([otherTab(1), otherTab(2)]))).toEqual([
      { kind: "new", closable: false },
    ]);
    // Opened again later, it shows what it showed.
    const later = run(
      [{ kind: "select", entry: id(2) }, { kind: "opened" }],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect(shown(later)).toBe(id(2));
    // The strip's last tab ends elsewhere: Nová karta shows.
    const shownTab = run(
      [{ kind: "chosen", tab: id(1) }],
      openWith([listedTab(1)]),
    );
    const emptied = relist(shownTab, [otherTab(1)]);
    expect([stripEntries(emptied), shown(emptied)]).toEqual([
      [{ kind: "new", closable: false }],
      "new",
    ]);
  });

  test("+ shows a fresh Nová karta; what is chosen in it and held shows, and Nová karta goes from the strip", () => {
    const state = openWith([listedTab(1), otherTab(2)]);
    const fresh = run(
      [{ kind: "select", entry: id(1) }, { kind: "new-tab" }],
      state,
    );
    expect([shown(fresh), fresh.generation]).toEqual(["new", 1]);
    // A tab chosen in Přehled, held for the Launchpad, then shown: in the
    // strip before an overview says the Launchpad holds it.
    const chosen = run([{ kind: "chosen", tab: id(2) }], fresh);
    expect([keys(chosen), shown(chosen)]).toEqual([[id(1), id(2)], id(2)]);
    // An overview begun before the hold, which does not have it yet, does
    // not take it away; the next one says the Launchpad holds it.
    const before = run(
      [{ kind: "listed", request: 1, tabs: [listedTab(1), otherTab(2)] }],
      chosen,
    );
    expect(keys(before)).toEqual([id(1), id(2)]);
    const after = relist(before, [listedTab(1), listedTab(2)]);
    expect([keys(after), after.overrides]).toEqual([[id(1), id(2)], []]);
    // A page just opened shows before the overview lists it at all.
    const opened = run(
      [{ kind: "new-tab" }, { kind: "chosen", tab: id(9) }],
      after,
    );
    expect([keys(opened), shown(opened)]).toEqual([
      [id(1), id(2), id(9)],
      id(9),
    ]);
    expect(stripEntries(opened)[2]).toMatchObject({ tab: null, title: "" });
  });

  test("× lets go: the tab goes at once and stays gone while the release is on its way, even when an overview read before still holds it; only one requested after lifts the hide; a failed release brings it back", () => {
    const state = openWith([listedTab(1), listedTab(2)]);
    // Pablo's reproduction (#324), on the release that × now is: the tab
    // goes, then an overview begun before the release was done still lists
    // the Launchpad's hold.
    const releasing = run([{ kind: "releasing", tab: id(1) }], state);
    expect(keys(releasing)).toEqual([id(2), "new"]);
    const read = relist(releasing, [listedTab(1), listedTab(2)]);
    expect(keys(read)).toEqual([id(2), "new"]);
    expect(read.overrides).toEqual([
      { id: id(1), state: "hidden", after: null },
    ]);
    // Done while the 3rd overview was in flight: its answer still holds the
    // tab and changes nothing; the 4th is the Launchpad's word.
    const inFlight = run([{ kind: "requested" }], read);
    const done = run([{ kind: "released", tab: id(1) }], inFlight);
    const late = run(
      [{ kind: "listed", request: 3, tabs: [listedTab(1), listedTab(2)] }],
      done,
    );
    expect(keys(late)).toEqual([id(2), "new"]);
    const confirmed = relist(late, [otherTab(1), listedTab(2)]);
    expect([keys(confirmed), confirmed.overrides]).toEqual([
      [id(2), "new"],
      [],
    ]);
    // A release that fails brings the tab back at once.
    const failed = run(
      [
        { kind: "releasing", tab: id(2) },
        { kind: "release-failed", tab: id(2) },
      ],
      state,
    );
    expect([keys(failed), failed.overrides]).toEqual([
      [id(1), id(2), "new"],
      [],
    ]);
  });

  test("the shown tab let go falls to the tab that took its place or the one before it, and with the strip empty Nová karta shows", () => {
    const state = run(
      [{ kind: "chosen", tab: id(3) }],
      openWith([listedTab(1), listedTab(2), listedTab(3)]),
    );
    const third = run([{ kind: "releasing", tab: id(3) }], state);
    expect([keys(third), shown(third)]).toEqual([[id(1), id(2)], id(2)]);
    const first = run(
      [
        { kind: "select", entry: id(1) },
        { kind: "releasing", tab: id(1) },
      ],
      third,
    );
    expect([keys(first), shown(first)]).toEqual([[id(2)], id(2)]);
    const none = run([{ kind: "releasing", tab: id(2) }], first);
    expect([stripEntries(none), shown(none)]).toEqual([
      [{ kind: "new", closable: false }],
      "new",
    ]);
  });

  test("Vrátit holds the tab again: back in its place in the strip, and shown again where it was shown when let go", () => {
    const released = run(
      [
        { kind: "chosen", tab: id(2) },
        { kind: "releasing", tab: id(2) },
        { kind: "released", tab: id(2) },
      ],
      openWith([listedTab(1), listedTab(2), listedTab(3)]),
    );
    const settled = relist(released, [listedTab(1), otherTab(2), listedTab(3)]);
    expect([keys(settled), shown(settled)]).toEqual([[id(1), id(3)], id(3)]);
    const back = run([{ kind: "held-again", tab: id(2), show: true }], settled);
    expect([keys(back), shown(back)]).toEqual([[id(1), id(2), id(3)], id(2)]);
    const quiet = run(
      [{ kind: "held-again", tab: id(2), show: false }],
      settled,
    );
    expect([keys(quiet), shown(quiet)]).toEqual([[id(1), id(2), id(3)], id(3)]);
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

  test("a page's new tab held here shows at once with its address, its title follows the view, and the overview takes over", () => {
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
    const listed = relist(state, [
      listedTab(1),
      listedTab(9, { title: "Sign in" }),
    ]);
    expect(stripEntries(listed)[1]).toMatchObject({
      id: id(9),
      title: "Sign in",
      tab: { id: id(9) },
    });
    expect([listed.live, listed.overrides]).toEqual([[], []]);
  });
});

describe("holding and letting go (decision F47 points 4 and 9)", () => {
  const answer = (status: number, value: unknown = null) => ({ status, value });

  test("a hold counts only as 200 {held: true}; one that failed says why, with Zkusit znovu where trying again can help", () => {
    expect(holdSucceeded(answer(200, { held: true }))).toBe(true);
    for (const failed of [
      answer(200, {}),
      answer(200, { held: "true" }),
      answer(201, { held: true }),
      answer(0),
    ])
      expect(holdSucceeded(failed)).toBe(false);
    const cases: readonly [ReturnType<typeof answer>, string, boolean][] = [
      [
        answer(409, { error: "too-many-tabs" }),
        "Launchpad už má tolik záložek, kolik unese. Zavřete některé a zkuste to znovu.",
        true,
      ],
      [
        answer(404, { error: "not-found" }),
        "Záložka už v Environmentu není.",
        false,
      ],
      [
        answer(503, { error: "holder-unavailable" }),
        "Záložku se nepodařilo v Launchpadu ponechat.",
        false,
      ],
      [
        answer(503, { error: "closing" }),
        "Launchpad teď neodpovídá, zkuste to za chvíli znovu.",
        true,
      ],
      [
        answer(503, { error: "hub-unreachable" }),
        "Prohlížeč Environmentu teď neodpovídá, zkuste to za chvíli znovu.",
        true,
      ],
      [
        answer(500, { error: "hold-failed" }),
        "Záložku se nepodařilo v Launchpadu ponechat.",
        true,
      ],
      [answer(0), "Launchpad teď neodpovídá, zkuste to za chvíli znovu.", true],
      [
        answer(404, { error: "no-browser" }),
        "Tento Environment nemá prohlížeč.",
        false,
      ],
    ];
    for (const [failed, text, retry] of cases)
      expect(holdFailure(failed, cs)).toEqual({ text, retry });
    // Vrátit says it in its own words.
    expect(
      holdFailure(answer(404, { error: "not-found" }), cs, cs.restoreFailed),
    ).toEqual({ text: "Záložku už nejde vrátit.", retry: false });
  });

  test("a release counts only as 200 {released: true}; its toast says what happens to the tab, as the overview tells", () => {
    expect(releaseSucceeded(answer(200, { released: true }))).toBe(true);
    for (const failed of [
      answer(200, {}),
      answer(500, { error: "release-failed" }),
    ])
      expect(releaseSucceeded(failed)).toBe(false);
    expect(releaseText(listedTab(1), cs)).toBe(
      "Záložka se zavře v Environmentu.",
    );
    expect(releaseText(null, cs)).toBe("Záložka se zavře v Environmentu.");
    expect(releaseText(listedTab(1, { agents: ["codex-a1"] }), cs)).toBe(
      "Záložka zmizela z Launchpadu. Pracuje v ní agent, takže zůstává otevřená.",
    );
    expect(
      releaseText(
        listedTab(1, {
          holders: [
            launchpad,
            { strip: "t3-x", label: "Faktury za září" },
            { strip: "t3-y", label: "" },
            { strip: "bot-z", label: "Bot" },
          ],
        }),
        cs,
      ),
    ).toBe(
      "Záložka zmizela z Launchpadu. Dál je ve vlákně „Faktury za září“, v jiném vlákně a jinde.",
    );
    expect(
      releaseText(
        listedTab(1, { holders: [{ strip: "t3-x", label: "Invoices" }] }),
        en,
      ),
    ).toBe("The tab left the Launchpad. It stays in the thread “Invoices”.");
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

  test("Nová karta's choice in the Launchpad: a page it opened or a tab it chose, framed on the recorded origin; the Launchpad has no tools, and anything else is nothing", () => {
    for (const kind of ["page", "tab"] as const)
      expect(
        panelChoice({ kind, tab: target.toLowerCase(), view: at }),
      ).toEqual({ kind, tab: target });
    // Only the tab is taken: its frame is the recorded view's, whatever
    // address the choice carried.
    const elsewhere = panelChoice({
      kind: "tab",
      tab: target,
      view: `https://elsewhere.example/t/${target}`,
    });
    expect(elsewhere).toEqual({ kind: "tab", tab: target });
    expect(tabViewAddress(origin, elsewhere?.tab ?? "", page)).toBe(at);
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
