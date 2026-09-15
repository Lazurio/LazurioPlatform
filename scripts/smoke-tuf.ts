import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
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
import {
  prepareInstallLocation,
  resolveInstallLocation,
} from "../src/distribution/install-location";
import {
  downloadPilotUnderOwner,
  readPublishedPilotTrust,
  recoverPilotAttempts,
} from "../src/distribution/installation-state";
import { replayPilotTrust } from "../src/distribution/replay-pilot";
import { stagePilotCandidate } from "../src/distribution/staging";
import { DistributionTransport } from "../src/distribution/transport";
import {
  parseTrustCheckpoint,
  readTrustCheckpoint,
  writeNewTrustCheckpoint,
} from "../src/distribution/trust-checkpoint";
import { folderStateSchemas } from "../src/folder/state";
import { artifactIdentity } from "./artifact-identity";

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
const identityPath = `artifacts/${hash(payload).sha256}/identity.json`;
// Fixture identity for the supplied bytes; the label is synthetic, not a build.
const identityFor = (target: string, schemas = folderStateSchemas) =>
  Buffer.from(
    JSON.stringify({
      kind: "unsigned-development-candidate",
      identity: artifactIdentity({
        version: "0.0.0",
        target,
        sourceCommit: "0".repeat(40),
        toolchain: "bun@1.4.2",
        schemas,
        lockfile: Buffer.from("fixture lock"),
        artifact: payload,
      }),
    }),
  );
let identityBytes = identityFor("linux-arm64");
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
        [identityPath]: new TargetFile({
          path: identityPath,
          length: identityBytes.length,
          hashes: hash(identityBytes),
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
    [`/targets/${identityPath}`, identityBytes],
  ]);
};
let served = repository(2);
let requestCount = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    requestCount++;
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
    const beforeReplay = requestCount;
    const recovered = await replayPilotTrust(
      join(fixture, "owned-tamper"),
      join(fixture, "recovered"),
      "linux-arm64",
    );
    assert.equal(requestCount, beforeReplay);
    assert.equal(recovered.outcome, "complete");
    if (recovered.outcome !== "complete") throw new Error("unreachable");
    assert.equal(recovered.selection.sequence, 3);
    assert.equal(
      JSON.parse(recovered.checkpoint.metadata.timestamp).signed.version,
      3,
    );
    const replayedTrust: PilotTrust = {
      kind: "established",
      checkpoint: recovered.checkpoint,
      channel: recovered.selection,
    };
    served = repository(2);
    await assert.rejects(
      download("recovered-timestamp-rollback", replayedTrust),
      /New timestamp version 2 is less than current version 3/,
    );
    served = repository(4, false, 2);
    await assert.rejects(
      download("recovered-channel-rollback", replayedTrust),
      /Channel rollback/,
    );
    await assert.rejects(
      replayPilotTrust(
        join(fixture, "owned-tamper"),
        join(fixture, "recovered"),
        "linux-arm64",
      ),
      /EEXIST/,
    );
    const channelPath = join(fixture, "owned-tamper", "channel.json");
    const originalChannel = await readFile(channelPath);
    await writeFile(channelPath, Buffer.alloc(originalChannel.length, 65));
    await assert.rejects(
      replayPilotTrust(
        join(fixture, "owned-tamper"),
        join(fixture, "replay-bad-channel"),
        "linux-arm64",
      ),
      /Expected hash/,
    );
    await writeFile(channelPath, originalChannel);
    const snapshotPath = join(journal, "002-snapshot.json");
    const originalSnapshot = await readFile(snapshotPath);
    await writeFile(snapshotPath, Buffer.alloc(originalSnapshot.length, 65));
    await assert.rejects(
      replayPilotTrust(
        join(fixture, "owned-tamper"),
        join(fixture, "replay-bad-metadata"),
        "linux-arm64",
      ),
    );
    await writeFile(snapshotPath, originalSnapshot);
    await rename(snapshotPath, join(fixture, "saved-snapshot"));
    await assert.rejects(
      replayPilotTrust(
        join(fixture, "owned-tamper"),
        join(fixture, "replay-gap"),
        "linux-arm64",
      ),
      /Incomplete/,
    );
    await rename(join(fixture, "saved-snapshot"), snapshotPath);
    served = repository(4, true);
    await assert.rejects(download("owned-expired", established), /expired/);
    await assert.rejects(
      replayPilotTrust(
        join(fixture, "owned-expired"),
        join(fixture, "replay-expired"),
        "linux-arm64",
      ),
      /expired/,
    );
    console.log(
      "PASS: offline TUF replay restores metadata and channel high-water after payload failure; altered, missing, expired and occupied evidence refused",
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
  {
    // Installation state owner: one lock, one published trust record, pending
    // attempts reconciled by offline replay before any new refresh.
    const location = await prepareInstallLocation(
      resolveInstallLocation({
        platform: "linux",
        env: { XDG_DATA_HOME: join(fixture, "xdg") },
        homedir: fixture,
      }),
    );
    const root = location.owner;
    const network = {
      executionTarget: "linux-arm64",
      metadataBaseUrl: `${server.url}metadata/`,
      targetBaseUrl: `${server.url}targets/`,
      allowedOrigins: [server.url.origin],
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      maxArtifactBytes: payload.length,
      loopbackFixture: true,
    };
    const bootstrapRoot = rootBytes.toString();
    const attempts = join(root, "attempts");
    const history = join(root, "history");
    const selected = join(root, "trust", "selected.json");
    assert.equal(await readPublishedPilotTrust(root), null);
    await assert.rejects(
      downloadPilotUnderOwner({ root, ...network }),
      /Bootstrap root required/,
    );
    const first = await downloadPilotUnderOwner({
      root,
      bootstrapRoot,
      ...network,
    });
    assert.equal(first.published.trust.channel.sequence, 2);
    assert.equal(first.candidate.sha256, hash(payload).sha256);
    assert.deepEqual(await readFile(first.candidate.path), payload);
    assert.deepEqual(await readdir(attempts), []);
    assert.deepEqual(await readdir(history), [first.attempt]);
    assert.deepEqual(await readPublishedPilotTrust(root), first.published);
    await assert.rejects(
      downloadPilotUnderOwner({ root, bootstrapRoot, ...network }),
      /bootstrap refused/,
    );
    served = repository(3);
    const second = await downloadPilotUnderOwner({ root, ...network });
    assert.equal(second.published.trust.channel.sequence, 3);
    assert.notEqual(second.attempt, first.attempt);
    // Payload failure: metadata v4 accepted, artifact refused, attempt pending.
    served = repository(4);
    served.set(`/targets/${artifactPath}`, Buffer.alloc(payload.length, 65));
    await assert.rejects(
      downloadPilotUnderOwner({ root, ...network }),
      /Expected hash/,
    );
    const [pendingTamper] = await readdir(attempts);
    assert.ok(pendingTamper);
    await assert.rejects(
      downloadPilotUnderOwner({ root, ...network }),
      /requires recovery/,
    );
    assert.deepEqual(await readPublishedPilotTrust(root), second.published);
    const beforeRecovery = requestCount;
    assert.deepEqual(
      await recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
      [{ attempt: pendingTamper, published: true, candidate: null }],
    );
    assert.equal(requestCount, beforeRecovery);
    const reconciled = await readPublishedPilotTrust(root);
    assert.ok(reconciled);
    assert.equal(reconciled.generation, pendingTamper);
    assert.equal(reconciled.trust.channel.sequence, 4);
    assert.equal(
      JSON.parse(reconciled.trust.checkpoint.metadata.timestamp).signed.version,
      4,
    );
    assert.deepEqual(await readdir(attempts), []);
    // The reconciled trust, not the pre-failure checkpoint, governs the next
    // refresh: a mirror serving the older repository is refused and that
    // refusal reconciles to no progress instead of blocking the owner.
    served = repository(3);
    await assert.rejects(
      downloadPilotUnderOwner({ root, ...network }),
      /New timestamp version 3 is less than current version 4/,
    );
    const [pendingRollback] = await readdir(attempts);
    assert.ok(pendingRollback);
    assert.deepEqual(
      await recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
      [{ attempt: pendingRollback, published: false, candidate: null }],
    );
    assert.deepEqual(await readPublishedPilotTrust(root), reconciled);
    // Channel failure after accepted metadata v5: metadata progress publishes,
    // the channel high-water stays at 4 and no candidate is claimed.
    served = repository(5);
    const goodChannel = served.get("/targets/channels/pilot.json");
    assert.ok(goodChannel);
    served.set(
      "/targets/channels/pilot.json",
      Buffer.alloc(goodChannel.length, 65),
    );
    await assert.rejects(
      downloadPilotUnderOwner({ root, ...network }),
      /Expected hash/,
    );
    const [pendingChannel] = await readdir(attempts);
    assert.ok(pendingChannel);
    assert.deepEqual(
      await recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
      [{ attempt: pendingChannel, published: true, candidate: null }],
    );
    const metadataOnly = await readPublishedPilotTrust(root);
    assert.ok(metadataOnly);
    assert.equal(metadataOnly.generation, pendingChannel);
    assert.equal(metadataOnly.trust.channel.sequence, 4);
    assert.equal(
      JSON.parse(metadataOnly.trust.checkpoint.metadata.timestamp).signed
        .version,
      5,
    );
    served = repository(5);
    const fifth = await downloadPilotUnderOwner({ root, ...network });
    assert.equal(fifth.published.trust.channel.sequence, 5);
    assert.deepEqual(await readFile(fifth.candidate.path), payload);
    // Unreachable origin: no response was recorded, so nothing is reconciled.
    served = new Map();
    await assert.rejects(downloadPilotUnderOwner({ root, ...network }));
    const [pendingOffline] = await readdir(attempts);
    assert.ok(pendingOffline);
    assert.deepEqual(
      await readdir(join(attempts, pendingOffline, "received-metadata")),
      [],
    );
    assert.deepEqual(
      await recoverPilotAttempts({ root, executionTarget: "linux-arm64" }),
      [{ attempt: pendingOffline, published: false, candidate: null }],
    );
    assert.deepEqual(await readPublishedPilotTrust(root), fifth.published);
    // Interrupted publication after the generation write but before the
    // selection: recovery republishes the same generation and keeps the candidate.
    served = repository(6);
    const sixth = await downloadPilotUnderOwner({ root, ...network });
    await rename(join(history, sixth.attempt), join(attempts, sixth.attempt));
    await writeFile(
      selected,
      JSON.stringify({
        schemaVersion: 1,
        generation: fifth.attempt,
        channel: fifth.published.trust.channel,
      }),
    );
    await assert.rejects(
      downloadPilotUnderOwner({ root, ...network }),
      /requires recovery/,
    );
    const republished = await recoverPilotAttempts({
      root,
      executionTarget: "linux-arm64",
    });
    assert.deepEqual(
      republished.map((entry) => ({
        attempt: entry.attempt,
        published: entry.published,
        sha256: entry.candidate?.sha256,
      })),
      [
        {
          attempt: sixth.attempt,
          published: true,
          sha256: hash(payload).sha256,
        },
      ],
    );
    assert.deepEqual(await readPublishedPilotTrust(root), sixth.published);
    // Interrupted after the selection but before closing the attempt.
    await rename(join(history, sixth.attempt), join(attempts, sixth.attempt));
    assert.deepEqual(
      (
        await recoverPilotAttempts({ root, executionTarget: "linux-arm64" })
      ).map((entry) => ({
        attempt: entry.attempt,
        published: entry.published,
        sha256: entry.candidate?.sha256,
      })),
      [
        {
          attempt: sixth.attempt,
          published: false,
          sha256: hash(payload).sha256,
        },
      ],
    );
    assert.deepEqual(await readPublishedPilotTrust(root), sixth.published);
    assert.deepEqual(await readdir(attempts), []);
    // A damaged selection without a pending attempt is never first install.
    const selectedBytes = await readFile(selected);
    await rm(selected);
    await assert.rejects(readPublishedPilotTrust(root), /requires recovery/);
    await assert.rejects(
      downloadPilotUnderOwner({ root, bootstrapRoot, ...network }),
      /requires recovery/,
    );
    await assert.rejects(
      recoverPilotAttempts({
        root,
        bootstrapRoot,
        executionTarget: "linux-arm64",
      }),
      /requires recovery/,
    );
    // Restore with an explicit private mode; an inherited group-writable umask
    // must not turn the fixture's repair into an unsafe selection file.
    await writeFile(selected, selectedBytes, { mode: 0o600 });
    assert.deepEqual(await readPublishedPilotTrust(root), sixth.published);
    console.log(
      "PASS: installation owner publishes trust and channel high-water under one lock, reconciles pending attempts offline, refuses stale/damaged state and never resets to bootstrap",
    );
    // Staging: bind the closed candidate to its authenticated identity and
    // publish one immutable versioned directory; nothing becomes active.
    const versions = location.versions;
    const stage = (attempt: string, executionTarget = "linux-arm64") =>
      stagePilotCandidate({
        location,
        attempt,
        executionTarget,
        requiredSchemas: folderStateSchemas,
      });
    await assert.rejects(stage(fifth.attempt), /not selectable/);
    await assert.rejects(stage(sixth.attempt, "linux-x64"), /not selectable/);
    const staged = await stage(sixth.attempt);
    assert.equal(staged.alreadyStaged, false);
    assert.equal(staged.name, `0.0.0+${hash(payload).sha256.slice(0, 16)}`);
    assert.equal(staged.identity.artifactSha256, hash(payload).sha256);
    assert.deepEqual(staged.identity.schemas, {
      preferences: [1],
      manifest: [1],
    });
    assert.deepEqual(await readFile(staged.artifactPath), payload);
    assert.equal((await stat(staged.artifactPath)).mode & 0o777, 0o500);
    assert.deepEqual((await readdir(staged.directory)).sort(), [
      "identity.json",
      "lazurio",
      "provenance.json",
    ]);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(staged.directory, "provenance.json"), "utf8"),
      ),
      {
        schemaVersion: 1,
        attempt: sixth.attempt,
        channel: sixth.published.trust.channel,
        artifactSha256: hash(payload).sha256,
      },
    );
    assert.deepEqual(await readdir(versions), [staged.name]);
    const again = await stage(sixth.attempt);
    assert.equal(again.alreadyStaged, true);
    assert.equal(again.directory, staged.directory);
    // An occupied name whose layout or bytes differ is refused, never
    // overwritten; the staged artifact stays intact.
    await chmod(join(staged.directory, "identity.json"), 0o600);
    await writeFile(join(staged.directory, "identity.json"), "{}");
    await assert.rejects(stage(sixth.attempt), /immutable file|Conflicting/);
    assert.deepEqual(await readFile(staged.artifactPath), payload);
    await writeFile(join(staged.directory, "identity.json"), identityBytes);
    await chmod(join(staged.directory, "identity.json"), 0o400);
    assert.equal((await stage(sixth.attempt)).alreadyStaged, true);
    // Identity refusals: wrong platform label and a release that cannot read
    // the required schemas are refused before any directory is created.
    for (const [index, [label, bytes]] of (
      [
        ["different platform", identityFor("linux-x64")],
        [
          "required schema",
          identityFor("linux-arm64", { preferences: [2], manifest: [1] }),
        ],
      ] as const
    ).entries()) {
      identityBytes = bytes;
      // Each fixture publication needs a new version; the client keeps an
      // equal-version cache and would otherwise compare stale target lengths.
      served = repository(7 + index);
      const wrong = await downloadPilotUnderOwner({ root, ...network });
      await assert.rejects(stage(wrong.attempt), new RegExp(label));
      assert.deepEqual(await readdir(versions), [staged.name]);
    }
    identityBytes = identityFor("linux-arm64");
    // A leftover staging directory from an interruption is retained, never
    // adopted, and does not block a fresh staging of another version.
    await mkdir(join(versions, ".staging-deadbeefdeadbeef"), { mode: 0o700 });
    served = repository(9);
    const eighth = await downloadPilotUnderOwner({ root, ...network });
    const restaged = await stage(eighth.attempt);
    assert.equal(restaged.alreadyStaged, true);
    assert.deepEqual((await readdir(versions)).sort(), [
      ".staging-deadbeefdeadbeef",
      staged.name,
    ]);
    // Foreign content in the versions directory blocks staging, unremoved.
    await writeFile(join(versions, "foreign-owned-content"), "x", {
      mode: 0o600,
    });
    await assert.rejects(stage(eighth.attempt), /Unknown content/);
    await rm(join(versions, "foreign-owned-content"));
    // A validly named foreign directory, file or link beside the staged
    // product blocks staging as well; foreign bytes stay untouched.
    const foreignName = "9.9.9+fedcba9876543210";
    const foreignPath = join(versions, foreignName);
    await mkdir(foreignPath, { mode: 0o700 });
    await writeFile(join(foreignPath, "lazurio"), "not ours", { mode: 0o600 });
    await assert.rejects(stage(eighth.attempt), /staged version layout/);
    assert.equal(
      await readFile(join(foreignPath, "lazurio"), "utf8"),
      "not ours",
    );
    await rm(foreignPath, { recursive: true });
    await writeFile(foreignPath, "not ours", { mode: 0o600 });
    await assert.rejects(stage(eighth.attempt));
    assert.equal(await readFile(foreignPath, "utf8"), "not ours");
    await rm(foreignPath);
    await symlink(staged.directory, foreignPath);
    await assert.rejects(stage(eighth.attempt), /Canonical/);
    await rm(foreignPath);
    assert.equal((await stage(eighth.attempt)).alreadyStaged, true);
    assert.deepEqual((await readdir(versions)).sort(), [
      ".staging-deadbeefdeadbeef",
      staged.name,
    ]);
    assert.deepEqual(await readPublishedPilotTrust(root), eighth.published);
    console.log(
      "PASS: staging binds the closed candidate to its signed identity, checks read compatibility, publishes one immutable versioned directory and never touches an active version",
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
  served.set(`/targets/${artifactPath}`, Buffer.alloc(payload.length, 65));
  const rotatedAttempt = join(fixture, "rotated-download");
  await assert.rejects(
    downloadPilotCandidate({
      directory: rotatedAttempt,
      trust: { kind: "bootstrap", trustedRoot: rootBytes.toString() },
      executionTarget: "linux-arm64",
      metadataBaseUrl: `${server.url}metadata/`,
      targetBaseUrl: `${server.url}targets/`,
      allowedOrigins: [server.url.origin],
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      maxArtifactBytes: payload.length,
      loopbackFixture: true,
    }),
    /Expected hash/,
  );
  const rootReplayed = await replayPilotTrust(
    rotatedAttempt,
    join(fixture, "replayed-root"),
    "linux-arm64",
  );
  assert.equal(rootReplayed.outcome, "complete");
  if (rootReplayed.outcome !== "complete") throw new Error("unreachable");
  assert.equal(rootReplayed.checkpoint.metadata.root, acceptedRoot.toString());
  assert.equal(rootReplayed.selection.sequence, 2);
  await writeFile(
    join(rotatedAttempt, "received-metadata", "001-2.root.json"),
    rotatedRoot(true, false),
  );
  await assert.rejects(
    replayPilotTrust(
      rotatedAttempt,
      join(fixture, "replay-unilateral-root"),
      "linux-arm64",
    ),
    /root was signed by 0\/1 keys/,
  );
  console.log(
    "PASS: replay re-verifies old/new root rotation from original anchor and rejects unilateral replacement",
  );
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
