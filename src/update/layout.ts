import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type DurableWriter,
  removeAbandonedTemporaries,
  syncDirectory,
  writeDurableFile,
} from "./durable-file";
import { UpdateFailure } from "./errors";
import { isProductVersion } from "./identity";
import { compareVersions } from "./version";

/** Owned names inside the install base (docs/update.md "State on disk").
 * Unknown entries are tolerated and never inspected.
 */
export const executableName = "lazurio";

export const layout = (base: string) =>
  Object.freeze({
    bin: join(base, "bin"),
    selector: join(base, "bin", executableName),
    versions: join(base, "versions"),
    update: join(base, "update"),
    lock: join(base, "update", "lock"),
    highWater: join(base, "update", "high-water"),
    lastCheck: join(base, "update", "last-check.json"),
    scratch: join(base, "update", "scratch"),
    /** Where the supervised Launchpad answers its health question. */
    healthSocket: join(base, "update", "launchpad.sock"),
    sigstore: join(base, "sigstore"),
  });

export const versionDirectory = (base: string, version: string) =>
  join(layout(base).versions, version);
export const versionExecutable = (base: string, version: string) =>
  join(layout(base).versions, version, executableName);

/** Create the owned directories with owner-only modes, whatever the umask. */
export async function ensureLayout(base: string): Promise<void> {
  const paths = layout(base);
  for (const directory of [base, paths.bin, paths.versions, paths.update]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

/** A link is read only by its literal target; any other shape selects nothing
 * this product owns.
 */
async function readVersionLink(
  path: string,
  shape: RegExp,
): Promise<string | null> {
  let target: string;
  try {
    target = await readlink(path);
  } catch {
    return null;
  }
  const match = shape.exec(target);
  return match && isProductVersion(match[1]) ? (match[1] as string) : null;
}

/** `bin/lazurio` is the only selector of the active version. */
export const readSelector = (base: string) =>
  readVersionLink(layout(base).selector, /^\.\.\/versions\/([^/]+)\/lazurio$/);

/** Replace a symlink by one atomic rename and make the directory durable: a
 * reader — or a Machine that loses power — sees the old or the new target,
 * never none. Callers hold the update lock, so a temporary link found here is
 * a killed writer's. A running executable is never touched.
 */
async function replaceLink(directory: string, name: string, target: string) {
  await removeAbandonedTemporaries(directory);
  const temporary = join(
    directory,
    `.${name}.tmp-${randomBytes(8).toString("hex")}`,
  );
  await symlink(target, temporary);
  try {
    await rename(temporary, join(directory, name));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

export async function swapSelector(base: string, version: string) {
  if (!isProductVersion(version)) throw new Error("Invalid version");
  await replaceLink(
    layout(base).bin,
    executableName,
    `../versions/${version}/${executableName}`,
  );
}

/** Remove a version directory whose files are read-only. */
export async function removeVersion(base: string, version: string) {
  const directory = versionDirectory(base, version);
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

/** After an activation only the active version is kept: there is no way back
 * to keep another for (docs/update.md "Activation"). Entries that are not
 * versions are someone else's and stay.
 */
export async function pruneVersions(base: string): Promise<void> {
  const active = await readSelector(base);
  // Without a readable selector nothing is known to be safe to delete.
  if (active === null) return;
  for (const entry of await readdir(layout(base).versions).catch(() => []))
    if (isProductVersion(entry) && entry !== active)
      await removeVersion(base, entry).catch(() => undefined);
}

const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** The update state a `state-invalid` failure can name, relative to the base. */
export const updateStatePaths = [
  "update/high-water",
  "update/pending.json",
] as const;
const stateInvalid = (path: (typeof updateStatePaths)[number]) =>
  new UpdateFailure("state-invalid", { path });

/** `update/high-water`: the highest version that was ever activated. It only
 * rises. A missing mark means the floor is the active
 * version; one that exists and cannot be understood is NOT "no floor" — that
 * would permit the downgrade the mark exists to refuse — it is `state-invalid`.
 */
export async function readHighWater(base: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(layout(base).highWater, "utf8");
  } catch (error) {
    if (absent(error)) return null;
    throw stateInvalid("update/high-water");
  }
  const version = text.trim();
  if (!isProductVersion(version)) throw stateInvalid("update/high-water");
  return version;
}

export async function raiseHighWater(
  base: string,
  version: string,
  write: DurableWriter = writeDurableFile,
): Promise<void> {
  const current = await readHighWater(base);
  if (current !== null && compareVersions(version, current) <= 0) return;
  await write(layout(base).update, "high-water", Buffer.from(`${version}\n`));
}

/** No network path installs below this: the higher of the active version and
 * the high-water mark (docs/update.md "Invariants").
 */
export async function versionFloor(base: string): Promise<string | null> {
  const active = await readSelector(base);
  const highWater = await readHighWater(base);
  if (active === null || highWater === null) return active ?? highWater;
  return compareVersions(active, highWater) >= 0 ? active : highWater;
}
