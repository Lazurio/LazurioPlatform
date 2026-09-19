import { readFile } from "node:fs/promises";
import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import {
  toSignedEntity,
  toTrustMaterial,
  type VerificationPolicy,
  Verifier,
} from "@sigstore/verify";
import { UpdateFailure } from "./errors";
import { type ReleaseOrigin, tagOf } from "./identity";
import { maxBundleBytes } from "./manifest";

/** Verify (docs/update.md "Release and trust"): the Sigstore bundle of one
 * release, checked by the maintained sigstore-js verifier — the packages the
 * `sigstore` facade itself composes — against a trusted root. Nothing here is
 * our own cryptography: this module states the policy and reads the statement.
 */
export const githubActionsIssuer =
  "https://token.actions.githubusercontent.com";

/** Fulcio certificate extensions of a GitHub Actions identity. */
const oidSourceRepositoryDigest = "1.3.6.1.4.1.57264.1.13";
const oidSourceRepositoryRef = "1.3.6.1.4.1.57264.1.14";
const oidSourceRepositoryId = "1.3.6.1.4.1.57264.1.15";
const oidSourceRepositoryOwnerId = "1.3.6.1.4.1.57264.1.17";

const escapePattern = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** sigstore-js treats the policy identity as a REGULAR EXPRESSION, so the
 * exact identity is an anchored, fully escaped pattern. It names the workflow
 * at the tag, which binds the signed bytes to that tag.
 */
export function workflowIdentityPattern(
  origin: Pick<ReleaseOrigin, "repository">,
  version: string,
): string {
  return `^${escapePattern(
    `https://github.com/${origin.repository}/.github/workflows/release.yml@refs/tags/${tagOf(version)}`,
  )}$`;
}

/** These extensions are DER UTF8String values; the verifier compares bytes. */
function utf8String(value: string): Buffer {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength > 127) throw new Error("Extension value too long");
  return Buffer.concat([Buffer.from([0x0c, content.byteLength]), content]);
}

export function releasePolicy(
  origin: ReleaseOrigin,
  expected: Readonly<{ version: string; sourceCommit: string }>,
): VerificationPolicy {
  const oid = (id: string, value: string) => ({
    oid: { id: id.split(".").map(Number) },
    value: utf8String(value),
  });
  return {
    subjectAlternativeName: workflowIdentityPattern(origin, expected.version),
    extensions: { issuer: githubActionsIssuer },
    oids: [
      oid(oidSourceRepositoryId, origin.repositoryId),
      oid(oidSourceRepositoryOwnerId, origin.ownerId),
      oid(oidSourceRepositoryRef, `refs/tags/${tagOf(expected.version)}`),
      oid(oidSourceRepositoryDigest, expected.sourceCommit),
    ],
  };
}

export type TrustedRootSource = () => Promise<TrustedRoot>;

/** Sigstore's public trust root through Sigstore's own TUF client, cached
 * under the install base. A refresh that cannot reach Sigstore falls back to
 * metadata the same client verified earlier and that has not expired; a cold
 * cache therefore blocks the update and nothing ever weakens verification.
 */
export function sigstoreTrustedRoot(
  cachePath: string,
  // Tests only: an unreachable mirror proves the cold-cache refusal.
  mirror?: Readonly<{ mirrorURL: string; rootPath: string }>,
): TrustedRootSource {
  return async () => {
    const options = { cachePath, retry: 1, timeout: 10_000, ...mirror };
    try {
      return await getTrustedRoot(options);
    } catch {
      try {
        return await getTrustedRoot({ ...options, forceCache: true });
      } catch {
        throw new UpdateFailure("trust-unavailable");
      }
    }
  };
}

/** FIXTURE ONLY: a trusted root read from a file (tests and the qualification
 * build). A release build has no path that reaches this.
 */
export function fixtureTrustedRoot(path: string): TrustedRootSource {
  return async () => {
    try {
      return TrustedRoot.fromJSON(JSON.parse(await readFile(path, "utf8")));
    } catch {
      throw new UpdateFailure("trust-unavailable", { fixture: true });
    }
  };
}

export type AttestationRequest = Readonly<{
  bundle: Uint8Array;
  version: string;
  sourceCommit: string;
  /** Every digest that must be among the attested subjects. */
  subjectSha256: readonly string[];
}>;

/** Injectable so that the update use case is testable without a signer. */
export type AttestationVerifier = (
  request: AttestationRequest,
) => Promise<void>;

const invalid = (reason: string) =>
  new UpdateFailure("attestation-invalid", { reason });

export function createAttestationVerifier(
  origin: ReleaseOrigin,
  trustedRoot: TrustedRootSource,
): AttestationVerifier {
  return async (request) => {
    if (request.bundle.byteLength > maxBundleBytes) throw invalid("size");
    const root = await trustedRoot();
    let payload: Buffer;
    try {
      const bundle = bundleFromJSON(
        JSON.parse(Buffer.from(request.bundle).toString("utf8")),
      );
      if (bundle.content.$case !== "dsseEnvelope") throw invalid("envelope");
      new Verifier(toTrustMaterial(root)).verify(
        toSignedEntity(bundle),
        releasePolicy(origin, request),
      );
      if (
        bundle.content.dsseEnvelope.payloadType !==
        "application/vnd.in-toto+json"
      )
        throw invalid("payload-type");
      payload = bundle.content.dsseEnvelope.payload;
    } catch (error) {
      if (error instanceof UpdateFailure) throw error;
      // The library's message may quote certificate content; keep its code.
      const code = (error as { code?: unknown } | undefined)?.code;
      throw new UpdateFailure("attestation-invalid", {
        reason: "verification",
        ...(typeof code === "string" && /^[A-Z_]+$/.test(code)
          ? { detail: code }
          : {}),
      });
    }
    // Only now is the statement authentic: read what it is about.
    let subjects: unknown;
    try {
      subjects = (JSON.parse(payload.toString("utf8")) as { subject?: unknown })
        .subject;
    } catch {
      throw invalid("statement");
    }
    if (!Array.isArray(subjects)) throw invalid("statement");
    const attested = new Set(
      subjects.map(
        (subject: { digest?: { sha256?: unknown } } | null) =>
          subject?.digest?.sha256,
      ),
    );
    for (const digest of request.subjectSha256)
      if (!attested.has(digest)) throw invalid("subject");
  };
}
