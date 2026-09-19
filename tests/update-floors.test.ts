import { afterEach, expect, test } from "bun:test";
import {
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
import { type CheckInput, checkForUpdate } from "../src/update/check";
import {
  type DurableWriter,
  writeDurableFile,
} from "../src/update/durable-file";
import {
  emptyFloors,
  type FloorVector,
  factsOf,
  mergeFloors,
  parseFloors,
  type RoleFacts,
  rebuildFloors,
  serializeFloors,
  violationOf,
} from "../src/update/floors";

// The floor vector (docs/update.md "The floor vector"). Every case the
// retained mechanism proves in tests/historical-roles.test.ts has its
// equivalent here, against the new path; the mapping is in the PR body and in
// the comment above each test ("ports: …").
const target = "linux-x64";
const past = "2020-01-01T00:00:00.000Z";
const later = "2031-01-01T00:00:00.000Z";
const clock = () => new Date("2026-09-19T10:00:00.000Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function repository() {
  const fixture = createUpdateFixture({ executionTarget: target });
  cleanups.push(() => fixture.stop());
  const text = (path: string) => fixture.served(path)?.toString() ?? "";
  /** Facts of everything the repository serves for its CURRENT generation. */
  const facts = (): RoleFacts[] => [
    factsOf("timestamp.json", text("/metadata/timestamp.json")),
    factsOf(
      "snapshot.json",
      text(`/metadata/${fixture.version()}.snapshot.json`),
    ),
    factsOf(
      "targets.json",
      text(`/metadata/${fixture.version()}.targets.json`),
    ),
  ];
  return { fixture, text, facts };
}

const violations = (vector: FloorVector, all: readonly RoleFacts[]) =>
  all.flatMap((facts) => {
    const violation = violationOf(vector, facts);
    return violation ? [`${violation.role}:${violation.rule}`] : [];
  });

// ports: "publication comparison refuses lost counters, omitted roles and root
// substitution" (version part), "expired distinct-role chain authenticates
// floors" (what a floor consists of)
test("rule 1: every role has its own version floor; an identical state is a no-op and a higher one is accepted", () => {
  const { fixture, facts } = repository();
  fixture.release("stable", { sequence: 1, version: "1.0.0" });
  const first = facts();
  fixture.publish();
  const second = facts();
  const vector = mergeFloors(emptyFloors, second);
  expect(vector).toMatchObject({
    timestamp: { version: 2, snapshot: { version: 2 } },
    snapshot: { version: 2, meta: { "targets.json": { version: 2 } } },
    roles: { "targets.json": { version: 2 } },
  });
  expect(violations(vector, second)).toEqual([]);
  expect(violations(vector, first)).toEqual([
    "timestamp:version",
    "snapshot:version",
    "targets.json:version",
  ]);
  fixture.publish();
  expect(violations(vector, facts())).toEqual([]);
  // Nothing at all is refused by an empty vector: first contact.
  expect(violations(emptyFloors, first)).toEqual([]);
});

// ports: "validly signed <timestamp|snapshot|targets> cannot extend expiry at
// the same version", "content bindings ignore JSON formatting but retain
// unknown signed fields"
test("rule 2: the same version with different signed content is refused for timestamp, snapshot and targets; formatting, key order and signatures do not count, unknown signed members do", () => {
  const { fixture, facts, text } = repository();
  fixture.release("stable", { sequence: 1, version: "1.0.0" });
  fixture.publish({
    expires: { timestamp: past, snapshot: past, targets: past },
  });
  const expired = facts();
  const vector = mergeFloors(emptyFloors, expired);
  // The holder of the role keys "extends" the expiry at the SAME version: in
  // isolation a perfectly valid chain.
  for (const role of ["timestamp", "snapshot", "targets"] as const) {
    fixture.publish({
      at: 2,
      expires: {
        timestamp: past,
        snapshot: past,
        targets: past,
        [role]: later,
      },
    });
    expect([role, violations(vector, facts())]).toEqual([
      role,
      // The changed role itself, and every role above it: their signed
      // content names the changed one by hash.
      role === "timestamp"
        ? ["timestamp:content"]
        : role === "snapshot"
          ? ["timestamp:content", "snapshot:content"]
          : ["timestamp:content", "snapshot:content", "targets.json:content"],
    ]);
  }
  // The signed content decides, not the bytes: other key order, other
  // whitespace, other signatures — the same role.
  const original = text("/metadata/timestamp.json");
  const envelope = JSON.parse(original);
  const reordered = JSON.stringify(
    {
      signed: Object.fromEntries(Object.entries(envelope.signed).reverse()),
      signatures: [],
    },
    null,
    2,
  );
  expect(reordered).not.toBe(original);
  expect(factsOf("timestamp.json", reordered)).toEqual(
    factsOf("timestamp.json", original),
  );
  // An unknown signed member IS content.
  envelope.signed.customBinding = "new signed content";
  const unknown = factsOf("timestamp.json", JSON.stringify(envelope));
  expect(
    violationOf(
      mergeFloors(emptyFloors, [factsOf("timestamp.json", original)]),
      unknown,
    ),
  ).toMatchObject({ role: "timestamp", rule: "content" });
});

// ports: "higher snapshot reference cannot mask rollback of the cached
// snapshot itself", "trusted input conversion preserves snapshot's own higher
// version"
test("rule 3: a timestamp may not name a snapshot below ANY snapshot version this Machine authenticated — by reference or as a snapshot", () => {
  const { fixture, facts, text } = repository();
  fixture.release("stable", { sequence: 1, version: "1.0.0" });
  fixture.publish();
  fixture.publish();
  const vector = mergeFloors(emptyFloors, facts());
  // Version 4 of the timestamp, naming the still served snapshot 1.
  fixture.publish({ timestampReferences: 1 });
  const lowered = factsOf("timestamp.json", text("/metadata/timestamp.json"));
  expect(lowered).toMatchObject({ version: 4, snapshot: { version: 1 } });
  expect(violationOf(vector, lowered)).toEqual({
    role: "timestamp",
    rule: "snapshot-reference",
    floor: 3,
    offered: 1,
  });
  // The reference floor alone (only a timestamp was ever captured, e.g. as an
  // expired floor) binds a later snapshot too…
  const referenceOnly = mergeFloors(emptyFloors, [
    factsOf("timestamp.json", text("/metadata/timestamp.json")),
  ]);
  expect(referenceOnly.snapshot).toBeNull();
  // …and the snapshot's OWN verified version binds a timestamp whose recorded
  // reference floor is lower.
  const snapshotOnly = mergeFloors(emptyFloors, [
    factsOf("snapshot.json", text("/metadata/3.snapshot.json")),
  ]);
  expect(violationOf(snapshotOnly, lowered)).toMatchObject({
    rule: "snapshot-reference",
    floor: 3,
  });
  expect(
    violationOf(
      mergeFloors(emptyFloors, [
        factsOf("timestamp.json", text("/metadata/timestamp.json")),
        {
          kind: "timestamp",
          version: 9,
          signedSha256: "b".repeat(64),
          snapshot: { version: 7 },
        },
      ]),
      factsOf("snapshot.json", text("/metadata/3.snapshot.json")),
    ),
  ).toEqual({
    role: "snapshot",
    rule: "snapshot-reference",
    floor: 7,
    offered: 3,
  });
});

// ports: "publication comparison refuses … omitted roles" (entry removed,
// entry lowered), "a later snapshot retains missing historical role floors
// without pretending it is accepted"
test("rule 4: no snapshot.meta entry that was ever recorded may disappear, go down, or name other content at the same version", () => {
  const { fixture, facts } = repository();
  fixture.release("stable", { sequence: 1, version: "1.0.0" });
  fixture.publish({ extraMeta: { "retained.json": 12 } });
  const vector = mergeFloors(emptyFloors, facts());
  expect(vector.snapshot?.meta).toMatchObject({
    "targets.json": { version: 2 },
    "retained.json": { version: 12 },
  });
  fixture.publish();
  expect(violations(vector, facts())).toEqual(["retained.json:snapshot-meta"]);
  fixture.publish({ extraMeta: { "retained.json": 11 } });
  expect(violations(vector, facts())).toEqual(["retained.json:snapshot-meta"]);
  fixture.publish({ extraMeta: { "retained.json": 12, "new.json": 1 } });
  const grown = facts();
  expect(violations(vector, grown)).toEqual([]);
  // A refused snapshot never erases what was recorded; an accepted one only
  // adds.
  expect(mergeFloors(vector, grown).snapshot?.meta).toMatchObject({
    "targets.json": { version: 5 },
    "retained.json": { version: 12 },
    "new.json": { version: 1 },
  });
  // An entry may not fall below a role of that name that was VERIFIED, even
  // when no snapshot entry recorded it.
  const verifiedOnly = mergeFloors(emptyFloors, [
    {
      kind: "role",
      name: "targets.json",
      version: 9,
      signedSha256: "a".repeat(64),
    },
  ]);
  expect(violations(verifiedOnly, grown)).toEqual([
    "targets.json:snapshot-meta",
    "targets.json:version",
  ]);
});

// ports: "partial subsequent cycles cannot erase earlier authenticated floors",
// "continuation rejects serialized floors … without mutating its input"
test("the vector is an element-wise maximum: partial and lower cycles never lower it, inputs are never mutated, and its text is canonical and strictly parsed", () => {
  const { fixture, facts, text } = repository();
  fixture.release("stable", { sequence: 1, version: "1.0.0" });
  const first = facts();
  fixture.publish();
  const second = facts();
  fixture.publish();
  const timestampOnly = [
    factsOf("timestamp.json", text("/metadata/timestamp.json")),
  ];
  const initial = mergeFloors(emptyFloors, second);
  const before = serializeFloors(initial);
  // A cycle that got only as far as the timestamp…
  const partial = mergeFloors(initial, timestampOnly);
  expect(partial).toMatchObject({
    timestamp: { version: 3, snapshot: { version: 3 } },
    snapshot: { version: 2 },
    roles: { "targets.json": { version: 2 } },
  });
  // …then a complete LOWER cycle, merged without having been compared.
  const lower = mergeFloors(partial, first);
  expect(serializeFloors(lower)).toBe(serializeFloors(partial));
  expect(serializeFloors(mergeFloors(lower, []))).toBe(serializeFloors(lower));
  expect(serializeFloors(initial)).toBe(before);
  // Merge order does not matter.
  expect(
    serializeFloors(mergeFloors(mergeFloors(emptyFloors, first), second)),
  ).toBe(serializeFloors(mergeFloors(mergeFloors(emptyFloors, second), first)));
  expect(parseFloors(serializeFloors(partial))).toEqual(partial);
  for (const damaged of [
    "",
    "{}",
    '{"schemaVersion":2}',
    serializeFloors(partial).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ),
    serializeFloors(partial).replace(
      /"signedSha256":"[a-f0-9]{8}/,
      '"signedSha256":"XXXXXXXX',
    ),
  ])
    expect(() => parseFloors(damaged)).toThrow();
});

// ————— Through the check, against the signed loopback repository —————

async function scenario() {
  const fixture = createUpdateFixture({ executionTarget: target });
  const base = join(
    await realpath(await mkdtemp(join(tmpdir(), "update-floors-"))),
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
      identity: { version: "1.0.0", commit: "a".repeat(40), target },
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
  const trust = join(base, "trust");
  const snapshot = async () => {
    const entries: Record<string, string> = {};
    for (const name of (await readdir(trust)).sort())
      entries[name] = await readFile(join(trust, name), "utf8");
    return entries;
  };
  const vector = async () =>
    parseFloors(await readFile(join(trust, "floors.json"), "utf8"));
  const roleVersion = async (name: string) =>
    JSON.parse(await readFile(join(trust, name), "utf8")).signed.version;
  // Established at generation 3, then ALL role keys are rotated: every
  // retained role file is signed by a revoked key and no longer loads in the
  // client, so the client's own rollback checks have nothing to compare with.
  const rotatedAt3 = async () => {
    fixture.release("stable", { sequence: 1, version: "1.2.0" });
    await check({ bootstrapRoot: fixture.bootstrapRoot });
    fixture.publish({ extraMeta: { "retained.json": 12 } });
    fixture.publish({ extraMeta: { "retained.json": 12 } });
    expect(await check()).toMatchObject({ kind: "available" });
    expect(await roleVersion("timestamp.json")).toBe(3);
  };
  const rotateRoleKeys = () =>
    fixture.rotateRoot({ rotate: ["timestamp", "snapshot", "targets"] });
  const targetRequests = () =>
    fixture.requests.filter((path) => path.startsWith("/targets/"));
  return {
    fixture,
    base,
    trust,
    check,
    snapshot,
    vector,
    roleVersion,
    rotatedAt3,
    rotateRoleKeys,
    targetRequests,
  };
}

// ports: every rule above "across root rotation" — the case the retained
// mechanism exists for ("root rotation requires consecutive version and old
// plus new authorization" keeps its own equivalent in update-trust.test.ts)
test("after a rotation that revoked every role key the client itself is blind; the vector refuses a lower version, a lowered reference, a removed or lowered meta entry and other content at the same version, looks up no target, and keeps only the root chain", async () => {
  for (const [name, attack, expected] of [
    [
      "lower version of everything",
      { at: 2, extraMeta: { "retained.json": 12 } },
      { role: "timestamp", rule: "version", floor: 3, offered: 2 },
    ],
    [
      "timestamp names an older snapshot",
      { timestampReferences: 1, extraMeta: { "retained.json": 12 } },
      { role: "timestamp", rule: "snapshot-reference", floor: 3, offered: 1 },
    ],
    [
      "snapshot.meta entry removed",
      {},
      { role: "retained.json", rule: "snapshot-meta", floor: 12, offered: 0 },
    ],
    [
      "snapshot.meta entry lowered",
      { extraMeta: { "retained.json": 11 } },
      { role: "retained.json", rule: "snapshot-meta", floor: 12, offered: 11 },
    ],
    [
      "same version, other signed content",
      {
        at: 3,
        extraMeta: { "retained.json": 12 },
        expires: { targets: later },
      },
      { role: "timestamp", rule: "content", floor: 3, offered: 3 },
    ],
  ] as const) {
    const s = await scenario();
    await s.rotatedAt3();
    const before = await s.snapshot();
    // The rotation itself publishes generation 4 with the new keys; what the
    // Machine is then served instead is the attack, signed by the NEW keys.
    s.fixture.rotateRoot({ rotate: ["timestamp", "snapshot", "targets"] });
    s.fixture.publish(attack);
    s.fixture.requests.length = 0;
    expect([name, await s.check()]).toEqual([
      name,
      { kind: "error", code: "metadata-rollback", context: expected },
    ]);
    // 3. No target was looked up under a refused refresh.
    expect(s.targetRequests()).toEqual([]);
    // Only the valid root chain was kept (and recorded in the vector).
    const after = await s.snapshot();
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(before), "2.root.json"].sort(),
    );
    for (const role of ["timestamp.json", "snapshot.json", "targets.json"])
      expect(after[role]).toBe(before[role] as string);
    expect(JSON.parse(after["root.json"] ?? "").signed.version).toBe(2);
    expect(await s.vector()).toMatchObject({
      root: { version: 2 },
      timestamp: { version: 3 },
      snapshot: { version: 3, meta: { "retained.json": { version: 12 } } },
      roles: { "targets.json": { version: 3 } },
    });
    // No wedge: what a repository that only moves forward serves is accepted.
    s.fixture.publish({ at: 6, extraMeta: { "retained.json": 12 } });
    expect(await s.check()).toMatchObject({ kind: "available" });
    expect(await s.roleVersion("targets.json")).toBe(6);
  }
}, 60_000);

// ports: the interruption half of "partial subsequent cycles cannot erase
// earlier authenticated floors"
test("interrupted after the vector and before the files: the older, still valid generation — which the client would now accept again — is refused, and the same or a newer generation is not", async () => {
  const s = await scenario();
  s.fixture.release("stable", { sequence: 1, version: "1.2.0" });
  await s.check({ bootstrapRoot: s.fixture.bootstrapRoot });
  s.fixture.publish();
  let done = 0;
  const dying: DurableWriter = async (...args) => {
    // Exactly one durable write survives: floors.json, which is first.
    if (done >= 1) throw new Error("killed");
    done += 1;
    await writeDurableFile(...args);
  };
  expect(await s.check({ writeDurable: dying })).toMatchObject({
    code: "internal",
  });
  expect(await s.roleVersion("timestamp.json")).toBe(1);
  expect(await s.vector()).toMatchObject({ timestamp: { version: 2 } });
  // For the client generation 1 is "no change": it would succeed and
  // authorize targets. The vector is what says no.
  s.fixture.rewindTo(1);
  s.fixture.requests.length = 0;
  expect(await s.check()).toEqual({
    kind: "error",
    code: "metadata-rollback",
    context: { role: "timestamp", rule: "version", floor: 2, offered: 1 },
  });
  expect(s.targetRequests()).toEqual([]);
  // A vector that is ahead does not wedge: the generation it was written for
  // is a no-op for it and is promoted…
  s.fixture.rewindTo(2);
  expect(await s.check()).toMatchObject({ kind: "available" });
  expect(await s.roleVersion("targets.json")).toBe(2);
  // …and so is a repository that simply advances.
  s.fixture.publish();
  s.fixture.publish();
  expect(await s.check()).toMatchObject({ kind: "available" });
  expect(await s.vector()).toMatchObject({
    timestamp: { version: 4 },
    roles: { "targets.json": { version: 4 } },
  });
  s.fixture.rewindTo(3);
  expect(await s.check()).toMatchObject({ code: "metadata-rollback" });
});

// ports: "explicit previously trusted mixed-stage cache retains all historical
// versions"
test("a missing or damaged floors.json is rebuilt from the retained files, each under the retained root that was valid for it — across a rotation — and never blocks a check or resets to empty", async () => {
  const s = await scenario();
  await s.rotatedAt3();
  // Rotation of every role key, and a refresh that gets only as far as the
  // timestamp: trust/ now holds a timestamp signed by the NEW key and a
  // snapshot and targets signed by REVOKED ones.
  s.rotateRoleKeys();
  s.fixture.block(`/metadata/${s.fixture.version()}.snapshot.json`);
  expect(await s.check()).toMatchObject({ code: "network-unavailable" });
  expect(await s.roleVersion("root.json")).toBe(2);
  expect(await s.roleVersion("timestamp.json")).toBe(4);
  expect(await s.roleVersion("snapshot.json")).toBe(3);
  const recorded = await s.vector();
  expect(recorded).toMatchObject({
    root: { version: 2 },
    timestamp: { version: 4, snapshot: { version: 4 } },
    snapshot: { version: 3, meta: { "retained.json": { version: 12 } } },
    roles: { "targets.json": { version: 3 } },
  });
  expect(Object.keys(recorded.root.retained)).toEqual(["1", "2"]);
  expect(await rebuildFloors(s.trust)).toEqual(recorded);
  for (const damage of [
    () => rm(join(s.trust, "floors.json")),
    () => writeFile(join(s.trust, "floors.json"), "{ not json"),
    () => writeFile(join(s.trust, "floors.json"), '{"schemaVersion":2}'),
  ]) {
    await damage();
    // The rebuilt vector still refuses what the recorded one refused…
    s.fixture.publish({ at: 2, extraMeta: { "retained.json": 12 } });
    expect(await s.check()).toMatchObject({
      code: "metadata-rollback",
      context: { role: "timestamp", rule: "version", floor: 4 },
    });
    // …and is written back, equal to what was there before.
    expect(await s.vector()).toEqual(recorded);
  }
  // A role file that verifies under NO retained root states nothing, and the
  // rest still stands.
  const stranger = createUpdateFixture({ executionTarget: target });
  cleanups.push(() => stranger.stop());
  stranger.release("stable", { sequence: 1, version: "9.9.9" });
  for (let generation = 0; generation < 8; generation++) stranger.publish();
  await writeFile(
    join(s.trust, "targets.json"),
    stranger.served("/metadata/9.targets.json") as Buffer,
  );
  expect(await rebuildFloors(s.trust)).toEqual({ ...recorded, roles: {} });
  expect(await rebuildFloors(join(s.trust, "absent"))).toEqual(emptyFloors);
});
