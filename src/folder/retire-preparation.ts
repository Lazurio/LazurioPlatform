import { constants } from "node:fs";
import { mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { planProfileChange } from "./change-profile";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import {
  inspectStateLayout,
  readOwnedStateFile,
  readStateJson,
} from "./read-state";
import { instructionSource, renderInstructions } from "./render";
import {
  parseFolderPreferences,
  parseInstructionManifest,
  stateFields,
} from "./state";

// Explicitly abandon a recognized pre-activation attempt, retaining every file.
// recoveryId is a caller-retained retry token, not authority or a state locator.
// Empty/unreadable before snapshots and any prepared marker require other repair.
export async function retireIncompletePreparation(
  folder: string,
  expectedRevision: number,
  recoveryId: string,
  checkpoint: () => Promise<void> = async () => {},
) {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    !/^[0-9a-f]{32}$/.test(recoveryId)
  )
    throw new Error("Invalid recovery request");
  await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  const history = join(state, "history");
  const archive = join(history, `incomplete-${recoveryId}`);
  return withFolderOperationLock(state, async (assertHeld) => {
    const entries = await readdir(state);
    const pending = entries.includes("transaction");
    await inspectStateLayout(state, pending);
    const source = pending ? join(state, "transaction") : archive;
    const validate = async (directory = source) => {
      const folderRoot = await inspectOwnedDirectory(folder);
      const root = await inspectOwnedDirectory(state);
      const stage = await inspectOwnedDirectory(directory);
      if (root.dev !== stage.dev || root.dev !== folderRoot.dev)
        throw new Error("Cross-filesystem recovery is unsupported");
      const files = await readdir(directory);
      const sequence = [
        "before.json",
        "preferences.json",
        "instructions.json",
        "AGENTS.md",
      ] as const;
      if (
        !files.length ||
        files.length > sequence.length ||
        sequence.slice(0, files.length).some((name) => !files.includes(name))
      )
        throw new Error("Unrecognized incomplete preparation");
      for (const name of sequence.slice(0, files.length))
        await readOwnedStateFile(directory, name);
      const before = stateFields(
        await readStateJson(directory, "before.json"),
        [
          "schemaVersion",
          "preferences",
          "manifest",
          "outputIdentity",
          "preferencesIdentity",
          "manifestIdentity",
        ],
      );
      if (before.schemaVersion !== 2)
        throw new Error("Unsupported transaction schema");
      const preferences = parseFolderPreferences(before.preferences);
      const manifest = parseInstructionManifest(before.manifest);
      if (
        preferences.revision !== expectedRevision ||
        preferences.profile.os !== executionOs(process.platform)
      )
        throw new Error("Recovery revision or OS mismatch");
      const active = await readOwnedStateFile(folder, "AGENTS.md");
      const prefs = await readOwnedStateFile(state, "preferences.json");
      const owned = await readOwnedStateFile(state, "instructions.json");
      const pairs = [
        [active, before.outputIdentity],
        [prefs, before.preferencesIdentity],
        [owned, before.manifestIdentity],
      ] as const;
      for (const [file, recorded] of pairs) {
        const identity = stateFields(recorded, ["dev", "ino"]);
        if (
          identity.dev !== file.identity.dev ||
          identity.ino !== file.identity.ino
        )
          throw new Error("Recovery conflicts with active identity");
      }
      if (
        active.content !== renderInstructions(instructionSource(preferences)) ||
        JSON.stringify(parseFolderPreferences(JSON.parse(prefs.content))) !==
          JSON.stringify(preferences) ||
        JSON.stringify(parseInstructionManifest(JSON.parse(owned.content))) !==
          JSON.stringify(manifest)
      )
        throw new Error("Recovery conflicts with active content");
      const coherent = await planProfileChange(
        preferences,
        manifest,
        expectedRevision,
        { preset: preferences.preset.name, profile: preferences.profile },
        async () => ({ kind: "regular", digest: manifest.output.digest }),
      );
      if (coherent.kind !== "unchanged")
        throw new Error("Recovery requires coherent original state");
    };
    await validate();
    if (pending) {
      if (!entries.includes("history")) await mkdir(history, { mode: 0o700 });
      await inspectStateLayout(state, true);
      if ((await readdir(history)).includes(`incomplete-${recoveryId}`))
        throw new Error("Recovery archive already exists");
      await validate();
      await assertHeld();
      await rename(source, archive);
      await checkpoint();
    }
    for (const directory of [history, state]) {
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
    await validate(archive);
    await assertHeld();
    return {
      kind: "incomplete-preparation-retained" as const,
      recoveryId,
      revision: expectedRevision,
    };
  });
}
