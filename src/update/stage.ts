import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "./durable-file";
import {
  executableName,
  layout,
  versionDirectory,
  versionExecutable,
  versionName,
} from "./layout";
import { type ProcessRunner, requireSelfCheck } from "./self-check";
import type { SignedIdentity } from "./signed-identity";

/** Stage (docs/update.md "Download", second half): a verified artifact becomes
 * `versions/<version>+<sha16>/` only after the executable itself — run by its
 * own path, never through the selector — reported the signed identity and
 * read the Folder state. One rename publishes the complete directory; a
 * refusal leaves everything in scratch, which the operation deletes.
 */
export async function sha256File(path: string): Promise<string> {
  const file = await open(path, "r");
  const digest = createHash("sha256");
  try {
    for await (const chunk of file.createReadStream({ autoClose: false }))
      digest.update(chunk);
  } finally {
    await file.close();
  }
  return digest.digest("hex");
}

async function writeSynced(path: string, bytes: Uint8Array, mode: number) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await chmod(path, mode);
}

export type StageInput = Readonly<{
  base: string;
  scratch: string;
  /** Verified artifact bytes inside `scratch`. */
  artifactFile: string;
  identityBytes: Uint8Array;
  identity: SignedIdentity;
  folder?: string | undefined;
  selfCheckTimeoutMs?: number | undefined;
  run?: ProcessRunner | undefined;
}>;

export async function stageCandidate(input: StageInput): Promise<string> {
  const name = versionName(
    input.identity.version,
    input.identity.artifactSha256,
  );
  const candidate = join(input.scratch, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  const executable = join(candidate, executableName);
  await rename(input.artifactFile, executable);
  // Read-only and executable for the owner: the bytes are final.
  await chmod(executable, 0o500);
  await writeSynced(
    join(candidate, "identity.json"),
    input.identityBytes,
    0o400,
  );
  await syncDirectory(candidate);
  await requireSelfCheck({
    executable,
    expected: input.identity,
    folder: input.folder,
    timeoutMs: input.selfCheckTimeoutMs,
    run: input.run,
  });
  const { versions } = layout(input.base);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await rename(candidate, versionDirectory(input.base, name));
  await syncDirectory(versions);
  return name;
}

/** Whether `versions/<name>` holds exactly the signed bytes. Staged versions
 * are immutable by convention, not by the filesystem, so an explicit retry
 * re-establishes it instead of assuming it.
 */
export async function stagedMatches(
  base: string,
  name: string,
  expected: Readonly<{ artifactSha256: string; identityBytes: Uint8Array }>,
): Promise<boolean> {
  try {
    const identity = await readFile(
      join(versionDirectory(base, name), "identity.json"),
    );
    return (
      identity.equals(expected.identityBytes) &&
      (await sha256File(versionExecutable(base, name))) ===
        expected.artifactSha256
    );
  } catch {
    return false;
  }
}

/** Remove a version directory whose files are read-only. */
export async function removeVersion(base: string, name: string) {
  const directory = versionDirectory(base, name);
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
