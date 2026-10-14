import { browserViewUrl, viewPathTab } from "../contract/pure";
import type { Picture } from "./protocol";

/** The bar of the people's view (decision F39 point 1 and its addendum of
 * 2026-10-13): what its controls decide, as pure functions. The view page's
 * script (`client.ts`) applies them to its DOM; the tests run them without
 * one. */

/** Where the person's picture quality is kept: the browser's storage of the
 * view's origin. Every Environment has a view origin of its own, so the
 * choice holds for one Environment on this device. */
export const pictureKey = "lazurio.view.picture";

/** A picture quality from text (the stored value, a menu item's): only
 * `saver` is Data saver; nothing and anything else is Standard, the picture
 * as it always was. */
export function pictureOf(value: string | null | undefined): Picture {
  return value === "saver" ? "saver" : "standard";
}

/** The menu item a key moves the focus to, from `index` among `count` items
 * (-1 when none has it): the arrows step and wrap, Home and End go to the
 * ends. Null for any other key, which the menu leaves alone. */
export function menuStep(
  key: string,
  index: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return index < 0 ? 0 : (index + 1) % count;
    case "ArrowUp":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** What "Otevřít samostatně" opens: the view's own address of the tab shown,
 * `<origin>/t/<id>`, for a new tab of the person's browser. Only a view
 * inside an app's frame (`embedded`) has the button; a view that is a tab of
 * its own, or has no tab yet, gets null. */
export function aloneAddress(
  embedded: boolean,
  origin: string,
  tab: string | null,
): string | null {
  return embedded && tab !== null ? browserViewUrl(origin, tab) : null;
}

/** How the view names its own tab to the app around it (C8, decision F50
 * point 2): the tab's view address in the contract's form, by the tab it
 * shows, else by its page's path, whatever else its address says (a query,
 * a slash, an id in lower case), which an app would refuse. Null without a
 * tab. */
export function ownTabView(
  origin: string,
  shown: string | null,
  path: string,
): string | null {
  const tab = shown ?? viewPathTab(path);
  return tab === null ? null : browserViewUrl(origin, tab);
}
