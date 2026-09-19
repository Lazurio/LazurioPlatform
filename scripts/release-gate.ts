import { isProductVersion, versionOfTag } from "../src/update/identity";
import { compareVersions } from "../src/update/version";

/** The ordering gate of the publishing job (docs/update.md "Publishing"): a
 * FINAL version must be greater than every published final release, because
 * GitHub's `latest` is a flag, not an order, and a client never goes below its
 * floor. Reads `gh release list --json tagName,isDraft,isPrerelease` on stdin.
 *
 *   gh release list --limit 1000 --json tagName,isDraft,isPrerelease | bun run scripts/release-gate.ts <X.Y.Z>
 */
export type ListedRelease = Readonly<{
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
}>;

export const isPrereleaseVersion = (version: string) => version.includes("-");

/** The published final release that forbids `version`, if any. A prerelease
 * is not ordered: it is invisible to `latest` and reached only by name.
 */
export function blockingRelease(
  version: string,
  releases: readonly ListedRelease[],
): string | undefined {
  if (!isProductVersion(version)) throw new Error("Invalid version");
  if (isPrereleaseVersion(version)) return undefined;
  return releases.find((release) => {
    const published = versionOfTag(release.tagName);
    return (
      !release.isDraft &&
      !release.isPrerelease &&
      published !== undefined &&
      !isPrereleaseVersion(published) &&
      compareVersions(version, published) <= 0
    );
  })?.tagName;
}

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  const releases = JSON.parse(await Bun.stdin.text()) as ListedRelease[];
  if (!Array.isArray(releases)) throw new Error("Release list expected");
  const blocking = blockingRelease(version, releases);
  if (blocking !== undefined) {
    console.error(
      `Refused: ${version} is not greater than the published final release ${blocking}.`,
    );
    process.exit(1);
  }
  console.log(`${version} may be published.`);
}
