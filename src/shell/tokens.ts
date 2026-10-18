import { designTokens } from "./design-tokens";

// The design system's tokens in the document of an app that loads the shell
// (F36's addendum of 2026-10-13, root decision 0200). On a Lazurio
// Environment, T3 Code's standard light look takes the design system's
// colours, type and radii: the fork maps T3 Code's own tokens onto these in
// one stylesheet, under `:root[data-lazurio-theme="light"]`, so its mapping
// applies only where Lazurio's shell is present. The shell therefore puts
// the vendored `tokens.css`, without its comments, first in the document's
// head and marks the root `data-lazurio-theme="light"`: the design system's
// light tokens, the only ones it has. Like base-styles.ts, which applies the
// same text to `:host`, it relies on the file's shape: one `:root` rule of
// `--lz-*` custom properties and nothing else, which
// tests/shell-tokens.test.ts holds, so no rule for an element, no font on
// `html` and no at-rule can reach the app, whose look changes only through
// its own mapping. Once per document; a document whose root already resolves
// any of these names (the Launchpad page, which links `tokens.css`; the
// Dashboard, which vendors it) is left as it is. The shell elements do not
// read these: each declares the same tokens on its own `:host`, so no value
// on the document reaches their shadow roots, and their colours stay the
// app's roles (0187) over the design system's.
//
// Beside the tokens, in the same style, the one custom property that says
// which colour scheme their values are in (F36's addendum of 2026-10-18,
// root decision 0208): `--lazurio-color-scheme: light`, on every document
// that gets the tokens, from the moment the script evaluates, with or
// without an Environment theme. MausBot's "Environment" skin keys its code
// palette on it. An Environment theme's dark values set it to `dark` where
// they apply (theme.ts); nothing else changes it.

/** The mark on `<html>` once the shell declared the tokens there (interface
 * v1, `declares.theme`). */
export const shellTheme = Object.freeze({
  attribute: "data-lazurio-theme",
  value: "light",
} as const);

/** The vendored `tokens.css` without its comments. */
const designTokensCss = designTokens.replace(/\/\*[\s\S]*?\*\//g, "");

/** The scheme the tokens' values are in, declared with them (interface v1,
 * `declares.environmentTheme.properties`). */
export const shellColorSchemeCss = ":root { --lazurio-color-scheme: light; }\n";

/** What the shell puts in an app's document: the vendored `tokens.css`
 * without its comments, then the scheme of its values. */
export const shellTokensCss = `${designTokensCss}${shellColorSchemeCss}`;

/** The names it declares, in its order. */
const tokenNames = [...designTokensCss.matchAll(/(--lz-[\w-]+)\s*:/g)].flatMap(
  (match) => (match[1] === undefined ? [] : [match[1]]),
);

/** The part of a document the tokens touch. */
export type TokenDocument = {
  querySelector(selectors: string): object | null;
  createElement(tagName: "style"): {
    readonly dataset: Record<string, string | undefined>;
    textContent: string | null;
  };
  readonly head: { prepend(node: unknown): void };
  readonly documentElement: { setAttribute(name: string, value: string): void };
  readonly defaultView: {
    getComputedStyle(element: TokenDocument["documentElement"]): {
      getPropertyValue(property: string): string;
    };
  } | null;
};

/** Declares the design system's tokens on the document's root once, first
 * in its head so a stylesheet of the document's own wins over them, and
 * marks the root; a document whose root already resolves any of them keeps
 * its own and gets neither. */
export function installShellTokens(target: TokenDocument): void {
  if (target.querySelector("style[data-lazurio-tokens]") !== null) return;
  const first = tokenNames[0];
  if (first === undefined) return;
  const root = target.documentElement;
  const computed = target.defaultView?.getComputedStyle(root) ?? null;
  const resolves = (name: string) =>
    computed !== null && computed.getPropertyValue(name).trim() !== "";
  if (tokenNames.some((name) => resolves(name))) return;
  const style = target.createElement("style");
  style.dataset.lazurioTokens = "";
  style.textContent = shellTokensCss;
  target.head.prepend(style);
  // The mark only where the tokens hold: under a policy that refuses inline
  // styles they do not, and a fork's mapping onto them would paint nothing.
  if (computed !== null && !resolves(first)) return;
  root.setAttribute(shellTheme.attribute, shellTheme.value);
}
