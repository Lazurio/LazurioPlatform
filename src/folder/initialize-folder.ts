import { constants } from "node:fs";
import { mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  inspectHandoverLayout,
  requireEmptyHandoverLayout,
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
import { type PresetName, presetReference } from "./presets";
import { previewFolder } from "./preview";
import { readOwnedStateFile } from "./read-state";
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

// Only the empty, operator-owned layout prepared by Machines; not resident adoption.
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
  const layout = handover ? await inspectHandoverLayout(folder) : null;
  if (layout) await requireEmptyHandoverLayout(folder);
  else await mkdir(folder, { mode: 0o700 }); // Exclusive fresh-path initialization.
  await checkpoint("folder");
  const state = join(folder, ".lazurio");
  await mkdir(state, { mode: 0o700 });
  return withFolderOperationLock(state, async (assertHeld) => {
    if (layout) {
      await verifyHandoverLayout(folder, layout);
      await requireEmptyHandoverLayout(folder, true);
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
    for (const name of ["organizations", "personalspace"])
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
