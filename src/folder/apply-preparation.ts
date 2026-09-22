import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "./lock";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import {
  inspectStateLayout,
  readOwnedStateFile,
  readStateJson,
} from "./read-state";
import { instructionSource, renderInstructions } from "./render";
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
  return withFolderOperationLock(join(folder, ".lazurio"), (assertHeld) =>
    applyPreparationLocked(folder, assertHeld, checkpoint),
  );
}

// Internal entry for a caller retaining the same operation lock.
export async function applyPreparationLocked(
  folder: string,
  assertHeld: () => Promise<void>,
  checkpoint: (step: ApplicationStep) => Promise<void> = async () => {},
) {
  await assertHeld();
  const state = join(folder, ".lazurio");
  const transaction = join(state, "transaction");
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
}

// Caller holds the common lock. Only a prefix of the fixed replacement order is
// accepted; each consumed stage must be the recorded inode now at its destination.
async function inspectProgress(folder: string, archivedRevision?: number) {
  const state = join(folder, ".lazurio");
  const transaction =
    archivedRevision === undefined
      ? join(state, "transaction")
      : join(state, "history", `revision-${archivedRevision}`);
  const root = await inspectOwnedDirectory(folder);
  const metadata = await inspectOwnedDirectory(state);
  const stage = await inspectOwnedDirectory(transaction);
  if (root.dev !== metadata.dev || root.dev !== stage.dev)
    throw new Error("Cross-filesystem transaction is unsupported");
  await inspectStateLayout(state, archivedRevision === undefined);
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
    renderInstructions(instructionSource(preferences)),
  );
  if (preferences.profile.os !== executionOs(process.platform))
    throw new Error("Transaction execution OS mismatch");
  const before = [
    renderInstructions(instructionSource(validated.previousPreferences)),
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

// Explicit close operation: preserve the verified journal by moving it to a
// revision-keyed archive. Never delete or overwrite an existing history entry.
export async function finalizePreparation(
  folder: string,
  revision: number,
  checkpoint: (step: "history" | "archived") => Promise<void> = async () => {},
) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(join(folder, ".lazurio"), (assertHeld) =>
    finalizePreparationLocked(folder, revision, assertHeld, checkpoint),
  );
}

// Internal entry for a caller retaining the same operation lock.
export async function finalizePreparationLocked(
  folder: string,
  revision: number,
  assertHeld: () => Promise<void>,
  checkpoint: (step: "history" | "archived") => Promise<void> = async () => {},
) {
  await assertHeld();
  if (!Number.isSafeInteger(revision) || revision < 2)
    throw new Error("Invalid finalized revision");
  await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  const history = join(state, "history");
  const transaction = join(state, "transaction");
  const archive = join(history, `revision-${revision}`);
  const pending = await exists(transaction);
  const verified = await inspectProgress(
    folder,
    pending ? undefined : revision,
  );
  if (
    verified.revision !== revision ||
    verified.applied.length !== names.length
  )
    throw new Error("Transaction is not fully applied at requested revision");
  if (pending) {
    if (!(await exists(history))) await mkdir(history, { mode: 0o700 });
    await inspectStateLayout(state, true);
    await syncDirectory(state);
    await checkpoint("history");
    if (await exists(archive))
      throw new Error("History destination already exists");
    // Revalidate after the test interruption boundary and immediately before move.
    const current = await inspectProgress(folder);
    if (
      current.revision !== revision ||
      current.applied.length !== names.length
    )
      throw new Error("Transaction changed before finalization");
    await assertHeld();
    await rename(transaction, archive);
    await checkpoint("archived");
  }
  await syncDirectory(history);
  await syncDirectory(state);
  const final = await inspectProgress(folder, revision);
  if (final.revision !== revision || final.applied.length !== names.length)
    throw new Error("Finalized transaction no longer matches active state");
  await assertHeld();
  return { kind: "finalized" as const, revision };
}

// Internal recovery entry; caller retains the common lock. Check the intended
// target before applying any remaining replacement, not merely after success.
export async function resumePreparationLocked(
  folder: string,
  targetRevision: number,
  assertHeld: () => Promise<void>,
) {
  await assertHeld();
  if (!Number.isSafeInteger(targetRevision) || targetRevision < 2)
    throw new Error("Invalid recovery target revision");
  const pending = await exists(join(folder, ".lazurio", "transaction"));
  const current = await inspectProgress(
    folder,
    pending ? undefined : targetRevision,
  );
  if (current.revision !== targetRevision)
    throw new Error("Recovery target revision mismatch");
  if (pending) await applyPreparationLocked(folder, assertHeld);
  await finalizePreparationLocked(folder, targetRevision, assertHeld);
  return { kind: "recovered" as const, revision: targetRevision };
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
