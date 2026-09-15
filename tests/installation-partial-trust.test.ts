import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPilotFixture } from "../scripts/tuf-fixture";
import {
  downloadPilotUnderOwner,
  readPublishedPilotTrust,
  recoverPilotAttempts,
} from "../src/distribution/installation-state";

for (const blockedPath of [
  "/metadata/snapshot.json",
  "/targets/channels/pilot.json",
]) {
  test(`bootstrap interruption at ${blockedPath} retains partial trust rather than permitting bootstrap reset`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "partial-pilot-trust-")),
    );
    const fixture = createPilotFixture({
      artifact: Buffer.from("not executed"),
      identity: Buffer.from("{}"),
      executionTarget: "linux-arm64",
    });
    fixture.publish(7);
    let requests = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const path = new URL(request.url).pathname;
        if (path === blockedPath)
          return new Response("fixture interrupted", { status: 404 });
        return fetch(new URL(path, fixture.origin));
      },
    });
    const options = {
      root,
      bootstrapRoot: fixture.rootBytes.toString(),
      executionTarget: "linux-arm64",
      metadataBaseUrl: `${proxy.url}metadata/`,
      targetBaseUrl: `${proxy.url}targets/`,
      allowedOrigins: [proxy.url.origin],
      loopbackFixture: true,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      maxArtifactBytes: 1024,
    };
    try {
      await expect(downloadPilotUnderOwner(options)).rejects.toThrow();
      const attempts = await readdir(join(root, "attempts"));
      expect(attempts).toHaveLength(1);
      const attempt = join(root, "attempts", attempts[0] ?? "missing");
      const inputBefore = await readFile(join(attempt, "input-trust.json"));
      const journal = join(attempt, "received-metadata");
      const records = await readdir(journal);
      expect(records).toContain("001-timestamp.json");
      const timestampBefore = await readFile(
        join(journal, "001-timestamp.json"),
      );
      // The client persisted this timestamp before the fixture interrupted it.
      expect(
        JSON.parse(
          await readFile(join(attempt, "metadata/timestamp.json"), "utf8"),
        ).signed.version,
      ).toBe(7);
      const requestCount = requests;
      for (let retry = 0; retry < 2; retry++) {
        await expect(recoverPilotAttempts(options)).rejects.toThrow(
          "Partial trust remains pending",
        );
        expect(await readdir(join(root, "attempts"))).toEqual(attempts);
        expect(await readdir(join(root, "history"))).toEqual([]);
        expect(await readPublishedPilotTrust(root)).toBeNull();
        expect(await readFile(join(attempt, "input-trust.json"))).toEqual(
          inputBefore,
        );
        expect(await readFile(join(journal, "001-timestamp.json"))).toEqual(
          timestampBefore,
        );
        expect(await readdir(journal)).toEqual(records);
        await expect(
          downloadPilotUnderOwner({ ...options, bootstrapRoot: "{}" }),
        ).rejects.toThrow("Pending installation attempt");
      }
      expect(requests).toBe(requestCount);
    } finally {
      await proxy.stop(true);
      await fixture.stop();
      await rm(root, { recursive: true });
    }
  });
}
