import type { BrowserEntry } from "./units";

/** Where a person sees the Environment browser (decisions F38 and F39): the
 * people's view on the gateway's `browser.` origin. The address of one remote
 * tab is `<origin>/t/<target id>`, and `<origin>/` opens a new one. Neither
 * carries a token: the gateway's session is the only admission (F39 point
 * 8). The Launchpad answers these addresses for the panels and the links. */

/** An agent-browser session name as agent-browser accepts it
 * (`[A-Za-z0-9_-]`, `cli/src/validation.rs`), at most 64 characters. */
export const isBrowserSession = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** The answer of `GET /.lazurio/browser.json`: where the view of one
 * thread's tab (or a new tab) is, or that this Environment has none. */
export type BrowserView =
  | Readonly<{ available: true; view: string; session: string | null }>
  | Readonly<{ available: false; reason: BrowserViewReason }>;

export const browserViewReasons = [
  /** The recorded entry has no `browser`: no view is routed here. */
  "not-declared",
  /** The thread's window could not be found or opened. */
  "view-unavailable",
] as const;
export type BrowserViewReason = (typeof browserViewReasons)[number];

export type BrowserViewSeams = Readonly<{
  /** The session's window, opened when it has none, exactly as `lazurio
   * browser window` does (`ensureThreadWindow`): the person and the thread's
   * agent always see the same tab. */
  openWindow: (session: string) => Promise<Readonly<{ targetId: string }>>;
}>;

/** The view of one remote tab, or of a new one without a target. */
export function browserViewUrl(
  origin: string,
  targetId: string | null,
): string {
  return targetId === null ? `${origin}/` : `${origin}/t/${targetId}`;
}

export async function resolveBrowserView(
  entry: BrowserEntry | undefined,
  session: string | null,
  seams: BrowserViewSeams,
): Promise<BrowserView> {
  if (entry === undefined)
    return Object.freeze({ available: false, reason: "not-declared" });
  // Without a session (the Launchpad's panel): a new remote tab. The view of
  // every window is retired (root decision 0191 point 18).
  if (session === null)
    return Object.freeze({
      available: true,
      view: browserViewUrl(entry.origin, null),
      session: null,
    });
  const window = await seams.openWindow(session).catch(() => null);
  if (window === null)
    return Object.freeze({ available: false, reason: "view-unavailable" });
  return Object.freeze({
    available: true,
    view: browserViewUrl(entry.origin, window.targetId),
    session,
  });
}

/** The recorded entry's browser members as the view takes them. */
export const browserEntryOf = (
  entry:
    | Readonly<{ browserOrigin?: string; browserListenPort?: number }>
    | null
    | undefined,
): BrowserEntry | undefined =>
  entry?.browserOrigin === undefined || entry.browserListenPort === undefined
    ? undefined
    : Object.freeze({
        origin: entry.browserOrigin,
        listenPort: entry.browserListenPort,
      });
