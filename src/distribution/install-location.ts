import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedJson } from "../providers/owned-json";
import { exactFields } from "./trust-checkpoint";

/** Per-user product location outside any Lazurio Folder: the installation
 * owner root, immutable versioned product directories and, later, the stable
 * entrypoint. Resolution is pure; nothing here inspects or creates paths.
 */
export type InstallLocation = Readonly<{
  base: string;
  owner: string;
  versions: string;
}>;

const record = "location.json";
const ownerEntries = new Set([
  ".operation-lock",
  "attempts",
  "history",
  "trust",
]);
export const stagedVersionName =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\+[0-9a-f]{16}$/;
const stagingName = /^\.staging-[0-9a-f]{16}$/;

export function resolveInstallLocation(input: {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}): InstallLocation {
  if (!isAbsolute(input.homedir)) throw new Error("Absolute home required");
  let base: string;
  if (input.platform === "darwin")
    base = join(input.homedir, "Library", "Application Support", "Lazurio");
  else if (input.platform === "linux") {
    // XDG: a relative XDG_DATA_HOME is invalid and must be ignored.
    const xdg = input.env.XDG_DATA_HOME;
    base =
      xdg && isAbsolute(xdg)
        ? join(xdg, "lazurio")
        : join(input.homedir, ".local", "share", "lazurio");
  } else throw new Error("Unqualified install platform");
  return Object.freeze({
    base,
    owner: join(base, "distribution"),
    versions: join(base, "versions"),
  });
}

/** The three paths are one custody tuple derived from `base`; any other
 * combination is refused before inspection or writes, so owner state and
 * versions can never be paired across two locations. Each component is read
 * exactly once into a new frozen snapshot; every later step uses that
 * snapshot, never the caller's possibly mutable object.
 */
export function boundInstallLocation(
  location: InstallLocation,
): InstallLocation {
  const base = location.base;
  const owner = location.owner;
  const versions = location.versions;
  if (
    typeof base !== "string" ||
    !isAbsolute(base) ||
    resolve(base) !== base ||
    owner !== join(base, "distribution") ||
    versions !== join(base, "versions")
  )
    throw new Error("Unbound install location tuple");
  return Object.freeze({ base, owner, versions });
}

/** Read-only proof that this location was initialized by this product: the
 * exclusive `location.json` record exists and every directory holds only
 * entries this product creates. Anything else fails closed and is never
 * adopted, repaired or removed. Custody checks do not replace this record.
 */
export async function verifyInstallLocation(
  input: InstallLocation,
): Promise<InstallLocation> {
  const location = boundInstallLocation(input);
  await inspectOwnedDirectory(location.base);
  const fields = exactFields(await readOwnedJson(join(location.base, record)), [
    "kind",
    "schemaVersion",
  ]);
  if (fields.schemaVersion !== 1 || fields.kind !== "lazurio-install-location")
    throw new Error("Unrecognized install location record");
  const entries = (await readdir(location.base)).sort();
  if (entries.join(",") !== `distribution,${record},versions`)
    throw new Error("Unknown content in install location");
  await inspectOwnedDirectory(location.owner);
  for (const entry of await readdir(location.owner))
    if (!ownerEntries.has(entry))
      throw new Error("Unknown content in installation owner directory");
  await inspectOwnedDirectory(location.versions);
  for (const entry of await readdir(location.versions)) {
    const path = join(location.versions, entry);
    if (stagingName.test(entry)) {
      // A leftover from an interrupted staging is retained, never used.
      if (!(await lstat(path)).isDirectory())
        throw new Error("Unknown content in product versions directory");
    } else if (stagedVersionName.test(entry))
      await verifyStagedVersionDirectory(path, entry);
    else throw new Error("Unknown content in product versions directory");
  }
  return location;
}

/** A published version directory must prove it was staged by this product: a
 * canonical owned directory holding exactly the read-only artifact,
 * identity.json and provenance.json, whose provenance and identity agree with
 * each other and with the directory name. A name alone proves nothing; a
 * regular file, link or foreign directory with a valid name is refused. This
 * does not re-hash the artifact bytes; staging and activation re-verify them.
 */
export async function verifyStagedVersionDirectory(
  directory: string,
  name: string,
) {
  if (!stagedVersionName.test(name))
    throw new Error("Invalid staged version name");
  await inspectOwnedDirectory(directory);
  const entries = (await readdir(directory)).sort();
  const artifactName = entries.includes("lazurio.exe")
    ? "lazurio.exe"
    : "lazurio";
  if (entries.join(",") !== `identity.json,${artifactName},provenance.json`)
    throw new Error("Unrecognized staged version layout");
  for (const [entry, mode] of [
    [artifactName, 0o500],
    ["identity.json", 0o400],
    ["provenance.json", 0o400],
  ] as const) {
    const stat = await lstat(join(directory, entry));
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== mode
    )
      throw new Error(
        "Staged version entry is not this product's immutable file",
      );
  }
  const provenance = exactFields(
    await readOwnedJson(join(directory, "provenance.json")),
    ["artifactSha256", "attempt", "channel", "schemaVersion"],
  );
  const channel = exactFields(provenance.channel, [
    "documentSha256",
    "sequence",
  ]);
  const [version, digestPrefix] = name.split("+");
  if (
    provenance.schemaVersion !== 1 ||
    typeof provenance.attempt !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provenance.attempt) ||
    typeof provenance.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(provenance.artifactSha256) ||
    !provenance.artifactSha256.startsWith(digestPrefix as string) ||
    !Number.isSafeInteger(channel.sequence) ||
    (channel.sequence as number) < 1 ||
    typeof channel.documentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(channel.documentSha256)
  )
    throw new Error("Staged version provenance is inconsistent");
  const envelope = (await readOwnedJson(
    join(directory, "identity.json"),
  )) as Record<string, unknown> | null;
  const identity = envelope?.identity as Record<string, unknown> | undefined;
  if (
    !identity ||
    typeof identity !== "object" ||
    identity.schemaVersion !== 1 ||
    identity.version !== version ||
    identity.artifactSha256 !== provenance.artifactSha256 ||
    (identity.target as string | undefined)?.startsWith("windows-") !==
      (artifactName === "lazurio.exe")
  )
    throw new Error("Staged version identity does not match its provenance");
}

/** Creates the location once as a complete private layout published by one
 * rename, or verifies an existing initialized one. A pre-existing base without
 * this product's record is refused, not adopted; a leftover
 * `.lazurio-location-*` directory from an interruption is retained.
 */
export async function prepareInstallLocation(
  input: InstallLocation,
): Promise<InstallLocation> {
  const location = boundInstallLocation(input);
  if (await exists(location.base)) return verifyInstallLocation(location);
  const parent = dirname(location.base);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await inspectOwnedDirectory(parent);
  const staging = join(
    parent,
    `.lazurio-location-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(staging, { mode: 0o700 });
  await mkdir(join(staging, "distribution"), { mode: 0o700 });
  await mkdir(join(staging, "versions"), { mode: 0o700 });
  const file = await open(join(staging, record), "wx", 0o400);
  try {
    await file.writeFile(
      JSON.stringify({ schemaVersion: 1, kind: "lazurio-install-location" }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
  await syncPath(staging);
  if (await exists(location.base))
    throw new Error("Install location appeared during preparation");
  await rename(staging, location.base);
  await syncPath(parent);
  return verifyInstallLocation(location);
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncPath(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
