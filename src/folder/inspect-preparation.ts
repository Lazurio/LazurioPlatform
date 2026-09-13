import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readOwnedStateFile, readStateJson } from "./read-state";
import { renderInstructions } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";
import { validatePreparation } from "./validate-preparation";

// Pre-activation inspection only. This rejects partial/changed/previously activated
// transactions; forward recovery is a distinct consumer. No activation authority.
export async function inspectPreparation(folder: string) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(
    join(folder, ".lazurio"),
    async (assertHeld) => {
      const result = await readPreparedChange(folder);
      await assertHeld();
      return result;
    },
  );
}

// Internal adapter entry for a future writer already holding the same lock.
// The caller must retain that lock and recheck state immediately before mutation.
export async function readPreparedChange(folder: string) {
  const root = await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  const stateRoot = await inspectOwnedDirectory(state);
  const transaction = join(state, "transaction");
  const stagedRoot = await inspectOwnedDirectory(transaction);
  if (root.dev !== stateRoot.dev || root.dev !== stagedRoot.dev)
    throw new Error("Cross-filesystem transaction is unsupported");
  await exactEntries(state, [
    "preferences.json",
    "instructions.json",
    ".operation-lock",
    "transaction",
  ]);
  await exactEntries(transaction, [
    "before.json",
    "preferences.json",
    "instructions.json",
    "AGENTS.md",
    "prepared.json",
  ]);
  const staged = await readOwnedStateFile(transaction, "AGENTS.md");
  const validated = await validatePreparation(
    await readStateJson(transaction, "before.json"),
    await readStateJson(transaction, "preferences.json"),
    await readStateJson(transaction, "instructions.json"),
    await readStateJson(transaction, "prepared.json"),
    staged.content,
  );
  const currentPreferences = parseFolderPreferences(
    await readStateJson(state, "preferences.json"),
  );
  const currentManifest = parseInstructionManifest(
    await readStateJson(state, "instructions.json"),
  );
  const current = await readOwnedStateFile(folder, "AGENTS.md");
  if (
    currentPreferences.profile.os !== executionOs(process.platform) ||
    JSON.stringify(currentPreferences) !==
      JSON.stringify(validated.previousPreferences) ||
    JSON.stringify(currentManifest) !==
      JSON.stringify(validated.previousManifest) ||
    current.content !==
      renderInstructions(validated.previousPreferences.profile) ||
    JSON.stringify(current.identity) !==
      JSON.stringify(validated.previousIdentity) ||
    JSON.stringify(staged.identity) !== JSON.stringify(validated.stagedIdentity)
  )
    throw new Error("Prepared transaction no longer matches owned state");
  return validated;
}

async function exactEntries(directory: string, names: readonly string[]) {
  const entries = await readdir(directory);
  if (
    entries.length !== names.length ||
    entries.some((name) => !names.includes(name))
  )
    throw new Error("Incomplete or unrecognized transaction state");
}
