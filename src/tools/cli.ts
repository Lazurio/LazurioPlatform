import { parseArgs } from "node:util";
import { runProcess } from "../update/self-check";
import { type ToolStatus, toolsStatus } from "./status";
import { toolsUpdate } from "./update";

/** `lazurio tools status|update`: the terminal surface of the operator's tools
 * (decision 0161 / F17, docs/environment-tools.md). */
export const toolsHelp = `tools status [--json]
  The operator's tools (codex, claude, gh, git, node, npm, bun) as found on
  this process's PATH: path, real path and the version each reports. Read-only,
  never the network. Versions are facts, not drift.
tools update <tool> [--json]
  Runs that one tool's official update path as the current user: the tool's
  own updater (claude update, bun upgrade) or the vendor's installer script
  (codex). Tools without one (gh, git, node, npm) are reported with their
  official source and nothing runs. Run it only on the Principal's explicit
  instruction. Never pins or downgrades; never touches another tool.`;

export class ToolsUsageError extends Error {}

export type ToolsCommandOutput = Readonly<{
  code: number;
  result: Record<string, unknown>;
  text: string;
}>;

const line = (tool: ToolStatus): string =>
  tool.installed
    ? `${tool.name.padEnd(7)} ${(tool.version ?? "?").padEnd(16)} ${tool.path}${
        tool.realPath && tool.realPath !== tool.path
          ? ` -> ${tool.realPath}`
          : ""
      }${tool.versionError ? `  (version: ${tool.versionError})` : ""}`
    : `${tool.name.padEnd(7)} ${"missing".padEnd(16)} ${tool.source}`;

export async function runToolsCommand(
  args: string[],
  context: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
  }> = { env: process.env, platform: process.platform },
): Promise<ToolsCommandOutput> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
  });
  const common = {
    path: context.env.PATH,
    home: context.env.HOME,
    platform: context.platform,
    run: runProcess,
  };
  if (positionals[0] === "status" && positionals.length === 1) {
    const result = await toolsStatus(common);
    return {
      code: 0,
      result,
      text: values.json
        ? JSON.stringify(result)
        : result.tools.map(line).join("\n"),
    };
  }
  if (positionals[0] === "update" && positionals.length === 2) {
    const result = await toolsUpdate({ ...common, tool: positionals[1] ?? "" });
    const code =
      result.kind === "tool-updated"
        ? 0
        : result.kind === "tool-unknown"
          ? 2
          : 1;
    let text = JSON.stringify(result);
    if (!values.json) {
      if (result.kind === "tool-unknown")
        text = `Unknown tool ${result.tool}; known: ${result.known.join(", ")}`;
      else if (result.kind === "tool-not-self-updating")
        text = `${result.tool} has no official self-update path here; installed: ${result.before.version ?? "missing"}. Official source: ${result.source}`;
      else if (result.kind === "tool-updated")
        text = `${result.tool}: ${result.before.version ?? "missing"} -> ${result.after.version ?? "?"}${result.changed ? "" : " (unchanged)"}`;
      else
        text = `${result.tool}: update failed${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}\n${result.output}`;
    }
    return { code, result, text };
  }
  throw new ToolsUsageError(
    "Usage: tools status [--json] | tools update <tool> [--json]",
  );
}
