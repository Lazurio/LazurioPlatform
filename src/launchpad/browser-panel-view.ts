import {
  browserTimes,
  browserViewUrl,
  launchpadStrip,
  parseNewTabChoice,
  stripAppOf,
  targetIdOf,
  viewAddressOf,
} from "../browser/contract/pure";
import type { PublicEntry } from "./chat";
import type { MessageKey } from "./messages";
import {
  actionFailure,
  fill,
  hideAnswered,
  hideAsked,
  isNoBrowser,
  type NewTabAnswer,
  type NewTabCopy,
  type NewTabOverview,
  type NewTabTab,
  type PendingUndo,
  settleOverrides,
  type TabOverride,
  withOverride,
} from "./new-tab-view";

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207; decision F47 point 9, its addendum
// of 2026-10-12 and Matěj's tuning of the same day): the strip of the tabs
// the Launchpad holds, read from Nová karta's overview every 5 s while the
// panel is open, then its Nová karta entries, and under it either one tab's
// view (decision F39, the same view every app of the Environment embeds; the
// Launchpad builds no viewer of its own) or Nová karta, the shell element
// `<lazurio-new-tab strip="launchpad" focus-address>`. "+" adds a Nová karta
// after the others, as Chrome does, and opening the panel on an empty strip
// shows one. × on a Nová karta takes it away; × on a tab lets go of the
// Launchpad's hold, with Vrátit while the hub's grace lasts, one Vrátit for
// every tab one command let go of (F47 point 9's addendum of 2026-10-13);
// closing a tab for everyone is Přehled's Zavřít. An entry's menu (the same
// addendum) opens a tab's view on its own or frames it anew, and closes the
// entry, the others or those to its right as × does. The person's × on the
// strip's last entry closes the panel, as T3 Code's does (root decision 0195
// point 16), and so does the menu's "Zavřít" there. The panel is offered
// only where the recorded entry routes the view (`browserOrigin`): never on
// a workstation, which has no entry, and never in Recovery mode. A view is
// framed only on exactly the recorded origin. Pure: the DOM
// (browser-panel.ts) only draws this and asks.

/** The view's origin where the panel is offered, null where it is not: no
 * recorded entry (a workstation), an entry whose gateway routes no view, or
 * Recovery mode. */
export function browserPanelOrigin(
  entry: PublicEntry | null,
  recovery: boolean,
): string | null {
  return recovery ? null : (entry?.browserOrigin ?? null);
}

/** The view's address in an answer of `GET /.lazurio/browser.json`: only
 * `{available: true, view}` whose `view` is a view address of the contract
 * (`viewAddressOf`: a tab's or the bare origin) on exactly `origin`, the
 * recorded `browserOrigin`, as the contract writes it. Never on the page's
 * own origin: the sandbox confines the frame only while it is another
 * origin. Anything else is null. */
export function browserViewAddress(
  answer: unknown,
  origin: string,
  pageOrigin: string,
): string | null {
  if (!isRecord(answer) || answer.available !== true) return null;
  const address = viewAddressOf(answer.view);
  return address !== null &&
    address.origin === origin &&
    address.origin !== pageOrigin
    ? address.view
    : null;
}

/** The view of one remote tab that the panel frames, under the same check
 * as any view: null for anything but a tab id on the recorded origin. */
export function tabViewAddress(
  origin: string,
  tab: string,
  pageOrigin: string,
): string | null {
  const id = targetIdOf(tab);
  if (id === null) return null;
  return browserViewAddress(
    { available: true, view: browserViewUrl(origin, id) },
    origin,
    pageOrigin,
  );
}

/** The remote tab a view address shows (`viewAddressOf`): `<origin>/t/<id>`
 * on exactly the view's origin, in the contract's form, its id in upper
 * case; null otherwise. */
export function viewTabOf(view: unknown, origin: string): string | null {
  const address = viewAddressOf(view);
  return address !== null && address.origin === origin ? address.tab : null;
}

// ---- The strip -------------------------------------------------------------------

/** One remote tab as the overview lists it, what the strip needs of it. */
export type StripTab = Pick<
  NewTabTab,
  "id" | "title" | "url" | "favicon" | "agents" | "holders" | "closing"
>;

/** The Launchpad holds the tab, as the overview says (F47 point 4): the
 * Launchpad's own hold, as it last wrote its holder file. */
export const heldByLaunchpad = (tab: Pick<StripTab, "holders">): boolean =>
  tab.holders.some((hold) => hold.strip === launchpadStrip);

export type StripState = Readonly<{
  /** The last overview's tabs in the hub's order, every tab of the
   * Environment; null before the first answer that listed them. */
  listed: readonly StripTab[] | null;
  /** What was done here that an older overview does not know yet. */
  overrides: readonly TabOverride[];
  /** A tab's title and address as its view reported them, until an
   * overview requested after that. */
  live: readonly Readonly<{
    id: string;
    title: string;
    url: string;
    after: number;
  }>[];
  /** Every tab the strip has had, in the order it first had it: the strip
   * keeps that order, and a tab held again returns to its place. */
  order: readonly string[];
  /** Overviews requested so far. */
  requests: number;
  /** The strip's Nová karta entries, each with a key of its own
   * (`new-<n>`), in the order "+" made them. They stand after the tabs, as
   * in the wireframe, and none of them is a remote tab yet. */
  newTabs: readonly string[];
  /** The key of the entry the panel shows (a tab's id, a Nová karta's
   * key); null before the first opening and once the strip's last entry
   * went. */
  active: string | null;
  /** Nová karta entries made so far, for the next one's key. */
  made: number;
}>;

export const emptyStrip: StripState = Object.freeze({
  listed: null,
  overrides: [],
  live: [],
  order: [],
  requests: 0,
  newTabs: [],
  active: null,
  made: 0,
});

export type StripEntry =
  | Readonly<{
      kind: "tab";
      id: string;
      /** Its title, its address, or empty while neither is known. */
      title: string;
      url: string;
      favicon: string | null;
      working: boolean;
      /** The overview's facts; null while only this panel knows the tab. */
      tab: StripTab | null;
    }>
  | Readonly<{
      kind: "new";
      /** Its own key: every Nová karta is a tab of the strip, with its ×
       * (Matěj 2026-10-12). */
      key: string;
    }>;

/** An entry's key in the strip: a tab's id, a Nová karta's own key. Tab
 * ids are hexadecimal target ids, so the two never meet. */
export const entryKey = (entry: StripEntry): string =>
  entry.kind === "new" ? entry.key : entry.id;

/** The strip (F47 point 9's addendum of 2026-10-12): the tabs the Launchpad
 * holds, as the overview says, and those it took here before an overview
 * says so; none taken away here, and none whose close for everyone counts
 * down unless brought back here. In the order the strip first had them,
 * then its Nová karta entries; empty only before the panel first opens and
 * once the person's × took its last entry. Every other tab of the
 * Environment is in Přehled only. */
export function stripEntries(state: StripState): readonly StripEntry[] {
  const listed = state.listed ?? [];
  const facts = new Map(listed.map((tab) => [tab.id, tab]));
  const hidden = new Set<string>();
  const shown = new Set<string>();
  for (const override of state.overrides)
    (override.state === "hidden" ? hidden : shown).add(override.id);
  const ids = [
    ...new Set([
      ...listed.filter(heldByLaunchpad).map((tab) => tab.id),
      ...shown,
    ]),
  ].filter(
    (id) =>
      !hidden.has(id) && (shown.has(id) || facts.get(id)?.closing !== true),
  );
  const rank = new Map(state.order.map((id, at) => [id, at]));
  const place = (id: string) => rank.get(id) ?? state.order.length;
  const live = (id: string) => state.live.find((item) => item.id === id);
  const entries: StripEntry[] = ids
    .map((id, at) => ({ id, at }))
    .sort((a, b) => place(a.id) - place(b.id) || a.at - b.at)
    .map(({ id }) => {
      const tab = facts.get(id) ?? null;
      return {
        kind: "tab",
        id,
        title: live(id)?.title || tab?.title || "",
        url: live(id)?.url || tab?.url || "",
        favicon: tab?.favicon ?? null,
        working: (tab?.agents.length ?? 0) > 0,
        tab,
      };
    });
  return [
    ...entries,
    ...state.newTabs.map((key): StripEntry => ({ kind: "new", key })),
  ];
}

/** The entry the panel shows: the one shown last, else the strip's last;
 * null while the strip is empty. */
export function shownEntry(state: StripState): StripEntry | null {
  const entries = stripEntries(state);
  return (
    entries.find((entry) => entryKey(entry) === state.active) ??
    entries[entries.length - 1] ??
    null
  );
}

/** The person's × took the strip's last entry: the panel closes, as T3
 * Code's does when its last tab closes (root decision 0195 point 16), and
 * opens again on a Nová karta. */
export const closesPanel = (state: StripState): boolean =>
  stripEntries(state).length === 0;

export type StripEvent =
  /** The panel opened: on an empty strip it shows a new Nová karta,
   * otherwise what it showed last. */
  | Readonly<{ kind: "opened" }>
  /** An overview is requested now; it is the `requests`-th. */
  | Readonly<{ kind: "requested" }>
  /** The answer to the `request`-th overview; `tabs` null while the hub
   * does not answer, which changes nothing. */
  | Readonly<{
      kind: "listed";
      request: number;
      tabs: readonly StripTab[] | null;
    }>
  /** "+": a new Nová karta after the others, shown; the one shown before
   * stays as it was (Matěj 2026-10-12). */
  | Readonly<{ kind: "new-tab" }>
  /** An entry of the strip chosen, by its key. */
  | Readonly<{ kind: "select"; entry: string }>
  /** The person's × on an entry, or a close of one command over several
   * entries (F47 point 9's addendum of 2026-10-13): the entries `keys` go
   * at once. A Nová karta among them is no remote tab, so nothing is let go
   * of and there is no Vrátit for it. The Launchpad lets go of every tab
   * among them, which goes from the strip at once and stays gone while the
   * release is on its way (`hideAsked`). */
  | Readonly<{ kind: "close"; keys: readonly string[] }>
  /** The Nová karta `from` became this tab, which the Launchpad now holds:
   * a page it opened, or a tab chosen in its Přehled and held. That Nová
   * karta goes, and the panel shows the tab. */
  | Readonly<{ kind: "chosen"; tab: string; from: string | null }>
  /** A tab the Launchpad now holds, to show: a page's new tab viewed here,
   * a sign-in an Integrace opened in the Environment browser. */
  | Readonly<{ kind: "show"; tab: string; url?: string | undefined }>
  /** The release of a tab `close` let go of is done: only an overview
   * requested after now lifts the hide (`hideAnswered`). */
  | Readonly<{ kind: "released"; tab: string }>
  /** The release failed: the tab is back. */
  | Readonly<{ kind: "release-failed"; tab: string }>
  /** Vrátit: the Launchpad holds the tab again, shown again where it was
   * shown when released. */
  | Readonly<{ kind: "held-again"; tab: string; show: boolean }>
  /** The view said its tab ended (`lazurio-browser:closed`). */
  | Readonly<{ kind: "ended"; tab: string }>
  /** The view said where its tab is (`lazurio-browser:info`). */
  | Readonly<{ kind: "info"; tab: string; title: string; url: string }>;

/** A new Nová karta after the others, shown. */
function withNewTab(state: StripState): StripState {
  const key = `new-${state.made + 1}`;
  return {
    ...state,
    newTabs: [...state.newTabs, key],
    active: key,
    made: state.made + 1,
  };
}

function apply(state: StripState, event: StripEvent): StripState {
  const after = state.requests;
  switch (event.kind) {
    case "opened": {
      const entries = stripEntries(state);
      const last = entries[entries.length - 1];
      if (last === undefined) return withNewTab(state);
      return entries.some((entry) => entryKey(entry) === state.active)
        ? state
        : { ...state, active: entryKey(last) };
    }
    case "requested":
      return { ...state, requests: state.requests + 1 };
    case "listed":
      return event.tabs === null
        ? state
        : {
            ...state,
            listed: event.tabs,
            overrides: settleOverrides(state.overrides, event.request),
            live: state.live.filter((item) => item.after >= event.request),
          };
    case "new-tab":
      return withNewTab(state);
    case "select":
      return stripEntries(state).some(
        (entry) => entryKey(entry) === event.entry,
      )
        ? { ...state, active: event.entry }
        : state;
    case "close": {
      const keys = new Set(event.keys);
      return {
        ...state,
        newTabs: state.newTabs.filter((key) => !keys.has(key)),
        overrides: stripEntries(state).reduce(
          (overrides, entry) =>
            entry.kind === "tab" && keys.has(entry.id)
              ? hideAsked(overrides, entry.id)
              : overrides,
          state.overrides,
        ),
      };
    }
    case "chosen":
      return {
        ...state,
        newTabs: state.newTabs.filter((key) => key !== event.from),
        overrides: withOverride(state.overrides, event.tab, "shown", after),
        active: event.tab,
      };
    case "show":
      return {
        ...state,
        overrides: withOverride(state.overrides, event.tab, "shown", after),
        live:
          event.url === undefined
            ? state.live
            : [
                ...state.live.filter((item) => item.id !== event.tab),
                { id: event.tab, title: "", url: event.url, after },
              ],
        active: event.tab,
      };
    case "released":
    case "release-failed":
      return {
        ...state,
        overrides: hideAnswered(
          state.overrides,
          event.tab,
          event.kind === "released",
          after,
        ),
      };
    case "held-again":
      return {
        ...state,
        overrides: withOverride(state.overrides, event.tab, "shown", after),
        active: event.show ? event.tab : state.active,
      };
    case "ended":
      return {
        ...state,
        overrides: withOverride(state.overrides, event.tab, "hidden", after),
      };
    case "info":
      return {
        ...state,
        live: [
          ...state.live.filter((item) => item.id !== event.tab),
          { id: event.tab, title: event.title, url: event.url, after },
        ],
      };
  }
}

/** The person's own × on an entry of the strip, or a close of its menu. */
const closedByPerson = (event: StripEvent): boolean => event.kind === "close";

/** The strip after `event`. When what the panel showed is gone from the
 * strip (closed, released, ended, or held no more), it shows the entry that
 * took its place, else the one before it. With nothing left, the person's
 * × leaves the strip empty, which closes the panel (`closesPanel`); a strip
 * emptied any other way (its tab ended, another device let go of it) shows
 * a new Nová karta, so the panel never closes by itself. A tab new to the
 * strip takes the last place in its order. */
export function reduceStrip(state: StripState, event: StripEvent): StripState {
  const applied = apply(state, event);
  const known = new Set(applied.order);
  const added = stripEntries(applied).flatMap((entry) =>
    entry.kind === "tab" && !known.has(entry.id) ? [entry.id] : [],
  );
  const next =
    added.length === 0
      ? applied
      : { ...applied, order: [...applied.order, ...added] };
  const active = next.active;
  if (active === null) return next;
  const entries = stripEntries(next);
  if (entries.some((entry) => entryKey(entry) === active)) return next;
  if (entries.length === 0)
    return closedByPerson(event) ? { ...next, active: null } : withNewTab(next);
  // The entry that took its place: the first one after it that is still
  // there, else the nearest one before it, by the strip as it was, so that
  // entries gone at once (one overview) never skip the next one (Pablo's
  // review of #341).
  const before = stripEntries(state);
  const at = before.findIndex((entry) => entryKey(entry) === active);
  const stays = (entry: StripEntry) =>
    entries.some((left) => entryKey(left) === entryKey(entry));
  const neighbour =
    (at < 0
      ? undefined
      : (before.slice(at + 1).find(stays) ??
        before.slice(0, at).reverse().find(stays))) ??
    entries[entries.length - 1];
  return {
    ...next,
    active: neighbour === undefined ? null : entryKey(neighbour),
  };
}

/** The strip's tabs from Nová karta's overview; null while the hub does not
 * answer. */
export function stripTabs(
  overview: NewTabOverview | null,
): readonly StripTab[] | null {
  return overview?.tabs ?? null;
}

// ---- A tab's menu --------------------------------------------------------------

// The menu of an entry of the strip (F47 point 9's addendum of 2026-10-13,
// the wireframe's TabMenu): with the panel's head row gone, what the strip
// offered for the shown tab, "Načíst znovu" and "Otevřít v nové kartě", is
// here for each tab, beside the closes T3 Code's tab menu has.

/** The closes of a menu: Zavřít, Zavřít ostatní, Zavřít vpravo. */
export type CloseCommand = "close" | "close-others" | "close-right";
export type TabMenuCommand = "open-separately" | "reload" | CloseCommand;
export type TabMenuItem = Readonly<{
  command: TabMenuCommand;
  disabled: boolean;
}>;
export type TabMenu = Readonly<{
  /** The entry's key. */
  key: string;
  /** What "Otevřít samostatně" opens in a new tab of the person's browser,
   * without an opener: the tab's view (`tabViewAddress`). Null for a Nová
   * karta, and for a tab the panel may not frame. */
  view: string | null;
  /** Its commands in groups, a line between two groups. */
  groups: readonly (readonly TabMenuItem[])[];
}>;

/** The Launchpad's words for each command (messages.ts). */
export const tabMenuLabels: Readonly<Record<TabMenuCommand, MessageKey>> = {
  "open-separately": "browserOpenTab",
  reload: "browserReload",
  close: "browserTabClose",
  "close-others": "browserTabCloseOthers",
  "close-right": "browserTabCloseRight",
};

/** The entries a close of `key`'s menu takes, in the strip's order: Zavřít
 * the entry itself, Zavřít ostatní every other one, Zavřít vpravo every one
 * after it. None for an entry the strip does not have. */
export function closedBy(
  state: StripState,
  key: string,
  command: CloseCommand,
): readonly string[] {
  const keys = stripEntries(state).map(entryKey);
  const at = keys.indexOf(key);
  if (at < 0) return [];
  switch (command) {
    case "close":
      return [key];
    case "close-others":
      return keys.filter((other) => other !== key);
    case "close-right":
      return keys.slice(at + 1);
  }
}

/** The menu of the entry `key`: for a tab of the Environment browser,
 * "Otevřít samostatně" and "Načíst znovu", then for every entry "Zavřít",
 * "Zavřít ostatní" and "Zavřít vpravo", which work as its × does. A close
 * with nothing to close is disabled, and so are the first two where the
 * tab has no view the panel may frame (`origin` is the recorded view
 * origin, null where the panel is not offered). Null for an entry the strip
 * does not have. */
export function tabMenu(
  state: StripState,
  key: string,
  place: Readonly<{ origin: string | null; pageOrigin: string }>,
): TabMenu | null {
  const entry = stripEntries(state).find((item) => entryKey(item) === key);
  if (entry === undefined) return null;
  const closes = (["close", "close-others", "close-right"] as const).map(
    (command): TabMenuItem => ({
      command,
      disabled: closedBy(state, key, command).length === 0,
    }),
  );
  if (entry.kind === "new") return { key, view: null, groups: [closes] };
  const view =
    place.origin === null
      ? null
      : tabViewAddress(place.origin, entry.id, place.pageOrigin);
  return {
    key,
    view,
    groups: [
      [
        { command: "open-separately", disabled: view === null },
        { command: "reload", disabled: view === null },
      ],
      closes,
    ],
  };
}

// ---- What the Launchpad answers --------------------------------------------------
// (What a tab's frame says, the panel reads with the contract's
// `acceptViewMessage`, C8.)

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The Launchpad holds the tab (F47 point 4): `POST /api/new-tab/hold`
 * answered `200 {held: true}`, and nothing else. */
export function holdSucceeded(answer: NewTabAnswer): boolean {
  return (
    answer.status === 200 &&
    isRecord(answer.value) &&
    answer.value.held === true
  );
}

/** Why a hold failed, in Nová karta's words, and whether Zkusit znovu can
 * help: a tab that is gone (`gone` says it), an Environment without a
 * browser, or a Launchpad without its holder file cannot hold it by trying
 * again; a full holder can, once the person closed some tabs. Any other
 * reason the Launchpad gave is `failed`. */
export function holdFailure(
  answer: NewTabAnswer,
  copy: NewTabCopy,
  gone: string = copy.holdGone,
  failed: string = copy.holdFailed,
): Readonly<{ text: string; retry: boolean }> {
  const error = isRecord(answer.value) ? answer.value.error : undefined;
  if (answer.status === 404 && error === "not-found")
    return { text: gone, retry: false };
  if (answer.status === 409 && error === "too-many-tabs")
    return { text: copy.holdFull, retry: true };
  return {
    text: actionFailure(answer, failed, copy),
    retry: !isNoBrowser(answer) && error !== "holder-unavailable",
  };
}

/** Why Vrátit could not hold `failed` of a command's tabs again: as
 * `holdFailure` says it, a tab that is gone as one Vrátit no longer brings
 * back, for one tab or for several. */
export function restoreFailure(
  answer: NewTabAnswer,
  copy: NewTabCopy,
  failed: number,
): Readonly<{ text: string; retry: boolean }> {
  return failed > 1
    ? holdFailure(answer, copy, copy.restoreTabsFailed, copy.holdTabsFailed)
    : holdFailure(answer, copy, copy.restoreFailed);
}

/** The Launchpad let go of the tab: `POST /api/new-tab/release` answered
 * `200 {released: true}`, and nothing else. */
export function releaseSucceeded(answer: NewTabAnswer): boolean {
  return (
    answer.status === 200 &&
    isRecord(answer.value) &&
    answer.value.released === true
  );
}

/** What happens to a tab the Launchpad lets go of, as the overview tells
 * (the wireframe's words for a thread's strip): an agent works in it, so it
 * stays; another place holds it, so it stays there; else it closes in the
 * Environment once nothing views it. Nothing known of it: it closes. */
export function releaseText(
  tab: Pick<StripTab, "agents" | "holders"> | null,
  copy: NewTabCopy,
): string {
  if (tab !== null && tab.agents.length > 0) return copy.releasedAgent;
  const others = (tab?.holders ?? []).filter(
    (hold) => hold.strip !== launchpadStrip,
  );
  if (others.length === 0) return copy.closing;
  const places = [
    ...new Set(
      others.map((hold) =>
        stripAppOf(hold.strip) !== "t3code"
          ? copy.placeElsewhere
          : hold.label.trim() === ""
            ? copy.placeOtherThread
            : fill(copy.placeThread, { thread: hold.label }),
      ),
    ),
  ];
  const last = places.pop() ?? "";
  return fill(copy.releasedElsewhere, {
    places:
      places.length === 0
        ? last
        : `${places.join(", ")}${copy.placesAnd}${last}`,
  });
}

/** A tab the Launchpad lets go of ends, as the overview tells: no agent
 * works in it and no other place holds it, so it closes in the Environment
 * once nothing views it (`releaseText`'s "closes"). Nothing known of it: it
 * ends. */
const releaseEnds = (tab: Pick<StripTab, "agents" | "holders"> | null) =>
  tab === null ||
  (tab.agents.length === 0 &&
    tab.holders.every((hold) => hold.strip === launchpadStrip));

/** The Vrátit of one command of the strip, its × or a close of a tab's menu
 * (F47 point 9's addendum of 2026-10-13): every tab the command let go of,
 * in the strip's order; what happens to them, one in `releaseText`'s words,
 * several as all closing, all staying or some of each; the one of them the
 * panel showed, shown there again; and whether one of them ends, which a
 * later command that ends none never takes away (`replacesUndo`). Null when
 * the command let go of no tab, a Nová karta alone. */
export function letGoUndo(
  tabs: readonly Readonly<{
    id: string;
    tab: Pick<StripTab, "agents" | "holders"> | null;
  }>[],
  shown: string | null,
  copy: NewTabCopy,
): PendingUndo | null {
  const [one, ...more] = tabs;
  if (one === undefined) return null;
  const ending = tabs.filter((entry) => releaseEnds(entry.tab)).length;
  return {
    tabs: tabs.map((entry) => entry.id),
    text:
      more.length === 0
        ? releaseText(one.tab, copy)
        : ending === tabs.length
          ? copy.closingTabs
          : ending === 0
            ? copy.releasedTabsStay
            : copy.releasedTabsSome,
    shown: tabs.some((entry) => entry.id === shown) ? shown : null,
    ends: ending > 0,
  };
}

/** Until when the strip offers the Vrátit of a command whose first release
 * request went at `sentAt`: 1 s less than the hub's grace, which begins no
 * earlier than that request (`browserTimes.undoMs`, decision F50 point 2),
 * so Vrátit never outlives the tab. */
export function letGoUndoUntil(sentAt: number): number {
  return sentAt + browserTimes.undoMs;
}

/** Why letting go of `failed` of a command's tabs failed, in Nová karta's
 * words: the cause where the answer names it, else that the tab, or the
 * tabs, could not be taken out of the Launchpad. */
export function releaseFailure(
  answer: NewTabAnswer,
  copy: NewTabCopy,
  failed: number,
): string {
  return actionFailure(
    answer,
    failed > 1 ? copy.releaseTabsFailed : copy.releaseFailed,
    copy,
  );
}

/** What Nová karta's choice shows in the Launchpad's panel: a page it opened
 * (the Launchpad already holds it) or a tab it chose (which the Launchpad
 * holds before it shows it). The Launchpad has no tools, so a tool is
 * nothing, and so is anything not a choice. */
export function panelChoice(
  detail: unknown,
): Readonly<{ kind: "page" | "tab"; tab: string }> | null {
  const choice = parseNewTabChoice(detail);
  return choice === null || choice.kind === "tool"
    ? null
    : { kind: choice.kind, tab: choice.tab };
}
