import { vendorText } from "./vendor-text" with { type: "macro" };

const tokens = vendorText("tokens.css");

// The styles of the shell elements, inside their shadow roots: the Lazurio
// design system's tokens (vendored byte-for-byte, declared on `:root`, here
// applied to `:host` so they hold inside the shadow root and nowhere else),
// and the components of the rail and the app switch after the shell
// wireframe (prototypes-lazurio, DEV-6639). Nothing here reaches the host
// page, and the host page's styles do not reach in.

/** The tokens, scoped to the element. */
export const hostTokens = tokens.replace(":root", ":host");

/** The width the rail takes; the host lays its content beside it with
 * `margin-left: var(--lazurio-rail-width, 0)`. */
export const railWidth = "72px";

const base = `
:host { --env-accent: var(--lz-ink); font-family: var(--lz-font-sans); font-size: 15px; font-weight: 400; line-height: 1.4; letter-spacing: normal; text-align: left; text-transform: none; color: var(--lz-ink); -webkit-font-smoothing: antialiased; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
a, button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--lz-accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

export const railCss = `${hostTokens}
${base}
:host { position: fixed; inset: 0 auto 0 0; z-index: 40; display: block; width: ${railWidth}; background: var(--lz-gray-50); }
nav { display: flex; height: 100%; flex-direction: column; align-items: center; gap: 6px; padding: 12px 0; }
.item { position: relative; display: grid; width: 44px; height: 44px; flex: none; place-items: center; padding: 0; border: 0; border-radius: var(--lz-radius-md); background: var(--lz-gray-100); color: var(--lz-ink-muted); cursor: pointer; text-decoration: none; transition: border-radius 120ms ease; }
.item:hover { color: var(--lz-ink); border-radius: 14px; }
.home, .utility, .account { background: transparent; }
.home img { width: 30px; height: 30px; display: block; }
.search { width: 36px; height: 32px; }
.divider { width: 32px; height: 1px; margin: 4px 0; flex: none; background: var(--lz-line); }
.scroll { display: flex; width: 100%; min-height: 0; flex: 1; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0 10px; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.scroll::-webkit-scrollbar { display: none; }
.env .initials { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
.folder { display: flex; flex: none; flex-direction: column; align-items: center; gap: 4px; padding: 4px; border-radius: 14px; background: color-mix(in srgb, var(--env-accent) 18%, var(--lz-white)); }
.folder.has-active { box-shadow: inset 0 0 0 2px var(--env-accent); }
.folder .env { width: 40px; height: 40px; background: var(--lz-white); }
.env[aria-current="page"], .folder .env[aria-current="page"] { background: var(--env-accent); color: var(--lz-white); box-shadow: 0 0 0 2px var(--lz-white), 0 0 0 4.5px var(--env-accent), 0 4px 14px color-mix(in srgb, var(--env-accent) 45%, transparent); }
.env[aria-current="page"]::before { position: absolute; left: -14px; width: 5px; height: 36px; border-radius: 0 4px 4px 0; background: var(--env-accent); content: ""; }
.folder .env[aria-current="page"]::before { left: -18px; }
.folder-head { display: grid; width: 40px; height: 32px; place-items: center; }
.mark { display: grid; width: 24px; height: 24px; place-items: center; overflow: hidden; border-radius: var(--lz-radius-sm); background: var(--lz-white); box-shadow: inset 0 0 0 1px var(--lz-line); color: var(--lz-ink); font-size: 10px; font-weight: 600; letter-spacing: 0.02em; }
.mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
.more { display: grid; width: 40px; height: 22px; place-items: center; padding: 0; border: 0; border-radius: 999px; background: var(--lz-white); color: var(--lz-ink-muted); cursor: pointer; font-size: 11px; font-weight: 650; }
.avatar { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 50%; background: var(--lz-ink); color: var(--lz-white); font-size: 13px; font-weight: 600; }
.tip { position: fixed; z-index: 60; display: grid; max-width: 260px; padding: 6px 10px; border-radius: var(--lz-radius-sm); background: var(--lz-ink); color: var(--lz-white); font-size: 13px; line-height: 1.3; pointer-events: none; transform: translateY(-50%); box-shadow: 0 4px 14px rgb(0 0 0 / 18%); }
.tip strong { font-weight: 600; }
.tip span { color: rgb(255 255 255 / 70%); font-size: 12px; }
.tip span:empty { display: none; }
dialog { width: min(28rem, calc(100vw - 2rem)); padding: 0; border: 1px solid var(--lz-line); border-radius: 14px; background: var(--lz-white); color: var(--lz-ink); box-shadow: 0 24px 64px -24px rgb(0 0 0 / 55%); font-family: var(--lz-font-sans); }
dialog::backdrop { background: rgb(0 0 0 / 28%); }
.jump-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--lz-line-faint); color: var(--lz-ink-muted); }
.jump-head input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--lz-ink); font: inherit; font-size: 15px; }
.jump-list { display: grid; gap: 2px; max-height: 50vh; margin: 0; padding: 6px; overflow-y: auto; list-style: none; }
.jump-list a { display: grid; gap: 1px; padding: 8px 10px; border-radius: var(--lz-radius-sm); text-decoration: none; }
.jump-list a:hover, .jump-list a:focus-visible { background: var(--lz-gray-100); outline: none; }
.jump-list strong { font-size: 14px; font-weight: 600; }
.jump-list span { color: var(--lz-ink-muted); font-size: 12.5px; }
.jump-empty { padding: 10px 14px 14px; color: var(--lz-ink-muted); font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .item { transition: none; } }
`;

export const columnHeadCss = `${hostTokens}
${base}
:host { display: block; }
nav { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 3px; border-radius: var(--lz-radius-md); background: var(--lz-gray-100); }
.tab { display: flex; min-width: 0; flex-direction: column; align-items: center; gap: 2px; padding: 6px 2px 5px; border-radius: calc(var(--lz-radius-md) - 2px); color: var(--lz-ink-muted); font-size: 11px; font-weight: 550; line-height: 1.25; text-decoration: none; }
a.tab:hover { color: var(--lz-ink); }
.tab[aria-current="page"] { background: var(--lz-white); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); color: var(--lz-ink); }
.tab[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
`;
