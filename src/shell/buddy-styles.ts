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
// Buddy stands free (F60's addendum of 2026-11-14, the prototype of
// prototypes-lazurio #131): his figure at 48 x 52 px with its pixels kept
// sharp, no disc, a soft shadow on the ground under his feet. He moves a
// little: he breathes, rises under the pointer, lifts and leans while
// dragged (`data-drag`, `--buddy-tilt`), lands where he is put
// (`data-landed`), hops now and then while something new waits
// (`data-calling`), and his ground is ringed in ink while his window shows.
// The launcher's box stays 58 px, so his corner and its clearance are as
// before. Without his picture the neutral guide's mark keeps its white disc.
// While he is out presenting the guide (decision F56's addendum (7) of
// 2026-10-25) his place waits empty, only his ground, dashed. Less motion
// keeps him still.
//
// Before the person met Buddy (F60's addendum of 2026-10-26; the prototype
// of prototypes-lazurio #92, `.buddyw__unread` and `buddy-meet.css`): his "1"
// on the launcher's corner in the design system's red, and his window as a
// short conversation, his figure, his hello and the one thing he needs in
// speech bubbles, with one action where the composer would be. While the
// Launchpad's dialog shows where he is, the launcher stands over the dialog
// as a popover in its own place, in the design system's blue with a ring
// that pulses and a small hop; without motion, the ring alone. A popover's
// own place (`inset: 0`, `margin: auto`) never applies: the launcher keeps
// its corner either way.

/** The launcher's size. */
export const buddyLauncherSize = 58;
/** The launcher's distance from the window's right and bottom edges, the
 * same in every app. */
export const buddyLauncherOffset = Object.freeze({ right: 22, bottom: 22 });
/** Buddy's figure inside the disc (the prototype's launcher image). */
export const buddyLauncherFigure = Object.freeze({ width: 48, height: 52 });
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
.launcher { position: fixed; inset: auto var(--buddy-x) var(--buddy-y) auto; z-index: ${buddyLayer}; display: grid; width: ${buddyLauncherSize}px; height: ${buddyLauncherSize}px; margin: 0; padding: 0 0 3px; place-items: end center; overflow: visible; border: 0; border-radius: 50%; background: transparent; color: var(--lz-ink); cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }
.launcher::before { position: absolute; bottom: 0; left: 50%; width: 34px; height: 7px; border-radius: 50%; background: rgb(0 0 0 / 0.16); content: ""; transform: translateX(-50%); transition: width 0.2s ease-out, opacity 0.2s ease-out; }
.launcher:focus-visible { outline: 2px solid var(--shell-focus); outline-offset: 3px; }
.figure { display: grid; place-items: end center; transform-origin: 50% 100%; transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2); }
.launcher:hover .figure { transform: translateY(-3px); }
.launcher img { display: block; width: ${buddyLauncherFigure.width}px; height: ${buddyLauncherFigure.height}px; object-fit: contain; image-rendering: pixelated; pointer-events: none; filter: drop-shadow(0 0 1px rgb(255 255 255 / 0.9)) drop-shadow(0 2px 3px rgb(0 0 0 / 0.18)); transform-origin: 50% 100%; animation: buddy-breathe 3.4s ease-in-out infinite; }
.launcher[data-drag] { cursor: grabbing; }
.launcher[data-drag] .figure { transform: translateY(-10px) rotate(var(--buddy-tilt, 0deg)) scale(1.06); transition: transform 0.08s linear; }
.launcher[data-drag]::before { width: 22px; opacity: 0.6; }
.figure[data-landed] { animation: buddy-land 0.42s ease-out; }
.launcher[data-calling] .figure { animation: buddy-call 5s ease-in-out 1.5s infinite; }
.launcher[aria-expanded="true"]::before { background: transparent; box-shadow: 0 0 0 2px var(--lz-ink); }
.launcher[data-fallback] .figure { width: 48px; height: 48px; place-items: center; border-radius: 50%; background: var(--lz-white); box-shadow: 0 0 0 1px var(--lz-line), var(--lz-shadow-float); }
.launcher[data-fallback] img { width: 34px; height: 34px; filter: none; animation: none; }
.launcher[data-away] .figure { opacity: 0; }
.launcher[data-away]::before { background: transparent; box-shadow: none; outline: 1.5px dashed var(--lz-gray-300); }
@keyframes buddy-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.015, 1.035); } }
@keyframes buddy-land { 0% { transform: translateY(-8px); } 45% { transform: translateY(0) scale(1.1, 0.88); } 75% { transform: translateY(-2px) scale(0.97, 1.04); } 100% { transform: none; } }
@keyframes buddy-call { 0%, 14%, 100% { transform: none; } 4% { transform: translateY(1px) scale(1.06, 0.92); } 8% { transform: translateY(-12px) scale(0.97, 1.05); } 12% { transform: translateY(0) scale(1.04, 0.95); } }
.badge { position: absolute; top: -3px; right: -3px; display: grid; min-width: 20px; height: 20px; box-sizing: border-box; padding: 0 5px; place-items: center; border: 2px solid var(--lz-white); border-radius: var(--lz-radius-pill); background: var(--lz-red-500); color: var(--lz-white); font-size: 11px; font-weight: 700; line-height: 1; pointer-events: none; }
.badge[hidden] { display: none; }
.launcher[data-spot] { background: var(--lz-white); box-shadow: 0 0 0 2px var(--lz-blue-500), var(--lz-shadow-float); pointer-events: none; animation: buddy-hop 1.6s ease-in-out 0.3s infinite; }
.launcher[data-spot]::after { position: absolute; inset: -8px; box-sizing: border-box; border: 2px solid var(--lz-blue-500); border-radius: 50%; content: ""; pointer-events: none; animation: buddy-ring 1.6s ease-out 0.3s infinite; }
@keyframes buddy-ring { from { opacity: 0.9; transform: scale(0.9); } to { opacity: 0; transform: scale(1.3); } }
@keyframes buddy-hop { 0%, 60%, 100% { transform: none; } 30% { transform: translateY(-5px); } }
.window { position: fixed; inset: auto var(--buddy-x) calc(var(--buddy-y) + ${above}px) auto; z-index: ${buddyLayer}; box-sizing: border-box; width: min(${buddyPanelSize.width}px, calc(100vw - 2 * var(--buddy-x))); height: min(${buddyPanelSize.height}px, calc(100dvh - var(--buddy-y) - ${above + 16}px)); max-width: none; max-height: none; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-md); background: var(--shell-raised); color: var(--shell-ink); box-shadow: var(--lz-shadow-float); }
.window:modal { inset: 0; width: 100%; height: 100%; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
.window iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
.window[data-meeting="shown"] iframe { display: none; }
.meet { display: flex; height: 100%; box-sizing: border-box; flex-direction: column; }
.meet[hidden] { display: none; }
.meet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 10px 16px; border-bottom: 1px solid var(--shell-line); font-size: 14px; }
.meet-close { display: grid; width: 32px; height: 32px; padding: 0; place-items: center; border: 0; border-radius: var(--lz-radius-sm); background: transparent; color: var(--shell-ink-muted); cursor: pointer; }
.meet-close:hover { background: var(--shell-hover); color: var(--shell-ink); }
.meet-talk { display: grid; justify-items: start; gap: 8px; padding: 18px 16px 12px; overflow: auto; }
.meet-face { justify-self: center; width: 48px; height: 52px; margin-bottom: 6px; object-fit: contain; image-rendering: pixelated; }
.meet-line { max-width: 85%; margin: 0; padding: 9px 12px; border: 1px solid var(--shell-line); border-radius: 12px 12px 12px 4px; background: var(--shell-raised); color: var(--shell-ink); font-size: 14px; line-height: 1.45; }
.meet-action { display: flex; min-height: 36px; margin: auto 12px 12px; padding: 0 14px; align-items: center; justify-content: center; border-radius: var(--lz-radius-sm); background: var(--lz-accent-button); color: var(--lz-on-accent); font-size: 14px; font-weight: var(--lz-weight-akce); text-decoration: none; }
.meet-action:hover { background: var(--lz-accent-button-hover); }
@media (prefers-reduced-motion: reduce) { .launcher::before, .figure, .launcher[data-drag] .figure { transition: none; } .launcher:hover .figure, .launcher[data-drag] .figure { transform: none; } .launcher img, .figure[data-landed], .launcher[data-calling] .figure, .launcher[data-spot], .launcher[data-spot]::after { animation: none; } }
`;

/** The bubble's stylesheet in its element's shadow root. */
export const buddyBubbleCss = `${hostTokens}\n${baseCss}\n${bubbleCss}`;
