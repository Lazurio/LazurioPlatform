import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPilotFixture } from "../scripts/tuf-fixture";
import { downloadPilotCandidate } from "../src/distribution/download-pilot";
import { parseTrustCheckpoint } from "../src/distribution/trust-checkpoint";

// The input is a synthetic *previously trusted complete cache*. This does not
// authenticate a pending transcript or establish trust in arbitrary cache files.
// No clock overrides: final network metadata must pass the real client's clock.
for (const nextVersion of [6, 7, 8]) {
  test(`expired trusted cache refresh with version ${nextVersion} preserves version and freshness rules`, async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "expired-refresh-")),
    );
    const fixture = createPilotFixture({
      artifact: Buffer.from("verified bytes, never executed"),
      identity: Buffer.from("{}"),
      executionTarget: "linux-arm64",
    });
    try {
      fixture.publish(7, new Date(Date.now() - 86_400_000).toISOString());
      const metadata: Record<string, string> = {
        root: fixture.rootBytes.toString(),
      };
      for (const role of ["timestamp", "snapshot", "targets"]) {
        const response = await fetch(`${fixture.metadataBaseUrl}${role}.json`);
        expect(response.ok).toBe(true);
        metadata[role] = await response.text();
      }
      const channelResponse = await fetch(
        `${fixture.targetBaseUrl}channels/pilot.json`,
      );
      const channel = Buffer.from(await channelResponse.arrayBuffer());
      const checkpoint = parseTrustCheckpoint({ schemaVersion: 1, metadata });
      const before = JSON.stringify(checkpoint);
      const trust = {
        kind: "established" as const,
        checkpoint,
        channel: {
          sequence: 7,
          documentSha256: createHash("sha256").update(channel).digest("hex"),
        },
      };
      fixture.publish(nextVersion); // Fresh dates; version7 must still be refused.
      const operation = downloadPilotCandidate({
        directory: join(parent, "attempt"),
        trust,
        executionTarget: "linux-arm64",
        metadataBaseUrl: fixture.metadataBaseUrl,
        targetBaseUrl: fixture.targetBaseUrl,
        allowedOrigins: [fixture.origin],
        loopbackFixture: true,
        timeoutMs: 5000,
        signal: new AbortController().signal,
        maxArtifactBytes: 1024,
      });
      if (nextVersion === 8) {
        const result = await operation;
        expect(result.selection.sequence).toBe(8);
        expect(
          JSON.parse(result.checkpoint.metadata.timestamp).signed.version,
        ).toBe(8);
        expect(
          JSON.parse(result.checkpoint.metadata.snapshot).signed.version,
        ).toBe(8);
      } else {
        await expect(operation).rejects.toThrow();
      }
      expect(JSON.stringify(checkpoint)).toBe(before);
    } finally {
      await fixture.stop();
      await rm(parent, { recursive: true });
    }
  });
}
