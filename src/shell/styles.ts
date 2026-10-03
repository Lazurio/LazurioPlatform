import { vendorText } from "./vendor-text" with { type: "macro" };

const tokens = vendorText("tokens.css");

// The styles of the shell elements, inside their shadow roots: the Lazurio
// design system's tokens (vendored byte-for-byte, declared on `:root`, here
// applied to `:host` so they hold inside the shadow root and nowhere else),
// and the components of the rail, the Environment picker and the app switch
// after the shell wireframe (prototypes-lazurio 1cbad15, the Organization
// rail) and the design system's selection rule (design-system-lazurio
// 5bbc1f7, `lz-picker`, `lz-menu__head`: a quiet surface one step darker,
// full-weight text, a check with a word; no left edge, no shadow, no
// capitals). Nothing here reaches the host page, and the host page's styles
// do not reach in.

/** The tokens, scoped to the element. */
export const hostTokens = tokens.replace(":root", ":host");

/** The width the rail takes; the host lays its content beside it with
 * `padding-left: var(--lazurio-rail-width, 0px)`. */
export const railWidth = "72px";

const base = `
:host { font-family: var(--lz-font-sans); font-size: 15px; font-weight: 400; line-height: 1.4; letter-spacing: normal; text-align: left; text-transform: none; color: var(--lz-ink); -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
a, button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--lz-accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.org-mark { display: grid; flex: none; place-items: center; overflow: hidden; border-radius: var(--lz-radius-sm); background: var(--lz-white); box-shadow: inset 0 0 0 1px var(--lz-line); color: var(--lz-ink); font-weight: var(--lz-weight-akce); letter-spacing: 0.02em; }
.org-mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
`;

/** The list of Environments: under the picker (one space) and as the ⌘⇧E
 * dialog (every space). */
const switcherCss = `
dialog.switcher-dialog { width: min(560px, 92vw); max-height: 64vh; margin: 12vh auto auto; padding: 0; border: 1px solid var(--lz-gray-300); border-radius: 14px; background: var(--lz-white); color: var(--lz-ink); }
dialog.switcher-dialog::backdrop { background: rgb(0 0 0 / 25%); }
.switcher-box { display: flex; flex-direction: column; max-height: inherit; overflow: hidden; background: var(--lz-white); }
.switcher-popover { position: fixed; inset: auto; margin: 0; padding: 0; max-height: min(72vh, 600px); border: 1px solid var(--lz-gray-300); border-radius: 12px; color: var(--lz-ink); }
.switcher-search { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--lz-line); color: var(--lz-ink-muted); }
.switcher-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--lz-ink); font-size: 15px; }
.kbd { padding: 1px 6px; border: 1px solid var(--lz-line); border-radius: 6px; color: var(--lz-ink-muted); font-family: var(--lz-font-mono); font-size: 11px; }
.switcher-list { overflow: auto; padding: 6px 8px 10px; }
.switcher-title { padding: 8px 8px 4px; color: var(--lz-ink-muted); font-size: 12px; font-weight: var(--lz-weight-akce); }
.switcher-head { display: flex; width: 100%; align-items: center; gap: 8px; margin: 4px 0 2px; padding: 7px 8px; border-bottom: 1px solid var(--lz-line-faint); border-radius: 8px 8px 0 0; color: var(--lz-ink); font-size: 13px; font-weight: var(--lz-weight-akce); text-decoration: none; }
.switcher-head .org-mark { width: 20px; height: 20px; border-radius: 5px; font-size: 8px; }
.switcher-head-meta { margin-left: auto; color: var(--lz-ink-muted); font-weight: 400; }
.switcher-row { display: flex; width: 100%; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; color: var(--lz-ink); font-size: 14px; text-decoration: none; }
.is-cursor { background: var(--lz-gray-50); }
.switcher-row[aria-current="page"], .switcher-head[aria-current="page"] { background: var(--lz-gray-100); }
.switcher-glyph { display: grid; width: 26px; height: 26px; flex: none; place-items: center; border-radius: 7px; background: var(--lz-gray-50); color: var(--lz-ink-muted); font-size: 11px; font-weight: 700; }
.switcher-row[aria-current="page"] .switcher-glyph { background: var(--lz-white); color: var(--lz-ink); }
.switcher-name { flex: none; font-weight: 550; white-space: nowrap; }
.switcher-row[aria-current="page"] .switcher-name { font-weight: var(--lz-weight-akce); }
.switcher-who { flex: 1; min-width: 0; overflow: hidden; color: var(--lz-ink-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.switcher-here { display: flex; flex: none; align-items: center; gap: 4px; color: var(--lz-ink); font-size: 12px; font-weight: var(--lz-weight-akce); }
.switcher-empty { margin: 0; padding: 6px 8px; color: var(--lz-ink-muted); font-size: 13px; }
.switcher-foot { display: flex; align-items: center; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--lz-line); color: var(--lz-ink-muted); font-size: 12px; white-space: nowrap; }
.switcher-widen { display: flex; align-items: center; gap: 6px; margin-right: auto; padding: 3px 8px; border: 1px solid var(--lz-line); border-radius: 8px; background: var(--lz-white); color: var(--lz-ink); font-size: 12px; font-weight: 550; cursor: pointer; }
.switcher-widen:hover { background: var(--lz-gray-50); }
`;

export const railCss = `${hostTokens}
${base}
${switcherCss}
:host { position: fixed; inset: 0 auto 0 0; z-index: 40; display: block; width: ${railWidth}; background: var(--lz-gray-50); }
nav { display: flex; height: 100%; flex-direction: column; align-items: center; gap: 6px; padding: 12px 0; }
.item { position: relative; display: grid; width: 44px; height: 44px; flex: none; place-items: center; padding: 0; border: 0; border-radius: var(--lz-radius-md); background: transparent; color: var(--lz-ink-muted); cursor: pointer; text-decoration: none; transition: border-radius 120ms ease; }
.item:hover { color: var(--lz-ink); border-radius: 14px; }
.home img { width: 30px; height: 30px; display: block; }
.search { width: 36px; height: 32px; }
.divider { width: 32px; height: 1px; margin: 4px 0; flex: none; background: var(--lz-line); }
.scroll { display: flex; width: 100%; min-height: 0; flex: 1; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0 10px; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.scroll::-webkit-scrollbar { display: none; }
.space .org-mark, .space .initials { width: 40px; height: 40px; border-radius: 12px; transition: border-radius 120ms ease; }
.space:hover .org-mark, .space:hover .initials { border-radius: 14px; }
.space .org-mark { font-size: 12px; }
.space .initials { display: grid; place-items: center; background: var(--lz-ink); color: var(--lz-white); font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
.space[aria-current="true"] .org-mark, .space[aria-current="true"] .initials { box-shadow: 0 0 0 2px var(--lz-paper), 0 0 0 4px var(--lz-ink); }
.add { border: 1px dashed var(--lz-line); }
.account .avatar { display: grid; width: 36px; height: 36px; place-items: center; overflow: hidden; border-radius: 50%; background: var(--lz-ink); color: var(--lz-white); font-size: 13px; font-weight: var(--lz-weight-akce); object-fit: cover; }
.tip { position: fixed; z-index: 60; display: grid; max-width: 260px; padding: 6px 10px; border-radius: var(--lz-radius-sm); background: var(--lz-ink); color: var(--lz-white); font-size: 13px; line-height: 1.3; pointer-events: none; transform: translateY(-50%); box-shadow: 0 4px 14px rgb(0 0 0 / 18%); }
.tip strong { font-weight: 600; }
.tip span { color: rgb(255 255 255 / 70%); font-size: 12px; }
.tip span:empty { display: none; }
@media (prefers-reduced-motion: reduce) { .item, .space .org-mark, .space .initials { transition: none; } }
`;

export const columnHeadCss = `${hostTokens}
${base}
${switcherCss}
:host { display: block; }
.head { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: stretch; gap: 6px; }
.pick { display: flex; flex: 1; min-width: 0; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: var(--lz-radius-md); background: transparent; color: var(--lz-ink); text-align: left; cursor: pointer; }
.pick:hover, .pick[aria-expanded="true"] { background: var(--lz-gray-100); }
.pick-glyph { display: grid; width: 30px; height: 30px; flex: none; place-items: center; border-radius: 8px; color: var(--lz-ink); font-size: 11px; font-weight: 700; }
.pick-glyph .org-mark { width: 24px; height: 24px; font-size: 9px; }
.pick-glyph .initials { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 6px; background: var(--lz-ink); color: var(--lz-white); }
.pick-text { display: grid; flex: 1; min-width: 0; line-height: 1.25; }
.pick-title, .pick-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-title { font-size: 14px; font-weight: 650; }
.pick-who { color: var(--lz-ink-muted); font-size: 12px; }
.pick > svg { flex: none; color: var(--lz-ink-muted); transition: transform 0.15s; }
.pick[aria-expanded="true"] > svg { transform: rotate(180deg); }
.gear { display: grid; width: 40px; flex: none; place-items: center; border-radius: var(--lz-radius-md); color: var(--lz-ink-muted); text-decoration: none; }
.gear:hover, .gear[aria-current="page"] { background: var(--lz-gray-100); color: var(--lz-ink); }
nav.switch { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 3px; border-radius: var(--lz-radius-md); background: var(--lz-gray-100); }
.tab { display: flex; min-width: 0; flex-direction: column; align-items: center; gap: 2px; padding: 6px 2px 5px; border-radius: calc(var(--lz-radius-md) - 2px); color: var(--lz-ink-muted); font-size: 11px; font-weight: 550; line-height: 1.25; text-decoration: none; }
a.tab:hover { color: var(--lz-ink); }
.tab[aria-current="page"] { background: var(--lz-white); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); color: var(--lz-ink); }
.tab[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
/* A dark host (data-host-tone="dark", from --lazurio-host-tone or the host's
   background): no frame, light text, a translucent hover. */
:host([data-host-tone="dark"]) { color: #fff; }
:host([data-host-tone="dark"]) .pick { color: #fff; }
:host([data-host-tone="dark"]) .pick-who, :host([data-host-tone="dark"]) .pick > svg, :host([data-host-tone="dark"]) .gear { color: rgb(255 255 255 / 0.65); }
:host([data-host-tone="dark"]) .pick:hover, :host([data-host-tone="dark"]) .pick[aria-expanded="true"], :host([data-host-tone="dark"]) .gear:hover, :host([data-host-tone="dark"]) .gear[aria-current="page"] { background: rgb(255 255 255 / 0.1); color: #fff; }
:host([data-host-tone="dark"]) nav.switch { background: rgb(255 255 255 / 0.06); }
:host([data-host-tone="dark"]) .tab { color: rgb(255 255 255 / 0.65); }
:host([data-host-tone="dark"]) a.tab:hover { color: #fff; }
:host([data-host-tone="dark"]) .tab[aria-current="page"] { background: rgb(255 255 255 / 0.12); box-shadow: none; color: #fff; }
/* A narrow host (a fork's icon-only sidebar): the glyphs alone. */
:host { container-type: inline-size; }
@container (max-width: 160px) {
  .row { flex-direction: column; align-items: center; }
  .pick { flex: none; justify-content: center; padding: 7px; }
  .pick-text, .pick > svg { display: none; }
  .gear { width: 40px; height: 40px; }
  nav.switch { grid-template-columns: 1fr; }
  .tab span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
@media (prefers-reduced-motion: reduce) { .pick > svg { transition: none; } }
`;
