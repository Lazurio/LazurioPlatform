import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "./durable-file";
import { storageFailure } from "./errors";
import {
  executableName,
  layout,
  removeVersion,
  versionDirectory,
  versionExecutable,
} from "./layout";
import { type ProcessRunner, requireSelfCheck } from "./self-check";

/** Stage (docs/update.md "Activation", steps 1 and 2): verified bytes become
 * `versions/<version>/lazurio` by one rename of a complete directory, and the
 * executable itself — run by its immutable path, never through the selector —
 * must then report the verified identity and read the install base and the
 * Folder. A refusal removes what this call placed; nothing was switched.
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

/** Whether `versions/<version>` already holds exactly these bytes. Versions
 * are immutable by convention, not by the filesystem, so it is re-established.
 */
export async function stagedMatches(
  base: string,
  version: string,
  sha256: string,
): Promise<boolean> {
  try {
    return (await sha256File(versionExecutable(base, version))) === sha256;
  } catch {
    return false;
  }
}

/** Move the verified scratch file into place. The caller established that no
 * matching version is staged and that `version` is neither active nor previous.
 */
export async function placeVersion(input: {
  base: string;
  scratch: string;
  artifactFile: string;
  version: string;
}): Promise<void> {
  try {
    const candidate = join(input.scratch, "candidate");
    await mkdir(candidate, { mode: 0o700 });
    // Explicit: a umask may clear bits of `mode`, and the owned layout states
    // its modes instead of inheriting them.
    await chmod(candidate, 0o700);
    const executable = join(candidate, executableName);
    await rename(input.artifactFile, executable);
    // Read-only and executable for the owner: the bytes are final.
    await chmod(executable, 0o500);
    await syncDirectory(candidate);
    await removeVersion(input.base, input.version);
    await rename(candidate, versionDirectory(input.base, input.version));
    await syncDirectory(layout(input.base).versions);
  } catch (error) {
    throw storageFailure(error, "stage");
  }
}

export async function selfCheckStaged(input: {
  base: string;
  expected: Parameters<typeof requireSelfCheck>[0]["expected"];
  folder?: string | undefined;
  /** Remove the version when it fails: true only for what this run placed. */
  removeOnFailure: boolean;
  timeoutMs?: number | undefined;
  run?: ProcessRunner | undefined;
}): Promise<void> {
  try {
    await requireSelfCheck({
      executable: versionExecutable(input.base, input.expected.version),
      expected: input.expected,
      base: input.base,
      folder: input.folder,
      timeoutMs: input.timeoutMs,
      run: input.run,
    });
  } catch (error) {
    if (input.removeOnFailure)
      await removeVersion(input.base, input.expected.version).catch(
        () => undefined,
      );
    throw error;
  }
}
