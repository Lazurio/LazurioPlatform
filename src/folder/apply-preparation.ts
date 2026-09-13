import { constants } from "node:fs";
import { open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readOwnedStateFile, readStateJson } from "./read-state";
import { renderInstructions } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";
import { validatePreparation } from "./validate-preparation";

const names = ["AGENTS.md", "preferences.json", "instructions.json"] as const;
type OutputName = (typeof names)[number];
export type ApplicationStep = OutputName | `renamed:${OutputName}`;

// Development-only existing-file activation. The journal remains pending even
// after all replacements; retirement and stale-lock recovery are separate gates.
// Requires a cooperative, stable owner filesystem, not hostile same-user writers.
export async function applyPreparation(
  folder: string,
  checkpoint: (step: ApplicationStep) => Promise<void> = async () => {},
) {
  await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  const transaction = join(state, "transaction");
  return withFolderOperationLock(state, async (assertHeld) => {
    for (const name of names) {
      const current = await inspectProgress(folder);
      if (current.applied.includes(name)) {
        await assertHeld();
        await syncDirectory(name === "AGENTS.md" ? folder : state);
        await syncDirectory(transaction);
        continue;
      }
      await assertHeld();
      await rename(
        join(transaction, name),
        join(name === "AGENTS.md" ? folder : state, name),
      );
      await checkpoint(`renamed:${name}`);
      await syncDirectory(name === "AGENTS.md" ? folder : state);
      await syncDirectory(transaction);
      await checkpoint(name);
    }
    // Resume may observe a rename whose directory sync previously failed.
    await syncDirectory(folder);
    await syncDirectory(state);
    await syncDirectory(transaction);
    const verified = await inspectProgress(folder);
    await assertHeld();
    return {
      kind: "applied-journal-retained" as const,
      revision: verified.revision,
    };
  });
}

// Caller holds the common lock. Only a prefix of the fixed replacement order is
// accepted; each consumed stage must be the recorded inode now at its destination.
async function inspectProgress(folder: string) {
  const state = join(folder, ".lazurio");
  const transaction = join(state, "transaction");
  const root = await inspectOwnedDirectory(folder);
  const metadata = await inspectOwnedDirectory(state);
  const stage = await inspectOwnedDirectory(transaction);
  if (root.dev !== metadata.dev || root.dev !== stage.dev)
    throw new Error("Cross-filesystem transaction is unsupported");
  const entries = await readdir(state);
  const expected = [
    "preferences.json",
    "instructions.json",
    ".operation-lock",
    "transaction",
  ];
  if (
    entries.length !== expected.length ||
    entries.some((n) => !expected.includes(n))
  )
    throw new Error("Unrecognized Folder state");
  const stagedEntries = await readdir(transaction);
  if (
    !stagedEntries.includes("before.json") ||
    !stagedEntries.includes("prepared.json") ||
    stagedEntries.some(
      (n) => ![...names, "before.json", "prepared.json"].includes(n),
    )
  )
    throw new Error("Incomplete or unrecognized transaction");
  const marker = await readStateJson(transaction, "prepared.json");
  const preferences = parseFolderPreferences(marker.preferences);
  const validated = await validatePreparation(
    await readStateJson(transaction, "before.json"),
    preferences,
    marker.manifest,
    marker,
    renderInstructions(preferences.profile),
  );
  if (preferences.profile.os !== executionOs(process.platform))
    throw new Error("Transaction execution OS mismatch");
  const before = [
    renderInstructions(validated.previousPreferences.profile),
    JSON.stringify(validated.previousPreferences),
    JSON.stringify(validated.previousManifest),
  ];
  const after = [
    validated.plan.desired.content,
    JSON.stringify(validated.plan.preferences),
    JSON.stringify(validated.plan.manifest),
  ];
  const previousIdentities = [
    validated.previousIdentity,
    validated.previousPreferencesIdentity,
    validated.previousManifestIdentity,
  ];
  const nextIdentities = [
    validated.stagedIdentity,
    validated.stagedPreferencesIdentity,
    validated.stagedManifestIdentity,
  ];
  const applied: OutputName[] = [];
  let pending = false;
  for (const [index, name] of names.entries()) {
    const active = await readOwnedStateFile(
      name === "AGENTS.md" ? folder : state,
      name,
    );
    const staged = stagedEntries.includes(name)
      ? await readOwnedStateFile(transaction, name)
      : null;
    const expectedIdentity = staged
      ? previousIdentities[index]
      : nextIdentities[index];
    if (
      JSON.stringify(active.identity) !== JSON.stringify(expectedIdentity) ||
      normalize(name, active.content) !==
        (staged ? before[index] : after[index])
    )
      throw new Error("Transaction conflicts with active state");
    if (staged) {
      pending = true;
      if (
        JSON.stringify(staged.identity) !==
          JSON.stringify(nextIdentities[index]) ||
        normalize(name, staged.content) !== after[index]
      )
        throw new Error("Transaction conflicts with staged state");
    } else {
      if (pending)
        throw new Error("Unrecognized transaction replacement order");
      applied.push(name);
    }
  }
  return { applied, revision: preferences.revision };
}

function normalize(name: OutputName, content: string) {
  if (name === "AGENTS.md") return content;
  return JSON.stringify(
    name === "preferences.json"
      ? parseFolderPreferences(JSON.parse(content))
      : parseInstructionManifest(JSON.parse(content)),
  );
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
