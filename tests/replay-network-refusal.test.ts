import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPilotFixture } from "../scripts/tuf-fixture";
import {
  downloadPilotUnderOwner,
  readPublishedPilotTrust,
  recoverPilotAttempts,
} from "../src/distribution/installation-state";

for (const refusal of [
  "expired",
  "altered",
  "gap",
  "cancelled",
  "channel-tamper",
] as const) {
  test(`network continuation cannot bypass ${refusal} retained evidence`, async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "replay-refusal-")),
    );
    const fixture = createPilotFixture({
      artifact: Buffer.from("never executed"),
      identity: Buffer.from("{}"),
      executionTarget: "linux-arm64",
    });
    fixture.publish(
      7,
      refusal === "expired"
        ? new Date(Date.now() - 86_400_000).toISOString()
        : undefined,
    );
    let blocked = true;
    let requests = 0;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const path = new URL(request.url).pathname;
        const blockedPath =
          refusal === "channel-tamper"
            ? "/targets/channels/pilot.json"
            : "/metadata/snapshot.json";
        if (blocked && path === blockedPath)
          return new Response("interrupted fixture", { status: 404 });
        if (!blocked && refusal === "channel-tamper" && path === blockedPath)
          return new Response("{}");
        return fetch(new URL(path, fixture.origin));
      },
    });
    const controller = new AbortController();
    const options = {
      root,
      bootstrapRoot: fixture.rootBytes.toString(),
      executionTarget: "linux-arm64",
      metadataBaseUrl: `${proxy.url}metadata/`,
      targetBaseUrl: `${proxy.url}targets/`,
      allowedOrigins: [proxy.url.origin],
      loopbackFixture: true,
      timeoutMs: 5000,
      signal: controller.signal,
      maxArtifactBytes: 1024,
    };
    try {
      await expect(downloadPilotUnderOwner(options)).rejects.toThrow();
      const attempts = await readdir(join(root, "attempts"));
      expect(attempts).toHaveLength(1);
      const attempt = join(root, "attempts", attempts[0] ?? "missing");
      const input = await readFile(join(attempt, "input-trust.json"));
      const journal = join(attempt, "received-metadata");
      const timestamp = join(journal, "001-timestamp.json");
      if (refusal === "altered") await writeFile(timestamp, "{}");
      if (refusal === "gap")
        await rename(timestamp, join(journal, "003-timestamp.json"));
      if (refusal === "cancelled") controller.abort();
      const records = await readdir(journal);
      const bytes = await Promise.all(
        records.map((name) => readFile(join(journal, name))),
      );
      const beforeRequests = requests;
      blocked = false;
      fixture.publish(8); // Fresh metadata exists, but cannot erase the retained prefix.
      await expect(
        recoverPilotAttempts({ ...options, network: options }),
      ).rejects.toThrow();
      expect(requests).toBe(
        beforeRequests + (refusal === "channel-tamper" ? 1 : 0),
      );
      await expect(readFile(join(attempt, "channel.json"))).rejects.toThrow();
      expect(await readdir(join(root, "attempts"))).toEqual(attempts);
      expect(await readdir(join(root, "history"))).toEqual([]);
      expect(await readPublishedPilotTrust(root)).toBeNull();
      expect(await readFile(join(attempt, "input-trust.json"))).toEqual(input);
      expect(await readdir(journal)).toEqual(records);
      expect(
        await Promise.all(records.map((name) => readFile(join(journal, name)))),
      ).toEqual(bytes);
    } finally {
      await proxy.stop(true);
      await fixture.stop();
      await rm(root, { recursive: true });
    }
  });
}
