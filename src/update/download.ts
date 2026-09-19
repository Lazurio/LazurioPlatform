import { createHash, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { DownloadHTTPError } from "tuf-js/dist/error";
import type { RangeResponse } from "../distribution/transport";
import type { AvailableSession, SignedArtifact } from "./check";
import { UpdateFailure } from "./errors";
import {
  assertCandidateIdentity,
  identityTargetPath,
  maxIdentityBytes,
  parseSignedIdentity,
  type SignedIdentity,
  type StateSchemas,
} from "./signed-identity";

/** Download (docs/update.md "Download"): the signed identity first — a wrong
 * target or an unreadable Folder schema is refused before the large transfer —
 * then the artifact, resumable, into the operation's scratch directory. Every
 * refusal is a thrown `UpdateFailure` and leaves nothing outside scratch.
 */
export type RangeOpener = (
  url: string,
  offset: number,
  signal: AbortSignal,
) => Promise<RangeResponse>;

export type DownloadFile = Readonly<{
  write(chunk: Uint8Array): Promise<void>;
  /** Forget everything written so far. */
  restart(): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}>;

/** Every effect of a download that a test must be able to fail. */
export type DownloadEffects = Readonly<{
  freeBytes(directory: string): Promise<number>;
  create(path: string): Promise<DownloadFile>;
  now(): number;
  sleep(ms: number): Promise<void>;
}>;

export const systemDownloadEffects: DownloadEffects = Object.freeze({
  async freeBytes(directory: string) {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  },
  async create(path: string) {
    // Append mode: after `restart` the next write lands at offset zero.
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_APPEND,
      0o600,
    );
    return Object.freeze({
      async write(chunk: Uint8Array) {
        await file.appendFile(chunk);
      },
      async restart() {
        await file.truncate(0);
      },
      sync: () => file.sync(),
      close: () => file.close(),
    });
  },
  now: () => performance.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

export type DownloadPolicy = Readonly<{
  /** ONE deadline for the whole transfer, retries and waits included. */
  deadlineMs: number;
  /** Consecutive attempts that received nothing before giving up. */
  stalledAttempts: number;
  /** A connection that delivers nothing for this long is retried. */
  idleMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  /** Free space required on top of the artifact itself. */
  reserveBytes: number;
}>;

export const defaultDownloadPolicy: DownloadPolicy = Object.freeze({
  deadlineMs: 30 * 60_000,
  stalledAttempts: 5,
  idleMs: 30_000,
  backoffMs: 500,
  maxBackoffMs: 10_000,
  reserveBytes: 32 * 1024 * 1024,
});

/** The ONE mapping from a signed artifact target to its URL. A release names
 * the download location of its executable in the SIGNED target metadata
 * (`custom.url`, a GitHub Release asset — docs/update.md "Publishing"); the
 * bytes are verified against the signed length and digest wherever they came
 * from, and the transport decides which origins may be contacted at all. A
 * target without a location is served by the repository itself under its TUF
 * consistent-snapshot name (`artifacts/<sha256>/<sha256>.lazurio`): the
 * loopback fixture, or a mirror that hosts everything in one tree.
 */
export function artifactUrl(
  targetBaseUrl: string,
  artifact: SignedArtifact,
): string {
  if (artifact.url !== undefined) return artifact.url;
  const slash = artifact.path.lastIndexOf("/");
  return `${targetBaseUrl}${artifact.path.slice(0, slash + 1)}${artifact.sha256}.${artifact.path.slice(slash + 1)}`;
}

function storageFailure(error: unknown, stage: string): UpdateFailure {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "ENOSPC" || errno === "EDQUOT")
    return new UpdateFailure("disk-full", { stage });
  return new UpdateFailure("storage-unavailable", {
    stage,
    ...(typeof errno === "string" && /^E[A-Z]+$/.test(errno) ? { errno } : {}),
  });
}

/** HTTP statuses worth another attempt; every other 4xx is the publisher's
 * answer and repeats identically.
 */
const transientStatus = (status: number) =>
  status === 408 || status === 429 || status >= 500;

export async function downloadArtifact(input: {
  url: string;
  artifact: SignedArtifact;
  destination: string;
  directory: string;
  openRange: RangeOpener;
  effects?: DownloadEffects;
  policy?: Partial<DownloadPolicy>;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
}): Promise<void> {
  const effects = input.effects ?? systemDownloadEffects;
  const policy = { ...defaultDownloadPolicy, ...input.policy };
  const { length, sha256 } = input.artifact;
  let free: number;
  try {
    free = await effects.freeBytes(input.directory);
  } catch (error) {
    throw storageFailure(error, "disk-check");
  }
  if (free < length + policy.reserveBytes)
    throw new UpdateFailure("disk-full", { stage: "disk-check" });

  const deadline = effects.now() + policy.deadlineMs;
  const expired = new AbortController();
  const deadlineTimer = setTimeout(() => expired.abort(), policy.deadlineMs);
  let file: DownloadFile;
  try {
    file = await effects.create(input.destination);
  } catch (error) {
    clearTimeout(deadlineTimer);
    throw storageFailure(error, "download");
  }
  let received = 0;
  let digest: Hash = createHash("sha256");
  let stalled = 0;
  let lastStatus: number | undefined;
  const unavailable = (reason: string) =>
    new UpdateFailure("network-unavailable", {
      resource: "artifact",
      reason,
      ...(lastStatus === undefined ? {} : { httpStatus: lastStatus }),
    });
  const restart = async () => {
    try {
      await file.restart();
    } catch (error) {
      throw storageFailure(error, "download");
    }
    received = 0;
    digest = createHash("sha256");
  };
  try {
    while (received < length) {
      if (expired.signal.aborted || effects.now() >= deadline)
        throw unavailable("deadline");
      const before = received;
      const attempt = new AbortController();
      let idle = setTimeout(() => attempt.abort(), policy.idleMs);
      let response: RangeResponse | undefined;
      try {
        response = await input.openRange(
          input.url,
          received,
          AbortSignal.any([expired.signal, attempt.signal]),
        );
        // The server ignored the range: what it sends starts at zero.
        if (response.offset !== received) await restart();
        for await (const chunk of response.body) {
          clearTimeout(idle);
          idle = setTimeout(() => attempt.abort(), policy.idleMs);
          if (received + chunk.byteLength > length)
            throw new UpdateFailure("artifact-invalid", { reason: "length" });
          try {
            await file.write(chunk);
          } catch (error) {
            throw storageFailure(error, "download");
          }
          digest.update(chunk);
          received += chunk.byteLength;
          input.onProgress?.(received, length);
        }
      } catch (error) {
        if (error instanceof UpdateFailure) throw error;
        lastStatus =
          error instanceof DownloadHTTPError ? error.statusCode : undefined;
        if (lastStatus === 416 && received > 0) await restart();
        else if (lastStatus !== undefined && !transientStatus(lastStatus))
          throw unavailable("http");
      } finally {
        clearTimeout(idle);
        response?.close();
      }
      if (received >= length) break;
      // Progress proves the origin is alive: only fruitless attempts count.
      stalled = received > before ? 0 : stalled + 1;
      if (stalled >= policy.stalledAttempts) throw unavailable("retries");
      const wait = Math.min(
        policy.backoffMs * 2 ** Math.max(0, stalled - 1),
        policy.maxBackoffMs,
        Math.max(0, deadline - effects.now()),
      );
      if (wait > 0) await effects.sleep(wait);
    }
    if (digest.digest("hex") !== sha256)
      throw new UpdateFailure("artifact-invalid", { reason: "digest" });
    try {
      await file.sync();
    } catch (error) {
      throw storageFailure(error, "download");
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(input.destination, { force: true });
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
  try {
    await file.close();
  } catch (error) {
    throw storageFailure(error, "download");
  }
}

/** Fetch the signed identity through the TUF client (length and digest are
 * verified against signed targets there) and hold it against the candidate.
 */
export async function downloadSignedIdentity(
  session: Pick<
    AvailableSession,
    "updater" | "scratch" | "artifact" | "document"
  >,
  expected: Readonly<{ target: string; requiredSchemas: StateSchemas }>,
): Promise<Readonly<{ bytes: Buffer; identity: SignedIdentity }>> {
  const path = identityTargetPath(session.artifact.path);
  const info = await session.updater.getTargetInfo(path);
  if (!info) throw new UpdateFailure("identity-invalid", { reason: "absent" });
  if (info.length > maxIdentityBytes)
    throw new UpdateFailure("response-too-large", { resource: "identity" });
  const file = join(session.scratch, "identity.json");
  let bytes: Buffer;
  try {
    await session.updater.downloadTarget(info, file);
    bytes = await readFile(file);
  } catch {
    // The pinned client reports a failed transfer and a failed verification
    // alike; both mean "not obtainable now".
    throw new UpdateFailure("network-unavailable", { resource: "identity" });
  }
  const identity = parseSignedIdentity(bytes);
  assertCandidateIdentity(identity, {
    target: expected.target,
    version: session.document.version,
    artifactSha256: session.artifact.sha256,
    artifactBytes: session.artifact.length,
    requiredSchemas: expected.requiredSchemas,
  });
  return Object.freeze({ bytes, identity });
}
