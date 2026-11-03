import { isAbsolute, join } from "node:path";
import type { TabOpener } from "../contract/platform";
import { browserBounds, isStrip, targetIdOf } from "../contract/pure";
import { sleepableAddress } from "./sleep";

/** Remembered tabs of the Environment browser (decision F57's addendum of
 * 2026-11-03): the last web address of every tab, by the id its links name,
 * kept after the tab ended. A link to a tab is sent into a chat and clicked
 * a day later, when the tab ended long ago (nothing held it, its agent's
 * daemon idled out, the browser or the Environment restarted). Viewing such
 * a link opens the address again under the same id, as viewing a tab that
 * sleeps does, so a link to a tab keeps working. Only the address, title,
 * icon and opener are kept, never the page's content; the browser's own
 * history holds as much. */

/** How long and how many: a record goes 30 days after its tab was last
 * seen, and past `maxRemembered` the least recently seen go first. A tab
 * that still exists, awake or asleep, counts as seen: the hub marks it seen
 * again every `refreshMs`, and looks for records to let go on the same beat,
 * whether anything else changed or not. */
export const rememberTimes = Object.freeze({
  keepMs: 30 * 24 * 60 * 60_000,
  refreshMs: 60 * 60_000,
  /** How soon after a change the records are written down, one write at a
   * time. */
  writeAfterMs: 2_000,
});
export const maxRemembered = 2_000;

/** The most text the records take on disk. The writer leaves out the least
 * recently seen until the text fits (`rememberedText`), and the reader takes
 * a text up to this size, so whatever is written is read back. 2000 records
 * at the longest address and icon fit with room to spare. */
export const maxRememberedText = 16 * 1024 * 1024;

/** One tab as the hub remembers it. Times are the hub's milliseconds
 * (`Date.now()`). */
export type RememberedTab = Readonly<{
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  opener: TabOpener;
  openedAt: number;
  /** When the hub last saw the tab with this address, awake. */
  seenAt: number;
}>;

export const rememberedSchema = "lazurio.browser-remembered.v1";

/** Where the records live: `${XDG_STATE_HOME:-~/.local/state}/lazurio/
 * browser/remembered-tabs.json`, owner-only. State, not runtime: unlike the
 * tabs that sleep (`sleep.json`), they outlast a restart of the browser and
 * a reboot, because the links that name them do. Undefined without an
 * absolute HOME. */
export function rememberedPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const state = env.XDG_STATE_HOME;
  if (state !== undefined && state !== "" && isAbsolute(state))
    return join(state, "lazurio", "browser", "remembered-tabs.json");
  const home = env.HOME;
  return home !== undefined && isAbsolute(home)
    ? join(
        home,
        ".local",
        "state",
        "lazurio",
        "browser",
        "remembered-tabs.json",
      )
    : undefined;
}

/** The text of the records, least recently seen first: only records the
 * reader takes (`rememberedTabOf`), at most `maxRemembered`, and the least
 * recently seen left out until the text fits `maxRememberedText`. */
export function rememberedText(
  records: Iterable<RememberedTab>,
  maxText = maxRememberedText,
): string {
  const lines: string[] = [];
  for (const record of [...records]
    .filter((record) => rememberedTabOf(record) !== null)
    .sort((a, b) => a.seenAt - b.seenAt)
    .slice(-maxRemembered))
    lines.push(JSON.stringify(record));
  const head = `{"schema":${JSON.stringify(rememberedSchema)},"tabs":[`;
  const tail = "]}\n";
  let size = head.length + tail.length;
  let from = lines.length;
  // From the most recently seen back, as long as each fits with its comma.
  while (from > 0) {
    const next = (lines[from - 1] as string).length + 1;
    if (size + next > maxText) break;
    size += next;
    from -= 1;
  }
  return `${head}${lines.slice(from).join(",")}${tail}`;
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

/** A record the hub may keep and read back, normalized; null for one it
 * may not. The hub checks a tab with it before it remembers it, so it never
 * writes a record the reader drops: an address longer than the bound is not
 * remembered at all, never cut. */
export function rememberedTabOf(value: unknown): RememberedTab | null {
  if (!isRecord(value)) return null;
  const id = targetIdOf(value.id);
  const url = typeof value.url === "string" ? value.url : "";
  if (
    id === null ||
    url.length > browserBounds.addressLength ||
    !sleepableAddress(url) ||
    typeof value.title !== "string" ||
    !time(value.openedAt) ||
    !time(value.seenAt)
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
    seenAt: value.seenAt,
  };
}

/** The written records still kept at `now`, least recently seen first, at
 * most `maxRemembered`; an empty list for a text that is not one. A record
 * that is not one is left out, and of two with one id the later seen
 * counts. */
export function parseRemembered(
  text: string,
  now: number,
  keepMs: number = rememberTimes.keepMs,
): RememberedTab[] {
  if (text.length > maxRememberedText) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (
    !isRecord(value) ||
    value.schema !== rememberedSchema ||
    !Array.isArray(value.tabs)
  )
    return [];
  const byId = new Map<string, RememberedTab>();
  for (const item of value.tabs) {
    const tab = rememberedTabOf(item);
    if (tab === null || now - tab.seenAt > keepMs) continue;
    const before = byId.get(tab.id);
    if (before === undefined || before.seenAt <= tab.seenAt)
      byId.set(tab.id, tab);
  }
  return [...byId.values()]
    .sort((a, b) => a.seenAt - b.seenAt)
    .slice(-maxRemembered);
}
