import {
  type ShellTheme,
  type ShellThemeColor,
  type ShellThemeValues,
  shellThemeColors,
} from "../shell/contract";
import { designTokens } from "../shell/design-tokens";
import {
  EMBER_THEME,
  GROVE_THEME,
  getThemeColorsForAppearance,
  IRIS_THEME,
  OCEAN_THEME,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "./vendor/t3code/themePalettes";

// The themes an Environment may take (root decision 0208 point 2, F36's
// addendum of 2026-10-18): `lazurio`, the design system's own look and the
// default, and T3 Code's four built-in themes Grove, Ocean, Ember and Iris,
// vendored byte for byte from the Lazurio/t3code fork (`vendor/README.md`,
// MIT). T3 Chat, T3's own brand palette, is not offered. A theme reaches the
// apps only as values of the colour names interface v1 promises
// (`shellThemeColors`): the projection below takes, for each name, the T3
// Code role whose colour T3 Code itself paints where the fork's `theme.css`
// maps that name, so Chat's standard look follows the palette as T3 Code
// draws it, and MausBot and the Launchpad, which map the same names, follow
// it too. Contrast is held per theme and appearance
// (tests/theme-palettes.test.ts). Type, the radius and the success colours
// stay the design system's: in light its own `--lz-success`, in dark the
// light end of the same green ramp, as the design system pairs its accent
// with `--lz-accent-on-dark`. The Lazurio theme is exactly the vendored
// tokens' values, light only: the design system has no dark UI yet.

export const environmentThemeIds = [
  "lazurio",
  "grove",
  "ocean",
  "ember",
  "iris",
] as const;
export type EnvironmentThemeId = (typeof environmentThemeIds)[number];

/** The theme of an Environment nobody chose one for. */
export const defaultEnvironmentTheme: EnvironmentThemeId = "lazurio";

export const isEnvironmentThemeId = (
  value: unknown,
): value is EnvironmentThemeId =>
  typeof value === "string" &&
  (environmentThemeIds as readonly string[]).includes(value);

/** For each promised colour name but the success colours, the role of a T3
 * Code palette whose colour it takes. Each is the role T3 Code paints in the
 * places the fork's `theme.css` maps the name to: `canvas` behind
 * `--background`, `sidebar` behind the sidebar, `messageAction` behind its
 * solid controls, `accentSurface` behind a selection, `muted` behind a quiet
 * surface with muted text. The muted ink is the sidebar's, the darkest of T3
 * Code's muted greys, so it reads on the paper as on the surface. */
export const themeProjection = Object.freeze({
  "--lz-surface": "canvas",
  "--lz-paper": "sidebar",
  "--lz-ink": "text",
  "--lz-ink-muted": "sidebarMutedForeground",
  "--lz-line": "border",
  "--lz-accent": "accent",
  "--lz-accent-button": "messageAction",
  "--lz-accent-button-hover": "messageActionHover",
  "--lz-on-accent": "messageActionForeground",
  "--lz-gray-50": "muted",
  "--lz-gray-100": "accentSurface",
  "--lz-red-500": "error",
  "--lz-danger": "errorForeground",
  "--lz-danger-bg": "errorSurface",
  "--lz-warning": "warningForeground",
  "--lz-warning-bg": "warningSurface",
  "--lz-info": "updateForeground",
  "--lz-info-bg": "updateSurface",
} as const satisfies Record<
  Exclude<ShellThemeColor, "--lz-green-500" | "--lz-success">,
  ThemeColorRole
>);

/** The success colours, the design system's in every theme: the token
 * whose value each name takes, per appearance. */
export const designSystemSuccess = Object.freeze({
  light: Object.freeze({
    "--lz-green-500": "--lz-green-500",
    "--lz-success": "--lz-success",
  }),
  dark: Object.freeze({
    "--lz-green-500": "--lz-green-500",
    "--lz-success": "--lz-green-300",
  }),
});

/** Every `--lz-*` token of the vendored `tokens.css` with its value, each
 * `var()` resolved. */
export function designSystemValues(
  text: string = designTokens,
): Readonly<Record<string, string>> {
  const declared = new Map(
    [
      ...text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/(--lz-[\w-]+)\s*:\s*([^;]+);/g),
    ].map((match) => [match[1] as string, (match[2] as string).trim()]),
  );
  const resolve = (name: string, seen: readonly string[]): string => {
    const value = declared.get(name);
    if (value === undefined || seen.includes(name))
      throw new Error(`The design system's ${name} does not resolve`);
    const reference = /^var\((--lz-[\w-]+)\)$/.exec(value)?.[1];
    return reference === undefined
      ? value
      : resolve(reference, [...seen, name]);
  };
  return Object.freeze(
    Object.fromEntries(
      [...declared.keys()].map((name) => [name, resolve(name, [])]),
    ),
  );
}

const hexColour = /^#[0-9a-f]{6}$/;

/** A colour of a T3 Code palette as a literal sRGB `#rrggbb`: `oklch(L C
 * H)` converted (Björn Ottosson's OKLab), a channel past the sRGB gamut
 * clamped (T3 Code's palettes pass it by at most 1/10 000), and `#rrggbb` as
 * it is. Throws on anything else. */
export function paletteHex(value: string): string {
  const hex = value.trim().toLowerCase();
  if (hexColour.test(hex)) return hex;
  const match =
    /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/.exec(hex) ?? null;
  if (match === null) throw new Error(`Not a palette colour: ${value}`);
  const [lightness, chroma, hue] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((channel) => {
      const c = Math.min(1, Math.max(0, channel));
      const encoded =
        c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** One theme an Environment may take, with its values. */
export type EnvironmentThemeChoice = Readonly<{
  id: EnvironmentThemeId;
  label: string;
  light: ShellThemeValues;
  dark?: ShellThemeValues;
}>;

const ordered = (value: (name: ShellThemeColor) => string): ShellThemeValues =>
  Object.freeze(
    Object.fromEntries(shellThemeColors.map((name) => [name, value(name)])),
  ) as ShellThemeValues;

/** The design system's values for every promised colour name. */
function designSystemAppearance(
  design: Readonly<Record<string, string>>,
  names: Readonly<Partial<Record<ShellThemeColor, string>>>,
): ShellThemeValues {
  return ordered((name) => {
    const value = design[names[name] ?? name];
    if (value === undefined || !hexColour.test(value))
      throw new Error(`The design system's ${name} is no colour`);
    return value;
  });
}

/** One appearance of a T3 Code palette, projected. */
function projectedAppearance(
  colors: ThemeColors,
  design: Readonly<Record<string, string>>,
  success: Readonly<Record<"--lz-green-500" | "--lz-success", string>>,
): ShellThemeValues {
  return ordered((name) =>
    name === "--lz-green-500" || name === "--lz-success"
      ? (design[success[name]] as string)
      : paletteHex(colors[themeProjection[name]]),
  );
}

function projectedPalette(
  palette: ThemeDefinition,
  design: Readonly<Record<string, string>>,
): EnvironmentThemeChoice {
  const light = getThemeColorsForAppearance(palette, "light");
  const dark = getThemeColorsForAppearance(palette, "dark");
  if (light === null || !isEnvironmentThemeId(palette.id))
    throw new Error(`The palette ${palette.id} has no light values`);
  return Object.freeze({
    id: palette.id,
    label: palette.label,
    light: projectedAppearance(light, design, designSystemSuccess.light),
    ...(dark === null
      ? {}
      : {
          dark: projectedAppearance(dark, design, designSystemSuccess.dark),
        }),
  });
}

/** The themes an Environment may take, in the order Settings shows them. */
export const environmentThemeChoices: readonly EnvironmentThemeChoice[] =
  (() => {
    const design = designSystemValues();
    return Object.freeze([
      Object.freeze({
        id: "lazurio",
        label: "Lazurio",
        light: designSystemAppearance(design, {}),
      }),
      ...[GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME].map((palette) =>
        projectedPalette(palette, design),
      ),
    ] satisfies EnvironmentThemeChoice[]);
  })();

/** The choice of `id`. */
export function environmentThemeChoice(
  id: EnvironmentThemeId,
): EnvironmentThemeChoice {
  const choice = environmentThemeChoices.find((entry) => entry.id === id);
  if (choice === undefined) throw new Error(`No theme ${id}`);
  return choice;
}

/** The `theme` member of `lazurio.shell.v1` for the Environment's record. */
export function shellThemeOf(
  record: Readonly<{ theme: EnvironmentThemeId; revision: number }>,
): ShellTheme {
  const { id, label, light, dark } = environmentThemeChoice(record.theme);
  return Object.freeze({
    id,
    label,
    revision: record.revision,
    light,
    ...(dark === undefined ? {} : { dark }),
  });
}
