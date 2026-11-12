import { expect, test } from "bun:test";
import {
  busyPercent,
  cpuWindowMs,
  createCpuReader,
  parseLoadavg,
  parseProcStat,
  readEnvironmentDisk,
  type SystemSeams,
  type Volume,
} from "../src/launchpad/new-tab/machine";
import { processNewTabHost } from "../src/launchpad/new-tab-routes";

// The Environment's disk and processor for Přehled (decision F47 point 7,
// its addendum of 2026-11-12): read only, never throwing, null off Linux.

const GiB = 1024 * 1024 * 1024;

/** `/proc/stat` with the aggregate line's user, nice, system, idle, iowait,
 * irq, softirq, steal, guest and guest_nice, and `cores` lines. */
const procStat = (busy: number, idle: number, cores = 4) =>
  [
    `cpu  ${busy} 0 0 ${idle} 0 0 0 0 ${busy} 0`,
    ...Array.from({ length: cores }, (_, n) => `cpu${n} 1 0 0 1 0 0 0 0 0 0`),
    "intr 1 2 3",
    "ctxt 100",
    "btime 1700000000",
    "",
  ].join("\n");

test("/proc/stat: busy and all ticks of the first line, idle and iowait idle, guest not twice, and the cores", () => {
  expect(
    parseProcStat(
      "cpu  100 5 20 800 40 3 2 1 50 0\ncpu0 1 0 0 1 0 0 0 0 0 0\ncpu1 1 0 0 1 0 0 0 0 0 0\n",
    ),
  ).toEqual({ times: { busy: 131, total: 971 }, cores: 2 });
  // An old kernel's four fields.
  expect(parseProcStat("cpu 10 0 10 80\n")).toEqual({
    times: { busy: 20, total: 100 },
    cores: null,
  });
  for (const text of [
    "",
    "intr 1 2",
    "cpu 1 2\n",
    "cpu0 1 2 3 4\n",
    "cpu a b c d\n",
  ])
    expect(parseProcStat(text)).toBeNull();
});

test("busy between two readings in percent; nothing when no time passed or the counters went back", () => {
  expect(
    busyPercent({ busy: 100, total: 1000 }, { busy: 350, total: 2000 }),
  ).toBe(25);
  expect(busyPercent({ busy: 0, total: 0 }, { busy: 10, total: 10 })).toBe(100);
  expect(
    busyPercent({ busy: 5, total: 10 }, { busy: 5, total: 10 }),
  ).toBeNull();
  // A reboot between the readings.
  expect(
    busyPercent({ busy: 900, total: 2000 }, { busy: 10, total: 100 }),
  ).toBeNull();
});

test("/proc/loadavg: the 5-minute average", () => {
  expect(parseLoadavg("0.95 1.00 0.90 1/1166 1079902\n")).toBe(1);
  expect(parseLoadavg("12.50 7.25 3.10 9/300 42")).toBe(7.25);
  for (const text of ["", "high", "1 2"]) expect(parseLoadavg(text)).toBeNull();
});

/** A /proc whose /proc/stat answers `stats` one after another (the last
 * again), with a fake clock that `sleep` moves. */
function fakeProc(
  stats: (string | null)[],
  loadavg: string | null = "0.50 3.80 2.00 1/100 1\n",
) {
  let at = 0;
  const reads: number[] = [];
  const sleeps: number[] = [];
  let next = 0;
  return {
    reads,
    sleeps,
    advance: (ms: number) => {
      at += ms;
    },
    seams: {
      readFile: async (path: string) => {
        if (path === "/proc/loadavg") {
          if (loadavg === null) throw new Error("ENOENT");
          return loadavg;
        }
        if (path !== "/proc/stat") throw new Error(`unexpected ${path}`);
        reads.push(at);
        const text = stats[Math.min(next, stats.length - 1)] ?? null;
        next += 1;
        if (text === null) throw new Error("ENOENT");
        return text;
      },
      now: () => at,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        at += ms;
      },
    },
  };
}

const linux: SystemSeams = {
  volume: async () => ({ device: 1, total: GiB, free: GiB }),
  home: null,
};

test("the processor: a first reading samples twice, a later one measures since the last, a sooner one repeats it", async () => {
  const proc = fakeProc([
    procStat(100, 900),
    procStat(150, 950), // after the 250 ms sample: 50 %
    procStat(450, 1650), // 5 s later: 300 of 1000, 30 %
    procStat(999, 9999), // not read: within a second
    procStat(1450, 1650), // 70 s later, too old: sampled again
    procStat(1550, 1650), // 100 %
  ]);
  const read = createCpuReader(proc.seams);
  expect(await read(linux)).toEqual({ percent: 50, cores: 4, load: 3.8 });
  expect(proc.sleeps).toEqual([cpuWindowMs.sample]);
  proc.advance(5_000);
  expect(await read(linux)).toEqual({ percent: 30, cores: 4, load: 3.8 });
  expect(proc.sleeps).toHaveLength(1);
  proc.advance(500);
  // Within a second of the last: the same answer, still from a fresh read.
  expect((await read(linux))?.percent).toBe(30);
  proc.advance(70_000);
  expect((await read(linux))?.percent).toBe(100);
  expect(proc.sleeps).toHaveLength(2);
});

test("the processor never throws: an unreadable /proc gives what it can, off Linux nothing", async () => {
  const none = fakeProc([null], null);
  expect(await createCpuReader(none.seams)(linux)).toBeNull();
  const loadOnly = fakeProc([null]);
  expect(await createCpuReader(loadOnly.seams)(linux)).toEqual({
    percent: null,
    cores: null,
    load: 3.8,
  });
  // The second reading fails: the cores are known, how busy is not.
  const once = fakeProc([procStat(1, 1), null], null);
  expect(await createCpuReader(once.seams)(linux)).toEqual({
    percent: null,
    cores: 4,
    load: null,
  });
  const off = fakeProc([procStat(1, 1)]);
  expect(await createCpuReader(off.seams)(null)).toBeNull();
  expect(off.reads).toEqual([]);
});

function volumes(
  table: Readonly<Record<string, Volume | Error>>,
  home: string | null,
): SystemSeams & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    home,
    volume: async (path) => {
      asked.push(path);
      const volume = table[path];
      if (volume === undefined || volume instanceof Error)
        throw volume ?? new Error("ENOENT");
      return volume;
    },
  };
}

test("the disk: the root's space, what only the system may write counted as used, and the home folder only on a disk of its own", async () => {
  const root = { device: 2049, total: 60 * GiB, free: 20 * GiB };
  expect(
    await readEnvironmentDisk(
      volumes({ "/": root, "/home/a": { ...root } }, "/home/a"),
    ),
  ).toEqual({ total: 60 * GiB, used: 40 * GiB, free: 20 * GiB, home: null });
  expect(
    await readEnvironmentDisk(
      volumes(
        { "/": root, "/home/a": { device: 2065, total: 100 * GiB, free: GiB } },
        "/home/a",
      ),
    ),
  ).toEqual({
    total: 60 * GiB,
    used: 40 * GiB,
    free: 20 * GiB,
    home: { total: 100 * GiB, used: 99 * GiB, free: GiB },
  });
  // An unreadable home folder is left out; an unreadable root is no disk.
  expect(
    (
      await readEnvironmentDisk(
        volumes({ "/": root, "/home/a": new Error("EACCES") }, "/home/a"),
      )
    )?.home,
  ).toBeNull();
  expect(
    await readEnvironmentDisk(volumes({ "/home/a": root }, "/home/a")),
  ).toBeNull();
  // A size that is no byte count, or free past the size.
  expect(
    await readEnvironmentDisk(
      volumes({ "/": { device: 1, total: 0, free: 0 } }, null),
    ),
  ).toBeNull();
  expect(
    await readEnvironmentDisk(
      volumes({ "/": { device: 1, total: GiB, free: 2 * GiB } }, null),
    ),
  ).toEqual({ total: GiB, used: 0, free: GiB, home: null });
  const rootOnly = volumes({ "/": root }, null);
  await readEnvironmentDisk(rootOnly);
  expect(rootOnly.asked).toEqual(["/"]);
  expect(await readEnvironmentDisk(null)).toBeNull();
});

test("the Launchpad's own host reads the disk and the processor only on Linux, from statfs, and never walks the disk", async () => {
  for (const platform of ["darwin", "win32"])
    expect(processNewTabHost({ HOME: "/Users/a" }, platform).system).toBeNull();
  const host = processNewTabHost({ HOME: "relative" }, "linux");
  expect(host.system?.home).toBeNull();
  if (process.platform !== "linux") return;
  // This Linux: the root's real numbers.
  const disk = await readEnvironmentDisk(host.system ?? null);
  expect(disk?.total).toBeGreaterThan(0);
  expect((disk?.used ?? -1) + (disk?.free ?? -1)).toBe(disk?.total ?? 0);
  const cpu = await createCpuReader({ readFile: host.readFile })(
    host.system ?? null,
  );
  expect(cpu?.cores).toBeGreaterThan(0);
  expect(cpu?.percent).toBeGreaterThanOrEqual(0);
});
