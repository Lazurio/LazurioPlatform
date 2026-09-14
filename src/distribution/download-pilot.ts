import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Updater } from "tuf-js";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { parseUniqueJson } from "../providers/unique-json";
import { type ChannelSelection, selectPilotTarget } from "./channel";
import { DistributionTransport } from "./transport";
import {
  parseTrustCheckpoint,
  type TrustCheckpoint,
  writeNewTrustCheckpoint,
} from "./trust-checkpoint";

export type PilotTrust =
  | Readonly<{ kind: "bootstrap"; trustedRoot: string }>
  | Readonly<{
      kind: "established";
      checkpoint: TrustCheckpoint;
      channel: Pick<ChannelSelection, "sequence" | "documentSha256">;
    }>;

/** Verified download, NOT installation or activation. The owner supplies trusted
 * bootstrap bytes OR its retained checkpoint and channel high-water mark. Missing
 * established state must never be converted to bootstrap by the caller.
 * Output is new and private; failures retain it, never changing an active path.
 */
export async function downloadPilotCandidate(options: {
  directory: string;
  trust: PilotTrust;
  executionTarget: string;
  metadataBaseUrl: string;
  targetBaseUrl: string;
  allowedOrigins: readonly string[];
  timeoutMs: number;
  signal: AbortSignal;
  maxArtifactBytes: number;
  loopbackFixture?: boolean;
}) {
  if (
    !Number.isSafeInteger(options.maxArtifactBytes) ||
    options.maxArtifactBytes < 1
  )
    throw new Error("Invalid candidate size policy");
  const fetcher = new DistributionTransport(
    options.allowedOrigins,
    options.timeoutMs,
    options.signal,
    options.loopbackFixture ?? false,
  );
  let metadata: Readonly<Record<string, string>>;
  let previous:
    | Pick<ChannelSelection, "sequence" | "documentSha256">
    | undefined;
  if (options.trust.kind === "established") {
    metadata = parseTrustCheckpoint(options.trust.checkpoint).metadata;
    previous = options.trust.channel;
    if (
      !previous ||
      !Number.isSafeInteger(previous.sequence) ||
      previous.sequence < 1 ||
      !/^[a-f0-9]{64}$/.test(previous.documentSha256)
    )
      throw new Error("Established channel state required");
  } else if (options.trust.kind === "bootstrap") {
    // Reject ambiguous JSON before the library consumes bootstrap input.
    parseUniqueJson(options.trust.trustedRoot);
    metadata = { root: options.trust.trustedRoot };
  } else {
    throw new Error("Explicit pilot trust state required");
  }
  options.signal.throwIfAborted();
  await inspectOwnedDirectory(dirname(options.directory));
  await mkdir(options.directory, { mode: 0o700 });
  const cache = join(options.directory, "metadata");
  await mkdir(cache, { mode: 0o700 });
  for (const [role, bytes] of Object.entries(metadata))
    await writeFile(join(cache, `${role}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  const updater = new Updater({
    fetcher,
    metadataDir: cache,
    metadataBaseUrl: options.metadataBaseUrl,
    targetBaseUrl: options.targetBaseUrl,
    config: { fetchRetries: 0, fetchRetry: false, maxDelegations: 0 },
  });
  await updater.refresh();
  const channelTarget = await updater.getTargetInfo("channels/pilot.json");
  if (!channelTarget || channelTarget.length > 64 * 1024)
    throw new Error("Pilot channel unavailable or too large");
  const channelPath = join(options.directory, "channel.json");
  await updater.downloadTarget(channelTarget, channelPath);
  const channelBytes = await readFile(channelPath);
  const selection = selectPilotTarget(
    new TextDecoder("utf-8", { fatal: true }).decode(channelBytes),
    options.executionTarget,
    previous,
  );
  const target = await updater.getTargetInfo(selection.targetPath);
  if (
    !target ||
    target.length < 1 ||
    target.length > options.maxArtifactBytes ||
    target.hashes.sha256 !== selection.targetPath.split("/")[1]
  )
    throw new Error("Selected artifact identity or size refused");
  const artifactPath = join(
    options.directory,
    options.executionTarget.startsWith("windows-") ? "lazurio.exe" : "lazurio",
  );
  await updater.downloadTarget(target, artifactPath);
  options.signal.throwIfAborted();
  // The library's destination copy is not itself a durability guarantee.
  for (const path of [channelPath, artifactPath]) {
    const file = await open(path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const verifiedMetadata: Record<string, string> = {};
  for (const role of ["root", "timestamp", "snapshot", "targets"])
    verifiedMetadata[role] = await readFile(
      join(cache, `${role}.json`),
      "utf8",
    );
  const checkpoint = parseTrustCheckpoint({
    schemaVersion: 1,
    metadata: verifiedMetadata,
  });
  await writeNewTrustCheckpoint(
    join(options.directory, "checkpoint"),
    checkpoint,
  );
  return Object.freeze({ artifactPath, checkpoint, selection });
}
