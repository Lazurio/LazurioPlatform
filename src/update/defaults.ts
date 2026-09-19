import type { UpdateChannel } from "./channel";
import { verifiedRoot } from "./trust";

/** What an installed Lazurio knows without being told (docs/update.md
 * "Identity in the binary"): where the signed repository is, which origins a
 * download may touch, the default channel and the trust root. Every value is
 * configuration with a default — a fork or a fixture passes its own through
 * the explicit options of `lazurio update`.
 */
export const defaultMetadataBaseUrl =
  "https://lazurio.github.io/LazurioPlatform/metadata/";
export const defaultTargetBaseUrl =
  "https://lazurio.github.io/LazurioPlatform/targets/";
export const defaultChannel: UpdateChannel = "stable";

/** Origins an executable download may touch besides the repository's own.
 *
 * A release's executables are GitHub Release assets; the SIGNED location is
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`, which
 * GitHub answers with `302` to a short-lived signed URL on its asset storage.
 * GitHub documents that storage only as `*.githubusercontent.com`
 * (`GET https://api.github.com/meta`, `domains.website`); the transport
 * matches exact origins, never a wildcard, so the hosts are named:
 *
 *  - `release-assets.githubusercontent.com` — where release downloads redirect
 *    today (observed 2026-09-19 for a public repository);
 *  - `objects.githubusercontent.com` — the host used before it, which GitHub's
 *    own firewall guidance still lists for release downloads.
 *
 * Any other redirect is refused by the transport (proven in
 * `tests/update-publish-journey.test.ts`). The release workflow downloads
 * every new asset through this same list before it publishes metadata, so a
 * host GitHub introduces later stops a release, not installed Machines.
 */
export const defaultArtifactOrigins: readonly string[] = Object.freeze([
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
]);

/** `bun build --define` replaces this identifier with the text of
 * `release/root.json` (see `identity.ts` for the mechanism). A run from
 * source, and a build made before the key ceremony (docs/release-keys.md),
 * has none: the product then holds NO trust root and `lazurio update` answers
 * `trust-missing` unless the caller supplies `--bootstrap-root`.
 */
declare const LAZURIO_BUILD_TRUST_ROOT: string | undefined;

export function embeddedTrustRoot(): Uint8Array | undefined {
  return typeof LAZURIO_BUILD_TRUST_ROOT === "string"
    ? new TextEncoder().encode(LAZURIO_BUILD_TRUST_ROOT)
    : undefined;
}

/** Build tooling passes the root through this function, so the writer and the
 * reader of the define cannot drift apart. A root that does not verify under
 * its own keys is a broken release input and is refused, never embedded.
 */
export function trustRootDefines(rootText: string | undefined): string[] {
  if (rootText === undefined) return [];
  if (verifiedRoot(rootText) === undefined)
    throw new Error("release/root.json is not a self-signed TUF root");
  return ["--define", `LAZURIO_BUILD_TRUST_ROOT=${JSON.stringify(rootText)}`];
}
