import { isProductVersion, versionOfTag } from "../src/update/identity";
import { compareVersions } from "../src/update/version";

/** The ordering gate of the publishing job (docs/update.md "Publishing"): a
 * FINAL version must be greater than EVERY published final release, because
 * GitHub's `latest` is a flag, not an order, and a client never goes below its
 * floor. "Every" means the whole history, so the input is the paginated
 * releases API — one JSON object per line — never a finite `release list`:
 *
 *   gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
 *     --jq '.[] | {tag_name, draft, prerelease}' | bun run scripts/release-gate.ts <X.Y.Z>
 *
 * It fails closed: input it cannot read, or a published final release whose
 * tag is not `v<version>`, refuses the publication instead of being skipped.
 */
export type ListedRelease = Readonly<{
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}>;

export const isPrereleaseVersion = (version: string) => version.includes("-");

/** One release per non-empty line. Anything else is not a release list. */
export function parseReleaseList(text: string): ListedRelease[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const value = JSON.parse(line) as Partial<ListedRelease> | null;
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.tag_name !== "string" ||
        typeof value.draft !== "boolean" ||
        typeof value.prerelease !== "boolean"
      )
        throw new Error("Not a release list");
      return Object.freeze({
        tag_name: value.tag_name,
        draft: value.draft,
        prerelease: value.prerelease,
      });
    });
}

/** The published final release that forbids `version`, if any. Drafts and
 * prereleases order nothing, and a prerelease candidate is not ordered: it is
 * invisible to `latest` and reached only by name.
 */
export function blockingRelease(
  version: string,
  releases: readonly ListedRelease[],
): string | undefined {
  if (!isProductVersion(version)) throw new Error("Invalid version");
  if (isPrereleaseVersion(version)) return undefined;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const published = versionOfTag(release.tag_name);
    // A published final release this gate cannot order might be the higher one.
    if (published === undefined)
      throw new Error(`Published final release with an unorderable tag`);
    if (compareVersions(version, published) <= 0) return release.tag_name;
  }
  return undefined;
}

if (import.meta.main) {
  const version = process.argv[2] ?? "";
  const blocking = blockingRelease(
    version,
    parseReleaseList(await Bun.stdin.text()),
  );
  if (blocking !== undefined) {
    console.error(
      `Refused: ${version} is not greater than the published final release ${blocking}.`,
    );
    process.exit(1);
  }
  console.log(`${version} may be published.`);
}
