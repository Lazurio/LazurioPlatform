import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type Fetcher, Updater } from "tuf-js";
import { ExpiredMetadataError } from "tuf-js/dist/error";
import {
  assertNotRolledBack,
  type ChannelDocument,
  channelTargetPath,
  isUpdateChannel,
  maxChannelDocumentBytes,
  parseChannelDocument,
  type UpdateChannel,
} from "./channel";
import {
  type DurableWriter,
  removeAbandonedTemporaries,
  writeDurableFile,
} from "./durable-file";
import {
  type ErrorContext,
  type UpdateError,
  type UpdateErrorCode,
  UpdateFailure,
  updateError,
  updateErrors,
} from "./errors";
import type { ProductIdentity } from "./identity";
import { acquireUpdateLock } from "./lock";
import {
  type Observed,
  type ObservedAvailable,
  readObserved,
  readSelected,
  writeObserved,
} from "./observed";
import {
  advanceChannelFloor,
  ensureOwnedDirectory,
  promoteVerified,
  readChannelFloors,
  readSeed,
  seedScratch,
} from "./trust";
import { TrustFetcher } from "./trust-fetcher";
import { compareVersions } from "./version";

export type CheckInput = Readonly<{
  /** Per-user install base; created when absent. Unrelated entries in it are
   * never inspected. */
  base: string;
  metadataBaseUrl: string;
  targetBaseUrl: string;
  channel: UpdateChannel;
  identity: ProductIdentity;
  /** Trust anchor for the very first check only; refused once `trust/` holds a
   * root. The compiled-in root of a later slice enters through this input. */
  bootstrapRoot?: Uint8Array;
  /** Owns origins, redirects, size and time limits of every transfer. */
  transport: Fetcher;
  /** Times written into the observation. Metadata expiry is judged by the
   * pinned TUF client against the system clock (store.js:11); it offers no
   * clock input and this use case never works around that. */
  clock: () => Date;
  lockTimeoutMs?: number;
  operationId?: string;
  /** Effect adapter for every durable write of this use case. */
  writeDurable?: DurableWriter;
}>;

export type CheckResult =
  | Readonly<{
      kind: "up-to-date";
      version: string;
      channelVersion: string;
      sequence: number;
    }>
  | Readonly<{
      kind: "available";
      version: string;
      artifactSha256: string;
      length: number;
      sequence: number;
    }>
  | (Readonly<{ kind: "error" }> & UpdateError);

type Verified = Readonly<{
  document: ChannelDocument;
  artifact: Readonly<{ sha256: string; length: number }> | undefined;
}>;

/** Pinned-client compatibility (tuf-js 6.0.0): snapshot and targets failures
 * are re-thrown as `RuntimeError` carrying only the STRINGIFIED cause
 * (updater.js:254, :290), so their expiry survives solely in the message. A
 * wrong guess here only swaps two retryable error codes; it promotes nothing.
 */
function expired(error: unknown): boolean {
  return (
    error instanceof ExpiredMetadataError ||
    (error instanceof Error &&
      /(?:^|: )(?:Final )?[a-z]+\.json is expired$/.test(error.message))
  );
}

function classify(error: unknown, fetcher: TrustFetcher): UpdateError {
  if (error instanceof UpdateFailure) return error.failure;
  if (fetcher.lastFailure)
    return updateError("network-unavailable", fetcher.lastFailure);
  if (expired(error)) return updateError("metadata-expired");
  return updateError("metadata-invalid");
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith("/")
    );
  } catch {
    return false;
  }
}

/** Refresh in scratch. Throws on the first failure; the caller captures
 * whatever was verified before it. NO target is looked up here.
 */
async function refresh(
  input: CheckInput,
  scratch: string,
  fetcher: TrustFetcher,
): Promise<Updater> {
  const updater = new Updater({
    fetcher,
    metadataDir: scratch,
    metadataBaseUrl: input.metadataBaseUrl,
    targetBaseUrl: input.targetBaseUrl,
    // No hidden retries: the caller's click is the retry. One refresh walks a
    // bounded number of roots; a Machine further behind converges over
    // several checks because every verified root is promoted.
    config: {
      fetchRetries: 0,
      fetchRetry: false,
      maxDelegations: 0,
      maxRootRotations: 32,
    },
  });
  await updater.refresh();
  return updater;
}

/** Targets are looked up only after a refresh that completed without error
 * AND satisfied the floor vector (docs/update.md "The floor vector").
 */
async function readChannel(
  input: CheckInput,
  scratch: string,
  updater: Updater,
): Promise<Buffer> {
  const path = channelTargetPath(input.channel);
  const target = await updater.getTargetInfo(path);
  if (!target)
    throw new UpdateFailure("channel-invalid", {
      channel: input.channel,
      reason: "absent",
    });
  if (target.length > maxChannelDocumentBytes)
    throw new UpdateFailure("channel-invalid", {
      channel: input.channel,
      reason: "too-large",
    });
  const file = join(scratch, "channel-document");
  await updater.downloadTarget(target, file);
  return readFile(file);
}

/** Check for an update: automatic, cheap, and no mutation of the product
 * (docs/update.md "Check"). It advances only durable trust and rewrites the
 * observation. Expected failures are returned, never thrown.
 */
export async function checkForUpdate(input: CheckInput): Promise<CheckResult> {
  const fail = (code: UpdateErrorCode, context: ErrorContext = {}) =>
    Object.freeze({ kind: "error" as const, ...updateError(code, context) });
  if (
    !isAbsolute(input.base) ||
    resolve(input.base) !== input.base ||
    !isUpdateChannel(input.channel) ||
    !validUrl(input.metadataBaseUrl) ||
    !validUrl(input.targetBaseUrl)
  )
    return fail("invalid-request");
  const write = input.writeDurable ?? writeDurableFile;
  const operationId = input.operationId ?? randomUUID();
  const trustDirectory = join(input.base, "trust");
  const updateDirectory = join(input.base, "update");
  let lock: Awaited<ReturnType<typeof acquireUpdateLock>>;
  try {
    await mkdir(input.base, { recursive: true, mode: 0o700 });
    await ensureOwnedDirectory(trustDirectory);
    await ensureOwnedDirectory(updateDirectory);
    lock = await acquireUpdateLock(join(updateDirectory, "lock"), {
      timeoutMs: input.lockTimeoutMs ?? 30_000,
    });
  } catch (error) {
    // `busy` leaves the observation alone: the holder is about to write it.
    if (error instanceof UpdateFailure)
      return fail(error.failure.code, error.failure.context);
    return fail(...storageOrInternal(error, "prepare"));
  }
  try {
    const outcome = await checkUnderLock(
      input,
      { trustDirectory, updateDirectory, operationId },
      write,
    );
    try {
      await writeObserved(
        input.base,
        await observe(input, operationId, outcome),
        write,
      );
    } catch {
      // Derived state: failing to write it must not change the result.
    }
    return "failure" in outcome
      ? fail(outcome.failure.code, outcome.failure.context)
      : result(input.identity, outcome);
  } catch {
    return fail("internal");
  } finally {
    await lock.release();
  }
}

type Outcome = Verified | Readonly<{ failure: UpdateError }>;

async function checkUnderLock(
  input: CheckInput,
  owned: {
    trustDirectory: string;
    updateDirectory: string;
    operationId: string;
  },
  write: DurableWriter,
): Promise<Outcome> {
  const { trustDirectory, updateDirectory } = owned;
  const fetcher = new TrustFetcher(input.transport, input.metadataBaseUrl);
  const scratch = join(updateDirectory, `scratch-${owned.operationId}`);
  let updater: Updater | undefined;
  let failure: UpdateError | undefined;
  try {
    // Holding the lock proves no writer is alive: every scratch directory and
    // every temporary file is an abandoned leftover.
    for (const entry of await readdir(updateDirectory))
      if (entry.startsWith("scratch-"))
        await rm(join(updateDirectory, entry), { recursive: true });
    await removeAbandonedTemporaries(trustDirectory);
    await removeAbandonedTemporaries(updateDirectory);
    const seed = await readSeed(trustDirectory, input.bootstrapRoot);
    await mkdir(scratch, { mode: 0o700 });
    await seedScratch(scratch, seed);
    try {
      updater = await refresh(input, scratch, fetcher);
    } catch (error) {
      failure = classify(error, fetcher);
    }
    // Trust never rewinds: capture on success AND on failure, before anything
    // else can go wrong with this attempt. A floor-vector violation outranks
    // whatever else went wrong: it is the one that must be seen.
    try {
      await promoteVerified({
        trustDirectory,
        scratch,
        seed,
        fetchedRoots: fetcher.roots,
        refreshed: updater !== undefined,
        lastDelivered: updater ? undefined : fetcher.lastDelivered,
        write,
      });
    } catch (error) {
      return {
        failure:
          error instanceof UpdateFailure
            ? error.failure
            : updateError(...storageOrInternal(error, "trust")),
      };
    }
    if (failure || !updater)
      return { failure: failure ?? updateError("internal") };
    let bytes: Buffer;
    try {
      bytes = await readChannel(input, scratch, updater);
    } catch (error) {
      return { failure: classify(error, fetcher) };
    }
    const received = { bytes, updater };
    // Read only now: unreadable floors refuse the channel decision, but they
    // must not stop verified TUF roles above from becoming durable.
    const floors = await readChannelFloors(trustDirectory);
    const document = parseChannelDocument(received.bytes, input.channel);
    assertNotRolledBack(document, floors[input.channel]);
    try {
      await advanceChannelFloor({ trustDirectory, floors, document, write });
    } catch (error) {
      return { failure: updateError(...storageOrInternal(error, "floor")) };
    }
    const path = document.targets[input.identity.target];
    if (path === undefined) return { document, artifact: undefined };
    const artifact = await received.updater.getTargetInfo(path);
    const sha256 = path.split("/")[1] as string;
    if (!artifact || artifact.length < 1 || artifact.hashes.sha256 !== sha256)
      return {
        failure: updateError("metadata-invalid", { subject: "artifact" }),
      };
    return { document, artifact: { sha256, length: artifact.length } };
  } catch (error) {
    return {
      failure:
        error instanceof UpdateFailure
          ? error.failure
          : updateError(...storageOrInternal(error, "check")),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A filesystem refusal (full disk, permissions) is an outside condition the
 * user can restore; anything else at these stages is a product defect.
 */
function storageOrInternal(
  error: unknown,
  stage: string,
): [UpdateErrorCode, ErrorContext] {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof errno === "string" && /^E[A-Z]+$/.test(errno)
    ? ["storage-unavailable", { stage, errno }]
    : ["internal", { stage }];
}

function result(identity: ProductIdentity, verified: Verified): CheckResult {
  const { document, artifact } = verified;
  if (!artifact)
    return Object.freeze({
      kind: "error" as const,
      ...updateError("target-unsupported", {
        channel: document.channel,
        target: identity.target,
      }),
    });
  // Never a downgrade: an equal or older channel version is up to date.
  if (compareVersions(document.version, identity.version) <= 0)
    return Object.freeze({
      kind: "up-to-date",
      version: identity.version,
      channelVersion: document.version,
      sequence: document.sequence,
    });
  return Object.freeze({
    kind: "available",
    version: document.version,
    artifactSha256: artifact.sha256,
    length: artifact.length,
    sequence: document.sequence,
  });
}

/** Rewrite the observation from facts. The previous file contributes only
 * what this check could not re-establish — the last authenticated time and a
 * still-newer verified target — and only when it parses.
 */
async function observe(
  input: CheckInput,
  operationId: string,
  outcome: Outcome,
): Promise<Observed> {
  const now = input.clock();
  const at = now.toISOString();
  const previous = await readObserved(input.base, now);
  const checked =
    "failure" in outcome ? undefined : result(input.identity, outcome);
  const error: UpdateError | null =
    "failure" in outcome
      ? outcome.failure
      : checked?.kind === "error"
        ? updateError(checked.code, checked.context)
        : null;
  let available: ObservedAvailable | null = null;
  if (!("failure" in outcome)) {
    if (checked?.kind === "available")
      available = Object.freeze({
        version: checked.version,
        artifactSha256: checked.artifactSha256,
        length: checked.length,
        sequence: checked.sequence,
        minimumVersion: outcome.document.minimumVersion,
        verifiedAt: at,
      });
  } else if (
    previous.channel === input.channel &&
    previous.available &&
    compareVersions(previous.available.version, input.identity.version) > 0
  )
    available = previous.available;
  return Object.freeze({
    schemaVersion: 1,
    observedAt: at,
    operationId,
    status: error
      ? "error"
      : checked?.kind === "available"
        ? "available"
        : "up-to-date",
    channel: input.channel,
    lastAuthenticatedCheckAt:
      "failure" in outcome
        ? previous.channel === input.channel
          ? previous.lastAuthenticatedCheckAt
          : null
        : at,
    checkedBy: input.identity,
    selected: await readSelected(input.base, now),
    running: previous.running,
    available,
    lastHealthyActivation: previous.lastHealthyActivation,
    belowMinimumVersion:
      "failure" in outcome
        ? previous.channel === input.channel && previous.belowMinimumVersion
        : compareVersions(
            input.identity.version,
            outcome.document.minimumVersion,
          ) < 0,
    releaseNotes: null,
    downloadPercent: null,
    error,
    canRetry: error ? updateErrors[error.code].retryable : false,
  });
}
