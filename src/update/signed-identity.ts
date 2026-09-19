import { parseUniqueJson } from "../providers/unique-json";
import { UpdateFailure } from "./errors";
import { isProductVersion } from "./identity";

/** Folder state schema versions, by document (src/folder/state.ts). */
export type StateSchemas = Readonly<{
  preferences: readonly number[];
  manifest: readonly number[];
}>;

/** The contract between a staged version and the updater that activates it:
 * the self-check mode, the activation record and the worker arguments. A
 * release that needs a newer updater says so in its signed identity and is
 * refused by an older one instead of being activated half-understood.
 */
export const updaterContract = 1;

/** `artifacts/<sha256>/identity.json`: what the publisher signed about the
 * artifact (written by `scripts/artifact-identity.ts`). Members this version
 * does not know are ignored, so a newer publisher stays readable.
 */
export type SignedIdentity = Readonly<{
  version: string;
  target: string;
  sourceCommit: string;
  /** Schema versions this release can READ. */
  schemas: StateSchemas;
  artifactSha256: string;
  artifactBytes: number;
  minimumUpdaterContract: number;
}>;

export const maxIdentityBytes = 64 * 1024;

/** Signed target path of the identity that belongs to an artifact path. */
export function identityTargetPath(artifactPath: string): string {
  return `${artifactPath.slice(0, artifactPath.lastIndexOf("/"))}/identity.json`;
}

const schemaVersions = (input: unknown): readonly number[] | undefined =>
  Array.isArray(input) &&
  input.length > 0 &&
  input.every((version) => Number.isSafeInteger(version) && version >= 1)
    ? Object.freeze([...(input as number[])])
    : undefined;

/** Shape only. The bytes are authenticated by whoever obtained them: TUF for a
 * download, the immutable version directory for a staged version.
 */
export function parseSignedIdentity(bytes: Uint8Array): SignedIdentity {
  const invalid = (reason: string) =>
    new UpdateFailure("identity-invalid", { reason });
  let value: unknown;
  try {
    value = parseUniqueJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw invalid("malformed");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("malformed");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw invalid("unsupported-schema");
  const schemas = record.schemas as Record<string, unknown> | undefined;
  const preferences = schemaVersions(schemas?.preferences);
  const manifest = schemaVersions(schemas?.manifest);
  const contract = record.minimumUpdaterContract ?? 1;
  if (
    !isProductVersion(record.version) ||
    typeof record.target !== "string" ||
    typeof record.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(record.sourceCommit) ||
    typeof record.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.artifactSha256) ||
    typeof record.artifactBytes !== "number" ||
    !Number.isSafeInteger(record.artifactBytes) ||
    record.artifactBytes < 1 ||
    typeof contract !== "number" ||
    !Number.isSafeInteger(contract) ||
    contract < 1 ||
    !preferences ||
    !manifest
  )
    throw invalid("malformed");
  return Object.freeze({
    version: record.version,
    target: record.target,
    sourceCommit: record.sourceCommit,
    schemas: Object.freeze({ preferences, manifest }),
    artifactSha256: record.artifactSha256,
    artifactBytes: record.artifactBytes,
    minimumUpdaterContract: contract,
  });
}

export function canRead(
  schemas: StateSchemas,
  required: StateSchemas,
): boolean {
  return (
    required.preferences.every((version) =>
      schemas.preferences.includes(version),
    ) &&
    required.manifest.every((version) => schemas.manifest.includes(version))
  );
}

/** A candidate is acceptable only when its signed identity describes exactly
 * the signed artifact, this Machine's target and the channel's version, this
 * updater satisfies its contract, and it can read the Folder state in use.
 */
export function assertCandidateIdentity(
  identity: SignedIdentity,
  expected: Readonly<{
    target: string;
    version: string;
    artifactSha256: string;
    artifactBytes: number;
    requiredSchemas: StateSchemas;
  }>,
): void {
  const invalid = (reason: string) =>
    new UpdateFailure("identity-invalid", { reason });
  if (identity.target !== expected.target) throw invalid("target");
  if (identity.version !== expected.version) throw invalid("version");
  if (
    identity.artifactSha256 !== expected.artifactSha256 ||
    identity.artifactBytes !== expected.artifactBytes
  )
    throw invalid("artifact");
  if (identity.minimumUpdaterContract > updaterContract)
    throw invalid("updater-contract");
  if (!canRead(identity.schemas, expected.requiredSchemas))
    throw new UpdateFailure("schema-incompatible", {
      version: identity.version,
    });
}
