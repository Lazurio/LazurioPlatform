import { parseArgs } from "node:util";
import { FolderAdoptionError } from "../folder/handover-layout";
import {
  adoptedHandoverFolder,
  initializeHandoverFolder,
} from "../folder/initialize-folder";
import { FolderOperationBusyError } from "../folder/lock";
import type { MachineBinding } from "../folder/machine-binding";
import { executionOs } from "../folder/platform";
import {
  allowedPresets,
  derivePreset,
  type PresetName,
  parsePresetName,
  presetProfile,
  selectablePresets,
} from "../folder/presets";
import { refreshFolder } from "../folder/update-profile";
import {
  type EnvironmentSshLocation,
  type EnvironmentSshResult,
  writeEnvironmentSsh,
} from "../ssh-access/environments";
import { machineBinding } from "./binding";
import {
  bindMachineOperator,
  type MachineContext,
  MachineContextError,
  readMachineContext,
} from "./context";
import {
  type LaunchpadSeams,
  recordedEntry,
  restartLaunchpadForEntry,
} from "./launchpad-entry";
import { readLinuxOperator } from "./operator";

export const machineHelp = `machine inspect
Read the root-issued /etc/lazurio/lazurio.machine.json on Linux only and print
it as written, including its optional entry (how the gateway reaches the
Launchpad, T3 Code and modules of this Remote Environment).
Output contains private Environment/Organization context; do not publish it.
The declaration grants no permissions, provider identity or access.
machine folder-init [--preset <name>] [--locale <cs|en>]
  [--detail <concise|technical>] [--coordination <direct|coordinator>]
Initialize the declared operator's standard Lazurio Folder from the handover.
The workspace preset is derived from the handover (personal-vm -> hosted-personal;
workspace-vm with owner.assignment operator -> hosted-organization-personal, team
-> hosted-organization-team, automation (the Henry Environment of an
Organization persona, decision 0169) -> hosted-organization-steward, services
(the services Environment of a server, root decision 0209) ->
hosted-organization-team; without owner.assignment and without owner.team ->
hosted-organization-personal). When
the handover states owner.assignment, --preset may name only the preset it
derives. A workspace-vm handover with owner.team and no owner.assignment does
not say whether the Remote Environment is assigned to one user or shared, so
it derives nothing: --preset with one of hosted-organization-personal,
hosted-organization-team or hosted-organization-steward is required and
recorded as an explicit choice; without owner.assignment --preset may pick any
of these on a workspace-vm. Omitted communication choices take the preset's
defaults; all are changeable later in the Launchpad.
Adopts the existing Folder: organizations/ and personalspace/ may hold work
and are never entered; launchpad.gen3.json and launchpad.gen3.local.json are
tolerated; any other top-level entry is refused by name. Re-running on an
adopted Folder reports already-adopted and changes nothing; a rewritten
handover reaches the Folder through folder-refresh. On a personal Remote
Environment an "initialized" answer also writes the SSH config for its
assigned Work Environments and adds "environmentSsh", as folder-refresh does.
Run as the declared operator, never root. No path or custody override.
No Organization checkout, gateway change, resident removal or migration.
An interrupted recognized journal can be completed using folder-resume;
missing/damaged journals require a user's diagnosis, never blanket cleanup.
machine folder-refresh [--preset <name>]
Re-render the adopted Folder's generated files (AGENTS.md, manual/) from the
current handover, keeping the recorded preset and profile. Run it as the
declared operator after every handover rewrite; lazurio update runs it itself
after a product update when the Folder records an older template revision. --preset
names the preset the handover now derives, to take it after
preset-derivation-changed; no other preset is taken here. A Folder rendered by
an older template revision is re-rendered in full when every generated file
still matches its recorded digest.
The Environment identity (kind, name, Owner, tailnet node) must be the one the
Folder was adopted for; the host, assignment, relationships and the document
digest follow the handover. Prints {"kind":"refreshed","revision":<n>} after one
archived update transaction, or {"kind":"unchanged"} when the current handover
renders the same bytes (nothing is written, the revision stays). On a
personal Remote Environment either answer then also writes, from the recorded
binding's assigned Work Environments, ~/.ssh/config.d/lazurio-environments.conf
(0600), ~/.ssh/known_hosts_lazurio_environments (0644) and one Include line at
the top of ~/.ssh/config, or removes the two files when there are none, and
adds "environmentSsh": written, unchanged, removed, none, blocked (with reason
and path: a file Lazurio did not write or an unsafe path, nothing changed) or
failed; the exit code stays the refresh's. A refresh
that records a different entry restarts the supervised Launchpad of this
Folder, which reads its entry only when it starts, and waits for it to answer;
modules, T3 Code and Codex keep running. The answer then adds "launchpad":
restarted, restart-failed or not-supervised (no installer unit of this base
starts this Folder; the Launchpad takes the entry at its next start). Blocked with
exit 2, nothing written: folder-not-initialized (run folder-init first),
folder-binding-changed, folder-state-unrecognized, folder-foreign-entry (a
top-level entry the Folder does not own or tolerate), drift or unsafe-path with
the edited path (owned files are never overwritten), preset-derivation-changed
(the assignment now derives another preset: take it with folder-refresh
--preset <the derived preset>), preset-not-allowed (--preset is not the
preset the handover derives), template-upgrade-required (a newer product rendered the Folder;
nothing is downgraded), or a machine-context-* code. Exit 1 is an
operation failure; an interrupted refresh is completed with
profile-resume --folder <Folder> --target-revision <n>.
Every outcome of folder-init, folder-refresh and inspect is exactly one JSON
object on stdout; text for people goes to stderr. A Folder whose lock another
Lazurio operation still holds after the adoption check waited answers
{"kind":"blocked","reason":"folder-busy","retryable":true} with exit 2, nothing
changed: the same command may simply be run again. Any other failure answers
{"kind":"failed","reason":"internal"} with exit 1.`;

const choices = {
  locale: ["cs", "en"],
  detail: ["concise", "technical"],
  coordination: ["direct", "coordinator"],
} as const;

// A wrong invocation, before any filesystem access: the CLI prints the help
// text and exits 2. It is not a failed Folder operation.
export class MachineUsageError extends Error {}

const machineOptions = {
  preset: { type: "string" },
  locale: { type: "string" },
  detail: { type: "string" },
  coordination: { type: "string" },
} as const;

function parseMachineTokens(args: string[]) {
  try {
    return parseArgs({
      args,
      strict: true,
      tokens: true,
      options: machineOptions,
    });
  } catch {
    throw new MachineUsageError("Unknown or malformed lazurio machine option");
  }
}

// Exported so a test can prove what the parser accepts without reaching the
// handover: runMachineCommand reads the root-issued declaration and acts on
// the declared operator's real Folder, which a test must never do (#782).
export function parseMachineArguments(args: string[]) {
  const [command, ...options] = args;
  if (
    command !== "inspect" &&
    command !== "folder-init" &&
    command !== "folder-refresh"
  )
    throw new MachineUsageError("Unknown lazurio machine command");
  const parsed = parseMachineTokens(options);
  const { values, tokens } = parsed;
  if (
    (command === "inspect" && tokens.length !== 0) ||
    (command === "folder-refresh" &&
      tokens.some(
        (token) => token.kind === "option" && token.name !== "preset",
      )) ||
    tokens.some((token) => token.kind !== "option") ||
    new Set(tokens.map((token) => (token.kind === "option" ? token.name : "")))
      .size !== tokens.length
  )
    throw new MachineUsageError(
      "Explicit nonduplicate lazurio machine options required",
    );
  const value = (name: keyof typeof choices) => {
    const chosen = values[name];
    if (
      chosen !== undefined &&
      !(choices[name] as readonly string[]).includes(chosen)
    )
      throw new MachineUsageError(`Invalid lazurio machine choice: ${name}`);
    return chosen;
  };
  let preset: ReturnType<typeof parsePresetName> | undefined;
  try {
    preset =
      values.preset === undefined ? undefined : parsePresetName(values.preset);
  } catch {
    throw new MachineUsageError("Unknown workspace preset");
  }
  return {
    command,
    preset,
    locale: value("locale") as "cs" | "en" | undefined,
    detail: value("detail") as "concise" | "technical" | undefined,
    coordination: value("coordination") as "direct" | "coordinator" | undefined,
  };
}

// `launchpad` is where folder-refresh finds the supervised Launchpad to
// restart after it recorded a different entry (launchpad-entry.ts); the CLI
// passes the installed one, and without it nothing is restarted.
export async function runMachineCommand(
  args: string[],
  launchpad?: LaunchpadSeams,
) {
  const {
    command,
    preset: requestedPreset,
    ...values
  } = parseMachineArguments(args);
  try {
    const observed = await readMachineContext();
    // Projected before anything is printed or recorded: inspect refuses what
    // folder-init and folder-refresh would refuse.
    const machine = machineBinding(observed.context, observed.digest);
    if (command === "inspect")
      return { code: 0, result: machineInspection(observed) };
    const operator = await readLinuxOperator();
    const folder = bindMachineOperator(observed.context, operator);
    const { code, result } =
      command === "folder-refresh"
        ? await refreshMachineFolderAndLaunchpad(
            folder,
            machine,
            requestedPreset,
            launchpad,
          )
        : await initializeMachineFolder(folder, machine, {
            preset: requestedPreset,
            ...values,
          });
    return {
      code,
      result: {
        ...(await withEnvironmentSsh(result, machine, {
          home: operator.homedir,
          uid: operator.uid,
        })),
        machineContextDigest: observed.digest,
      },
    };
  } catch (error) {
    return machineFailureAnswer(error);
  }
}

// A Folder whose lock another Lazurio operation holds: nothing changed, and
// the same command may simply run again. `profile-update` answers the same,
// so `lazurio update` retries either refresh (decision F17's addendum of
// 2026-10-30).
export const folderBusyAnswer = Object.freeze({
  kind: "blocked" as const,
  reason: "folder-busy" as const,
  retryable: true as const,
  next: "Another Lazurio operation holds this Folder; run the same command again in a moment. Nothing was changed.",
});

// Every failure of folder-init, folder-refresh and inspect is one JSON answer
// too, because Lazurio Machines reads exactly one (issue #655). A busy Folder
// is named as retryable; anything unexpected names nothing it read, as the
// CLI's own failure text does, and says only that the operation failed.
export function machineFailureAnswer(error: unknown) {
  if (error instanceof FolderAdoptionError)
    return { code: 2, result: describeFolderAdoption(error) };
  if (error instanceof MachineContextError)
    return {
      code: 2,
      result: {
        kind: "blocked" as const,
        reason: error.code,
        next: "Ask the operator who hosts this Remote Environment to verify the handover; do not edit the identity file or reset product trust.",
      },
    };
  if (error instanceof FolderOperationBusyError)
    return { code: 2, result: folderBusyAnswer };
  return {
    code: 1,
    result: {
      kind: "failed" as const,
      reason: "internal" as const,
      next: "The Folder operation failed and its state may require recovery; no automatic retry or cleanup was performed.",
    },
  };
}

// What `machine inspect` prints: the validated handover exactly as written,
// its optional `entry` included, and its digest. Context, never authority.
export function machineInspection(
  observed: Readonly<{ context: MachineContext; digest: string }>,
) {
  return {
    kind: "machine-context-observed" as const,
    ...observed,
    authority: "none" as const,
  };
}

export type FolderInitChoices = Readonly<{
  preset: PresetName | undefined;
  locale: "cs" | "en" | undefined;
  detail: "concise" | "technical" | undefined;
  coordination: "direct" | "coordinator" | undefined;
}>;

// folder-init after the handover and the operator are bound. The preset is
// --preset when given (within what the handover offers as a new choice: only
// the derived one when it states owner.assignment, issue #107), else the
// derived one. A handover that derives none (see machineAssignment) never gets
// a guess: an already adopted Folder keeps the preset it has, anything else
// needs --preset.
export async function initializeMachineFolder(
  folder: string,
  machine: MachineBinding,
  choices: FolderInitChoices,
) {
  const derived = derivePreset(machine);
  const allowed = selectablePresets(machine);
  const preset = choices.preset ?? derived;
  if (preset === null) {
    const adopted = await adoptedHandoverFolder(folder, machine);
    if (adopted) return { code: 0, result: adopted };
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "preset-ambiguous",
        allowed,
        next: "Pass --preset: this handover names a Team but no owner.assignment, so it does not say whether the Remote Environment is assigned to one user or shared; the Lazurio Machines resident role passes it from the owner infrastructure.",
      },
    };
  }
  if (!allowed.includes(preset)) {
    // Rerunning the command that adopted this Folder is no new choice: a
    // preset the handover still allows reports the adopted Folder (#107).
    if (allowedPresets(machine).includes(preset)) {
      const adopted = await adoptedHandoverFolder(folder, machine);
      if (adopted) return { code: 0, result: adopted };
    }
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "preset-not-allowed",
        derived,
        allowed,
        next:
          derived === null
            ? "Choose a preset the handover allows; this handover derives none."
            : "Choose a preset the handover allows, or omit --preset for the derived one.",
      },
    };
  }
  const profile = presetProfile(preset, executionOs(process.platform), {
    ...(choices.locale === undefined ? {} : { locale: choices.locale }),
    ...(choices.detail === undefined ? {} : { detail: choices.detail }),
    ...(choices.coordination === undefined
      ? {}
      : { coordination: choices.coordination }),
  });
  const result = await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile,
  });
  return { code: 0, result };
}

// folder-refresh after the handover and the operator are bound. The adoption
// check refuses another Machine's or unrecognized state by name before the
// update transaction; the planner checks the identity again under its lock.
// `preset` is the preset the handover now derives, taken with it (#107).
export async function refreshMachineFolder(
  folder: string,
  machine: MachineBinding,
  preset: PresetName | undefined = undefined,
) {
  const adopted = await adoptedHandoverFolder(folder, machine);
  if (adopted === null)
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "folder-not-initialized",
        next: "Run lazurio machine folder-init first; nothing was created.",
      },
    };
  const result = await refreshFolder(folder, machine, undefined, preset);
  return { code: result.kind === "blocked" ? 2 : 0, result };
}

// The refresh, then the running Launchpad: it read its entry when it started,
// so a refresh that records a different entry restarts the supervised
// Launchpad of this Folder and says so in `launchpad`. An unchanged entry
// (unchanged, blocked, or a refresh of rendered text only) restarts nothing
// and adds nothing to the answer.
export async function refreshMachineFolderAndLaunchpad(
  folder: string,
  machine: MachineBinding,
  preset: PresetName | undefined,
  launchpad: LaunchpadSeams | undefined,
) {
  const before = launchpad === undefined ? null : await recordedEntry(folder);
  const refreshed = await refreshMachineFolder(folder, machine, preset);
  if (launchpad === undefined || refreshed.result.kind !== "refreshed")
    return refreshed;
  if ((await recordedEntry(folder)) === before) return refreshed;
  return {
    code: refreshed.code,
    result: {
      ...refreshed.result,
      launchpad: await restartLaunchpadForEntry(folder, launchpad),
    },
  };
}

// When the Folder records exactly this handover's binding (folder-init that
// initialized it, folder-refresh that recorded it or found it the same), the
// person's SSH config on a personal Machine follows its assigned peers (root
// decision 0192, addendum of 2026-10-26; src/ssh-access/environments.ts), and
// the answer says how in `environmentSsh`. "already-adopted" may record an
// older handover until the refresh that follows it, and a blocked operation
// wrote nothing: neither writes here, and nor does any other Machine. Neither
// a refusal nor a failure of this step changes the exit code: the Folder is
// what it is, and the files are the person's to fix.
const recordsThisBinding: ReadonlySet<string> = new Set([
  "initialized",
  "refreshed",
  "unchanged",
]);
export async function withEnvironmentSsh<
  Result extends Readonly<{ kind: string }>,
>(result: Result, machine: MachineBinding, location: EnvironmentSshLocation) {
  if (machine.kind !== "personal-vm" || !recordsThisBinding.has(result.kind))
    return result;
  let environmentSsh: EnvironmentSshResult | { kind: "failed" };
  try {
    environmentSsh = await writeEnvironmentSsh(location, machine);
  } catch {
    environmentSsh = { kind: "failed" };
  }
  if (environmentSsh.kind === "blocked")
    console.error(
      `The SSH config for the assigned Work Environments was not written: ${environmentSsh.path} is ${environmentSsh.reason === "file-foreign" ? "not Lazurio's file" : "not a plain file or directory of this account"}. Nothing was changed; move it away and refresh again.`,
    );
  else if (environmentSsh.kind === "failed")
    console.error(
      "The SSH config for the assigned Work Environments could not be written; the Folder itself is unaffected.",
    );
  return { ...result, environmentSsh };
}

// The refusal names the entry; the operator decides what to do with it.
export function describeFolderAdoption(error: FolderAdoptionError) {
  const next = {
    "foreign-entry":
      "Move this entry out of the Folder; only organizations/, personalspace/, the two legacy launchpad files and what Lazurio generated may be present.",
    "layout-missing":
      "Ask the operator who hosts this Remote Environment to deliver the standard Folder layout; nothing is created in its place.",
    "personalspace-conflict":
      "An Organization preset never has a Personalspace; move it away yourself, nothing is deleted.",
    "state-unrecognized":
      "Complete a recognized initialization with folder-resume or diagnose the state; nothing is reset.",
    "binding-changed":
      "The Folder was adopted from a different handover; verify the identity of this Remote Environment with the operator who hosts it.",
    "directory-shared":
      "chmod g-w,o-w this path under the Lazurio Folder (Ubuntu's default umask 0002 makes new directories group-writable); nothing was changed.",
  } as const;
  return {
    kind: "blocked" as const,
    reason: `folder-${error.code}` as const,
    entry: error.entry,
    next: next[error.code],
  };
}
