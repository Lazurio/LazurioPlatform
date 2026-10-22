import { baseCss, hostTokens } from "./base-styles";

// Buddy's bubble inside `<lazurio-buddy>`'s shadow root (decision F60): the
// launcher, a 58 px disc at the bottom right with Buddy's picture (without
// it the neutral guide's mark: the Lazurio symbol on a white disc), and his
// window, one `<dialog>` holding the frame: the panel above the launcher
// (about 400 × 600, never past the window's edges) or full screen, a modal
// over the page 760 px wide with the page dimmed behind it. Light, as the
// design system's floating layers are: the one floating shadow and a
// hairline; the window's own colours are the frame's.
//
// Layers: the launcher and the panel at z-index 45, above an app's own
// content and below the overlays a host keeps at its body (T3 Code's sheets
// from 46, both forks' dialogs from 50, menus, toasts and tooltips), so a
// dialog of the app is never covered; full screen is a modal in the top
// layer, and the guide's layer (guide-styles.ts) plays over all of it.
//
// Where it stands (`buddyLauncherOffset`): 20 px from the window's right and
// bottom edges in the Launchpad, whose corner holds nothing. In Chat and
// Automate (the column head's `active`) the bottom right is the composer's,
// T3 Code's send button up to 101 px from the bottom and MausBot's two-row
// composer up to 92 px, at every width, since a composer as wide as its
// column comes within 20 to 48 px of the edge: there the launcher stands
// 112 px from the bottom and 16 px from the right, above the composer. The
// device's safe area adds to both. A host moves it with
// `--lazurio-buddy-right` and `--lazurio-buddy-bottom` (interface v1), and
// the panel stays above it.

/** The launcher's size. */
export const buddyLauncherSize = 58;
/** The launcher's distance from the window's right and bottom edges, by the
 * app the page is (the column head's `active`): the Launchpad's, and Chat's
 * and Automate's, above their composers. */
export const buddyLauncherOffset = Object.freeze({
  apps: Object.freeze({ right: 20, bottom: 20 }),
  composer: Object.freeze({ right: 16, bottom: 112 }),
});
/** The panel's size and its distance above the launcher. */
export const buddyPanelSize = Object.freeze({
  width: 400,
  height: 600,
  gap: 12,
});
/** Full screen: its reading width. */
export const buddyReadingWidth = 760;
/** The layer of the launcher and the panel. */
export const buddyLayer = 45;

const offset = (place: Readonly<{ right: number; bottom: number }>) =>
  `--buddy-right: var(--lazurio-buddy-right, ${place.right}px); --buddy-bottom: var(--lazurio-buddy-bottom, ${place.bottom}px);`;
const above = buddyLauncherSize + buddyPanelSize.gap;

const bubbleCss = `
:host { display: contents; }
:host([hidden]) { display: none; }
.bubble { ${offset(buddyLauncherOffset.apps)} --buddy-x: calc(var(--buddy-right) + env(safe-area-inset-right, 0px)); --buddy-y: calc(var(--buddy-bottom) + env(safe-area-inset-bottom, 0px)); }
.bubble:is([data-app="chat"], [data-app="automate"]) { ${offset(buddyLauncherOffset.composer)} }
.launcher { position: fixed; right: var(--buddy-x); bottom: var(--buddy-y); z-index: ${buddyLayer}; display: grid; width: ${buddyLauncherSize}px; height: ${buddyLauncherSize}px; padding: 0; place-items: center; overflow: hidden; border: 0; border-radius: 50%; background: var(--lz-white); box-shadow: 0 0 0 1px var(--lz-line), var(--lz-shadow-float); cursor: pointer; transition: transform 0.15s ease-out; }
.launcher:hover { transform: translateY(-2px); }
.launcher:focus-visible { outline: 2px solid var(--shell-focus); outline-offset: 3px; }
.launcher img { display: block; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
.launcher[data-fallback] img { width: 34px; height: 34px; object-fit: contain; }
.window { position: fixed; inset: auto var(--buddy-x) calc(var(--buddy-y) + ${above}px) auto; z-index: ${buddyLayer}; box-sizing: border-box; width: min(${buddyPanelSize.width}px, calc(100vw - 2 * var(--buddy-x))); height: min(${buddyPanelSize.height}px, calc(100dvh - var(--buddy-y) - ${above + 16}px)); max-width: none; max-height: none; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-md); background: var(--shell-raised); color: var(--shell-ink); box-shadow: var(--lz-shadow-float); }
.window:modal { inset: 0; width: min(${buddyReadingWidth}px, calc(100vw - 32px)); height: calc(100dvh - 32px); margin: auto; }
.window::backdrop { background: rgb(0 0 0 / 0.32); }
.window iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
@media (max-width: 639px) { .window:modal { width: calc(100vw - 16px); height: calc(100dvh - 16px); } }
@media (prefers-reduced-motion: reduce) { .launcher { transition: none; } .launcher:hover { transform: none; } }
`;

/** The bubble's stylesheet in its element's shadow root. */
export const buddyBubbleCss = `${hostTokens}\n${baseCss}\n${bubbleCss}`;
