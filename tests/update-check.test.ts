import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateFixture } from "../scripts/update-fixture";
import { DistributionTransport } from "../src/distribution/transport";
import { type CheckInput, checkForUpdate } from "../src/update/check";
import {
  type DurableWriter,
  writeDurableFile,
} from "../src/update/durable-file";
import { acquireUpdateLock } from "../src/update/lock";
import { readObserved } from "../src/update/observed";

// Signed loopback repository + real filesystem; the only fake is the clock of
// the observation. Expiry is produced by publishing already-expired metadata,
// never by moving a clock the TUF client cannot see.
const target = "linux-x64";
const past = "2020-01-01T00:00:00.000Z";
const clock = () => new Date("2026-09-19T10:00:00.000Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function scenario(version = "1.0.0") {
  const fixture = createUpdateFixture({ executionTarget: target });
  const base = join(
    await realpath(await mkdtemp(join(tmpdir(), "update-check-"))),
    "base",
  );
  cleanups.push(async () => {
    await fixture.stop();
    await rm(join(base, ".."), { recursive: true });
  });
  const check = (overrides: Partial<CheckInput> = {}) =>
    checkForUpdate({
      base,
      metadataBaseUrl: fixture.metadataBaseUrl,
      targetBaseUrl: fixture.targetBaseUrl,
      channel: "stable",
      identity: { version, commit: "a".repeat(40), target },
      transport: new DistributionTransport(
        [fixture.origin],
        10_000,
        new AbortController().signal,
        true,
      ),
      clock,
      lockTimeoutMs: 10_000,
      ...overrides,
    });
  const trust = (name: string) =>
    readFile(join(base, "trust", name), "utf8").catch(() => undefined);
  const trustSnapshot = async () => {
    const entries: Record<string, string> = {};
    for (const name of (await readdir(join(base, "trust"))).sort())
      entries[name] = (await trust(name)) ?? "";
    return entries;
  };
  const version_ = async (name: string): Promise<number | undefined> => {
    const text = await trust(name);
    return text === undefined ? undefined : JSON.parse(text).signed.version;
  };
  return { fixture, base, check, trust, trustSnapshot, roleVersion: version_ };
}

test("first check with a bootstrap root promotes trust, writes the observation and reports availability", async () => {
  const { fixture, base, check, trust } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  const result = await check({ bootstrapRoot: fixture.bootstrapRoot });
  expect(result).toEqual({
    kind: "available",
    version: "1.2.0",
    artifactSha256: fixture.artifactSha256,
    length: fixture.artifactLength,
    sequence: 1,
  });
  expect((await readdir(join(base, "trust"))).sort()).toEqual([
    "1.root.json",
    "channel-floors.json",
    "floors.json",
    "root.json",
    "snapshot.json",
    "targets.json",
    "timestamp.json",
  ]);
  expect(await trust("root.json")).toBe(fixture.bootstrapRoot.toString());
  expect(JSON.parse((await trust("channel-floors.json")) ?? "")).toEqual({
    schemaVersion: 1,
    channels: {
      stable: {
        sequence: 1,
        documentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    },
  });
  // Scratch is always deleted; no artifact was requested.
  expect(await readdir(join(base, "update"))).toEqual(
    expect.arrayContaining(["lock", "observed.json"]),
  );
  expect(
    (await readdir(join(base, "update"))).some((name) =>
      name.startsWith("scratch-"),
    ),
  ).toBe(false);
  expect(fixture.requests.some((path) => path.includes("/artifacts/"))).toBe(
    false,
  );
  const observed = JSON.parse(
    await readFile(join(base, "update", "observed.json"), "utf8"),
  );
  expect(observed).toMatchObject({
    schemaVersion: 1,
    observedAt: "2026-09-19T10:00:00.000Z",
    status: "available",
    channel: "stable",
    lastAuthenticatedCheckAt: "2026-09-19T10:00:00.000Z",
    checkedBy: { version: "1.0.0", target },
    selected: null,
    running: null,
    lastHealthyActivation: null,
    available: {
      version: "1.2.0",
      artifactSha256: fixture.artifactSha256,
      sequence: 1,
      verifiedAt: "2026-09-19T10:00:00.000Z",
    },
    error: null,
    canRetry: false,
  });
  expect(typeof observed.operationId).toBe("string");
});

test("an equal or older channel version is up to date, never a downgrade", async () => {
  const { fixture, check } = await scenario("1.2.0");
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toEqual({
    kind: "up-to-date",
    version: "1.2.0",
    channelVersion: "1.2.0",
    sequence: 1,
  });
  fixture.release("stable", { sequence: 2, version: "1.1.0" });
  expect(await check()).toMatchObject({
    kind: "up-to-date",
    channelVersion: "1.1.0",
  });
});

test("later checks need no bootstrap root; a bootstrap root beside established trust is refused; no trust and no root is typed", async () => {
  const { fixture, check, trustSnapshot } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  expect(await check()).toMatchObject({ kind: "error", code: "trust-missing" });
  expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toMatchObject({
    kind: "available",
  });
  const established = await trustSnapshot();
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toMatchObject({
    kind: "error",
    code: "trust-conflict",
  });
  expect(await trustSnapshot()).toEqual(established);
  expect(
    await check({ bootstrapRoot: Buffer.from('{"signed":{}}') }),
  ).toMatchObject({ kind: "error", code: "trust-conflict" });
});

test("a bootstrap root that verified nothing is not kept, so it can never wedge the first check", async () => {
  const { fixture, base, check } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  const stranger = createUpdateFixture({ executionTarget: target });
  await stranger.stop();
  // A self-consistent root of ANOTHER repository verifies nothing here.
  expect(await check({ bootstrapRoot: stranger.bootstrapRoot })).toMatchObject({
    kind: "error",
    code: "metadata-invalid",
  });
  expect(await readdir(join(base, "trust"))).toEqual([]);
  expect(
    await check({ bootstrapRoot: Buffer.from("not a root") }),
  ).toMatchObject({ kind: "error", code: "trust-invalid" });
  expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toMatchObject({
    kind: "available",
  });
});

test("a root rotation accepted during a refresh that later fails is retained, and the next check succeeds under it", async () => {
  for (const failing of ["targets", "channel", "timestamp"] as const) {
    const { fixture, check, trust, roleVersion } = await scenario();
    fixture.release("stable", { sequence: 1, version: "1.2.0" });
    expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toMatchObject(
      { kind: "available" },
    );
    fixture.rotateRoot();
    const blocked =
      failing === "targets"
        ? "/metadata/2.targets.json"
        : failing === "timestamp"
          ? "/metadata/timestamp.json"
          : (fixture.requests.find((path) => path.includes("/channels/")) ??
            "");
    fixture.block(blocked, failing === "timestamp" ? 503 : 404);
    const failed = await check();
    expect(failed).toMatchObject({
      kind: "error",
      code: "network-unavailable",
      context: {
        resource: blocked.split("/").at(-1),
        httpStatus: failing === "timestamp" ? 503 : 404,
      },
    });
    // The rotated root is durable although the attempt failed.
    const rotated = fixture.served("/metadata/2.root.json")?.toString();
    expect(await trust("root.json")).toBe(rotated);
    expect(await trust("2.root.json")).toBe(rotated);
    expect(await trust("1.root.json")).toBe(fixture.bootstrapRoot.toString());
    // Everything verified before the failure moved forward too — and nothing
    // after it.
    expect(await roleVersion("timestamp.json")).toBe(
      failing === "timestamp" ? 1 : 2,
    );
    expect(await roleVersion("snapshot.json")).toBe(
      failing === "timestamp" ? 1 : 2,
    );
    expect(await roleVersion("targets.json")).toBe(
      failing === "channel" ? 2 : 1,
    );
    fixture.unblock(blocked);
    fixture.requests.length = 0;
    expect(await check()).toMatchObject({ kind: "available" });
    // The next refresh started FROM root 2: it only probed for root 3.
    expect(
      fixture.requests.filter((path) => path.endsWith(".root.json")),
    ).toEqual(["/metadata/3.root.json"]);
    expect(await roleVersion("targets.json")).toBe(2);
  }
});

test("rotated timestamp and snapshot keys: old roles that no longer verify are replaced, not fatal", async () => {
  const { fixture, check, roleVersion } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  fixture.rotateRoot({ rotate: ["root", "timestamp", "snapshot", "targets"] });
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await roleVersion("root.json")).toBe(2);
  expect(await roleVersion("timestamp.json")).toBe(2);
});

test("a correctly signed but EXPIRED rotated root is still promoted; a fresh successor then verifies from it", async () => {
  const { fixture, check, trust, roleVersion } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  fixture.rotateRoot({ expires: past });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-expired",
  });
  // Authenticity was complete; expiry is about freshness of THIS refresh. The
  // root that revoked key 1 must not be forgotten (see src/update/trust.ts).
  expect(await trust("root.json")).toBe(
    fixture.served("/metadata/2.root.json")?.toString(),
  );
  // It authorized nothing: the check failed. The newer timestamp it could
  // authenticate is kept as a version floor, like under any other expiry.
  expect(await roleVersion("timestamp.json")).toBe(2);
  expect(await roleVersion("snapshot.json")).toBe(1);
  fixture.renewRoot();
  fixture.requests.length = 0;
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await roleVersion("root.json")).toBe(3);
  expect(fixture.requests).not.toContain("/metadata/2.root.json");
});

test("a crash between any two promotions converges on the next check", async () => {
  // Count the writes of an uninterrupted check, then die before each one.
  const counting = await scenario();
  counting.fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await counting.check({ bootstrapRoot: counting.fixture.bootstrapRoot });
  counting.fixture.rotateRoot();
  counting.fixture.release("stable", { sequence: 2, version: "1.3.0" });
  let writes = 0;
  const counted: DurableWriter = async (...args) => {
    writes += 1;
    await writeDurableFile(...args);
  };
  await counting.check({ writeDurable: counted });
  const converged = await counting.trustSnapshot();
  // floors.json (the vector, FIRST), 2.root.json, root.json, timestamp,
  // snapshot, targets, channel floors, observed.
  expect(writes).toBe(8);

  for (let survive = 0; survive < writes; survive++) {
    const { fixture, check, trustSnapshot, base } = await scenario();
    fixture.release("stable", { sequence: 1, version: "1.2.0" });
    await check({ bootstrapRoot: fixture.bootstrapRoot });
    fixture.rotateRoot();
    fixture.release("stable", { sequence: 2, version: "1.3.0" });
    let done = 0;
    const dying: DurableWriter = async (...args) => {
      // A dead process writes nothing further, the observation included.
      if (done >= survive) throw new Error("killed");
      done += 1;
      await writeDurableFile(...args);
    };
    const interrupted = await check({ writeDurable: dying });
    if (survive < 7)
      expect(interrupted).toMatchObject({ kind: "error", code: "internal" });
    // Promotion order is an invariant, not a habit: whatever survived is a
    // PREFIX of vector → root chain → root → timestamp → snapshot → targets →
    // channel floor, so trust/ never holds a role newer than the root that
    // verifies it, and the vector is never LOWER than what the files prove.
    const partial = await trustSnapshot();
    const at = (name: string): number =>
      JSON.parse(partial[name] ?? "").signed.version;
    const vector = JSON.parse(partial["floors.json"] ?? "");
    expect(vector.root.version).toBeGreaterThanOrEqual(at("root.json"));
    expect(vector.timestamp.version).toBeGreaterThanOrEqual(
      at("timestamp.json"),
    );
    expect(vector.snapshot.version).toBeGreaterThanOrEqual(at("snapshot.json"));
    expect(vector.roles["targets.json"].version).toBeGreaterThanOrEqual(
      at("targets.json"),
    );
    // Written first: ahead of the files from the first surviving write on.
    expect(vector.timestamp.version).toBe(survive === 0 ? 1 : 3);
    if (at("root.json") === 2) expect(partial["2.root.json"]).toBeDefined();
    if (at("timestamp.json") > 1) expect(at("root.json")).toBe(2);
    if (at("snapshot.json") > 1) expect(at("timestamp.json")).toBe(3);
    if (at("targets.json") > 1) expect(at("snapshot.json")).toBe(3);
    if (
      JSON.parse(partial["channel-floors.json"] ?? "").channels.stable
        .sequence === 2
    )
      expect(at("targets.json")).toBe(3);
    // Exactly `survive` promotions happened before the kill.
    expect(
      [
        vector.timestamp.version === 3,
        partial["2.root.json"] !== undefined,
        at("root.json") === 2,
        at("timestamp.json") === 3,
        at("snapshot.json") === 3,
        at("targets.json") === 3,
        JSON.parse(partial["channel-floors.json"] ?? "").channels.stable
          .sequence === 2,
      ].filter(Boolean).length,
    ).toBe(Math.min(survive, 7));
    // Whatever prefix survived, a plain next check finishes the job.
    expect(await check()).toMatchObject({
      kind: "available",
      version: "1.3.0",
      sequence: 2,
    });
    const after = await trustSnapshot();
    expect(Object.keys(after)).toEqual(Object.keys(converged));
    for (const name of ["root.json", "timestamp.json", "targets.json"])
      expect(JSON.parse(after[name] ?? "").signed.version).toBe(
        JSON.parse(converged[name] ?? "").signed.version,
      );
    expect(
      JSON.parse(after["channel-floors.json"] ?? "").channels.stable,
    ).toMatchObject({ sequence: 2 });
    // A vector that was ahead did not wedge, and ends where the files are.
    expect(JSON.parse(after["floors.json"] ?? "")).toMatchObject({
      root: { version: 2 },
      timestamp: { version: 3, snapshot: { version: 3 } },
      snapshot: { version: 3, meta: { "targets.json": { version: 3 } } },
      roles: { "targets.json": { version: 3 } },
    });
    expect((await readObserved(base, clock())).status).toBe("available");
  }
}, 60_000);

test("abandoned scratch directories and temporary files of a killed check are removed by the next one", async () => {
  const { fixture, base, check } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  await mkdir(join(base, "update", "scratch-dead"));
  await writeFile(join(base, "update", "scratch-dead", "root.json"), "junk");
  await writeFile(
    join(base, "trust", ".timestamp.json.tmp-0123456789abcdef"),
    "half",
  );
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await readdir(join(base, "update"))).not.toContain("scratch-dead");
  expect(await readdir(join(base, "trust"))).not.toContain(
    ".timestamp.json.tmp-0123456789abcdef",
  );
});

test("an expired timestamp is a typed error that never wedges; the newer version it proved is kept as a rollback floor and authorizes nothing", async () => {
  const { fixture, base, check, trustSnapshot, roleVersion } = await scenario();
  // First contact: the root authenticated the timestamp, so both are kept;
  // nothing is offered, and a later fresh generation simply works.
  fixture.release(
    "stable",
    { sequence: 1, version: "1.2.0" },
    { expires: { timestamp: past } },
  );
  expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toMatchObject({
    kind: "error",
    code: "metadata-expired",
  });
  expect((await readdir(join(base, "trust"))).sort()).toEqual([
    "1.root.json",
    "floors.json",
    "root.json",
    "timestamp.json",
  ]);
  expect(await readObserved(base, clock())).toMatchObject({
    status: "error",
    error: { code: "metadata-expired" },
    canRetry: true,
    available: null,
    lastAuthenticatedCheckAt: null,
  });
  fixture.publish();
  expect(await check()).toMatchObject({ kind: "available" });

  // (a) Established trust at generation 2; generation 3 has an authentic but
  // EXPIRED timestamp. The client authenticates it, throws, and never writes
  // it — promotion keeps it from the raw bytes.
  const valid = fixture.version();
  const before = await trustSnapshot();
  fixture.publish({ expires: { timestamp: past } });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-expired",
  });
  expect(await roleVersion("timestamp.json")).toBe(valid + 1);
  // Only the timestamp and the vector that remembers it moved.
  expect({
    ...(await trustSnapshot()),
    "timestamp.json": "",
    "floors.json": "",
  }).toEqual({ ...before, "timestamp.json": "", "floors.json": "" });
  expect(
    JSON.parse((await trustSnapshot())["floors.json"] ?? ""),
  ).toMatchObject({
    timestamp: { version: valid + 1, snapshot: { version: valid + 1 } },
    snapshot: { version: valid },
  });
  // The verified target stays visible while the error is shown.
  expect(await readObserved(base, clock())).toMatchObject({
    status: "error",
    available: { version: "1.2.0" },
    lastAuthenticatedCheckAt: "2026-09-19T10:00:00.000Z",
  });
  // The same expired generation again: still an expiry, nothing authorized.
  expect(await check()).toMatchObject({ code: "metadata-expired" });
  // (b) Replay of the last VALID, unexpired generation — lower than the
  // floor. Without the floor this would pass as "no change".
  const floor = await trustSnapshot();
  fixture.rewindTo(valid);
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-rollback",
    context: { role: "timestamp", rule: "version", floor: valid + 1 },
  });
  expect(await trustSnapshot()).toEqual(floor);
  // (c) No wedge: a fresh higher generation is accepted.
  fixture.publish();
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await roleVersion("timestamp.json")).toBe(valid + 2);
  expect(await roleVersion("targets.json")).toBe(valid + 2);
});

test("an expired snapshot: the newer version the timestamp names is kept as a floor, refuses a lower targets version even when the timestamp is lost, and never wedges", async () => {
  const { fixture, base, check, trustSnapshot, roleVersion } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  fixture.publish();
  expect(await check()).toMatchObject({ kind: "available" });
  const valid = fixture.version();
  // (a) Fresh timestamp, authentic but EXPIRED snapshot of a higher version.
  fixture.publish({ expires: { snapshot: past } });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-expired",
  });
  expect(await roleVersion("timestamp.json")).toBe(valid + 1);
  expect(await roleVersion("snapshot.json")).toBe(valid + 1);
  // Expired metadata authorizes nothing: targets did not move.
  expect(await roleVersion("targets.json")).toBe(valid);
  expect(await check()).toMatchObject({ code: "metadata-expired" });
  // (b) Replay of the last valid generation is refused by the timestamp…
  const floor = await trustSnapshot();
  fixture.rewindTo(valid);
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-rollback",
    context: { role: "timestamp", rule: "version" },
  });
  expect(await trustSnapshot()).toEqual(floor);
  // …and still when the timestamp FILE is lost: the vector remembers it, and
  // so does the expired snapshot the client loads as a floor.
  await rm(join(base, "trust", "timestamp.json"));
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-rollback",
  });
  expect(await roleVersion("snapshot.json")).toBe(valid + 1);
  expect(await roleVersion("targets.json")).toBe(valid);
  // (c) No wedge.
  fixture.publish();
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await roleVersion("snapshot.json")).toBe(valid + 2);
  expect(await roleVersion("targets.json")).toBe(valid + 2);
});

test("a role delivered last that is not authentic or not newer is never kept, and an interrupted capture converges at the next check", async () => {
  const { fixture, check, trustSnapshot, roleVersion } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  const before = await trustSnapshot();
  // (e) A newer, expired timestamp whose signature is damaged.
  fixture.publish({ expires: { timestamp: past } });
  const genuine = fixture.served("/metadata/timestamp.json") as Buffer;
  fixture.substitute(
    "/metadata/timestamp.json",
    Buffer.from(genuine.toString().replace(/"sig":"../, '"sig":"00')),
  );
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-invalid",
  });
  expect(await trustSnapshot()).toEqual(before);
  // A damaged snapshot under a fresh timestamp: the timestamp moves, the
  // snapshot does not.
  fixture.publish({ tamper: "snapshot" });
  expect(await check()).toMatchObject({ code: "metadata-invalid" });
  expect(await roleVersion("snapshot.json")).toBe(1);
  const moved = await trustSnapshot();
  // An authentic LOWER version delivered last (a replay) is no floor: it is
  // named for what it is.
  fixture.rewindTo(1);
  expect(await check()).toMatchObject({ code: "metadata-rollback" });
  expect(await trustSnapshot()).toEqual(moved);

  // (f) The process dies between capture and promotion, at every write:
  // before the floor is written (a refresh that never ran) and after it
  // (only the observation is lost). The next check converges either way.
  for (let survive = 0; survive < 2; survive++) {
    fixture.publish({ expires: { timestamp: past } });
    let done = 0;
    await check({
      writeDurable: async (...args) => {
        if (done >= survive) throw new Error("killed");
        done += 1;
        await writeDurableFile(...args);
      },
    });
    expect(await check()).toMatchObject({ code: "metadata-expired" });
    expect(await roleVersion("timestamp.json")).toBe(fixture.version());
  }
});

test("expired snapshot and targets are classified as expiry through the pinned client's wrapped errors", async () => {
  for (const role of ["snapshot", "targets"] as const) {
    const { fixture, check, roleVersion } = await scenario();
    fixture.release("stable", { sequence: 1, version: "1.2.0" });
    await check({ bootstrapRoot: fixture.bootstrapRoot });
    fixture.publish({ expires: { [role]: past } });
    expect(await check()).toMatchObject({
      kind: "error",
      code: "metadata-expired",
    });
    // The fresh timestamp moved; snapshot 2 is in trust/ either way — as a
    // floor when it is the expired one, as a verified role otherwise — and
    // expired targets are never kept: they carry no floor.
    expect(await roleVersion("timestamp.json")).toBe(2);
    expect(await roleVersion("snapshot.json")).toBe(2);
    expect(await roleVersion("targets.json")).toBe(1);
    fixture.publish();
    expect(await check()).toMatchObject({ kind: "available" });
  }
});

test("a role that fails verification is never promoted, while the roles verified before it are", async () => {
  const { fixture, check, roleVersion } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  fixture.publish({ tamper: "snapshot" });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "metadata-invalid",
  });
  expect(await roleVersion("timestamp.json")).toBe(2);
  expect(await roleVersion("snapshot.json")).toBe(1);
  expect(await roleVersion("targets.json")).toBe(1);
  fixture.publish();
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await roleVersion("snapshot.json")).toBe(3);
});

test("channel floors only move forward; a lower sequence or reused sequence is a rollback", async () => {
  const { fixture, check, trust } = await scenario();
  const floor = async () =>
    JSON.parse((await trust("channel-floors.json")) ?? "").channels.stable;
  fixture.release("stable", { sequence: 5, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  const five = await floor();
  expect(five.sequence).toBe(5);
  // Identical authenticated bytes in a newer generation are a normal repeat.
  fixture.publish();
  expect(await check()).toMatchObject({ kind: "available", sequence: 5 });
  expect(await floor()).toEqual(five);
  fixture.release("stable", { sequence: 7, version: "1.3.0" });
  expect(await check()).toMatchObject({ kind: "available", sequence: 7 });
  const seven = await floor();
  expect(seven.sequence).toBe(7);
  // TUF accepts both generations below (their metadata versions rise); only
  // the channel floor refuses them.
  fixture.release("stable", { sequence: 6, version: "1.4.0" });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "channel-rollback",
    context: { channel: "stable", floorSequence: 7, offeredSequence: 6 },
  });
  expect(await floor()).toEqual(seven);
  fixture.release("stable", { sequence: 7, version: "1.4.0" });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "channel-rollback",
  });
  expect(await floor()).toEqual(seven);
  // Each channel has its own floor.
  fixture.release("preview", { sequence: 1, version: "2.0.0-rc.1" });
  fixture.release("stable", { sequence: 8, version: "1.4.0" });
  expect(await check({ channel: "preview" })).toMatchObject({
    kind: "available",
    version: "2.0.0-rc.1",
    sequence: 1,
  });
  expect(
    JSON.parse((await trust("channel-floors.json")) ?? "").channels,
  ).toMatchObject({ stable: { sequence: 7 }, preview: { sequence: 1 } });
  expect(await check()).toMatchObject({ kind: "available", sequence: 8 });
});

test("channel document problems and an unsupported target are typed; the floor still advances for a verified document", async () => {
  const { fixture, check, trust } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  expect(await check({ channel: "preview" })).toMatchObject({
    kind: "error",
    code: "channel-invalid",
    context: { reason: "absent" },
  });
  fixture.release("stable", {
    sequence: 2,
    version: "1.3.0",
    withoutTarget: true,
  });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "target-unsupported",
    context: { target },
  });
  expect(
    JSON.parse((await trust("channel-floors.json")) ?? "").channels.stable
      .sequence,
  ).toBe(2);
  fixture.release("stable", {
    sequence: 3,
    version: "1.3.0",
    rawDocument: '{"schemaVersion":1,"schemaVersion":1}',
  });
  expect(await check()).toMatchObject({
    kind: "error",
    code: "channel-invalid",
    context: { reason: "malformed" },
  });
  expect(
    await check({ channel: "nightly" as unknown as "stable" }),
  ).toMatchObject({ kind: "error", code: "invalid-request" });
});

test("a missing or corrupt observation never blocks a check and is always rebuilt", async () => {
  const { fixture, base, check } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  const path = join(base, "update", "observed.json");
  expect(await readObserved(base, clock())).toMatchObject({
    status: "idle",
    operationId: null,
    available: null,
  });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  for (const garbage of [
    "{ not json",
    "null",
    '{"schemaVersion":99,"status":"downloading"}',
    '{"schemaVersion":1,"status":"downloading"}',
    "x".repeat(200_000),
  ]) {
    await writeFile(path, garbage);
    expect(await readObserved(base, clock())).toMatchObject({ status: "idle" });
    expect(await check()).toMatchObject({ kind: "available" });
    expect(await readObserved(base, clock())).toMatchObject({
      status: "available",
    });
  }
  await rm(path);
  expect(await check()).toMatchObject({ kind: "available" });
  // Even an observation that cannot be written does not change the result.
  await rm(path);
  await mkdir(path);
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await readObserved(base, clock())).toMatchObject({ status: "idle" });
});

test("the observation reads the selector and nothing else about the active version", async () => {
  const { fixture, base, check } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await mkdir(join(base, "bin"), { recursive: true });
  await symlink(
    "../versions/1.0.0+0123456789abcdef/lazurio",
    join(base, "bin", "lazurio"),
  );
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  expect((await readObserved(base, clock())).selected).toEqual({
    version: "1.0.0",
    artifactSha16: "0123456789abcdef",
    observedAt: "2026-09-19T10:00:00.000Z",
  });
});

test("unknown entries in the base, in trust/ and in update/ never stop a check and are left alone", async () => {
  const { fixture, base, check } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await mkdir(join(base, "legacy-runtime", "node_modules"), {
    recursive: true,
  });
  await mkdir(join(base, "trust"), { recursive: true });
  await mkdir(join(base, "update"), { recursive: true });
  const strangers = [
    join(base, "active.json"),
    join(base, "legacy-runtime", "node_modules", "x.js"),
    join(base, "trust", "notes.txt"),
    join(base, "trust", "99.root.json"),
    join(base, "trust", "selected.json"),
    join(base, "update", "config.json"),
  ];
  for (const path of strangers) await writeFile(path, "unrelated");
  await mkdir(join(base, "trust", "7"));
  expect(await check({ bootstrapRoot: fixture.bootstrapRoot })).toMatchObject({
    kind: "available",
  });
  expect(await check()).toMatchObject({ kind: "available" });
  for (const path of strangers)
    expect(await readFile(path, "utf8")).toBe("unrelated");
});

test("owned security state of a newer schema is refused, not guessed", async () => {
  const { fixture, base, check, roleVersion } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  await writeFile(
    join(base, "trust", "channel-floors.json"),
    '{"schemaVersion":2,"floors":[]}',
  );
  fixture.rotateRoot();
  expect(await check()).toMatchObject({
    kind: "error",
    code: "trust-invalid",
    context: { subject: "channel-floors", reason: "newer-schema" },
  });
  // The channel decision is refused; verified TUF trust still moved forward.
  expect(await roleVersion("root.json")).toBe(2);
  expect(await roleVersion("targets.json")).toBe(2);
});

test("two concurrent checks serialize on the lock and neither corrupts trust; a held lock times out as busy", async () => {
  const { fixture, base, check, trustSnapshot } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  fixture.rotateRoot();
  fixture.release("stable", { sequence: 2, version: "1.3.0" });
  const results = await Promise.all([check(), check(), check()]);
  for (const result of results)
    expect(result).toMatchObject({ kind: "available", sequence: 2 });
  const settled = await trustSnapshot();
  expect(JSON.parse(settled["root.json"] ?? "").signed.version).toBe(2);
  expect(await check()).toMatchObject({ kind: "available" });
  expect(await trustSnapshot()).toEqual(settled);

  const held = await acquireUpdateLock(join(base, "update", "lock"), {
    timeoutMs: 0,
  });
  const observedBefore = await readFile(
    join(base, "update", "observed.json"),
    "utf8",
  );
  try {
    fixture.requests.length = 0;
    expect(await check({ lockTimeoutMs: 150 })).toEqual({
      kind: "error",
      code: "busy",
      context: {},
    });
    // A busy check touched neither the network nor the observation.
    expect(fixture.requests).toEqual([]);
    expect(await readFile(join(base, "update", "observed.json"), "utf8")).toBe(
      observedBefore,
    );
    const waiting = check({ lockTimeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await held.release();
    expect(await waiting).toMatchObject({ kind: "available" });
  } finally {
    await held.release();
  }
});

test("an unreachable origin is a retryable typed error that keeps the last verified facts", async () => {
  const { fixture, base, check, trustSnapshot } = await scenario();
  fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await check({ bootstrapRoot: fixture.bootstrapRoot });
  const before = await trustSnapshot();
  await fixture.stop();
  expect(await check()).toMatchObject({
    kind: "error",
    code: "network-unavailable",
  });
  expect(await trustSnapshot()).toEqual(before);
  expect(await readObserved(base, clock())).toMatchObject({
    status: "error",
    error: { code: "network-unavailable" },
    canRetry: true,
    available: { version: "1.2.0" },
  });
});
