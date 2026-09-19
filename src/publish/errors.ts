/** Refusals of the publisher. A code is stable for the workflows that read
 * it; `detail` names a path, role or version and never key material.
 */
export const publishErrorCodes = [
  /** A private or public key could not be read or is not Ed25519. */
  "key-invalid",
  /** The operation must sign a role whose key was not supplied. */
  "key-missing",
  /** The supplied key is not authorized for the role by the current root. */
  "key-unauthorized",
  /** The tree does not hold a verifiable repository. */
  "repository-invalid",
  /** An empty tree needs the initial root. */
  "root-missing",
  /** The offered root does not continue the published chain. */
  "root-chain",
  /** Bytes for an immutable path differ from the published ones. */
  "immutable-conflict",
  "invalid-input",
  /** The channel already offers this or a newer version. */
  "not-newer",
  /** The release drops a target the channel currently serves. */
  "target-dropped",
  /** Promotion asked for a version the source channel does not offer. */
  "version-mismatch",
  /** A role's remaining validity is below its margin. */
  "validity-low",
  /** A referenced object is missing, or has another length or digest. */
  "unreachable",
] as const;
export type PublishErrorCode = (typeof publishErrorCodes)[number];

export class PublishError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
