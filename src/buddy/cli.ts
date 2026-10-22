import { isAbsolute } from "node:path";
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
import { type BuddyChat, buddyChat } from "./chat";

/** `lazurio buddy chat` (decision F61): what Machines run after they install
 * Buddy's T3 Code, as they run `lazurio chat defaults --apply` for Chat. */
export const buddyHelp = `buddy chat [--apply] [--folder <absolute Folder>] [--json]
  Buddy's chat in Lazurio (decision F61): the T3 Code of his own in
  ~/.t3-buddy on the user's Osobní Prostředí, whose one provider is Buddy,
  the Hermes Agent over ACP. Reads, without writing, whether its settings hold
  Lazurio's members: the provider instance buddy runs \`hermes acp\` with
  HERMES_HOME=~/.hermes and LAZURIO_BUDDY_CHANNEL=t3; Codex and Claude are
  off; no turn continues by itself after an update; agents get no T3
  browser. --apply writes these members of ~/.t3-buddy/userdata/settings.json
  and keeps every other one. Settings already in place need nothing; a change
  takes T3 Code's ownership of that home, as T3's own offline commands do, so
  while Buddy's T3 Code runs it is refused (t3-running): stop its unit, apply,
  start it. Unavailable, and nothing written, without Hermes's ACP server
  (hermes acp --check), without Buddy's layer in the Folder's .agents/buddy,
  or with the layer inside a Git work tree; on any other Environment it does
  nothing (not-personal). The instance's unit, port, route and project are
  Machines'; the composer's steer and queue are T3 Code's own. JSON on
  stdout: {kind: "buddy-chat", state, reason?}. The Folder is found as for
  lazurio doctor.
  Exit status: 0 managed, 10 outdated or not personal, 1 unavailable, 2 usage.`;

export type BuddyContext = CliContext &
  Readonly<{
    /** Tests only: the runner of `hermes acp --check`. */
    toolRun?: ToolRunner | undefined;
  }>;

const usage = Object.freeze({
  code: exitUsage,
  stderr: "Usage: buddy chat [--apply] [--folder <absolute Folder>] [--json]",
});

const exitOf = (answer: BuddyChat): number =>
  answer.state === "managed"
    ? exitOk
    : answer.state === "unavailable"
      ? exitFailure
      : exitUpdateAvailable;

export async function runBuddyCommand(
  args: readonly string[],
  context: BuddyContext,
): Promise<CommandOutput> {
  if (args[0] !== "chat") return usage;
  let values: { apply?: boolean; folder?: string };
  try {
    const parsed = parseArgs({
      args: args.slice(1),
      tokens: true,
      allowPositionals: true,
      strict: true,
      options: {
        apply: { type: "boolean" },
        json: { type: "boolean" },
        folder: { type: "string" },
      },
    });
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (
      parsed.positionals.length > 0 ||
      new Set(names).size !== names.length ||
      (parsed.values.folder !== undefined && !isAbsolute(parsed.values.folder))
    )
      return usage;
    values = parsed.values;
  } catch {
    return usage;
  }
  try {
    const folder = values.folder ?? (await operatorFolder(context));
    const answer: BuddyChat =
      folder === undefined
        ? { kind: "buddy-chat", state: "skipped", reason: "not-personal" }
        : await buddyChat(
            toolsEnvironmentOf(context.env, context.platform, context.toolRun),
            { folder, apply: values.apply === true },
          );
    return { code: exitOf(answer), stdout: JSON.stringify(answer) };
  } catch {
    return {
      code: exitFailure,
      stderr: "Could not inspect Buddy's chat in this Environment.",
    };
  }
}
