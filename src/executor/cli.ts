import { parseArgs } from "node:util";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import type { AgentRegistration } from "./agents";
import {
  type ExecutorHost,
  type ExecutorPhase,
  type ExecutorStatus,
  type ExecutorUnsupportedReason,
  executorSetup,
  executorStatus,
} from "./flow";
import { processExecutorHost } from "./host";
import { executorUnit } from "./pin";

/** `lazurio executor`: Executor of this Remote Environment for agents and
 * the operator (decision F44). The same core as Settings → Tools → executor
 * and the Launchpad's own setup after it starts. */
export const executorHelp = `executor status [--json]
  Executor of this Remote Environment as Settings → Tools shows it, read
  locally (the service only on 127.0.0.1): the pinned version and the one
  installed, whether the service runs and answers, and whether Codex and
  Claude Code have the MCP server executor. Nothing is changed and the
  network is not used.
executor setup [--json]
  What the Launchpad does after it starts in a Remote Environment, for an
  agent or the Launchpad's Repair: installs the pinned Executor (the npm
  registry's tarballs, verified against their pinned integrity before npm
  runs them, offline and without scripts) into
  ~/.local/share/executor-cli/<version>, writes the entry
  ~/.local/bin/executor (analytics and the update check off for every run),
  installs and starts its service ${executorUnit} on 127.0.0.1:4789 with
  executor install and Lazurio's drop-in, and adds the MCP server executor
  (~/.local/bin/executor mcp) to Codex and Claude Code where they are
  installed. Each step only what is missing; a running service is stopped
  only to switch versions. An entry or MCP server named executor that is not
  Lazurio's is reported and left as it is. Running chats keep their tools;
  new chats see executor. Remote Environments on Linux only; on this
  computer it is the second wave. Exit status: 0 running, 2 waiting for a
  person (not available here, a conflict), 1 not finished.`;

export type ExecutorCliContext = CliContext &
  Readonly<{
    /** Test seam: the host instead of this process's. */
    host?: ExecutorHost | undefined;
    /** Where `setup` reports its phases (default: nothing). */
    progress?: ((line: string) => void) | undefined;
  }>;

const reasons: Readonly<Record<ExecutorUnsupportedReason, string>> = {
  workstation:
    "Lazurio sets Executor up only in a Remote Environment on Linux for now; on this computer it comes once its macOS service is verified",
  "handover-unreadable": "the Machine handover cannot be read",
  "not-operator": "this account is not the Environment's declared operator",
};

const agentWord: Readonly<Record<AgentRegistration, string>> = {
  registered: "connected",
  disabled: "switched off by the operator",
  missing: "not connected yet",
  conflict: "has another MCP server named executor",
  absent: "not installed",
  unknown: "could not be read",
};

const phaseText: Readonly<Record<ExecutorPhase, string>> = {
  install: "Installing the pinned Executor…",
  service: "Starting its service…",
  agents: "Connecting the agents…",
};

/** The status in plain lines; never a secret, a token or a path of the
 * operator's. */
export function executorStatusText(status: ExecutorStatus): string {
  if (status.state === "unsupported")
    return `Not available: ${reasons[status.reason]}.`;
  const head = {
    running: `Executor ${status.installed} runs on ${status.address} (this Environment only) and the agents are connected.`,
    "not-installed": `Executor is not installed; lazurio executor setup installs ${status.version}.`,
    outdated: `Executor ${status.installed} is installed; lazurio executor setup moves it to ${status.version}.`,
    conflict:
      status.entry === "conflict"
        ? "~/.local/bin/executor is not Lazurio's, so Lazurio leaves Executor alone. Remove that entry (or ask an agent to) and run lazurio executor setup."
        : "An MCP server named executor that is not Lazurio's is configured; Lazurio leaves it as it is. Remove it (codex mcp remove executor, claude mcp remove executor --scope user) and run lazurio executor setup.",
    "not-running": `Executor ${status.installed} is installed and does not answer on ${status.address}; lazurio executor setup starts it.`,
    incomplete: `Executor ${status.installed} answers on ${status.address}; lazurio executor setup finishes Lazurio's part.`,
  }[status.state];
  const lines = [
    head,
    `Service ${executorUnit}: ${status.service}; Lazurio's settings: ${status.settings}; lingering: ${status.linger}.`,
    `Codex: ${agentWord[status.agents.codex]}. Claude Code: ${agentWord[status.agents.claude]}.`,
  ];
  if (status.failure !== undefined)
    lines.push(
      `The setup stopped at ${status.failure.stage}: ${status.failure.reason}.`,
    );
  return lines.join("\n");
}

export async function runExecutorCommand(
  args: readonly string[],
  context: ExecutorCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: executor status|setup [--json]\n${executorHelp}`,
  });
  let json = false;
  let command: string;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: { json: { type: "boolean" } },
    });
    const names = parsed.tokens.flatMap((token) =>
      token.kind === "option" ? [token.name] : [],
    );
    if (parsed.positionals.length !== 1 || new Set(names).size !== names.length)
      return usage;
    command = parsed.positionals[0] as string;
    json = parsed.values.json === true;
  } catch {
    return usage;
  }
  if (command !== "status" && command !== "setup") return usage;
  const host =
    context.host ??
    processExecutorHost({
      hostedFolder: async () => context.hostedFolder?.(),
      env: context.env,
      platform: context.platform,
      run: runTool,
    });
  try {
    const status =
      command === "status"
        ? await executorStatus(host)
        : await executorSetup(host, (phase) => {
            if (!json) context.progress?.(phaseText[phase]);
          });
    const code =
      command === "status" || status.state === "running"
        ? exitOk
        : status.state === "unsupported" || status.state === "conflict"
          ? exitUsage
          : exitFailure;
    return {
      code,
      stdout: json ? JSON.stringify(status) : executorStatusText(status),
    };
  } catch {
    // Never a path, an output of a tool or a value.
    return { code: exitFailure, stderr: `Executor ${command} failed.` };
  }
}
