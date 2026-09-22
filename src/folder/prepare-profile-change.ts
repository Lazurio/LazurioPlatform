import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { planProfileChange } from "./change-profile";
import { inspectOutput } from "./inventory";
import { withFolderOperationLock } from "./lock";
import {
  type OutputPath,
  outputFile,
  outputPaths,
  stagedName,
} from "./outputs";
import { inspectOwnedDirectory } from "./owned-directory";
import { executionOs } from "./platform";
import { readFolderState, readOwnedStateFile } from "./read-state";
import {
  type FileIdentity,
  transactionSchemaVersion,
} from "./validate-preparation";

export type PreparationStep =
  | "directory"
  | "before"
  | "preferences"
  | "manifest"
  | "instructions"
  | "manual"
  | "prepared";

// Development-only preparation, not activation. Existing bytes are never replaced.
// Incomplete state is retained and blocks subsequent operations. checkpoint exists
// for interruption tests; no CLI or installed mutation surface exposes this yet.
export async function prepareProfileChange(
  folder: string,
  expectedRevision: number,
  requested: unknown,
  checkpoint: (step: PreparationStep) => Promise<void> = async () => {},
) {
  await inspectOwnedDirectory(folder);
  return withFolderOperationLock(join(folder, ".lazurio"), (assertHeld) =>
    prepareProfileChangeLocked(
      folder,
      expectedRevision,
      requested,
      assertHeld,
      checkpoint,
    ),
  );
}

// Internal entry for an application use case retaining the common lock.
export async function prepareProfileChangeLocked(
  folder: string,
  expectedRevision: number,
  requested: unknown,
  assertHeld: () => Promise<void>,
  checkpoint: (step: PreparationStep) => Promise<void> = async () => {},
) {
  await assertHeld();
  const root = await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  const stateRoot = await inspectOwnedDirectory(stateDirectory);
  if (stateRoot.dev !== root.dev)
    throw new Error("Cross-filesystem preparation is unsupported");
  const state = await readFolderState(stateDirectory);
  if (state.preferences.profile.os !== executionOs(process.platform))
    throw new Error("Stored profile does not match execution Machine");
  const plan = await planProfileChange(
    state.preferences,
    state.manifest,
    expectedRevision,
    requested,
    (path) => inspectOutput(folder, path),
  );
  if (plan.kind !== "profile-change") return plan;
  // Every generated output is staged and replaced, changed or not: one
  // transaction with one fixed file list, whose identities are all recorded.
  const before: Partial<Record<OutputPath, FileIdentity>> = {};
  for (const path of outputPaths) {
    const { directory, name } = outputFile(folder, path);
    const stat = await lstat(join(directory, name));
    before[path] = { dev: String(stat.dev), ino: String(stat.ino) };
  }
  const previousPreferences = await readOwnedStateFile(
    stateDirectory,
    "preferences.json",
  );
  const previousManifest = await readOwnedStateFile(
    stateDirectory,
    "instructions.json",
  );
  const directory = join(stateDirectory, "transaction");
  await assertHeld();
  await mkdir(directory, { mode: 0o700 }); // Exclusive; never adopt an existing directory.
  await syncDirectory(stateDirectory);
  await checkpoint("directory");
  await writeNew(
    join(directory, "before.json"),
    JSON.stringify({
      schemaVersion: transactionSchemaVersion,
      ...state,
      outputIdentities: before,
      preferencesIdentity: previousPreferences.identity,
      manifestIdentity: previousManifest.identity,
    }),
  );
  await checkpoint("before");
  const stagedPreferences = await writeNew(
    join(directory, "preferences.json"),
    JSON.stringify(plan.preferences),
  );
  await checkpoint("preferences");
  const stagedManifest = await writeNew(
    join(directory, "instructions.json"),
    JSON.stringify(plan.manifest),
  );
  await checkpoint("manifest");
  const staged: Partial<Record<OutputPath, FileIdentity>> = {};
  for (const path of outputPaths) {
    const stat = await writeNew(
      join(directory, stagedName(path)),
      plan.desired[path].content,
    );
    staged[path] = { dev: String(stat.dev), ino: String(stat.ino) };
    if (path === "AGENTS.md") await checkpoint("instructions");
  }
  await checkpoint("manual");
  for (const path of outputPaths) {
    const observed = await inspectOutput(folder, path);
    const { directory: outputDirectory, name } = outputFile(folder, path);
    const current = await lstat(join(outputDirectory, name));
    await assertHeld();
    if (
      observed.kind !== "regular" ||
      observed.digest !== plan.previous[path] ||
      String(current.dev) !== before[path]?.dev ||
      String(current.ino) !== before[path]?.ino
    )
      throw new Error(
        "Instructions changed during preparation; recovery required",
      );
  }
  // Marker means only staging completed. Later activation/recovery must validate
  // every staged input, expected revision and file identity again under the lock.
  await writeNew(
    join(directory, "prepared.json"),
    JSON.stringify({
      schemaVersion: transactionSchemaVersion,
      expectedRevision,
      nextRevision: plan.preferences.revision,
      outputIdentities: staged,
      preferences: plan.preferences,
      manifest: plan.manifest,
      preferencesIdentity: {
        dev: String(stagedPreferences.dev),
        ino: String(stagedPreferences.ino),
      },
      manifestIdentity: {
        dev: String(stagedManifest.dev),
        ino: String(stagedManifest.ino),
      },
    }),
  );
  await syncDirectory(directory);
  await checkpoint("prepared");
  return {
    kind: "prepared" as const,
    expectedRevision,
    nextRevision: plan.preferences.revision,
  };
}

async function writeNew(path: string, content: string) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
    return await file.stat();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
