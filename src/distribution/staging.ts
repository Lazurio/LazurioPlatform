import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedDeclarationBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import {
  closedSelection,
  describeCandidate,
  type PilotCandidate,
  readPublishedPilotTrust,
} from "./installation-state";

/** Read compatibility the installer requires from a release: every listed
 * schema version must be readable by the staged product.
 */
export type RequiredSchemas = Readonly<{
  preferences: readonly number[];
  manifest: readonly number[];
}>;

export type StagedIdentity = Readonly<{
  version: string;
  target: string;
  sourceCommit: string;
  toolchain: string;
  schemas: RequiredSchemas;
  artifactSha256: string;
  artifactBytes: number;
}>;

export type StagedProduct = Readonly<{
  name: string;
  directory: string;
  artifactPath: string;
  identity: StagedIdentity;
  alreadyStaged: boolean;
}>;

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Stages one closed, still-selectable attempt into an immutable versioned
 * product directory under the same installation owner lock. The artifact and
 * its identity are bound to the published signed targets and to each other,
 * declared read compatibility is checked, and the directory is published by
 * one rename. No active version exists or changes here; a leftover staging
 * directory from an interruption is retained and never adopted.
 */
export async function stagePilotCandidate(options: {
  root: string;
  versions: string;
  attempt: string;
  executionTarget: string;
  requiredSchemas: RequiredSchemas;
}): Promise<StagedProduct> {
  await inspectOwnedDirectory(options.root);
  await inspectOwnedDirectory(options.versions);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.attempt))
    throw new Error("Invalid attempt identifier");
  return withFolderOperationLock(options.root, async (assertHeld) => {
    const closed = join(options.root, "history", options.attempt);
    await inspectOwnedDirectory(closed);
    const published = await readPublishedPilotTrust(options.root);
    if (!published) throw new Error("No published trust to stage from");
    const selection = await closedSelection(
      closed,
      options.executionTarget,
      published.trust.channel,
    );
    if (!selection)
      throw new Error("Attempt is not selectable under the published channel");
    const targets = signedTargets(published.trust.checkpoint.metadata.targets);
    const candidate = await describeCandidate(
      closed,
      options.executionTarget,
      selection,
    );
    if (!candidate) throw new Error("Closed attempt has no verified candidate");
    expectTarget(targets, selection.targetPath, candidate);
    const identityPath = `${selection.targetPath.slice(
      0,
      selection.targetPath.lastIndexOf("/"),
    )}/identity.json`;
    const identityBytes = await readOwnedDeclarationBytes(
      join(closed, "identity.json"),
    );
    expectTarget(targets, identityPath, {
      sha256: createHash("sha256").update(identityBytes).digest("hex"),
      length: identityBytes.length,
    });
    const identity = parseIdentity(
      new TextDecoder("utf-8", { fatal: true }).decode(identityBytes),
      options.executionTarget,
      candidate,
      options.requiredSchemas,
    );
    const name = `${identity.version}+${candidate.sha256.slice(0, 16)}`;
    const directory = join(options.versions, name);
    const artifactName = options.executionTarget.startsWith("windows-")
      ? "lazurio.exe"
      : "lazurio";
    const existing = (await readdir(options.versions)).includes(name);
    await assertHeld();
    if (existing) {
      // Immutable: an occupied name is accepted only when byte-identical.
      const staged = await describeCandidate(
        directory,
        options.executionTarget,
        selection,
      );
      const stagedIdentity = await readOwnedDeclarationBytes(
        join(directory, "identity.json"),
      );
      if (!staged || !stagedIdentity.equals(identityBytes))
        throw new Error("Conflicting staged product directory");
      return Object.freeze({
        name,
        directory,
        artifactPath: staged.path,
        identity,
        alreadyStaged: true,
      });
    }
    const staging = join(
      options.versions,
      `.staging-${randomBytes(8).toString("hex")}`,
    );
    await mkdir(staging, { mode: 0o700 });
    await copyReadOnly(candidate.path, join(staging, artifactName), 0o500);
    await writeReadOnly(join(staging, "identity.json"), identityBytes);
    await writeReadOnly(
      join(staging, "provenance.json"),
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          attempt: options.attempt,
          channel: {
            sequence: selection.sequence,
            documentSha256: selection.documentSha256,
          },
          artifactSha256: candidate.sha256,
        }),
      ),
    );
    await syncPath(staging);
    // Publish the complete directory by one rename; verify the published bytes.
    await rename(staging, directory);
    await syncPath(options.versions);
    const staged = await describeCandidate(
      directory,
      options.executionTarget,
      selection,
    );
    if (!staged) throw new Error("Staged product failed reverification");
    return Object.freeze({
      name,
      directory,
      artifactPath: staged.path,
      identity,
      alreadyStaged: false,
    });
  });
}

function signedTargets(targetsJson: string) {
  const value = parseUniqueJson(targetsJson) as Record<string, unknown>;
  const signed = value?.signed as Record<string, unknown> | undefined;
  const targets = signed?.targets as Record<string, unknown> | undefined;
  if (!targets || typeof targets !== "object" || Array.isArray(targets))
    throw new Error("Published targets metadata unavailable");
  return targets;
}

function expectTarget(
  targets: Record<string, unknown>,
  path: string,
  actual: Readonly<{ sha256: string; length: number }>,
) {
  const entry = Object.hasOwn(targets, path)
    ? (targets[path] as Record<string, unknown>)
    : undefined;
  const hashes = entry?.hashes as Record<string, unknown> | undefined;
  if (
    !entry ||
    entry.length !== actual.length ||
    hashes?.sha256 !== actual.sha256
  )
    throw new Error(`Bytes do not match the published target ${path}`);
}

function parseIdentity(
  json: string,
  executionTarget: string,
  candidate: PilotCandidate,
  required: RequiredSchemas,
): StagedIdentity {
  const envelope = parseUniqueJson(json) as Record<string, unknown>;
  const identity = envelope?.identity as Record<string, unknown> | undefined;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    identity.schemaVersion !== 1
  )
    throw new Error("Unsupported artifact identity");
  const schemas = identity.schemas as Record<string, unknown> | undefined;
  const versions = (input: unknown) =>
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((version) => Number.isSafeInteger(version) && version >= 1)
      ? Object.freeze([...(input as number[])])
      : null;
  const preferences = versions(schemas?.preferences);
  const manifest = versions(schemas?.manifest);
  if (
    typeof identity.version !== "string" ||
    !semver.test(identity.version) ||
    typeof identity.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(identity.sourceCommit) ||
    typeof identity.toolchain !== "string" ||
    !preferences ||
    !manifest
  )
    throw new Error("Invalid artifact identity");
  if (identity.target !== executionTarget)
    throw new Error("Artifact identity targets a different platform");
  if (
    identity.artifactSha256 !== candidate.sha256 ||
    identity.artifactBytes !== candidate.length
  )
    throw new Error("Artifact identity does not describe the verified bytes");
  if (
    !required.preferences.every((version) => preferences.includes(version)) ||
    !required.manifest.every((version) => manifest.includes(version))
  )
    throw new Error("Staged release cannot read the required schema versions");
  return Object.freeze({
    version: identity.version,
    target: executionTarget,
    sourceCommit: identity.sourceCommit,
    toolchain: identity.toolchain,
    schemas: Object.freeze({ preferences, manifest }),
    artifactSha256: candidate.sha256,
    artifactBytes: candidate.length,
  });
}

async function copyReadOnly(source: string, destination: string, mode: number) {
  const input = await open(source, "r");
  const output = await open(destination, "wx", 0o600);
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      await output.write(chunk, 0, bytesRead, position);
      position += bytesRead;
    }
    await output.sync();
  } finally {
    await output.close();
    await input.close();
  }
  await chmod(destination, mode);
}

async function writeReadOnly(path: string, bytes: Buffer) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, 0o400);
}

async function syncPath(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
