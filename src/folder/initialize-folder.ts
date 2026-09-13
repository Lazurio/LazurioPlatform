import { constants } from "node:fs";
import { mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  initializationReceipts,
  recordInitializationCreation,
} from "./initialization-receipt";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { previewFolder } from "./preview";
import { readOwnedStateFile } from "./read-state";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

export type InitializationStep =
  | "folder"
  | "journal"
  | "instructions"
  | "preferences"
  | "manifest"
  | "layout";

// Fresh-path development initialization only. Never adopts an existing directory.
// Failed attempts remain in place; no implicit retry, recursive cleanup or migration.
export async function initializeFolder(
  folder: string,
  profile: unknown,
  checkpoint: (step: InitializationStep) => Promise<void> = async () => {},
) {
  if (!isAbsolute(folder) || resolve(folder) !== folder)
    throw new Error("Canonical new Folder path required");
  await inspectOwnedDirectory(dirname(folder));
  const preferences = parseFolderPreferences({
    schemaVersion: 1,
    revision: 1,
    profile,
    customInstructions: "",
  });
  const preview = await previewFolder(preferences.profile, null, async () => ({
    kind: "absent",
  }));
  if (preferences.profile.os !== executionOs(process.platform))
    throw new Error("Initialization OS mismatch");
  const manifest = parseInstructionManifest({
    schemaVersion: 1,
    preferenceRevision: 1,
    templateRevision: preview.templateRevision,
    output: { path: "AGENTS.md", digest: preview.desired.digest },
  });
  await mkdir(folder, { mode: 0o700 }); // Exclusive, including empty existing directories.
  await checkpoint("folder");
  const state = join(folder, ".lazurio");
  await mkdir(state, { mode: 0o700 });
  return withFolderOperationLock(state, async (assertHeld) => {
    const transaction = join(state, "transaction");
    await mkdir(transaction, { mode: 0o700 });
    const journal = JSON.stringify({
      schemaVersion: 2,
      kind: "fresh-folder-initialization",
      preferences,
      manifest,
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
    for (const name of ["organizations", "personalspace"])
      await mkdir(join(folder, name), { mode: 0o700 });
    await checkpoint("layout");
    for (const name of ["organizations", "personalspace"])
      await inspectOwnedDirectory(join(folder, name));
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
    return { kind: "initialized" as const, revision: 1 };
  });
}
