import { vendorText } from "./vendor-text" with { type: "macro" };

const tokens = vendorText("tokens.css");

// The styles of the shell elements, inside their shadow roots: the Lazurio
// design system's tokens (vendored byte-for-byte, declared on `:root`, here
// applied to `:host` so they hold inside the shadow root and nowhere else),
// and the components of the rail, the Environment picker and the app switch
// after the shell wireframe (prototypes-lazurio 1acd615, F36's addendum of
// 2026-10-06) and the design system (design-system-lazurio fdcc9b4). They
// mirror its rules: the selected look is a quiet surface one step darker,
// with a hairline in the rail (`lz-rail`, B3) and a check in a list whose
// word only screen readers hear (`lz-menu-item--compact`); no left edge, no
// capitals. Three radii, one per kind of thing: `radius-xs` fields and key
// labels, `radius-sm` controls and marks, `radius-md` free-standing objects;
// an inner corner is the outer minus the gap. One shadow, only for a layer
// floating above the page (`--lz-shadow-float`, always with a hairline): the
// list of Environments, the ⌘⇧E dialog and the rail's label; nothing in the
// flow of the page has one. Nothing here reaches the host page, and the host
// page's styles do not reach in.
//
// Colours (F36, addendum of 2026-10-04, evening; prototypes-lazurio
// 5411279, `shell-theme.css`): the elements have no palette of their own.
// They take the colours of the app they sit in through the colour roles of
// interface v1 (`--lazurio-surface`, `--lazurio-ink`, …), custom properties
// the host sets on its document, which inherit into these shadow roots. The
// components below use only the `--shell-*` names, each bound to a role with
// the design system's value as its fallback: without roles the elements look
// as the design system draws them. A `--shell-host-*` name is mixed from a
// role and stays unset while the host sets none (a `var()` without a
// fallback); it is only ever read with the design system's value as
// fallback.

/** The tokens, scoped to the element. */
export const hostTokens = tokens.replace(":root", ":host");

/** The width the rail takes, one step of the design system's grid
 * (`--lz-grid-step`, `lz-rail`); the host lays its content beside it with
 * `padding-left: var(--lazurio-rail-width, 0px)`. 72 px until F36's addendum
 * of 2026-10-06. */
export const railWidth = "64px";

const base = `
:host {
  --shell-ink: var(--lazurio-ink, var(--lz-ink));
  --shell-ink-muted: var(--lazurio-ink-muted, var(--lz-ink-muted));
  --shell-line: var(--lazurio-line, var(--lz-line));
  --shell-line-strong: var(--lazurio-line-strong, var(--lz-gray-300));
  --shell-hover: var(--lazurio-hover, var(--lz-gray-100));
  --shell-selected: var(--lazurio-selected, var(--lz-gray-100));
  --shell-control: var(--lazurio-control, var(--lz-gray-100));
  --shell-raised: var(--lazurio-raised, var(--lz-white));
  /* The active tab is in the flow of the page: a hairline, never a shadow. */
  --shell-raised-shadow: inset 0 0 0 1px var(--shell-line);
  --shell-focus: var(--lazurio-focus, var(--lz-accent));
  --shell-overlay: var(--lazurio-overlay, var(--lz-white));
  --shell-overlay-ink: var(--lazurio-overlay-ink, var(--lz-ink));
  /* Marks (an Organization's avatar or initials, your personal monogram) sit
     on the raised colour with a hairline, never on ink. The rail's labels
     and the account's initials are ink with the surface's colour as text.
     The dark tone below leaves them as they are. */
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
 * dialog (every space). It floats on the host's overlay colour with a
 * hairline and the one shadow; its lines, hover and selection are mixed from
 * the overlay and its ink, as the wireframe does. One line per Environment
 * (design-system-lazurio `lz-menu-item--compact`): a glyph without a tile,
 * the name and, quieter beside it, who it is for; the current one has the
 * quiet surface and the check. The jump's Organization heads are
 * `lz-menu__head`. */
const switcherCss = `
dialog.switcher-dialog, .switcher-box {
  --shell-host-muted: color-mix(in oklab, var(--shell-overlay-ink) 62%, var(--lazurio-overlay));
  --shell-host-line: color-mix(in oklab, var(--shell-overlay-ink) 14%, var(--lazurio-overlay));
  --shell-host-line-faint: color-mix(in oklab, var(--shell-overlay-ink) 9%, var(--lazurio-overlay));
  --shell-host-hover: color-mix(in oklab, var(--shell-overlay-ink) 5%, var(--lazurio-overlay));
  --shell-host-selected: color-mix(in oklab, var(--shell-overlay-ink) 10%, var(--lazurio-overlay));
  --shell-ink: var(--shell-overlay-ink);
  --shell-ink-muted: var(--shell-host-muted, var(--lz-ink-muted));
  --shell-line: var(--shell-host-line, var(--lz-line));
  --shell-line-faint: var(--shell-host-line-faint, var(--lz-line-faint));
  --shell-hover: var(--shell-host-hover, var(--lz-gray-50));
  /* An entry under the pointer or the cursor: paper, a step lighter than
     the selected surface, so the two are never confused. */
  --shell-entry-hover: var(--shell-host-hover, var(--lz-paper));
  --shell-selected: var(--shell-host-selected, var(--lz-gray-100));
  --shell-mark: var(--shell-overlay);
  --shell-mark-ink: var(--shell-overlay-ink);
  --shell-mark-line: var(--shell-line);
}
dialog.switcher-dialog { width: min(560px, 92vw); max-height: 64vh; margin: 12vh auto auto; padding: 0; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-md); background: var(--shell-overlay); color: var(--shell-ink); box-shadow: var(--lz-shadow-float); }
dialog.switcher-dialog::backdrop { background: rgb(0 0 0 / 25%); }
.switcher-box { display: flex; flex-direction: column; max-height: inherit; overflow: hidden; background: var(--shell-overlay); }
.switcher-box:focus { outline: none; }
.switcher-popover { position: fixed; inset: auto; margin: 0; padding: 0; max-height: min(72vh, 600px); border: 1px solid var(--shell-line); border-radius: var(--lz-radius-md); color: var(--shell-ink); box-shadow: var(--lz-shadow-float); }
.switcher-search { display: flex; flex: none; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--shell-line); color: var(--shell-ink-muted); }
.switcher-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--shell-ink); font-size: 15px; }
.kbd { padding: 1px 6px; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-xs); color: var(--shell-ink-muted); font-family: var(--lz-font-mono); font-size: 11px; }
.switcher-list { overflow: auto; padding: 6px 8px 10px; }
.switcher-popover .switcher-list { padding: 6px; }
.switcher-title { display: flex; align-items: center; gap: 8px; padding: 8px 8px 4px; color: var(--shell-ink-muted); font-size: 12px; font-weight: var(--lz-weight-akce); }
.switcher-head { display: flex; width: 100%; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--shell-line-faint); border-radius: var(--lz-radius-sm) var(--lz-radius-sm) 0 0; color: var(--shell-ink); font-size: 14px; font-weight: var(--lz-weight-akce); line-height: normal; text-decoration: none; }
.switcher-head .org-mark { width: 24px; height: 24px; font-size: 10px; }
.switcher-head-meta { display: flex; margin-left: auto; color: var(--shell-ink-muted); font-weight: 400; }
.switcher-row { display: flex; width: 100%; align-items: center; gap: 10px; padding: 7px 8px; border-radius: var(--lz-radius-sm); color: var(--shell-ink); line-height: normal; text-decoration: none; }
.switcher-row:hover, .switcher-head:hover, .is-cursor { background: var(--shell-entry-hover); }
.switcher-row[aria-current="page"], .switcher-head[aria-current="page"] { background: var(--shell-selected); }
.switcher-glyph { display: grid; width: 20px; height: 20px; flex: none; place-items: center; color: var(--shell-ink-muted); font-size: 10px; font-weight: var(--lz-weight-akce); }
.switcher-copy { display: flex; min-width: 0; align-items: baseline; gap: 8px; }
.switcher-name { flex: none; font-size: 14px; font-weight: var(--lz-weight-akce); white-space: nowrap; }
.switcher-who { min-width: 0; overflow: hidden; color: var(--shell-ink-muted); font-size: 13px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.switcher-check { display: inline-flex; flex: none; align-items: center; margin-left: auto; color: var(--shell-ink); }
.switcher-empty { margin: 12px 0 0; padding: 6px 8px; color: var(--shell-ink-muted); font-size: 13px; line-height: 1.5; }
.switcher-foot { display: flex; flex: none; align-items: center; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--shell-line); color: var(--shell-ink-muted); font-size: 12px; line-height: normal; white-space: nowrap; }
.switcher-widen { display: flex; align-items: center; gap: 6px; margin-right: auto; padding: 3px 8px; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-sm); background: var(--shell-overlay); color: var(--shell-ink); font-size: 12px; font-weight: 550; cursor: pointer; }
.switcher-widen:hover { background: var(--shell-hover); }
`;

export const railCss = `${hostTokens}
${base}
${switcherCss}
/* The rail is the host's surface, paper without roles like the app's column
   (design-system-lazurio#59), and draws no edge toward the app beside it
   (Matěj 2026-10-04): no border, no shadow, no line. */
:host {
  --shell-surface: var(--lazurio-surface, var(--lz-paper));
  --shell-host-tip-sub: color-mix(in srgb, var(--lazurio-surface) 70%, transparent);
}
:host { position: fixed; inset: 0 auto 0 0; z-index: 40; display: block; width: ${railWidth}; background: var(--shell-surface); }
nav { display: flex; height: 100%; flex-direction: column; align-items: center; gap: 4px; padding: 12px 0; }
/* One corner family (prototypes-lazurio#11): every item is 40 px with
   radius-md around a 32 px mark with radius-sm, so the corners are
   concentric (6 + 4 = 10). Under the pointer an item only brings the
   surface; its shape never changes. */
.item { position: relative; display: grid; width: 40px; height: 40px; flex: none; place-items: center; padding: 0; border: 0; border-radius: var(--lz-radius-md); background: transparent; color: var(--shell-ink-muted); cursor: pointer; text-decoration: none; }
.item:hover { background: var(--shell-hover); color: var(--shell-ink); }
/* The Lazurio logo sits on a white disc, so it reads the same in every
   app's colours (Matěj 2026-10-04); white whatever the roles say. */
.home .disc { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 50%; background: var(--lz-white); box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08); }
.home img { width: 20px; height: 20px; display: block; }
/* On the personal Dashboard (F36's addendum of 2026-10-05) the logo is the
   page you are on: the design system's selected look (B3), the quiet surface
   with a hairline, as the space you are in has it. */
.home[aria-current="page"] { background: var(--shell-selected); box-shadow: inset 0 0 0 1px var(--shell-line-strong); }
.divider { width: 24px; height: 1px; margin: 4px 0; flex: none; background: var(--shell-line); }
.scroll { display: flex; width: 100%; min-height: 0; flex: 1; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0 10px; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.scroll::-webkit-scrollbar { display: none; }
.space .org-mark, .space .initials { width: 32px; height: 32px; border-radius: var(--lz-radius-sm); }
.space .org-mark { font-size: 12px; }
/* Your personal space is a monogram like an Organization's without an
   avatar, on the raised colour with a hairline: never an ink block, and
   never the surface of a selected item (lz-rail__mark). */
.space .initials { display: grid; place-items: center; background: var(--shell-mark); box-shadow: inset 0 0 0 1px var(--shell-mark-line); color: var(--shell-mark-ink); font-size: 12px; font-weight: 700; letter-spacing: 0.02em; }
/* The space you are in: the design system's B3 (design-system-lazurio#57,
   lz-rail): the quiet surface around its mark with a hairline, never a ring.
   As in lz-rail, the mark draws them itself with two spread shadows (3 px of
   surface, then 1 px of hairline): exactly the 40 px item, concentric with
   the mark's corners. */
.space[aria-current="true"] .org-mark, .space[aria-current="true"] .initials { box-shadow: inset 0 0 0 1px var(--shell-mark-line), 0 0 0 3px var(--shell-selected), 0 0 0 4px var(--shell-line-strong); }
.add { width: 32px; height: 32px; margin: 4px 0; border: 1px dashed var(--shell-line); border-radius: var(--lz-radius-sm); }
.account .avatar { display: grid; width: 28px; height: 28px; place-items: center; overflow: hidden; border-radius: 50%; background: var(--shell-inverse); color: var(--shell-inverse-ink); font-size: 11px; font-weight: var(--lz-weight-akce); object-fit: cover; }
/* With nobody signed in (F36's addendum of 2026-10-06) the sign-in key stands
   at the foot, where a person's account stands, in the items' colours. */
.sign-in { margin-top: auto; }
/* The rail's label floats above the page: the one shadow. */
.tip { position: fixed; z-index: 60; display: grid; max-width: 260px; padding: 6px 10px; border-radius: var(--lz-radius-sm); background: var(--shell-inverse); color: var(--shell-inverse-ink); font-size: 13px; line-height: 1.3; pointer-events: none; transform: translateY(-50%); box-shadow: var(--lz-shadow-float); }
.tip strong { font-weight: 600; }
.tip span { color: var(--shell-host-tip-sub, rgb(255 255 255 / 70%)); font-size: 12px; }
.tip span:empty { display: none; }
`;

export const columnHeadCss = `${hostTokens}
${base}
${switcherCss}
:host { display: block; }
.head { display: flex; flex-direction: column; gap: 8px; }
/* The picker and the gear of what it names, side by side (lz-picker-row). */
.row { display: flex; align-items: center; gap: var(--lz-space-4); }
/* The Environment picker (lz-picker): no frame, the quiet surface under the
   pointer and while its list is open. */
.pick { display: flex; flex: 1; min-width: 0; min-height: var(--lz-space-48); align-items: center; gap: var(--lz-space-12); padding: var(--lz-space-8); border: 0; border-radius: var(--lz-radius-md); background: transparent; color: var(--shell-ink); text-align: left; cursor: pointer; }
.pick:hover { background: var(--shell-hover); }
.pick[aria-expanded="true"] { background: var(--shell-selected); }
/* Its glyph (lz-picker__mark), in the picker's ink: an Organization's mark
   or your monogram inside it, or the kind's icon filling it. */
.pick-glyph { display: grid; width: var(--lz-space-32); height: var(--lz-space-32); flex: none; place-items: center; overflow: hidden; border-radius: var(--lz-radius-sm); color: var(--shell-ink); font-size: var(--lz-size-meta); font-weight: var(--lz-weight-akce); }
.pick-glyph > svg { display: block; width: 100%; height: auto; }
.pick-glyph .org-mark { width: 24px; height: 24px; font-size: 10px; }
/* Your personal Environment's glyph: your monogram as the rail draws it. */
.pick-glyph .initials { display: grid; width: 24px; height: 24px; place-items: center; border-radius: var(--lz-radius-sm); background: var(--shell-mark); box-shadow: inset 0 0 0 1px var(--shell-mark-line); color: var(--shell-mark-ink); font-size: 10px; font-weight: 700; letter-spacing: 0.02em; }
.pick-text { display: grid; flex: 1; min-width: 0; line-height: normal; }
.pick-title, .pick-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick-title { font-size: var(--lz-size-nav); font-weight: var(--lz-weight-akce); }
.pick-who { color: var(--shell-ink-muted); font-size: var(--lz-size-meta); }
.pick > svg { flex: none; color: var(--shell-ink-muted); transition: transform 0.15s; }
.pick[aria-expanded="true"] > svg { transform: rotate(180deg); }
/* The gear (lz-button--quiet lz-button--icon): a square of the grid's
   48 px, in the picker's ink. Under the pointer it takes the quiet surface
   of the column's other controls. */
.gear { display: grid; width: var(--lz-space-48); height: var(--lz-space-48); flex: none; place-items: center; border-radius: var(--lz-radius-sm); color: var(--shell-ink); text-decoration: none; }
.gear:hover { background: var(--shell-hover); }
.gear[aria-current="page"] { background: var(--shell-selected); }
nav.switch { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 3px; border-radius: var(--lz-radius-md); background: var(--shell-control); }
.tab { display: flex; min-width: 0; flex-direction: column; align-items: center; gap: 2px; padding: 6px 2px 5px; border-radius: calc(var(--lz-radius-md) - 2px); color: var(--shell-ink-muted); font-size: 11px; font-weight: 550; line-height: normal; text-decoration: none; }
a.tab:hover { color: var(--shell-ink); }
.tab[aria-current="page"] { background: var(--shell-raised); box-shadow: var(--shell-raised-shadow); color: var(--shell-ink); }
.tab[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
/* The line under the switch until the Environment is usable (root decision
   0188): one sentence and its buttons, in the host's colours; a stopped
   preparation in the danger colour. */
.setup { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 8px 10px; border: 1px solid var(--shell-line); border-radius: var(--lz-radius-md); color: var(--shell-ink); font-size: 12.5px; line-height: 1.35; }
.setup > svg { flex: none; color: var(--shell-ink-muted); }
.setup-text { flex: 1 1 calc(100% - 26px); min-width: 0; }
.setup-links { display: flex; flex-wrap: wrap; gap: 4px 12px; padding-left: 24px; }
.setup-link { color: var(--shell-ink); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
.setup[data-tone="failed"] { border-color: color-mix(in oklab, var(--lz-danger) 55%, transparent); }
.setup[data-tone="failed"] > svg { color: var(--lz-danger); }
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
  .pick { flex: none; justify-content: center; }
  .pick-text, .pick > svg { display: none; }
  nav.switch { grid-template-columns: 1fr; }
  .tab span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .setup { display: none; }
}
@media (prefers-reduced-motion: reduce) { .pick > svg { transition: none; } }
`;
