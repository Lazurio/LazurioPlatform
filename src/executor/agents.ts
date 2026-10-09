import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveOnPath, type ToolRunner } from "../tools/status";
import { executorServerName } from "./pin";

// The agents' way to Executor (decision F44, an amendment of F17 and F29):
// one MCP server named `executor` in the operator's Codex and Claude Code,
// `~/.local/bin/executor mcp`, which reads its credential from `~/.executor`
// itself. Lazurio adds exactly that one entry with each harness's own CLI
// (`codex mcp add`, `claude mcp add --scope user`) and never changes or
// removes another entry, never rewrites one named `executor` that is not its
// own, and never restarts a running session: new chats see it.

/** How one harness knows Executor. `registered`: Lazurio's entry, enabled;
 * `disabled`: Lazurio's entry, switched off by the operator in Codex (left
 * so); `missing`: no entry of that name; `conflict`: an entry of that name
 * that is not Lazurio's; `absent`: the harness is not installed;
 * `unknown`: it could not be read. */
export type AgentRegistration =
  | "registered"
  | "disabled"
  | "missing"
  | "conflict"
  | "absent"
  | "unknown";

export const agentRegistrations: readonly AgentRegistration[] = [
  "registered",
  "disabled",
  "missing",
  "conflict",
  "absent",
  "unknown",
];

export type AgentsFacts = Readonly<{
  codex: AgentRegistration;
  claude: AgentRegistration;
}>;

export type AgentsInput = Readonly<{
  home: string;
  path: string | undefined;
  platform: string;
  /** Where each harness keeps its configuration, when the process names
   * one (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`); nothing else of it is passed
   * on. */
  env: Readonly<Record<string, string | undefined>>;
  run: ToolRunner;
  /** `~/.local/bin/executor`, the command of the entry. */
  entry: string;
}>;

// Both switches travel with the entry as well as in the wrapper: the
// runbook's registration, so an entry an operator made by hand is the same.
const switches = [
  "EXECUTOR_DISABLE_ANALYTICS=1",
  "EXECUTOR_DISABLE_UPDATE_CHECK=1",
] as const;

const timeoutMs = 30_000;

/** An MCP entry as either harness records it (Claude Code's server object,
 * Codex's `transport`): Lazurio's when it runs the entry with `mcp` over
 * stdio and sets at most the two switches, nothing passed through and no
 * working directory. */
export function isExecutorEntry(
  value: unknown,
  entry: string,
): "lazurio" | "other" {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "other";
  const record = value as Record<string, unknown>;
  const type = record.type ?? "stdio";
  const args = record.args;
  const env = record.env ?? {};
  const passed = record.env_vars ?? [];
  if (
    type !== "stdio" ||
    record.command !== entry ||
    !Array.isArray(args) ||
    args.length !== 1 ||
    args[0] !== "mcp" ||
    env === null ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    !Array.isArray(passed) ||
    passed.length > 0 ||
    (record.cwd !== undefined && record.cwd !== null)
  )
    return "other";
  const allowed = new Map(
    switches.map((item) => item.split("=") as [string, string]),
  );
  return Object.entries(env as Record<string, unknown>).every(
    ([name, setting]) => allowed.get(name) === setting,
  )
    ? "lazurio"
    : "other";
}

function harnessEnvironment(
  input: AgentsInput,
  variable: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
): Record<string, string> {
  const env: Record<string, string> = { HOME: input.home };
  if (input.path !== undefined) env.PATH = input.path;
  const named = input.env[variable];
  if (named !== undefined && isAbsolute(named)) env[variable] = named;
  return env;
}

// ---- Codex ---------------------------------------------------------------

async function codexEntry(
  input: AgentsInput,
  codex: string,
): Promise<AgentRegistration> {
  const result = await input
    .run(
      [codex, "mcp", "get", executorServerName, "--json"],
      timeoutMs,
      harnessEnvironment(input, "CODEX_HOME"),
    )
    .catch(() => "timeout" as const);
  if (result === "timeout") return "unknown";
  if (result.exitCode !== 0)
    return /No MCP server named/.test(`${result.stdout}\n${result.stderr}`)
      ? "missing"
      : "unknown";
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return "unknown";
  }
  if (value === null || typeof value !== "object") return "unknown";
  const record = value as { transport?: unknown; enabled?: unknown };
  if (isExecutorEntry(record.transport, input.entry) === "other")
    return "conflict";
  return record.enabled === false ? "disabled" : "registered";
}

export async function observeCodex(
  input: AgentsInput,
): Promise<AgentRegistration> {
  const codex = await resolveOnPath("codex", input.path, input.platform);
  return codex === undefined ? "absent" : codexEntry(input, codex);
}

async function addCodex(input: AgentsInput, codex: string): Promise<boolean> {
  const result = await input
    .run(
      [
        codex,
        "mcp",
        "add",
        executorServerName,
        ...switches.flatMap((item) => ["--env", item]),
        "--",
        input.entry,
        "mcp",
      ],
      timeoutMs,
      harnessEnvironment(input, "CODEX_HOME"),
    )
    .catch(() => "timeout" as const);
  return result !== "timeout" && result.exitCode === 0;
}

// ---- Claude Code ------------------------------------------------------------

/** Claude Code's user configuration: `~/.claude.json`, or the one in
 * `CLAUDE_CONFIG_DIR`. Its user-scope servers are its top-level
 * `mcpServers`. Read directly: `claude mcp get` would start the server for a
 * health check and has no JSON answer. */
const claudeConfig = (input: AgentsInput) => {
  const directory = input.env.CLAUDE_CONFIG_DIR;
  return join(
    directory !== undefined && isAbsolute(directory) ? directory : input.home,
    ".claude.json",
  );
};

async function claudeEntry(input: AgentsInput): Promise<AgentRegistration> {
  let text: string;
  try {
    text = await readFile(claudeConfig(input), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unknown";
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "unknown";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "unknown";
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return "missing";
  if (servers === null || typeof servers !== "object" || Array.isArray(servers))
    return "unknown";
  if (!Object.hasOwn(servers, executorServerName)) return "missing";
  return isExecutorEntry(
    (servers as Record<string, unknown>)[executorServerName],
    input.entry,
  ) === "lazurio"
    ? "registered"
    : "conflict";
}

export async function observeClaude(
  input: AgentsInput,
): Promise<AgentRegistration> {
  const claude = await resolveOnPath("claude", input.path, input.platform);
  return claude === undefined ? "absent" : claudeEntry(input);
}

async function addClaude(input: AgentsInput, claude: string): Promise<boolean> {
  const result = await input
    .run(
      [
        claude,
        "mcp",
        "add",
        "--scope",
        "user",
        executorServerName,
        ...switches.flatMap((item) => ["-e", item]),
        "--",
        input.entry,
        "mcp",
      ],
      timeoutMs,
      {
        ...harnessEnvironment(input, "CLAUDE_CONFIG_DIR"),
        // Only this one command: no update check or telemetry of Claude
        // Code's own while Lazurio adds the entry.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    )
    .catch(() => "timeout" as const);
  return result !== "timeout" && result.exitCode === 0;
}

// ---- Both -------------------------------------------------------------------

export async function observeAgents(input: AgentsInput): Promise<AgentsFacts> {
  return Object.freeze({
    codex: await observeCodex(input),
    claude: await observeClaude(input),
  });
}

/** Adds the entry where a harness is installed and has none; everything
 * else stays as it is. The answer is read again after an add. */
export async function ensureAgents(input: AgentsInput): Promise<AgentsFacts> {
  const codex = await resolveOnPath("codex", input.path, input.platform);
  let codexState: AgentRegistration =
    codex === undefined ? "absent" : await codexEntry(input, codex);
  if (codex !== undefined && codexState === "missing") {
    await addCodex(input, codex);
    codexState = await codexEntry(input, codex);
  }
  const claude = await resolveOnPath("claude", input.path, input.platform);
  let claudeState: AgentRegistration =
    claude === undefined ? "absent" : await claudeEntry(input);
  if (claude !== undefined && claudeState === "missing") {
    await addClaude(input, claude);
    claudeState = await claudeEntry(input);
  }
  return Object.freeze({ codex: codexState, claude: claudeState });
}
