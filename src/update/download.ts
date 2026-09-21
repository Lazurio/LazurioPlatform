import { createHash } from "node:crypto";
import { open, rm, statfs } from "node:fs/promises";
import { storageFailure, UpdateFailure } from "./errors";
import type { ReleaseOrigin } from "./identity";
import type { ManifestTarget } from "./manifest";
import { type Fetcher, openAsset } from "./transport";

/** Download (docs/update.md "Activation", step 1): the artifact into a scratch
 * file, held against the size and digest of the verified manifest while it
 * arrives. One attempt: there is no resume and no partial state — a failure
 * deletes the file, and the same action starts again from zero.
 */
export type DownloadPolicy = Readonly<{
  /** ONE deadline for the whole transfer. */
  deadlineMs: number;
  /** A connection that delivers nothing for this long has failed. */
  idleMs: number;
  /** Free space required on top of the artifact itself. */
  reserveBytes: number;
  freeBytes(directory: string): Promise<number>;
}>;

export const defaultDownloadPolicy: DownloadPolicy = Object.freeze({
  deadlineMs: 30 * 60_000,
  idleMs: 60_000,
  reserveBytes: 32 * 1024 * 1024,
  async freeBytes(directory: string) {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  },
});

export async function downloadArtifact(input: {
  origin: ReleaseOrigin;
  fetcher: Fetcher;
  url: string;
  artifact: ManifestTarget;
  /** Directory of `destination`, on the filesystem of the install base. */
  directory: string;
  destination: string;
  policy?: Partial<DownloadPolicy> | undefined;
  onProgress?:
    | ((receivedBytes: number, totalBytes: number) => void)
    | undefined;
}): Promise<void> {
  const policy = { ...defaultDownloadPolicy, ...input.policy };
  const { size, sha256 } = input.artifact;
  let free: number;
  try {
    free = await policy.freeBytes(input.directory);
  } catch (error) {
    throw storageFailure(error, "disk-check");
  }
  if (free < size + policy.reserveBytes)
    throw new UpdateFailure("disk-full", { stage: "disk-check" });

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), policy.deadlineMs);
  let idle = setTimeout(() => abort.abort(), policy.idleMs);
  const file = await open(input.destination, "wx", 0o600).catch((error) => {
    clearTimeout(deadline);
    clearTimeout(idle);
    throw storageFailure(error, "download");
  });
  try {
    const response = await openAsset(
      input.origin,
      input.fetcher,
      input.url,
      "artifact",
      abort.signal,
    );
    const digest = createHash("sha256");
    let received = 0;
    try {
      for await (const chunk of response.body as ReadableStream<Uint8Array>) {
        clearTimeout(idle);
        idle = setTimeout(() => abort.abort(), policy.idleMs);
        received += chunk.byteLength;
        if (received > size)
          throw new UpdateFailure("release-invalid", {
            resource: "artifact",
            reason: "size",
          });
        await file.writeFile(chunk).catch((error) => {
          throw storageFailure(error, "download");
        });
        digest.update(chunk);
        input.onProgress?.(received, size);
      }
    } catch (error) {
      if (error instanceof UpdateFailure) throw error;
      throw new UpdateFailure("network-unavailable", {
        resource: "artifact",
        reason: abort.signal.aborted ? "timeout" : "connection",
      });
    }
    if (received !== size || digest.digest("hex") !== sha256)
      throw new UpdateFailure("release-invalid", {
        resource: "artifact",
        reason: received !== size ? "size" : "digest",
      });
    await file.sync().catch((error) => {
      throw storageFailure(error, "download");
    });
    await file.close();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(input.destination, { force: true });
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(idle);
  }
}
