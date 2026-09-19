import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fulcioHandler,
  initializeCA,
  initializeCTLog,
  initializeTLog,
  rekorHandler,
} from "@sigstore/mock";
import { attest } from "sigstore";
import { githubActionsIssuer } from "../src/update/attestation";
import { productOrigin, tagOf } from "../src/update/identity";
import {
  bundleFile,
  manifestFile,
  renderManifest,
  sha256Hex,
} from "../src/update/manifest";

/** FIXTURE ONLY. A throwaway Sigstore — mock Fulcio, CT log and Rekor from
 * sigstore-js's own `@sigstore/mock` — that signs release bundles the REAL
 * verifier accepts against the fixture trusted root it hands out. Keys live in
 * memory for one process; nothing here can sign for the public trust root.
 */
type MockHandler = Readonly<{
  path: string;
  fn: (body: string) => Promise<{
    statusCode: number;
    response: string;
    contentType?: string;
  }>;
}>;

export type CertificateClaims = Readonly<{
  issuer: string;
  /** The certificate's subject alternative name. */
  identity: string;
  repositoryId: string;
  ownerId: string;
  ref: string;
  commit: string;
}>;

export type FixtureSigstore = Readonly<{
  /** JSON of the trusted root that verifies this instance's bundles. */
  trustedRoot: string;
  attest(
    claims: CertificateClaims,
    subjects: readonly Readonly<{ name: string; sha256: string }>[],
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}>;

const keyPair = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const base64url = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export async function createFixtureSigstore(): Promise<FixtureSigstore> {
  const ctlog = await initializeCTLog(keyPair());
  const ca = await initializeCA(keyPair(), ctlog);
  const handlers: MockHandler[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const handler = handlers.find(
        (candidate) => candidate.path === new URL(request.url).pathname,
      );
      if (!handler) return new Response("not found", { status: 404 });
      const result = await handler.fn(await request.text());
      return new Response(result.response, {
        status: result.statusCode,
        headers: { "content-type": result.contentType ?? "text/plain" },
      });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const tlog = await initializeTLog(url, keyPair());
  // The mock log echoes the proposal; Rekor stores the canonical DSSE entry,
  // and that is what the verifier compares the envelope with.
  const canonicalLog = {
    publicKey: tlog.publicKey,
    logV2: tlog.logV2.bind(tlog),
    log(proposed: {
      apiVersion: string;
      kind: string;
      spec: { proposedContent: { envelope: string; verifiers: string[] } };
    }) {
      const { envelope, verifiers } = proposed.spec.proposedContent;
      const parsed = JSON.parse(envelope) as {
        payload: string;
        signatures: { sig: string }[];
      };
      const sha256 = (value: string | Buffer) => ({
        algorithm: "sha256",
        value: createHash("sha256").update(value).digest("hex"),
      });
      return tlog.log({
        apiVersion: proposed.apiVersion,
        kind: proposed.kind,
        spec: {
          envelopeHash: sha256(envelope),
          payloadHash: sha256(Buffer.from(parsed.payload, "base64")),
          signatures: parsed.signatures.map((signature) => ({
            signature: signature.sig,
            verifier: verifiers[0],
          })),
        },
      });
    },
  };
  handlers.push(
    fulcioHandler(ca, { subjectClaim: "fixture_identity" }) as MockHandler,
    rekorHandler(canonicalLog as never) as MockHandler,
  );
  const validFor = { start: new Date(Date.now() - 3_600_000).toISOString() };
  const logKey = (publicKey: Buffer) => ({
    rawBytes: publicKey.toString("base64"),
    keyDetails: "PKIX_ECDSA_P256_SHA_256",
    validFor,
  });
  const trustedRoot = JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [
      {
        baseUrl: url,
        hashAlgorithm: "SHA2_256",
        publicKey: logKey(tlog.publicKey),
        logId: {
          keyId: createHash("sha256").update(tlog.publicKey).digest("base64"),
        },
      },
    ],
    certificateAuthorities: [
      {
        subject: { organization: "sigstore.mock", commonName: "sigstore" },
        uri: url,
        certChain: {
          certificates: [
            {
              rawBytes: Buffer.from(
                ca.rootCertificate.buffer,
                ca.rootCertificate.byteOffset,
                ca.rootCertificate.byteLength,
              ).toString("base64"),
            },
          ],
        },
        validFor,
      },
    ],
    ctlogs: [
      {
        baseUrl: url,
        hashAlgorithm: "SHA2_256",
        publicKey: logKey(ctlog.publicKey),
        logId: {
          keyId: Buffer.from(
            ctlog.logID.buffer,
            ctlog.logID.byteOffset,
            ctlog.logID.byteLength,
          ).toString("base64"),
        },
      },
    ],
    timestampAuthorities: [],
  });
  return Object.freeze({
    trustedRoot,
    async attest(claims, subjects) {
      // The mock Fulcio turns these OIDC claims into the same certificate
      // extensions GitHub's token produces on the public instance.
      const token = `${base64url({ alg: "none" })}.${base64url({
        iss: claims.issuer,
        sub: "fixture",
        aud: "sigstore",
        fixture_identity: claims.identity,
        repository_id: claims.repositoryId,
        repository_owner_id: claims.ownerId,
        ref: claims.ref,
        sha: claims.commit,
      })}.`;
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: subjects.map((subject) => ({
          name: subject.name,
          digest: { sha256: subject.sha256 },
        })),
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {},
      };
      const bundle = await attest(
        Buffer.from(JSON.stringify(statement)),
        "application/vnd.in-toto+json",
        { fulcioURL: url, rekorURL: url, identityToken: token, retry: 0 },
      );
      return new TextEncoder().encode(JSON.stringify(bundle));
    },
    async close() {
      await server.stop(true);
    },
  });
}

/** What the release workflow would state about `version` of the product. */
export function releaseClaims(
  version: string,
  commit: string,
): CertificateClaims {
  return Object.freeze({
    issuer: githubActionsIssuer,
    identity: `https://github.com/${productOrigin.repository}/.github/workflows/release.yml@refs/tags/${tagOf(version)}`,
    repositoryId: productOrigin.repositoryId,
    ownerId: productOrigin.ownerId,
    ref: `refs/tags/${tagOf(version)}`,
    commit,
  });
}

export type FixtureRelease = Readonly<{
  version: string;
  commit: string;
  minimumUpdaterVersion?: string;
  artifacts: Readonly<Record<string, Uint8Array>>;
  /** Certificate claims other than the release workflow's own. */
  claims?: Partial<CertificateClaims>;
}>;

/** Write one release into a fixture origin tree (`<tree>/<tag>/<asset>`), the
 * layout `scripts/update-fixture-server.ts` serves. `latest` is a text file.
 */
export async function writeFixtureRelease(
  tree: string,
  sigstore: FixtureSigstore,
  release: FixtureRelease,
  options: Readonly<{ latest?: boolean }> = {},
): Promise<void> {
  const directory = join(tree, tagOf(release.version));
  await mkdir(directory, { recursive: true });
  const manifest = renderManifest({
    version: release.version,
    sourceCommit: release.commit,
    minimumUpdaterVersion: release.minimumUpdaterVersion ?? "0.0.1",
    repository: productOrigin.repository,
    targets: Object.fromEntries(
      Object.entries(release.artifacts).map(([target, bytes]) => [
        target,
        { sha256: sha256Hex(bytes), size: bytes.byteLength },
      ]),
    ),
  });
  await writeFile(join(directory, manifestFile), manifest);
  for (const [target, bytes] of Object.entries(release.artifacts))
    await writeFile(join(directory, `lazurio-${target}`), bytes);
  await writeFile(
    join(directory, bundleFile),
    await sigstore.attest(
      { ...releaseClaims(release.version, release.commit), ...release.claims },
      [
        { name: manifestFile, sha256: sha256Hex(manifest) },
        ...Object.entries(release.artifacts).map(([target, bytes]) => ({
          name: `lazurio-${target}`,
          sha256: sha256Hex(bytes),
        })),
      ],
    ),
  );
  if (options.latest ?? true)
    await writeFile(join(tree, "latest"), tagOf(release.version));
}
