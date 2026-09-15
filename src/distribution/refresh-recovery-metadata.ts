import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Updater } from "tuf-js";
import {
  assertCheckpointRetainsFloors,
  type HistoricalFloors,
} from "./historical-roles";
import { beginRecoveryMetadataCycle } from "./recovery-cycles";
import { DistributionTransport } from "./transport";
import { parseTrustCheckpoint } from "./trust-checkpoint";

/** Metadata-only fresh refresh, not an installable result. Caller owns the lock
 * and original authenticated evidence. No channel, target or publication API is
 * used here; the owner integration must still preserve channel high-water.
 */
export async function refreshRecoveryMetadata(
  options: Readonly<{
    attempt: string;
    original: HistoricalFloors;
    executionTarget: string;
    assertHeld: () => Promise<void>;
    metadataBaseUrl: string;
    allowedOrigins: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
    loopbackFixture?: boolean;
  }>,
) {
  const input = { ...options };
  input.signal.throwIfAborted();
  const transport = new DistributionTransport(
    input.allowedOrigins,
    input.timeoutMs,
    input.signal,
    input.loopbackFixture ?? false,
  );
  const cycle = await beginRecoveryMetadataCycle(
    input.attempt,
    input.original,
    input.executionTarget,
    input.assertHeld,
    transport,
    input.metadataBaseUrl,
  );
  await input.assertHeld();
  // Disposable client cache outside the immutable ledger. Never adopted on a
  // later invocation, and never used as recovery authority after interruption.
  const cache = await mkdtemp(join(input.attempt, ".fresh-metadata-"));
  await writeFile(join(cache, "root.json"), cycle.floors.root, {
    flag: "wx",
    mode: 0o600,
  });
  await input.assertHeld();
  const updater = new Updater({
    metadataDir: cache,
    metadataBaseUrl: input.metadataBaseUrl,
    fetcher: {
      async downloadBytes(url, maxLength) {
        await input.assertHeld();
        input.signal.throwIfAborted();
        const bytes = await cycle.fetcher.downloadBytes(url, maxLength);
        await input.assertHeld();
        return bytes;
      },
      async downloadFile() {
        throw new Error("Metadata recovery cannot download targets");
      },
    },
    config: { fetchRetries: 0, fetchRetry: false, maxDelegations: 0 },
  });
  await updater.refresh(); // Real clock, normal signatures and metadata links.
  await input.assertHeld();
  const metadata: Record<string, string> = {};
  for (const role of ["root", "timestamp", "snapshot", "targets"])
    metadata[role] = await readFile(join(cache, `${role}.json`), "utf8");
  const checkpoint = parseTrustCheckpoint({ schemaVersion: 1, metadata });
  assertCheckpointRetainsFloors(cycle.floors, checkpoint);
  input.signal.throwIfAborted();
  await input.assertHeld();
  return Object.freeze({
    kind: "fresh-metadata-only" as const,
    checkpoint,
    cycle: cycle.directory,
  });
}
