import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { acquireFileLock, type FileLock } from "../platform/flock";
import { runTool } from "../tools/status";
import type { CliContext, CommandOutput } from "../update/cli";
import { exitFailure, exitOk, exitUsage } from "../update/errors";
import { runProcess } from "../update/self-check";
import { processBrainHost } from "./host";
import { readBrainState, writeBrainState } from "./keys";
import {
  type NightWindow,
  nightLeastMinutes,
  nightOf,
  nightShortestMinutes,
  parseNight,
} from "./night";
import { brainPin } from "./pin";
import {
  earlierStepBlockers,
  meaningBlockers,
  moveBlockers,
  stopFirstBlockers,
} from "./preflight";
import { brainSetup, type SetupHost, type SetupResult } from "./setup";
import { type BrainStatus, brainStatus } from "./status";

/** `lazurio brain`: the person's memory of a Personal Environment (plan
 * LZD-0033 R11a), a tool Lazurio looks after like Executor. */
export const brainHelp = `brain status [--json]
  The person's memory (GBrain) of this Personal Environment, read locally:
  who runs its server (Lazurio, the interim installer, Machines), the
  version answering on 127.0.0.1:3131 and the pinned one (${brainPin.version}),
  whether the brain is there, and which of Lazurio's keys are handed over.
  Where an earlier installer runs it: the release a takeover would record
  (interimRelease), every reason known now that would refuse the takeover
  or, as held does, only the move after it (takeoverBlockers, empty where
  none) and the brain's size beside the room on the disk (brainRoom), from
  file sizes only; the text gives the sizes in MB, --json in bytes.
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
  previous release, 1 not finished (a key not minted or an earlier one not
  revoked included) or stopped for a person.
brain take-over [--json]
  The owner's consent to take over the brain an earlier installer runs on
  this Personal Environment, then what setup does, under setup's lock (while
  another run holds it, nothing happens: busy). The consent counts only for
  this run: where the takeover does not run (Machines not ready, a unit not
  the installer's, its release not known for sure, the server not answering
  its version), nothing takes the brain over later until its owner runs
  take-over again. A consent an earlier release recorded counts for nothing.
brain night [HH:MM-HH:MM [--time-zone Zone]] [--json]
  The night window in which search by meaning computes its vectors, the
  memory stopped for it (up to an hour at a stretch, only while Buddy is
  idle); by day nothing stops the memory for it, except a small backlog one
  short window computes. Without a window, shows the one in force: the
  person's, or 02:00-05:00 Europe/Prague. With one, chooses it under setup's
  lock (busy while another run holds it).`;

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

const megabytes = (bytes: number | null) =>
  bytes === null ? "unknown" : `${Math.ceil(bytes / 1024 / 1024)} MB`;

/** An interim installer's brain: what a consented run would do, in the
 * order setup meets its blockers. No handover mark, or a takeover's way
 * back that did not complete, stops it before anything changes; else an
 * earlier step's record is dealt with first (things change), then a
 * refusal stops the takeover, and `held` stops only the move after it. */
function adoptableText(
  status: Extract<BrainStatus, { owner: unknown }>,
): string {
  const from = `The memory runs from an earlier installer (${status.running ?? "not answering"})`;
  const blockers = status.takeoverBlockers ?? [];
  const gate = blockers.filter((b) => stopFirstBlockers.includes(b));
  const earlier = blockers.filter((b) => earlierStepBlockers.includes(b));
  const refusing = blockers.filter(
    (b) =>
      !moveBlockers.includes(b) &&
      !meaningBlockers.includes(b) &&
      !earlierStepBlockers.includes(b) &&
      !stopFirstBlockers.includes(b),
  );
  const held = blockers.filter((b) => moveBlockers.includes(b));
  const meaningHeld = blockers.filter((b) => meaningBlockers.includes(b));
  // What a consented run does once nothing before stops it.
  const outcome =
    refusing.length > 0
      ? `the takeover would be refused: ${refusing.join(", ")}`
      : held.length > 0
        ? `a run with consent takes the memory over, but does not move it to ${status.pin}: ${held.join(", ")} (a move to this release was given up before)`
        : meaningHeld.length > 0
          ? `a run with consent takes the memory over and moves it to ${status.pin}, but does not switch search by meaning on: ${meaningHeld.join(", ")} (given up or stopped for this model before)`
          : `a run with consent takes the memory over and moves it to ${status.pin}`;
  const room = status.brainRoom;
  const size =
    room === undefined
      ? ""
      : `\nSize: ${megabytes(room.brainBytes)} in ${room.brainFiles ?? "unknown"} files; room on the disk ${megabytes(room.freeBytes)}, needed ${megabytes(room.neededBytes)}.`;
  const rest = blockers.filter((b) => !gate.includes(b));
  if (gate.length > 0)
    return `${from}; a takeover now would be refused and change nothing: ${gate.join(", ")}.${rest.length > 0 ? ` Once that is resolved, also in the way: ${rest.join(", ")}.` : ""}${size}`;
  if (earlier.length > 0) {
    // What follows the earlier step, as setup goes on (`setupOnce`): a
    // stopped move keeps the server down in every run; a move left half way
    // is finished or undone by a run that then takes nothing over; the rest
    // (`recoverFirst`) go on to the takeover only where they complete.
    const tail = earlier.includes("move-stopped")
      ? "A move stopped for a person keeps the memory stopped and disabled in every run until a person decides; no run takes it over."
      : earlier.includes("move-unfinished")
        ? "The run that finishes or undoes the unfinished move takes nothing over; a later run with consent is checked anew."
        : `If that completes, in the same run ${outcome}; if it does not, setup stops there for a person.`;
    return `${from}; an earlier step was left unfinished (${earlier.join(", ")}). Setup deals with it first, in any run, also without consent: it may stop the memory, put units or a copy back or finish that step. ${tail} Let a person look at it before consenting.${size}`;
  }
  if (refusing.length > 0)
    return `${from}; a takeover now would be refused and change nothing: ${refusing.join(", ")}.${size}`;
  if (held.length > 0 || meaningHeld.length > 0)
    return `${from}; once its owner agrees, ${outcome}.${size}`;
  return `${from}; Lazurio takes it over once its owner agrees, and nothing known now would stop it or the move to ${status.pin}.${size}`;
}

/** Plain lines; never a key, a token or a path of the person's. */
export function brainStatusText(status: BrainStatus): string {
  if (status.state === "unsupported")
    return `Not available: ${reasons[status.reason]}.`;
  const head = {
    "not-installed": status.brain
      ? "A memory is here without a unit; Lazurio leaves it as it is until a person decides."
      : `No memory is set up here; lazurio brain setup installs GBrain ${status.pin}.`,
    adoptable: adoptableText(status),
    machines: "The memory is run by Machines on this Environment.",
    foreign:
      "A unit of the memory (gbrain.service or its refresh) that Lazurio did not write, or cannot read, is in place; Lazurio leaves it alone.",
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
  const meaning =
    status.meaning === "on"
      ? "Search by meaning is on."
      : status.meaning === "filling"
        ? `Search by meaning is being switched on: it covers the pages done, and the rest is computed at night (${status.night.start}–${status.night.end}, ${status.night.timeZone}; lazurio brain night changes it).`
        : `Search by meaning is off: the memory finds pages by their words only. It is computed at night (${status.night.start}–${status.night.end}, ${status.night.timeZone}; lazurio brain night changes it).`;
  return `${head}\nKeys: ${keys}.\n${meaning}${waits}`;
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
    ...(result.archive === undefined ? [] : [`archive ${result.archive}`]),
    ...(result.meaning === undefined ? [] : [`meaning ${result.meaning}`]),
    ...(result.timer === undefined ? [] : [`timer ${result.timer}`]),
  ].join("\n");

/** `lazurio brain night [HH:MM-HH:MM] [--time-zone Zone]`: the night window
 * search by meaning computes in, shown, or chosen under setup's lock (while
 * another run holds it, nothing is written: busy). */
async function nightCommand(
  host: SetupHost,
  range: string | undefined,
  timeZone: string | undefined,
  json: boolean,
): Promise<CommandOutput> {
  const status = await brainStatus(host);
  if (status.state === "unsupported")
    return { code: exitUsage, stdout: brainStatusText(status) };
  const show = (night: NightWindow, code: number, changed: boolean) => ({
    code,
    stdout: json
      ? JSON.stringify({ night, changed })
      : `Search by meaning computes at night, ${night.start}–${night.end} (${night.timeZone}); by day nothing stops the memory for it, except a small backlog.`,
  });
  if (range === undefined)
    return show(
      nightOf((await readBrainState(host.paths)).night),
      exitOk,
      false,
    );
  const chosen = parseNight(range, timeZone);
  if (typeof chosen === "string")
    return {
      code: exitUsage,
      stderr:
        chosen === "invalid-range"
          ? "A night window is HH:MM-HH:MM, start and end apart, e.g. 02:00-05:00."
          : chosen === "too-short"
            ? `A night window needs at least ${nightShortestMinutes} minutes: one stop of the memory needs ${nightLeastMinutes} of them to compute anything. Choose a longer one, e.g. 02:00-05:00.`
            : "That time zone is not known; give an IANA name, e.g. Europe/Prague.",
    };
  let lock: FileLock;
  try {
    await mkdir(dirname(host.paths.state), { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(
      join(dirname(host.paths.state), "setup.lock"),
      {
        timeoutMs: 0,
      },
    );
  } catch {
    return { code: exitUsage, stdout: json ? '{"night":"busy"}' : "busy" };
  }
  try {
    const current = await readBrainState(host.paths);
    await writeBrainState(host.paths, { ...current, night: chosen });
  } finally {
    await lock.release();
  }
  return show(chosen, exitOk, true);
}

export async function runBrainCommand(
  args: readonly string[],
  context: BrainCliContext,
): Promise<CommandOutput> {
  const usage = Object.freeze({
    code: exitUsage,
    stderr: `Usage: brain status|setup|take-over|night [--json]\n${brainHelp}`,
  });
  let command: string;
  let json = false;
  let range: string | undefined;
  let timeZone: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        "time-zone": { type: "string" },
      },
    });
    command = parsed.positionals[0] as string;
    const extra = parsed.positionals.length - 1;
    if (command === "night" ? extra > 1 : extra !== 0) return usage;
    range = command === "night" ? parsed.positionals[1] : undefined;
    timeZone = parsed.values["time-zone"];
    if (timeZone !== undefined && range === undefined) return usage;
    json = parsed.values.json === true;
  } catch {
    return usage;
  }
  if (!["status", "setup", "take-over", "night"].includes(command))
    return usage;
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
    if (command === "night")
      return await nightCommand(host, range, timeZone, json);
    if (command === "take-over") {
      const status = await brainStatus(host);
      if (status.state === "unsupported")
        return { code: exitUsage, stdout: brainStatusText(status) };
    }
    const result = await brainSetup(
      host,
      command === "take-over" ? { consent: new Date() } : {},
    );
    // A key not minted, or an earlier one not revoked, is not finished.
    // So is a refresh timer that is enabled and does not run.
    // So is a conversation archive that could not be switched off: the
    // person's memory keeps taking in their agents' conversations.
    const keysIncomplete =
      result.timer === "failed" ||
      result.archive?.startsWith("failed:") === true ||
      Object.values(result.keys ?? {}).some(
        (outcome) => outcome === "failed" || outcome === "incomplete",
      );
    const code =
      ["failed", "stopped", "takeover-refused"].includes(result.server) ||
      keysIncomplete
        ? exitFailure
        : ["installed", "started", "running", "moved"].includes(result.server)
          ? exitOk
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
            archive: result.archive,
            meaning: result.meaning,
            timer: result.timer,
            status: result.status,
          })
        : labelOf(result),
    };
  } catch {
    return { code: exitFailure, stderr: `Brain ${command} failed.` };
  }
}
