import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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

/** Read-only proof that this location was initialized by this product: the
 * exclusive `location.json` record exists and every directory holds only
 * entries this product creates. Anything else fails closed and is never
 * adopted, repaired or removed. Custody checks do not replace this record.
 */
export async function verifyInstallLocation(
  location: InstallLocation,
): Promise<InstallLocation> {
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
  for (const entry of await readdir(location.versions))
    if (!stagedVersionName.test(entry) && !stagingName.test(entry))
      throw new Error("Unknown content in product versions directory");
  return location;
}

/** Creates the location once as a complete private layout published by one
 * rename, or verifies an existing initialized one. A pre-existing base without
 * this product's record is refused, not adopted; a leftover
 * `.lazurio-location-*` directory from an interruption is retained.
 */
export async function prepareInstallLocation(
  location: InstallLocation,
): Promise<InstallLocation> {
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
