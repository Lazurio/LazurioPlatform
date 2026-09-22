import { parseArgs } from "node:util";
import { FolderAdoptionError } from "../folder/handover-layout";
import { initializeHandoverFolder } from "../folder/initialize-folder";
import {
  allowedPresets,
  derivePreset,
  parsePresetName,
  presetProfile,
} from "../folder/presets";
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
workspace-vm with owner.team -> hosted-organization-team; without ->
hosted-organization-personal). --preset may pick another preset the handover
allows and is recorded as an explicit choice. Omitted communication choices
take the preset's defaults; all are changeable later in the Launchpad.
Adopts the existing Folder: organizations/ and personalspace/ may hold work
and are never entered; launchpad.gen3.json and launchpad.gen3.local.json are
tolerated; any other top-level entry is refused by name. Re-running on an
adopted Folder reports already-adopted and changes nothing.
Run as the declared operator, never root. No path or custody override.
No Organization checkout, gateway change, resident removal or migration.
An interrupted recognized journal can be completed using folder-resume;
missing/damaged journals require operator diagnosis, never blanket cleanup.`;

const choices = {
  locale: ["cs", "en"],
  detail: ["concise", "technical"],
  coordination: ["direct", "coordinator"],
} as const;

export async function runMachineCommand(args: string[]) {
  const [command, ...options] = args;
  if (command !== "inspect" && command !== "folder-init")
    throw new Error("Unknown Machine command");
  const { values, tokens } = parseArgs({
    args: options,
    strict: true,
    tokens: true,
    options: {
      preset: { type: "string" },
      locale: { type: "string" },
      detail: { type: "string" },
      coordination: { type: "string" },
    },
  });
  if (
    (command === "inspect" && tokens.length !== 0) ||
    tokens.some((token) => token.kind !== "option") ||
    new Set(tokens.map((token) => (token.kind === "option" ? token.name : "")))
      .size !== tokens.length
  )
    throw new Error("Explicit nonduplicate Machine options required");
  for (const [name, allowed] of Object.entries(choices)) {
    const value = values[name as keyof typeof choices];
    if (value !== undefined && !(allowed as readonly string[]).includes(value))
      throw new Error(`Invalid Machine choice: ${name}`);
  }
  const requestedPreset =
    values.preset === undefined ? undefined : parsePresetName(values.preset);
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
    const preset = requestedPreset ?? derivePreset(machine);
    if (!allowedPresets(machine).includes(preset))
      return {
        code: 2,
        result: {
          kind: "blocked",
          reason: "preset-not-allowed",
          derived: derivePreset(machine),
          allowed: allowedPresets(machine),
          next: "Choose a preset the handover allows, or omit --preset for the derived one.",
        },
      };
    const profile = presetProfile(preset, "linux", {
      ...(values.locale === undefined
        ? {}
        : { locale: values.locale as "cs" | "en" }),
      ...(values.detail === undefined
        ? {}
        : { detail: values.detail as "concise" | "technical" }),
      ...(values.coordination === undefined
        ? {}
        : { coordination: values.coordination as "direct" | "coordinator" }),
    });
    const folder = bindMachineOperator(
      observed.context,
      await readLinuxOperator(),
    );
    const result = await initializeHandoverFolder(folder, {
      preset,
      machine,
      profile,
    });
    return {
      code: 0,
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

// The refusal names the entry; the operator decides what to do with it.
export function describeFolderAdoption(error: FolderAdoptionError) {
  const next = {
    "foreign-entry":
      "Move this entry out of the Folder; only organizations/, personalspace/ and the two legacy launchpad files may be present.",
    "layout-missing":
      "Ask the Machines operator to deliver the standard Folder layout; nothing is created in its place.",
    "personalspace-conflict":
      "An Organization preset never has a Personalspace; move it away yourself, nothing is deleted.",
    "state-unrecognized":
      "Complete a recognized initialization with folder-resume or diagnose the state; nothing is reset.",
    "binding-changed":
      "The Folder was adopted from a different handover; verify the Machine identity with the Machines operator.",
  } as const;
  return {
    kind: "blocked" as const,
    reason: `folder-${error.code}` as const,
    entry: error.entry,
    next: next[error.code],
  };
}
