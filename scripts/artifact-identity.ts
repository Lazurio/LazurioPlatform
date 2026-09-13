import { createHash } from "node:crypto";

export const artifactTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-arm64",
  "windows-x64",
] as const;

// Identity describes bytes; it never establishes publisher trust or qualification.
export function artifactIdentity(input: {
  version: string;
  target: string;
  sourceCommit: string;
  toolchain: string;
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
  const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  return {
    schemaVersion: 1,
    version: input.version,
    target: input.target,
    sourceCommit: input.sourceCommit,
    toolchain: input.toolchain,
    lockfileSha256: digest(input.lockfile),
    artifactSha256: digest(input.artifact),
    artifactBytes: input.artifact.byteLength,
  } as const;
}
