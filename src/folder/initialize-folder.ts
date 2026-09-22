import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  FolderAdoptionError,
  handoverDirectories,
  inspectHandoverLayout,
  requireAdoptableLayout,
  verifyHandoverLayout,
} from "./handover-layout";
import {
  initializationReceipts,
  manualDirectoryReceipt,
  recordInitializationCreation,
} from "./initialization-receipt";
import { withFolderOperationLock } from "./lock";
import type { MachineBinding } from "./machine-binding";
import {
  createManualDirectory,
  verifyManualDirectory,
} from "./manual-directory";
import { type OutputPath, outputFile, outputPaths } from "./outputs";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { type PresetName, presetReference, workspacePreset } from "./presets";
import { desiredOutputs, outputDigests } from "./preview";
import { readFolderState, readOwnedStateFile } from "./read-state";
import { instructionSource, instructionTemplateRevision } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

export type InitializationStep =
  | "folder"
  | "journal"
  | "manual-directory"
  | "instructions"
  | "manual"
  | "preferences"
  | "manifest"
  | "layout";

// What a hosted initialization records: the preset chosen against the handover
// and the immutable binding projected from it. A workstation has neither.
export type HandoverSource = Readonly<{
  preset: PresetName;
  machine: MachineBinding;
  profile: unknown;
}>;

// Fresh-path development initialization only. Never adopts an existing directory.
// Failed attempts remain in place; no implicit retry, recursive cleanup or migration.
export async function initializeFolder(
  folder: string,
  profile: unknown,
  checkpoint: (step: InitializationStep) => Promise<void> = async () => {},
) {
  return initialize(
    folder,
    { preset: presetReference("local", null), machine: null, profile },
    checkpoint,
    false,
  );
}

// Adopts the operator-owned Folder delivered by Machines: organizations/ and
// personalspace/ may already hold work and are never entered; the two legacy
// launchpad files are tolerated by name; anything else fails closed by name.
// An already adopted Folder is reported as such and left unchanged.
export async function initializeHandoverFolder(
  folder: string,
  source: HandoverSource,
  checkpoint: (step: InitializationStep) => Promise<void> = async () => {},
) {
  return initialize(
    folder,
    {
      preset: presetReference(source.preset, source.machine),
      machine: source.machine,
      profile: source.profile,
    },
    checkpoint,
    true,
  );
}

// The generated outputs in creation order, then the two state files. The
// manual follows AGENTS.md; the last manual file carries the `manual` step.
type Planned = Readonly<{
  directory: string;
  name: string;
  content: string;
  receipt: keyof typeof initializationReceipts;
  step: InitializationStep | null;
}>;

async function initialize(
  folder: string,
  source: Readonly<{
    preset: unknown;
    machine: MachineBinding | null;
    profile: unknown;
  }>,
  checkpoint: (step: InitializationStep) => Promise<void>,
  handover: boolean,
) {
  if (!isAbsolute(folder) || resolve(folder) !== folder)
    throw new Error("Canonical new Folder path required");
  await inspectOwnedDirectory(dirname(folder));
  const preferences = parseFolderPreferences({
    schemaVersion: 2,
    revision: 1,
    preset: source.preset,
    machine: source.machine,
    profile: source.profile,
    customInstructions: "",
  });
  const desired = desiredOutputs(instructionSource(preferences));
  if (preferences.profile.os !== executionOs(process.platform))
    throw new Error("Initialization OS mismatch");
  const manifest = parseInstructionManifest({
    schemaVersion: 2,
    preferenceRevision: 1,
    templateRevision: instructionTemplateRevision,
    outputs: outputDigests(desired),
  });
  const state = join(folder, ".lazurio");
  const manual = join(folder, "manual");
  const personalspace = workspacePreset(preferences.preset.name).personalspace;
  if (handover) {
    const adopted = await adoptedHandoverFolder(folder, preferences.machine);
    if (adopted) return adopted;
  }
  const layout = handover ? await inspectHandoverLayout(folder) : null;
  if (layout) await requireAdoptableLayout(folder, personalspace);
  else await mkdir(folder, { mode: 0o700 }); // Exclusive fresh-path initialization.
  await checkpoint("folder");
  await mkdir(state, { mode: 0o700 });
  const directories = layout
    ? handoverDirectories(layout)
    : (["organizations", "personalspace"] as const);
  return withFolderOperationLock(state, async (assertHeld) => {
    if (layout) {
      await verifyHandoverLayout(folder, layout);
      await requireAdoptableLayout(folder, personalspace, true);
    }
    const transaction = join(state, "transaction");
    await mkdir(transaction, { mode: 0o700 });
    const journal = JSON.stringify({
      schemaVersion: layout ? 3 : 2,
      kind: layout
        ? "handover-folder-initialization"
        : "fresh-folder-initialization",
      preferences,
      manifest,
      ...(layout ? { layout } : {}),
    });
    const lastManual = outputPaths[outputPaths.length - 1];
    const planned: Planned[] = [
      ...outputPaths.map((path: OutputPath) => ({
        ...outputFile(folder, path),
        content: desired[path].content,
        receipt: path,
        step:
          path === "AGENTS.md"
            ? ("instructions" as const)
            : path === lastManual
              ? ("manual" as const)
              : null,
      })),
      {
        directory: state,
        name: "preferences.json",
        content: JSON.stringify(preferences),
        receipt: "preferences.json",
        step: "preferences",
      },
      {
        directory: state,
        name: "instructions.json",
        content: JSON.stringify(manifest),
        receipt: "instructions.json",
        step: "manifest",
      },
    ];
    await assertHeld();
    const journalIdentity = await createFile(
      join(transaction, "before.json"),
      journal,
    );
    await checkpoint("journal");
    // The owned manual directory is created exclusively, sealed with a nonce
    // marker and receipted before any output is written: on recovery only the
    // recorded directory is ours; any other is foreign and refused by name.
    const identities: Record<string, { dev: string; ino: string }> = {
      [manualDirectoryReceipt]: await createManualDirectory(
        folder,
        transaction,
      ),
    };
    await checkpoint("manual-directory");
    for (const file of planned) {
      await assertHeld();
      const identity = await createFile(
        join(file.directory, file.name),
        file.content,
      );
      identities[file.receipt] = identity;
      await recordInitializationCreation(transaction, file.receipt, identity);
      if (file.step) await checkpoint(file.step);
    }
    if (!layout)
      for (const name of ["organizations", "personalspace"])
        await mkdir(join(folder, name), { mode: 0o700 });
    await checkpoint("layout");
    for (const name of directories)
      await inspectOwnedDirectory(join(folder, name));
    await verifyManualDirectory(folder, transaction);
    if (layout) await verifyHandoverLayout(folder, layout);
    const transactionEntries = await readdir(transaction);
    const receipts = Object.values(initializationReceipts);
    if (
      transactionEntries.length !== receipts.length + 1 ||
      transactionEntries.some(
        (name) => !["before.json", ...receipts].includes(name),
      )
    )
      throw new Error("Unrecognized initialization journal");
    const observedJournal = await readOwnedStateFile(
      transaction,
      "before.json",
    );
    if (
      observedJournal.content !== journal ||
      JSON.stringify(observedJournal.identity) !==
        JSON.stringify(journalIdentity)
    )
      throw new Error("Initialization files changed");
    for (const file of planned) {
      const observed = await readOwnedStateFile(file.directory, file.name);
      if (
        observed.content !== file.content ||
        JSON.stringify(observed.identity) !==
          JSON.stringify(identities[file.receipt])
      )
        throw new Error("Initialization files changed");
    }
    const entries = await readdir(state);
    if (
      entries.length !== 4 ||
      entries.some(
        (n) =>
          ![
            "transaction",
            "preferences.json",
            "instructions.json",
            ".operation-lock",
          ].includes(n),
      )
    )
      throw new Error("Unrecognized initialization state");
    const history = join(state, "history");
    await mkdir(history, { mode: 0o700 });
    await assertHeld();
    await rename(transaction, join(history, "initialization"));
    for (const directory of [
      join(history, "initialization"),
      history,
      state,
      manual,
      folder,
      dirname(folder),
    ])
      await syncDirectory(directory);
    await assertHeld();
    if (layout) await verifyHandoverLayout(folder, layout);
    return {
      kind: "initialized" as const,
      revision: 1,
      preset: preferences.preset,
    };
  });
}

// Exclusive creation with the bytes made durable; returns the file identity
// the journal receipt records.
async function createFile(path: string, content: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
    const stat = await file.stat();
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } finally {
    await file.close();
  }
}

async function syncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// The part of a binding that names the Machine: kind, name, Owner (Organization
// and Team, or Principal), tailnet node and host. Machines rewrites the handover
// on every apply (`installed`, and since v0.12.61 the declared assignment and the
// derived relationships), so the document digest is not identity; a re-apply of
// the same Machine must not turn an adopted Folder into a blocked one.
export function machineIdentity(machine: MachineBinding | null) {
  if (machine === null) return null;
  const { assignment: _, ...owner } = machine.owner as MachineBinding["owner"] &
    Readonly<{ assignment?: unknown }>;
  return {
    kind: machine.kind,
    name: machine.name,
    owner,
    network: machine.network,
    host: machine.host,
  };
}

// Idempotent re-run: valid state recorded for the same Machine reports the
// adopted Folder (with the preset and the binding it already has); another
// Machine's handover or unrecognized state is refused by name. Only the
// ephemeral operation lock is written. `null` means no Folder state exists yet.
export async function adoptedHandoverFolder(
  folder: string,
  machine: MachineBinding | null,
) {
  const state = join(folder, ".lazurio");
  try {
    await lstat(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let current: Awaited<ReturnType<typeof readFolderState>>;
  try {
    await inspectOwnedDirectory(state);
    current = await withFolderOperationLock(state, () =>
      readFolderState(state),
    );
  } catch (error) {
    if (error instanceof Error && /busy/.test(error.message)) throw error;
    throw new FolderAdoptionError("state-unrecognized", ".lazurio");
  }
  if (
    JSON.stringify(machineIdentity(current.preferences.machine)) !==
    JSON.stringify(machineIdentity(machine))
  )
    throw new FolderAdoptionError("binding-changed", ".lazurio");
  return {
    kind: "already-adopted" as const,
    revision: current.preferences.revision,
    preset: current.preferences.preset,
  };
}
