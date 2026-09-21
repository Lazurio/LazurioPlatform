import { createHash } from "node:crypto";
import { UpdateFailure } from "./errors";
import { isProductVersion, tagOf } from "./identity";

/** `manifest.json` of one release (docs/update.md "Release and trust"). The
 * bytes are authenticated by the attestation; this module only decides whether
 * they describe a release at all. Unknown members are tolerated so a later
 * release may add one without stranding an installed client.
 */
export const manifestFile = "manifest.json";
export const bundleFile = "lazurio.sigstore.json";
export const maxManifestBytes = 64 * 1024;
export const maxBundleBytes = 1024 * 1024;
export const maxArtifactBytes = 1024 * 1024 * 1024;

export type ManifestTarget = Readonly<{
  file: string;
  sha256: string;
  size: number;
}>;

export type ReleaseManifest = Readonly<{
  schema: 1;
  version: string;
  sourceCommit: string;
  /** Oldest installed version able to perform this update. */
  minimumUpdaterVersion: string;
  notesUrl: string;
  targets: Readonly<Record<string, ManifestTarget>>;
}>;

export const artifactFile = (target: string) => `lazurio-${target}`;

const invalid = (reason: string) =>
  new UpdateFailure("release-invalid", { resource: "manifest", reason });

function parseTarget(name: string, value: unknown): ManifestTarget {
  const entry = value as Partial<ManifestTarget> | null;
  if (
    !/^[a-z0-9]+-[a-z0-9]+$/.test(name) ||
    typeof entry !== "object" ||
    entry === null ||
    // The asset name is derived, never followed: no path can hide in it.
    entry.file !== artifactFile(name) ||
    typeof entry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.sha256) ||
    !Number.isSafeInteger(entry.size) ||
    (entry.size as number) <= 0 ||
    (entry.size as number) > maxArtifactBytes
  )
    throw invalid("target");
  return Object.freeze({
    file: entry.file,
    sha256: entry.sha256,
    size: entry.size as number,
  });
}

export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  if (bytes.byteLength > maxManifestBytes) throw invalid("size");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("json");
  if (value.schema !== 1) throw invalid("schema");
  if (!isProductVersion(value.version)) throw invalid("version");
  if (
    typeof value.source_commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.source_commit)
  )
    throw invalid("source-commit");
  if (!isProductVersion(value.minimum_updater_version))
    throw invalid("minimum-updater-version");
  if (
    typeof value.notes_url !== "string" ||
    !URL.canParse(value.notes_url) ||
    new URL(value.notes_url).protocol !== "https:"
  )
    throw invalid("notes-url");
  const targets = value.targets;
  if (typeof targets !== "object" || targets === null || Array.isArray(targets))
    throw invalid("targets");
  return Object.freeze({
    schema: 1,
    version: value.version,
    sourceCommit: value.source_commit,
    minimumUpdaterVersion: value.minimum_updater_version,
    notesUrl: value.notes_url,
    targets: Object.freeze(
      Object.fromEntries(
        Object.entries(targets).map(([name, entry]) => [
          name,
          parseTarget(name, entry),
        ]),
      ),
    ),
  });
}

/** The writer used by `scripts/release-manifest.ts`; reading its own output
 * back through the parser keeps the two sides one fact.
 */
export function renderManifest(input: {
  version: string;
  sourceCommit: string;
  minimumUpdaterVersion: string;
  repository: string;
  targets: Readonly<Record<string, Readonly<{ sha256: string; size: number }>>>;
}): Uint8Array {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(
      {
        schema: 1,
        version: input.version,
        source_commit: input.sourceCommit,
        minimum_updater_version: input.minimumUpdaterVersion,
        notes_url: `https://github.com/${input.repository}/releases/tag/${tagOf(input.version)}`,
        targets: Object.fromEntries(
          Object.entries(input.targets)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, entry]) => [
              name,
              {
                file: artifactFile(name),
                sha256: entry.sha256,
                size: entry.size,
              },
            ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  parseManifest(bytes);
  return bytes;
}

export const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
