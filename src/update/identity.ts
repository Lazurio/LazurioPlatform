/** The identity this executable was built with. This module is the ONLY reader
 * of the build-time defines; every other consumer receives the value.
 *
 * `bun build --define NAME='"value"'` replaces the bare identifier with a
 * literal, so the names below must appear literally in this source. A run from
 * source (tests, `bun run src/cli.ts`) has no defines: `typeof` of an
 * undeclared identifier is safe and selects the development fallback, which
 * sorts below every release so a development run never claims to be current.
 */
declare const LAZURIO_BUILD_VERSION: string | undefined;
declare const LAZURIO_BUILD_COMMIT: string | undefined;
declare const LAZURIO_BUILD_TARGET: string | undefined;
declare const LAZURIO_BUILD_FIXTURE: string | undefined;

/** Targets the update mechanism supports (docs/update.md "Deliberately
 * narrow"). `linux-arm64` exists because the local qualification VM is ARM64.
 */
export const updateTargets = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
] as const;
export type UpdateTarget = (typeof updateTargets)[number];

/** The release origin (docs/update.md "Release and trust"). The numeric IDs
 * survive a rename and defeat a resurrected repository name. A private fork is
 * a separately compiled product: it changes these constants, never a setting.
 */
export type ReleaseOrigin = Readonly<{
  repository: string;
  repositoryId: string;
  ownerId: string;
  /** Where release assets are requested. */
  baseUrl: string;
}>;

export const productOrigin: ReleaseOrigin = Object.freeze({
  repository: "Lazurio/LazurioPlatform",
  repositoryId: "1361711425",
  ownerId: "309688040",
  baseUrl: "https://github.com/Lazurio/LazurioPlatform",
});

/** FIXTURE ONLY. A qualification build (scripts/qualify-update-linux.ts) asks
 * a loopback origin and trusts a fixture Sigstore root from a file. A release
 * build never carries this define; `--version` names it and a self-check
 * refuses a fixture candidate for a product updater.
 */
export type FixtureBuild = Readonly<{ baseUrl: string; trustedRoot: string }>;

export type ProductIdentity = Readonly<{
  version: string;
  commit: string;
  target: string;
}>;

export const developmentVersion = "0.0.0-development";
export const developmentCommit = "0".repeat(40);

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isProductVersion(value: unknown): value is string {
  return typeof value === "string" && versionPattern.test(value);
}

/** A release tag is `v<version>` and nothing else. */
export const tagOf = (version: string) => `v${version}`;
export function versionOfTag(tag: unknown): string | undefined {
  return typeof tag === "string" &&
    tag.startsWith("v") &&
    isProductVersion(tag.slice(1))
    ? tag.slice(1)
    : undefined;
}

/** Build tooling uses this to pass the defines; the keys are the literal
 * identifiers read above, so the writer and the reader cannot drift apart.
 */
export function identityDefines(
  identity: ProductIdentity,
  fixture?: FixtureBuild,
): string[] {
  const checked = parseIdentity(identity);
  return [
    ["LAZURIO_BUILD_VERSION", checked.version],
    ["LAZURIO_BUILD_COMMIT", checked.commit],
    ["LAZURIO_BUILD_TARGET", checked.target],
    ...(fixture ? [["LAZURIO_BUILD_FIXTURE", JSON.stringify(fixture)]] : []),
  ].flatMap(([name, value]) => [
    "--define",
    `${name}=${JSON.stringify(value)}`,
  ]);
}

export function parseIdentity(input: {
  version: unknown;
  commit: unknown;
  target: unknown;
}): ProductIdentity {
  if (!isProductVersion(input.version))
    throw new Error("Invalid embedded product version");
  if (typeof input.commit !== "string" || !/^[0-9a-f]{40}$/.test(input.commit))
    throw new Error("Invalid embedded source commit");
  // The target is a build fact, not a support claim: an identity may name a
  // target the update mechanism refuses (`target-unsupported`).
  if (
    typeof input.target !== "string" ||
    !/^[a-z0-9]+-[a-z0-9]+$/.test(input.target)
  )
    throw new Error("Invalid embedded execution target");
  return Object.freeze({
    version: input.version,
    commit: input.commit,
    target: input.target,
  });
}

export function nativeTarget(platform: string, arch: string): string {
  return `${platform === "win32" ? "windows" : platform}-${arch}`;
}

/** Either all three defines are present (a built product) or none (a source
 * run). A partial set is a broken build and is refused rather than guessed.
 */
export function embeddedIdentity(): ProductIdentity {
  const version =
    typeof LAZURIO_BUILD_VERSION === "string"
      ? LAZURIO_BUILD_VERSION
      : undefined;
  const commit =
    typeof LAZURIO_BUILD_COMMIT === "string" ? LAZURIO_BUILD_COMMIT : undefined;
  const target =
    typeof LAZURIO_BUILD_TARGET === "string" ? LAZURIO_BUILD_TARGET : undefined;
  if (version === undefined && commit === undefined && target === undefined)
    return parseIdentity({
      version: developmentVersion,
      commit: developmentCommit,
      target: nativeTarget(process.platform, process.arch),
    });
  return parseIdentity({ version, commit, target });
}

export function embeddedFixture(): FixtureBuild | undefined {
  if (typeof LAZURIO_BUILD_FIXTURE !== "string") return undefined;
  const value = JSON.parse(LAZURIO_BUILD_FIXTURE) as Partial<FixtureBuild>;
  if (
    typeof value.baseUrl !== "string" ||
    typeof value.trustedRoot !== "string"
  )
    throw new Error("Invalid embedded fixture");
  return Object.freeze({
    baseUrl: value.baseUrl,
    trustedRoot: value.trustedRoot,
  });
}
