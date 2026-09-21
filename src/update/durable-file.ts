import { randomBytes } from "node:crypto";
import { open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

/** Temporary names are owned by this module: a leftover from a killed writer
 * is never a published file and is always safe to delete.
 */
const temporaryName = /^\.[A-Za-z0-9._-]+\.tmp-[0-9a-f]{16}$/;

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Replace `directory/name` so that a reader — and a machine that loses power
 * at any instant — sees either the complete old bytes or the complete new
 * bytes: temporary file, file sync, rename, directory sync.
 */
export type DurableWriter = (
  directory: string,
  name: string,
  bytes: Uint8Array,
) => Promise<void>;

export const writeDurableFile: DurableWriter = async (
  directory,
  name,
  bytes,
) => {
  const temporary = join(
    directory,
    `.${name}.tmp-${randomBytes(8).toString("hex")}`,
  );
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await file.close();
  try {
    await rename(temporary, join(directory, name));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
};

/** Only under the operation lock: no writer of this directory can be alive. */
export async function removeAbandonedTemporaries(
  directory: string,
): Promise<void> {
  for (const entry of await readdir(directory))
    if (temporaryName.test(entry))
      await rm(join(directory, entry), { force: true });
}
