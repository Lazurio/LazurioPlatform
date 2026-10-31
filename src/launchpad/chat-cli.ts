import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runChatDefaults } from "../chat/cli";
import type { ToolRunner } from "../tools/status";
import {
  type CliContext,
  type CommandOutput,
  operatorFolder,
} from "../update/cli";
import {
  exitFailure,
  exitOk,
  exitUpdateAvailable,
  exitUsage,
} from "../update/errors";
import {
  type ChatLinkAnswer,
  type ChatLinkReason,
  chatLinkAnswer,
} from "./chat";
import { LaunchpadStartRefused, readStartState } from "./start-check";

/** `lazurio chat link`: the terminal surface of the Launchpad's Chat entry
 * (launchpad-parity B8, C.5 item 10). The same recorded entry and the same
 * plain T3 Code origin the Chat entry follows; it mints and records nothing
 * (the addendum of 2026-10-31 to the decision of 2026-10-17). */
export const chatHelp = `chat link [--folder <absolute Folder>] [--plain] [--json]
  The link into T3 Code in this Remote Environment, from the Folder's recorded
  entry, as the Launchpad's Chat entry opens it: the plain T3 Code origin.
  T3 Code pairs the user's browser itself (t3-pairs-itself), and a browser
  with a session opens it at once; nothing is minted. --plain is accepted for
  compatibility and changes nothing. Without a recorded entry (a workstation:
  T3 Code runs where the user runs it) there is no link (not-hosted). The
  link alone is on stdout; the reason goes to stderr. --json prints
  {kind: "chat-link", url, pairing: false, reason}. The Folder is found as
  for lazurio doctor.
  Exit status: 0 a link, 10 not a Remote Environment, 2 usage, 1 failure.

chat defaults [--apply] [--folder <absolute Folder>] [--json]
  Read the native T3 default without writing. --apply reconciles the Platform
  recommendation through the running T3 service, preserving a personal choice.
  The recommended model is the one this Environment's Codex configuration pins,
  as Codex's own config/read answers, or the Platform's own when it pins none.
  Without Codex's answer nothing is read from or written to T3: unavailable,
  codex-config-unreadable. T3 must support the managed Folder contract; no
  offline write or settings-file patch is attempted. Exit: 0 managed/custom,
  10 outdated/not hosted, 1 unavailable.`;

export const exitNotHosted = exitUpdateAvailable;

export type ChatContext = CliContext &
  Readonly<{
    /** Tests only: the runner of T3's calls (`chat defaults`). */
    toolRun?: ToolRunner | undefined;
  }>;

const synopsis = "chat link [--folder <absolute Folder>] [--plain] [--json]";

// The reason of an answer, one sentence.
const reasons = {
  en: {
    "t3-pairs-itself":
      "The plain T3 Code link: T3 Code pairs the browser itself, and a browser that is already paired opens it at once.",
    "not-hosted":
      "No T3 Code link: this Folder has no recorded Remote Environment entry, so T3 Code runs wherever the user runs it.",
  },
  cs: {
    "t3-pairs-itself":
      "Prostý odkaz na T3 Code: T3 Code si prohlížeč spáruje samo a už spárovaný prohlížeč ho otevře hned.",
    "not-hosted":
      "Žádný odkaz na T3 Code: tento Folder nemá zaznamenaný hostovaný vstup, T3 Code běží tam, kde ho uživatel spouští.",
  },
} as const satisfies Record<"cs" | "en", Record<ChatLinkReason, string>>;

function output(
  answer: ChatLinkAnswer,
  json: boolean,
  locale: "cs" | "en",
): CommandOutput {
  const code = answer.url === null ? exitNotHosted : exitOk;
  if (json) return Object.freeze({ code, stdout: JSON.stringify(answer) });
  return Object.freeze({
    code,
    ...(answer.url === null ? {} : { stdout: answer.url }),
    stderr: reasons[locale][answer.reason],
  });
}

export async function runChatCommand(
  args: readonly string[],
  context: ChatContext,
): Promise<CommandOutput> {
  if (args[0] === "defaults") return runChatDefaults(args.slice(1), context);
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: ${synopsis}`,
  });
  let values: {
    json?: boolean | undefined;
    plain?: boolean | undefined;
    folder?: string | undefined;
  };
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        plain: { type: "boolean" },
        folder: { type: "string" },
      },
    });
    values = parsed.values;
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      parsed.positionals.length !== 1 ||
      parsed.positionals[0] !== "link" ||
      new Set(names).size !== names.length ||
      (values.folder !== undefined &&
        (!isAbsolute(values.folder) ||
          resolve(values.folder) !== values.folder))
    )
      return usage;
  } catch {
    return usage;
  }
  const json = values.json === true;
  try {
    const folder = values.folder ?? (await operatorFolder(context));
    // No Folder of its own: a workstation without a supervised unit, which
    // has no recorded entry either.
    const state =
      folder === undefined
        ? null
        : await readStartState(folder, { locked: false });
    const locale = state?.preferences.profile.locale ?? "en";
    // `--plain` is accepted and changes nothing: every link is plain.
    const answer = chatLinkAnswer(state?.entry ?? null);
    return output(answer, json, locale);
  } catch (error) {
    // The start refusal is an enumerated id; nothing else is printed, since
    // it could quote a private path.
    return Object.freeze({
      code: exitFailure,
      stderr:
        error instanceof LaunchpadStartRefused
          ? `Chat link failed: the Folder could not be read (${error.reason})`
          : "Chat link failed",
    });
  }
}
