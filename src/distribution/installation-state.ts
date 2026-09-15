import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import {
  readOwnedDeclarationBytes,
  readOwnedJson,
} from "../providers/owned-json";
import { type ChannelSelection, selectPilotTarget } from "./channel";
import { downloadPilotCandidate, type PilotTrust } from "./download-pilot";
import { type PilotReplayNetwork, replayPilotTrust } from "./replay-pilot";
import {
  exactFields,
  readTrustCheckpoint,
  type TrustCheckpoint,
  writeNewTrustCheckpoint,
} from "./trust-checkpoint";

/** One installation state owner per explicit root directory. Layout:
 * `attempts/<id>` pending download evidence, `history/<id>` closed attempts
 * (retained, never pruned here), `trust/<generation>/trust.json` immutable
 * verified metadata and `trust/selected.json` the single published record of
 * generation plus channel high-water. All mutation runs under the root's
 * operation lock. Nothing here stages, activates or executes a candidate.
 */
export type EstablishedPilotTrust = Extract<
  PilotTrust,
  { kind: "established" }
>;
export type PublishedPilotTrust = Readonly<{
  generation: string;
  trust: EstablishedPilotTrust;
}>;
export type PilotCandidate = Readonly<{
  path: string;
  sha256: string;
  length: number;
}>;
export type RecoveredAttempt = Readonly<{
  attempt: string;
  published: boolean;
  candidate: PilotCandidate | null;
}>;

const identifier = /^[a-z0-9][a-z0-9-]{0,63}$/;
const nextSelection = "selected.json.next";

/** null only when this owner never published trust. A missing or damaged
 * selection with existing generations fails closed: it is never first install
 * and never permission to adopt another readable generation.
 */
export async function readPublishedPilotTrust(
  root: string,
): Promise<PublishedPilotTrust | null> {
  await inspectOwnedDirectory(root);
  return readPublished(join(root, "trust"), []);
}

async function readPublished(
  trust: string,
  pendingAttempts: readonly string[],
): Promise<PublishedPilotTrust | null> {
  // Only a genuinely absent directory may mean first install; an existing
  // entry must pass custody before its emptiness is believed.
  try {
    await inspectOwnedDirectory(trust);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const entries = await readdir(trust);
  if (entries.length === 0) return null;
  if (!entries.includes("selected.json")) {
    // Only an interrupted first publication of a still-pending attempt may
    // leave generations without a selection; anything else is damage.
    if (
      entries.every(
        (entry) => entry === nextSelection || pendingAttempts.includes(entry),
      )
    )
      return null;
    throw new Error("Trust selection missing; installation requires recovery");
  }
  const selection = exactFields(
    await readOwnedJson(join(trust, "selected.json")),
    ["channel", "generation", "schemaVersion"],
  );
  if (
    selection.schemaVersion !== 1 ||
    typeof selection.generation !== "string" ||
    !identifier.test(selection.generation)
  )
    throw new Error("Invalid trust selection");
  const channel = parseChannel(selection.channel);
  const checkpoint = await readTrustCheckpoint(
    join(trust, selection.generation),
  );
  return Object.freeze({
    generation: selection.generation,
    trust: Object.freeze({ kind: "established" as const, checkpoint, channel }),
  });
}

function parseChannel(input: unknown) {
  const channel = exactFields(input, ["documentSha256", "sequence"]);
  if (
    !Number.isSafeInteger(channel.sequence) ||
    (channel.sequence as number) < 1 ||
    typeof channel.documentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(channel.documentSha256)
  )
    throw new Error("Invalid published channel high-water");
  return Object.freeze({
    sequence: channel.sequence as number,
    documentSha256: channel.documentSha256,
  });
}

type Network = {
  executionTarget: string;
  metadataBaseUrl: string;
  targetBaseUrl: string;
  allowedOrigins: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
  maxArtifactBytes: number;
  loopbackFixture?: boolean;
};

/** Verified download under the owner. Uses the published trust, or the caller's
 * bootstrap root only while nothing was ever published. A pending attempt must
 * be recovered first; a failed attempt stays pending with its evidence.
 */
export async function downloadPilotUnderOwner(
  options: { root: string; bootstrapRoot?: string } & Network,
): Promise<{
  attempt: string;
  published: PublishedPilotTrust;
  candidate: PilotCandidate;
}> {
  await inspectOwnedDirectory(options.root);
  return withFolderOperationLock(options.root, async (assertHeld) => {
    const layout = await openLayout(options.root);
    const pending = await listAttempts(layout.attempts);
    if (pending.length)
      throw new Error(
        `Pending installation attempt requires recovery: ${pending.join(", ")}`,
      );
    const published = await readPublished(layout.trust, []);
    let trust: PilotTrust;
    if (published) {
      if (options.bootstrapRoot !== undefined)
        throw new Error("Established trust present; bootstrap refused");
      trust = published.trust;
    } else {
      if (options.bootstrapRoot === undefined)
        throw new Error("Bootstrap root required for the first pilot download");
      trust = { kind: "bootstrap", trustedRoot: options.bootstrapRoot };
    }
    const attempt = randomBytes(16).toString("hex");
    const directory = join(layout.attempts, attempt);
    const downloaded = await downloadPilotCandidate({
      directory,
      trust,
      executionTarget: options.executionTarget,
      metadataBaseUrl: options.metadataBaseUrl,
      targetBaseUrl: options.targetBaseUrl,
      allowedOrigins: options.allowedOrigins,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxArtifactBytes: options.maxArtifactBytes,
      ...(options.loopbackFixture === undefined
        ? {}
        : { loopbackFixture: options.loopbackFixture }),
    });
    await assertHeld();
    const result = await publish(
      layout.trust,
      attempt,
      downloaded.checkpoint,
      downloaded.selection,
    );
    const closed = await close(layout, attempt);
    const candidate = await describeCandidate(
      closed,
      options.executionTarget,
      downloaded.selection,
    );
    if (!candidate)
      throw new Error("Downloaded candidate failed reverification");
    return Object.freeze({ attempt, published: result, candidate });
  });
}

/** Reconciles every pending attempt in order under the lock. Without received
 * metadata nothing was accepted and the attempt is closed. Otherwise the attempt
 * input must match the published trust (or the caller's bootstrap root before
 * any publication), the transcript is replayed offline and the accepted state
 * is published before the attempt closes. Explicit network options can complete
 * missing responses after a still-valid prefix; they cannot skip old evidence.
 * Expired or inconsistent evidence
 * stops recovery and keeps the attempt pending; nothing resets to bootstrap.
 */
export async function recoverPilotAttempts(options: {
  root: string;
  bootstrapRoot?: string;
  executionTarget: string;
  network?: PilotReplayNetwork;
}): Promise<readonly RecoveredAttempt[]> {
  // One deadline across this owner operation, not a fresh timeout for every
  // pending attempt. Each replay's transport shares this cancellation signal.
  const network = options.network
    ? {
        ...options.network,
        allowedOrigins: [...options.network.allowedOrigins],
        signal: AbortSignal.any([
          options.network.signal,
          AbortSignal.timeout(options.network.timeoutMs),
        ]),
      }
    : undefined;
  await inspectOwnedDirectory(options.root);
  return withFolderOperationLock(options.root, async (assertHeld) => {
    const layout = await openLayout(options.root);
    const pending = await listAttempts(layout.attempts);
    // Damaged published state is reported even when nothing is pending.
    await readPublished(layout.trust, pending);
    const results: RecoveredAttempt[] = [];
    for (const attempt of pending) {
      const directory = join(layout.attempts, attempt);
      await inspectOwnedDirectory(directory);
      let records: string[];
      try {
        records = await readdir(join(directory, "received-metadata"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        records = [];
      }
      const published = await readPublished(layout.trust, pending);
      if (records.length === 0) {
        // No response ever reached the client; only the input was retained.
        await assertHeld();
        await close(layout, attempt);
        results.push(
          Object.freeze({ attempt, published: false, candidate: null }),
        );
        continue;
      }
      if (published?.generation === attempt) {
        // Publication completed; only closing the attempt was interrupted.
        await assertHeld();
        const closed = await close(layout, attempt);
        const selection = await closedSelection(
          closed,
          options.executionTarget,
          published.trust.channel,
        );
        results.push(
          Object.freeze({
            attempt,
            published: false,
            candidate: selection
              ? await describeCandidate(
                  closed,
                  options.executionTarget,
                  selection,
                )
              : null,
          }),
        );
        continue;
      }
      await bindAttemptInput(directory, published, options.bootstrapRoot);
      let replay: Awaited<ReturnType<typeof replayPilotTrust>>;
      try {
        replay = await replayPilotTrust(
          directory,
          join(directory, `replay-${randomBytes(8).toString("hex")}`),
          options.executionTarget,
          network,
        );
      } catch (error) {
        throw new Error(
          `Attempt ${attempt} recovery refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      const checkpoint = replay.checkpoint;
      network?.signal.throwIfAborted();
      const channel =
        replay.outcome === "complete"
          ? replay.selection
          : published?.trust.channel;
      await assertHeld();
      let didPublish = false;
      // Received metadata may already have advanced root/role versions even
      // before a complete checkpoint or first channel exists. Closing here
      // would permit a new bootstrap and forget those accepted floors. Keep
      // the original attempt as the exclusion barrier until partial trust can
      // be durably carried into a fresh network recovery. No-progress attempts
      // with zero received records are handled separately above.
      if (!checkpoint || !channel)
        throw new Error(
          `Partial trust remains pending for attempt ${attempt}; network recovery required`,
        );
      if (checkpoint && channel) {
        const unchanged =
          published !== null &&
          sameMetadata(published.trust.checkpoint, checkpoint) &&
          published.trust.channel.sequence === channel.sequence &&
          published.trust.channel.documentSha256 === channel.documentSha256;
        if (!unchanged) {
          await publish(layout.trust, attempt, checkpoint, channel);
          didPublish = true;
        }
      }
      const closed = await close(layout, attempt);
      results.push(
        Object.freeze({
          attempt,
          published: didPublish,
          candidate:
            replay.outcome === "complete"
              ? await describeCandidate(
                  closed,
                  options.executionTarget,
                  replay.selection,
                )
              : null,
        }),
      );
    }
    return Object.freeze(results);
  });
}

// Materializes the owner layout only while the operation lock is held.
async function openLayout(root: string) {
  await inspectOwnedDirectory(root);
  const layout = {
    attempts: join(root, "attempts"),
    history: join(root, "history"),
    trust: join(root, "trust"),
  };
  for (const path of Object.values(layout)) await ensureOwnedDirectory(path);
  return layout;
}

async function ensureOwnedDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await inspectOwnedDirectory(path);
}

async function listAttempts(attempts: string) {
  const entries = (await readdir(attempts)).sort();
  for (const entry of entries)
    if (!identifier.test(entry))
      throw new Error(`Unrecognized installation attempt entry: ${entry}`);
  return entries;
}

function sameMetadata(left: TrustCheckpoint, right: TrustCheckpoint) {
  return (["root", "timestamp", "snapshot", "targets"] as const).every(
    (role) => left.metadata[role] === right.metadata[role],
  );
}

async function bindAttemptInput(
  directory: string,
  published: PublishedPilotTrust | null,
  bootstrapRoot: string | undefined,
) {
  const input = exactFields(
    await readOwnedJson(join(directory, "input-trust.json")),
    ["channel", "kind", "metadata", "schemaVersion"],
  );
  if (input.schemaVersion !== 1)
    throw new Error("Unsupported attempt trust input");
  if (published) {
    if (input.kind !== "established")
      throw new Error("Attempt did not start from the published trust");
    const metadata = exactFields(input.metadata, [
      "root",
      "timestamp",
      "snapshot",
      "targets",
    ]);
    const channel = parseChannel(input.channel);
    if (
      !sameMetadata(published.trust.checkpoint, {
        schemaVersion: 1,
        metadata: metadata as Record<
          "root" | "timestamp" | "snapshot" | "targets",
          string
        >,
      }) ||
      channel.sequence !== published.trust.channel.sequence ||
      channel.documentSha256 !== published.trust.channel.documentSha256
    )
      throw new Error("Attempt trust input does not match published trust");
    return;
  }
  if (bootstrapRoot === undefined)
    throw new Error(
      "Bootstrap root required to recover an unpublished attempt",
    );
  const metadata = exactFields(input.metadata, ["root"]);
  if (
    input.kind !== "bootstrap" ||
    input.channel !== null ||
    metadata.root !== bootstrapRoot
  )
    throw new Error("Attempt trust input does not match the bootstrap root");
}

async function publish(
  trust: string,
  generation: string,
  checkpoint: TrustCheckpoint,
  channel: Pick<ChannelSelection, "sequence" | "documentSha256">,
): Promise<PublishedPilotTrust> {
  const directory = join(trust, generation);
  let existing = false;
  try {
    await lstat(directory);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    // An interrupted publication may have written this generation already.
    if (!sameMetadata(await readTrustCheckpoint(directory), checkpoint))
      throw new Error("Conflicting trust generation already exists");
  } else await writeNewTrustCheckpoint(directory, checkpoint);
  // The transient file is this owner's own, created only under the lock; a
  // leftover proves an interrupted publication and is never read as trust.
  const next = join(trust, nextSelection);
  await rm(next, { force: true });
  const record = JSON.stringify({
    schemaVersion: 1,
    generation,
    channel: {
      sequence: channel.sequence,
      documentSha256: channel.documentSha256,
    },
  });
  const file = await open(next, "wx", 0o600);
  try {
    await file.writeFile(record);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(next, join(trust, "selected.json"));
  await syncDirectory(trust);
  return Object.freeze({
    generation,
    trust: Object.freeze({
      kind: "established" as const,
      checkpoint,
      channel: Object.freeze({
        sequence: channel.sequence,
        documentSha256: channel.documentSha256,
      }),
    }),
  });
}

async function close(
  layout: { attempts: string; history: string },
  attempt: string,
) {
  const closed = join(layout.history, attempt);
  await rename(join(layout.attempts, attempt), closed);
  await syncDirectory(layout.attempts);
  await syncDirectory(layout.history);
  return closed;
}

/** Selection of a closed attempt, valid only while its channel bytes still equal
 * the published high-water; older closed attempts are not selectable again.
 */
export async function closedSelection(
  directory: string,
  executionTarget: string,
  channel: Pick<ChannelSelection, "sequence" | "documentSha256">,
): Promise<ChannelSelection | null> {
  let bytes: Buffer;
  try {
    bytes = await readOwnedDeclarationBytes(join(directory, "channel.json"));
  } catch {
    return null;
  }
  if (
    createHash("sha256").update(bytes).digest("hex") !== channel.documentSha256
  )
    return null;
  try {
    return selectPilotTarget(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      executionTarget,
      channel,
    );
  } catch {
    return null;
  }
}

// Reverifies retained bytes against the authenticated selection; a mismatch or
// unsafe file yields no candidate and the closed evidence is left untouched.
export async function describeCandidate(
  directory: string,
  executionTarget: string,
  selection: ChannelSelection,
): Promise<PilotCandidate | null> {
  const path = join(
    directory,
    executionTarget.startsWith("windows-") ? "lazurio.exe" : "lazurio",
  );
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    return null;
  const file = await open(path, "r");
  const digest = createHash("sha256");
  let length = 0;
  try {
    const opened = await file.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      digest.update(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
  } finally {
    await file.close();
  }
  const sha256 = digest.digest("hex");
  if (sha256 !== selection.targetPath.split("/")[1] || length !== stat.size)
    return null;
  return Object.freeze({ path, sha256, length });
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
