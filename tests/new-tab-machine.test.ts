import { expect, test } from "bun:test";
import {
  loadPercent,
  parseCores,
  parseLoadavg,
  readEnvironmentCpu,
  readEnvironmentDisk,
  type SystemSeams,
  type Volume,
} from "../src/launchpad/new-tab/machine";
import { processNewTabHost } from "../src/launchpad/new-tab-routes";

// The Environment's disk and processor for Přehled (decision F47 point 7,
// its addendum of 2026-11-12): read only, never throwing, null off Linux.

const GiB = 1024 * 1024 * 1024;

const procStat = (cores: number) =>
  [
    "cpu  100 0 0 900 0 0 0 0 0 0",
    ...Array.from({ length: cores }, (_, n) => `cpu${n} 1 0 0 1 0 0 0 0 0 0`),
    "intr 1 2 3",
    "",
  ].join("\n");

test("/proc/stat: the online cores", () => {
  expect(parseCores(procStat(4))).toBe(4);
  expect(parseCores(procStat(24))).toBe(24);
  for (const text of ["", "cpu 1 2 3 4\n", "intr 1 2"])
    expect(parseCores(text)).toBeNull();
});

test("/proc/loadavg: the 5-minute average", () => {
  expect(parseLoadavg("0.95 1.00 0.90 1/1166 1079902\n")).toBe(1);
  expect(parseLoadavg("12.50 7.25 3.10 9/300 42")).toBe(7.25);
  for (const text of ["", "high", "1 2"]) expect(parseLoadavg(text)).toBeNull();
});

test("the processor's number: the 5-minute load against the cores in percent, at most 100", () => {
  expect(loadPercent(1, 4)).toBe(25);
  expect(loadPercent(3.6, 4)).toBe(90);
  expect(loadPercent(0, 24)).toBe(0);
  // Work waiting past the cores is a full processor.
  expect(loadPercent(9.5, 4)).toBe(100);
  expect(loadPercent(1, 0)).toBeNull();
  expect(loadPercent(Number.NaN, 4)).toBeNull();
});

/** A /proc with `stat` and `loadavg`, each null to fail. */
const fakeProc =
  (stat: string | null, loadavg: string | null) => async (path: string) => {
    const text =
      path === "/proc/stat" ? stat : path === "/proc/loadavg" ? loadavg : null;
    if (text === null) throw new Error("ENOENT");
    return text;
  };

const linux: SystemSeams = {
  volume: async () => ({ device: 1, total: GiB, free: GiB }),
  home: null,
};

test("the processor: one reading of each file, never throwing, what it can when a file fails, and nothing off Linux", async () => {
  expect(
    await readEnvironmentCpu(
      fakeProc(procStat(4), "0.50 3.80 2.00 1/100 1\n"),
      linux,
    ),
  ).toEqual({ percent: 95, cores: 4, load: 3.8 });
  expect(
    await readEnvironmentCpu(fakeProc(null, "0.5 1.5 2 1/1 1\n"), linux),
  ).toEqual({ percent: null, cores: null, load: 1.5 });
  expect(await readEnvironmentCpu(fakeProc(procStat(2), null), linux)).toEqual({
    percent: null,
    cores: 2,
    load: null,
  });
  expect(await readEnvironmentCpu(fakeProc(null, null), linux)).toBeNull();
  let read = 0;
  expect(
    await readEnvironmentCpu(async () => {
      read += 1;
      return "";
    }, null),
  ).toBeNull();
  expect(read).toBe(0);
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
  const cpu = await readEnvironmentCpu(host.readFile, host.system ?? null);
  expect(cpu?.cores).toBeGreaterThan(0);
  expect(cpu?.percent).toBeGreaterThanOrEqual(0);
  expect(cpu?.percent).toBeLessThanOrEqual(100);
});
