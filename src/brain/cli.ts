import { parseArgs } from "node:util";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { runProcess } from "../update/self-check";
import { processBrainHost } from "./host";
import { brainPin } from "./pin";
import { brainSetup, type SetupHost, type SetupResult } from "./setup";
import { type BrainStatus, brainStatus } from "./status";

/** `lazurio brain`: the person's memory of a Personal Environment (plan
 * LZD-0033 R11a), a tool Lazurio looks after like Executor. */
export const brainHelp = `brain status [--json]
  The person's memory (GBrain) of this Personal Environment, read locally:
  who runs its server (Lazurio, the interim installer, Machines), the
  version answering on 127.0.0.1:3131 and the pinned one (${brainPin.version}),
  whether the brain is there, and which of Lazurio's keys are handed over.
  Nothing is changed and the network is not used.
brain setup [--json]
  What the Launchpad starts after it starts on a Personal Environment:
  installs the pinned GBrain for this user without root, creates the brain
  where there is none, writes Lazurio's units and starts the server, and
  keeps the keys of the Launchpad, Executor and doctor working. A brain the
  interim installer or Machines run is only reported. Prints closed labels
  only, never a key. Exit status: 0 running, 2 not here or waiting for its
  owner, 1 not finished.`;

export type BrainCliContext = CliContext &
  Readonly<{ host?: SetupHost | undefined }>;

const reasons = {
  workstation:
    "the person's memory is set up by Lazurio only in a Remote Environment on Linux",
  "handover-unreadable": "the Machine handover cannot be read",
  "not-operator": "this account is not the Environment's declared operator",
  "not-personal":
    "the person's memory belongs to a Personal Environment, and this one is not",
} as const;

/** Plain lines; never a key, a token or a path of the person's. */
export function brainStatusText(status: BrainStatus): string {
  if (status.state === "unsupported")
    return `Not available: ${reasons[status.reason]}.`;
  const head = {
    "not-installed": `No memory is set up here; lazurio brain setup installs GBrain ${status.pin}.`,
    adoptable: `The memory runs from an earlier installer (${status.running ?? "not answering"}); Lazurio takes it over once its owner agrees.`,
    machines: "The memory is run by Machines on this Environment.",
    foreign:
      "A unit gbrain.service that Lazurio did not write is in place; Lazurio leaves it alone.",
    outdated: `The memory runs ${status.running}; Lazurio moves it to ${status.pin} with a copy first.`,
    "not-running":
      "The memory is set up and does not answer; lazurio brain setup starts it.",
    running: `The memory ${status.running} runs on 127.0.0.1:3131.`,
  }[status.state];
  const keys = Object.entries(status.keys)
    .map(([kind, state]) => `${kind} ${state}`)
    .join(", ");
  return `${head}\nKeys: ${keys}.`;
}

const labelOf = (result: SetupResult) =>
  [
    `server ${result.server}${result.step ? ` at ${result.step}` : ""}`,
    ...Object.entries(result.keys ?? {}).map(
      ([kind, outcome]) => `key ${kind} ${outcome}`,
    ),
  ].join("\n");

export async function runBrainCommand(
  args: readonly string[],
  context: BrainCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: brain status|setup [--json]\n${brainHelp}`,
  });
  let command: string;
  let json = false;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: { json: { type: "boolean" } },
    });
    if (parsed.positionals.length !== 1) return usage;
    command = parsed.positionals[0] as string;
    json = parsed.values.json === true;
  } catch {
    return usage;
  }
  if (command !== "status" && command !== "setup") return usage;
  const host =
    context.host ??
    processBrainHost({
      hostedFolder: async () => context.hostedFolder?.(),
      env: context.env,
      platform: context.platform,
      run: runTool,
      service: context.run ?? runProcess,
    });
  try {
    if (command === "status") {
      const status = await brainStatus(host);
      return {
        code: exitOk,
        stdout: json ? JSON.stringify(status) : brainStatusText(status),
      };
    }
    const result = await brainSetup(host);
    const code = ["installed", "started", "running"].includes(result.server)
      ? exitOk
      : ["failed"].includes(result.server)
        ? exitFailure
        : exitUsage;
    // Closed labels and the status only: the result carries no key.
    return {
      code,
      stdout: json
        ? JSON.stringify({
            server: result.server,
            step: result.step,
            keys: result.keys,
            status: result.status,
          })
        : labelOf(result),
    };
  } catch {
    return { code: exitFailure, stderr: `Brain ${command} failed.` };
  }
}
