import { parseArgs } from "node:util";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { runProcess } from "../update/self-check";
import { processBrainHost } from "./host";
import { brainPin } from "./pin";
import { brainSetup, type SetupHost, type SetupResult } from "./setup";
import { type BrainStatus, brainStatus } from "./status";
import { consentToTakeover } from "./takeover";

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
  keeps the keys of the Launchpad, Executor and doctor working; puts an
  empty brain onto the private vault the Personalspace declares (with a
  copy first, only while Buddy is idle) and keeps it in sync. A brain the
  interim installer runs is reported until its owner takes it over; then it
  is taken over in place and, like a brain on an earlier release, moved to
  the pin with a copy first and a way back, only while Buddy is idle. A
  brain Machines run is only reported. Prints closed labels only, never a key.
  Exit status: 0 running the pin, 2 not here, waiting or held on the
  previous release, 1 not finished or stopped for a person.
brain take-over [--json]
  The owner's consent to take over the brain an earlier installer runs on
  this Personal Environment, recorded once; then what setup does.`;

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
  const waits = status.handover
    ? ""
    : "\nMachines have not marked the handover on this host yet (/etc/lazurio/brain-handover); until then Lazurio only reports.";
  const keys = Object.entries(status.keys)
    .map(([kind, state]) => `${kind} ${state}`)
    .join(", ");
  return `${head}\nKeys: ${keys}.${waits}`;
}

const labelOf = (result: SetupResult) =>
  [
    `server ${result.server}${result.step ? ` at ${result.step}` : ""}`,
    ...Object.entries(result.keys ?? {}).map(
      ([kind, outcome]) => `key ${kind} ${outcome}`,
    ),
    ...(result.takeover === undefined ? [] : [`takeover ${result.takeover}`]),
    ...(result.move === undefined ? [] : [`move ${result.move}`]),
    ...(result.vault === undefined ? [] : [`vault ${result.vault}`]),
  ].join("\n");

export async function runBrainCommand(
  args: readonly string[],
  context: BrainCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: brain status|setup|take-over [--json]\n${brainHelp}`,
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
  if (!["status", "setup", "take-over"].includes(command)) return usage;
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
    if (command === "take-over") {
      const status = await brainStatus(host);
      if (status.state === "unsupported")
        return { code: exitUsage, stdout: brainStatusText(status) };
      await consentToTakeover(host.paths, new Date());
    }
    const result = await brainSetup(host);
    const code = ["installed", "started", "running", "moved"].includes(
      result.server,
    )
      ? exitOk
      : ["failed", "stopped", "takeover-refused"].includes(result.server)
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
            takeover: result.takeover,
            move: result.move,
            vault: result.vault,
            status: result.status,
          })
        : labelOf(result),
    };
  } catch {
    return { code: exitFailure, stderr: `Brain ${command} failed.` };
  }
}
