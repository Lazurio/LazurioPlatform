import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Key,
  Metadata,
  MetaFile,
  Root,
  Signature,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from "@tufjs/models";
import { Updater } from "tuf-js";
import { selectPilotTarget } from "../src/distribution/channel";
import { DistributionTransport } from "../src/distribution/transport";

// Local synthetic repository only. One ephemeral test key for all roles is NOT
// a proposed production key-management policy. No installation takes place.
const pair = generateKeyPairSync("ed25519");
const key = new Key({
  keyID: "fixture",
  keyType: "ed25519",
  scheme: "ed25519",
  keyVal: {
    public: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  },
});
const expires = new Date(Date.now() + 3600_000).toISOString();
const fields = (version: number) => ({
  version,
  specVersion: "1.0.0",
  expires,
});
const signed = (value: Root | Targets | Timestamp | Snapshot) => {
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
const hash = (bytes: Buffer) => ({
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const root = new Root({ ...fields(1), consistentSnapshot: false });
for (const role of ["root", "targets", "snapshot", "timestamp"])
  root.addKey(key, role);
const rootBytes = signed(root);
const artifact = process.argv[2];
assert.ok(
  artifact,
  "Supply an explicit candidate artifact; it will not be executed",
);
const payload = await readFile(artifact);
const artifactPath = `artifacts/${hash(payload).sha256}/lazurio`;
const repository = (version: number, expired = false) => {
  const channel = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      channel: "pilot",
      sequence: version,
      targets: { "linux-arm64": artifactPath },
    }),
  );
  const targets = signed(
    new Targets({
      ...fields(version),
      targets: {
        "channels/pilot.json": new TargetFile({
          path: "channels/pilot.json",
          length: channel.length,
          hashes: hash(channel),
        }),
        [artifactPath]: new TargetFile({
          path: artifactPath,
          length: payload.length,
          hashes: hash(payload),
        }),
        "artifact.bin": new TargetFile({
          path: "artifact.bin",
          length: payload.length,
          hashes: hash(payload),
        }),
      },
    }),
  );
  const snapshot = signed(
    new Snapshot({
      ...fields(version),
      meta: {
        "targets.json": new MetaFile({
          version,
          length: targets.length,
          hashes: hash(targets),
        }),
      },
    }),
  );
  const timestamp = signed(
    new Timestamp({
      ...fields(version),
      ...(expired ? { expires: "2000-01-01T00:00:00Z" } : {}),
      snapshotMeta: new MetaFile({
        version,
        length: snapshot.length,
        hashes: hash(snapshot),
      }),
    }),
  );
  return new Map<string, Buffer>([
    ["/metadata/timestamp.json", timestamp],
    ["/metadata/snapshot.json", snapshot],
    ["/metadata/targets.json", targets],
    ["/targets/artifact.bin", payload],
    ["/targets/channels/pilot.json", channel],
    [`/targets/${artifactPath}`, payload],
  ]);
};
let served = repository(2);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const bytes = served.get(new URL(request.url).pathname);
    return bytes
      ? new Response(new Uint8Array(bytes))
      : new Response("not found", { status: 404 });
  },
});
const fixture = await mkdtemp(join(tmpdir(), "tuf-updater-fixture-"));
const transport = () =>
  new DistributionTransport(
    [server.url.origin],
    30_000,
    new AbortController().signal,
    true,
  );
async function client(name: string) {
  const directory = join(fixture, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "root.json"), rootBytes, { mode: 0o600 });
  return new Updater({
    fetcher: transport(),
    metadataDir: directory,
    metadataBaseUrl: `${server.url}metadata/`,
    targetDir: directory,
    targetBaseUrl: `${server.url}targets/`,
    config: { fetchRetries: 0, fetchRetry: false, fetchTimeout: 1000 },
  });
}
try {
  const valid = await client("valid");
  await valid.refresh();
  const channelTarget = await valid.getTargetInfo("channels/pilot.json");
  assert.ok(channelTarget);
  const channelFile = await valid.downloadTarget(channelTarget);
  const selection = selectPilotTarget(
    await readFile(channelFile, "utf8"),
    "linux-arm64",
  );
  const selectedTarget = await valid.getTargetInfo(selection.targetPath);
  assert.ok(selectedTarget);
  assert.equal(selectedTarget.hashes.sha256, hash(payload).sha256);
  assert.equal(selectedTarget.length, payload.length);
  const selectedFile = await valid.downloadTarget(selectedTarget);
  assert.deepEqual(await readFile(selectedFile), payload);
  const channelBytes = await readFile(channelFile);
  served.set(
    "/targets/channels/pilot.json",
    Buffer.alloc(channelBytes.length, 65),
  );
  let selectedTamperedChannel = false;
  await assert.rejects(async () => {
    const alteredFile = await valid.downloadTarget(channelTarget);
    selectedTamperedChannel = true;
    selectPilotTarget(await readFile(alteredFile, "utf8"), "linux-arm64");
  }, /Expected hash/);
  assert.equal(selectedTamperedChannel, false);
  assert.deepEqual(await readFile(channelFile), channelBytes);
  assert.deepEqual(await readFile(selectedFile), payload);
  served.set("/targets/channels/pilot.json", channelBytes);
  console.log(
    "PASS: TUF-authenticated channel selects a TUF-verified artifact; platform label is a synthetic fixture, not qualification",
  );
  const target = await valid.getTargetInfo("artifact.bin");
  assert.ok(target);
  const downloaded = await valid.downloadTarget(target);
  assert.deepEqual(await readFile(downloaded), payload);
  served.set("/targets/artifact.bin", Buffer.alloc(payload.length, 65));
  await assert.rejects(
    valid.downloadTarget(target, join(fixture, "tampered-target")),
    /Expected hash/,
  );
  served = repository(1);
  const cached = new Updater({
    fetcher: transport(),
    metadataDir: join(fixture, "valid"),
    metadataBaseUrl: `${server.url}metadata/`,
    config: { fetchRetries: 0, fetchRetry: false, fetchTimeout: 1000 },
  });
  await assert.rejects(
    cached.refresh(),
    /New timestamp version 1 is less than current version 2/,
  );
  served = repository(1, true);
  const expired = await client("expired");
  await assert.rejects(expired.refresh(), /Final timestamp.json is expired/);
  served = repository(1);
  const timestampBytes = served.get("/metadata/timestamp.json");
  assert.ok(timestampBytes);
  const altered = JSON.parse(timestampBytes.toString());
  altered.signed.version = 99;
  served.set("/metadata/timestamp.json", Buffer.from(JSON.stringify(altered)));
  const badSignature = await client("bad-signature");
  await assert.rejects(
    badSignature.refresh(),
    /timestamp was signed by 0\/1 keys/,
  );
  // Rotate only the root role; other roles intentionally retain the fixture key.
  const successorPair = generateKeyPairSync("ed25519");
  const successorKey = new Key({
    keyID: "successor",
    keyType: "ed25519",
    scheme: "ed25519",
    keyVal: {
      public: successorPair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    },
  });
  const rotatedRoot = (oldSignature: boolean, newSignature: boolean) => {
    const next = new Root({ ...fields(2), consistentSnapshot: false });
    next.addKey(successorKey, "root");
    for (const role of ["targets", "snapshot", "timestamp"])
      next.addKey(key, role);
    const metadata = new Metadata(next);
    if (oldSignature)
      metadata.sign(
        (bytes) =>
          new Signature({
            keyID: key.keyID,
            sig: sign(null, bytes, pair.privateKey).toString("hex"),
          }),
        true,
      );
    if (newSignature)
      metadata.sign(
        (bytes) =>
          new Signature({
            keyID: successorKey.keyID,
            sig: sign(null, bytes, successorPair.privateKey).toString("hex"),
          }),
        true,
      );
    return Buffer.from(JSON.stringify(metadata.toJSON()));
  };
  for (const [name, oldSignature, newSignature] of [
    ["old-only", true, false],
    ["new-only", false, true],
  ] as const) {
    served = repository(2);
    served.set(
      "/metadata/2.root.json",
      rotatedRoot(oldSignature, newSignature),
    );
    const rejected = await client(name);
    await assert.rejects(rejected.refresh(), /root was signed by 0\/1 keys/);
    assert.deepEqual(
      await readFile(join(fixture, name, "root.json")),
      rootBytes,
    );
  }
  served = repository(2);
  const acceptedRoot = rotatedRoot(true, true);
  served.set("/metadata/2.root.json", acceptedRoot);
  const rotated = await client("rotated");
  await rotated.refresh();
  assert.deepEqual(
    await readFile(join(fixture, "rotated", "root.json")),
    acceptedRoot,
  );
  assert.ok(await rotated.getTargetInfo("artifact.bin"));
  const validDirectory = join(fixture, "valid");
  const before = new Map(
    await Promise.all(
      (await readdir(validDirectory)).map(
        async (name) =>
          [name, await readFile(join(validDirectory, name))] as const,
      ),
    ),
  );
  const metadataUrl = `${server.url}metadata/`;
  await server.stop(true);
  const offline = new Updater({
    fetcher: transport(),
    metadataDir: validDirectory,
    metadataBaseUrl: metadataUrl,
    config: { fetchRetries: 0, fetchRetry: false, fetchTimeout: 1000 },
  });
  await assert.rejects(offline.refresh(), (error: unknown) => {
    assert.ok(error instanceof Error);
    // A transport failure must not be confused with a signature/expiry refusal.
    assert.match(String(error), /connect|fetch|socket|network/i);
    return true;
  });
  assert.deepEqual(
    (await readdir(validDirectory)).sort(),
    [...before.keys()].sort(),
  );
  for (const [name, bytes] of before)
    assert.deepEqual(await readFile(join(validDirectory, name)), bytes);
  console.log(
    "PASS: TUF Updater refresh/download, target tamper, cached timestamp rollback, expired timestamp and altered signed metadata refusal",
  );
  console.log(
    "PASS: stopped-server transport failure leaves previously cached metadata and downloaded artifact byte-identical",
  );
  console.log(
    "PASS: root rotation requires old and new signatures, persists accepted root and preserves old root on unilateral replacement",
  );
  console.log(
    `Verified candidate SHA-256 ${hash(payload).sha256}; artifact never executed`,
  );
  console.log(
    "NOT TESTED: production bootstrap/key custody, installation, activation or cross-platform qualification",
  );
} finally {
  await server.stop(true);
  await rm(fixture, { recursive: true });
}
