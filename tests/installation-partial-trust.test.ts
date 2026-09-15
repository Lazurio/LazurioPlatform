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
    let blocked: string | undefined = blockedPath;
    let artifactRequests = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const path = new URL(request.url).pathname;
        if (path.includes("/artifacts/")) artifactRequests++;
        if (path === blocked)
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
      if (blockedPath === "/metadata/snapshot.json") {
        // A second interruption retains the newly appended snapshot too.
        blocked = "/metadata/targets.json";
        await expect(
          recoverPilotAttempts({ ...options, network: options }),
        ).rejects.toThrow("Partial trust remains pending");
        expect(await readdir(journal)).toContain("002-snapshot.json");
        expect(await readFile(join(journal, "001-timestamp.json"))).toEqual(
          timestampBefore,
        );
      }
      blocked = undefined;
      expect(
        await recoverPilotAttempts({ ...options, network: options }),
      ).toEqual([
        { attempt: attempts[0] ?? "missing", published: true, candidate: null },
      ]);
      expect(artifactRequests).toBe(0);
      expect(await readdir(join(root, "attempts"))).toEqual([]);
      const closed = join(root, "history", attempts[0] ?? "missing");
      expect(await readFile(join(closed, "input-trust.json"))).toEqual(
        inputBefore,
      );
      expect(
        await readFile(join(closed, "received-metadata/001-timestamp.json")),
      ).toEqual(timestampBefore);
      expect(
        (await readPublishedPilotTrust(root))?.trust.channel.sequence,
      ).toBe(7);
      const { bootstrapRoot: _bootstrapRoot, ...establishedOptions } = options;
      const downloaded = await downloadPilotUnderOwner(establishedOptions);
      expect(downloaded.candidate.sha256).toBe(fixture.artifactSha256);
    } finally {
      await proxy.stop(true);
      await fixture.stop();
      await rm(root, { recursive: true });
    }
  });
}
