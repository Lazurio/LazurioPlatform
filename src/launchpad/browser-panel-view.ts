import { browserViewUrl } from "../browser/view";
import { isTargetId, parseNewTabChoice } from "../shell/new-tab-protocol";
import type { PublicEntry } from "./chat";
import {
  actionFailure,
  fill,
  hideAnswered,
  hideAsked,
  isNoBrowser,
  launchpadStrip,
  type NewTabAnswer,
  type NewTabCopy,
  type NewTabOverview,
  type NewTabTab,
  settleOverrides,
  type TabOverride,
  withOverride,
} from "./new-tab-view";

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207; decision F47 point 9 and its addendum
// of 2026-10-12): the strip of the tabs the Launchpad holds, read from Nová
// karta's overview every 5 s while the panel is open, and under it either one
// tab's view (decision F39, the same view every app of the Environment
// embeds; the Launchpad builds no viewer of its own) or Nová karta, the shell
// element `<lazurio-new-tab strip="launchpad" focus-address>`. The first
// opening shows Nová karta, and so does the strip once its last tab goes. ×
// lets go of the Launchpad's hold, with Vrátit while the hub's grace lasts;
// closing a tab for everyone is Přehled's Zavřít. The panel is offered only
// where the recorded entry routes the view (`browserOrigin`): never on a
// workstation, which has no entry, and never in Recovery mode. A view is
// framed only on exactly the recorded origin. Pure: the DOM
// (browser-panel.ts) only draws this and asks.

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
 * its own origin, cookie and scripts, and cannot navigate this page. */
export const browserFrame = Object.freeze({
  allow: "clipboard-read; clipboard-write; fullscreen",
  referrerpolicy: "no-referrer",
  sandbox:
    "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals",
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
 * `{available: true, view}` whose `view` is an https URL on exactly `origin`
 * (the recorded `browserOrigin`), without credentials, as written. Never on
 * the page's own origin: the sandbox confines the frame only while it is
 * another origin. Anything else is null. */
export function browserViewAddress(
  answer: unknown,
  origin: string,
  pageOrigin: string,
): string | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { available, view } = answer as Record<string, unknown>;
  if (available !== true || typeof view !== "string") return null;
  try {
    const url = new URL(view);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.origin === pageOrigin ||
      url.username ||
      url.password ||
      url.href !== view
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The view of one remote tab that the panel frames, under the same check
 * as any view: null for anything but a tab id on the recorded origin. */
export function tabViewAddress(
  origin: string,
  tab: string,
  pageOrigin: string,
): string | null {
  if (!isTargetId(tab)) return null;
  return browserViewAddress(
    { available: true, view: browserViewUrl(origin, tab.toUpperCase()) },
    origin,
    pageOrigin,
  );
}

/** The remote tab a view address shows: `<origin>/t/<id>` on exactly the
 * view's origin; null otherwise. */
export function viewTabOf(view: unknown, origin: string): string | null {
  if (typeof view !== "string" || view.length > 512) return null;
  try {
    const url = new URL(view);
    if (url.origin !== origin || url.username || url.password) return null;
    const tab = /^\/t\/([0-9A-Fa-f]{32})$/.exec(url.pathname)?.[1];
    return tab === undefined ? null : tab.toUpperCase();
  } catch {
    return null;
  }
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
  /** A Nová karta of the strip. */
  newTab: boolean;
  /** What the panel shows; null until its first opening. */
  active:
    | Readonly<{ kind: "new" }>
    | Readonly<{ kind: "tab"; id: string }>
    | null;
  /** Grows with every "+", so each shows a fresh Nová karta. */
  generation: number;
}>;

export const emptyStrip: StripState = Object.freeze({
  listed: null,
  overrides: [],
  live: [],
  order: [],
  requests: 0,
  newTab: false,
  active: null,
  generation: 0,
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
      /** Its × shows only beside other tabs: an empty strip is Nová
       * karta. */
      closable: boolean;
    }>;

const sameEntry = (
  entry: StripEntry,
  active: NonNullable<StripState["active"]>,
): boolean =>
  entry.kind === active.kind &&
  (entry.kind === "new" || (active.kind === "tab" && entry.id === active.id));

/** The strip (F47 point 9's addendum of 2026-10-12): the tabs the Launchpad
 * holds, as the overview says, and those it took here before an overview
 * says so; none taken away here, and none whose close for everyone counts
 * down unless brought back here. In the order the strip first had them,
 * then its Nová karta; with nothing in it the strip is Nová karta. Every
 * other tab of the Environment is in Přehled only. */
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
  if (state.newTab || entries.length === 0)
    entries.push({ kind: "new", closable: entries.length > 0 });
  return entries;
}

/** The entry the panel shows. */
export function shownEntry(state: StripState): StripEntry {
  const entries = stripEntries(state);
  const active = state.active;
  return (
    entries.find((entry) => active !== null && sameEntry(entry, active)) ??
    entries.find((entry) => entry.kind === "new") ??
    (entries[entries.length - 1] as StripEntry)
  );
}

export type StripEvent =
  /** The panel opened: the first opening shows Nová karta. */
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
  /** "+": a fresh Nová karta. */
  | Readonly<{ kind: "new-tab" }>
  | Readonly<{ kind: "select"; entry: "new" | string }>
  /** × on the Nová karta. */
  | Readonly<{ kind: "close-new-tab" }>
  /** Nová karta became this tab, which the Launchpad now holds: a page it
   * opened, or a tab chosen in its Přehled and held. */
  | Readonly<{ kind: "chosen"; tab: string }>
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

function apply(state: StripState, event: StripEvent): StripState {
  const after = state.requests;
  switch (event.kind) {
    case "opened":
      return state.active === null
        ? { ...state, newTab: true, active: { kind: "new" } }
        : state;
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
      return {
        ...state,
        newTab: true,
        active: { kind: "new" },
        generation: state.generation + 1,
      };
    case "select":
      return event.entry === "new"
        ? { ...state, newTab: true, active: { kind: "new" } }
        : { ...state, active: { kind: "tab", id: event.entry } };
    case "close-new-tab":
      return { ...state, newTab: false };
    case "chosen":
      return {
        ...state,
        newTab: false,
        overrides: withOverride(state.overrides, event.tab, "shown", after),
        active: { kind: "tab", id: event.tab },
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
        active: { kind: "tab", id: event.tab },
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
        active: event.show ? { kind: "tab", id: event.tab } : state.active,
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

/** The strip after `event`. When what the panel showed is gone from the
 * strip (released, ended, or held no more), it shows the entry that took its
 * place, else the one before it, and with nothing left Nová karta. A tab new
 * to the strip takes the last place in its order. */
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
  if (entries.some((entry) => sameEntry(entry, active)))
    return active.kind === "new" && !next.newTab
      ? { ...next, newTab: true }
      : next;
  const before = stripEntries(state);
  const at = before.findIndex((entry) => sameEntry(entry, active));
  const rest = before.filter((entry) =>
    entries.some(
      (left) =>
        left.kind === entry.kind &&
        (left.kind === "new" || (entry.kind === "tab" && left.id === entry.id)),
    ),
  );
  const neighbour =
    at < 0 ? rest[rest.length - 1] : rest[Math.min(at, rest.length - 1)];
  return neighbour?.kind === "tab"
    ? { ...next, active: { kind: "tab", id: neighbour.id } }
    : { ...next, newTab: true, active: { kind: "new" } };
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
        !hold.strip.startsWith("t3-")
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
