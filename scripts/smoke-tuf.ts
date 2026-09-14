import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
import {
  downloadPilotCandidate,
  type PilotTrust,
} from "../src/distribution/download-pilot";
import { DistributionTransport } from "../src/distribution/transport";
import {
  parseTrustCheckpoint,
  readTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "../src/distribution/trust-checkpoint";

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
const repository = (
  version: number,
  expired = false,
  channelSequence = version,
) => {
  const channel = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      channel: "pilot",
      sequence: channelSequence,
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
const fixture = await realpath(
  await mkdtemp(join(tmpdir(), "tuf-updater-fixture-")),
);
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
  {
    const download = (
      name: string,
      trust: PilotTrust,
      maxArtifactBytes = payload.length,
    ) =>
      downloadPilotCandidate({
        directory: join(fixture, name),
        trust,
        executionTarget: "linux-arm64",
        metadataBaseUrl: `${server.url}metadata/`,
        targetBaseUrl: `${server.url}targets/`,
        allowedOrigins: [server.url.origin],
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        maxArtifactBytes,
        loopbackFixture: true,
      });
    const downloaded = await download("owned-download", {
      kind: "bootstrap",
      trustedRoot: rootBytes.toString(),
    });
    assert.deepEqual(await readFile(downloaded.artifactPath), payload);
    assert.deepEqual(
      await readTrustCheckpoint(join(fixture, "owned-download", "checkpoint")),
      downloaded.checkpoint,
    );
    const established: PilotTrust = {
      kind: "established",
      checkpoint: downloaded.checkpoint,
      channel: downloaded.selection,
    };
    const retry = await download("owned-retry", established);
    assert.deepEqual(retry.selection, downloaded.selection);
    await assert.rejects(download("owned-download", established), /EEXIST/);
    served = repository(3, false, 1);
    await assert.rejects(
      download("owned-channel-rollback", established),
      /Channel rollback/,
    );
    served = repository(3);
    served.set(`/targets/${artifactPath}`, Buffer.alloc(payload.length, 65));
    await assert.rejects(
      download("owned-tamper", established),
      /Expected hash/,
    );
    const retainedInput = JSON.parse(
      await readFile(join(fixture, "owned-tamper", "input-trust.json"), "utf8"),
    );
    assert.equal(retainedInput.kind, "established");
    assert.deepEqual(retainedInput.metadata, downloaded.checkpoint.metadata);
    assert.equal(retainedInput.channel.sequence, 2);
    const journal = join(fixture, "owned-tamper", "received-metadata");
    const records = (await readdir(journal)).sort();
    assert.deepEqual(records, [
      "001-timestamp.json",
      "002-snapshot.json",
      "003-targets.json",
    ]);
    for (const name of records)
      assert.deepEqual(
        await readFile(join(journal, name)),
        served.get(`/metadata/${name.slice(4)}`),
      );
    await assert.rejects(
      readFile(join(fixture, "owned-tamper", "checkpoint", "trust.json")),
      /ENOENT/,
    );
    served = repository(3);
    await assert.rejects(
      download("owned-oversize", established, payload.length - 1),
      /identity or size/,
    );
    const upgraded = await download("owned-upgrade", established);
    assert.equal(upgraded.selection.sequence, 3);
    assert.deepEqual(await readFile(upgraded.artifactPath), payload);
    assert.deepEqual(await readFile(downloaded.artifactPath), payload);
    assert.deepEqual(
      await readTrustCheckpoint(join(fixture, "owned-download", "checkpoint")),
      downloaded.checkpoint,
    );
    console.log(
      "PASS: shared verified download, established retry/update, channel rollback, payload tamper, size and existing-output refusal; prior download preserved",
    );
    served = repository(2);
  }
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
  // Characterize a damaged cache: the library alone cannot remember discarded
  // versions. An installer must retain independently durable high-water state.
  served = repository(2);
  const damaged = await client("damaged-cache");
  await damaged.refresh();
  assert.ok(await damaged.getTargetInfo("channels/pilot.json"));
  const checkpointPath = join(fixture, "trust-checkpoint");
  const metadata = Object.fromEntries(
    await Promise.all(
      ["root", "timestamp", "snapshot", "targets"].map(async (role) => [
        role,
        await readFile(join(fixture, "damaged-cache", `${role}.json`), "utf8"),
      ]),
    ),
  );
  await writeNewTrustCheckpoint(
    checkpointPath,
    parseTrustCheckpoint({ schemaVersion: 1, metadata }),
  );
  for (const role of ["timestamp", "snapshot", "targets"])
    await writeFile(join(fixture, "damaged-cache", `${role}.json`), "\u0000");
  served = repository(1);
  const afterDamage = new Updater({
    fetcher: transport(),
    metadataDir: join(fixture, "damaged-cache"),
    metadataBaseUrl: `${server.url}metadata/`,
    targetDir: join(fixture, "damaged-cache"),
    targetBaseUrl: `${server.url}targets/`,
  });
  await afterDamage.refresh();
  const olderChannel = await afterDamage.getTargetInfo("channels/pilot.json");
  assert.ok(olderChannel);
  const olderFile = await afterDamage.downloadTarget(olderChannel);
  const olderJson = await readFile(olderFile, "utf8");
  assert.throws(
    () => selectPilotTarget(olderJson, "linux-arm64", selection),
    /rollback/,
  );
  console.log(
    "OBSERVED: damaged TUF cache permits older signed metadata; retained channel high-water rejects it, durable retention still required",
  );
  const retained = await readTrustCheckpoint(checkpointPath);
  const restoredDirectory = join(fixture, "restored-cache");
  await mkdir(restoredDirectory, { mode: 0o700 });
  for (const [role, bytes] of Object.entries(retained.metadata))
    await writeFile(join(restoredDirectory, `${role}.json`), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  const restored = new Updater({
    fetcher: transport(),
    metadataDir: restoredDirectory,
    metadataBaseUrl: `${server.url}metadata/`,
  });
  await assert.rejects(
    restored.refresh(),
    /New timestamp version 1 is less than current version 2/,
  );
  console.log(
    "PASS: reloading retained checkpoint into a separate fixture preserves TUF timestamp rollback refusal; not automated crash recovery",
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
