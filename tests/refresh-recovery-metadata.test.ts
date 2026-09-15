import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater } from "tuf-js";
import { createPilotFixture } from "../scripts/tuf-fixture";
import { authenticateHistoricalRoles } from "../src/distribution/historical-roles";
import { reconstructRecoveryCycles } from "../src/distribution/recovery-cycles";
import { refreshRecoveryMetadata } from "../src/distribution/refresh-recovery-metadata";
import { withFolderOperationLock } from "../src/folder/lock";

for (const boundary of ["cache-write", "client-refresh"] as const) {
  test(`fresh metadata refuses lost custody at ${boundary} before client consumption`, async () => {
    const attempt = await realpath(
      await mkdtemp(join(tmpdir(), "fresh-custody-")),
    );
    const fixture = createPilotFixture({
      artifact: Buffer.from("never fetched"),
      identity: Buffer.from("{}"),
      executionTarget: "linux-arm64",
    });
    const requests: string[] = [];
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(path);
        return fetch(new URL(path, fixture.origin));
      },
    });
    let revoked = false;
    const originalRefresh = Updater.prototype.refresh;
    const refreshSpy = spyOn(Updater.prototype, "refresh").mockImplementation(
      async function (this: Updater) {
        await originalRefresh.call(this);
        if (boundary === "client-refresh") {
          revoked = true;
          const cache = (await readdir(attempt)).find((name) =>
            name.startsWith(".fresh-metadata-"),
          );
          if (!cache) throw new Error("Missing test cache");
          // If the owner reads/constructs a checkpoint before checking custody,
          // this produces a parse error rather than the required lock refusal.
          await writeFile(join(attempt, cache, "targets.json"), "not JSON");
        }
      },
    );
    try {
      fixture.publish(1);
      await expect(
        withFolderOperationLock(attempt, async (held) =>
          refreshRecoveryMetadata({
            attempt,
            original: authenticateHistoricalRoles(
              fixture.rootBytes.toString(),
              [],
            ),
            executionTarget: "linux-arm64",
            async assertHeld() {
              await held();
              if (boundary === "cache-write")
                revoked = (await readdir(attempt)).some((name) =>
                  name.startsWith(".fresh-metadata-"),
                );
              if (revoked) throw new Error("Test owner custody revoked");
            },
            metadataBaseUrl: `${proxy.url}metadata/`,
            allowedOrigins: [proxy.url.origin],
            timeoutMs: 5000,
            signal: new AbortController().signal,
            loopbackFixture: true,
          }),
        ),
      ).rejects.toThrow("Test owner custody revoked");
      if (boundary === "cache-write") {
        expect(refreshSpy).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
      }
      expect(requests.some((path) => path.startsWith("/targets/"))).toBe(false);
    } finally {
      refreshSpy.mockRestore();
      await proxy.stop(true);
      await fixture.stop();
      await rm(attempt, { recursive: true });
    }
  });
}

test("another interrupted refresh retains its timestamp across restart and refuses rollback", async () => {
  const attempt = await realpath(
    await mkdtemp(join(tmpdir(), "refresh-restart-")),
  );
  const fixture = createPilotFixture({
    artifact: Buffer.from("never fetched"),
    identity: Buffer.from("{}"),
    executionTarget: "linux-arm64",
  });
  let interrupt = true;
  const requests: string[] = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (interrupt && path.endsWith("snapshot.json"))
        return new Response("interrupted", { status: 503 });
      return fetch(new URL(path, fixture.origin));
    },
  });
  const original = () =>
    authenticateHistoricalRoles(fixture.rootBytes.toString(), []);
  const refresh = async () =>
    withFolderOperationLock(attempt, async (assertHeld) =>
      refreshRecoveryMetadata({
        attempt,
        original: original(),
        executionTarget: "linux-arm64",
        assertHeld,
        metadataBaseUrl: `${proxy.url}metadata/`,
        allowedOrigins: [proxy.url.origin],
        timeoutMs: 5000,
        signal: new AbortController().signal,
        loopbackFixture: true,
      }),
    );
  try {
    fixture.publish(8);
    await expect(refresh()).rejects.toThrow();
    await withFolderOperationLock(attempt, async (held) => {
      const state = await reconstructRecoveryCycles(
        attempt,
        original(),
        "linux-arm64",
        held,
      );
      expect(state.floors.timestampVersion).toBe(8);
      expect(state.records).toBe(1);
    });
    interrupt = false;
    fixture.publish(7);
    await expect(refresh()).rejects.toThrow();
    fixture.publish(9);
    const result = await refresh();
    expect(
      JSON.parse(result.checkpoint.metadata.timestamp).signed.version,
    ).toBe(9);
    expect(requests.some((path) => path.startsWith("/targets/"))).toBe(false);
    await withFolderOperationLock(attempt, async (held) => {
      const state = await reconstructRecoveryCycles(
        attempt,
        original(),
        "linux-arm64",
        held,
      );
      expect(state.count).toBe(3);
      expect(state.floors.timestampVersion).toBe(9);
    });
  } finally {
    await proxy.stop(true);
    await fixture.stop();
    await rm(attempt, { recursive: true });
  }
});

for (const version of [6, 7, 8]) {
  test(`fresh recovery metadata preserves expired timestamp floor against version ${version}`, async () => {
    const attempt = await realpath(
      await mkdtemp(join(tmpdir(), "fresh-cycle-")),
    );
    const fixture = createPilotFixture({
      artifact: Buffer.from("never fetched"),
      identity: Buffer.from("{}"),
      executionTarget: "linux-arm64",
    });
    try {
      fixture.publish(7, new Date(Date.now() - 86_400_000).toISOString());
      const original = authenticateHistoricalRoles(
        fixture.rootBytes.toString(),
        [
          {
            name: "timestamp.json",
            bytes: await (
              await fetch(`${fixture.metadataBaseUrl}timestamp.json`)
            ).text(),
          },
        ],
      );
      fixture.publish(version);
      await withFolderOperationLock(attempt, async (assertHeld) => {
        const operation = refreshRecoveryMetadata({
          attempt,
          original,
          executionTarget: "linux-arm64",
          assertHeld,
          metadataBaseUrl: fixture.metadataBaseUrl,
          allowedOrigins: [fixture.origin],
          timeoutMs: 5000,
          signal: new AbortController().signal,
          loopbackFixture: true,
        });
        if (version === 8) {
          const result = await operation;
          expect(result.kind).toBe("fresh-metadata-only");
          expect(
            JSON.parse(result.checkpoint.metadata.timestamp).signed.version,
          ).toBe(8);
        } else await expect(operation).rejects.toThrow();
      });
    } finally {
      await fixture.stop();
      await rm(attempt, { recursive: true });
    }
  });
}
