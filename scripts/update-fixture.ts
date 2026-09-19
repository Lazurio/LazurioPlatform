import { channelDocumentBytes } from "../src/publish/channel-document";
import {
  generateSigner,
  type RoleName,
  type Signer,
} from "../src/publish/keys";
import {
  buildRoot,
  buildSnapshot,
  buildTargets,
  buildTimestamp,
  consistentTargetPath,
  metadataPath,
  sha256,
  type TargetEntry,
} from "../src/publish/metadata";

/** Local synthetic signed repository for the update core: consistent
 * snapshots, one ephemeral key PER role, numbered immutable roots, snapshots
 * and targets, hash-addressed channel documents, and old objects retained —
 * the layout docs/update.md "Publishing" prescribes. Keys never leave this
 * process and the bytes never leave the loopback server.
 *
 * Every signed byte is built by the publisher's own builders
 * (`src/publish/metadata.ts`, `channel-document.ts`), so the repository format
 * the client tests prove is the format the publisher writes. What stays here
 * is what a publisher must never do: expired or tampered metadata, malformed
 * documents, rewinding, and a misbehaving server.
 */
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
    root: generateSigner(),
    targets: generateSigner(),
    snapshot: generateSigner(),
    timestamp: generateSigner(),
  };
  const served = new Map<string, Buffer>();
  const blocked = new Map<string, number>();
  const requests: string[] = [];
  const channels = new Map<"stable" | "preview", FixtureChannel>();
  const timestamps = new Map<number, Buffer>();
  let rootVersion = 0;
  let version = 0;

  /** Publish root N+1. A rotation replaces the root key and is signed by both
   * the outgoing and the incoming key, as the client requires.
   */
  const publishRoot = (options: {
    rotate?: RoleName[];
    expires?: string;
  }): Buffer => {
    const outgoing = signers.root;
    for (const role of options.rotate ?? []) signers[role] = generateSigner();
    rootVersion += 1;
    const bytes = buildRoot({
      version: rootVersion,
      expires: options.expires ?? future(),
      keys: {
        root: [signers.root.key],
        targets: [signers.targets.key],
        snapshot: [signers.snapshot.key],
        timestamp: [signers.timestamp.key],
      },
      signers:
        outgoing === signers.root ? [outgoing] : [outgoing, signers.root],
    });
    served.set(`/${metadataPath("root", rootVersion)}`, bytes);
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
    const entries = new Map<string, TargetEntry>();
    const put = (path: string, bytes: Buffer) => {
      entries.set(path, { length: bytes.length, sha256: sha256(bytes) });
      served.set(`/${consistentTargetPath(path, sha256(bytes))}`, bytes);
    };
    for (const [path, bytes] of artifactTargets) put(path, bytes);
    for (const [name, channel] of channels) {
      const targets: Record<string, string> = channel.withoutTarget
        ? {}
        : {
            [input.executionTarget]: channel.artifactSha256
              ? `artifacts/${channel.artifactSha256}/lazurio`
              : artifactPath,
          };
      put(
        `channels/${name}.json`,
        channel.rawDocument !== undefined
          ? Buffer.from(channel.rawDocument)
          : channelDocumentBytes({
              channel: name,
              sequence: channel.sequence,
              version: channel.version,
              minimumVersion: channel.minimumVersion ?? "0.0.1",
              targets,
            }),
      );
    }
    const expires = (role: "targets" | "snapshot" | "timestamp") =>
      options.expires?.[role] ?? future();
    const targets = buildTargets({
      version,
      expires: expires("targets"),
      targets: entries,
      signer: signers.targets,
    });
    const snapshot = buildSnapshot({
      version,
      expires: expires("snapshot"),
      targetsVersion: version,
      targetsBytes: targets,
      ...(options.extraMeta ? { extraMeta: options.extraMeta } : {}),
      signer: signers.snapshot,
    });
    const referenced =
      options.timestampReferences === undefined
        ? snapshot
        : served.get(
            `/${metadataPath("snapshot", options.timestampReferences)}`,
          );
    if (!referenced) throw new Error("Unknown fixture generation");
    const timestamp = buildTimestamp({
      version,
      expires: expires("timestamp"),
      snapshotVersion: options.timestampReferences ?? version,
      snapshotBytes: referenced,
      signer: signers.timestamp,
    });
    // Same length, different bytes: the signed hash no longer matches.
    const damaged = (bytes: Buffer) => {
      const copy = Buffer.from(bytes);
      copy[copy.length - 2] = copy[copy.length - 2] === 0x20 ? 0x0a : 0x20;
      return copy;
    };
    served.set(
      `/${metadataPath("targets", version)}`,
      options.tamper === "targets" ? damaged(targets) : targets,
    );
    served.set(
      `/${metadataPath("snapshot", version)}`,
      options.tamper === "snapshot" ? damaged(snapshot) : snapshot,
    );
    served.set(`/${metadataPath("timestamp", version)}`, timestamp);
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
