import {
  type AgentMcpServer,
  type AgentsFacts,
  ensureAgentMcp,
  isLazurioEntry,
  observeAgentMcp,
} from "../tools/agent-mcp";
import type { ToolRunner } from "../tools/status";
import { executorServerName } from "./pin";

// The agents' way to Executor (decision F44, an amendment of F17 and F29):
// one MCP server named `executor` in the operator's Codex and Claude Code,
// `~/.local/bin/executor mcp`, which reads its credential from `~/.executor`
// itself. Lazurio adds exactly that one entry the way every Environment
// service reaches its agents (`../tools/agent-mcp`).

export {
  type AgentRegistration,
  type AgentsFacts,
  agentRegistrations,
} from "../tools/agent-mcp";

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

/** Executor's entry. Both switches travel with the entry as well as in the
 * wrapper: the runbook's registration, so an entry an operator made by hand
 * is the same. */
export const executorMcpServer = (entry: string): AgentMcpServer =>
  Object.freeze({
    name: executorServerName,
    command: entry,
    args: Object.freeze(["mcp"]),
    env: Object.freeze([
      "EXECUTOR_DISABLE_ANALYTICS=1",
      "EXECUTOR_DISABLE_UPDATE_CHECK=1",
    ]),
  });

/** Lazurio's when it runs the entry with `mcp` over stdio and sets at most
 * the two switches, nothing passed through and no working directory. */
export const isExecutorEntry = (
  value: unknown,
  entry: string,
): "lazurio" | "other" => isLazurioEntry(value, executorMcpServer(entry));

const mcpInput = ({ entry, ...input }: AgentsInput) => ({
  ...input,
  server: executorMcpServer(entry),
});

export const observeAgents = (input: AgentsInput): Promise<AgentsFacts> =>
  observeAgentMcp(mcpInput(input));

/** Adds the entry where a harness is installed and has none; everything
 * else stays as it is. The answer is read again after an add. */
export const ensureAgents = (input: AgentsInput): Promise<AgentsFacts> =>
  ensureAgentMcp(mcpInput(input));
