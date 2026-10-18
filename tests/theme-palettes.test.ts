import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseShellTheme,
  type ShellThemeColor,
  type ShellThemeValues,
  shellThemeColors,
} from "../src/shell/contract";
import { designTokens } from "../src/shell/design-tokens";
import {
  designSystemSuccess,
  designSystemValues,
  environmentThemeChoice,
  environmentThemeChoices,
  environmentThemeIds,
  paletteHex,
  shellThemeOf,
  themeProjection,
} from "../src/theme/palettes";
import {
  BUILT_IN_THEMES,
  EMBER_THEME,
  GROVE_THEME,
  IRIS_THEME,
  OCEAN_THEME,
} from "../src/theme/vendor/t3code/themePalettes";

/** A token's resolved value, which the test needs to be there. */
const value = (design: Readonly<Record<string, string>>, name: string) => {
  const found = design[name];
  if (found === undefined) throw new Error(`No ${name}`);
  return found;
};

// Root decision 0208 point 2 (F36's addendum of 2026-10-18): the themes an
// Environment may take are Lazurio, exactly the design system's tokens and
// light only, and T3 Code's four built-ins, vendored byte for byte and
// projected onto the promised colour names; T3 Chat is not offered. Each
// theme holds the contrast its names are used for, in every appearance it
// has.

test("every vendored file has the hash its README records", async () => {
  const directory = join(import.meta.dir, "..", "src", "theme", "vendor");
  const readme = await readFile(join(directory, "README.md"), "utf8");
  const rows = [
    ...readme.matchAll(/\| `([^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|/g),
  ];
  expect(rows.map((row) => row[1])).toEqual([
    "t3code/themePalettes.ts",
    "t3code/LICENSE",
  ]);
  for (const [, file, hash] of rows) {
    const bytes = await readFile(join(directory, file ?? ""));
    expect([file, createHash("sha256").update(bytes).digest("hex")]).toEqual([
      file,
      hash,
    ]);
  }
  const licence = await readFile(join(directory, "t3code", "LICENSE"), "utf8");
  expect(
    licence.startsWith("MIT License\n\nCopyright (c) 2026 T3 Tools Inc."),
  ).toBe(true);
});

test("the themes: Lazurio first and by default, then Grove, Ocean, Ember and Iris; never T3 Chat", () => {
  expect(environmentThemeChoices.map(({ id, label }) => [id, label])).toEqual([
    ["lazurio", "Lazurio"],
    ["grove", "Grove"],
    ["ocean", "Ocean"],
    ["ember", "Ember"],
    ["iris", "Iris"],
  ]);
  expect([...environmentThemeIds]).toEqual(
    environmentThemeChoices.map((choice) => choice.id),
  );
  // T3's own brand palette is in the vendored file and nowhere else.
  expect(BUILT_IN_THEMES.map((theme) => theme.id)).toContain("t3-chat");
  expect(JSON.stringify(environmentThemeChoices)).not.toContain("t3-chat");
  // Every choice is a theme the shell reads, every value a literal colour.
  for (const choice of environmentThemeChoices) {
    expect(parseShellTheme({ ...choice, revision: 0 })).toEqual({
      ...choice,
      revision: 0,
    });
    for (const appearance of [choice.light, choice.dark])
      if (appearance !== undefined)
        for (const name of shellThemeColors)
          expect(appearance[name]).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test("Lazurio is exactly the vendored tokens' values, light only", () => {
  const lazurio = environmentThemeChoice("lazurio");
  expect(lazurio.dark).toBeUndefined();
  const design = designSystemValues();
  for (const name of shellThemeColors)
    expect([name, lazurio.light[name]]).toEqual([name, value(design, name)]);
  // Resolved from the file itself, so a new copy of the design system needs
  // no edit here: `--lz-surface` is `var(--lz-white)` there.
  expect(designTokens).toContain("--lz-surface: var(--lz-white);");
  expect(value(design, "--lz-surface")).toBe(value(design, "--lz-white"));
  expect(lazurio.light["--lz-accent"]).toBe(value(design, "--lz-blue-500"));
  expect(() => designSystemValues(":root { --lz-a: var(--lz-b); }")).toThrow();
  expect(() =>
    designSystemValues(":root { --lz-a: var(--lz-b); --lz-b: var(--lz-a); }"),
  ).toThrow();
});

test("a T3 Code palette is projected role by role; the success colours are the design system's", () => {
  const design = designSystemValues();
  for (const palette of [GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME]) {
    const choice = environmentThemeChoice(palette.id as never);
    const dark = palette.variants?.dark;
    if (dark === undefined || choice.dark === undefined)
      throw new Error(`${palette.id} has a dark variant`);
    for (const [appearance, colors, values] of [
      ["light", palette.colors, choice.light],
      ["dark", dark, choice.dark],
    ] as const)
      for (const name of shellThemeColors) {
        const expected =
          name === "--lz-green-500" || name === "--lz-success"
            ? value(design, designSystemSuccess[appearance][name])
            : paletteHex(colors[themeProjection[name]]);
        expect([palette.id, appearance, name, values[name]]).toEqual([
          palette.id,
          appearance,
          name,
          expected,
        ]);
      }
  }
  // The success text in dark is the light end of the design system's green.
  expect(environmentThemeChoice("ocean").dark?.["--lz-success"]).toBe(
    value(design, "--lz-green-300"),
  );
  expect(environmentThemeChoice("ocean").light["--lz-success"]).toBe(
    value(design, "--lz-success"),
  );
});

test("a palette's oklch colour becomes the sRGB #rrggbb it paints", () => {
  // Reference values of the sRGB primaries and white in OKLCH.
  expect(paletteHex("oklch(1 0 0)")).toBe("#ffffff");
  expect(paletteHex("oklch(0 0 0)")).toBe("#000000");
  expect(paletteHex("oklch(0.627955 0.257683 29.2339)")).toBe("#ff0000");
  expect(paletteHex("oklch(0.86644 0.294827 142.495)")).toBe("#00ff00");
  expect(paletteHex("oklch(0.452014 0.313214 264.052)")).toBe("#0000ff");
  expect(paletteHex("#ABCDEF")).toBe("#abcdef");
  // Past the gamut a channel is clamped, never wrapped.
  expect(paletteHex("oklch(0.9 0.4 140)")).toMatch(/^#[0-9a-f]{6}$/);
  for (const refused of ["red", "rgb(0 0 0)", "oklch(1 0)", "#fff"])
    expect(() => paletteHex(refused)).toThrow();
});

/** The relative luminance of `#rrggbb` (WCAG 2). */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};

// What each name is used for, as the design system's own contrast contract
// (tokens.css) and the apps that map them use it: text at 4.5:1 (WCAG AA),
// a graphic at 3:1. Muted ink is read on the surface, the paper and the quiet
// grey; the button's ink on every fill MausBot and T3 Code put it on.
const text: readonly (readonly [ShellThemeColor, ShellThemeColor])[] = [
  ["--lz-ink", "--lz-surface"],
  ["--lz-ink", "--lz-paper"],
  ["--lz-ink", "--lz-gray-50"],
  ["--lz-ink", "--lz-gray-100"],
  ["--lz-ink-muted", "--lz-surface"],
  ["--lz-ink-muted", "--lz-paper"],
  ["--lz-ink-muted", "--lz-gray-50"],
  ["--lz-on-accent", "--lz-accent-button"],
  ["--lz-on-accent", "--lz-accent-button-hover"],
  ["--lz-on-accent", "--lz-accent"],
  ["--lz-on-accent", "--lz-success"],
  ["--lz-on-accent", "--lz-danger"],
  ["--lz-accent", "--lz-surface"],
  ["--lz-danger", "--lz-surface"],
  ["--lz-warning", "--lz-surface"],
  ["--lz-info", "--lz-surface"],
  ["--lz-success", "--lz-surface"],
  ["--lz-danger", "--lz-danger-bg"],
  ["--lz-warning", "--lz-warning-bg"],
  ["--lz-info", "--lz-info-bg"],
];
const graphic: readonly (readonly [ShellThemeColor, ShellThemeColor])[] = [
  ["--lz-red-500", "--lz-surface"],
  ["--lz-success", "--lz-paper"],
];

for (const choice of environmentThemeChoices)
  for (const [appearance, values] of [
    ["light", choice.light],
    ["dark", choice.dark],
  ] as const) {
    if (values === undefined) continue;
    test(`${choice.label} ${appearance}: text reads at 4.5:1 and graphics at 3:1`, () => {
      const below = (
        pairs: typeof text,
        minimum: number,
        all: ShellThemeValues,
      ) =>
        pairs
          .map(([fore, back]) => ({
            pair: `${fore} on ${back}`,
            ratio: Math.round(contrast(all[fore], all[back]) * 100) / 100,
          }))
          .filter(({ ratio }) => ratio < minimum);
      expect(below(text, 4.5, values)).toEqual([]);
      expect(below(graphic, 3, values)).toEqual([]);
    });
  }

test("the shell document's theme of a record: its choice at its revision", () => {
  expect(shellThemeOf({ theme: "ocean", revision: 4 })).toEqual({
    ...environmentThemeChoice("ocean"),
    revision: 4,
  });
  const lazurio = shellThemeOf({ theme: "lazurio", revision: 0 });
  expect(Object.hasOwn(lazurio, "dark")).toBe(false);
  expect(parseShellTheme(lazurio)).toEqual(lazurio);
});
