import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readOwnedJson } from "../providers/owned-json";
import {
  type InstallLocation,
  stagedVersionName,
  verifyInstallLocation,
  verifyStagedVersionDirectory,
} from "./install-location";
import { exactFields } from "./trust-checkpoint";

/** The single owner-controlled active version record and the one stable
 * entrypoint derived from it. `active.json` names the active staged version
 * and the version it replaced; `bin/lazurio` is a symlink to that version's
 * immutable artifact, replaced by rename so a running executable is never
 * overwritten. Activation changes only what future launches select: draining
 * running consumers and PATH integration are separate, later steps.
 */
export type ActiveProduct = Readonly<{
  name: string;
  artifactSha256: string;
  previous: string | null;
  artifactPath: string;
}>;

const entrypoint = "lazurio";

/** Reads the active record and proves the entrypoint agrees with it. Absent
 * record and entrypoint means nothing is active. A record without a matching
 * entrypoint, or an entrypoint without a record, is an interrupted activation
 * that fails closed until the same activation is repeated.
 */
export async function readActiveProduct(
  input: InstallLocation,
): Promise<ActiveProduct | null> {
  const location = await verifyInstallLocation(input);
  const recordPath = join(location.base, "active.json");
  const linkPath = join(location.base, "bin", entrypoint);
  const record = await readRecord(recordPath);
  const target = await readEntrypoint(linkPath);
  if (!record && !target) return null;
  if (!record || !target)
    throw new Error("Interrupted activation; repeat the activation to recover");
  const artifactPath = join(location.versions, record.name, entrypoint);
  if (target !== artifactPath)
    throw new Error("Entrypoint does not select the active version");
  await verifyRecordedVersion(location, record);
  return Object.freeze({ ...record, artifactPath });
}

// The record's full digest must equal the staged provenance and identity of
// the version it names; a prefix match through the name proves nothing.
async function verifyRecordedVersion(
  location: InstallLocation,
  record: Readonly<{ name: string; artifactSha256: string }>,
) {
  const directory = join(location.versions, record.name);
  await verifyStagedVersionDirectory(directory, record.name);
  const provenance = exactFields(
    await readOwnedJson(join(directory, "provenance.json")),
    ["artifactSha256", "attempt", "channel", "schemaVersion"],
  );
  if (provenance.artifactSha256 !== record.artifactSha256)
    throw new Error("Active record digest does not match the staged version");
}

/** Activates one already staged, verified version under the owner lock. The
 * artifact bytes are re-hashed against the staged provenance before the record
 * is replaced atomically and the entrypoint symlink is swapped by rename.
 * Repeating an activation completes an interrupted one; nothing else repairs.
 * Refusals never change the active record or the entrypoint.
 */
export async function activateStagedProduct(options: {
  location: InstallLocation;
  name: string;
  executionTarget: string;
}): Promise<ActiveProduct & { alreadyActive: boolean }> {
  const location = await verifyInstallLocation(options.location);
  if (!stagedVersionName.test(options.name))
    throw new Error("Invalid staged version name");
  if (options.executionTarget.startsWith("windows-"))
    throw new Error("Unqualified activation platform");
  return withFolderOperationLock(location.owner, async (assertHeld) => {
    const directory = join(location.versions, options.name);
    await verifyStagedVersionDirectory(directory, options.name);
    const provenance = exactFields(
      await readOwnedJson(join(directory, "provenance.json")),
      ["artifactSha256", "attempt", "channel", "schemaVersion"],
    );
    const identity = (
      (await readOwnedJson(join(directory, "identity.json"))) as Record<
        string,
        unknown
      >
    ).identity as Record<string, unknown>;
    if (identity.target !== options.executionTarget)
      throw new Error("Staged version targets a different platform");
    const artifactPath = join(directory, entrypoint);
    const artifactSha256 = await sha256File(artifactPath);
    if (
      artifactSha256 !== provenance.artifactSha256 ||
      artifactSha256 !== identity.artifactSha256
    )
      throw new Error("Staged artifact bytes do not match their provenance");
    const recordPath = join(location.base, "active.json");
    const linkPath = join(location.base, "bin", entrypoint);
    const current = await readRecord(recordPath);
    const target = await readEntrypoint(linkPath);
    if (current) {
      // An existing record must be fully coherent before it is trusted for an
      // idempotent return or replaced; a corrupt record is never overwritten
      // as a repair.
      if (current.name === options.name) {
        if (current.artifactSha256 !== artifactSha256)
          throw new Error(
            "Active record digest does not match the staged artifact bytes",
          );
      } else await verifyRecordedVersion(location, current);
    }
    if (current?.name === options.name && target === artifactPath)
      return Object.freeze({
        ...current,
        artifactPath,
        alreadyActive: true,
      });
    await assertHeld();
    const record = Object.freeze({
      name: options.name,
      artifactSha256,
      previous:
        current === null || current.name === options.name
          ? (current?.previous ?? null)
          : current.name,
    });
    if (current?.name !== options.name) {
      // Replace the record atomically; a leftover transient is this owner's
      // own, created only under the lock, and never read as the record.
      const next = join(location.base, "active.json.next");
      await rm(next, { force: true });
      const file = await open(next, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ schemaVersion: 1, ...record }));
        await file.sync();
      } finally {
        await file.close();
      }
      await chmod(next, 0o400);
      await rename(next, recordPath);
      await syncPath(location.base);
    }
    // Swap the entrypoint by rename so no running executable is overwritten.
    const bin = join(location.base, "bin");
    try {
      await mkdir(bin, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await inspectOwnedDirectory(bin);
    const staging = join(bin, `.lazurio-${randomBytes(8).toString("hex")}`);
    await symlink(artifactPath, staging);
    await rename(staging, linkPath);
    await syncPath(bin);
    if ((await readEntrypoint(linkPath)) !== artifactPath)
      throw new Error("Entrypoint swap failed verification");
    return Object.freeze({ ...record, artifactPath, alreadyActive: false });
  });
}

async function readRecord(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const fields = exactFields(await readOwnedJson(path), [
    "artifactSha256",
    "name",
    "previous",
    "schemaVersion",
  ]);
  if (
    fields.schemaVersion !== 1 ||
    typeof fields.name !== "string" ||
    !stagedVersionName.test(fields.name) ||
    typeof fields.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(fields.artifactSha256) ||
    !fields.artifactSha256.startsWith(fields.name.split("+")[1] as string) ||
    (fields.previous !== null &&
      (typeof fields.previous !== "string" ||
        !stagedVersionName.test(fields.previous)))
  )
    throw new Error("Invalid active version record");
  return Object.freeze({
    name: fields.name,
    artifactSha256: fields.artifactSha256,
    previous: fields.previous as string | null,
  });
}

async function readEntrypoint(path: string) {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error("Entrypoint is not this product's symbolic link");
  return readlink(path);
}

async function sha256File(path: string) {
  const file = await open(path, "r");
  const digest = createHash("sha256");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  return digest.digest("hex");
}

async function syncPath(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
