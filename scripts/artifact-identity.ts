import { createHash } from "node:crypto";

export const artifactTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
] as const;

export type SupportedSchemas = Readonly<{
  preferences: readonly number[];
  manifest: readonly number[];
}>;

// Sorted, unique, positive schema versions the release can read.
function supportedSchemaVersions(input: unknown): readonly number[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.some(
      (version, index) =>
        !Number.isSafeInteger(version) ||
        version < 1 ||
        (index > 0 && version <= (input[index - 1] as number)),
    )
  )
    throw new Error(
      "Supported schema versions must be sorted positive integers",
    );
  return Object.freeze([...(input as number[])]);
}

// Identity describes bytes and declared read compatibility; it never
// establishes publisher trust or qualification.
export function artifactIdentity(input: {
  version: string;
  target: string;
  sourceCommit: string;
  toolchain: string;
  schemas: SupportedSchemas;
  lockfile: Uint8Array;
  artifact: Uint8Array;
}) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      input.version,
    )
  )
    throw new Error("Invalid artifact version");
  if (!(artifactTargets as readonly string[]).includes(input.target))
    throw new Error("Unknown artifact target");
  if (!/^[0-9a-f]{40}$/.test(input.sourceCommit))
    throw new Error("A full source commit is required");
  if (!/^bun@\d+\.\d+\.\d+$/.test(input.toolchain))
    throw new Error("An exact Bun toolchain is required");
  if (!input.artifact.byteLength || !input.lockfile.byteLength)
    throw new Error("Artifact and lockfile must not be empty");
  const schemas = Object.freeze({
    preferences: supportedSchemaVersions(input.schemas.preferences),
    manifest: supportedSchemaVersions(input.schemas.manifest),
  });
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  return {
    schemaVersion: 1,
    version: input.version,
    target: input.target,
    sourceCommit: input.sourceCommit,
    toolchain: input.toolchain,
    schemas,
    lockfileSha256: digest(input.lockfile),
    artifactSha256: digest(input.artifact),
    artifactBytes: input.artifact.byteLength,
  } as const;
}
