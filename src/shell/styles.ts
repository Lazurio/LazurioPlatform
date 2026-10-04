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
//
// Colours (F36, addendum of 2026-10-04, evening; prototypes-lazurio
// 5411279, `shell-theme.css`): the elements have no palette of their own.
// They take the colours of the app they sit in through the colour roles of
// interface v1 (`--lazurio-surface`, `--lazurio-ink`, …), custom properties
// the host sets on its document, which inherit into these shadow roots. The
// components below use only the `--shell-*` names, each bound to a role with
// the design system's value as its fallback: without roles the elements look
// exactly as before. A `--shell-host-*` name is mixed from a role and stays
// unset while the host sets none (a `var()` without a fallback); it is only
// ever read with the design system's value as fallback.

/** The tokens, scoped to the element. */
export const hostTokens = tokens.replace(":root", ":host");

/** The width the rail takes; the host lays its content beside it with
 * `padding-left: var(--lazurio-rail-width, 0px)`. */
export const railWidth = "72px";

const base = `
:host {
  --shell-ink: var(--lazurio-ink, var(--lz-ink));
  --shell-ink-muted: var(--lazurio-ink-muted, var(--lz-ink-muted));
  --shell-line: var(--lazurio-line, var(--lz-line));
  --shell-line-strong: var(--lazurio-line-strong, var(--lz-ink));
  --shell-hover: var(--lazurio-hover, var(--lz-gray-100));
  --shell-selected: var(--lazurio-selected, var(--lz-gray-100));
  --shell-control: var(--lazurio-control, var(--lz-gray-100));
  --shell-raised: var(--lazurio-raised, var(--lz-white));
  --shell-raised-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  --shell-focus: var(--lazurio-focus, var(--lz-accent));
  --shell-overlay: var(--lazurio-overlay, var(--lz-white));
  --shell-overlay-ink: var(--lazurio-overlay-ink, var(--lz-ink));
  /* Marks (an Organization's avatar or initials) sit on the raised colour;
     inverted marks and the rail's labels are ink with the surface's colour
     as text. The dark tone below leaves them as they are. */
  --shell-mark: var(--lazurio-raised, var(--lz-white));
  --shell-mark-ink: var(--lazurio-ink, var(--lz-ink));
  --shell-mark-line: var(--lazurio-line, var(--lz-line));
  --shell-inverse: var(--lazurio-ink, var(--lz-ink));
  --shell-inverse-ink: var(--lazurio-surface, var(--lz-white));
}
:host { font-family: var(--lz-font-sans); font-size: 15px; font-weight: 400; line-height: 1.4; letter-spacing: normal; text-align: left; text-transform: none; color: var(--shell-ink); -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
a, button, input { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--shell-focus); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.org-mark { display: grid; flex: none; place-items: center; overflow: hidden; border-radius: var(--lz-radius-sm); background: var(--shell-mark); box-shadow: inset 0 0 0 1px var(--shell-mark-line); color: var(--shell-mark-ink); font-weight: var(--lz-weight-akce); letter-spacing: 0.02em; }
.org-mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
`;

/** The list of Environments: under the picker (one space) and as the ⌘⇧E
 * dialog (every space). It sits on the host's overlay colour; its lines,
 * hover and selection are mixed from the overlay and its ink, as the
 * wireframe does. */
const switcherCss = `
dialog.switcher-dialog, .switcher-box {
  --shell-host-muted: color-mix(in oklab, var(--shell-overlay-ink) 62%, var(--lazurio-overlay));
  --shell-host-line: color-mix(in oklab, var(--shell-overlay-ink) 14%, var(--lazurio-overlay));
  --shell-host-line-faint: color-mix(in oklab, var(--shell-overlay-ink) 9%, var(--lazurio-overlay));
  --shell-host-border: color-mix(in oklab, var(--shell-overlay-ink) 22%, var(--lazurio-overlay));
  --shell-host-hover: color-mix(in oklab, var(--shell-overlay-ink) 5%, var(--lazurio-overlay));
  --shell-host-selected: color-mix(in oklab, var(--shell-overlay-ink) 10%, var(--lazurio-overlay));
  --shell-ink: var(--shell-overlay-ink);
  --shell-ink-muted: var(--shell-host-muted, var(--lz-ink-muted));
  --shell-line: var(--shell-host-line, var(--lz-line));
  --shell-line-faint: var(--shell-host-line-faint, var(--lz-line-faint));
  --shell-border: var(--shell-host-border, var(--lz-gray-300));
  --shell-hover: var(--shell-host-hover, var(--lz-gray-50));
  --shell-selected: var(--shell-host-selected, var(--lz-gray-100));
  --shell-mark: var(--shell-overlay);
  --shell-mark-ink: var(--shell-overlay-ink);
  --shell-mark-line: var(--shell-line);
}
dialog.switcher-dialog { width: min(560px, 92vw); max-height: 64vh; margin: 12vh auto auto; padding: 0; border: 1px solid var(--shell-border); border-radius: 14px; background: var(--shell-overlay); color: var(--shell-ink); }
dialog.switcher-dialog::backdrop { background: rgb(0 0 0 / 25%); }
.switcher-box { display: flex; flex-direction: column; max-height: inherit; overflow: hidden; background: var(--shell-overlay); }
.switcher-popover { position: fixed; inset: auto; margin: 0; padding: 0; max-height: min(72vh, 600px); border: 1px solid var(--shell-border); border-radius: 12px; color: var(--shell-ink); }
.switcher-search { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--shell-line); color: var(--shell-ink-muted); }
.switcher-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--shell-ink); font-size: 15px; }
.kbd { padding: 1px 6px; border: 1px solid var(--shell-line); border-radius: 6px; color: var(--shell-ink-muted); font-family: var(--lz-font-mono); font-size: 11px; }
.switcher-list { overflow: auto; padding: 6px 8px 10px; }
.switcher-title { padding: 8px 8px 4px; color: var(--shell-ink-muted); font-size: 12px; font-weight: var(--lz-weight-akce); }
.switcher-head { display: flex; width: 100%; align-items: center; gap: 8px; margin: 4px 0 2px; padding: 7px 8px; border-bottom: 1px solid var(--shell-line-faint); border-radius: 8px 8px 0 0; color: var(--shell-ink); font-size: 13px; font-weight: var(--lz-weight-akce); text-decoration: none; }
.switcher-head .org-mark { width: 20px; height: 20px; border-radius: 5px; font-size: 8px; }
.switcher-head-meta { margin-left: auto; color: var(--shell-ink-muted); font-weight: 400; }
.switcher-row { display: flex; width: 100%; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 8px; color: var(--shell-ink); font-size: 14px; text-decoration: none; }
.is-cursor { background: var(--shell-hover); }
.switcher-row[aria-current="page"], .switcher-head[aria-current="page"] { background: var(--shell-selected); }
.switcher-glyph { display: grid; width: 26px; height: 26px; flex: none; place-items: center; border-radius: 7px; background: var(--shell-hover); color: var(--shell-ink-muted); font-size: 11px; font-weight: 700; }
.switcher-row[aria-current="page"] .switcher-glyph { background: var(--shell-overlay); color: var(--shell-ink); }
.switcher-name { flex: none; font-weight: 550; white-space: nowrap; }
.switcher-row[aria-current="page"] .switcher-name { font-weight: var(--lz-weight-akce); }
.switcher-who { flex: 1; min-width: 0; overflow: hidden; color: var(--shell-ink-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.switcher-here { display: flex; flex: none; align-items: center; gap: 4px; color: var(--shell-ink); font-size: 12px; font-weight: var(--lz-weight-akce); }
.switcher-empty { margin: 0; padding: 6px 8px; color: var(--shell-ink-muted); font-size: 13px; }
.switcher-foot { display: flex; align-items: center; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--shell-line); color: var(--shell-ink-muted); font-size: 12px; white-space: nowrap; }
.switcher-widen { display: flex; align-items: center; gap: 6px; margin-right: auto; padding: 3px 8px; border: 1px solid var(--shell-line); border-radius: 8px; background: var(--shell-overlay); color: var(--shell-ink); font-size: 12px; font-weight: 550; cursor: pointer; }
.switcher-widen:hover { background: var(--shell-hover); }
`;

export const railCss = `${hostTokens}
${base}
${switcherCss}
/* The rail is the host's surface and draws no edge toward the app beside it
   (Matěj 2026-10-04): no border, no shadow, no line. */
:host {
  --shell-surface: var(--lazurio-surface, var(--lz-gray-50));
  --shell-ring-gap: var(--lazurio-surface, var(--lz-paper));
  --shell-host-tip-sub: color-mix(in srgb, var(--lazurio-surface) 70%, transparent);
}
:host { position: fixed; inset: 0 auto 0 0; z-index: 40; display: block; width: ${railWidth}; background: var(--shell-surface); }
nav { display: flex; height: 100%; flex-direction: column; align-items: center; gap: 6px; padding: 12px 0; }
.item { position: relative; display: grid; width: 44px; height: 44px; flex: none; place-items: center; padding: 0; border: 0; border-radius: var(--lz-radius-md); background: transparent; color: var(--shell-ink-muted); cursor: pointer; text-decoration: none; transition: border-radius 120ms ease; }
.item:hover { color: var(--shell-ink); border-radius: 14px; }
.home img { width: 30px; height: 30px; display: block; }
.search { width: 36px; height: 32px; }
.divider { width: 32px; height: 1px; margin: 4px 0; flex: none; background: var(--shell-line); }
.scroll { display: flex; width: 100%; min-height: 0; flex: 1; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0 10px; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.scroll::-webkit-scrollbar { display: none; }
.space .org-mark, .space .initials { width: 40px; height: 40px; border-radius: 12px; transition: border-radius 120ms ease; }
.space:hover .org-mark, .space:hover .initials { border-radius: 14px; }
.space .org-mark { font-size: 12px; }
.space .initials { display: grid; place-items: center; background: var(--shell-inverse); color: var(--shell-inverse-ink); font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
.space[aria-current="true"] .org-mark, .space[aria-current="true"] .initials { box-shadow: 0 0 0 2px var(--shell-ring-gap), 0 0 0 4px var(--shell-line-strong); }
.add { border: 1px dashed var(--shell-line); }
.account .avatar { display: grid; width: 36px; height: 36px; place-items: center; overflow: hidden; border-radius: 50%; background: var(--shell-inverse); color: var(--shell-inverse-ink); font-size: 13px; font-weight: var(--lz-weight-akce); object-fit: cover; }
.tip { position: fixed; z-index: 60; display: grid; max-width: 260px; padding: 6px 10px; border-radius: var(--lz-radius-sm); background: var(--shell-inverse); color: var(--shell-inverse-ink); font-size: 13px; line-height: 1.3; pointer-events: none; transform: translateY(-50%); box-shadow: 0 4px 14px rgb(0 0 0 / 18%); }
.tip strong { font-weight: 600; }
.tip span { color: var(--shell-host-tip-sub, rgb(255 255 255 / 70%)); font-size: 12px; }
.tip span:empty { display: none; }
@media (prefers-reduced-motion: reduce) { .item, .space .org-mark, .space .initials { transition: none; } }
`;

export const columnHeadCss = `${hostTokens}
${base}
${switcherCss}
:host { display: block; }
.head { display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; align-items: stretch; gap: 6px; }
.pick { display: flex; flex: 1; min-width: 0; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: var(--lz-radius-md); background: transparent; color: var(--shell-ink); text-align: left; cursor: pointer; }
.pick:hover { background: var(--shell-hover); }
.pick[aria-expanded="true"] { background: var(--shell-selected); }
.pick-glyph { display: grid; width: 30px; height: 30px; flex: none; place-items: center; border-radius: 8px; color: var(--shell-mark-ink); font-size: 11px; font-weight: 700; }
.pick-glyph .org-mark { width: 24px; height: 24px; font-size: 9px; }
.pick-glyph .initials { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 6px; background: var(--shell-inverse); color: var(--shell-inverse-ink); }
.pick-text { display: grid; flex: 1; min-width: 0; line-height: 1.25; }
.pick-title, .pick-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-title { font-size: 14px; font-weight: 650; }
.pick-who { color: var(--shell-ink-muted); font-size: 12px; }
.pick > svg { flex: none; color: var(--shell-ink-muted); transition: transform 0.15s; }
.pick[aria-expanded="true"] > svg { transform: rotate(180deg); }
.gear { display: grid; width: 40px; flex: none; place-items: center; border-radius: var(--lz-radius-md); color: var(--shell-ink-muted); text-decoration: none; }
.gear:hover { background: var(--shell-hover); color: var(--shell-ink); }
.gear[aria-current="page"] { background: var(--shell-selected); color: var(--shell-ink); }
nav.switch { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 3px; border-radius: var(--lz-radius-md); background: var(--shell-control); }
.tab { display: flex; min-width: 0; flex-direction: column; align-items: center; gap: 2px; padding: 6px 2px 5px; border-radius: calc(var(--lz-radius-md) - 2px); color: var(--shell-ink-muted); font-size: 11px; font-weight: 550; line-height: 1.25; text-decoration: none; }
a.tab:hover { color: var(--shell-ink); }
.tab[aria-current="page"] { background: var(--shell-raised); box-shadow: var(--shell-raised-shadow); color: var(--shell-ink); }
.tab[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
/* A dark host without colour roles (data-host-tone="dark", from
   --lazurio-host-tone or the host's background): no frame, light text, a
   translucent hover. A role the host sets wins. The marks and the list
   under the picker keep their colours. */
:host([data-host-tone="dark"]) {
  --shell-ink: var(--lazurio-ink, #fff);
  --shell-ink-muted: var(--lazurio-ink-muted, rgb(255 255 255 / 0.65));
  --shell-hover: var(--lazurio-hover, rgb(255 255 255 / 0.1));
  --shell-selected: var(--lazurio-selected, rgb(255 255 255 / 0.1));
  --shell-control: var(--lazurio-control, rgb(255 255 255 / 0.06));
  --shell-raised: var(--lazurio-raised, rgb(255 255 255 / 0.12));
  --shell-raised-shadow: none;
}
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
