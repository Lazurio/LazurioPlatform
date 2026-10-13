import {
  browserViewUrl,
  launchpadStrip,
  stripAppOf,
  targetIdOf,
  viewAddressOf,
} from "../browser/contract/pure";
import { parseNewTabChoice } from "../shell/new-tab-protocol";
import type { PublicEntry } from "./chat";
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
// Launchpad's hold, with Vrátit while the hub's grace lasts; closing a tab
// for everyone is Přehled's Zavřít. The person's × on the strip's last entry
// closes the panel, as T3 Code's does (root decision 0195 point 16). The
// panel is offered only where the recorded entry routes the view
// (`browserOrigin`): never on a workstation, which has no entry, and never in
// Recovery mode. A view is framed only on exactly the recorded origin. Pure:
// the DOM (browser-panel.ts) only draws this and asks.

/** `GET /.lazurio/browser.json` (the server's `browserViewDocumentPath`):
 * the view's address for a new tab, or that there is none. */
export const browserViewDocumentPath = "/.lazurio/browser.json";
/** The hand-over (the server's `browserViewPath`): it redirects a link's
 * browser to the view, through the gateway's sign-in when the session has
 * expired. A frame cannot show that sign-in page; a new tab can. */
export const browserHandOverPath = "/.lazurio/browser";

/** The frame's attributes. `allow` lets the view use the clipboard (copying
 * out of the Environment browser, pasting into it) and full screen; the
 * sandbox is the one of T3 Code's panel (Lazurio/t3code#41): the view keeps
 * its own origin, cookie and scripts, and cannot navigate this page. A tab
 * the view opens escapes the sandbox (`allow-popups-to-escape-sandbox`, F47
 * point 9's addendum of 2026-10-13), as a tab opened from Nová karta's frame
 * does (`newTabFrameSandbox`): the view's own "Otevřít samostatně" then opens
 * an ordinary tab of the person's browser, where without the flag the tab
 * would inherit this sandbox. The frame itself stays as confined. */
export const browserFrame = Object.freeze({
  allow: "clipboard-read; clipboard-write; fullscreen",
  referrerpolicy: "no-referrer",
  sandbox:
    "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
});

/** How often the strip reads the overview while the panel is open. */
export const stripEveryMs = 5_000;

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
  /** × on a Nová karta: that entry goes. It is no remote tab, so nothing
   * is let go of and there is no Vrátit. */
  | Readonly<{ kind: "close-new-tab"; key: string }>
  /** The Nová karta `from` became this tab, which the Launchpad now holds:
   * a page it opened, or a tab chosen in its Přehled and held. That Nová
   * karta goes, and the panel shows the tab. */
  | Readonly<{ kind: "chosen"; tab: string; from: string | null }>
  /** A tab the Launchpad now holds, to show: a page's new tab viewed here,
   * a sign-in an Integrace opened in the Environment browser. */
  | Readonly<{ kind: "show"; tab: string; url?: string | undefined }>
  /** × in the strip: the Launchpad lets go of the tab, which goes from the
   * strip at once and stays gone while the release is on its way
   * (`hideAsked`). */
  | Readonly<{ kind: "releasing"; tab: string }>
  /** The release is done: only an overview requested after now lifts the
   * hide (`hideAnswered`). */
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
    case "close-new-tab":
      return {
        ...state,
        newTabs: state.newTabs.filter((key) => key !== event.key),
      };
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
    case "releasing":
      return { ...state, overrides: hideAsked(state.overrides, event.tab) };
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

/** The person's own × on an entry of the strip. */
const closedByPerson = (event: StripEvent): boolean =>
  event.kind === "close-new-tab" || event.kind === "releasing";

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

// ---- What the frames say ----------------------------------------------------------

export type ViewMessage =
  /** The page opened a new tab (F39 point 4): held for the Launchpad, then
   * shown (F47 point 4). */
  | Readonly<{ kind: "new-tab"; tab: string; url: string }>
  /** The view's tab ended: it goes from the strip (F47 point 6). */
  | Readonly<{ kind: "closed"; tab: string }>
  /** Where the view's tab is now. */
  | Readonly<{ kind: "info"; tab: string; title: string; url: string }>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A message of the view frame (src/browser/people/client.ts), only from
 * that frame's window on the view's own origin, about a tab of that view;
 * null for anything else. */
export function viewMessage(
  event: Readonly<{ data: unknown; origin: string; fromFrame: boolean }>,
  viewOrigin: string | null,
): ViewMessage | null {
  if (!event.fromFrame || viewOrigin === null || event.origin !== viewOrigin)
    return null;
  const data = event.data;
  if (!isRecord(data)) return null;
  const tab = viewTabOf(data.view, viewOrigin);
  if (tab === null) return null;
  switch (data.type) {
    case "lazurio-browser:new-tab":
      return typeof data.url === "string"
        ? { kind: "new-tab", tab, url: data.url.slice(0, 2_048) }
        : null;
    case "lazurio-browser:closed":
      return { kind: "closed", tab };
    case "lazurio-browser:info":
      return typeof data.title === "string" && typeof data.url === "string"
        ? {
            kind: "info",
            tab,
            title: data.title.slice(0, 500),
            url: data.url.slice(0, 2_048),
          }
        : null;
    default:
      return null;
  }
}

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
 * again; a full holder can, once the person closed some tabs. */
export function holdFailure(
  answer: NewTabAnswer,
  copy: NewTabCopy,
  gone: string = copy.holdGone,
): Readonly<{ text: string; retry: boolean }> {
  const error = isRecord(answer.value) ? answer.value.error : undefined;
  if (answer.status === 404 && error === "not-found")
    return { text: gone, retry: false };
  if (answer.status === 409 && error === "too-many-tabs")
    return { text: copy.holdFull, retry: true };
  return {
    text: actionFailure(answer, copy.holdFailed, copy),
    retry: !isNoBrowser(answer) && error !== "holder-unavailable",
  };
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
