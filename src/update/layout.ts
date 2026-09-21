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
    previous: join(base, "previous"),
    versions: join(base, "versions"),
    update: join(base, "update"),
    lock: join(base, "update", "lock"),
    highWater: join(base, "update", "high-water"),
    pending: join(base, "update", "pending.json"),
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
/** `previous` is the rollback target. */
export const readPrevious = (base: string) =>
  readVersionLink(layout(base).previous, /^versions\/([^/]+)$/);

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

export async function setPrevious(base: string, version: string) {
  if (!isProductVersion(version)) throw new Error("Invalid version");
  await replaceLink(base, "previous", `versions/${version}`);
}

/** Remove a version directory whose files are read-only. */
export async function removeVersion(base: string, version: string) {
  const directory = versionDirectory(base, version);
  await chmod(directory, 0o700).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

/** After a committed activation only the active and the previous version are
 * kept. Entries that are not versions are someone else's and stay.
 */
export async function pruneVersions(base: string): Promise<void> {
  const active = await readSelector(base);
  // Without a readable selector nothing is known to be safe to delete.
  if (active === null) return;
  const keep = new Set([active, await readPrevious(base)]);
  for (const entry of await readdir(layout(base).versions).catch(() => []))
    if (isProductVersion(entry) && !keep.has(entry))
      await removeVersion(base, entry).catch(() => undefined);
}

const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const stateInvalid = (path: string) =>
  new UpdateFailure("state-invalid", { path });

/** `update/high-water`: the highest version whose activation was ever
 * committed. It only rises. A missing mark means the floor is the active
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

/** `update/pending.json {from, to}`: the activation marker of a supervised
 * installation, written before the switch and deleted by the commit or the
 * undo. One that cannot be read as exactly that is `state-invalid`.
 */
export type PendingActivation = Readonly<{ from: string; to: string }>;

export async function readPending(
  base: string,
): Promise<PendingActivation | null> {
  let text: string;
  try {
    text = await readFile(layout(base).pending, "utf8");
  } catch (error) {
    if (absent(error)) return null;
    throw stateInvalid("update/pending.json");
  }
  try {
    const value = JSON.parse(text) as Partial<PendingActivation> | null;
    if (isProductVersion(value?.from) && isProductVersion(value?.to))
      return Object.freeze({ from: value.from, to: value.to });
  } catch {}
  throw stateInvalid("update/pending.json");
}

/** What a marker means, from what is on disk alone (docs/update.md
 * "Reconciling the marker"). Every combination a crash cannot produce throws
 * `state-invalid` and is left exactly as it was found.
 */
export type MarkerState =
  | Readonly<{ kind: "absent" }>
  /** Crashed before the switch, or after an undo: the marker is stale. */
  | Readonly<{ kind: "not-switched"; pending: PendingActivation }>
  | Readonly<{ kind: "switched"; pending: PendingActivation }>;

async function markerState(base: string): Promise<MarkerState> {
  const pending = await readPending(base);
  if (pending === null) return Object.freeze({ kind: "absent" });
  const active = await readSelector(base);
  if (active === pending.from)
    return Object.freeze({ kind: "not-switched", pending });
  if (active === pending.to && (await readPrevious(base)) === pending.from)
    return Object.freeze({ kind: "switched", pending });
  throw stateInvalid("update/pending.json");
}

/** The ONE step every reconciler begins with — a mutating update command, a
 * starting Launchpad and the rollback unit alike: read and validate the WHOLE
 * update state, and only then decide. An unreadable high-water mark is
 * `state-invalid` whatever the marker says, so nothing is undone, restarted or
 * deleted on top of state a person must look at first.
 */
export type UpdateState = Readonly<{
  highWater: string | null;
  marker: MarkerState;
}>;

export async function readUpdateState(base: string): Promise<UpdateState> {
  const highWater = await readHighWater(base);
  return Object.freeze({ highWater, marker: await markerState(base) });
}

export const writePending = (
  base: string,
  pending: PendingActivation,
  write: DurableWriter = writeDurableFile,
) =>
  write(
    layout(base).update,
    "pending.json",
    Buffer.from(`${JSON.stringify({ from: pending.from, to: pending.to })}\n`),
  );

export async function deletePending(base: string): Promise<void> {
  await rm(layout(base).pending, { force: true });
  await syncDirectory(layout(base).update);
}
