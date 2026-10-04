import { type ToolEntry, toolCatalog } from "./catalog";
import {
  resolveOnPath,
  type ToolRunner,
  type ToolStatus,
  toolsStatus,
} from "./status";

/** `lazurio tools update <tool>`: runs exactly one tool's official update path
 * as the operator, with the Operator's consent (decision 0161 /
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
      /** What a person or agent does next, when the update leaves something
       * running on the old version (Codex: its app-server). */
      next?: string;
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

/** After Codex changed its version: an app-server already running (one
 * ChatGPT Desktop started over SSH, for example) keeps the old version until
 * it is replaced, and nothing here stops or restarts it: that would end live
 * sessions (decision F29, issue #173). */
export const codexUpdatedNext =
  "A Codex app-server that is already running keeps the old version until it is replaced; nothing was stopped or restarted. In a Remote Environment, lazurio doctor reports it (codex-app-server, app-server-outdated) and the Folder's manual/troubleshooting.md says how to replace it, with the Operator's consent.";

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
  // An empty injected catalog means the product's own, as before.
  const catalog = input.catalog?.length ? input.catalog : toolCatalog;
  const entry = catalog.find((candidate) => candidate.name === input.tool);
  if (!entry)
    return {
      kind: "tool-unknown",
      tool: input.tool,
      known: catalog.map((candidate) => candidate.name),
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
    const versionChanged =
      before.version !== undefined && before.version !== after.version;
    return {
      kind: "tool-updated",
      tool: entry.name,
      command,
      before,
      after,
      changed:
        before.version !== after.version || before.realPath !== after.realPath,
      output,
      ...(entry.name === "codex" && versionChanged
        ? { next: codexUpdatedNext }
        : {}),
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
