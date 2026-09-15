import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { type Fetcher, Updater } from "tuf-js";
import { DownloadHTTPError, ExpiredMetadataError } from "tuf-js/dist/error";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import {
  readOwnedDeclarationBytes,
  readOwnedJson,
} from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import { type ChannelSelection, selectPilotTarget } from "./channel";
import {
  MetadataJournalFetcher,
  readMetadataJournal,
} from "./metadata-journal";
import { DistributionTransport } from "./transport";
import {
  parseTrustCheckpoint,
  type TrustCheckpoint,
  writeNewTrustCheckpoint,
} from "./trust-checkpoint";

export type PilotReplay = Readonly<
  | {
      outcome: "complete";
      checkpoint: TrustCheckpoint;
      selection: ChannelSelection;
    }
  | {
      /** Metadata accepted before a deterministic refusal of the final record,
       * before the transcript ended, or before the channel was received. The
       * caller keeps its previous channel high-water; null means the accepted
       * state has no complete role set (bootstrap before its first refresh).
       */
      outcome: "partial";
      checkpoint: TrustCheckpoint | null;
      refused: string;
    }
>;

const roles = ["root", "timestamp", "snapshot", "targets"] as const;

export type PilotReplayNetwork = Readonly<{
  metadataBaseUrl: string;
  targetBaseUrl: string;
  allowedOrigins: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
  loopbackFixture?: boolean;
}>;

// The pinned client wraps snapshot/targets failures in RuntimeError, so the
// expiry class alone cannot be relied on; the message is stable in tuf-js 6.0.0.
function isExpiry(error: unknown) {
  return (
    error instanceof ExpiredMetadataError ||
    (error instanceof Error && /expired/i.test(error.message))
  );
}

/** Bounded reverification, offline by default. Explicit network options may
 * complete only the missing end of a still-valid transcript, appending responses
 * durably before consumption and retaining a verified missing channel. Existing
 * source bytes are never rewritten. This is not expired-metadata refresh.
 * Not a general
 * crash-recovery owner: the caller must serialize access and publish the returned
 * trust before a new attempt. The owner must bind source to its recorded attempt
 * and trusted original input; filesystem ownership alone does not authenticate an
 * arbitrary bootstrap root. No product artifact download or execution is reachable.
 * A partial outcome reproduces only what the original process could itself have
 * accepted: expiry at replay time, altered or unconsumed records fail closed.
 */
export async function replayPilotTrust(
  source: string,
  output: string,
  executionTarget: string,
  network?: PilotReplayNetwork,
): Promise<PilotReplay> {
  network?.signal.throwIfAborted();
  await inspectOwnedDirectory(source);
  const input = (await readOwnedJson(
    join(source, "input-trust.json"),
  )) as Record<string, unknown>;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !==
      "channel,kind,metadata,schemaVersion" ||
    input.schemaVersion !== 1
  )
    throw new Error("Invalid retained pilot input");
  let metadata: Readonly<Record<string, string>>;
  let previous: { sequence: number; documentSha256: string } | undefined;
  if (input.kind === "established") {
    metadata = parseTrustCheckpoint({
      schemaVersion: 1,
      metadata: input.metadata,
    }).metadata;
    const channel = input.channel as Record<string, unknown>;
    if (
      !channel ||
      typeof channel !== "object" ||
      Array.isArray(channel) ||
      Object.keys(channel).sort().join(",") !== "documentSha256,sequence" ||
      !Number.isSafeInteger(channel.sequence) ||
      (channel.sequence as number) < 1 ||
      typeof channel.documentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(channel.documentSha256)
    )
      throw new Error("Invalid retained channel high-water");
    previous = {
      sequence: channel.sequence as number,
      documentSha256: channel.documentSha256,
    };
  } else if (input.kind === "bootstrap") {
    const candidate = input.metadata as Record<string, unknown>;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).join(",") !== "root" ||
      typeof candidate.root !== "string" ||
      input.channel !== null
    )
      throw new Error("Invalid retained bootstrap");
    metadata = { root: candidate.root };
    parseUniqueJson(candidate.root);
  } else throw new Error("Unknown retained trust kind");

  const journal = join(source, "received-metadata");
  const { records, bytes: length } = await readMetadataJournal(journal);
  await inspectOwnedDirectory(dirname(output));
  await mkdir(output, { mode: 0o700 });
  const cache = join(output, "metadata");
  await mkdir(cache, { mode: 0o700 });
  for (const [role, bytes] of Object.entries(metadata))
    await writeFile(join(cache, `${role}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  let cursor = 0;
  let exhausted = false;
  const base = "https://replay.invalid/metadata/";
  const continuation = network ? { ...network } : undefined;
  const transport = continuation
    ? new DistributionTransport(
        continuation.allowedOrigins,
        continuation.timeoutMs,
        continuation.signal,
        continuation.loopbackFixture ?? false,
      )
    : undefined;
  const append =
    transport && continuation
      ? new MetadataJournalFetcher(
          transport,
          journal,
          continuation.metadataBaseUrl,
          { records: records.length, bytes: length },
        )
      : undefined;
  const fetcher: Fetcher = {
    async downloadBytes(url, maxLength) {
      if (!url.startsWith(base)) throw new Error("Unexpected replay origin");
      const name = url.slice(base.length);
      const record = records[cursor];
      if (record?.name === name) {
        if (record.bytes.length > maxLength)
          throw new Error("Replay metadata length refused");
        cursor++;
        return record.bytes;
      }
      // Only the end of the complete retained prefix permits network use.
      // No gap, reordering, refused response or expired role is skipped.
      // Append before handing bytes to TUF so a further interruption replays
      // the same original input plus the extended, immutable response prefix.
      if (cursor === records.length && append && continuation) {
        const bytes = await append.downloadBytes(
          new URL(name, continuation.metadataBaseUrl).href,
          maxLength,
        );
        records.push({ name, bytes });
        cursor++;
        return bytes;
      }
      if (
        /^[1-9][0-9]*\.root\.json$/.test(name) &&
        !records
          .slice(cursor)
          .some((entry) => entry.name.endsWith(".root.json"))
      )
        throw new DownloadHTTPError("No further received root", 404);
      if (cursor === records.length) {
        exhausted = true;
        throw new Error("Replay evidence ends before this metadata");
      }
      throw new Error("Missing or out-of-order replay response");
    },
    async downloadFile(url, maxLength, handler) {
      if (!transport) throw new Error("Replay cannot download artifacts");
      // Only the authenticated channel below calls this method; recovery
      // never fetches, stages or executes a product artifact.
      return transport.downloadFile(url, maxLength, handler);
    },
  };
  const updater = new Updater({
    metadataDir: cache,
    metadataBaseUrl: base,
    ...(continuation ? { targetBaseUrl: continuation.targetBaseUrl } : {}),
    fetcher,
    config: { fetchRetries: 0, fetchRetry: false, maxDelegations: 0 },
  });
  let refused: string | undefined;
  try {
    await updater.refresh();
  } catch (error) {
    // Only a deterministic refusal of the final record or a transcript that
    // ends before the next request reproduces the original process's state.
    // Expiry depends on replay time and cannot prove the original refused it.
    if (cursor !== records.length || isExpiry(error)) throw error;
    refused = exhausted
      ? "Retained metadata ends before the next required response"
      : error instanceof Error
        ? error.message
        : String(error);
  }
  if (cursor !== records.length) throw new Error("Unconsumed replay evidence");
  const persisted: Record<string, string> = {};
  for (const role of roles) {
    try {
      persisted[role] = await readFile(join(cache, `${role}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const complete = roles.every((role) => role in persisted);
  const checkpoint = complete
    ? parseTrustCheckpoint({ schemaVersion: 1, metadata: persisted })
    : null;
  const partial = async (reason: string): Promise<PilotReplay> => {
    if (checkpoint)
      await writeNewTrustCheckpoint(join(output, "checkpoint"), checkpoint);
    await syncDirectory(dirname(output));
    return Object.freeze({ outcome: "partial", checkpoint, refused: reason });
  };
  if (refused !== undefined) return partial(refused);
  if (!checkpoint) throw new Error("Replay accepted an incomplete role set");
  const target = await updater.getTargetInfo("channels/pilot.json");
  if (!target || target.length > 64 * 1024)
    return partial("Replay channel unavailable or oversized");
  const channelPath = join(source, "channel.json");
  try {
    await lstat(channelPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!continuation)
      return partial("Channel was not received before the failure");
    // Precreate the private output with explicit custody even under umask002.
    // TUF verifies the download before it can become retained source evidence.
    const receivedPath = join(output, "received-channel.json");
    const reserved = await open(receivedPath, "wx", 0o600);
    await reserved.close();
    await updater.downloadTarget(target, receivedPath);
    const receivedBytes = await readOwnedDeclarationBytes(receivedPath);
    continuation.signal.throwIfAborted();
    const retained = await open(channelPath, "wx", 0o600);
    try {
      await retained.writeFile(receivedBytes);
      await retained.sync();
    } finally {
      await retained.close();
    }
    await syncDirectory(source);
  }
  // A present channel was verified before its copy; an altered copy is refused.
  const channelBytes = await readOwnedDeclarationBytes(channelPath);
  await target.verify(Readable.from([channelBytes]));
  let selection: ChannelSelection;
  try {
    selection = selectPilotTarget(
      new TextDecoder("utf-8", { fatal: true }).decode(channelBytes),
      executionTarget,
      previous,
    );
  } catch (error) {
    return partial(error instanceof Error ? error.message : String(error));
  }
  const channel = await open(join(output, "channel.json"), "wx", 0o600);
  try {
    await channel.writeFile(channelBytes);
    await channel.sync();
  } finally {
    await channel.close();
  }
  await writeNewTrustCheckpoint(join(output, "checkpoint"), checkpoint);
  // Sync the new output's name too, not only its contents.
  await syncDirectory(dirname(output));
  return Object.freeze({ outcome: "complete", checkpoint, selection });
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
