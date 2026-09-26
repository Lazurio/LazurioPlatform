import { findTool, type ToolEntry } from "./catalog";
import {
  resolveOnPath,
  type ToolRunner,
  type ToolStatus,
  toolsStatus,
} from "./status";

/** `lazurio tools update <tool>`: runs exactly one tool's official update path
 * as the operator, on the Principal's explicit instruction (decision 0161 /
 * F17), and reports the version before and after. It never pins, never
 * downgrades on its own and never touches another tool; a tool without an
 * official self-update path is only reported with its source. */
export type ToolsUpdateResult =
  | Readonly<{ kind: "tool-unknown"; tool: string; known: readonly string[] }>
  | Readonly<{
      kind: "tool-not-self-updating";
      tool: string;
      source: string;
      before: ToolStatus;
    }>
  | Readonly<{
      kind: "tool-updated";
      tool: string;
      command: readonly string[];
      before: ToolStatus;
      after: ToolStatus;
      changed: boolean;
      output: string;
    }>
  | Readonly<{
      kind: "tool-update-failed";
      tool: string;
      command: readonly string[];
      before: ToolStatus;
      exitCode?: number;
      output: string;
    }>;

export type ToolsUpdateInput = Readonly<{
  tool: string;
  path: string | undefined;
  home: string | undefined;
  platform: string;
  run: ToolRunner;
  catalog?: readonly ToolEntry[] | undefined;
  timeoutMs?: number | undefined;
}>;

const updateTimeoutMs = 10 * 60_000;

async function updateCommand(
  entry: ToolEntry,
  input: ToolsUpdateInput,
): Promise<readonly string[] | undefined> {
  const updater = entry.updater;
  if (updater.kind === "installer")
    return input.platform === "win32"
      ? ["powershell", "-ExecutionPolicy", "ByPass", "-c", updater.windows]
      : ["/bin/sh", "-c", updater.posix];
  if (updater.kind === "self") {
    const path = await resolveOnPath(entry.command, input.path, input.platform);
    return path ? [path, ...updater.argv] : undefined;
  }
  return undefined;
}

export async function toolsUpdate(
  input: ToolsUpdateInput,
): Promise<ToolsUpdateResult> {
  const entry = input.catalog
    ? input.catalog.find((candidate) => candidate.name === input.tool)
    : findTool(input.tool);
  if (!entry)
    return {
      kind: "tool-unknown",
      tool: input.tool,
      known: (input.catalog ?? []).length
        ? (input.catalog ?? []).map((candidate) => candidate.name)
        : ["codex", "claude", "gh", "git", "node", "npm", "bun"],
    };
  const status = async () =>
    (await toolsStatus({ ...input, catalog: [entry] })).tools[0] as ToolStatus;
  const before = await status();
  const command = await updateCommand(entry, input);
  if (!command)
    return {
      kind: "tool-not-self-updating",
      tool: entry.name,
      source: entry.source,
      before,
    };
  const env: Record<string, string> = {};
  if (input.path) env.PATH = input.path;
  if (input.home) env.HOME = input.home;
  try {
    const result = await input.run(
      command,
      input.timeoutMs ?? updateTimeoutMs,
      env,
    );
    if (result === "timeout")
      return {
        kind: "tool-update-failed",
        tool: entry.name,
        command,
        before,
        output: `timeout after ${input.timeoutMs ?? updateTimeoutMs} ms`,
      };
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-4000);
    if (result.exitCode !== 0)
      return {
        kind: "tool-update-failed",
        tool: entry.name,
        command,
        before,
        exitCode: result.exitCode,
        output,
      };
    const after = await status();
    return {
      kind: "tool-updated",
      tool: entry.name,
      command,
      before,
      after,
      changed:
        before.version !== after.version || before.realPath !== after.realPath,
      output,
    };
  } catch (error) {
    return {
      kind: "tool-update-failed",
      tool: entry.name,
      command,
      before,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
