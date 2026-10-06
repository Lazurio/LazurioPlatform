import type { PublicEntry } from "./chat";
import type { MessageKey } from "./messages";

// The Launchpad's right panel (decision F38's addendum of 2026-10-05, root
// decision 0191 points 8a and 18, #207): the people's view of the Environment
// browser (decision F39), the same view every app of the Environment embeds
// in its right panel; the Launchpad builds no viewer of its own. The panel is
// offered only where the recorded entry routes the view (`browserOrigin`):
// never on a workstation, which has no entry, and never in Recovery mode.
// Opening it asks this origin for `GET /.lazurio/browser.json` without a
// session, which answers the view's `/`: a new remote tab, closed again a
// short while after the panel closes. The view of every window is retired.
// The panel embeds the view only when its address is an https URL on exactly
// the recorded origin, and asks again on every opening and every reload.
// Pure but for the fetch passed in.

type Copy = Readonly<Record<MessageKey, string>>;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The answer the panels read (the server's `browserViewDocumentPath`). */
export const browserViewDocumentPath = "/.lazurio/browser.json";
/** The hand-over (the server's `browserViewPath`): it redirects a link's
 * browser to the view, through the gateway's sign-in when the session has
 * expired. A frame cannot show that sign-in page; a new tab can. */
export const browserHandOverPath = "/.lazurio/browser";
/** How long the panel waits for the answer; without a session it is
 * immediate. */
export const browserViewReadMs = 20_000;

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

/** What the open panel shows: the answer still coming, the view, an
 * Environment browser that answered it is not available, or no answer that
 * can be used (an expired session,
 * a refusal, a timeout, an answer of another shape). */
export type BrowserPanelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "view"; view: string }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "failed" }>;

/** Asks this origin for the view of every window: same origin, the
 * gateway's session cookie and nothing else (no token, no session name), no
 * cache, no redirect followed (an expired session is a failure, never a
 * sign-in page to follow), given up after `timeoutMs`. Never throws. */
export async function readBrowserView(
  origin: string,
  pageOrigin: string,
  fetcher: Fetch = fetch,
  timeoutMs = browserViewReadMs,
): Promise<BrowserPanelState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(browserViewDocumentPath, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return Object.freeze({ kind: "failed" });
    const answer: unknown = await response.json();
    const view = browserViewAddress(answer, origin, pageOrigin);
    if (view !== null) return Object.freeze({ kind: "view", view });
    return Object.freeze({
      kind:
        typeof answer === "object" &&
        answer !== null &&
        (answer as { available?: unknown }).available === false
          ? "unavailable"
          : "failed",
    });
  } catch {
    return Object.freeze({ kind: "failed" });
  } finally {
    clearTimeout(timer);
  }
}

export type BrowserPanelView = Readonly<{
  /** The frame's address, or null: no frame. */
  frame: string | null;
  /** The one sentence the panel shows instead of the frame, or null. */
  message: string | null;
  /** Where "Open in a new tab" leads: the view once it is known, the
   * hand-over otherwise. */
  tab: string;
}>;

/** What the open panel draws for its state. */
export function browserPanelView(
  state: BrowserPanelState,
  copy: Copy,
): BrowserPanelView {
  switch (state.kind) {
    case "view":
      return { frame: state.view, message: null, tab: state.view };
    case "loading":
      return {
        frame: null,
        message: copy.browserLoading,
        tab: browserHandOverPath,
      };
    case "unavailable":
      return {
        frame: null,
        message: copy.browserUnavailable,
        tab: browserHandOverPath,
      };
    case "failed":
      return {
        frame: null,
        message: copy.browserFailed,
        tab: browserHandOverPath,
      };
  }
}
