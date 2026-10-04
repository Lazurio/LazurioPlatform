import type { OpenApps } from "./account";

// Where a module's app opens (root decision 0185 S18): one setting of the
// person's account, "tab" (a new tab, the default and the behaviour without
// the account) or "same" (this window navigates to the app's own address).
// It applies to the tiles, to the favourites in the Apps column and to
// "Otevřít aplikaci" on the module's information page. An app is never
// embedded in a frame. Pure but for the window passed in.

/** How a link to a module's app on its own origin opens. */
export function appLinkTarget(
  mode: OpenApps,
): Readonly<{ target: "_blank" | null; rel: string }> {
  return mode === "same"
    ? { target: null, rel: "noreferrer" }
    : { target: "_blank", rel: "noopener noreferrer" };
}

/** A new tab, opened at the click. */
export type AppTab = Readonly<{
  close: () => void;
  navigate: (href: string) => void;
}>;

/** What the start-then-open flow of a workstation does with the browser. */
export type AppWindow = Readonly<{
  /** Opens a blank tab now, within the click, or null (blocked). */
  open: () => AppTab | null;
  /** Navigates this window. */
  assign: (href: string) => void;
}>;

/** A workstation's tile: start the app through the lifecycle (`start`
 * resolves to the link it reports, or null), then open that link where the
 * account says. For a new tab the tab is opened within the click, before
 * anything is awaited, because a tab opened later is a blocked pop-up; for
 * this window nothing moves until the start succeeded. Resolves whether the
 * app opened; on false the caller shows why (a tab opened for it is closed). */
export async function startThenOpen(
  mode: OpenApps,
  start: () => Promise<string | null>,
  browser: AppWindow,
): Promise<boolean> {
  const tab = mode === "tab" ? browser.open() : null;
  let link: string | null = null;
  try {
    link = await start();
  } catch {
    link = null;
  }
  if (link !== null && mode === "same") {
    browser.assign(link);
    return true;
  }
  if (link !== null && tab !== null) {
    tab.navigate(link);
    return true;
  }
  tab?.close();
  return false;
}
