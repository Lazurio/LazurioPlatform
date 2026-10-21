import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isPublicEnvironment } from "../launchpad/public-environment";
import { readStartState } from "../launchpad/start-check";
import {
  type CliContext,
  type CommandOutput,
  installBase,
  operatorFolder,
} from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import {
  environmentThemeChoice,
  environmentThemeChoices,
  environmentThemeIds,
  isEnvironmentThemeId,
} from "./palettes";
import {
  type EnvironmentThemeRecord,
  fileThemeStore,
  fixedThemeReads,
  type ThemeStore,
} from "./record";

// `lazurio theme`: the Environment's theme for its agents (root decision 0208
// point 1), over the same record and the same change as the Launchpad's
// Settings → Obecné (src/theme/record.ts). JSON on stdout, as `lazurio chat
// defaults` answers; a wrong invocation is the usage on stderr.

export const themeHelp = `theme show [--folder <absolute Folder>]
  This Environment's theme (root decision 0208): its id and name, the record's
  revision and when it was set, and the themes it may take. Chat, Apps and
  Automate take it through the Lazurio shell; a user's own pick of a theme
  inside T3 Code or MausBot stays theirs. Prints {kind: "theme", theme,
  label, revision, setAt, themes: [{id, label}]}. The Folder is found as for
  lazurio doctor, the record is in this installation's base.
  Exit status: 0 shown, 2 usage, 1 failure.

theme set <${environmentThemeIds.join("|")}> [--expected-revision <n>] [--folder <absolute Folder>]
  Changes this Environment's theme; the apps follow as soon as they are shown
  again. With --expected-revision only while the record is at that revision,
  else {kind: "blocked", reason: "theme-changed"} with the current one. The
  theme it already has is {outcome: "unchanged"}. A public Environment's
  theme is fixed, since its visitors share it: set is refused there
  ({kind: "blocked", reason: "public-environment"}, and why on stderr),
  show still answers. Never run T3 Code's own \`t3 theme set\` on a Lazurio
  Environment: it resets every user's own pick once.
  Exit status: 0 set or unchanged, 2 usage, 1 refused or failed.`;

export type ThemeContext = CliContext &
  Readonly<{
    /** Tests only: the record of a Folder (the install base's otherwise). */
    store?: ((folder: string) => ThemeStore) | undefined;
  }>;

const usage = Object.freeze({
  code: exitUsage,
  stderr: `Usage: theme show [--folder <absolute Folder>]
       theme set <${environmentThemeIds.join("|")}> [--expected-revision <n>] [--folder <absolute Folder>]`,
});

const answer = (code: number, body: unknown): CommandOutput =>
  Object.freeze({ code, stdout: JSON.stringify(body) });

/** Why a public Environment's theme stays, for whoever reads stderr. */
const publicRefusal = {
  en: "This Environment is public and shared by its visitors, so its theme is fixed. Nothing was changed.",
  cs: "Toto Prostředí je veřejné a sdílí ho jeho návštěvníci, proto má pevné téma. Nic se nezměnilo.",
} as const;

/** The record as the CLI says it. */
const recordAnswer = (record: EnvironmentThemeRecord) => ({
  theme: record.theme,
  label: environmentThemeChoice(record.theme).label,
  revision: record.revision,
  setAt: record.setAt,
});

export async function runThemeCommand(
  args: readonly string[],
  context: ThemeContext,
): Promise<CommandOutput> {
  let values: {
    folder?: string | undefined;
    "expected-revision"?: string | undefined;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        folder: { type: "string" },
        "expected-revision": { type: "string" },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      new Set(names).size !== names.length ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      return usage;
  } catch {
    return usage;
  }
  const [verb, id, ...rest] = positionals;
  const expectedText = values["expected-revision"];
  const expected =
    expectedText === undefined
      ? null
      : /^(0|[1-9][0-9]{0,15})$/.test(expectedText)
        ? Number(expectedText)
        : Number.NaN;
  const wanted = verb === "set" && isEnvironmentThemeId(id) ? id : null;
  if (
    rest.length > 0 ||
    !(
      (verb === "show" && id === undefined && expectedText === undefined) ||
      (wanted !== null && (expected === null || Number.isSafeInteger(expected)))
    )
  )
    return usage;
  try {
    const folder = values.folder ?? (await operatorFolder(context));
    if (folder === undefined)
      return answer(exitFailure, {
        kind: "theme",
        state: "unavailable",
        reason: "no-folder",
      });
    let entry: Awaited<ReturnType<typeof readStartState>>["entry"];
    let locale: "cs" | "en";
    try {
      const started = await readStartState(folder, { locked: false });
      entry = started.entry;
      locale = started.preferences.profile.locale === "cs" ? "cs" : "en";
    } catch {
      return answer(exitFailure, {
        kind: "theme",
        state: "unavailable",
        reason: "folder-unreadable",
      });
    }
    let store: ThemeStore;
    if (context.store !== undefined) store = context.store(folder);
    else {
      let base: string;
      try {
        base = installBase(context, undefined);
      } catch {
        return answer(exitFailure, {
          kind: "theme",
          state: "unavailable",
          reason: "no-install-base",
        });
      }
      store = fileThemeStore(base, folder);
    }
    // A public Environment shows the default theme, whatever its record
    // says (root decision 0208 point 6), as its Launchpad does.
    store = fixedThemeReads(store, () => isPublicEnvironment(entry));
    if (wanted === null)
      return answer(exitOk, {
        kind: "theme",
        ...recordAnswer(await store.read()),
        themes: environmentThemeChoices.map(({ id, label }) => ({ id, label })),
      });
    // A public Environment's visitors share it (root decision 0208 point
    // 6, decision F55): its theme is fixed, by the same rule that withholds
    // Nástroje and Trezor there. A guardrail of this command, not a security
    // boundary: the Environment is that (root decision 0172).
    if (isPublicEnvironment(entry))
      return Object.freeze({
        ...answer(exitFailure, {
          kind: "blocked",
          reason: "public-environment",
        }),
        stderr: publicRefusal[locale],
      });
    const change = await store.change(wanted, expected);
    if (change.kind === "blocked")
      return answer(
        exitFailure,
        change.reason === "theme-changed"
          ? {
              kind: "blocked",
              reason: change.reason,
              ...recordAnswer(change.record),
            }
          : { kind: "blocked", reason: change.reason },
      );
    return answer(exitOk, {
      kind: "theme",
      outcome: change.kind,
      ...recordAnswer(change.record),
    });
  } catch {
    return Object.freeze({
      code: exitFailure,
      stderr: "Could not read or change this Environment's theme.",
    });
  }
}
