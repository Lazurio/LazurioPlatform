import { baseCss, hostTokens } from "./base-styles";

/** One identity as `drawIdentity` draws it (F39's addendum of 2026-10-12),
 * in the column head's picker and in `<lazurio-environment>`: the glyph
 * (lz-picker__mark) in the ink, an Organization's mark or your monogram
 * inside it or the kind's icon filling it, then the name and, quieter, who
 * it is for. The picker's rules until then, under the drawing's names. */
export const identityCss = `
.identity-glyph { display: grid; width: var(--lz-space-32); height: var(--lz-space-32); flex: none; place-items: center; overflow: hidden; border-radius: var(--lz-radius-sm); color: var(--shell-ink); font-size: var(--lz-size-meta); font-weight: var(--lz-weight-akce); }
.identity-glyph > svg { display: block; width: 100%; height: auto; }
.identity-glyph .org-mark { width: 24px; height: 24px; font-size: 10px; }
/* Your personal Environment's glyph: your monogram as the rail draws it. */
.identity-glyph .initials { display: grid; width: 24px; height: 24px; place-items: center; border-radius: var(--lz-radius-sm); background: var(--shell-mark); box-shadow: inset 0 0 0 1px var(--shell-mark-line); color: var(--shell-mark-ink); font-size: 10px; font-weight: 700; letter-spacing: 0.02em; }
.identity-text { display: grid; flex: 1; min-width: 0; line-height: normal; }
.identity-name, .identity-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.identity-name { font-size: var(--lz-size-nav); font-weight: var(--lz-weight-akce); }
.identity-who { color: var(--shell-ink-muted); font-size: var(--lz-size-meta); }
`;

/** `<lazurio-environment>` (F39's addendum of 2026-10-12): the identity on
 * one line, in the size of the text around it (a header, the bar of the
 * Environment browser's view): the glyph, the name and, quieter beside it,
 * who it is for, as a line of the list of Environments draws them
 * (`lz-menu-item--compact`). Who it is for gives way first. In the host's
 * colour roles; without them, the design system's. */
export const environmentCss = `${hostTokens}
${baseCss}
${identityCss}
:host { display: inline-flex; min-width: 0; max-width: 100%; vertical-align: middle; font-size: inherit; line-height: normal; }
:host([hidden]) { display: none; }
.identity { display: flex; min-width: 0; align-items: center; gap: 0.5em; }
.identity-glyph { width: 20px; height: 20px; font-size: 9px; }
.identity-glyph > svg { width: 16px; height: 16px; }
.identity-glyph .org-mark, .identity-glyph .initials { width: 20px; height: 20px; font-size: 9px; }
.identity-text { display: flex; align-items: baseline; gap: 0.4em; }
.identity-name { flex: 0 1 auto; min-width: 0; font-size: 1em; }
.identity-who { flex: 0 100 auto; min-width: 0; font-size: 0.92em; }
`;
