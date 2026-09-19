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
  /** Artifact added with `addArtifact`; default: the synthetic one. */
  artifactSha256?: string;
}>;

/** How the loopback server misbehaves for one path, to prove the download. */
export type FixtureFault =
  /** Send `after` bytes of the response body, then end the response. */
  | Readonly<{ kind: "truncate"; after: number; times: number }>
  /** Same length, one byte different. */
  | Readonly<{ kind: "corrupt" }>
  /** Answer a range request with the whole object and `200`. */
  | Readonly<{ kind: "ignore-range" }>;

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
  /** Signed target path → bytes, for every artifact and identity. */
  const artifactTargets = new Map<string, Buffer>([[artifactPath, artifact]]);
  const faults = new Map<string, FixtureFault>();
  const rangeRequests: { path: string; range: string | null }[] = [];
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
    } = {},
  ) => {
    version += 1;
    const files: Record<string, TargetFile> = {};
    for (const [path, bytes] of artifactTargets) {
      files[path] = new TargetFile({
        path,
        length: bytes.length,
        hashes: { sha256: sha256(bytes) },
      });
      // Consistent-snapshot name: `<directory>/<sha256>.<file>`.
      const slash = path.lastIndexOf("/");
      served.set(
        `/targets/${path.slice(0, slash + 1)}${sha256(bytes)}.${path.slice(slash + 1)}`,
        bytes,
      );
    }
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
              : {
                  [input.executionTarget]: channel.artifactSha256
                    ? `artifacts/${channel.artifactSha256}/lazurio`
                    : artifactPath,
                },
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
        },
      }),
      [signers.snapshot],
    );
    const timestamp = signedBy(
      new Timestamp({
        ...fields("timestamp"),
        snapshotMeta: new MetaFile({
          version,
          length: snapshot.length,
          hashes: { sha256: sha256(snapshot) },
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
      let bytes = served.get(path);
      if (!bytes) return new Response("not found", { status: 404 });
      const fault = faults.get(path);
      if (fault?.kind === "corrupt") {
        bytes = Buffer.from(bytes);
        bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] as number) ^ 0xff;
      }
      const range = request.headers.get("range");
      if (path.startsWith("/targets/artifacts/"))
        rangeRequests.push({ path, range });
      const from = /^bytes=(\d+)-$/.exec(range ?? "");
      const offset =
        from && fault?.kind !== "ignore-range" ? Number(from[1]) : 0;
      if (offset >= bytes.length && offset > 0)
        return new Response("range", { status: 416 });
      const body = bytes.subarray(offset);
      const headers: Record<string, string> =
        offset > 0
          ? {
              "content-range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}`,
            }
          : {};
      if (fault?.kind === "truncate" && fault.times > 0) {
        faults.set(path, { ...fault, times: fault.times - 1 });
        const head = body.subarray(0, fault.after);
        return new Response(
          new ReadableStream({
            async pull(controller) {
              controller.enqueue(new Uint8Array(head));
              // Let the bytes leave before the response ends early.
              await Bun.sleep(50);
              controller.close();
            },
          }),
          {
            status: offset > 0 ? 206 : 200,
            headers: { ...headers, "content-length": String(body.length) },
          },
        );
      }
      return new Response(new Uint8Array(body), {
        status: offset > 0 ? 206 : 200,
        headers,
      });
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
    /** Every request for an artifact or identity, with its `Range` header. */
    rangeRequests,
    /** Add a signed artifact and its signed `identity.json`. `identity` is
     * merged over a truthful default, so a test can publish a wrong one.
     * Takes effect with the next published generation. */
    addArtifact(artifactInput: {
      bytes: Buffer;
      version: string;
      identity?: Record<string, unknown>;
      rawIdentity?: string;
    }) {
      const digest = sha256(artifactInput.bytes);
      artifactTargets.set(`artifacts/${digest}/lazurio`, artifactInput.bytes);
      artifactTargets.set(
        `artifacts/${digest}/identity.json`,
        Buffer.from(
          artifactInput.rawIdentity ??
            JSON.stringify({
              schemaVersion: 1,
              version: artifactInput.version,
              target: input.executionTarget,
              sourceCommit: "c".repeat(40),
              toolchain: "bun@0.0.0",
              schemas: { preferences: [1], manifest: [1] },
              artifactSha256: digest,
              artifactBytes: artifactInput.bytes.length,
              ...artifactInput.identity,
            }),
        ),
      );
      return Object.freeze({
        sha256: digest,
        url: `/targets/artifacts/${digest}/${digest}.lazurio`,
      });
    },
    fault(path: string, fault: FixtureFault | undefined) {
      if (fault) faults.set(path, fault);
      else faults.delete(path);
    },
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
