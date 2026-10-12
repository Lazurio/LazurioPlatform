import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import type { ChatContext } from "../launchpad/chat-cli";
import { readStartState } from "../launchpad/start-check";
import { toolsEnvironmentOf } from "../tools/overview";
import { type CommandOutput, operatorFolder } from "../update/cli";
import { chatDefaults } from "./defaults";

export async function runChatDefaults(
  args: readonly string[],
  context: ChatContext,
): Promise<CommandOutput> {
  try {
    const { values, positionals, tokens } = parseArgs({
      args: [...args],
      tokens: true,
      allowPositionals: true,
      options: {
        apply: { type: "boolean" },
        json: { type: "boolean" },
        folder: { type: "string" },
      },
    });
    const names = tokens.filter((t) => t.kind === "option").map((t) => t.name);
    if (
      positionals.length ||
      new Set(names).size !== names.length ||
      (values.folder && !isAbsolute(values.folder))
    )
      return {
        code: 2,
        stderr:
          "Usage: chat defaults [--apply] [--folder <absolute Folder>] [--json]",
      };
    const folder = values.folder ?? (await operatorFolder(context));
    if (
      !folder ||
      (await readStartState(folder, { locked: false })).entry === null
    )
      return {
        code: 10,
        stdout: JSON.stringify({
          kind: "chat-defaults",
          state: "skipped",
          reason: "not-hosted",
        }),
      };
    const answer = await chatDefaults(
      toolsEnvironmentOf(context.env, context.platform, context.toolRun),
      { apply: values.apply === true, folder },
    );
    return {
      code:
        answer.state === "unavailable"
          ? 1
          : answer.state === "outdated"
            ? 10
            : 0,
      stdout: JSON.stringify(answer),
    };
  } catch {
    return {
      code: 1,
      stderr: "Could not inspect this Environment's Chat defaults.",
    };
  }
}
