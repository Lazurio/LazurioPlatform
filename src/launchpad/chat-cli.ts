import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toolsEnvironmentOf } from "../tools/overview";
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
 * `issueChatLink` as `POST /api/chat/pair`; it records nothing. */
export const chatHelp = `chat link [--folder <absolute Folder>] [--plain] [--json]
  The link into T3 Code in this Remote Environment, from the Folder's recorded
  entry, as the Launchpad's Chat entry opens it: a one-time pairing link
  <T3 Code origin>/pair#token=… minted by the T3 launcher t3 on PATH (single
  use, valid 60 seconds), for the operator's browser. Without the launcher
  (t3-launcher-missing), when the pairing call fails (t3-pairing-failed) or
  with --plain (plain-requested) it prints the plain T3 Code origin, where
  T3 Code asks the browser to pair, and names the reason. Without a recorded
  entry (a workstation: T3 Code runs where the operator runs it) there is no
  link (not-hosted). The link alone is on stdout; the reason goes to stderr,
  which never carries the token. --json prints {kind: "chat-link", url,
  pairing, reason?}. The Folder is found as for lazurio doctor.
  Exit status: 0 a link, 10 not a Remote Environment, 2 usage, 1 failure.`;

export const exitNotHosted = exitUpdateAvailable;

export type ChatContext = CliContext &
  Readonly<{
    /** Tests only: the runner of the pairing call. */
    toolRun?: ToolRunner | undefined;
  }>;

const synopsis = "chat link [--folder <absolute Folder>] [--plain] [--json]";

// The reason of an answer without a pairing, one sentence, never the token.
const reasons = {
  en: {
    "plain-requested":
      "The plain T3 Code link, as asked: T3 Code asks the browser to pair.",
    "t3-launcher-missing":
      "No pairing: the T3 launcher t3 is not on PATH. The plain link opens T3 Code, which asks the browser to pair.",
    "t3-pairing-failed":
      "No pairing: T3 Code's pairing call failed. The plain link opens T3 Code, which asks the browser to pair.",
    "not-hosted":
      "No T3 Code link: this Folder has no recorded Remote Environment entry, so T3 Code runs wherever the operator runs it.",
  },
  cs: {
    "plain-requested":
      "Prostý odkaz na T3 Code, jak bylo požádáno: T3 Code si prohlížeč spáruje sám.",
    "t3-launcher-missing":
      "Bez párování: spouštěč T3 t3 není v PATH. Prostý odkaz otevře T3 Code, které si prohlížeč spáruje samo.",
    "t3-pairing-failed":
      "Bez párování: párovací volání T3 Code selhalo. Prostý odkaz otevře T3 Code, které si prohlížeč spáruje samo.",
    "not-hosted":
      "Žádný odkaz na T3 Code: tenhle Folder nemá zaznamenaný vstup Remote Environmentu, T3 Code běží tam, kde ho Operátor spouští.",
  },
  paired: {
    en: "A one-time link, valid for 60 seconds: hand it to the operator.",
    cs: "Jednorázový odkaz platný 60 sekund: předej ho Operátorovi.",
  },
} as const satisfies Record<"cs" | "en", Record<ChatLinkReason, string>> &
  Record<"paired", Record<"cs" | "en", string>>;

function output(
  answer: ChatLinkAnswer,
  json: boolean,
  locale: "cs" | "en",
): CommandOutput {
  const code = answer.url === null ? exitNotHosted : exitOk;
  if (json) return Object.freeze({ code, stdout: JSON.stringify(answer) });
  const stderr = answer.pairing
    ? reasons.paired[locale]
    : reasons[locale][answer.reason];
  return Object.freeze({
    code,
    ...(answer.url === null ? {} : { stdout: answer.url }),
    stderr,
  });
}

export async function runChatCommand(
  args: readonly string[],
  context: ChatContext,
): Promise<CommandOutput> {
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
    const answer = await chatLinkAnswer(
      state?.entry ?? null,
      toolsEnvironmentOf(context.env, context.platform, context.toolRun),
      { plain: values.plain === true },
    );
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
