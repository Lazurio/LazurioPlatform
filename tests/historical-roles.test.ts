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
import { authenticateHistoricalRoles } from "../src/distribution/historical-roles";

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
