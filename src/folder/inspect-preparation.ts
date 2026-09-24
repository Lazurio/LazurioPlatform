import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "./lock";
import { type OutputPath, outputPaths, stagedName } from "./outputs";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import {
  inspectStateLayout,
  readOwnedOutput,
  readOwnedStateFile,
  readStateJson,
} from "./read-state";
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
  await inspectStateLayout(state, true);
  await exactEntries(transaction, [
    "before.json",
    "preferences.json",
    "instructions.json",
    ...outputPaths.map(stagedName),
    "prepared.json",
  ]);
  const staged: Partial<
    Record<OutputPath, Awaited<ReturnType<typeof readOwnedStateFile>>>
  > = {};
  const stagedContents: Partial<Record<OutputPath, string>> = {};
  for (const path of outputPaths) {
    const file = await readOwnedStateFile(transaction, stagedName(path));
    staged[path] = file;
    stagedContents[path] = file.content;
  }
  const stagedPreferences = await readOwnedStateFile(
    transaction,
    "preferences.json",
  );
  const stagedManifest = await readOwnedStateFile(
    transaction,
    "instructions.json",
  );
  const validated = await validatePreparation(
    await readStateJson(transaction, "before.json"),
    JSON.parse(stagedPreferences.content),
    JSON.parse(stagedManifest.content),
    await readStateJson(transaction, "prepared.json"),
    stagedContents as Readonly<Record<OutputPath, string>>,
  );
  const preferencesFile = await readOwnedStateFile(state, "preferences.json");
  const manifestFile = await readOwnedStateFile(state, "instructions.json");
  const currentPreferences = parseFolderPreferences(
    JSON.parse(preferencesFile.content),
  );
  const currentManifest = parseInstructionManifest(
    JSON.parse(manifestFile.content),
  );
  // By the recorded digest: after a template upgrade this product cannot
  // render the previous bytes again.
  for (const path of outputPaths) {
    const current = await readOwnedOutput(folder, path);
    if (
      createHash("sha256").update(current.content).digest("hex") !==
        validated.previousManifest.outputs[path] ||
      JSON.stringify(current.identity) !==
        JSON.stringify(validated.previousIdentities[path]) ||
      JSON.stringify(staged[path]?.identity) !==
        JSON.stringify(validated.stagedIdentities[path])
    )
      throw new Error("Prepared transaction no longer matches owned state");
  }
  if (
    currentPreferences.profile.os !== executionOs(process.platform) ||
    JSON.stringify(currentPreferences) !==
      JSON.stringify(validated.previousPreferences) ||
    JSON.stringify(currentManifest) !==
      JSON.stringify(validated.previousManifest) ||
    JSON.stringify(preferencesFile.identity) !==
      JSON.stringify(validated.previousPreferencesIdentity) ||
    JSON.stringify(manifestFile.identity) !==
      JSON.stringify(validated.previousManifestIdentity) ||
    JSON.stringify(stagedPreferences.identity) !==
      JSON.stringify(validated.stagedPreferencesIdentity) ||
    JSON.stringify(stagedManifest.identity) !==
      JSON.stringify(validated.stagedManifestIdentity)
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
