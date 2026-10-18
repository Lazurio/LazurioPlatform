import {
  parseShellTheme,
  type Shell,
  type ShellTheme,
  type ShellThemeValues,
} from "../shell/contract";

// Apps and the Environment's theme (root decision 0208 points 2, 5 and 6, F36's
// addendum of 2026-10-18): what the Launchpad page shows of it and the model
// of its look group in Settings → Obecné. Pure and free of Node, so the page
// and the server share it.
//
// Apps stays light until the design system has a dark UI (0208 point 5): the
// page hands the shell its theme without the dark values, so its document
// only ever declares the light ones, whatever the device shows, and its root
// carries no `data-lazurio-theme-dark`. Its `data-lazurio-appearance="device"`
// says how it would show them. Chat and Automate get the whole theme.

/** The theme as Apps shows it: its light values alone. */
export function appsTheme(theme: ShellTheme): ShellTheme {
  const { dark: _, ...light } = theme;
  return Object.freeze(light);
}

/** The shell document as the Launchpad page hands it to the shell: its theme
 * as Apps shows it. */
export function withAppsTheme(shell: Shell): Shell {
  return shell.theme === undefined
    ? shell
    : Object.freeze({ ...shell, theme: appsTheme(shell.theme) });
}

/** One theme the look group offers, with the values its miniatures draw. */
export type ThemeChoiceView = Readonly<{
  id: string;
  label: string;
  light: ShellThemeValues;
  dark?: ShellThemeValues;
}>;

/** What `GET /api/theme` and a change answer: the record and the themes. */
export type ThemeView = Readonly<{
  theme: string;
  revision: number;
  setAt: string | null;
  choices: readonly ThemeChoiceView[];
}>;

/** The answer of `GET /api/theme` (or of a change), or null when it is not
 * one: every choice read as a theme would be, the record's theme among them. */
export function parseThemeAnswer(value: unknown): ThemeView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const answer = value as Readonly<Record<string, unknown>>;
  const { theme, revision, setAt, choices } = answer;
  if (
    answer.kind !== "theme" ||
    typeof theme !== "string" ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !(setAt === null || typeof setAt === "string") ||
    !Array.isArray(choices) ||
    choices.length === 0 ||
    choices.length > 32
  )
    return null;
  const read: ThemeChoiceView[] = [];
  for (const choice of choices) {
    const parsed = parseShellTheme(
      typeof choice === "object" && choice !== null
        ? { ...choice, revision: 0 }
        : choice,
    );
    if (parsed === undefined || parsed === false) return null;
    if (read.some((entry) => entry.id === parsed.id)) return null;
    read.push(
      Object.freeze({
        id: parsed.id,
        label: parsed.label,
        light: parsed.light,
        ...(parsed.dark === undefined ? {} : { dark: parsed.dark }),
      }),
    );
  }
  if (!read.some((entry) => entry.id === theme)) return null;
  return Object.freeze({
    theme,
    revision,
    setAt,
    choices: Object.freeze(read),
  });
}

/** The theme of the shell document for a choice at a revision: what the page
 * declares at once after a change, as `/.lazurio/shell.json` will name it. */
export function themeOfChoice(
  choice: ThemeChoiceView,
  revision: number,
): ShellTheme {
  return Object.freeze({
    id: choice.id,
    label: choice.label,
    revision,
    light: choice.light,
    ...(choice.dark === undefined ? {} : { dark: choice.dark }),
  });
}

/** The colours one miniature of a card draws, from one appearance. */
export function previewColours(
  values: ShellThemeValues,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "--preview-surface": values["--lz-surface"],
    "--preview-paper": values["--lz-paper"],
    "--preview-ink": values["--lz-ink"],
    "--preview-muted": values["--lz-ink-muted"],
    "--preview-line": values["--lz-line"],
    "--preview-selected": values["--lz-gray-100"],
    "--preview-accent": values["--lz-accent"],
    "--preview-button": values["--lz-accent-button"],
    "--preview-on-button": values["--lz-on-accent"],
  });
}
