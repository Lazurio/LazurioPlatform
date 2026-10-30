import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveOnPath, type ToolRunner } from "./status";

// How an Environment's service reaches its agents as one MCP server (decision
// F44 for Executor, F59 for Computer Use): one stdio entry of a fixed name in
// the operator's Codex and Claude Code, added with each harness's own CLI
// (`codex mcp add`, `claude mcp add --scope user`). Lazurio adds and removes
// only its own entry: it never changes or removes another entry, never
// rewrites one of that name that is not its own, and never restarts a running
// session. New chats see the change; running ones keep their tools. The one
// change Lazurio makes to the rest of a harness's configuration is outside
// the MCP entries: ChatGPT's apps in Codex (`codex-apps.ts`, decision F42's
// addendum of 2026-10-27).

/** The one entry a service gives its agents. */
export type AgentMcpServer = Readonly<{
  /** The MCP server's name in both harnesses. */
  name: string;
  /** The absolute program the harness starts over stdio. */
  command: string;
  args: readonly string[];
  /** `NAME=value` settings that travel with the entry. An entry that sets
   * fewer of them is still Lazurio's; one that sets another is not. */
  env: readonly string[];
}>;

/** How one harness knows the server. `registered`: Lazurio's entry, enabled;
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

export type AgentMcpInput = Readonly<{
  home: string;
  path: string | undefined;
  platform: string;
  /** Where each harness keeps its configuration, when the process names
   * one (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`); nothing else of it is passed
   * on. */
  env: Readonly<Record<string, string | undefined>>;
  run: ToolRunner;
  server: AgentMcpServer;
}>;

const timeoutMs = 30_000;

/** An MCP entry as either harness records it (Claude Code's server object,
 * Codex's `transport`): Lazurio's when it runs exactly the server's command
 * and arguments over stdio and sets at most the server's settings, nothing
 * passed through and no working directory. */
export function isLazurioEntry(
  value: unknown,
  server: AgentMcpServer,
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
    record.command !== server.command ||
    !Array.isArray(args) ||
    args.length !== server.args.length ||
    args.some((argument, index) => argument !== server.args[index]) ||
    env === null ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    !Array.isArray(passed) ||
    passed.length > 0 ||
    (record.cwd !== undefined && record.cwd !== null)
  )
    return "other";
  const allowed = new Map(
    server.env.map((item) => {
      const split = item.indexOf("=");
      return [item.slice(0, split), item.slice(split + 1)] as const;
    }),
  );
  return Object.entries(env as Record<string, unknown>).every(
    ([name, setting]) => allowed.get(name) === setting,
  )
    ? "lazurio"
    : "other";
}

function harnessEnvironment(
  input: AgentMcpInput,
  variable: "CODEX_HOME" | "CLAUDE_CONFIG_DIR",
): Record<string, string> {
  const env: Record<string, string> = { HOME: input.home };
  if (input.path !== undefined) env.PATH = input.path;
  const named = input.env[variable];
  if (named !== undefined && isAbsolute(named)) env[variable] = named;
  return env;
}

/** Claude Code without its own update check or telemetry while Lazurio
 * changes its entry. */
const claudeEnvironment = (input: AgentMcpInput) => ({
  ...harnessEnvironment(input, "CLAUDE_CONFIG_DIR"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

// ---- Codex ---------------------------------------------------------------

async function codexEntry(
  input: AgentMcpInput,
  codex: string,
): Promise<AgentRegistration> {
  const result = await input
    .run(
      [codex, "mcp", "get", input.server.name, "--json"],
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
  if (isLazurioEntry(record.transport, input.server) === "other")
    return "conflict";
  return record.enabled === false ? "disabled" : "registered";
}

async function addCodex(input: AgentMcpInput, codex: string): Promise<void> {
  await input
    .run(
      [
        codex,
        "mcp",
        "add",
        input.server.name,
        ...input.server.env.flatMap((item) => ["--env", item]),
        "--",
        input.server.command,
        ...input.server.args,
      ],
      timeoutMs,
      harnessEnvironment(input, "CODEX_HOME"),
    )
    .catch(() => "timeout" as const);
}

async function removeCodex(input: AgentMcpInput, codex: string): Promise<void> {
  await input
    .run(
      [codex, "mcp", "remove", input.server.name],
      timeoutMs,
      harnessEnvironment(input, "CODEX_HOME"),
    )
    .catch(() => "timeout" as const);
}

// ---- Claude Code ------------------------------------------------------------

/** Claude Code's user configuration: `~/.claude.json`, or the one in
 * `CLAUDE_CONFIG_DIR`. Its user-scope servers are its top-level
 * `mcpServers`. Read directly: `claude mcp get` would start the server for a
 * health check and has no JSON answer. */
const claudeConfig = (input: AgentMcpInput) => {
  const directory = input.env.CLAUDE_CONFIG_DIR;
  return join(
    directory !== undefined && isAbsolute(directory) ? directory : input.home,
    ".claude.json",
  );
};

async function claudeEntry(input: AgentMcpInput): Promise<AgentRegistration> {
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
  if (!Object.hasOwn(servers, input.server.name)) return "missing";
  return isLazurioEntry(
    (servers as Record<string, unknown>)[input.server.name],
    input.server,
  ) === "lazurio"
    ? "registered"
    : "conflict";
}

async function addClaude(input: AgentMcpInput, claude: string): Promise<void> {
  await input
    .run(
      [
        claude,
        "mcp",
        "add",
        "--scope",
        "user",
        input.server.name,
        ...input.server.env.flatMap((item) => ["-e", item]),
        "--",
        input.server.command,
        ...input.server.args,
      ],
      timeoutMs,
      claudeEnvironment(input),
    )
    .catch(() => "timeout" as const);
}

async function removeClaude(
  input: AgentMcpInput,
  claude: string,
): Promise<void> {
  await input
    .run(
      [claude, "mcp", "remove", "--scope", "user", input.server.name],
      timeoutMs,
      claudeEnvironment(input),
    )
    .catch(() => "timeout" as const);
}

// ---- Both -------------------------------------------------------------------

const harnesses = async (input: AgentMcpInput) => ({
  codex: await resolveOnPath("codex", input.path, input.platform),
  claude: await resolveOnPath("claude", input.path, input.platform),
});

export async function observeAgentMcp(
  input: AgentMcpInput,
): Promise<AgentsFacts> {
  const { codex, claude } = await harnesses(input);
  return Object.freeze({
    codex: codex === undefined ? "absent" : await codexEntry(input, codex),
    claude: claude === undefined ? "absent" : await claudeEntry(input),
  });
}

/** Adds the entry where a harness is installed and has none; everything
 * else stays as it is. The answer is read again after an add. */
export async function ensureAgentMcp(
  input: AgentMcpInput,
): Promise<AgentsFacts> {
  const { codex, claude } = await harnesses(input);
  let codexState: AgentRegistration =
    codex === undefined ? "absent" : await codexEntry(input, codex);
  if (codex !== undefined && codexState === "missing") {
    await addCodex(input, codex);
    codexState = await codexEntry(input, codex);
  }
  let claudeState: AgentRegistration =
    claude === undefined ? "absent" : await claudeEntry(input);
  if (claude !== undefined && claudeState === "missing") {
    await addClaude(input, claude);
    claudeState = await claudeEntry(input);
  }
  return Object.freeze({ codex: codexState, claude: claudeState });
}

/** Removes Lazurio's own entry, enabled or switched off, where a harness
 * has it; an entry of that name that is not Lazurio's, and every other entry,
 * stays. The answer is read again after a removal. */
export async function removeAgentMcp(
  input: AgentMcpInput,
): Promise<AgentsFacts> {
  const { codex, claude } = await harnesses(input);
  const own = (state: AgentRegistration) =>
    state === "registered" || state === "disabled";
  let codexState: AgentRegistration =
    codex === undefined ? "absent" : await codexEntry(input, codex);
  if (codex !== undefined && own(codexState)) {
    await removeCodex(input, codex);
    codexState = await codexEntry(input, codex);
  }
  let claudeState: AgentRegistration =
    claude === undefined ? "absent" : await claudeEntry(input);
  if (claude !== undefined && own(claudeState)) {
    await removeClaude(input, claude);
    claudeState = await claudeEntry(input);
  }
  return Object.freeze({ codex: codexState, claude: claudeState });
}
