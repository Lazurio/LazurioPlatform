import { parseArgs } from "node:util";
import { FolderAdoptionError } from "../folder/handover-layout";
import {
  readFolderTools,
  sharedSignInsWarning,
} from "../folder/inspect-tools-change";
import { updateTools } from "../folder/update-profile";
import { activatableTools, toolCatalog, toolPrompt } from "./catalog";
import { runTool, type ToolStatus, toolsStatus } from "./status";
import { toolsUpdate } from "./update";

/** `lazurio tools`: the terminal surface of the operator's tools (decision
 * 0161 / F17) and of the tools enabled for agents in a Lazurio Folder
 * (decision 0162 / F18), docs/environment-tools.md. */
export const toolsHelp = `tools status [--json]
  The operator's tools (codex, claude, gh, git, node, npm, bun, composio,
  wacli, gog, neon) as found on this process's PATH: path, real path, the version each reports and whether
  the PATH entry is the standard ~/.local/bin/<tool> (decision 0161).
  Read-only, never the network. Versions are facts, not drift.
tools update <tool> [--json]
  Runs that one tool's official update path as the current user: the tool's
  own updater (claude update, bun upgrade) or the vendor's installer script
  (codex). Tools without one (gh, git, node, npm) are reported with their
  official source and nothing runs. Run it only on the Principal's explicit
  instruction. Never pins or downgrades; never touches another tool.
tools list --folder <absolute Folder> [--json]
  The catalog tools agents may be told to use (gh required, composio
  recommended, wacli, gogcli and neon optional): tier, setup mode (launchpad:
  a curated Launchpad flow sets it up; agent: an agent does, from the prepared
  prompt), whether each is enabled in that Folder, and the same live facts as
  tools status. Read-only.
tools prompt <tool> [--locale cs|en] [--json]
  The prepared prompt for an agent who installs that tool and guides the
  operator's sign-in: the task, the target state and the rule to enable the
  tool afterwards. Read-only text, no Folder; it installs nothing.
tools enable <tool> --folder <absolute Folder> --expected-revision <n> [--json]
tools disable <tool> --folder <absolute Folder> --expected-revision <n> [--json]
  Records the tool as enabled or not in that Folder and re-renders AGENTS.md
  and manual/ through the profile transaction (recovery: profile-resume).
  Enabling is context for agents: it grants no access, installs nothing, signs
  in nowhere and pins no version. A required tool is always on: enabling it is
  unchanged, disabling it is refused. No implicit Folder discovery.
  Exit status: 0 completed/unchanged, 2 blocked or usage, 1 operation failure.`;

export class ToolsUsageError extends Error {}

export type ToolsCommandOutput = Readonly<{
  code: number;
  result: Record<string, unknown>;
  text: string;
}>;

// Wide enough for the longest catalog name, so the columns stay aligned.
const nameWidth = Math.max(...toolCatalog.map((entry) => entry.name.length));

const line = (tool: ToolStatus): string =>
  tool.installed
    ? `${tool.name.padEnd(nameWidth)} ${(tool.version ?? "?").padEnd(16)} ${tool.path}${
        tool.realPath && tool.realPath !== tool.path
          ? ` -> ${tool.realPath}`
          : ""
      }${tool.versionError ? `  (version: ${tool.versionError})` : ""}${
        tool.standardPath === false ? "  (outside ~/.local/bin)" : ""
      }`
    : `${tool.name.padEnd(nameWidth)} ${"missing".padEnd(16)} ${tool.source}`;

export async function runToolsCommand(
  args: string[],
  context: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
  }> = { env: process.env, platform: process.platform },
): Promise<ToolsCommandOutput> {
  let values: {
    json?: boolean | undefined;
    folder?: string | undefined;
    "expected-revision"?: string | undefined;
    locale?: string | undefined;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      tokens: true,
      options: {
        json: { type: "boolean" },
        folder: { type: "string" },
        "expected-revision": { type: "string" },
        locale: { type: "string" },
      },
      allowPositionals: true,
    });
    ({ values, positionals } = parsed);
    const supplied = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name)) throw new Error("Duplicate command option");
      supplied.add(token.name);
    }
  } catch (error) {
    // An unknown option is a usage error with the help text, exit 2.
    throw new ToolsUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  if (positionals[0] === "prompt") {
    const locale = values.locale ?? "en";
    const name = positionals[1];
    if (
      positionals.length !== 2 ||
      name === undefined ||
      (locale !== "cs" && locale !== "en") ||
      values.folder !== undefined ||
      values["expected-revision"] !== undefined
    )
      throw new ToolsUsageError(usage);
    const prompt = toolPrompt(name, locale);
    const entry = activatableTools().find((tool) => tool.name === name);
    if (prompt === undefined || entry === undefined) {
      const known = activatableTools().map((tool) => tool.name);
      const result = {
        kind: "blocked",
        reason: "tool-unknown",
        tool: name,
        known,
      };
      return {
        code: 2,
        result,
        text: values.json
          ? JSON.stringify(result)
          : `Unknown tool ${name}; the catalog offers: ${known.join(", ")}`,
      };
    }
    const result = {
      kind: "tool-prompt",
      tool: name,
      locale,
      setup: entry.activation.setup,
      prompt,
    };
    return {
      code: 0,
      result,
      text: values.json ? JSON.stringify(result) : prompt,
    };
  }
  if (values.locale !== undefined) throw new ToolsUsageError(usage);
  const folderBound = ["list", "enable", "disable"].includes(
    positionals[0] ?? "",
  );
  if (folderBound) return runFolderToolsCommand(positionals, values, context);
  if (values.folder !== undefined || values["expected-revision"] !== undefined)
    throw new ToolsUsageError(usage);
  const common = {
    path: context.env.PATH,
    home: context.env.HOME,
    platform: context.platform,
    run: runTool,
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
  throw new ToolsUsageError(usage);
}

const usage =
  "Usage: tools status [--json] | tools update <tool> [--json] | tools list --folder <Folder> [--json] | tools enable|disable <tool> --folder <Folder> --expected-revision <n> [--json] | tools prompt <tool> [--locale cs|en] [--json]";

// The Folder-bound commands (decision F18). The Folder is always explicit;
// a mutation names the revision it was decided against.
async function runFolderToolsCommand(
  positionals: readonly string[],
  values: Readonly<{
    json?: boolean | undefined;
    folder?: string | undefined;
    "expected-revision"?: string | undefined;
  }>,
  context: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
  }>,
): Promise<ToolsCommandOutput> {
  const folder = values.folder;
  if (!folder) throw new ToolsUsageError(usage);
  const done = (
    code: number,
    result: Record<string, unknown>,
    text: string,
  ): ToolsCommandOutput => ({
    code,
    result,
    text: values.json ? JSON.stringify(result) : text,
  });
  if (positionals[0] === "list") {
    if (positionals.length !== 1 || values["expected-revision"] !== undefined)
      throw new ToolsUsageError(usage);
    const recorded = await readFolderTools(folder);
    // The live facts of `tools status`, for the activatable tools only.
    const status = await toolsStatus({
      path: context.env.PATH,
      home: context.env.HOME,
      platform: context.platform,
      run: runTool,
      catalog: activatableTools(),
    });
    const tools = recorded.tools.map((selection, index) => ({
      ...(status.tools[index] as ToolStatus),
      tier: selection.tier,
      setup: selection.setup,
      enabled: selection.enabled,
    }));
    return done(
      0,
      { kind: "tools-list", revision: recorded.revision, tools },
      [
        `revision ${recorded.revision}`,
        ...tools.map(
          (tool) =>
            `${tool.name.padEnd(9)} ${tool.tier.padEnd(12)} ${tool.setup.padEnd(10)} ${(
              tool.enabled ? "enabled" : "disabled"
            ).padEnd(9)} ${
              tool.installed
                ? `${tool.version ?? "?"} ${tool.path}${
                    tool.standardPath === false
                      ? "  (outside ~/.local/bin)"
                      : ""
                  }`
                : `missing ${tool.source}`
            }`,
        ),
      ].join("\n"),
    );
  }
  const name = positionals[1];
  const revision = values["expected-revision"] ?? "";
  if (
    positionals.length !== 2 ||
    name === undefined ||
    !/^[1-9][0-9]*$/.test(revision) ||
    !Number.isSafeInteger(Number(revision))
  )
    throw new ToolsUsageError(usage);
  const enabling = positionals[0] === "enable";
  const entry = activatableTools().find((tool) => tool.name === name);
  if (!entry) {
    const known = activatableTools().map((tool) => tool.name);
    return done(
      2,
      { kind: "blocked", reason: "tool-unknown", tool: name, known },
      `Unknown tool ${name}; the catalog offers: ${known.join(", ")}`,
    );
  }
  try {
    const recorded = await readFolderTools(folder);
    // A required tool is always on, but the command still speaks about one
    // real Folder at the revision the caller saw.
    if (entry.activation.tier === "required") {
      if (recorded.revision !== Number(revision))
        return done(
          2,
          { kind: "blocked", reason: "stale-revision", tool: name },
          "Blocked: stale-revision",
        );
      return enabling
        ? done(
            0,
            { kind: "unchanged", tool: name },
            `${name} is required and always enabled`,
          )
        : done(
            2,
            { kind: "blocked", reason: "tool-required", tool: name },
            `${name} is required and cannot be disabled`,
          );
    }
    const tools = enabling
      ? [...new Set([...recorded.enabled, name])].sort()
      : recorded.enabled.filter((tool) => tool !== name);
    const result = await updateTools(folder, Number(revision), tools);
    // On an Environment shared by several operators a sign-in of the tool is
    // shared by all of them; say so whenever a tool is enabled there.
    const shared =
      "warning" in sharedSignInsWarning(recorded, enabling ? tools : []);
    return done(
      result.kind === "blocked" ? 2 : 0,
      {
        ...result,
        tool: name,
        ...(shared ? { warning: "shared-environment-sign-ins" } : {}),
      },
      result.kind === "updated"
        ? `${name} ${enabling ? "enabled" : "disabled"}; Folder revision ${result.revision}${
            shared
              ? "\nWarning: this Environment is shared. Accounts signed in to the tool apply to the whole Environment and are shared by all its operators."
              : ""
          }`
        : result.kind === "unchanged"
          ? `${name} is already ${enabling ? "enabled" : "disabled"}`
          : `Blocked: ${result.reason}${"path" in result ? ` (${result.path})` : ""}`,
    );
  } catch (error) {
    // A foreign top-level entry is a named refusal before any write.
    if (!(error instanceof FolderAdoptionError)) throw error;
    return done(
      2,
      {
        kind: "blocked",
        reason: `folder-${error.code}`,
        entry: error.entry,
        tool: name,
      },
      `Blocked: folder-${error.code} (${error.entry})`,
    );
  }
}
