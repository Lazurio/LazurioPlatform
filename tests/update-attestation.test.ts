import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CertificateClaims,
  createFixtureSigstore,
  type FixtureSigstore,
  releaseClaims,
} from "../scripts/update-fixture";
import {
  createAttestationVerifier,
  fixtureTrustedRoot,
  sigstoreTrustedRoot,
  workflowIdentityPattern,
} from "../src/update/attestation";
import { UpdateFailure } from "../src/update/errors";
import { productOrigin } from "../src/update/identity";

// The REAL sigstore-js verification runs here: certificate chain, SCT,
// transparency log entry, DSSE signature and policy. Only the trust root is a
// fixture (`@sigstore/mock`), so no test touches the network or a real key.
const version = "1.4.0";
const commit = "a".repeat(40);
const manifestSha = "1".repeat(64);
const artifactSha = "2".repeat(64);
const subjects = [
  { name: "manifest.json", sha256: manifestSha },
  { name: "lazurio-linux-x64", sha256: artifactSha },
];
let sigstore: FixtureSigstore;
let directory: string;
let rootFile: string;

beforeAll(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "attestation-")));
  sigstore = await createFixtureSigstore();
  rootFile = join(directory, "trusted_root.json");
  await writeFile(rootFile, sigstore.trustedRoot);
});
afterAll(async () => {
  await sigstore.close();
  await rm(directory, { recursive: true, force: true });
});

const verify = (
  bundle: Uint8Array,
  subjectSha256 = [manifestSha, artifactSha],
) =>
  createAttestationVerifier(
    productOrigin,
    fixtureTrustedRoot(rootFile),
  )({ bundle, version, sourceCommit: commit, subjectSha256 });
const refusal = async (run: Promise<void>) => {
  const error = await run.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UpdateFailure);
  return (error as UpdateFailure).failure;
};
const signed = (claims: Partial<CertificateClaims> = {}) =>
  sigstore.attest({ ...releaseClaims(version, commit), ...claims }, subjects);

test("the identity is an anchored, escaped pattern of the exact tag", () => {
  const pattern = workflowIdentityPattern(productOrigin, "1.4.0-rc.1");
  expect(pattern).toBe(
    "^https:\\/\\/github\\.com\\/Lazurio\\/LazurioPlatform\\/\\.github\\/workflows\\/release\\.yml@refs\\/tags\\/v1\\.4\\.0\\-rc\\.1$",
  );
  const matches = (identity: string) => new RegExp(pattern).test(identity);
  const exact =
    "https://github.com/Lazurio/LazurioPlatform/.github/workflows/release.yml@refs/tags/v1.4.0-rc.1";
  expect(matches(exact)).toBe(true);
  expect(matches(`${exact}0`)).toBe(false);
  expect(matches(`x${exact}`)).toBe(false);
  // An unescaped dot would accept these.
  expect(matches(exact.replace("v1.4.0", "v1x4.0"))).toBe(false);
  expect(matches(exact.replace("github.com", "githubxcom"))).toBe(false);
});

test("a bundle of the release workflow at the tag verifies", async () => {
  await verify(await signed());
});

test("every certificate claim is held against the compiled-in origin and the manifest", async () => {
  const release = releaseClaims(version, commit);
  for (const [name, claims] of Object.entries({
    issuer: { issuer: "https://accounts.example.com" },
    "another workflow": {
      identity: release.identity.replace("release.yml", "other.yml"),
    },
    "another tag": {
      identity: release.identity.replace("v1.4.0", "v1.4.1"),
    },
    "a branch": {
      identity: release.identity.replace("refs/tags/v1.4.0", "refs/heads/main"),
    },
    "a longer tag": { identity: `${release.identity}0` },
    "repository id": { repositoryId: "1" },
    "owner id": { ownerId: "1" },
    ref: { ref: "refs/tags/v1.3.0" },
    commit: { commit: "b".repeat(40) },
  } satisfies Record<string, Partial<CertificateClaims>>)) {
    const failure = await refusal(verify(await signed(claims)));
    expect([name, failure.code]).toEqual([name, "attestation-invalid"]);
    expect(failure.context.detail).toBe("UNTRUSTED_SIGNER_ERROR");
  }
});

test("both the manifest and the artifact must be attested subjects", async () => {
  const bundle = await signed();
  expect(
    (await refusal(verify(bundle, [manifestSha, "3".repeat(64)]))).context,
  ).toEqual({ reason: "subject" });
  expect(
    (await refusal(verify(bundle, ["3".repeat(64), artifactSha]))).context,
  ).toEqual({ reason: "subject" });
});

test("a changed statement, another Sigstore and garbage are refused", async () => {
  const bundle = JSON.parse(Buffer.from(await signed()).toString());
  const statement = JSON.parse(
    Buffer.from(bundle.dsseEnvelope.payload, "base64").toString(),
  );
  statement.subject.push({ name: "x", digest: { sha256: "3".repeat(64) } });
  bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString(
    "base64",
  );
  const tampered = new TextEncoder().encode(JSON.stringify(bundle));
  expect((await refusal(verify(tampered, ["3".repeat(64)]))).code).toBe(
    "attestation-invalid",
  );

  const foreign = await createFixtureSigstore();
  try {
    const failure = await refusal(
      verify(await foreign.attest(releaseClaims(version, commit), subjects)),
    );
    expect(failure.code).toBe("attestation-invalid");
  } finally {
    await foreign.close();
  }
  for (const garbage of ["", "{}", "not json"])
    expect(
      (await refusal(verify(new TextEncoder().encode(garbage)))).code,
    ).toBe("attestation-invalid");
});

test("a missing trust root is trust-unavailable, never a weaker verification", async () => {
  const failure = await refusal(
    createAttestationVerifier(
      productOrigin,
      fixtureTrustedRoot(join(directory, "absent.json")),
    )({
      bundle: await signed(),
      version,
      sourceCommit: commit,
      subjectSha256: [manifestSha],
    }),
  );
  expect(failure.code).toBe("trust-unavailable");
});

test("Sigstore's own client: a cold cache and an unreachable mirror block", async () => {
  // Sigstore's pinned root, as shipped by the client, against a closed port.
  const seeds = createRequire(import.meta.url)("@sigstore/tuf/seeds.json");
  const rootPath = join(directory, "sigstore-root.json");
  await writeFile(
    rootPath,
    Buffer.from(
      seeds["https://tuf-repo-cdn.sigstore.dev"]["root.json"],
      "base64",
    ),
  );
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const mirrorURL = `http://127.0.0.1:${closed.port}`;
  await closed.stop(true);
  const cache = join(directory, "cold-cache");
  const failure = await refusal(
    createAttestationVerifier(
      productOrigin,
      sigstoreTrustedRoot(cache, { mirrorURL, rootPath }),
    )({
      bundle: await signed(),
      version,
      sourceCommit: commit,
      subjectSha256: [manifestSha],
    }),
  );
  expect(failure.code).toBe("trust-unavailable");
  expect(await readFile(rootPath)).toBeDefined();
}, 60_000);
