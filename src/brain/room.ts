import { lstat, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { meaningPaths } from "./meaning-pin";
import { type BrainPaths, brainPin, releaseCommand } from "./pin";

// The brain's size and the room on the disk for what a takeover and the
// moves after it write (plan LZD-0033 R11a): a copy of the brain before the
// move to the pin and another before search by meaning is switched on (both
// kept), the brain growing by its vectors, the pinned release where it is
// not installed yet (about 500 MB measured), the model and its server where
// they are not there yet (about 650 MB), and a reserve. Read from file
// metadata only, never the brain's content.

export type BrainRoom = Readonly<{
  /** Bytes and number of the files in ~/.gbrain; null where unreadable. */
  brainBytes: number | null;
  brainFiles: number | null;
  /** Room left for this user on the disk of the home; null where unread. */
  freeBytes: number | null;
  /** What the takeover and the moves after it need; null where unknown. */
  neededBytes: number | null;
}>;

/** Room left on the file system of a path. */
export type FreeBytes = (path: string) => Promise<number | null>;

const mib = 1024 * 1024;
export const pinInstallBytes = 640 * mib;
export const meaningInstallBytes = 768 * mib;
export const reserveBytes = 1024 * mib;

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function sizeOf(
  root: string,
): Promise<Readonly<{ bytes: number; files: number }> | null> {
  let bytes = 0;
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        bytes += (await lstat(path)).size;
        files += 1;
      }
    }
  };
  try {
    await walk(root);
    return Object.freeze({ bytes, files });
  } catch {
    return null;
  }
}

export const freeBytesAt: FreeBytes = async (path) => {
  try {
    const fs = await statfs(path);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
};

export async function brainRoom(
  paths: BrainPaths,
  freeBytes: FreeBytes = freeBytesAt,
): Promise<BrainRoom> {
  const size = await sizeOf(paths.brain);
  const free = await freeBytes(paths.home);
  const needed =
    size === null
      ? null
      : 3 * size.bytes +
        ((await present(releaseCommand(paths, brainPin.commit)))
          ? 0
          : pinInstallBytes) +
        ((await present(meaningPaths(paths.home).model))
          ? 0
          : meaningInstallBytes) +
        reserveBytes;
  return Object.freeze({
    brainBytes: size?.bytes ?? null,
    brainFiles: size?.files ?? null,
    freeBytes: free,
    neededBytes: needed,
  });
}

/** Too little room, or room that cannot be told: fail closed. */
export const roomShort = (room: BrainRoom) =>
  room.neededBytes === null ||
  room.freeBytes === null ||
  room.freeBytes < room.neededBytes;
