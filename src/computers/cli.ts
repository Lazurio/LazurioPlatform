import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readFolderState } from "../folder/read-state";
import { processExecutorEndpoint } from "../integrations/executor-client";
import { processSshAccessHost } from "../ssh-access/host";
import { toolsEnvironmentOf } from "../tools/overview";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { runAgentEntry } from "./agent-entry";
import {
  type ComputersHost,
  type ComputerView,
  computersAllowed,
  installedEntry,
  listComputers,
  removeComputer,
} from "./computers";
import { registryEntry } from "./registry";
import { computerIdPattern, isUpdating, readTools, socketPath } from "./state";

/** `lazurio computer`: people's computers for agents (decision F73, Lazurio
 * Agent Desktop). */
export const computerHelp = `computer list [--json]
  The people's computers paired with this Environment (Settings →
  Connections): each one's id, name, system, whether it is attached now and
  its last activity. Read locally; nothing is changed.
computer remove <id> [--json]
  Removes a paired computer from the registry (an attached session ends
  within a minute), its MCP server from Executor and its state. The history
  stays.
computer mcp --device <id>
  The MCP server of one computer for agents, on stdin and stdout; Executor
  runs it as "Počítač: <name>". While the computer is not attached it
  answers the tools of its last session and a tool call says why it cannot
  run. One agent controls the computer at a time.
The computer itself attaches over HTTPS: its application opens a WebSocket
to the Launchpad's /.lazurio/computers/attach while its switch is on.`;

/** Whether the preset of this Environment's Folder allows a person's
 * computer, and the Folder's language; a Folder that cannot be read allows
 * nothing. */
async function folderFacts(
  context: CliContext,
): Promise<Readonly<{ allowed: boolean; locale: "cs" | "en" }>> {
  try {
    const folder = await context.hostedFolder?.();
    if (folder === undefined) return { allowed: false, locale: "en" };
    const { preferences } = await readFolderState(join(folder, ".lazurio"));
    return {
      allowed: computersAllowed(preferences.preset.name),
      locale: preferences.profile.locale === "cs" ? "cs" : "en",
    };
  } catch {
    return { allowed: false, locale: "en" };
  }
}

/** This process's host for people's computers. */
export function processComputersHost(context: CliContext): ComputersHost {
  const tools = toolsEnvironmentOf(context.env, context.platform, runTool);
  const ssh = processSshAccessHost(tools);
  let facts: Promise<
    Readonly<{ allowed: boolean; locale: "cs" | "en" }>
  > | null = null;
  const read = () => {
    facts ??= folderFacts(context);
    return facts;
  };
  return {
    ...ssh,
    // The CLI pairs nothing: the pairing is the Launchpad's.
    channelUrl: async () => null,
    executorCommand: () => installedEntry(ssh.home),
    executor: processExecutorEndpoint(context.env),
    allowed: async () => (await read()).allowed,
    locale: async () => (await read()).locale,
    version: context.identity.version,
  };
}

// The name of this process's parent, the harness that runs the MCP server
// (Linux `/proc`); null elsewhere.
async function parentName(): Promise<string | null> {
  try {
    const name = (await readFile(`/proc/${process.ppid}/comm`, "utf8")).trim();
    return name === "" ? null : name;
  } catch {
    return null;
  }
}

/** `mcp` owns this process's stdin and stdout until its agent leaves; its
 * exit status. */
export async function runComputerSession(
  args: readonly string[],
  context: CliContext,
): Promise<number> {
  let device: string;
  try {
    const parsed = parseArgs({
      args: [...args.slice(1)],
      strict: true,
      allowPositionals: false,
      options: { device: { type: "string" } },
    });
    device = parsed.values.device ?? "";
  } catch {
    process.stderr.write(`Usage: computer ${args[0]} --device <id>\n`);
    return exitUsage;
  }
  if (!computerIdPattern.test(device)) {
    process.stderr.write(`Usage: computer ${args[0]} --device <id>\n`);
    return exitUsage;
  }
  if (args[0] !== "mcp") {
    // The SSH path is gone (contract v1): nothing attaches here any more.
    process.stderr.write(
      "lazurio computer attach is gone: a computer attaches over HTTPS. Update Lazurio Agent Desktop.\n",
    );
    return exitUsage;
  }
  const host = processComputersHost(context);
  const entry = await registryEntry(host.home, host.uid, device);
  const name = entry?.name ?? device;
  return runAgentEntry({
    socket: socketPath(host.home, device),
    name,
    version: context.identity.version,
    input: process.stdin,
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
    cachedTools: () => readTools(host.home, device),
    updating: () => isUpdating(host.home, device),
    harness: await parentName(),
  });
}

const stateWord = (computer: ComputerView) =>
  computer.connected ? "attached" : "not attached";

export async function runComputerCommand(
  args: readonly string[],
  context: CliContext & Readonly<{ host?: ComputersHost }>,
): Promise<CommandOutput> {
  const usage: CommandOutput = {
    code: exitUsage,
    stderr: `Usage: computer list|remove <id> [--json]\n${computerHelp}`,
  };
  let positionals: string[];
  let json = false;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
    positionals = parsed.positionals;
    json = parsed.values.json === true;
  } catch {
    return usage;
  }
  const host = context.host ?? processComputersHost(context);
  try {
    if (positionals.length === 1 && positionals[0] === "list") {
      const overview = await listComputers(host);
      if (json) return { code: exitOk, stdout: JSON.stringify(overview) };
      if (!overview.supported)
        return {
          code: exitOk,
          stdout:
            overview.reason === "not-here"
              ? "People's computers are not used in this Environment (only a Personal Environment or a person's own Work Environment uses them)."
              : `People's computers are not available here (${overview.reason}).`,
        };
      return {
        code: exitOk,
        stdout:
          overview.computers.length === 0
            ? "No computer is paired. A person pairs one in Lazurio Agent Desktop through Settings → Connections."
            : overview.computers
                .map(
                  (computer) =>
                    `${computer.deviceId}  ${computer.name} (${computer.os ?? "?"}) · ${computer.appVersion === null ? "version unknown" : `app ${computer.appVersion}`} · ${computer.updating ? "updating" : stateWord(computer)} · last activity ${computer.lastActivity ?? "none"} · ${computer.agents === "executor" ? "in Executor" : "not in Executor"}`,
                )
                .join("\n"),
      };
    }
    if (positionals.length === 2 && positionals[0] === "remove") {
      const answer = await removeComputer(host, positionals[1]);
      const code =
        answer.kind === "computer-removed"
          ? exitOk
          : answer.reason === "invalid-id" || answer.reason === "not-found"
            ? exitUsage
            : exitFailure;
      if (json) return { code, stdout: JSON.stringify(answer) };
      return answer.kind === "computer-removed"
        ? {
            code,
            stdout:
              answer.agents === "left"
                ? `Removed ${answer.deviceId}. Its server stayed in Executor; remove it in Apps → Integrace → Vlastní.`
                : `Removed ${answer.deviceId}.`,
          }
        : { code, stderr: `Not removed: ${answer.reason}.` };
    }
  } catch {
    return { code: exitFailure, stderr: `computer ${positionals[0]} failed.` };
  }
  return usage;
}
