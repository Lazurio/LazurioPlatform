import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
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

/** Local synthetic signed repository for the update core: consistent
 * snapshots, one ephemeral key PER role, numbered immutable roots, snapshots
 * and targets, hash-addressed channel documents, and old objects retained —
 * the layout docs/update.md "Publishing" prescribes. Keys never leave this
 * process and the bytes never leave the loopback server. Not a publisher.
 */
type RoleName = "root" | "targets" | "snapshot" | "timestamp";
type Signer = { key: Key; secret: KeyObject };
export type FixtureChannel = Readonly<{
  sequence: number;
  version: string;
  minimumVersion?: string;
  /** Replace the generated document, e.g. to publish a malformed one. */
  rawDocument?: string;
  /** Omit this Machine's target from the document. */
  withoutTarget?: boolean;
}>;

function signer(id: string): Signer {
  const pair = generateKeyPairSync("ed25519");
  return {
    secret: pair.privateKey,
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
  };
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export function createUpdateFixture(input: {
  executionTarget: string;
  artifact?: Buffer;
}) {
  const artifact =
    input.artifact ?? Buffer.from("Synthetic artifact; never executed.");
  const artifactSha256 = sha256(artifact);
  const artifactPath = `artifacts/${artifactSha256}/lazurio`;
  const future = () => new Date(Date.now() + 3600_000).toISOString();
  const signers: Record<RoleName, Signer> = {
    root: signer("root-1"),
    targets: signer("targets-1"),
    snapshot: signer("snapshot-1"),
    timestamp: signer("timestamp-1"),
  };
  const served = new Map<string, Buffer>();
  const blocked = new Map<string, number>();
  const requests: string[] = [];
  const channels = new Map<string, FixtureChannel>();
  const timestamps = new Map<number, Buffer>();
  let rootVersion = 0;
  let version = 0;

  const signedBy = (
    value: Root | Targets | Snapshot | Timestamp,
    by: readonly Signer[],
  ) => {
    const metadata = new Metadata(value);
    for (const { key, secret } of by)
      metadata.sign(
        (bytes) =>
          new Signature({
            keyID: key.keyID,
            sig: sign(null, bytes, secret).toString("hex"),
          }),
      );
    return Buffer.from(JSON.stringify(metadata.toJSON()));
  };

  /** Publish root N+1. A rotation replaces the root key and is signed by both
   * the outgoing and the incoming key, as the client requires.
   */
  const publishRoot = (options: {
    rotate?: RoleName[];
    expires?: string;
  }): Buffer => {
    const outgoing = signers.root;
    for (const role of options.rotate ?? [])
      signers[role] = signer(`${role}-${rootVersion + 2}`);
    rootVersion += 1;
    const root = new Root({
      version: rootVersion,
      specVersion: "1.0.0",
      expires: options.expires ?? future(),
      consistentSnapshot: true,
    });
    for (const role of ["root", "targets", "snapshot", "timestamp"] as const)
      root.addKey(signers[role].key, role);
    const bytes = signedBy(
      root,
      outgoing === signers.root ? [outgoing] : [outgoing, signers.root],
    );
    served.set(`/metadata/${rootVersion}.root.json`, bytes);
    return bytes;
  };

  /** Publish one complete generation; every numbered object stays served. */
  const publish = (
    options: {
      expires?: Partial<Record<"targets" | "snapshot" | "timestamp", string>>;
      tamper?: "snapshot" | "targets";
      /** Publish THIS generation number instead of the next one, signed by
       * the current keys: a publisher (or whoever holds its keys) going back,
       * or saying something else at a version it already used. */
      at?: number;
      /** Further `snapshot.meta` entries, by file name → version. */
      extraMeta?: Readonly<Record<string, number>>;
      /** Let the timestamp name the snapshot of an OLDER generation that is
       * still served, instead of the one published now. */
      timestampReferences?: number;
    } = {},
  ) => {
    version = options.at ?? version + 1;
    const files: Record<string, TargetFile> = {
      [artifactPath]: new TargetFile({
        path: artifactPath,
        length: artifact.length,
        hashes: { sha256: artifactSha256 },
      }),
    };
    for (const [name, channel] of channels) {
      const document = Buffer.from(
        channel.rawDocument ??
          JSON.stringify({
            schemaVersion: 1,
            channel: name,
            sequence: channel.sequence,
            version: channel.version,
            minimumVersion: channel.minimumVersion ?? "0.0.1",
            targets: channel.withoutTarget
              ? {}
              : { [input.executionTarget]: artifactPath },
          }),
      );
      const path = `channels/${name}.json`;
      files[path] = new TargetFile({
        path,
        length: document.length,
        hashes: { sha256: sha256(document) },
      });
      served.set(
        `/targets/channels/${sha256(document)}.${name}.json`,
        document,
      );
    }
    const fields = (role: "targets" | "snapshot" | "timestamp") => ({
      version,
      specVersion: "1.0.0",
      expires: options.expires?.[role] ?? future(),
    });
    const targets = signedBy(
      new Targets({ ...fields("targets"), targets: files }),
      [signers.targets],
    );
    const snapshot = signedBy(
      new Snapshot({
        ...fields("snapshot"),
        meta: {
          "targets.json": new MetaFile({
            version,
            length: targets.length,
            hashes: { sha256: sha256(targets) },
          }),
          ...Object.fromEntries(
            Object.entries(options.extraMeta ?? {}).map(([name, entry]) => [
              name,
              new MetaFile({ version: entry }),
            ]),
          ),
        },
      }),
      [signers.snapshot],
    );
    const referenced =
      options.timestampReferences === undefined
        ? snapshot
        : served.get(`/metadata/${options.timestampReferences}.snapshot.json`);
    if (!referenced) throw new Error("Unknown fixture generation");
    const timestamp = signedBy(
      new Timestamp({
        ...fields("timestamp"),
        snapshotMeta: new MetaFile({
          version: options.timestampReferences ?? version,
          length: referenced.length,
          hashes: { sha256: sha256(referenced) },
        }),
      }),
      [signers.timestamp],
    );
    // Same length, different bytes: the signed hash no longer matches.
    const damaged = (bytes: Buffer) => {
      const copy = Buffer.from(bytes);
      copy[copy.length - 2] = copy[copy.length - 2] === 0x20 ? 0x0a : 0x20;
      return copy;
    };
    served.set(
      `/metadata/${version}.targets.json`,
      options.tamper === "targets" ? damaged(targets) : targets,
    );
    served.set(
      `/metadata/${version}.snapshot.json`,
      options.tamper === "snapshot" ? damaged(snapshot) : snapshot,
    );
    served.set("/metadata/timestamp.json", timestamp);
    timestamps.set(version, timestamp);
  };

  const bootstrapRoot = publishRoot({});
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const status = blocked.get(path);
      if (status !== undefined) return new Response("blocked", { status });
      const bytes = served.get(path);
      return bytes
        ? new Response(new Uint8Array(bytes))
        : new Response("not found", { status: 404 });
    },
  });
  return Object.freeze({
    bootstrapRoot,
    artifactSha256,
    artifactLength: artifact.length,
    metadataBaseUrl: `${server.url}metadata/`,
    targetBaseUrl: `${server.url}targets/`,
    origin: server.url.origin,
    requests,
    /** Serve the timestamp of an OLDER generation again: what an attacker
     * replaying a once-valid repository state would do. Every numbered object
     * of that generation is still served. */
    rewindTo(generation: number) {
      const timestamp = timestamps.get(generation);
      if (!timestamp) throw new Error("Unknown fixture generation");
      served.set("/metadata/timestamp.json", timestamp);
    },
    /** Set a channel's document and publish a new generation. */
    release(
      channel: "stable" | "preview",
      document: FixtureChannel,
      options?: Parameters<typeof publish>[0],
    ) {
      channels.set(channel, document);
      publish(options);
    },
    publish,
    /** Rotate the named role keys (default: root) into root N+1, then publish
     * a generation signed by the current keys. */
    rotateRoot(options: { rotate?: RoleName[]; expires?: string } = {}) {
      publishRoot({ rotate: options.rotate ?? ["root"], ...options });
      publish();
    },
    /** Root N+1 with unchanged keys, e.g. to replace an expired root. */
    renewRoot: () => publishRoot({}),
    rootVersion: () => rootVersion,
    version: () => version,
    block(path: string, status = 404) {
      blocked.set(path, status);
    },
    unblock(path: string) {
      blocked.delete(path);
    },
    served: (path: string) => served.get(path),
    /** Serve other bytes under an existing path. */
    substitute(path: string, bytes: Buffer) {
      served.set(path, bytes);
    },
    async stop() {
      await server.stop(true);
    },
  });
}
