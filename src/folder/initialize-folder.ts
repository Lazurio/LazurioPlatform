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
  recordInitializationCreation,
} from "./initialization-receipt";
import { withFolderOperationLock } from "./lock";
import type { MachineBinding } from "./machine-binding";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { type PresetName, presetReference, workspacePreset } from "./presets";
import { previewFolder } from "./preview";
import { readFolderState, readOwnedStateFile } from "./read-state";
import { instructionSource } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

export type InitializationStep =
  | "folder"
  | "journal"
  | "instructions"
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
  const preview = await previewFolder(
    instructionSource(preferences),
    null,
    async () => ({ kind: "absent" }),
  );
  if (preferences.profile.os !== executionOs(process.platform))
    throw new Error("Initialization OS mismatch");
  const manifest = parseInstructionManifest({
    schemaVersion: 1,
    preferenceRevision: 1,
    templateRevision: preview.templateRevision,
    output: { path: "AGENTS.md", digest: preview.desired.digest },
  });
  const state = join(folder, ".lazurio");
  const personalspace = workspacePreset(preferences.preset.name).personalspace;
  if (handover) {
    const adopted = await alreadyAdopted(folder, preferences.machine);
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
    const expected = [
      [transaction, "before.json", journal],
      [folder, "AGENTS.md", preview.desired.content],
      [state, "preferences.json", JSON.stringify(preferences)],
      [state, "instructions.json", JSON.stringify(manifest)],
    ] as const;
    const steps = [
      "journal",
      "instructions",
      "preferences",
      "manifest",
    ] as const;
    const identities = [];
    for (const [index, [directory, name, content]] of expected.entries()) {
      await assertHeld();
      const file = await open(join(directory, name), "wx", 0o600);
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
        const stat = await file.stat();
        identities.push({ dev: String(stat.dev), ino: String(stat.ino) });
      } finally {
        await file.close();
      }
      if (name !== "before.json") {
        const identity = identities[index];
        if (!identity) throw new Error("Missing creation identity");
        await recordInitializationCreation(transaction, name, identity);
      }
      const step = steps[index];
      if (!step) throw new Error("Unknown initialization step");
      await checkpoint(step);
    }
    if (!layout)
      for (const name of ["organizations", "personalspace"])
        await mkdir(join(folder, name), { mode: 0o700 });
    await checkpoint("layout");
    for (const name of directories)
      await inspectOwnedDirectory(join(folder, name));
    if (layout) await verifyHandoverLayout(folder, layout);
    const transactionEntries = await readdir(transaction);
    if (
      transactionEntries.length !== 4 ||
      transactionEntries.some(
        (name) =>
          !["before.json", ...Object.values(initializationReceipts)].includes(
            name,
          ),
      )
    )
      throw new Error("Unrecognized initialization journal");
    for (const [index, [directory, name, content]] of expected.entries()) {
      const observed = await readOwnedStateFile(directory, name);
      if (
        observed.content !== content ||
        JSON.stringify(observed.identity) !== JSON.stringify(identities[index])
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
      folder,
      dirname(folder),
    ]) {
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
    await assertHeld();
    if (layout) await verifyHandoverLayout(folder, layout);
    return {
      kind: "initialized" as const,
      revision: 1,
      preset: preferences.preset,
    };
  });
}

// Idempotent re-run: valid state recorded from the same handover reports the
// adopted Folder; a different handover or unrecognized state is refused by name.
// Only the ephemeral operation lock is written.
async function alreadyAdopted(folder: string, machine: MachineBinding | null) {
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
  if (JSON.stringify(current.preferences.machine) !== JSON.stringify(machine))
    throw new FolderAdoptionError("binding-changed", ".lazurio");
  return {
    kind: "already-adopted" as const,
    revision: current.preferences.revision,
    preset: current.preferences.preset,
  };
}
