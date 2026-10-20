import type { SleepReason, TabOpener } from "../contract/platform";
import {
  browserBounds,
  isStrip,
  navigableAddress,
  targetIdOf,
} from "../contract/pure";

/** Sleeping tabs of the Environment browser (decision F57): the rules the
 * view's hub applies, kept apart from its connection so they read and test
 * on their own. A tab sleeps when the hub closes its remote tab and keeps a
 * record of it, its tombstone: its id, address, title and icon and who
 * opened it. Every place that holds or lists the tab keeps it by that id.
 * Viewing it, or Probudit, opens its address again in a window of its own,
 * under the same id. No Chrome capability beyond DevTools and no extension. */

/** The times of sleep, in milliseconds. */
export const sleepTimes = Object.freeze({
  /** A held tab sleeps once nobody has viewed it, no agent has worked in
   * it, and its page has had no input and no navigation for this long. An
   * agent counts for as long after the hub last saw its agent-browser
   * daemon run. */
  idleMs: 20 * 60_000,
  /** How long the hub waits for a page it asked to close (`Page.close`, so
   * its `beforeunload` may object) before it keeps the tab awake. */
  closeWaitMs: 5_000,
  /** A tab that did not open again when someone waits for it is tried again
   * after this long. */
  wakeRetryMs: 2_000,
});

/** The most tombstones the hub keeps; past it the oldest asleep end, as a
 * tab that nothing holds ends. Each costs a few hundred bytes. */
export const maxSleeping = browserBounds.holderTabs;

/** What makes two addresses the same page for "no duplicate opens": the
 * origin and the path, without the query and the fragment. Null for an
 * address that is not http(s). */
export function addressKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** An address a tab can sleep with: one the hub opens again by itself, an
 * http(s) page (never `about:blank`, an error page, a `chrome:` page or the
 * view host of an Environment browser). */
export function sleepableAddress(url: string): boolean {
  return addressKey(url) !== null && navigableAddress(url) !== null;
}

/** The quiet clock of one tab: the latest of when it opened or woke, when
 * someone last viewed it, when an agent last worked in it, when its page
 * last had input or navigated, and when the hub last found unsaved input in
 * it. Milliseconds of the hub's clock. */
export type Quiet = Readonly<{
  openedAt: number;
  viewedAt: number;
  agentAt: number;
  activeAt: number;
  unsavedAt: number;
}>;

export function quietSince(quiet: Quiet): number {
  return Math.max(
    quiet.openedAt,
    quiet.viewedAt,
    quiet.agentAt,
    quiet.activeAt,
    quiet.unsavedAt,
  );
}

/** The page side of "no input for a while" (decision F57): run in the view's
 * isolated world, which the page's own scripts cannot reach, it listens for
 * trusted input in the main frame, an agent's through its own DevTools
 * connection (T3 Code's browser tools, Playwright) as well as a viewer's,
 * and answers how many milliseconds ago the last came, or null before any.
 * The hub runs it when a document commits, so it hears every input of the
 * document; the navigation itself the hub counts on its own. Only the hub
 * reads it; nothing is reported to the page. */
export const activityScript = `(() => {
  const key = "__lazurioActivity";
  let state = globalThis[key];
  if (state === undefined) {
    state = { at: null };
    const mark = (event) => { if (event.isTrusted) state.at = Date.now(); };
    for (const type of ["pointerdown", "keydown", "input", "wheel", "touchstart"])
      addEventListener(type, mark, { capture: true, passive: true });
    globalThis[key] = state;
  }
  return state.at === null ? null : Math.max(0, Date.now() - state.at);
})()`;

/** Unsaved input (decision F57): true when the focused field of the page, in
 * an open shadow root or a same-origin frame too, differs from what the page
 * gave it: a text field or text area whose value is not its default, a
 * checkbox or radio button changed, a file chosen, a select changed. A
 * focused rich editor (`contenteditable`) has no default to compare with;
 * the page's own `beforeunload` speaks for it. Run in the view's isolated
 * world; it reads, changes nothing and returns only the answer. */
export const unsavedInputScript = `(() => {
  let el = document.activeElement;
  for (let depth = 0; el && depth < 8; depth++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument ? el.contentDocument.activeElement : null; } catch {}
      if (inner) { el = inner; continue; }
    }
    break;
  }
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return el.value !== el.defaultValue;
  if (el.tagName === "SELECT") return Array.from(el.options).some((o) => o.selected !== o.defaultSelected);
  if (el.tagName !== "INPUT") return false;
  const type = String(el.type).toLowerCase();
  if (type === "checkbox" || type === "radio") return el.checked !== el.defaultChecked;
  if (type === "file") return Boolean(el.files && el.files.length > 0);
  if (["button", "submit", "reset", "image", "hidden"].includes(type)) return false;
  return el.value !== el.defaultValue;
})()`;

/** One tombstone as the hub keeps it and writes it down. Times are the
 * hub's milliseconds (`Date.now()`), as the list shows them. */
export type SleepRecord = Readonly<{
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  opener: TabOpener;
  openedAt: number;
  usedAt: number;
  sleptAt: number;
  reason: SleepReason;
}>;

/** What the hub writes down so a restart of the view keeps the tabs that
 * sleep and the ids of the tabs that woke (decision F57): the browser's own
 * id (`CdpConnection.browser`), each tombstone, and each woken tab's live
 * target with the id it keeps. Owner-only in the runtime directory, so it
 * goes at a reboot with the browser's tabs; a different browser id means
 * the browser restarted, and then nothing of it comes back (F38's addendum
 * of 2026-10-10). */
export type SleepState = Readonly<{
  browser: string;
  sleeping: readonly SleepRecord[];
  /** Live target id → the tab's id. */
  aliases: ReadonlyMap<string, string>;
}>;

export const sleepStateSchema = "lazurio.browser-sleep.v1";

const sleepReasons: readonly SleepReason[] = ["idle", "pressure", "asked"];

export function sleepStateText(state: SleepState): string {
  return `${JSON.stringify({
    schema: sleepStateSchema,
    browser: state.browser,
    sleeping: state.sleeping,
    aliases: Object.fromEntries(state.aliases),
  })}\n`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function openerOf(value: unknown): TabOpener {
  const unknown = { kind: "unknown" } as const;
  if (!isRecord(value)) return unknown;
  switch (value.kind) {
    case "view":
      return { kind: "view" };
    case "new-tab":
      return {
        kind: "new-tab",
        strip: isStrip(value.strip) ? value.strip : null,
      };
    case "page": {
      const id = targetIdOf(value.openerId);
      return id === null ? unknown : { kind: "page", openerId: id };
    }
    case "agent":
      return isStrip(value.session)
        ? { kind: "agent", session: value.session }
        : unknown;
    default:
      return unknown;
  }
}

function recordOf(value: unknown): SleepRecord | null {
  if (!isRecord(value)) return null;
  const id = targetIdOf(value.id);
  const url = typeof value.url === "string" ? value.url : "";
  if (
    id === null ||
    url.length > browserBounds.addressLength ||
    !sleepableAddress(url) ||
    typeof value.title !== "string" ||
    !time(value.openedAt) ||
    !time(value.usedAt) ||
    !time(value.sleptAt) ||
    !sleepReasons.includes(value.reason as SleepReason)
  )
    return null;
  const favicon = value.favicon;
  return {
    id,
    url,
    title: value.title.slice(0, browserBounds.titleLength),
    favicon:
      typeof favicon === "string" &&
      favicon.startsWith("https://") &&
      favicon.length <= browserBounds.addressLength
        ? favicon
        : null,
    opener: openerOf(value.opener),
    openedAt: value.openedAt,
    usedAt: value.usedAt,
    sleptAt: value.sleptAt,
    reason: value.reason as SleepReason,
  };
}

/** The written state, or null for a text that is not one. A record that is
 * not a tombstone is left out, and so is an alias that names no two ids. */
export function parseSleepState(text: string): SleepState | null {
  if (text.length > 4 * 1024 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schema !== sleepStateSchema ||
    typeof value.browser !== "string" ||
    value.browser === "" ||
    !Array.isArray(value.sleeping)
  )
    return null;
  const sleeping: SleepRecord[] = [];
  const seen = new Set<string>();
  for (const item of value.sleeping.slice(0, maxSleeping)) {
    const record = recordOf(item);
    if (record === null || seen.has(record.id)) continue;
    seen.add(record.id);
    sleeping.push(record);
  }
  const aliases = new Map<string, string>();
  if (isRecord(value.aliases))
    for (const [target, tab] of Object.entries(value.aliases)) {
      const live = targetIdOf(target);
      const id = targetIdOf(tab);
      if (live !== null && id !== null && live !== id) aliases.set(live, id);
    }
  return { browser: value.browser, sleeping, aliases };
}
