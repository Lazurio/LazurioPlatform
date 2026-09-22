import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  handoverDirectories,
  parseHandoverLayout,
  verifyHandoverLayout,
} from "./handover-layout";
import {
  initializationReceipts,
  recordInitializationCreation,
} from "./initialization-receipt";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { previewFolder } from "./preview";
import { readOwnedStateFile, readStateJson } from "./read-state";
import { instructionSource } from "./render";
import {
  parseFolderPreferences,
  parseInstructionManifest,
  stateFields,
} from "./state";

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Explicit forward completion of a recognized fresh initialization only.
// No replacement, deletion, stale-lock reclamation or adoption of an empty Folder.
export async function resumeInitialization(
  folder: string,
  checkpoint: (step: string) => Promise<void> = async () => {},
) {
  const root = await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  return withFolderOperationLock(state, async (assertHeld) => {
    const history = join(state, "history");
    const transaction = join(state, "transaction");
    const archive = join(history, "initialization");
    const pending = await exists(transaction);
    if (pending && (await exists(archive)))
      throw new Error("Occupied initialization archive");
    const journalDirectory = pending ? transaction : archive;
    const directories = [state, journalDirectory];
    if (await exists(history)) directories.push(history);
    for (const directory of directories) {
      if ((await inspectOwnedDirectory(directory)).dev !== root.dev)
        throw new Error("Cross-filesystem initialization recovery");
    }
    const entries = await readdir(state);
    if (
      entries.some(
        (name) =>
          ![
            "preferences.json",
            "instructions.json",
            ".operation-lock",
            "transaction",
            "history",
          ].includes(name),
      )
    )
      throw new Error("Unrecognized initialization state");
    const journalEntries = await readdir(journalDirectory);
    if (
      !journalEntries.includes("before.json") ||
      journalEntries.some(
        (name) =>
          !["before.json", ...Object.values(initializationReceipts)].includes(
            name,
          ),
      )
    )
      throw new Error("Unrecognized initialization journal");
    const rawRecord = await readStateJson(journalDirectory, "before.json");
    const handover =
      typeof rawRecord === "object" &&
      rawRecord !== null &&
      "kind" in rawRecord &&
      rawRecord.kind === "handover-folder-initialization";
    const record = stateFields(rawRecord, [
      "schemaVersion",
      "kind",
      "preferences",
      "manifest",
      ...(handover ? ["layout"] : []),
    ]);
    if (
      handover
        ? record.schemaVersion !== 3
        : record.schemaVersion !== 2 ||
          record.kind !== "fresh-folder-initialization"
    )
      throw new Error("Unsupported initialization journal");
    const handedLayout = handover ? parseHandoverLayout(record.layout) : null;
    if (handedLayout) await verifyHandoverLayout(folder, handedLayout);
    const preferences = parseFolderPreferences(record.preferences);
    const manifest = parseInstructionManifest(record.manifest);
    if (
      preferences.revision !== 1 ||
      preferences.customInstructions !== "" ||
      preferences.profile.os !== executionOs(process.platform)
    )
      throw new Error("Unsupported initialization preferences");
    const preview = await previewFolder(
      instructionSource(preferences),
      null,
      async () => ({ kind: "absent" }),
    );
    if (
      manifest.preferenceRevision !== 1 ||
      manifest.templateRevision !== preview.templateRevision ||
      manifest.output.digest !== preview.desired.digest
    )
      throw new Error("Initialization manifest mismatch");
    const files = [
      [folder, "AGENTS.md", preview.desired.content],
      [state, "preferences.json", JSON.stringify(preferences)],
      [state, "instructions.json", JSON.stringify(manifest)],
    ] as const;
    // A handed-over layout records which work directories existed; an absent
    // personalspace/ under an Organization preset is never created here.
    const layout = handedLayout
      ? handoverDirectories(handedLayout)
      : (["organizations", "personalspace"] as const);
    const verifyFile = async (
      directory: string,
      name: keyof typeof initializationReceipts,
      content: string,
      journal = journalDirectory,
    ) => {
      const observed = await readOwnedStateFile(directory, name);
      const receipt = stateFields(
        JSON.parse(
          (await readOwnedStateFile(journal, initializationReceipts[name]))
            .content,
        ),
        ["dev", "ino"],
      );
      if (
        observed.content !== content ||
        receipt.dev !== observed.identity.dev ||
        receipt.ino !== observed.identity.ino
      )
        throw new Error("Changed or foreign initialization output");
    };
    // Validate every existing output before creating anything. Only an ordered
    // prefix of the initializer is recognized; archived recovery must be complete.
    let missing = false;
    for (const [directory, name, content] of files) {
      if (!(await exists(join(directory, name)))) {
        if (await exists(join(journalDirectory, initializationReceipts[name])))
          throw new Error("Missing recorded initialization output");
        missing = true;
        if (!pending) throw new Error("Incomplete archived initialization");
      } else {
        if (missing)
          throw new Error("Changed or unordered initialization output");
        await verifyFile(directory, name, content);
      }
    }
    for (const name of layout) {
      if (!(await exists(join(folder, name)))) {
        if (handedLayout) throw new Error("Missing handed-over directory");
        missing = true;
        if (!pending) throw new Error("Incomplete archived initialization");
      } else {
        if (missing && !handedLayout)
          throw new Error("Unordered initialization layout");
        await inspectOwnedDirectory(join(folder, name));
      }
    }
    for (const [directory, name, content] of files) {
      await assertHeld();
      if (handedLayout) await verifyHandoverLayout(folder, handedLayout);
      if (!(await exists(join(directory, name)))) {
        const file = await open(join(directory, name), "wx", 0o600);
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
          const stat = await file.stat();
          await recordInitializationCreation(journalDirectory, name, {
            dev: String(stat.dev),
            ino: String(stat.ino),
          });
        } finally {
          await file.close();
        }
      }
      await verifyFile(directory, name, content);
      await checkpoint(name);
    }
    for (const name of layout) {
      await assertHeld();
      if (!(await exists(join(folder, name))))
        await mkdir(join(folder, name), { mode: 0o700 });
      await inspectOwnedDirectory(join(folder, name));
    }
    for (const [directory, name, content] of files)
      await verifyFile(directory, name, content);
    if (pending) {
      await assertHeld();
      if (!(await exists(history))) await mkdir(history, { mode: 0o700 });
      if (
        (await inspectOwnedDirectory(history)).dev !== root.dev ||
        (await exists(archive))
      )
        throw new Error("Unsafe initialization archive");
      await rename(transaction, archive);
      await checkpoint("archived");
    }
    for (const directory of [
      archive,
      history,
      state,
      ...layout.map((name) => join(folder, name)),
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
    if (handedLayout) await verifyHandoverLayout(folder, handedLayout);
    for (const [directory, name, content] of files)
      await verifyFile(directory, name, content, archive);
    return { kind: "recovered" as const, revision: 1 };
  });
}
