import { baseCss, hostTokens } from "./base-styles";

// Buddy's bubble inside `<lazurio-buddy>`'s shadow root (decision F60): the
// launcher, a 58 px disc at the bottom right with Buddy's picture (without
// it the neutral guide's mark: the Lazurio symbol on a white disc), and his
// window, one `<dialog>` holding the frame: the panel above the launcher
// (about 400 × 600, never past the window's edges) or full screen, a modal
// that covers the whole window (F60's addendum of 2026-10-25), in which the
// frame keeps its own reading width. Light, as the design system's floating
// layers are: the one floating shadow and a hairline; the window's own
// colours are the frame's.
//
// Layers: the launcher and the panel at z-index 45, above an app's own
// content and below the overlays a host keeps at its body (T3 Code's sheets
// from 46, both forks' dialogs from 50, menus, toasts and tooltips), so a
// dialog of the app is never covered; full screen is a modal in the top
// layer, and the guide's layer (guide-styles.ts) plays over all of it.
//
// Where it stands (`buddyLauncherOffset`, decision F60's addendum of
// 2026-10-25): 22 px from the window's right and bottom edges in every app,
// as the prototype has it (prototypes-lazurio `app/v1/src/styles.css`,
// "Bottom right, in the same place in every app and panel state"). The
// device's safe area adds to both. A page whose own controls reach that
// corner, a composer as wide as its column in Chat and Automate, makes room
// for it: while the launcher is drawn, `<lazurio-buddy>` sets
// `--lazurio-buddy-clearance` on the document (`buddyLauncherClearance`, the
// width the launcher takes from the window's right edge), as the rail sets
// `--lazurio-rail-width`, and the page keeps its controls out of that strip.
// A host still moves the launcher with `--lazurio-buddy-right` and
// `--lazurio-buddy-bottom` (interface v1), and the panel stays above it.
// Buddy's figure stands in the disc at 40 x 44 px with its pixels kept
// sharp, as in the prototype, rather than filling it.

/** The launcher's size. */
export const buddyLauncherSize = 58;
/** The launcher's distance from the window's right and bottom edges, the
 * same in every app. */
export const buddyLauncherOffset = Object.freeze({ right: 22, bottom: 22 });
/** Buddy's figure inside the disc (the prototype's launcher image). */
export const buddyLauncherFigure = Object.freeze({ width: 40, height: 44 });
/** The width the launcher takes from the window's right edge, which the
 * page keeps free for it while it is drawn: its disc, its distance from the
 * edge (a host's own, where it moves it) and the device's safe area. */
export const buddyLauncherClearance = `calc(${buddyLauncherSize}px + var(--lazurio-buddy-right, ${buddyLauncherOffset.right}px) + env(safe-area-inset-right, 0px))`;
/** The panel's size and its distance above the launcher. */
export const buddyPanelSize = Object.freeze({
  width: 400,
  height: 600,
  gap: 12,
});
/** The layer of the launcher and the panel. */
export const buddyLayer = 45;

const offset = (place: Readonly<{ right: number; bottom: number }>) =>
  `--buddy-right: var(--lazurio-buddy-right, ${place.right}px); --buddy-bottom: var(--lazurio-buddy-bottom, ${place.bottom}px);`;
const above = buddyLauncherSize + buddyPanelSize.gap;

const bubbleCss = `
:host { display: contents; }
:host([hidden]) { display: none; }
.bubble { ${offset(buddyLauncherOffset)} --buddy-x: calc(var(--buddy-right) + env(safe-area-inset-right, 0px)); --buddy-y: calc(var(--buddy-bottom) + env(safe-area-inset-bottom, 0px)); }
.launcher { position: fixed; right: var(--buddy-x); bottom: var(--buddy-y); z-index: ${buddyLayer}; display: grid; width: ${buddyLauncherSize}px; height: ${buddyLauncherSize}px; padding: 0; place-items: center; overflow: hidden; border: 0; border-radius: 50%; background: var(--lz-white); box-shadow: 0 0 0 1px var(--lz-line), var(--lz-shadow-float); cursor: pointer; transition: transform 0.15s ease-out; }
.launcher:hover { transform: translateY(-2px); }
.launcher:focus-visible { outline: 2px solid var(--shell-focus); outline-offset: 3px; }
.launcher img { display: block; width: ${buddyLauncherFigure.width}px; height: ${buddyLauncherFigure.height}px; object-fit: contain; image-rendering: pixelated; pointer-events: none; }
.launcher[data-fallback] img { width: 34px; height: 34px; object-fit: contain; }
.window { position: fixed; inset: auto var(--buddy-x) calc(var(--buddy-y) + ${above}px) auto; z-index: ${buddyLayer}; box-sizing: border-box; width: min(${buddyPanelSize.width}px, calc(100vw - 2 * var(--buddy-x))); height: min(${buddyPanelSize.height}px, calc(100dvh - var(--buddy-y) - ${above + 16}px)); max-width: none; max-height: none; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-md); background: var(--shell-raised); color: var(--shell-ink); box-shadow: var(--lz-shadow-float); }
.window:modal { inset: 0; width: 100%; height: 100%; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
.window iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
@media (prefers-reduced-motion: reduce) { .launcher { transition: none; } .launcher:hover { transform: none; } }
`;

/** The bubble's stylesheet in its element's shadow root. */
export const buddyBubbleCss = `${hostTokens}\n${baseCss}\n${bubbleCss}`;
