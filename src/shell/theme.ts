import type { Store } from "./account";
import {
  parseShellTheme,
  type ShellTheme,
  type ShellThemeValues,
  shellThemeColors,
} from "./contract";

// The Environment's theme in the app's document (F36's addendum of
// 2026-10-18, root decision 0208). The Launchpad owns one theme per
// Environment and names it in `lazurio.shell.v1` (`theme`, contract.ts); the
// shell declares its values on the root of every document it loads into, as
// values of the token names interface v1 promises (`declares.tokens`), so
// whatever an app maps onto those names follows the theme: T3 Code's
// standard look, MausBot's "Environment" skin and the Launchpad itself. The
// names stay promised and their values never are.
//
// One `<style data-lazurio-environment-theme>`: right after the tokens the
// shell installed itself (tokens.ts), so the app's own stylesheets still win
// over it; or the one a host placed after its own tokens (the Launchpad
// page). A document that has its own tokens and no such element keeps its
// own look. The style holds the light values on `:root`, always, and where
// the theme has a dark variant the dark values twice: where the host shows
// dark by itself (`class="dark"` on `<html>`, as T3 Code toggles it, or
// `data-lazurio-appearance="dark"`) and, where the host follows the device
// (`data-lazurio-appearance="device"`, MausBot and the Launchpad), under
// `prefers-color-scheme: dark`. Each block also says its scheme in
// `--lazurio-color-scheme`. Values are literal `#rrggbb` colours, never
// references and never `light-dark()`: an app may read them from script.
//
// Marks on `<html>`, only where the values hold (under a policy that refuses
// inline styles they do not, and a mapping onto them would paint nothing):
// `data-lazurio-environment-theme="<id>"`, and `data-lazurio-theme-dark`
// where the theme has dark values. The design system's mark
// `data-lazurio-theme="light"` (tokens.ts) stays as it is.
//
// First paint: when `/.lazurio/shell.js` evaluates, the shell declares the
// theme it last saw on this origin (`localStorage`, `lazurio.shell.theme`),
// synchronously, before the app's own module runs (both are deferred
// modules, executed in document order). The document's theme replaces it
// when it differs; on the first visit of an origin the look changes once,
// from the design system's to the theme. A change elsewhere arrives when the
// page is shown again: the elements read `/.lazurio/shell.json` again on
// `visibilitychange` and `focus` (elements.ts), and a tab of the same origin
// that stored a newer theme is followed at once (`storage`). Every change of
// the declared theme is announced as `lazurio-theme` on the document.

/** The names of the Environment theme in the document (interface v1,
 * `declares.environmentTheme` and `document`). */
export const environmentTheme = Object.freeze({
  /** On the style the values are in, and on `<html>` with the theme's id. */
  attribute: "data-lazurio-environment-theme",
  /** On `<html>` where the theme has dark values. */
  dark: "data-lazurio-theme-dark",
  /** A host's own switch on `<html>`: `device`, `light` or `dark`. */
  appearance: "data-lazurio-appearance",
  /** The class on `<html>` with which a host shows dark (T3 Code's). */
  darkClass: "dark",
  /** `light` or `dark`: the scheme of the values in effect. */
  scheme: "--lazurio-color-scheme",
  /** Dispatched on the document after the declared theme changed. */
  event: "lazurio-theme",
  /** This origin's memory of the last theme, in `localStorage`. */
  cacheKey: "lazurio.shell.theme",
} as const);

const declarations = (
  values: ShellThemeValues,
  scheme: "light" | "dark",
  indent: string,
) =>
  [
    ...shellThemeColors.map((name) => `${indent}${name}: ${values[name]};`),
    `${indent}${environmentTheme.scheme}: ${scheme};`,
  ].join("\n");

/** The style of a theme: the light values on `:root`, and where it has dark
 * values those where the host shows dark and, for a host that follows the
 * device, under `prefers-color-scheme: dark`. Throws on a theme that is not
 * one, so nothing unchecked ever reaches a stylesheet. */
export function environmentThemeCss(input: ShellTheme): string {
  const theme = parseShellTheme(input);
  if (theme === undefined || theme === false)
    throw new Error("Not an Environment theme");
  const light = `:root {\n${declarations(theme.light, "light", "  ")}\n}\n`;
  if (theme.dark === undefined) return light;
  return [
    light,
    `:root:is(.${environmentTheme.darkClass}, [${environmentTheme.appearance}="dark"]) {\n${declarations(theme.dark, "dark", "  ")}\n}\n`,
    `@media (prefers-color-scheme: dark) {\n  :root[${environmentTheme.appearance}="device"] {\n${declarations(theme.dark, "dark", "    ")}\n  }\n}\n`,
  ].join("");
}

/** A theme as one text in a fixed order: what this origin keeps, and how
 * two themes are compared. */
export function themeText(theme: ShellTheme): string {
  const ordered = (values: ShellThemeValues) =>
    Object.fromEntries(shellThemeColors.map((name) => [name, values[name]]));
  return JSON.stringify({
    id: theme.id,
    label: theme.label,
    revision: theme.revision,
    light: ordered(theme.light),
    ...(theme.dark === undefined ? {} : { dark: ordered(theme.dark) }),
  });
}

/** The style element the theme is written into. */
export type ThemeStyle = {
  readonly dataset: Record<string, string | undefined>;
  textContent: string | null;
  after(node: unknown): void;
};

/** The part of a document the theme touches. */
export type ThemeDocument = {
  querySelector(selectors: string): ThemeStyle | null;
  createElement(tagName: "style"): ThemeStyle;
  readonly documentElement: {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  readonly defaultView: {
    getComputedStyle(element: ThemeDocument["documentElement"]): {
      getPropertyValue(property: string): string;
    };
  } | null;
};

/** Declares `theme` in the document, or with null none: the values into its
 * style (the one a host placed, else one right after the tokens the shell
 * installed; neither, and the document keeps its own look), and the marks
 * where the values hold. Whether the theme is in effect. */
export function applyEnvironmentTheme(
  target: ThemeDocument,
  theme: ShellTheme | null,
): boolean {
  const root = target.documentElement;
  const unmark = () => {
    root.removeAttribute(environmentTheme.attribute);
    root.removeAttribute(environmentTheme.dark);
  };
  let style = target.querySelector(`style[${environmentTheme.attribute}]`);
  if (theme === null) {
    // A host's element stays where the host put it, empty.
    if (style !== null && style.textContent !== "") style.textContent = "";
    unmark();
    return false;
  }
  if (style === null) {
    const tokens = target.querySelector("style[data-lazurio-tokens]");
    if (tokens === null) {
      unmark();
      return false;
    }
    style = target.createElement("style");
    style.dataset.lazurioEnvironmentTheme = "";
    tokens.after(style);
  }
  const css = environmentThemeCss(theme);
  if (style.textContent !== css) style.textContent = css;
  // The values hold where the root resolves the surface to one of the
  // theme's own: never under a policy that refuses inline styles.
  const computed = target.defaultView?.getComputedStyle(root) ?? null;
  const surface =
    computed?.getPropertyValue("--lz-surface").trim().toLowerCase() ?? null;
  if (
    computed !== null &&
    surface !== theme.light["--lz-surface"] &&
    surface !== theme.dark?.["--lz-surface"]
  ) {
    unmark();
    return false;
  }
  root.setAttribute(environmentTheme.attribute, theme.id);
  if (theme.dark === undefined) root.removeAttribute(environmentTheme.dark);
  else root.setAttribute(environmentTheme.dark, "");
  return true;
}

/** What `lazurio-theme` says: the theme now declared, or null for none. */
export type EnvironmentThemeChange = Readonly<{
  id: string;
  revision: number;
  dark: boolean;
}> | null;

const changeOf = (theme: ShellTheme | null): EnvironmentThemeChange =>
  theme === null
    ? null
    : Object.freeze({
        id: theme.id,
        revision: theme.revision,
        dark: theme.dark !== undefined,
      });

/** The page's Environment theme: what is declared, this origin's memory of
 * it and the announcement of a change. Free of the browser's globals, so it
 * is tested with a stand-in document and store. */
export function createEnvironmentTheme(
  options: Readonly<{
    document: ThemeDocument | null;
    store: Store | null;
    announce?: (change: EnvironmentThemeChange) => void;
  }>,
) {
  // Undefined until something decided: the remembered theme or a document.
  let current: ShellTheme | null | undefined;
  const textOf = (theme: ShellTheme | null) =>
    theme === null ? "null" : themeText(theme);
  /** A remembered theme: null when none is kept, undefined when what is
   * kept is not one. */
  const parse = (text: string | null): ShellTheme | null | undefined => {
    if (text === null) return null;
    try {
      const theme = parseShellTheme(JSON.parse(text));
      return theme === false ? undefined : (theme ?? undefined);
    } catch {
      return undefined;
    }
  };
  const show = (theme: ShellTheme | null) => {
    current = theme;
    if (options.document !== null)
      applyEnvironmentTheme(options.document, theme);
  };
  const keep = (theme: ShellTheme | null) => {
    try {
      if (theme === null) options.store?.removeItem(environmentTheme.cacheKey);
      else {
        const text = themeText(theme);
        if (options.store?.getItem(environmentTheme.cacheKey) !== text)
          options.store?.setItem(environmentTheme.cacheKey, text);
      }
    } catch {}
  };
  return Object.freeze({
    /** The theme declared now; undefined before anything decided. */
    current: (): ShellTheme | null | undefined => current,
    /** As the script evaluates: the theme this origin remembers, declared at
     * once, unless a document already decided. What is kept but is no theme
     * is forgotten. */
    start(): void {
      if (current !== undefined) return;
      let text: string | null = null;
      try {
        text = options.store?.getItem(environmentTheme.cacheKey) ?? null;
      } catch {
        return;
      }
      const remembered = parse(text);
      if (remembered === undefined) {
        keep(null);
        return;
      }
      if (remembered !== null) show(remembered);
    },
    /** The theme of a person's document (null: it names none): declared
     * where it differs from what is, remembered, and announced. */
    provide(theme: ShellTheme | null): void {
      const before = current;
      keep(theme);
      if (before !== undefined && textOf(before) === textOf(theme)) return;
      show(theme);
      // Nothing was declared and nothing is: no change to announce.
      if (before === undefined && theme === null) return;
      options.announce?.(changeOf(theme));
    },
    /** Another tab of this origin stored `text`: followed unless it is no
     * theme or older than the one declared. */
    stored(text: string | null): void {
      const theme = parse(text);
      if (theme === undefined) return;
      if (
        theme !== null &&
        current !== undefined &&
        current !== null &&
        theme.revision < current.revision
      )
        return;
      if (current !== undefined && textOf(current) === textOf(theme)) return;
      if (current === undefined && theme === null) return;
      show(theme);
      options.announce?.(changeOf(theme));
    },
  });
}

export type EnvironmentThemeRuntime = ReturnType<typeof createEnvironmentTheme>;
