import { expect, test } from "bun:test";
import type { Store } from "../src/shell/account";
import {
  parseShell,
  parseShellTheme,
  type ShellTheme,
  type ShellThemeValues,
  shellThemeColors,
} from "../src/shell/contract";
import { shellElementInterface } from "../src/shell/interface";
import {
  applyEnvironmentTheme,
  createEnvironmentTheme,
  type EnvironmentThemeChange,
  environmentTheme,
  environmentThemeCss,
  type ThemeDocument,
  type ThemeStyle,
  themeText,
} from "../src/shell/theme";
import { shellColorSchemeCss } from "../src/shell/tokens";

// F36's addendum of 2026-10-18 (root decision 0208): `lazurio.shell.v1`
// names the Environment's theme, and the shell declares its values for the
// promised colour names on the app's document: one style right after the
// tokens it installed (or in a host's own place), light on `:root`, dark
// where the host shows dark, the marks on `<html>` where the values hold,
// the last theme remembered on the origin and declared at once as the
// script evaluates, a newer document's or another tab's theme in its place,
// every change announced as `lazurio-theme`.

const values = (colour: string): ShellThemeValues =>
  Object.fromEntries(
    shellThemeColors.map((name) => [name, colour]),
  ) as ShellThemeValues;

const ocean = (revision = 3): ShellTheme => ({
  id: "ocean",
  label: "Ocean",
  revision,
  light: { ...values("#cdd4dc"), "--lz-surface": "#f5f7f8" },
  dark: { ...values("#405567"), "--lz-surface": "#17212b" },
});
const lazurio = (revision = 0): ShellTheme => ({
  id: "lazurio",
  label: "Lazurio",
  revision,
  light: { ...values("#dddcdb"), "--lz-surface": "#ffffff" },
});

test("the colour names a theme gives values for are the promised colours, without the type and the radius", () => {
  const promised = shellElementInterface.declares.tokens;
  expect([...shellThemeColors] as string[]).toEqual(
    promised.filter((name) => !/^--lz-(font|radius)-/.test(name)),
  );
  expect(shellThemeColors.length).toBe(20);
});

test("a theme member is read in its exact shape, its colours in lowercase", () => {
  const read = parseShellTheme({
    ...ocean(),
    light: { ...ocean().light, "--lz-ink": "#ABCDEF" },
    // A name this version does not know is ignored, never refused.
    later: true,
  });
  expect(read).not.toBe(false);
  if (read === false || read === undefined) throw new Error("read");
  expect(read.light["--lz-ink"]).toBe("#abcdef");
  expect(Object.keys(read)).toEqual([
    "id",
    "label",
    "revision",
    "light",
    "dark",
  ]);
  expect(Object.keys(read.light)).toEqual([...shellThemeColors]);
  // Absent or null is none; dark is optional.
  expect(parseShellTheme(undefined)).toBeUndefined();
  expect(parseShellTheme(null)).toBeUndefined();
  expect(parseShellTheme(lazurio())).toEqual(lazurio());
  expect(parseShellTheme({ ...lazurio(), dark: null })).toEqual(lazurio());
  // Unknown names inside an appearance are dropped.
  const extra = parseShellTheme({
    ...lazurio(),
    light: { ...lazurio().light, "--lz-later": "#000000" },
  });
  expect(extra === false ? null : extra?.light).toEqual(lazurio().light);
  const { "--lz-paper": _, ...withoutPaper } = lazurio().light;
  for (const refused of [
    "ocean",
    [],
    { ...lazurio(), id: "Ocean" },
    { ...lazurio(), id: "o".repeat(33) },
    { ...lazurio(), id: "-ocean" },
    { ...lazurio(), label: "" },
    { ...lazurio(), label: "x".repeat(65) },
    { ...lazurio(), label: "Line\nbreak" },
    { ...lazurio(), revision: -1 },
    { ...lazurio(), revision: 1.5 },
    { ...lazurio(), revision: "1" },
    { ...lazurio(), light: withoutPaper },
    { ...lazurio(), light: { ...lazurio().light, "--lz-ink": "#fff" } },
    { ...lazurio(), light: { ...lazurio().light, "--lz-ink": "var(--x)" } },
    {
      ...lazurio(),
      light: { ...lazurio().light, "--lz-ink": "#000000; color: red" },
    },
    {
      ...lazurio(),
      light: { ...lazurio().light, "--lz-ink": "light-dark(#000, #fff)" },
    },
    {
      ...lazurio(),
      light: { ...lazurio().light, "--lz-ink": "oklch(0.2 0 0)" },
    },
    { ...lazurio(), dark: "dark" },
    { ...lazurio(), dark: { ...lazurio().light, "--lz-ink": "red" } },
  ])
    expect(parseShellTheme(refused)).toBe(false);
});

const document = (extra: Record<string, unknown> = {}) => ({
  schema: "lazurio.shell.v1",
  locale: "cs",
  current: "local",
  operator: { initials: null, login: null, avatar: null },
  environments: [
    {
      id: "local",
      label: null,
      kind: "workstation",
      organizations: [],
      assignee: null,
      apps: { apps: "/", chat: null, automate: null },
    },
  ],
  organizations: [],
  dashboard: "https://dashboard.lazurio.ai/home",
  account: "https://dashboard.lazurio.ai/settings/account",
  addOrganization: null,
  ...extra,
});

test("the shell document carries the theme beside a current Environment, and is refused with a broken one", () => {
  expect(parseShell(document({ theme: ocean() }))?.theme).toEqual(ocean());
  const none = parseShell(document());
  expect(none).not.toBeNull();
  expect(Object.hasOwn(none as object, "theme")).toBe(false);
  expect(
    Object.hasOwn(parseShell(document({ theme: null })) as object, "theme"),
  ).toBe(false);
  // Every known member in its exact shape: a broken theme refuses the
  // document, as a broken `setup` does.
  expect(parseShell(document({ theme: { ...ocean(), id: 1 } }))).toBeNull();
  // A page that belongs to no Environment has no Environment theme.
  expect(parseShell(document({ current: null }))).not.toBeNull();
  expect(parseShell(document({ current: null, theme: ocean() }))).toBeNull();
  expect(parseShell(document({ current: null, theme: null }))).toBeNull();
});

test("the style: the light values on the root, always with the scheme; the dark ones where the host shows dark", () => {
  const light = environmentThemeCss(lazurio());
  expect(light).toBe(
    `:root {\n${shellThemeColors.map((name) => `  ${name}: ${lazurio().light[name]};`).join("\n")}\n  --lazurio-color-scheme: light;\n}\n`,
  );
  // A light-only theme has no dark rule at all.
  expect(light).not.toContain("dark");
  const css = environmentThemeCss(ocean());
  const blocks = css.split(/\n(?=:root|@media)/);
  expect(blocks).toHaveLength(3);
  expect(blocks[0]?.startsWith(":root {\n")).toBe(true);
  expect(
    blocks[1]?.startsWith(
      ':root:is(.dark, [data-lazurio-appearance="dark"]) {\n',
    ),
  ).toBe(true);
  expect(
    blocks[2]?.startsWith(
      '@media (prefers-color-scheme: dark) {\n  :root[data-lazurio-appearance="device"] {\n',
    ),
  ).toBe(true);
  // Every block declares every promised colour name and its scheme: light
  // in the first, dark in both dark ones.
  for (const [block, scheme, theme] of [
    [blocks[0], "light", ocean().light],
    [blocks[1], "dark", ocean().dark],
    [blocks[2], "dark", ocean().dark],
  ] as const) {
    for (const name of shellThemeColors)
      expect(block).toContain(`${name}: ${theme?.[name]};`);
    expect(block).toContain(`--lazurio-color-scheme: ${scheme};`);
    expect(block?.match(/--lazurio-color-scheme/g)).toHaveLength(1);
  }
  // Literal colours only: nothing an app reading a value from script could
  // not take (no `var()`, no `light-dark()`), nothing that could end the
  // style.
  const declared = [...css.matchAll(/(--[\w-]+): ([^;]*);/g)];
  expect(declared).toHaveLength(3 * (shellThemeColors.length + 1));
  for (const [, name, value] of declared)
    expect([name, value]).toEqual([
      name,
      name === "--lazurio-color-scheme"
        ? (value?.match(/^(light|dark)$/)?.[0] ?? "no scheme")
        : (value?.match(/^#[0-9a-f]{6}$/)?.[0] ?? "no colour"),
    ]);
  expect(css).not.toContain("<");
  // What is not a theme never reaches a stylesheet.
  expect(() =>
    environmentThemeCss({
      ...lazurio(),
      light: { ...lazurio().light, "--lz-ink": "red}body{x" },
    }),
  ).toThrow();
});

type FakeStyle = ThemeStyle & { parent: FakeStyle[] };

/** A document with the shell's tokens (or a host's own place, or neither) in
 * its head; `holds` decides whether an inline style applies (a policy that
 * refuses them does not), and `dark` whether its dark values are shown. */
function fakeDocument(
  options: Readonly<{
    tokens?: boolean;
    place?: boolean;
    holds?: boolean;
    dark?: boolean;
    window?: boolean;
  }> = {},
) {
  const head: FakeStyle[] = [];
  const attributes = new Map<string, string>([["data-lazurio-theme", "light"]]);
  const style = (dataset: Record<string, string | undefined>): FakeStyle => {
    const node: FakeStyle = {
      dataset,
      textContent: null,
      parent: head,
      after(other) {
        head.splice(head.indexOf(node) + 1, 0, other as FakeStyle);
      },
    };
    return node;
  };
  if (options.tokens ?? true) head.push(style({ lazurioTokens: "" }));
  if (options.place === true) head.push(style({ lazurioEnvironmentTheme: "" }));
  head.push(style({ app: "" }));
  const find = (key: string) =>
    head.find((node) => node.dataset[key] !== undefined) ?? null;
  const theme = () => find("lazurioEnvironmentTheme");
  const surface = () => {
    const text = theme()?.textContent ?? "";
    const block =
      options.dark === true && text.includes(":root:is(")
        ? text.slice(text.indexOf(":root:is("))
        : text;
    return /--lz-surface: (#[0-9a-f]{6});/.exec(block)?.[1] ?? "#ffffff";
  };
  const doc: ThemeDocument = {
    querySelector: (selectors) =>
      selectors === "style[data-lazurio-environment-theme]"
        ? theme()
        : selectors === "style[data-lazurio-tokens]"
          ? find("lazurioTokens")
          : null,
    createElement: () => style({}),
    documentElement: {
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
    },
    defaultView:
      options.window === false
        ? null
        : {
            getComputedStyle: () => ({
              getPropertyValue: (name) =>
                name === "--lz-surface" && (options.holds ?? true)
                  ? ` ${surface().toUpperCase()}`
                  : name === "--lz-surface"
                    ? "#ffffff"
                    : "",
            }),
          },
  };
  return { doc, head, attributes, theme };
}

test("the shell writes the theme right after the tokens it installed and marks the root where the values hold", () => {
  const page = fakeDocument();
  expect(applyEnvironmentTheme(page.doc, ocean())).toBe(true);
  // Right after the tokens, before the app's own style, which wins.
  expect(page.head.map((node) => Object.keys(node.dataset)[0])).toEqual([
    "lazurioTokens",
    "lazurioEnvironmentTheme",
    "app",
  ]);
  expect(page.theme()?.textContent).toBe(environmentThemeCss(ocean()));
  expect([...page.attributes]).toEqual([
    ["data-lazurio-theme", "light"],
    ["data-lazurio-environment-theme", "ocean"],
    ["data-lazurio-theme-dark", ""],
  ]);
  // Swapped for a light-only theme: the same style, the dark mark gone, the
  // design system's mark kept.
  expect(applyEnvironmentTheme(page.doc, lazurio())).toBe(true);
  expect(page.head).toHaveLength(3);
  expect(page.theme()?.textContent).toBe(environmentThemeCss(lazurio()));
  expect([...page.attributes]).toEqual([
    ["data-lazurio-theme", "light"],
    ["data-lazurio-environment-theme", "lazurio"],
  ]);
  // None: the style emptied, the marks gone, the tokens' mark kept.
  expect(applyEnvironmentTheme(page.doc, null)).toBe(false);
  expect(page.theme()?.textContent).toBe("");
  expect([...page.attributes]).toEqual([["data-lazurio-theme", "light"]]);
  // The values hold also where the host shows the dark ones.
  const dark = fakeDocument({ dark: true });
  expect(applyEnvironmentTheme(dark.doc, ocean())).toBe(true);
  expect(dark.attributes.get("data-lazurio-environment-theme")).toBe("ocean");
});

test("a host's own place takes the theme; a document with its own tokens and no place keeps its look", () => {
  const host = fakeDocument({ tokens: false, place: true });
  expect(applyEnvironmentTheme(host.doc, ocean())).toBe(true);
  expect(host.head).toHaveLength(2);
  expect(host.theme()?.textContent).toBe(environmentThemeCss(ocean()));
  expect(host.attributes.get("data-lazurio-environment-theme")).toBe("ocean");
  const own = fakeDocument({ tokens: false });
  expect(applyEnvironmentTheme(own.doc, ocean())).toBe(false);
  expect(own.head).toHaveLength(1);
  expect(own.attributes.has("data-lazurio-environment-theme")).toBe(false);
});

test("where an inline style does not apply, the root is not marked; without a window it is", () => {
  const refused = fakeDocument({ holds: false });
  expect(applyEnvironmentTheme(refused.doc, ocean())).toBe(false);
  expect(refused.attributes.has("data-lazurio-environment-theme")).toBe(false);
  expect(refused.attributes.has("data-lazurio-theme-dark")).toBe(false);
  // Lazurio's values are the tokens' own: they hold where the tokens do.
  expect(applyEnvironmentTheme(refused.doc, lazurio())).toBe(true);
  const bare = fakeDocument({ window: false });
  expect(applyEnvironmentTheme(bare.doc, ocean())).toBe(true);
  expect(bare.attributes.get("data-lazurio-theme-dark")).toBe("");
});

test("the scheme is light from the start, with the tokens, and dark only in a theme's dark values", () => {
  // The shell's tokens declare it with them on every document, cached theme
  // or not (tests/shell-tokens.test.ts); a theme's light values say light
  // again, its dark ones dark.
  expect(shellColorSchemeCss).toContain("--lazurio-color-scheme: light;");
  expect(shellElementInterface.declares.environmentTheme.properties).toContain(
    environmentTheme.scheme,
  );
  const css = environmentThemeCss(ocean());
  expect(css.match(/--lazurio-color-scheme: light;/g)).toHaveLength(1);
  expect(css.match(/--lazurio-color-scheme: dark;/g)).toHaveLength(2);
});

/** A store that is this origin's `localStorage`; `refusing` throws as a
 * browser that blocks it does. */
function fakeStore(initial: Record<string, string> = {}, refusing = false) {
  const kept = new Map(Object.entries(initial));
  const store: Store = {
    getItem: (key) => {
      if (refusing) throw new Error("blocked");
      return kept.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (refusing) throw new Error("blocked");
      kept.set(key, value);
    },
    removeItem: (key) => {
      if (refusing) throw new Error("blocked");
      kept.delete(key);
    },
  };
  return { store, kept };
}

function runtime(initial: Record<string, string> = {}, page = fakeDocument()) {
  const { store, kept } = fakeStore(initial);
  const changes: EnvironmentThemeChange[] = [];
  const theme = createEnvironmentTheme({
    document: page.doc,
    store,
    announce: (change) => changes.push(change),
  });
  return { theme, kept, changes, page };
}

const key = environmentTheme.cacheKey;

test("as the script evaluates, the theme this origin remembers is declared at once, before any document", () => {
  const { theme, page, changes } = runtime({ [key]: themeText(ocean()) });
  // Synchronously: no promise, no waiting.
  expect(theme.start()).toBeUndefined();
  expect(page.theme()?.textContent).toBe(environmentThemeCss(ocean()));
  expect(page.attributes.get("data-lazurio-environment-theme")).toBe("ocean");
  expect(page.attributes.get("data-lazurio-theme")).toBe("light");
  expect(theme.current()).toEqual(ocean());
  expect(changes).toEqual([]);
  // A second start changes nothing.
  theme.start();
  expect(page.head).toHaveLength(3);
});

test("nothing remembered: nothing declared until the document; what is kept but is no theme is forgotten", () => {
  const empty = runtime();
  empty.theme.start();
  expect(empty.page.theme()).toBeNull();
  expect(empty.theme.current()).toBeUndefined();
  for (const broken of ["{", "null", JSON.stringify({ ...ocean(), id: 1 })]) {
    const run = runtime({ [key]: broken });
    run.theme.start();
    expect(run.page.theme()).toBeNull();
    expect(run.kept.has(key)).toBe(false);
  }
  // A browser that blocks storage: no memory, the document decides.
  const { store } = fakeStore({}, true);
  const page = fakeDocument();
  const blocked = createEnvironmentTheme({ document: page.doc, store });
  blocked.start();
  blocked.provide(ocean());
  expect(page.attributes.get("data-lazurio-environment-theme")).toBe("ocean");
});

test("the document's theme replaces the remembered one only where it differs, and is remembered and announced", () => {
  const { theme, page, kept, changes } = runtime({
    [key]: themeText(ocean(3)),
  });
  theme.start();
  // The same theme: nothing redrawn, nothing announced.
  const before = page.theme()?.textContent;
  theme.provide(ocean(3));
  expect(page.theme()?.textContent).toBe(before);
  expect(changes).toEqual([]);
  // A new revision of the same palette, or another theme: declared,
  // remembered, announced.
  theme.provide(ocean(4));
  expect(changes).toEqual([{ id: "ocean", revision: 4, dark: true }]);
  expect(kept.get(key)).toBe(themeText(ocean(4)));
  theme.provide(lazurio(5));
  expect(page.theme()?.textContent).toBe(environmentThemeCss(lazurio(5)));
  expect(page.attributes.has("data-lazurio-theme-dark")).toBe(false);
  expect(changes.at(-1)).toEqual({ id: "lazurio", revision: 5, dark: false });
  // Values that changed under the same revision (a release's new palette)
  // are a change too.
  theme.provide({
    ...lazurio(5),
    light: { ...lazurio(5).light, "--lz-ink": "#111111" },
  });
  expect(page.theme()?.textContent).toContain("--lz-ink: #111111;");
  // A document without one: nothing declared, nothing remembered.
  theme.provide(null);
  expect(page.theme()?.textContent).toBe("");
  expect(page.attributes.has("data-lazurio-environment-theme")).toBe(false);
  expect(kept.has(key)).toBe(false);
  expect(changes.at(-1)).toBeNull();
});

test("the first document of an origin declares its theme and remembers it; a document decides before the memory is read", () => {
  const first = runtime();
  first.theme.start();
  first.theme.provide(ocean());
  expect(first.page.attributes.get("data-lazurio-environment-theme")).toBe(
    "ocean",
  );
  expect(first.kept.get(key)).toBe(themeText(ocean()));
  expect(first.changes).toEqual([{ id: "ocean", revision: 3, dark: true }]);
  // A host that hands its document over before the elements are defined:
  // the memory, older, does not replace it.
  const host = runtime({ [key]: themeText(lazurio(1)) });
  host.theme.provide(ocean());
  host.theme.start();
  expect(host.page.theme()?.textContent).toBe(environmentThemeCss(ocean()));
  // Nothing declared and nothing named: nothing to announce.
  const quiet = runtime();
  quiet.theme.provide(null);
  expect(quiet.changes).toEqual([]);
  expect(quiet.page.theme()).toBeNull();
});

test("another tab of the origin that stored a newer theme is followed at once; an older or broken one is not", () => {
  const { theme, page, changes } = runtime({ [key]: themeText(ocean(3)) });
  theme.start();
  theme.stored(themeText(lazurio(4)));
  expect(page.attributes.get("data-lazurio-environment-theme")).toBe("lazurio");
  expect(changes).toEqual([{ id: "lazurio", revision: 4, dark: false }]);
  // An older revision, the same theme again, or no theme: ignored.
  theme.stored(themeText(ocean(3)));
  theme.stored(themeText(lazurio(4)));
  theme.stored("{");
  theme.stored(JSON.stringify({ ...ocean(9), light: {} }));
  expect(page.attributes.get("data-lazurio-environment-theme")).toBe("lazurio");
  expect(changes).toHaveLength(1);
  // The other tab's document had none: neither has this one.
  theme.stored(null);
  expect(page.attributes.has("data-lazurio-environment-theme")).toBe(false);
  expect(changes.at(-1)).toBeNull();
});
