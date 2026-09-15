import { createHash, generateKeyPairSync, sign } from "node:crypto";
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

/** Local synthetic signed pilot repository for development smokes. One
 * ephemeral key for all roles is NOT a production key policy; the served
 * bytes never leave the loopback fixture server. Not a release publisher.
 */
export function createPilotFixture(input: {
  artifact: Buffer;
  identity: Buffer;
  executionTarget: string;
}) {
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
  const digest = hash(input.artifact).sha256;
  const artifactPath = `artifacts/${digest}/lazurio`;
  const identityPath = `artifacts/${digest}/identity.json`;
  const repository = (version: number) => {
    const channel = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        channel: "pilot",
        sequence: version,
        targets: { [input.executionTarget]: artifactPath },
      }),
    );
    const target = (path: string, bytes: Buffer) =>
      new TargetFile({ path, length: bytes.length, hashes: hash(bytes) });
    const targets = signed(
      new Targets({
        ...fields(version),
        targets: {
          "channels/pilot.json": target("channels/pilot.json", channel),
          [artifactPath]: target(artifactPath, input.artifact),
          [identityPath]: target(identityPath, input.identity),
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
      ["/targets/channels/pilot.json", channel],
      [`/targets/${artifactPath}`, input.artifact],
      [`/targets/${identityPath}`, input.identity],
    ]);
  };
  let served = repository(1);
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
  return Object.freeze({
    rootBytes,
    artifactSha256: digest,
    metadataBaseUrl: `${server.url}metadata/`,
    targetBaseUrl: `${server.url}targets/`,
    origin: server.url.origin,
    publish(version: number) {
      served = repository(version);
    },
    async stop() {
      await server.stop(true);
    },
  });
}
