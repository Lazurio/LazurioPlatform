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

/** Targets the update mechanism supports (docs/update.md "Deliberately
 * narrow"). `linux-arm64` exists because the local qualification VM is ARM64.
 */
export const updateTargets = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
] as const;
export type UpdateTarget = (typeof updateTargets)[number];

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

/** Build tooling uses this to pass the defines; the keys are the literal
 * identifiers read above, so the writer and the reader cannot drift apart.
 */
export function identityDefines(identity: ProductIdentity): string[] {
  const checked = parseIdentity(identity);
  return [
    ["LAZURIO_BUILD_VERSION", checked.version],
    ["LAZURIO_BUILD_COMMIT", checked.commit],
    ["LAZURIO_BUILD_TARGET", checked.target],
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
