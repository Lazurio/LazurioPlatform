import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { requireClaimedFolderBoundary } from "./handover-layout";
import { withFolderOperationLock } from "./lock";
import {
  type OutputPath,
  outputFile,
  outputPaths,
  stagedName,
} from "./outputs";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { renderOutputs } from "./preview";
import {
  inspectStateLayout,
  readOwnedStateFile,
  readStateJson,
} from "./read-state";
import { instructionSource } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";
import { validatePreparation } from "./validate-preparation";

type StateName = "preferences.json" | "instructions.json";
type ReplacedName = OutputPath | StateName;
export type ApplicationStep = ReplacedName | `renamed:${ReplacedName}`;

// The fixed replacement order: every generated output first, the two state
// files last, so the manifest that claims the new digests is the final rename.
type Replacement = Readonly<{
  name: ReplacedName;
  staged: string;
  directory: string;
  file: string;
}>;
function replacements(folder: string): readonly Replacement[] {
  const state = join(folder, ".lazurio");
  return [
    ...outputPaths.map((path) => {
      const { directory, name } = outputFile(folder, path);
      return { name: path, staged: stagedName(path), directory, file: name };
    }),
    {
      name: "preferences.json" as const,
      staged: "preferences.json",
      directory: state,
      file: "preferences.json",
    },
    {
      name: "instructions.json" as const,
      staged: "instructions.json",
      directory: state,
      file: "instructions.json",
    },
  ];
}

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
  for (const item of replacements(folder)) {
    const current = await inspectProgress(folder);
    if (current.applied.includes(item.name)) {
      await assertHeld();
      await syncDirectory(item.directory);
      await syncDirectory(transaction);
      continue;
    }
    // The claimed Folder boundary, re-checked before every replacement as
    // initialization recovery does: time may have passed since preparation
    // (an interrupted update or refresh resumed later), and a foreign
    // top-level entry is refused by name with the journal left in place.
    await requireClaimedFolderBoundary(folder, current.machine);
    await assertHeld();
    await rename(
      join(transaction, item.staged),
      join(item.directory, item.file),
    );
    await checkpoint(`renamed:${item.name}`);
    await syncDirectory(item.directory);
    await syncDirectory(transaction);
    await checkpoint(item.name);
  }
  // Resume may observe a rename whose directory sync previously failed.
  await syncDirectory(folder);
  await syncDirectory(join(folder, "manual"));
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
  const manual = await inspectOwnedDirectory(join(folder, "manual"));
  if (
    root.dev !== metadata.dev ||
    root.dev !== stage.dev ||
    root.dev !== manual.dev
  )
    throw new Error("Cross-filesystem transaction is unsupported");
  await inspectStateLayout(state, archivedRevision === undefined);
  const items = replacements(folder);
  const stagedEntries = await readdir(transaction);
  if (
    !stagedEntries.includes("before.json") ||
    !stagedEntries.includes("prepared.json") ||
    stagedEntries.some(
      (n) =>
        ![
          ...items.map((item) => item.staged),
          "before.json",
          "prepared.json",
        ].includes(n),
    )
  )
    throw new Error("Incomplete or unrecognized transaction");
  const marker = await readStateJson(transaction, "prepared.json");
  const preferences = parseFolderPreferences(marker.preferences);
  const stagedContents: Partial<Record<OutputPath, string>> = {};
  for (const path of outputPaths)
    stagedContents[path] = stagedEntries.includes(stagedName(path))
      ? (await readOwnedStateFile(transaction, stagedName(path))).content
      : renderOutputs(instructionSource(preferences))[path];
  const validated = await validatePreparation(
    await readStateJson(transaction, "before.json"),
    preferences,
    marker.manifest,
    marker,
    stagedContents as Readonly<Record<OutputPath, string>>,
  );
  if (preferences.profile.os !== executionOs(process.platform))
    throw new Error("Transaction execution OS mismatch");
  // A generated output is compared by its digest: the one the previous
  // manifest records before the replacement (after a template upgrade this
  // product cannot render those bytes again), the planned one after it.
  const expected = (name: ReplacedName, side: "before" | "after") => {
    if (name === "preferences.json")
      return {
        content: JSON.stringify(
          side === "before"
            ? validated.previousPreferences
            : validated.plan.preferences,
        ),
        identity:
          side === "before"
            ? validated.previousPreferencesIdentity
            : validated.stagedPreferencesIdentity,
      };
    if (name === "instructions.json")
      return {
        content: JSON.stringify(
          side === "before"
            ? validated.previousManifest
            : validated.plan.manifest,
        ),
        identity:
          side === "before"
            ? validated.previousManifestIdentity
            : validated.stagedManifestIdentity,
      };
    return {
      content:
        side === "before"
          ? validated.previousManifest.outputs[name]
          : validated.plan.desired[name].digest,
      identity:
        side === "before"
          ? validated.previousIdentities[name]
          : validated.stagedIdentities[name],
    };
  };
  const applied: ReplacedName[] = [];
  let pending = false;
  for (const item of items) {
    const active = await readOwnedStateFile(item.directory, item.file);
    const staged = stagedEntries.includes(item.staged)
      ? await readOwnedStateFile(transaction, item.staged)
      : null;
    const before = expected(item.name, "before");
    const after = expected(item.name, "after");
    const current = staged ? before : after;
    if (
      JSON.stringify(active.identity) !== JSON.stringify(current.identity) ||
      normalize(item.name, active.content) !== current.content
    )
      throw new Error("Transaction conflicts with active state");
    if (staged) {
      pending = true;
      if (
        JSON.stringify(staged.identity) !== JSON.stringify(after.identity) ||
        normalize(item.name, staged.content) !== after.content
      )
        throw new Error("Transaction conflicts with staged state");
    } else {
      if (pending)
        throw new Error("Unrecognized transaction replacement order");
      applied.push(item.name);
    }
  }
  return {
    applied,
    revision: preferences.revision,
    total: items.length,
    // The binding before and after is the same Machine (the planner refuses
    // another), so either side decides whether the Folder is hosted.
    machine: validated.previousPreferences.machine,
  };
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
    verified.applied.length !== verified.total
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
      current.applied.length !== current.total
    )
      throw new Error("Transaction changed before finalization");
    await assertHeld();
    await rename(transaction, archive);
    await checkpoint("archived");
  }
  await syncDirectory(history);
  await syncDirectory(state);
  const final = await inspectProgress(folder, revision);
  if (final.revision !== revision || final.applied.length !== final.total)
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
  // Recovery never proceeds past a foreign top-level entry of a hosted Folder,
  // whatever step the interruption left: refused by name, journal and outputs
  // left in place. Activation checks it again before every replacement.
  await requireClaimedFolderBoundary(folder, current.machine);
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

// The comparable form of a replaced file: parsed state, or an output's digest.
function normalize(name: ReplacedName, content: string) {
  if (name === "preferences.json")
    return JSON.stringify(parseFolderPreferences(JSON.parse(content)));
  if (name === "instructions.json")
    return JSON.stringify(parseInstructionManifest(JSON.parse(content)));
  return createHash("sha256").update(content).digest("hex");
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
