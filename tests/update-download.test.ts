import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateFixture } from "../scripts/update-fixture";
import { DistributionTransport } from "../src/distribution/transport";
import {
  type DownloadEffects,
  downloadArtifact,
  systemDownloadEffects,
} from "../src/update/download";
import {
  type ErrorContext,
  type UpdateErrorCode,
  UpdateFailure,
} from "../src/update/errors";
import { swapSelector, versionName } from "../src/update/layout";
import { readObserved } from "../src/update/observed";
import { performUpdate, type UpdateInput } from "../src/update/update";

// The download against the signed loopback repository. Nothing here is
// executed: every refusal below happens before a candidate could run.
const target = "linux-x64";
const clock = () => new Date("2026-09-19T10:00:00.000Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scenario() {
  const fixture = createUpdateFixture({ executionTarget: target });
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "update-download-")),
  );
  cleanups.push(async () => {
    await fixture.stop();
    await rm(root, { recursive: true, force: true });
  });
  const transport = () =>
    new DistributionTransport(
      [fixture.origin],
      20_000,
      new AbortController().signal,
      true,
    );
  // 3 MiB of noise: large enough to arrive in several chunks.
  const bytes = randomBytes(3 * 1024 * 1024);
  const artifact = fixture.addArtifact({ bytes, version: "1.1.0" });
  const signed = {
    path: `artifacts/${artifact.sha256}/lazurio`,
    sha256: artifact.sha256,
    length: bytes.length,
  };
  const destination = join(root, "artifact");
  const download = (
    overrides: Partial<Parameters<typeof downloadArtifact>[0]> = {},
  ) => {
    const opened = transport();
    return downloadArtifact({
      url: `${fixture.origin}${artifact.url}`,
      artifact: signed,
      destination,
      directory: root,
      openRange: (url, offset, signal) => opened.openRange(url, offset, signal),
      policy: { backoffMs: 1, maxBackoffMs: 5 },
      ...overrides,
    });
  };
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(UpdateFailure);
    return (error as UpdateFailure).failure;
  };
  return {
    fixture,
    root,
    bytes,
    artifact,
    destination,
    download,
    failure,
    transport,
  };
}

test("a download is verified against the signed length and digest and reports progress", async () => {
  const s = await scenario();
  s.fixture.publish();
  const seen: number[] = [];
  await s.download({ onProgress: (received) => seen.push(received) });
  expect((await readFile(s.destination)).equals(s.bytes)).toBe(true);
  expect(seen.at(-1)).toBe(s.bytes.length);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(s.fixture.rangeRequests).toEqual([
    { path: s.artifact.url, range: null },
  ]);
});

test("an interrupted download resumes from the bytes it has, and a server that ignores the range is restarted from zero", async () => {
  const s = await scenario();
  s.fixture.publish();
  s.fixture.fault(s.artifact.url, {
    kind: "truncate",
    after: 700_000,
    times: 2,
  });
  await s.download();
  expect((await readFile(s.destination)).equals(s.bytes)).toBe(true);
  const ranges = s.fixture.rangeRequests.map((request) => request.range);
  expect(ranges).toHaveLength(3);
  expect(ranges[0]).toBeNull();
  // Each retry asks exactly for what is missing, and makes progress.
  const offsets = ranges.slice(1).map((range) => Number(range?.slice(6, -1)));
  expect(offsets[0]).toBeGreaterThan(0);
  expect(offsets[1]).toBeGreaterThan(offsets[0] as number);

  // A connection that breaks mid-body (the body throws) resumes the same way.
  s.fixture.rangeRequests.length = 0;
  let broken = false;
  const breaking = s.transport();
  await s.download({
    openRange: async (url, offset, signal) => {
      const response = await breaking.openRange(url, offset, signal);
      if (broken) return response;
      broken = true;
      return {
        ...response,
        body: (async function* () {
          let sent = 0;
          for await (const chunk of response.body) {
            yield chunk;
            sent += chunk.byteLength;
            if (sent > 300_000) throw new Error("connection reset");
          }
        })(),
      };
    },
  });
  expect((await readFile(s.destination)).equals(s.bytes)).toBe(true);
  expect(s.fixture.rangeRequests.map((request) => request.range)).toEqual([
    null,
    expect.stringMatching(/^bytes=[1-9]\d*-$/),
  ]);

  s.fixture.rangeRequests.length = 0;
  let interrupted = false;
  const opened = s.transport();
  await s.download({
    // First attempt breaks; the retry is answered with the WHOLE object.
    openRange: async (url, offset, signal) => {
      if (!interrupted) {
        interrupted = true;
        s.fixture.fault(s.artifact.url, {
          kind: "truncate",
          after: 500_000,
          times: 1,
        });
      } else s.fixture.fault(s.artifact.url, { kind: "ignore-range" });
      return opened.openRange(url, offset, signal);
    },
  });
  expect((await readFile(s.destination)).equals(s.bytes)).toBe(true);
});

test("corrupted, too long and unobtainable bytes are typed refusals that leave no file", async () => {
  const s = await scenario();
  s.fixture.publish();
  s.fixture.fault(s.artifact.url, { kind: "corrupt" });
  expect(await s.failure(s.download())).toEqual({
    code: "artifact-invalid",
    context: { reason: "digest" },
  });
  s.fixture.fault(s.artifact.url, undefined);
  s.fixture.substitute(
    s.artifact.url,
    Buffer.concat([s.bytes, Buffer.from("more")]),
  );
  expect(await s.failure(s.download())).toEqual({
    code: "artifact-invalid",
    context: { reason: "length" },
  });
  // A publisher's 404 repeats identically: no retries.
  s.fixture.rangeRequests.length = 0;
  s.fixture.block(s.artifact.url, 404);
  expect(await s.failure(s.download())).toEqual({
    code: "network-unavailable",
    context: { resource: "artifact", reason: "http", httpStatus: 404 },
  });
  expect(
    s.fixture.requests.filter((path) => path === s.artifact.url),
  ).toHaveLength(3);
  // A failing origin is retried a bounded number of times.
  const before = s.fixture.requests.length;
  s.fixture.block(s.artifact.url, 503);
  expect(
    await s.failure(
      s.download({ policy: { backoffMs: 1, stalledAttempts: 3 } }),
    ),
  ).toEqual({
    code: "network-unavailable",
    context: { resource: "artifact", reason: "retries", httpStatus: 503 },
  });
  expect(s.fixture.requests.length - before).toBe(3);
  // ONE deadline bounds everything, retries and waits included.
  const started = performance.now();
  expect(
    await s.failure(
      s.download({
        policy: { deadlineMs: 150, backoffMs: 40, stalledAttempts: 1_000 },
      }),
    ),
  ).toMatchObject({
    code: "network-unavailable",
    context: { reason: "deadline" },
  });
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(await readdir(s.root)).toEqual([]);
});

test("a full disk is refused before the transfer, and running out of space during it removes the partial file", async () => {
  const s = await scenario();
  s.fixture.publish();
  const effects = (overrides: Partial<DownloadEffects>): DownloadEffects => ({
    ...systemDownloadEffects,
    ...overrides,
  });
  expect(
    await s.failure(
      s.download({ effects: effects({ freeBytes: async () => 1024 }) }),
    ),
  ).toEqual({ code: "disk-full", context: { stage: "disk-check" } });
  expect(s.fixture.rangeRequests).toEqual([]);
  let written = 0;
  expect(
    await s.failure(
      s.download({
        effects: effects({
          async create(path) {
            const file = await systemDownloadEffects.create(path);
            return {
              ...file,
              async write(chunk) {
                written += chunk.byteLength;
                if (written > 1_000_000)
                  throw Object.assign(new Error("no space"), {
                    code: "ENOSPC",
                  });
                await file.write(chunk);
              },
            };
          },
        }),
      }),
    ),
  ).toEqual({ code: "disk-full", context: { stage: "download" } });
  expect(await readdir(s.root)).toEqual([]);
});

// The use case: signed identity first, then bytes, then nothing outside scratch.
async function installed() {
  const s = await scenario();
  const base = join(s.root, "base");
  const name = versionName("1.0.0", "a".repeat(64));
  await mkdir(join(base, "versions", name), { recursive: true });
  await writeFile(join(base, "versions", name, "lazurio"), "never executed");
  await swapSelector(base, name);
  const transport = s.transport();
  let trusted = false;
  const update = (overrides: Partial<UpdateInput> = {}) => {
    const input: UpdateInput = {
      base,
      metadataBaseUrl: s.fixture.metadataBaseUrl,
      targetBaseUrl: s.fixture.targetBaseUrl,
      channel: "stable",
      identity: { version: "1.0.0", commit: "a".repeat(40), target },
      ...(trusted ? {} : { bootstrapRoot: s.fixture.bootstrapRoot }),
      transport,
      clock,
      lockTimeoutMs: 5_000,
      service: { kind: "none" },
      openRange: (url, offset, signal) =>
        transport.openRange(url, offset, signal),
      downloadOnly: true,
      // Anything that reaches the gate is refused; nothing is executed.
      run: async () => ({ exitCode: 1, stdout: "" }),
      ...overrides,
    };
    trusted = true;
    return performUpdate(input);
  };
  const clean = async () => {
    expect(await readdir(join(base, "versions"))).toEqual([name]);
    expect(
      (await readdir(join(base, "update"))).filter((entry) =>
        entry.startsWith("scratch-"),
      ),
    ).toEqual([]);
  };
  return { ...s, base, update, clean };
}

test("the signed identity is held against the candidate before any large transfer: wrong target, wrong version, other bytes, unreadable schemas, a newer updater contract", async () => {
  const s = await installed();
  const cases: [
    Record<string, unknown> | string,
    UpdateErrorCode,
    ErrorContext,
  ][] = [
    [{ target: "darwin-arm64" }, "identity-invalid", { reason: "target" }],
    [{ version: "9.9.9" }, "identity-invalid", { reason: "version" }],
    [
      { artifactSha256: "b".repeat(64) },
      "identity-invalid",
      { reason: "artifact" },
    ],
    [{ artifactBytes: 1 }, "identity-invalid", { reason: "artifact" }],
    [
      { minimumUpdaterContract: 2 },
      "identity-invalid",
      { reason: "updater-contract" },
    ],
    [
      { schemas: { preferences: [2], manifest: [1] } },
      "schema-incompatible",
      { version: "1.1.0" },
    ],
    [
      { schemaVersion: 2 },
      "identity-invalid",
      { reason: "unsupported-schema" },
    ],
    [
      '{"schemaVersion":1,"schemaVersion":1}',
      "identity-invalid",
      { reason: "malformed" },
    ],
  ];
  let sequence = 0;
  for (const [identity, code, context] of cases) {
    const bytes = randomBytes(64 * 1024);
    const artifact = s.fixture.addArtifact({
      bytes,
      version: "1.1.0",
      ...(typeof identity === "string"
        ? { rawIdentity: identity }
        : { identity }),
    });
    sequence += 1;
    s.fixture.release("stable", {
      sequence,
      version: "1.1.0",
      artifactSha256: artifact.sha256,
    });
    s.fixture.rangeRequests.length = 0;
    expect(await s.update()).toEqual({ kind: "error", code, context });
    expect(
      s.fixture.rangeRequests.filter((request) =>
        request.path.endsWith(".lazurio"),
      ),
    ).toEqual([]);
    await s.clean();
  }
  // An artifact published without any identity is not a candidate.
  s.fixture.release("stable", { sequence: sequence + 1, version: "1.1.0" });
  expect(await s.update()).toMatchObject({
    code: "identity-invalid",
    context: { reason: "absent" },
  });
  // The observation keeps what is verified and says why it is not staged.
  expect(await readObserved(s.base, clock())).toMatchObject({
    status: "error",
    error: { code: "identity-invalid" },
    canRetry: true,
    available: { version: "1.1.0" },
    downloadPercent: null,
  });
});

test("a full disk and corrupted bytes fail the update with a typed error, clean scratch and a truthful observation; the retry works", async () => {
  const s = await installed();
  s.fixture.release("stable", {
    sequence: 1,
    version: "1.1.0",
    artifactSha256: s.artifact.sha256,
  });
  expect(
    await s.update({
      downloadEffects: { ...systemDownloadEffects, freeBytes: async () => 0 },
    }),
  ).toEqual({
    kind: "error",
    code: "disk-full",
    context: { stage: "disk-check" },
  });
  await s.clean();
  expect(await readObserved(s.base, clock())).toMatchObject({
    status: "error",
    error: { code: "disk-full" },
    canRetry: true,
    available: { version: "1.1.0" },
  });
  s.fixture.fault(s.artifact.url, { kind: "corrupt" });
  expect(await s.update()).toMatchObject({
    code: "artifact-invalid",
    context: { reason: "digest" },
  });
  await s.clean();
  // Good bytes reach the gate — which this test refuses — and still nothing
  // is staged.
  s.fixture.fault(s.artifact.url, undefined);
  const events: string[] = [];
  expect(
    await s.update({ onEvent: (event) => events.push(event.kind) }),
  ).toMatchObject({ code: "self-check-failed", context: { reason: "exit" } });
  expect(events.at(0)).toBe("downloading");
  expect(events.at(-1)).toBe("staging");
  await s.clean();
});

test("a download whose process died leaves `downloading` behind; reading the observation collapses it to the last stable status", async () => {
  const s = await installed();
  s.fixture.release("stable", {
    sequence: 1,
    version: "1.1.0",
    artifactSha256: s.artifact.sha256,
  });
  let seen: Awaited<ReturnType<typeof readObserved>> | undefined;
  const stuck = join(s.base, "update", "stuck.json");
  await s.update({
    downloadEffects: {
      ...systemDownloadEffects,
      async create(path) {
        const file = await systemDownloadEffects.create(path);
        return {
          ...file,
          async write(chunk) {
            await file.write(chunk);
            // While the operation is alive the transient status is true.
            const observed = await readObserved(s.base, clock());
            if (observed.status === "downloading" && !seen) {
              seen = observed;
              await writeFile(
                stuck,
                await readFile(join(s.base, "update", "observed.json")),
              );
            }
          },
        };
      },
    },
  });
  expect(seen).toMatchObject({
    status: "downloading",
    available: { version: "1.1.0" },
  });
  expect(typeof seen?.downloadPercent).toBe("number");
  // What a `kill -9` mid-download leaves on disk.
  await writeFile(
    join(s.base, "update", "observed.json"),
    await readFile(stuck),
  );
  expect(await readObserved(s.base, clock())).toMatchObject({
    status: "available",
    downloadPercent: null,
    available: { version: "1.1.0" },
  });
});
