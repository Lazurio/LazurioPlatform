// The Environment's disk and processor for the overview of Nová karta
// (decision F47 point 7, its addendum of 2026-11-12), beside the memory
// (memory.ts). Read only and never throwing: `statfs` of the root and, when
// the home folder is on another file system, of the home folder; the cores
// of `/proc/stat` and the 5-minute load average of `/proc/loadavg`. No
// daemon, no state, no walk of the disk. Off Linux there is nothing to read: both are
// null. Every value is in bytes or a plain number, or null where unknown.

/** One file system: its size and what an unprivileged writer can still
 * write (`f_bavail`), in bytes, and the device that holds the path. */
export type Volume = Readonly<{ device: number; total: number; free: number }>;

/** Where the disk and the processor are read. Null off Linux. */
export type SystemSeams = Readonly<{
  volume: (path: string) => Promise<Volume>;
  /** The account's home folder; null when unknown. */
  home: string | null;
}>;

/** A file system as Přehled shows it: `used` is everything nobody but the
 * system may write any more, the blocks reserved for root included, so a
 * full bar means writes fail. */
export type DiskSpace = Readonly<{ total: number; used: number; free: number }>;

export type EnvironmentDisk = DiskSpace &
  Readonly<{
    /** The home folder when it is on another file system than the root;
     * null when it is the same one or could not be read. */
    home: DiskSpace | null;
  }>;

export type EnvironmentCpu = Readonly<{
  /** The 5-minute load average against the cores, 0-100. */
  percent: number | null;
  /** Online cores (`cpuN` lines of `/proc/stat`). */
  cores: number | null;
  /** The load average over 5 minutes (`/proc/loadavg`). */
  load: number | null;
}>;

const byteCount = (value: number): number | null =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

function space(volume: Volume): DiskSpace | null {
  const total = byteCount(volume.total);
  const free = byteCount(volume.free);
  if (total === null || free === null || total === 0) return null;
  const left = Math.min(free, total);
  return { total, used: total - left, free: left };
}

/** The root's space and, on another file system, the home folder's; null
 * when the root cannot be read. */
export async function readEnvironmentDisk(
  system: SystemSeams | null,
): Promise<EnvironmentDisk | null> {
  if (system === null) return null;
  const read = (path: string) =>
    system.volume(path).then(
      (volume) => ({ volume, space: space(volume) }),
      () => null,
    );
  const [root, home] = await Promise.all([
    read("/"),
    system.home === null || system.home === "/"
      ? Promise.resolve(null)
      : read(system.home),
  ]);
  if (root?.space == null) return null;
  return {
    ...root.space,
    home:
      home?.space == null || home.volume.device === root.volume.device
        ? null
        : home.space,
  };
}

/** The online cores: the `cpuN` lines of `/proc/stat`; null without any. */
export function parseCores(text: string): number | null {
  const cores = text.match(/^cpu\d+ /gm)?.length ?? 0;
  return cores > 0 ? cores : null;
}

/** The 5-minute load average of `/proc/loadavg`; null when it is not one. */
export function parseLoadavg(text: string): number | null {
  const match = /^\d+(?:\.\d+)? (\d+(?:\.\d+)?) \d+(?:\.\d+)? /.exec(text);
  return match === null ? null : Number(match[1]);
}

/** The 5-minute load against the cores in percent, at most 100: a load
 * past the cores is a full processor with work waiting. */
export function loadPercent(load: number, cores: number): number | null {
  if (!Number.isFinite(load) || load < 0 || cores <= 0) return null;
  return Math.min(100, Math.round((load / cores) * 100));
}

/** The processor: its cores, its 5-minute load average and that load in
 * percent of the cores (Matěj 2026-11-12: the number Přehled shows is the
 * average its warning reads). One reading of each file, no state, no wait.
 * Null off Linux (`system` null) or when neither file can be read. */
export async function readEnvironmentCpu(
  readFile: (path: string) => Promise<string>,
  system: SystemSeams | null,
): Promise<EnvironmentCpu | null> {
  if (system === null) return null;
  const [cores, load] = await Promise.all([
    readFile("/proc/stat")
      .then(parseCores)
      .catch(() => null),
    readFile("/proc/loadavg")
      .then(parseLoadavg)
      .catch(() => null),
  ]);
  if (cores === null && load === null) return null;
  return {
    percent: cores === null || load === null ? null : loadPercent(load, cores),
    cores,
    load,
  };
}
