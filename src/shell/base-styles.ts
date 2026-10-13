import { designTokens } from "./design-tokens";

// What every shell element's stylesheet starts from, inside its shadow root:
// the Lazurio design system's tokens (vendored byte-for-byte, declared on
// `:root`, here applied to `:host` so they hold inside the shadow root
// whatever the document's root declares; tokens.ts declares them on the
// document for the app), the colour roles and an Organization's mark. The
// rail's and the column head's components are in styles.ts, one identity's
// drawing in identity-styles.ts; kept apart so a page that draws only
// `<lazurio-environment>` (the Environment browser's view) carries only
// what it uses.
//
// Colours (F36, addendum of 2026-10-04, evening; prototypes-lazurio
// 5411279, `shell-theme.css`): the elements have no palette of their own.
// They take the colours of the app they sit in through the colour roles of
// interface v1 (`--lazurio-surface`, `--lazurio-ink`, …), custom properties
// the host sets on its document, which inherit into these shadow roots. The
// components use only the `--shell-*` names, each bound to a role with the
// design system's value as its fallback: without roles the elements look
// as the design system draws them. A `--shell-host-*` name is mixed from a
// role and stays unset while the host sets none (a `var()` without a
// fallback); it is only ever read with the design system's value as
// fallback.

/** The tokens, scoped to the element. */
export const hostTokens = designTokens.replace(":root", ":host");

/** The colour roles bound to the shell's names, the element's own text, and
 * an Organization's mark (its avatar or initials). */
export const baseCss = `
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
