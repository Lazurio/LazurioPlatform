import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserViewDocumentPath } from "../src/browser/contract/platform";
import {
  acceptViewMessage,
  browserTimes,
  browserViewUrl,
  viewFrameAttributes,
} from "../src/browser/contract/pure";
import { browserEntryOf, resolveBrowserView } from "../src/browser/view";
import {
  browserPanelOrigin,
  browserViewAddress,
  type CloseCommand,
  closedBy,
  closesPanel,
  emptyStrip,
  entryKey,
  heldByLaunchpad,
  holdFailure,
  holdSucceeded,
  letGoUndo,
  letGoUndoUntil,
  panelChoice,
  reduceStrip,
  releaseFailure,
  releaseSucceeded,
  releaseText,
  restoreFailure,
  type StripEvent,
  type StripState,
  type StripTab,
  shownEntry,
  stripEntries,
  stripTabs,
  type TabMenu,
  tabMenu,
  tabMenuLabels,
  tabViewAddress,
  viewTabOf,
} from "../src/launchpad/browser-panel-view";
import { publicEntry } from "../src/launchpad/chat";
import { parseEntryAnswer } from "../src/launchpad/chat-view";
import { messages } from "../src/launchpad/messages";
import { newTabCopy, parseOverview } from "../src/launchpad/new-tab-view";
import { newTabFrameSandbox } from "../src/shell/new-tab-element";
import { bindings } from "./fixtures/machine-bindings";

const cs = newTabCopy("cs");
const en = newTabCopy("en");

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207; decision F47 point 9, its addendum
// of 2026-10-12 and Matěj's tuning of the same day): offered only where the
// recorded entry routes the Environment browser's view, never on a
// workstation or in Recovery mode. Its strip lists the tabs the Launchpad
// holds, from Nová karta's overview, then its Nová karta entries; "+" adds
// another, and opening the panel on an empty strip shows one; × on a tab lets
// go of the Launchpad's hold with Vrátit, × on a Nová karta takes it away,
// and the person's × on the last entry closes the panel; a tab shows here
// only once the Launchpad holds it; a view is framed only on exactly the
// recorded origin. What the view frame and Nová karta say is heard only from
// them. The DOM (browser-panel.ts) only draws this.

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

test("a view address is a tab only in the contract's form: no query, no slash after the id; its id in either case (decision F50 point 2)", () => {
  for (const address of [
    `${origin}/t/${target}?x=1`,
    `${origin}/t/${target}?`,
    `${origin}/t/${target}/`,
    `${origin}/T/${target}`,
  ])
    expect(viewTabOf(address, origin)).toBeNull();
  // So the view frame's messages about such an address are nothing, and a
  // message about a lower-case id names the tab in upper case.
  const closed = (view: string) =>
    acceptViewMessage(
      {
        data: { type: "lazurio-browser:closed", view },
        origin,
        fromFrame: true,
      },
      origin,
    );
  expect(closed(`${origin}/t/${target}?x=1`)).toBeNull();
  expect(closed(`${origin}/t/${target.toLowerCase()}`)).toEqual({
    kind: "closed",
    tab: target,
  });
  // The server's answer is a view: a tab's or the bare origin, never another
  // address on the view's origin.
  for (const view of [`${origin}/elsewhere`, `${origin}/t/${target}/`])
    expect(
      browserViewAddress({ available: true, view }, origin, page),
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

test("the panel and the server name the same route, and a tab's frame keeps the view's attributes", () => {
  // The view's address for a new tab, one definition for the route and the
  // panel (the contract's C12); since the strip lost its link (2026-10-13)
  // the panel no longer uses the server's hand-over.
  expect(browserViewDocumentPath).toBe("/.lazurio/browser.json");
  // The sandbox of T3 Code's panel (Lazurio/t3code#41): the view keeps its
  // own origin, cookie and scripts, and cannot navigate this page. Since
  // 2026-10-13 a tab the view opens escapes it, as a tab opened from Nová
  // karta's frame does: the view's own "Otevřít samostatně" is an ordinary
  // tab of the person's browser, not a sandboxed one. One set of frame
  // attributes for every app (F50 point 2), whose referrer names the
  // Launchpad's origin, by which another Environment's view admits it.
  expect(viewFrameAttributes).toEqual({
    allow: "clipboard-read; clipboard-write; fullscreen",
    referrerpolicy: "origin",
    sandbox:
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
  });
  expect(newTabFrameSandbox.split(" ")).toContain(
    "allow-popups-to-escape-sandbox",
  );
  // Nothing that would let the view navigate the Launchpad or run outside
  // its own origin's rules comes with it.
  for (const token of [
    "allow-top-navigation",
    "allow-top-navigation-by-user-activation",
    "allow-top-navigation-to-custom-protocols",
  ])
    expect(viewFrameAttributes.sandbox.split(" ")).not.toContain(token);
  expect(browserTimes.overviewEveryMs).toBe(5_000);
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

  expect(viewTabOf(`${origin}/t/${target}`, origin)).toBe(target);
  // A view address names its tab in the contract's form (decision F50 point
  // 2): its id in either case, as before, but no longer with a query, which
  // this reader took before.
  expect(viewTabOf(`${origin}/t/${target.toLowerCase()}`, origin)).toBe(target);
  expect(viewTabOf(`${origin}/t/${target}?from=link`, origin)).toBeNull();
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
/** The strip's entries by key: a tab's id, a Nová karta's `new-<n>`. */
const keys = (state: StripState) => stripEntries(state).map(entryKey);
const shown = (state: StripState) => {
  const entry = shownEntry(state);
  return entry === null ? null : entryKey(entry);
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
    expect(keys(state)).toEqual([id(2), id(4), "new-1"]);
    expect(stripEntries(state)[0]).toMatchObject({
      kind: "tab",
      title: "Stránka 2",
      favicon: "https://a.example/i.png",
      working: true,
    });
    expect(heldByLaunchpad(listedTab(2))).toBe(true);
    expect(heldByLaunchpad(otherTab(1))).toBe(false);
    // The hub's order changes, the strip's does not; a tab held later
    // comes last among the tabs, before the Nová karta entries.
    const later = relist(state, [listedTab(5), listedTab(4), listedTab(2)]);
    expect(keys(later)).toEqual([id(2), id(4), id(5), "new-1"]);
    // A tab whose close for everyone counts down leaves the strip.
    expect(
      keys(relist(later, [listedTab(2), listedTab(4, { closing: true })])),
    ).toEqual([id(2), "new-1"]);
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

  test("opening the panel on an empty strip shows one Nová karta, a full entry of the strip; opened again it shows what it showed; a strip emptied by anything but the person's × shows a new Nová karta", () => {
    const opened = run([{ kind: "opened" }]);
    expect(stripEntries(opened)).toEqual([{ kind: "new", key: "new-1" }]);
    expect([shown(opened), closesPanel(opened)]).toEqual(["new-1", false]);
    // The Launchpad holds nothing yet: only Nová karta, whatever Přehled lists.
    expect(keys(openWith([otherTab(1), otherTab(2)]))).toEqual(["new-1"]);
    // Opened again later, it shows what it showed, and adds nothing.
    const later = run(
      [{ kind: "select", entry: id(2) }, { kind: "opened" }],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect([keys(later), shown(later)]).toEqual([
      [id(1), id(2), "new-1"],
      id(2),
    ]);
    // The strip's last tab ends elsewhere: the panel stays open on a new
    // Nová karta and never closes by itself.
    const shownTab = run(
      [{ kind: "chosen", tab: id(1), from: "new-1" }],
      openWith([listedTab(1)]),
    );
    expect(keys(shownTab)).toEqual([id(1)]);
    const emptied = relist(shownTab, [otherTab(1)]);
    expect([keys(emptied), shown(emptied), closesPanel(emptied)]).toEqual([
      ["new-2"],
      "new-2",
      false,
    ]);
  });

  test("+ always adds a new Nová karta after the others and shows it; the one shown before stays as it was, and none of them is a remote tab", () => {
    const one = run([{ kind: "opened" }]);
    const three = run([{ kind: "new-tab" }, { kind: "new-tab" }], one);
    expect([keys(three), shown(three), three.made]).toEqual([
      ["new-1", "new-2", "new-3"],
      "new-3",
      3,
    ]);
    expect(three.overrides).toEqual([]);
    // Each is an entry of its own: choosing one shows it.
    expect(shown(run([{ kind: "select", entry: "new-1" }], three))).toBe(
      "new-1",
    );
    // Beside tabs, "+" from a tab adds one after the strip's Nová karta.
    const beside = run(
      [{ kind: "select", entry: id(1) }, { kind: "new-tab" }],
      openWith([listedTab(1)]),
    );
    expect([keys(beside), shown(beside)]).toEqual([
      [id(1), "new-1", "new-2"],
      "new-2",
    ]);
    // An entry the strip does not have is no choice.
    expect(run([{ kind: "select", entry: "new-9" }], beside)).toEqual(beside);
  });

  test("what is chosen in a Nová karta and held shows, and that Nová karta goes from the strip; the others stay", () => {
    const state = openWith([listedTab(1), otherTab(2)]);
    const fresh = run(
      [{ kind: "select", entry: id(1) }, { kind: "new-tab" }],
      state,
    );
    expect([keys(fresh), shown(fresh)]).toEqual([
      [id(1), "new-1", "new-2"],
      "new-2",
    ]);
    // A tab chosen in Přehled, held for the Launchpad, then shown: in the
    // strip before an overview says the Launchpad holds it.
    const chosen = run([{ kind: "chosen", tab: id(2), from: "new-2" }], fresh);
    expect([keys(chosen), shown(chosen)]).toEqual([
      [id(1), id(2), "new-1"],
      id(2),
    ]);
    // An overview begun before the hold, which does not have it yet, does
    // not take it away; the next one says the Launchpad holds it.
    const before = run(
      [{ kind: "listed", request: 1, tabs: [listedTab(1), otherTab(2)] }],
      chosen,
    );
    expect(keys(before)).toEqual([id(1), id(2), "new-1"]);
    const after = relist(before, [listedTab(1), listedTab(2)]);
    expect([keys(after), after.overrides]).toEqual([
      [id(1), id(2), "new-1"],
      [],
    ]);
    // A page just opened shows before the overview lists it at all, and
    // takes the place of the Nová karta it was opened in, also when another
    // entry is shown by the time it is held.
    const opened = run(
      [
        { kind: "select", entry: id(1) },
        { kind: "chosen", tab: id(9), from: "new-1" },
      ],
      after,
    );
    expect([keys(opened), shown(opened)]).toEqual([
      [id(1), id(2), id(9)],
      id(9),
    ]);
    expect(stripEntries(opened)[2]).toMatchObject({ tab: null, title: "" });
  });

  test("× on a Nová karta takes that entry away, with nothing let go of; the entry that took its place shows, else the one before it", () => {
    const state = run(
      [{ kind: "new-tab" }, { kind: "select", entry: "new-1" }],
      openWith([listedTab(1)]),
    );
    expect([keys(state), shown(state)]).toEqual([
      [id(1), "new-1", "new-2"],
      "new-1",
    ]);
    const first = run([{ kind: "close", keys: ["new-1"] }], state);
    expect([keys(first), shown(first), first.overrides]).toEqual([
      [id(1), "new-2"],
      "new-2",
      [],
    ]);
    const second = run([{ kind: "close", keys: ["new-2"] }], first);
    expect([keys(second), shown(second), closesPanel(second)]).toEqual([
      [id(1)],
      id(1),
      false,
    ]);
    // A Nová karta not shown goes without changing what is shown.
    expect(
      shown(
        run(
          [
            { kind: "select", entry: id(1) },
            { kind: "close", keys: ["new-2"] },
          ],
          first,
        ),
      ),
    ).toBe(id(1));
  });

  test("the person's × on the strip's last entry leaves it empty, which closes the panel; opening it again shows a new Nová karta", () => {
    // The last Nová karta.
    const alone = run([{ kind: "opened" }, { kind: "close", keys: ["new-1"] }]);
    expect([keys(alone), shown(alone), closesPanel(alone)]).toEqual([
      [],
      null,
      true,
    ]);
    const again = run([{ kind: "opened" }], alone);
    expect([keys(again), shown(again)]).toEqual([["new-2"], "new-2"]);
    // The last tab, let go of with ×: the strip stays empty while the
    // release is on its way and after it, and an overview that still holds
    // the tab brings nothing back.
    const tab = run(
      [{ kind: "chosen", tab: id(1), from: "new-1" }],
      openWith([listedTab(1)]),
    );
    const released = run(
      [
        { kind: "close", keys: [id(1)] },
        { kind: "requested" },
        { kind: "released", tab: id(1) },
      ],
      tab,
    );
    expect([keys(released), shown(released), closesPanel(released)]).toEqual([
      [],
      null,
      true,
    ]);
    expect(
      closesPanel(
        run(
          [
            {
              kind: "listed",
              request: released.requests,
              tabs: [listedTab(1)],
            },
          ],
          released,
        ),
      ),
    ).toBe(true);
    // Vrátit while the panel is closed puts the tab back without showing a
    // Nová karta, and the panel opens on it.
    const back = run(
      [{ kind: "held-again", tab: id(1), show: true }, { kind: "opened" }],
      released,
    );
    expect([keys(back), shown(back)]).toEqual([[id(1)], id(1)]);
    const quiet = run(
      [{ kind: "held-again", tab: id(1), show: false }, { kind: "opened" }],
      released,
    );
    expect([keys(quiet), shown(quiet)]).toEqual([[id(1)], id(1)]);
  });

  test("× lets go: the tab goes at once and stays gone while the release is on its way, even when an overview read before still holds it; only one requested after lifts the hide; a failed release brings it back", () => {
    const state = openWith([listedTab(1), listedTab(2)]);
    // Pablo's reproduction (#324), on the release that × now is: the tab
    // goes, then an overview begun before the release was done still lists
    // the Launchpad's hold.
    const releasing = run([{ kind: "close", keys: [id(1)] }], state);
    expect(keys(releasing)).toEqual([id(2), "new-1"]);
    const read = relist(releasing, [listedTab(1), listedTab(2)]);
    expect(keys(read)).toEqual([id(2), "new-1"]);
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
    expect(keys(late)).toEqual([id(2), "new-1"]);
    const confirmed = relist(late, [otherTab(1), listedTab(2)]);
    expect([keys(confirmed), confirmed.overrides]).toEqual([
      [id(2), "new-1"],
      [],
    ]);
    // A release that fails brings the tab back at once.
    const failed = run(
      [
        { kind: "close", keys: [id(2)] },
        { kind: "release-failed", tab: id(2) },
      ],
      state,
    );
    expect([keys(failed), failed.overrides]).toEqual([
      [id(1), id(2), "new-1"],
      [],
    ]);
  });

  test("the shown tab let go falls to the tab that took its place or the one before it, and the last one leaves the strip empty", () => {
    const state = run(
      [{ kind: "chosen", tab: id(3), from: "new-1" }],
      openWith([listedTab(1), listedTab(2), listedTab(3)]),
    );
    const third = run([{ kind: "close", keys: [id(3)] }], state);
    expect([keys(third), shown(third)]).toEqual([[id(1), id(2)], id(2)]);
    const first = run(
      [
        { kind: "select", entry: id(1) },
        { kind: "close", keys: [id(1)] },
      ],
      third,
    );
    expect([keys(first), shown(first)]).toEqual([[id(2)], id(2)]);
    const none = run([{ kind: "close", keys: [id(2)] }], first);
    expect([keys(none), shown(none), closesPanel(none)]).toEqual([
      [],
      null,
      true,
    ]);
    // A Nová karta after the tab takes its place instead.
    const kept = run(
      [{ kind: "new-tab" }, { kind: "select", entry: id(2) }],
      first,
    );
    const toNew = run([{ kind: "close", keys: [id(2)] }], kept);
    expect([keys(toNew), shown(toNew), closesPanel(toNew)]).toEqual([
      ["new-2"],
      "new-2",
      false,
    ]);
  });

  test("entries gone at once fall to the first one after the shown entry that is still there, else the nearest before it, by the strip as it was", () => {
    // Pablo's review of #341: [A, B, C, D, Nová karta] showing B, and one
    // overview drops A and B: C took B's place, not D.
    const four = run(
      [{ kind: "select", entry: id(2) }],
      openWith([listedTab(1), listedTab(2), listedTab(3), listedTab(4)]),
    );
    expect(keys(four)).toEqual([id(1), id(2), id(3), id(4), "new-1"]);
    const both = relist(four, [listedTab(3), listedTab(4)]);
    expect([keys(both), shown(both)]).toEqual([[id(3), id(4), "new-1"], id(3)]);
    // Showing D, C and D go together: the Nová karta after them.
    const last = relist(run([{ kind: "select", entry: id(4) }], four), [
      listedTab(1),
      listedTab(2),
    ]);
    expect([keys(last), shown(last)]).toEqual([
      [id(1), id(2), "new-1"],
      "new-1",
    ]);
    // Nothing after it is left: the nearest one before it.
    const tabs = run(
      [{ kind: "chosen", tab: id(3), from: "new-1" }],
      openWith([listedTab(1), listedTab(2), listedTab(3)]),
    );
    const before = relist(tabs, [listedTab(1)]);
    expect([keys(before), shown(before)]).toEqual([[id(1)], id(1)]);
    // Everything gone at once, by anything but the person's ×: a new Nová
    // karta, and the panel stays open.
    const emptied = relist(tabs, []);
    expect([keys(emptied), shown(emptied), closesPanel(emptied)]).toEqual([
      ["new-2"],
      "new-2",
      false,
    ]);
  });

  test("Vrátit holds the tab again: back in its place in the strip, and shown again where it was shown when let go", () => {
    const released = run(
      [
        { kind: "chosen", tab: id(2), from: "new-1" },
        { kind: "close", keys: [id(2)] },
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

  test("one command closes several entries at once (F47 point 9's addendum of 2026-10-13): its Nová karta entries go, its tabs are let go of, and one Vrátit holds them all again, each in its place, the shown one shown", () => {
    // [1, 2, 3, 4, Nová karta, Nová karta], showing tab 3.
    const six = run(
      [{ kind: "new-tab" }, { kind: "select", entry: id(3) }],
      openWith([listedTab(1), listedTab(2), listedTab(3), listedTab(4)]),
    );
    expect([keys(six), shown(six)]).toEqual([
      [id(1), id(2), id(3), id(4), "new-1", "new-2"],
      id(3),
    ]);
    // Everything but tab 2, at once: what was shown falls to tab 2, the only
    // entry left, and nothing closes the panel.
    const going = [id(1), id(3), id(4), "new-1", "new-2"];
    const closing = run([{ kind: "close", keys: going }], six);
    expect([
      keys(closing),
      shown(closing),
      closesPanel(closing),
      closing.newTabs,
    ]).toEqual([[id(2)], id(2), false, []]);
    // Each tab stays gone while its release is on its way, and after it
    // until an overview requested after it, which no longer holds it.
    expect(closing.overrides).toEqual(
      [1, 3, 4].map((n) => ({ id: id(n), state: "hidden", after: null })),
    );
    const read = relist(closing, [
      listedTab(1),
      listedTab(2),
      listedTab(3),
      listedTab(4),
    ]);
    expect(keys(read)).toEqual([id(2)]);
    const released = run(
      [1, 3, 4].map((n): StripEvent => ({ kind: "released", tab: id(n) })),
      read,
    );
    const settled = relist(released, [
      otherTab(1),
      listedTab(2),
      otherTab(3),
      otherTab(4),
    ]);
    expect([keys(settled), settled.overrides]).toEqual([[id(2)], []]);
    // One Vrátit: every tab held again, back where it was in the strip, the
    // one shown when they went shown again; the Nová karta entries do not
    // come back, as they were nothing yet.
    const back = run(
      [1, 3, 4].map(
        (n): StripEvent => ({
          kind: "held-again",
          tab: id(n),
          show: id(n) === id(3),
        }),
      ),
      settled,
    );
    expect([keys(back), shown(back)]).toEqual([
      [id(1), id(2), id(3), id(4)],
      id(3),
    ]);
    // A release that fails brings back its own tab only.
    const partly = run(
      [
        { kind: "released", tab: id(1) },
        { kind: "release-failed", tab: id(3) },
        { kind: "released", tab: id(4) },
      ],
      closing,
    );
    expect(keys(partly)).toEqual([id(2), id(3)]);
    // An entry the strip does not have is no part of a command.
    expect(run([{ kind: "close", keys: ["new-9", id(9)] }], six)).toEqual(six);
  });

  test("the view's tab ended: it goes, and the panel falls back, on its last tab to a new Nová karta; × on Nová karta among tabs shows the tab before it", () => {
    const two = run(
      [{ kind: "chosen", tab: id(2), from: "new-1" }],
      openWith([listedTab(1), listedTab(2)]),
    );
    const endedOne = run([{ kind: "ended", tab: id(2) }], two);
    expect([keys(endedOne), shown(endedOne)]).toEqual([[id(1)], id(1)]);
    const ended = run([{ kind: "ended", tab: id(1) }], endedOne);
    expect([keys(ended), shown(ended), closesPanel(ended)]).toEqual([
      ["new-2"],
      "new-2",
      false,
    ]);
    const closedNew = run(
      [{ kind: "close", keys: ["new-1"] }],
      openWith([listedTab(1), listedTab(2)]),
    );
    expect([keys(closedNew), shown(closedNew)]).toEqual([
      [id(1), id(2)],
      id(2),
    ]);
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

describe("an entry's menu (F47 point 9's addendum of 2026-10-13)", () => {
  const words = { cs: messages("cs"), en: messages("en") };
  const place = { origin, pageOrigin: page };
  /** A menu's commands in its words, a line between groups as "—", one
   * with nothing to do marked. */
  const read = (menu: TabMenu | null, locale: "cs" | "en") =>
    (menu?.groups ?? []).flatMap((group, index) => [
      ...(index === 0 ? [] : ["—"]),
      ...group.map(
        (item) =>
          `${words[locale][tabMenuLabels[item.command]]}${item.disabled ? " (disabled)" : ""}`,
      ),
    ]);
  // Tabs 1, 2 and 3, then two Nová karta entries, the second one shown.
  const five = run(
    [{ kind: "new-tab" }],
    openWith([listedTab(1), listedTab(2), listedTab(3)]),
  );

  test("a tab of the Environment browser offers Otevřít samostatně and Načíst znovu, then the closes; a Nová karta the closes alone; in Czech and in English", () => {
    expect([keys(five), shown(five)]).toEqual([
      [id(1), id(2), id(3), "new-1", "new-2"],
      "new-2",
    ]);
    expect(read(tabMenu(five, id(2), place), "cs")).toEqual([
      "Otevřít samostatně",
      "Načíst znovu",
      "—",
      "Zavřít",
      "Zavřít ostatní",
      "Zavřít vpravo",
    ]);
    expect(read(tabMenu(five, id(2), place), "en")).toEqual([
      "Open in a new tab",
      "Reload",
      "—",
      "Close",
      "Close others",
      "Close to the right",
    ]);
    expect(read(tabMenu(five, "new-1", place), "cs")).toEqual([
      "Zavřít",
      "Zavřít ostatní",
      "Zavřít vpravo",
    ]);
    // Otevřít samostatně opens the tab's view on exactly the recorded
    // origin; a Nová karta is no remote tab and has none.
    expect(tabMenu(five, id(2), place)?.view).toBe(`${origin}/t/${id(2)}`);
    expect(tabMenu(five, "new-1", place)?.view).toBeNull();
    // An entry the strip does not have has no menu.
    expect(tabMenu(five, id(9), place)).toBeNull();
    expect(tabMenu(five, "new-9", place)).toBeNull();
  });

  test("a close with nothing to close is greyed, and so are Otevřít samostatně and Načíst znovu where the tab has no view the panel may frame", () => {
    // The last entry has nothing on its right.
    expect(read(tabMenu(five, "new-2", place), "cs")).toEqual([
      "Zavřít",
      "Zavřít ostatní",
      "Zavřít vpravo (disabled)",
    ]);
    // The strip's only entry has no others either.
    const alone = run([{ kind: "opened" }]);
    expect(read(tabMenu(alone, "new-1", place), "cs")).toEqual([
      "Zavřít",
      "Zavřít ostatní (disabled)",
      "Zavřít vpravo (disabled)",
    ]);
    const one = run(
      [{ kind: "chosen", tab: id(1), from: "new-1" }],
      openWith([listedTab(1)]),
    );
    expect(read(tabMenu(one, id(1), place), "en")).toEqual([
      "Open in a new tab",
      "Reload",
      "—",
      "Close",
      "Close others (disabled)",
      "Close to the right (disabled)",
    ]);
    // No view to frame: the view on the page's own origin, or no panel.
    for (const nowhere of [
      { origin, pageOrigin: origin },
      { origin: null, pageOrigin: page },
    ]) {
      const menu = tabMenu(five, id(2), nowhere);
      expect(menu?.view).toBeNull();
      expect(read(menu, "cs")).toEqual([
        "Otevřít samostatně (disabled)",
        "Načíst znovu (disabled)",
        "—",
        "Zavřít",
        "Zavřít ostatní",
        "Zavřít vpravo",
      ]);
    }
  });

  test("Zavřít takes the entry, Zavřít ostatní every other one, Zavřít vpravo every one after it, Nová karta entries among them, at once; what was shown falls to the entry the command was chosen on", () => {
    expect(closedBy(five, id(2), "close")).toEqual([id(2)]);
    expect(closedBy(five, id(2), "close-others")).toEqual([
      id(1),
      id(3),
      "new-1",
      "new-2",
    ]);
    expect(closedBy(five, id(2), "close-right")).toEqual([
      id(3),
      "new-1",
      "new-2",
    ]);
    expect(closedBy(five, "new-1", "close-right")).toEqual(["new-2"]);
    for (const command of ["close", "close-others", "close-right"] as const)
      expect(closedBy(five, id(9), command)).toEqual([]);
    const after = (state: StripState, key: string, command: CloseCommand) =>
      run([{ kind: "close", keys: closedBy(state, key, command) }], state);
    // Zavřít ostatní on tab 2 while a Nová karta shows: tab 2 alone stays,
    // and shows; tabs 1 and 3 are let go of, the Nová karta entries go.
    const others = after(five, id(2), "close-others");
    expect([
      keys(others),
      shown(others),
      closesPanel(others),
      others.newTabs,
      others.overrides.map((override) => override.id),
    ]).toEqual([[id(2)], id(2), false, [], [id(1), id(3)]]);
    // Zavřít vpravo on tab 2: what was shown, right of it, falls to tab 2.
    const right = after(five, id(2), "close-right");
    expect([keys(right), shown(right)]).toEqual([[id(1), id(2)], id(2)]);
    // What is shown left of it stays shown.
    const left = run([{ kind: "select", entry: id(1) }], five);
    const kept = after(left, id(2), "close-right");
    expect([keys(kept), shown(kept)]).toEqual([[id(1), id(2)], id(1)]);
    // From a Nová karta the tabs go too.
    const fromNew = after(five, "new-1", "close-others");
    expect([keys(fromNew), shown(fromNew)]).toEqual([["new-1"], "new-1"]);
  });

  test("Zavřít on the strip's last entry is its ×: the strip is left empty and the panel closes; Zavřít ostatní and Zavřít vpravo never empty it", () => {
    const tab = run(
      [{ kind: "chosen", tab: id(1), from: "new-1" }],
      openWith([listedTab(1)]),
    );
    const closed = run(
      [{ kind: "close", keys: closedBy(tab, id(1), "close") }],
      tab,
    );
    expect([keys(closed), shown(closed), closesPanel(closed)]).toEqual([
      [],
      null,
      true,
    ]);
    const newTab = run([{ kind: "opened" }]);
    expect(
      closesPanel(
        run(
          [{ kind: "close", keys: closedBy(newTab, "new-1", "close") }],
          newTab,
        ),
      ),
    ).toBe(true);
    for (const key of keys(five))
      for (const command of ["close-others", "close-right"] as const)
        expect(
          closesPanel(
            run([{ kind: "close", keys: closedBy(five, key, command) }], five),
          ),
        ).toBe(false);
  });

  test("the markup: the strip keeps its entries, + and Close, without Reload and the link to a new tab; the menu waits in the panel, hidden", async () => {
    const html = await readFile(
      join(import.meta.dir, "..", "src", "launchpad", "index.html"),
      "utf8",
    );
    const inside: {
      id: string | null;
      classes: readonly string[];
      role: string | null;
      message: string | null;
      hidden: boolean;
    }[] = [];
    await new HTMLRewriter()
      .on("#browser-panel *", {
        element(node) {
          inside.push({
            id: node.getAttribute("id"),
            classes: (node.getAttribute("class") ?? "").split(/\s+/),
            role: node.getAttribute("role"),
            message: node.getAttribute("data-message"),
            hidden: node.hasAttribute("hidden"),
          });
        },
      })
      .transform(new Response(html))
      .text();
    const ids = inside.flatMap((node) => (node.id === null ? [] : [node.id]));
    for (const gone of ["browser-reload", "browser-tab"])
      expect(ids).not.toContain(gone);
    for (const gone of ["browserReload", "browserOpenTab"])
      expect(inside.some((node) => node.message === gone)).toBe(false);
    // "+" beside the entries, and the panel's Close, are its actions now.
    expect(
      inside
        .filter((node) => node.classes.includes("browser-action"))
        .map((node) => node.id),
    ).toEqual(["browser-new", "browser-close"]);
    for (const kept of ["browser-tablist", "browser-body", "browser-menu"])
      expect(ids).toContain(kept);
    expect(inside.find((node) => node.id === "browser-menu")).toMatchObject({
      role: "menu",
      hidden: true,
    });
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
        "Apps už mají tolik záložek, kolik unesou. Zavřete některé a zkuste to znovu.",
        true,
      ],
      [
        answer(404, { error: "not-found" }),
        "Záložka už v Prostředí není.",
        false,
      ],
      [
        answer(503, { error: "holder-unavailable" }),
        "Záložku se nepodařilo v Apps ponechat.",
        false,
      ],
      [
        answer(503, { error: "closing" }),
        "Lazurio teď neodpovídá, zkuste to za chvíli znovu.",
        true,
      ],
      [
        answer(503, { error: "hub-unreachable" }),
        "Prohlížeč Prostředí teď neodpovídá, zkuste to za chvíli znovu.",
        true,
      ],
      [
        answer(500, { error: "hold-failed" }),
        "Záložku se nepodařilo v Apps ponechat.",
        true,
      ],
      [answer(0), "Lazurio teď neodpovídá, zkuste to za chvíli znovu.", true],
      [
        answer(404, { error: "no-browser" }),
        "Toto Prostředí nemá prohlížeč.",
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
    expect(releaseText(listedTab(1), cs)).toBe("Záložka se zavře v Prostředí.");
    expect(releaseText(null, cs)).toBe("Záložka se zavře v Prostředí.");
    expect(releaseText(listedTab(1, { agents: ["codex-a1"] }), cs)).toBe(
      "Záložka zmizela z Apps. Pracuje v ní agent, takže zůstává otevřená.",
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
      "Záložka zmizela z Apps. Dál je ve vlákně „Faktury za září“, v jiném vlákně a jinde.",
    );
    expect(
      releaseText(
        listedTab(1, { holders: [{ strip: "t3-x", label: "Invoices" }] }),
        en,
      ),
    ).toBe("The tab left the Launchpad. It stays in the thread “Invoices”.");
  });

  test("one command's Vrátit (F47 point 9's addendum of 2026-10-13): every tab it let go of, one line for them all, the one shown, and whether one of them ends", () => {
    const entry = (n: number, tab: StripTab | null = listedTab(n)) => ({
      id: id(n),
      tab,
    });
    const agent = listedTab(2, { agents: ["codex-a1"] });
    const thread = listedTab(3, {
      holders: [launchpad, { strip: "t3-x", label: "Faktury za září" }],
    });
    // One tab: point 9's own words, as the × always said them.
    expect(letGoUndo([entry(1)], id(1), cs)).toEqual({
      tabs: [id(1)],
      text: "Záložka se zavře v Prostředí.",
      shown: id(1),
      ends: true,
    });
    expect(letGoUndo([entry(2, agent)], id(1), cs)).toEqual({
      tabs: [id(2)],
      text: "Záložka zmizela z Apps. Pracuje v ní agent, takže zůstává otevřená.",
      shown: null,
      ends: false,
    });
    // Several: all close, all stay, or some of each.
    expect(letGoUndo([entry(1), entry(4)], null, cs)).toEqual({
      tabs: [id(1), id(4)],
      text: "Záložky se zavřou v Prostředí.",
      shown: null,
      ends: true,
    });
    expect(letGoUndo([entry(2, agent), entry(3, thread)], id(3), cs)).toEqual({
      tabs: [id(2), id(3)],
      text: "Záložky zmizely z Apps. Zůstávají otevřené jinde nebo u agenta.",
      shown: id(3),
      ends: false,
    });
    expect(
      letGoUndo([entry(1), entry(2, agent), entry(3, thread)], id(9), en),
    ).toEqual({
      tabs: [id(1), id(2), id(3)],
      text: "The tabs left the Launchpad. Some stay open elsewhere or with an agent; the others close in the Environment.",
      shown: null,
      ends: true,
    });
    // A tab only this panel knows yet ends as nothing else holds it.
    expect(letGoUndo([entry(9, null)], null, cs)?.ends).toBe(true);
    // A command that let go of no tab (a Nová karta alone) offers none.
    expect(letGoUndo([], "new-1", cs)).toBeNull();
  });

  // Every app offers Vrátit for 1 s less than the hub's grace after its
  // release request (decision F50 point 2): 7 s, where the strip offered it
  // for the whole 8 s of the grace.
  test("one command's Vrátit lasts 1 s less than the hub's grace from its first request: 7 s", () => {
    expect(letGoUndoUntil(1_000)).toBe(8_000);
    expect(letGoUndoUntil(1_000) - 1_000).toBe(
      browserTimes.releaseGraceMs - 1_000,
    );
  });

  test("what a command says when tabs could not be let go of, or held again by its Vrátit: for one tab or several, or the cause the answer names", () => {
    expect(
      releaseFailure(answer(500, { error: "release-failed" }), cs, 1),
    ).toBe("Záložku se nepodařilo z Apps odebrat.");
    expect(
      releaseFailure(answer(500, { error: "release-failed" }), cs, 3),
    ).toBe("Záložky se nepodařilo z Apps odebrat.");
    expect(releaseFailure(answer(0), cs, 3)).toBe(
      "Lazurio teď neodpovídá, zkuste to za chvíli znovu.",
    );
    const gone = answer(404, { error: "not-found" });
    expect(restoreFailure(gone, cs, 1)).toEqual({
      text: "Záložku už nejde vrátit.",
      retry: false,
    });
    expect(restoreFailure(gone, cs, 2)).toEqual({
      text: "Záložky už nejde vrátit.",
      retry: false,
    });
    expect(
      restoreFailure(answer(500, { error: "hold-failed" }), cs, 2),
    ).toEqual({
      text: "Záložky se nepodařilo v Apps ponechat.",
      retry: true,
    });
    expect(
      restoreFailure(answer(500, { error: "hold-failed" }), en, 1),
    ).toEqual({
      text: "The tab could not be kept in the Launchpad.",
      retry: true,
    });
    expect(
      restoreFailure(answer(503, { error: "hub-unreachable" }), cs, 2),
    ).toEqual({
      text: "Prohlížeč Prostředí teď neodpovídá, zkuste to za chvíli znovu.",
      retry: true,
    });
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
      acceptViewMessage(
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
      acceptViewMessage(
        event({ type: "lazurio-browser:closed", view: at }),
        origin,
      ),
    ).toEqual({ kind: "closed", tab: target });
    expect(
      acceptViewMessage(
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
      expect(acceptViewMessage(event(data, extra), viewOrigin)).toBeNull();
  });

  test("Nová karta's choice in the Launchpad: a page it opened or a tab it chose, framed on the recorded origin; the Launchpad has no tools, and anything else is nothing", () => {
    for (const kind of ["page", "tab"] as const)
      expect(
        panelChoice({ kind, tab: target.toLowerCase(), view: at }),
      ).toEqual({ kind, tab: target });
    // Only the tab is taken: its frame is the recorded view's, whatever
    // view the choice carried. Since decision F50 point 2 that view is a view
    // address in the strict form, here another Environment's; an address
    // that is none (another host) is no choice.
    const elsewhere = panelChoice({
      kind: "tab",
      tab: target,
      view: `https://browser.vm-02.example.lazurio.io/t/${target}`,
    });
    expect(elsewhere).toEqual({ kind: "tab", tab: target });
    expect(tabViewAddress(origin, elsewhere?.tab ?? "", page)).toBe(at);
    expect(
      panelChoice({
        kind: "tab",
        tab: target,
        view: `https://elsewhere.example/t/${target}`,
      }),
    ).toBeNull();
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
