import { parseArgs } from "node:util";
import { FolderAdoptionError } from "../folder/handover-layout";
import {
  adoptedHandoverFolder,
  initializeHandoverFolder,
} from "../folder/initialize-folder";
import type { MachineBinding } from "../folder/machine-binding";
import { executionOs } from "../folder/platform";
import {
  allowedPresets,
  derivePreset,
  type PresetName,
  parsePresetName,
  presetProfile,
} from "../folder/presets";
import { refreshFolder, updateEntry } from "../folder/update-profile";
import { type HostedEntry, parseHostedEntry } from "../launchpad/hosted-trust";
import { machineBinding } from "./binding";
import {
  bindMachineOperator,
  MachineContextError,
  readMachineContext,
} from "./context";
import { readLinuxOperator } from "./operator";

export const machineHelp = `machine inspect
Read the root-issued /etc/lazurio/lazurio.machine.json on Linux only.
Output contains private Machine/Organization context; do not publish it.
The declaration grants no permissions, provider identity or access.
machine folder-init [--preset <name>] [--locale <cs|en>]
  [--detail <concise|technical>] [--coordination <direct|coordinator>]
Initialize the declared operator's standard Lazurio Folder from the handover.
The workspace preset is derived from the handover (personal-vm -> hosted-personal;
workspace-vm with owner.assignment operator -> hosted-organization-personal, team
-> hosted-organization-team; without owner.assignment and without owner.team ->
hosted-organization-personal). A workspace-vm handover with owner.team and no
owner.assignment does not say whether the Machine is assigned to one operator or
shared, so it derives nothing: --preset hosted-organization-personal or --preset
hosted-organization-team is required and recorded as an explicit choice. --preset may also pick another preset the handover allows. Omitted
communication choices take the preset's defaults; all are changeable later in
the Launchpad.
Adopts the existing Folder: organizations/ and personalspace/ may hold work
and are never entered; launchpad.gen3.json and launchpad.gen3.local.json are
tolerated; any other top-level entry is refused by name. Re-running on an
adopted Folder reports already-adopted and changes nothing; a rewritten
handover reaches the Folder through folder-refresh.
Run as the declared operator, never root. No path or custody override.
No Organization checkout, gateway change, resident removal or migration.
An interrupted recognized journal can be completed using folder-resume;
missing/damaged journals require operator diagnosis, never blanket cleanup.
machine folder-refresh
machine entry-update --expected-revision <n> --external-origin <https://launchpad.<machine>.<org>.lazurio.io>
  --auth-check-url <https://…/oauth2/auth> --auth-cookie-name <name> --listen-port <port>
Re-render the adopted Folder's generated files (AGENTS.md, manual/) from the
current handover, keeping the recorded preset and profile. Run it as the
declared operator after every handover rewrite and product update; it takes no
options. A Folder rendered by an older template revision is re-rendered in full
when every generated file still matches its recorded digest.
The Machine identity (kind, name, Owner, tailnet node, host) must be the one
the Folder was adopted for; assignment, relationships and the document digest
follow the handover. Prints {"kind":"refreshed","revision":<n>} after one
archived update transaction, or {"kind":"unchanged"} when the current handover
renders the same bytes (nothing is written, the revision stays). Blocked with
exit 2, nothing written: folder-not-initialized (run folder-init first),
folder-binding-changed, folder-state-unrecognized, folder-foreign-entry (a
top-level entry the Folder does not own or tolerate), drift or unsafe-path with
the edited path (owned files are never overwritten), preset-derivation-changed
(the assignment now derives another preset: choose it with profile-update
--preset), template-upgrade-required (a newer product rendered the Folder;
nothing is downgraded), or a Machine context code. Exit 1 is an
operation failure; an interrupted refresh is completed with
profile-resume --folder <Folder> --target-revision <n>.
entry-update records the hosted entry of this Machine (decision F16): the
Launchpad's external origin, the gateway's auth endpoint and session cookie
name, and the loopback port the gateway proxies to. It runs the same change
transaction as profile-update at the expected revision on the Folder adopted
for this Machine; the manual shows the entry, and \`lazurio launchpad --folder\`
serves behind the gateway from then on. Prints {"kind":"updated","revision":<n>},
{"kind":"unchanged"}, or a blocked reason with exit 2 (stale-revision, drift,
folder-not-initialized, …). Machines runs it after the handover until the
handover carries the entry itself.`;

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
  "expected-revision": { type: "string" },
  "external-origin": { type: "string" },
  "auth-check-url": { type: "string" },
  "auth-cookie-name": { type: "string" },
  "listen-port": { type: "string" },
} as const;
const entryOptions = [
  "expected-revision",
  "external-origin",
  "auth-check-url",
  "auth-cookie-name",
  "listen-port",
] as const;

function parseMachineTokens(args: string[]) {
  try {
    return parseArgs({
      args,
      strict: true,
      tokens: true,
      options: machineOptions,
    });
  } catch {
    throw new MachineUsageError("Unknown or malformed Machine option");
  }
}

function parseMachineArguments(args: string[]) {
  const [command, ...options] = args;
  if (
    command !== "inspect" &&
    command !== "folder-init" &&
    command !== "folder-refresh" &&
    command !== "entry-update"
  )
    throw new MachineUsageError("Unknown Machine command");
  const parsed = parseMachineTokens(options);
  const { values, tokens } = parsed;
  if (command === "entry-update") {
    const names = tokens.map((token) =>
      token.kind === "option" ? token.name : "",
    );
    if (
      names.length !== entryOptions.length ||
      new Set(names).size !== names.length ||
      !entryOptions.every((name) => names.includes(name))
    )
      throw new MachineUsageError(
        "entry-update requires exactly --expected-revision --external-origin --auth-check-url --auth-cookie-name --listen-port",
      );
    const integer = (name: "expected-revision" | "listen-port") => {
      const raw = values[name];
      if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw))
        throw new MachineUsageError(`Invalid Machine option: ${name}`);
      return Number(raw);
    };
    let entry: HostedEntry;
    try {
      entry = parseHostedEntry({
        externalOrigin: values["external-origin"],
        authCheckUrl: values["auth-check-url"],
        authCookieName: values["auth-cookie-name"],
        listenPort: integer("listen-port"),
      });
    } catch (error) {
      if (error instanceof MachineUsageError) throw error;
      throw new MachineUsageError(
        error instanceof Error ? error.message : "Invalid hosted entry",
      );
    }
    return {
      command,
      preset: undefined,
      locale: undefined,
      detail: undefined,
      coordination: undefined,
      entry: { expectedRevision: integer("expected-revision"), entry },
    };
  }
  if (
    (command !== "folder-init" && tokens.length !== 0) ||
    tokens.some((token) => token.kind !== "option") ||
    new Set(tokens.map((token) => (token.kind === "option" ? token.name : "")))
      .size !== tokens.length
  )
    throw new MachineUsageError(
      "Explicit nonduplicate Machine options required",
    );
  const value = (name: keyof typeof choices) => {
    const chosen = values[name];
    if (
      chosen !== undefined &&
      !(choices[name] as readonly string[]).includes(chosen)
    )
      throw new MachineUsageError(`Invalid Machine choice: ${name}`);
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
    entry: undefined,
  };
}

export async function runMachineCommand(args: string[]) {
  const {
    command,
    preset: requestedPreset,
    entry: entryRequest,
    ...values
  } = parseMachineArguments(args);
  try {
    const observed = await readMachineContext();
    if (command === "inspect")
      return {
        code: 0,
        result: {
          kind: "machine-context-observed",
          ...observed,
          authority: "none",
        },
      };
    const machine = machineBinding(observed.context, observed.digest);
    const folder = bindMachineOperator(
      observed.context,
      await readLinuxOperator(),
    );
    const { code, result } =
      command === "entry-update" && entryRequest
        ? await recordMachineEntry(folder, machine, entryRequest)
        : command === "folder-refresh"
          ? await refreshMachineFolder(folder, machine)
          : await initializeMachineFolder(folder, machine, {
              preset: requestedPreset,
              ...values,
            });
    return {
      code,
      result: { ...result, machineContextDigest: observed.digest },
    };
  } catch (error) {
    if (error instanceof FolderAdoptionError)
      return { code: 2, result: describeFolderAdoption(error) };
    if (error instanceof MachineContextError)
      return {
        code: 2,
        result: {
          kind: "blocked",
          reason: error.code,
          next: "Ask the Machines operator to verify the handover; do not edit the identity file or reset product trust.",
        },
      };
    throw error;
  }
}

export type FolderInitChoices = Readonly<{
  preset: PresetName | undefined;
  locale: "cs" | "en" | undefined;
  detail: "concise" | "technical" | undefined;
  coordination: "direct" | "coordinator" | undefined;
}>;

// folder-init after the handover and the operator are bound. The preset is
// --preset when given (within what the handover allows), else the derived one.
// A handover that derives none (see machineAssignment) never gets a guess: an
// already adopted Folder keeps the preset it has, anything else needs --preset.
export async function initializeMachineFolder(
  folder: string,
  machine: MachineBinding,
  choices: FolderInitChoices,
) {
  const derived = derivePreset(machine);
  const allowed = allowedPresets(machine);
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
        next: "Pass --preset: this handover names a Team but no owner.assignment, so it does not say whether the Machine is assigned to one operator or shared; the Machines resident role passes it from the owner infrastructure.",
      },
    };
  }
  if (!allowed.includes(preset))
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

// entry-update after the handover and the operator are bound: records the
// hosted entry of this Machine (decision F16) at the expected revision through
// the one Folder change transaction; the manual shows it. The Folder must be
// adopted for this Machine; any other state is refused exactly as a refresh.
async function recordMachineEntry(
  folder: string,
  machine: MachineBinding,
  request: Readonly<{ expectedRevision: number; entry: HostedEntry }>,
) {
  const adopted = await adoptedHandoverFolder(folder, machine);
  if (adopted === null)
    return {
      code: 2,
      result: {
        kind: "blocked",
        reason: "folder-not-initialized",
        next: "Run `lazurio machine folder-init` first.",
      },
    };
  const result = await updateEntry(
    folder,
    request.expectedRevision,
    request.entry,
  );
  if (result.kind === "updated")
    return { code: 0, result: { kind: "updated", revision: result.revision } };
  if (result.kind === "unchanged") return { code: 0, result };
  return { code: 2, result };
}

// folder-refresh after the handover and the operator are bound. The adoption
// check refuses another Machine's or unrecognized state by name before the
// update transaction; the planner checks the identity again under its lock.
export async function refreshMachineFolder(
  folder: string,
  machine: MachineBinding,
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
  const result = await refreshFolder(folder, machine);
  return { code: result.kind === "blocked" ? 2 : 0, result };
}

// The refusal names the entry; the operator decides what to do with it.
export function describeFolderAdoption(error: FolderAdoptionError) {
  const next = {
    "foreign-entry":
      "Move this entry out of the Folder; only organizations/, personalspace/, the two legacy launchpad files and what Lazurio generated may be present.",
    "layout-missing":
      "Ask the Machines operator to deliver the standard Folder layout; nothing is created in its place.",
    "personalspace-conflict":
      "An Organization preset never has a Personalspace; move it away yourself, nothing is deleted.",
    "state-unrecognized":
      "Complete a recognized initialization with folder-resume or diagnose the state; nothing is reset.",
    "binding-changed":
      "The Folder was adopted from a different handover; verify the Machine identity with the Machines operator.",
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
