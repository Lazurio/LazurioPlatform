import { browserBounds, isStrip, targetIdOf } from "./pure";

// The Environment browser's contract, its Platform-internal shapes (decision
// F50 point 2): the hub's loopback requests (C11) and the Launchpad's view
// routes (C12). They live in the module so the hub and its client, and the
// route and the panel that reads it, share one definition; one release
// serves both ends of each. They are no part of the forks' promise: the
// release's shell artifact ships only the pure and the Node part, no fork
// calls the hub, and the vectors, which the forks run, carry no case of
// them. Pure, like the pure part. Licensed under MIT with the rest of the
// module (`LICENSE`, F50 point 6).

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---- The hub's loopback requests (C11) ----------------------------------------

/** The list of tabs (`GET`, `?heap=1` with each tab's heap) and a new tab
 * (`POST {url, strip?}` → 201 `{id, view}`), on the view service's loopback
 * port only, from a caller that names no `Origin` and no `Sec-Fetch-Site`
 * (F47 point 6). */
export const hubTabsPath = "/.lazurio/tabs";

/** A close for everyone (→ 202 `{closing}`) or Vrátit (→ `{restored: true}`)
 * of one tab. */
export type HubTabAction = "close" | "restore";

/** The path of a tab's action, `/.lazurio/tabs/<id>/<action>`. */
export function hubTabPath(tab: string, action: HubTabAction): string {
  return `${hubTabsPath}/${tab}/${action}`;
}

const hubPathPattern = /^\/\.lazurio\/tabs(?:\/([^/]+)\/(close|restore))?$/;

/** The request a path of the hub names: the list or a new tab, a tab's
 * action by its id in either case, given in upper case (decision F50, C1);
 * null for a path of no such request. */
export function hubRequestOf(
  path: string,
):
  | Readonly<{ kind: "tabs" }>
  | Readonly<{ kind: HubTabAction; targetId: string }>
  | null {
  const found = hubPathPattern.exec(path);
  if (found === null) return null;
  const named = found[1];
  if (named === undefined) return { kind: "tabs" };
  const targetId = targetIdOf(named);
  return targetId === null
    ? null
    : { kind: found[2] as HubTabAction, targetId };
}

/** Who opened a tab, as far as the hub knows: the people's view (`/`), Nová
 * karta (through the loopback request), a page (its new tab or pop-up), an
 * agent (a session bound to it), or nobody it knows of (a tab from before
 * the service started). */
export type TabOpener =
  | Readonly<{ kind: "view" }>
  | Readonly<{ kind: "new-tab"; strip: string | null }>
  | Readonly<{ kind: "page"; openerId: string }>
  | Readonly<{ kind: "agent"; session: string }>
  | Readonly<{ kind: "unknown" }>;

/** Why a tab nothing holds or views is counting down (F47 point 5). */
export type GraceKind = "release" | "viewer" | "unviewed";

/** A strip that holds a tab, by its holder file. */
export type TabHold = Readonly<{ strip: string; label: string }>;

/** One remote tab as the loopback list reports it (F47 point 6). */
export type TabFacts = Readonly<{
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  openedAt: string;
  usedAt: string;
  opener: TabOpener;
  /** The sessions whose agent works in it now. */
  agents: readonly string[];
  holders: readonly TabHold[];
  viewers: number;
  /** When a close for everyone ends it, unless restored. */
  closing: string | null;
  grace: Readonly<{ kind: GraceKind; endsAt: string }> | null;
  /** Its JavaScript heap in bytes, the overview's estimate marked "≈" (F47
   * point 7): only in a list asked for with `heap=1`, null where it could
   * not be read in time. */
  heap?: Readonly<{ used: number; total: number }> | null;
}>;

const graceKinds: readonly GraceKind[] = ["release", "viewer", "unviewed"];

/** A time the hub wrote with `toISOString`, or null. */
export function hubTime(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

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

function heapOf(
  value: unknown,
): Readonly<{ used: number; total: number }> | null {
  if (!isRecord(value)) return null;
  const { used, total } = value;
  return typeof used === "number" &&
    typeof total === "number" &&
    Number.isFinite(used) &&
    Number.isFinite(total) &&
    used >= 0 &&
    total >= 0
    ? { used, total }
    : null;
}

/** One tab of the hub's list in the hub's shape, or null: an element without
 * an id, an address, a title, its times or its viewers is left out, and the
 * texts are cut for display. `heap` is read only when it was asked for. */
export function parseHubTab(value: unknown, heap: boolean): TabFacts | null {
  if (!isRecord(value)) return null;
  const id = targetIdOf(value.id);
  const openedAt = hubTime(value.openedAt);
  const usedAt = hubTime(value.usedAt);
  const viewers = value.viewers;
  if (
    id === null ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    openedAt === null ||
    usedAt === null ||
    typeof viewers !== "number" ||
    !Number.isSafeInteger(viewers) ||
    viewers < 0
  )
    return null;
  const grace = isRecord(value.grace) ? value.grace : null;
  const graceEnds = hubTime(grace?.endsAt);
  const favicon = value.favicon;
  const facts: TabFacts = {
    id,
    url: value.url.slice(0, browserBounds.addressLength),
    title: value.title.slice(0, browserBounds.titleLength),
    favicon:
      typeof favicon === "string" &&
      favicon.startsWith("https://") &&
      favicon.length <= browserBounds.addressLength
        ? favicon
        : null,
    openedAt,
    usedAt,
    opener: openerOf(value.opener),
    agents: Array.isArray(value.agents) ? value.agents.filter(isStrip) : [],
    holders: Array.isArray(value.holders)
      ? value.holders.flatMap((hold: unknown) =>
          isRecord(hold) && isStrip(hold.strip)
            ? [
                {
                  strip: hold.strip,
                  label:
                    typeof hold.label === "string"
                      ? hold.label.slice(0, browserBounds.holderLabelLength)
                      : "",
                },
              ]
            : [],
        )
      : [],
    viewers,
    closing: hubTime(value.closing),
    grace:
      grace !== null &&
      graceKinds.includes(grace.kind as GraceKind) &&
      graceEnds !== null
        ? { kind: grace.kind as GraceKind, endsAt: graceEnds }
        : null,
  };
  return heap ? { ...facts, heap: heapOf(value.heap) } : facts;
}

/** The hub's answers: the list, a new tab, a close for everyone, Vrátit,
 * each with the status the hub answers it with. */
export type HubOpened = Readonly<{ id: string; view: string }>;
export type HubClosing = Readonly<{ closing: string }>;
export type HubRestored = Readonly<{ restored: true }>;

// ---- The Launchpad's view routes (C12) ----------------------------------------

/** `GET /.lazurio/browser.json[?session=<name>]`: where the view of a
 * session's tab (or a new tab) is, or that this Environment has none
 * (`BrowserView`). The `session` query serves T3 Code 0.0.45-lazurio.7 until
 * lazurio.8 runs everywhere. */
export const browserViewDocumentPath = "/.lazurio/browser.json";

/** `GET /.lazurio/browser[?session=<name>]`: the Launchpad's hand-over, a
 * redirect to that view (`lazurio browser link`). */
export const browserViewPath = "/.lazurio/browser";

/** Why an Environment answers no view. */
export const browserViewReasons = [
  /** The recorded entry has no `browser`: no view is routed here. */
  "not-declared",
  /** The thread's window could not be found or opened. */
  "view-unavailable",
] as const;
export type BrowserViewReason = (typeof browserViewReasons)[number];

/** The answer of `GET /.lazurio/browser.json`. */
export type BrowserView =
  | Readonly<{ available: true; view: string; session: string | null }>
  | Readonly<{ available: false; reason: BrowserViewReason }>;

/** The Launchpad's hand-over to a session's tab, on its own origin: it opens
 * the window when the session has none. */
export function browserHandoverUrl(
  launchpadOrigin: string,
  session: string,
): string {
  return `${launchpadOrigin}${browserViewPath}?session=${session}`;
}
