// The Environment's disk and processor for the overview of Nová karta
// (decision F47 point 7, its addendum of 2026-11-12), beside the memory
// (memory.ts). Read only and never throwing: `statfs` of the root and, when
// the home folder is on another file system, of the home folder; two
// readings of `/proc/stat` and the load average of `/proc/loadavg`. No
// daemon, no walk of the disk. Off Linux there is nothing to read: both are
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
  /** How busy all cores were over the last moment, 0-100. */
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

/** The processor's times since boot: busy and in all, in clock ticks. */
export type CpuTimes = Readonly<{ busy: number; total: number }>;

/** `/proc/stat`'s first line in ticks and its count of cores; null without
 * the line. `idle` and `iowait` are idle; `guest` is counted in `user`
 * already and is left out. */
export function parseProcStat(
  text: string,
): Readonly<{ times: CpuTimes; cores: number | null }> | null {
  const line = /^cpu +([\d ]+)$/m.exec(text);
  if (line === null) return null;
  const fields = (line[1] ?? "").trim().split(/ +/).slice(0, 8).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isSafeInteger(value)))
    return null;
  const total = fields.reduce((sum, value) => sum + value, 0);
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const cores = text.match(/^cpu\d+ /gm)?.length ?? 0;
  return {
    times: { busy: total - idle, total },
    cores: cores > 0 ? cores : null,
  };
}

/** How busy the processor was between two readings, 0-100; null when no
 * time passed or the counters went back (a reboot between them). */
export function busyPercent(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total;
  const busy = after.busy - before.busy;
  if (total <= 0 || busy < 0) return null;
  return Math.min(100, Math.max(0, Math.round((busy / total) * 100)));
}

/** The 5-minute load average of `/proc/loadavg`; null when it is not one. */
export function parseLoadavg(text: string): number | null {
  const match = /^\d+(?:\.\d+)? (\d+(?:\.\d+)?) \d+(?:\.\d+)? /.exec(text);
  return match === null ? null : Number(match[1]);
}

export type CpuSeams = Readonly<{
  readFile: (path: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

/** A reading taken within this long of the last is measured against the
 * last one; a sooner one repeats its answer, a later or a first one takes
 * two readings `sample` ms apart. */
export const cpuWindowMs = Object.freeze({
  min: 1_000,
  max: 60_000,
  sample: 250,
});

/** The processor's reader for one Launchpad: it keeps its last reading, so
 * Přehled, read every 5 s, measures the time since its last reading
 * without a wait. Null off Linux (`system` null). */
export function createCpuReader(
  seams: CpuSeams,
): (system: SystemSeams | null) => Promise<EnvironmentCpu | null> {
  const now = seams.now ?? Date.now;
  const sleep =
    seams.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stat = () =>
    seams
      .readFile("/proc/stat")
      .then(parseProcStat)
      .catch(() => null);
  let last: Readonly<{ times: CpuTimes; at: number }> | null = null;
  let lastPercent: number | null = null;
  return async (system) => {
    if (system === null) return null;
    const [first, load] = await Promise.all([
      stat(),
      seams
        .readFile("/proc/loadavg")
        .then(parseLoadavg)
        .catch(() => null),
    ]);
    const at = now();
    let percent: number | null = null;
    if (first !== null) {
      const since = last === null ? null : at - last.at;
      if (
        last !== null &&
        since !== null &&
        since >= cpuWindowMs.min &&
        since <= cpuWindowMs.max
      ) {
        percent = busyPercent(last.times, first.times);
        last = { times: first.times, at };
      } else if (since !== null && since >= 0 && since < cpuWindowMs.min) {
        percent = lastPercent;
      }
      if (percent === null) {
        await sleep(cpuWindowMs.sample);
        const second = await stat();
        if (second !== null) {
          percent = busyPercent(first.times, second.times);
          last = { times: second.times, at: now() };
        }
      }
      lastPercent = percent;
    }
    if (first === null && load === null) return null;
    return { percent, cores: first?.cores ?? null, load };
  };
}
