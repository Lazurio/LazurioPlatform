import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  Key,
  Metadata,
  MetaFile,
  Root,
  Signature,
  Snapshot,
  Targets,
  Timestamp,
} from "@tufjs/models";
import {
  assertCheckpointRetainsFloors,
  authenticateHistoricalRoles,
  continueHistoricalRoles,
  historicalFloorsFromTrustedCheckpoint,
} from "../src/distribution/historical-roles";
import { parseTrustCheckpoint } from "../src/distribution/trust-checkpoint";

function signer(id: string) {
  const pair = generateKeyPairSync("ed25519");
  return {
    key: new Key({
      keyID: id,
      keyType: "ed25519",
      scheme: "ed25519",
      keyVal: {
        public: pair.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
    }),
    sign: (bytes: Buffer) =>
      new Signature({
        keyID: id,
        sig: sign(null, bytes, pair.privateKey).toString("hex"),
      }),
  };
}
function fixture() {
  const keys = {
    root: signer("root"),
    timestamp: signer("timestamp"),
    snapshot: signer("snapshot"),
    targets: signer("targets"),
  };
  const expires = new Date(Date.now() - 86_400_000).toISOString();
  const fields = (version: number) => ({
    version,
    expires,
    specVersion: "1.0.0",
  });
  const encode = (
    value: Root | Timestamp | Snapshot | Targets,
    signing = keys[value.type].sign,
  ) => {
    const metadata = new Metadata(value);
    metadata.sign(signing);
    return JSON.stringify(metadata.toJSON());
  };
  const root = new Root(fields(1));
  for (const role of ["root", "timestamp", "snapshot", "targets"] as const)
    root.addKey(keys[role].key, role);
  const link = (bytes: string, version: number) =>
    new MetaFile({
      version,
      length: Buffer.byteLength(bytes),
      hashes: { sha256: createHash("sha256").update(bytes).digest("hex") },
    });
  const targets = encode(new Targets(fields(4)));
  const snapshot = encode(
    new Snapshot({ ...fields(9), meta: { "targets.json": link(targets, 4) } }),
  );
  const timestamp = encode(
    new Timestamp({ ...fields(7), snapshotMeta: link(snapshot, 9) }),
  );
  const records = [
    { name: "timestamp.json", bytes: timestamp },
    { name: "9.snapshot.json", bytes: snapshot },
    { name: "4.targets.json", bytes: targets },
  ];
  return { anchor: encode(root), root, keys, fields, encode, link, records };
}

test("higher snapshot reference cannot mask rollback of the cached snapshot itself", () => {
  const f = fixture();
  const checkpoint = parseTrustCheckpoint({
    schemaVersion: 1,
    metadata: {
      root: f.anchor,
      timestamp: f.encode(
        new Timestamp({
          ...f.fields(11),
          snapshotMeta: new MetaFile({ version: 13 }),
        }),
      ),
      snapshot: f.records[1]?.bytes,
      targets: f.records[2]?.bytes,
    },
  });
  const previous = historicalFloorsFromTrustedCheckpoint(checkpoint);
  const candidate = {
    ...checkpoint,
    metadata: {
      ...checkpoint.metadata,
      snapshot: f.encode(
        new Snapshot({
          ...f.fields(8),
          meta: { "targets.json": f.link(f.records[2]?.bytes ?? "", 4) },
        }),
      ),
    },
  };
  expect(previous.snapshotVersion).toBe(13);
  expect(() => assertCheckpointRetainsFloors(previous, candidate)).toThrow(
    "snapshot content version rollback",
  );
});

for (const role of ["timestamp", "snapshot", "targets"] as const) {
  test(`validly signed ${role} cannot extend expiry at the same version`, () => {
    const f = fixture();
    const previous = authenticateHistoricalRoles(f.anchor, f.records);
    const before = JSON.stringify(previous);
    const fresh = new Date(Date.now() + 86_400_000).toISOString();
    const targets =
      role === "targets"
        ? f.encode(new Targets({ ...f.fields(4), expires: fresh }))
        : (f.records[2]?.bytes ?? "");
    const snapshotVersion = role === "targets" ? 10 : 9;
    const snapshot =
      role === "timestamp"
        ? (f.records[1]?.bytes ?? "")
        : f.encode(
            new Snapshot({
              ...f.fields(snapshotVersion),
              ...(role === "snapshot" ? { expires: fresh } : {}),
              meta: { "targets.json": f.link(targets, 4) },
            }),
          );
    const timestamp = f.encode(
      new Timestamp({
        ...f.fields(role === "timestamp" ? 7 : 8),
        ...(role === "timestamp" ? { expires: fresh } : {}),
        snapshotMeta: f.link(snapshot, snapshotVersion),
      }),
    );
    const records = [
      { name: "timestamp.json", bytes: timestamp },
      { name: `${snapshotVersion}.snapshot.json`, bytes: snapshot },
      { name: "4.targets.json", bytes: targets },
    ];
    // The new chain is signature/link-valid in isolation; the earlier binding
    // is what makes reuse of the same version unacceptable.
    expect(() => authenticateHistoricalRoles(f.anchor, records)).not.toThrow();
    expect(() => continueHistoricalRoles(previous, records)).toThrow(
      `${role} content changed at the same version`,
    );
    const candidate = parseTrustCheckpoint({
      schemaVersion: 1,
      metadata: { root: f.anchor, timestamp, snapshot, targets },
    });
    expect(() => assertCheckpointRetainsFloors(previous, candidate)).toThrow(
      `${role} content changed at the same version`,
    );
    expect(JSON.stringify(previous)).toBe(before);
  });
}

test("content bindings ignore JSON formatting but retain unknown signed fields", () => {
  const f = fixture();
  const previous = authenticateHistoricalRoles(f.anchor, f.records);
  const metadata = {
    root: f.anchor,
    timestamp: f.records[0]?.bytes ?? "",
    snapshot: f.records[1]?.bytes ?? "",
    targets: f.records[2]?.bytes ?? "",
  };
  const candidate = parseTrustCheckpoint({ schemaVersion: 1, metadata });
  const changed = JSON.parse(candidate.metadata.timestamp);
  changed.signed = Object.fromEntries(Object.entries(changed.signed).reverse());
  const formatted = {
    ...candidate,
    metadata: {
      ...candidate.metadata,
      timestamp: JSON.stringify(changed, null, 2),
    },
  };
  expect(() =>
    assertCheckpointRetainsFloors(previous, formatted),
  ).not.toThrow();
  changed.signed.customBinding = "new signed content";
  const unknown = {
    ...candidate,
    metadata: { ...candidate.metadata, timestamp: JSON.stringify(changed) },
  };
  expect(() => assertCheckpointRetainsFloors(previous, unknown)).toThrow(
    "timestamp content changed at the same version",
  );
});

test("publication comparison refuses lost counters, omitted roles and root substitution", () => {
  const f = fixture();
  const checkpoint = parseTrustCheckpoint({
    schemaVersion: 1,
    metadata: {
      root: f.anchor,
      timestamp: f.records[0]?.bytes,
      snapshot: f.records[1]?.bytes,
      targets: f.records[2]?.bytes,
    },
  });
  const floors = historicalFloorsFromTrustedCheckpoint(checkpoint);
  expect(() => assertCheckpointRetainsFloors(floors, checkpoint)).not.toThrow();
  const alter = (
    role: "timestamp" | "snapshot" | "targets",
    change: (signed: {
      version: number;
      meta: Record<string, { version: number }>;
    }) => void,
  ) => {
    const value = JSON.parse(checkpoint.metadata[role]);
    change(value.signed);
    return {
      ...checkpoint,
      metadata: { ...checkpoint.metadata, [role]: JSON.stringify(value) },
    };
  };
  expect(() =>
    assertCheckpointRetainsFloors(
      floors,
      alter("timestamp", (s) => {
        s.version = 6;
      }),
    ),
  ).toThrow("timestampVersion rollback");
  expect(() =>
    assertCheckpointRetainsFloors(
      floors,
      alter("targets", (s) => {
        s.version = 3;
      }),
    ),
  ).toThrow("targetsVersion rollback");
  expect(() =>
    assertCheckpointRetainsFloors(
      floors,
      alter("snapshot", (s) => {
        delete s.meta["targets.json"];
      }),
    ),
  ).toThrow("snapshot role rollback or omission");
  expect(() =>
    assertCheckpointRetainsFloors(
      floors,
      alter("snapshot", (s) => {
        s.meta["targets.json"] = { version: 3 };
      }),
    ),
  ).toThrow("snapshot role rollback or omission");
  expect(() =>
    assertCheckpointRetainsFloors(floors, {
      ...checkpoint,
      metadata: { ...checkpoint.metadata, root: fixture().anchor },
    }),
  ).toThrow("root substitution");
  expect(() =>
    assertCheckpointRetainsFloors(
      JSON.parse(JSON.stringify(floors)),
      checkpoint,
    ),
  ).toThrow("reconstructed authentication");
});

test("partial subsequent cycles cannot erase earlier authenticated floors", () => {
  const f = fixture();
  const initial = authenticateHistoricalRoles(f.anchor, f.records);
  const before = JSON.stringify(initial);
  const timestamp = f.encode(
    new Timestamp({
      ...f.fields(8),
      snapshotMeta: new MetaFile({ version: 10 }),
    }),
  );
  const partial = continueHistoricalRoles(initial, [
    { name: "timestamp.json", bytes: timestamp },
  ]);
  expect(partial.timestampVersion).toBe(8);
  expect(partial.snapshotVersion).toBe(10);
  expect(partial.snapshotRoles).toEqual({ "targets.json": 4 });
  expect(partial.targetsVersion).toBe(4);
  const lower = continueHistoricalRoles(partial, f.records);
  expect(lower.timestampVersion).toBe(8);
  expect(lower.snapshotVersion).toBe(10);
  expect(lower.snapshotRoles).toEqual({ "targets.json": 4 });
  expect(lower.targetsVersion).toBe(4);
  expect(continueHistoricalRoles(lower, [])).toEqual(lower);
  expect(JSON.stringify(initial)).toBe(before);
});

test("explicit previously trusted mixed-stage cache retains all historical versions", () => {
  const f = fixture();
  // Synthetic previously accepted cache: newer timestamp, older cached snapshot
  // and targets. This is not evidence that arbitrary cache bytes are trusted.
  const checkpoint = parseTrustCheckpoint({
    schemaVersion: 1,
    metadata: {
      root: f.anchor,
      timestamp: f.encode(
        new Timestamp({
          ...f.fields(11),
          snapshotMeta: new MetaFile({ version: 13 }),
        }),
      ),
      snapshot: f.records[1]?.bytes,
      targets: f.records[2]?.bytes,
    },
  });
  const before = JSON.stringify(checkpoint);
  const initial = historicalFloorsFromTrustedCheckpoint(checkpoint);
  expect(initial.timestampVersion).toBe(11);
  expect(initial.snapshotVersion).toBe(13);
  expect(initial.snapshotRoles).toEqual({ "targets.json": 4 });
  expect(initial.targetsVersion).toBe(4);
  expect(continueHistoricalRoles(initial, f.records)).toEqual(initial);
  expect(JSON.stringify(checkpoint)).toBe(before);
  expect("selection" in initial).toBe(false);
});

test("trusted input conversion preserves snapshot's own higher version and refuses malformed references", () => {
  const f = fixture();
  const checkpoint = parseTrustCheckpoint({
    schemaVersion: 1,
    metadata: {
      root: f.anchor,
      timestamp: f.encode(
        new Timestamp({
          ...f.fields(7),
          snapshotMeta: new MetaFile({ version: 8 }),
        }),
      ),
      snapshot: f.records[1]?.bytes,
      targets: f.records[2]?.bytes,
    },
  });
  expect(
    historicalFloorsFromTrustedCheckpoint(checkpoint).snapshotVersion,
  ).toBe(9);
  const invalid = JSON.parse(JSON.stringify(checkpoint));
  const timestamp = JSON.parse(invalid.metadata.timestamp);
  timestamp.signed.meta["snapshot.json"].version = Number.MAX_SAFE_INTEGER + 1;
  invalid.metadata.timestamp = JSON.stringify(timestamp);
  expect(() => historicalFloorsFromTrustedCheckpoint(invalid)).toThrow();
  expect(() =>
    historicalFloorsFromTrustedCheckpoint({
      ...checkpoint,
      extra: true,
    } as typeof checkpoint),
  ).toThrow();
});

test("a later snapshot retains missing historical role floors without pretending it is accepted", () => {
  const f = fixture();
  const snapshot = f.encode(
    new Snapshot({
      ...f.fields(9),
      meta: {
        "targets.json": new MetaFile({ version: 4 }),
        "retained.json": new MetaFile({ version: 12 }),
      },
    }),
  );
  const timestamp = f.encode(
    new Timestamp({ ...f.fields(7), snapshotMeta: f.link(snapshot, 9) }),
  );
  const initial = authenticateHistoricalRoles(f.anchor, [
    { name: "timestamp.json", bytes: timestamp },
    { name: "9.snapshot.json", bytes: snapshot },
  ]);
  const nextSnapshot = f.encode(
    new Snapshot({
      ...f.fields(10),
      meta: { "targets.json": f.link(f.records[2]?.bytes ?? "", 4) },
    }),
  );
  const nextTimestamp = f.encode(
    new Timestamp({
      ...f.fields(8),
      snapshotMeta: f.link(nextSnapshot, 10),
    }),
  );
  const result = continueHistoricalRoles(initial, [
    { name: "timestamp.json", bytes: nextTimestamp },
    { name: "10.snapshot.json", bytes: nextSnapshot },
    { name: "4.targets.json", bytes: f.records[2]?.bytes ?? "" },
  ]);
  expect(result.snapshotRoles).toEqual({
    "targets.json": 4,
    "retained.json": 12,
  });
  expect(result.kind).toBe("historical-floors-only");
  expect(Object.isFrozen(result.snapshotRoles)).toBe(true);
});

test("continuation rejects serialized floors and foreign signatures without mutating its input", () => {
  const f = fixture();
  const initial = authenticateHistoricalRoles(f.anchor, f.records);
  const before = JSON.stringify(initial);
  expect(() => continueHistoricalRoles(JSON.parse(before), [])).toThrow(
    "reconstructed authentication",
  );
  expect(() => continueHistoricalRoles({ ...initial }, [])).toThrow(
    "reconstructed authentication",
  );
  expect(() => continueHistoricalRoles(initial, fixture().records)).toThrow();
  expect(JSON.stringify(initial)).toBe(before);
});

test("expired distinct-role chain authenticates floors, not a checkpoint or target", () => {
  const f = fixture();
  const before = JSON.stringify(f.records);
  const result = authenticateHistoricalRoles(f.anchor, f.records);
  expect(result.kind).toBe("historical-floors-only");
  expect(result.rootVersion).toBe(1);
  expect(result.timestampVersion).toBe(7);
  expect(result.snapshotVersion).toBe(9);
  expect(result.snapshotRoles).toEqual({ "targets.json": 4 });
  expect(result.targetsVersion).toBe(4);
  expect("metadata" in result).toBe(false);
  expect("selection" in result).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.snapshotRoles)).toBe(true);
  expect(JSON.stringify(f.records)).toBe(before);
  const partial = authenticateHistoricalRoles(f.anchor, f.records.slice(0, 1));
  expect(partial.snapshotVersion).toBe(9);
  expect(partial.targetsVersion).toBeUndefined();
  expect(partial.snapshotRoles).toEqual({});
});

test("signatures and both metadata links are required even for historical floors", () => {
  const f = fixture();
  const foreign = fixture();
  expect(() =>
    authenticateHistoricalRoles(f.anchor, foreign.records),
  ).toThrow();
  for (const index of [0, 1, 2]) {
    const records = f.records.map((record) => ({ ...record }));
    const record = records[index];
    if (!record) throw new Error("fixture");
    const value = JSON.parse(record.bytes);
    value.signed.version += 1;
    record.bytes = JSON.stringify(value);
    expect(() => authenticateHistoricalRoles(f.anchor, records)).toThrow();
  }
  const otherTargets = f.encode(new Targets(f.fields(4)));
  // Different bytes with a valid targets signature must not bypass the snapshot hash.
  const changed = JSON.parse(otherTargets);
  changed.signed.expires = new Date(Date.now() - 172_800_000).toISOString();
  const targets = Targets.fromJSON(changed.signed);
  const altered = f.records.map((record) => ({ ...record }));
  altered[2] = { name: "4.targets.json", bytes: f.encode(targets) };
  expect(() => authenticateHistoricalRoles(f.anchor, altered)).toThrow();
});

test("gaps, repeated roles, wrong filename versions and duplicate JSON are refused", () => {
  const f = fixture();
  expect(() =>
    authenticateHistoricalRoles(f.anchor, f.records.slice(1)),
  ).toThrow();
  expect(() =>
    authenticateHistoricalRoles(f.anchor, [...f.records, ...f.records]),
  ).toThrow();
  const wrongName = f.records.map((record) => ({ ...record }));
  wrongName[1] = { name: "8.snapshot.json", bytes: f.records[1]?.bytes ?? "" };
  expect(() => authenticateHistoricalRoles(f.anchor, wrongName)).toThrow();
  const duplicate = f.anchor.replace('"version":1', '"version":1,"version":1');
  expect(duplicate).not.toBe(f.anchor);
  expect(() => authenticateHistoricalRoles(duplicate, [])).toThrow();
});

test("root rotation requires consecutive version and old plus new authorization", () => {
  const f = fixture();
  const nextKey = signer("next-root");
  const next = new Root(f.fields(2));
  next.addKey(nextKey.key, "root");
  for (const role of ["timestamp", "snapshot", "targets"] as const)
    next.addKey(f.keys[role].key, role);
  const metadata = new Metadata(next);
  metadata.sign(f.keys.root.sign);
  const oldOnly = JSON.stringify(metadata.toJSON());
  expect(() =>
    authenticateHistoricalRoles(f.anchor, [
      { name: "2.root.json", bytes: oldOnly },
    ]),
  ).toThrow();
  metadata.sign(nextKey.sign);
  const both = JSON.stringify(metadata.toJSON());
  const previous = authenticateHistoricalRoles(f.anchor, f.records);
  const rootOnly = continueHistoricalRoles(previous, [
    { name: "2.root.json", bytes: both },
  ]);
  expect(rootOnly.rootVersion).toBe(2);
  expect(rootOnly.timestampVersion).toBe(7);
  expect(rootOnly.snapshotVersion).toBe(9);
  expect(rootOnly.snapshotRoles).toEqual({ "targets.json": 4 });
  expect(rootOnly.targetsVersion).toBe(4);
  const result = authenticateHistoricalRoles(f.anchor, [
    { name: "2.root.json", bytes: both },
    ...f.records,
  ]);
  expect(result.rootVersion).toBe(2);
  expect(result.root).toBe(both);
  expect(result.timestampVersion).toBe(7);
  expect(() =>
    authenticateHistoricalRoles(f.anchor, [
      { name: "3.root.json", bytes: both },
    ]),
  ).toThrow();
  const newOnly = new Metadata(next);
  newOnly.sign(nextKey.sign);
  expect(() =>
    authenticateHistoricalRoles(f.anchor, [
      { name: "2.root.json", bytes: JSON.stringify(newOnly.toJSON()) },
    ]),
  ).toThrow();
});
