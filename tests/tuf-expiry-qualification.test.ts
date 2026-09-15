import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  Key,
  Metadata,
  MetaFile,
  Root,
  Signature,
  Snapshot,
  Timestamp,
} from "@tufjs/models";
import { BadVersionError, ExpiredMetadataError } from "tuf-js/dist/error";
import { TrustedMetadataStore } from "tuf-js/dist/store";

// Qualification of pinned tuf-js 6 internals, NOT a recovery implementation.
// No clock override: expired metadata may retain a rollback floor but cannot
// authorize targets. Production still uses Updater and refuses expired replay.
function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const key = new Key({
    keyID: "ephemeral-qualification",
    keyType: "ed25519",
    scheme: "ed25519",
    keyVal: {
      public: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  });
  const fresh = new Date(Date.now() + 86_400_000).toISOString();
  const expired = new Date(Date.now() - 86_400_000).toISOString();
  const fields = (version: number, expires = fresh) => ({
    version,
    expires,
    specVersion: "1.0.0",
  });
  const signed = (value: Root | Timestamp | Snapshot) => {
    const metadata = new Metadata(value);
    metadata.sign(
      (bytes) =>
        new Signature({
          keyID: key.keyID,
          sig: sign(null, bytes, pair.privateKey).toString("hex"),
        }),
    );
    return Buffer.from(JSON.stringify(metadata.toJSON()));
  };
  return {
    expired,
    root(version = 1, expires = fresh) {
      const root = new Root({ ...fields(version, expires) });
      for (const role of ["root", "timestamp", "snapshot", "targets"])
        root.addKey(key, role);
      return signed(root);
    },
    timestamp(version: number, snapshotVersion: number, expires = fresh) {
      return signed(
        new Timestamp({
          ...fields(version, expires),
          snapshotMeta: new MetaFile({ version: snapshotVersion }),
        }),
      );
    },
    snapshot(version: number, targetsVersion: number, expires = fresh) {
      return signed(
        new Snapshot({
          ...fields(version, expires),
          meta: { "targets.json": new MetaFile({ version: targetsVersion }) },
        }),
      );
    },
  };
}

test("expired timestamp retains both rollback floors but blocks snapshot until fresh replacement", () => {
  const f = fixture();
  const store = new TrustedMetadataStore(f.root());
  expect(() => store.updateTimestamp(f.timestamp(7, 9, f.expired))).toThrow(
    ExpiredMetadataError,
  );
  expect(store.timestamp?.signed.version).toBe(7);
  expect(store.timestamp?.signed.snapshotMeta.version).toBe(9);
  expect(() => store.updateSnapshot(f.snapshot(9, 4))).toThrow(
    ExpiredMetadataError,
  );
  expect(store.snapshot).toBeUndefined();
  expect(() => store.updateTimestamp(f.timestamp(6, 9))).toThrow(
    BadVersionError,
  );
  expect(() => store.updateTimestamp(f.timestamp(8, 8))).toThrow(
    BadVersionError,
  );
  store.updateTimestamp(f.timestamp(8, 9));
  store.updateSnapshot(f.snapshot(9, 4));
  expect(store.snapshot?.signed.version).toBe(9);
  expect(store.targets).toBeUndefined();
});

test("untrusted expired timestamp cannot advance an accepted rollback floor", () => {
  const f = fixture();
  const foreign = fixture();
  const store = new TrustedMetadataStore(f.root());
  store.updateTimestamp(f.timestamp(7, 9));
  expect(() =>
    store.updateTimestamp(foreign.timestamp(100, 100, foreign.expired)),
  ).toThrow();
  expect(store.timestamp?.signed.version).toBe(7);
  expect(store.timestamp?.signed.snapshotMeta.version).toBe(9);
});

test("expired snapshot retains targets floor and cannot authorize targets", () => {
  const f = fixture();
  const store = new TrustedMetadataStore(f.root());
  store.updateTimestamp(f.timestamp(7, 9));
  expect(() => store.updateSnapshot(f.snapshot(9, 4, f.expired))).toThrow(
    ExpiredMetadataError,
  );
  expect(store.snapshot?.signed.meta["targets.json"]?.version).toBe(4);
  // Expiry must stop processing before these invalid target bytes are parsed.
  expect(() =>
    store.updateDelegatedTargets(Buffer.from("invalid"), "targets", "root"),
  ).toThrow(ExpiredMetadataError);
  expect(store.targets).toBeUndefined();
  expect(() => store.updateSnapshot(f.snapshot(9, 3))).toThrow(BadVersionError);
  expect(store.snapshot?.signed.meta["targets.json"]?.version).toBe(4);
});

test("expired root can advance only through signed consecutive roots before timestamp", () => {
  const f = fixture();
  const store = new TrustedMetadataStore(f.root(1, f.expired));
  expect(() => store.updateTimestamp(f.timestamp(1, 1))).toThrow(
    ExpiredMetadataError,
  );
  expect(() => store.updateRoot(f.root(3))).toThrow(BadVersionError);
  expect(store.root.signed.version).toBe(1);
  store.updateRoot(f.root(2));
  store.updateTimestamp(f.timestamp(1, 1));
  expect(store.root.signed.version).toBe(2);
  expect(store.timestamp?.signed.version).toBe(1);
});
