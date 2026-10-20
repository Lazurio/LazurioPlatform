import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { parseMeminfo } from "../../launchpad/new-tab/memory";
import { readProcessControlGroup } from "../../modules/service-manager-process";
import { browserUnit } from "../units";

/** The pressure rule of sleeping tabs (decision F57 point 6, root decision
 * 0195 point 18): under memory pressure the view's hub puts tabs to sleep,
 * one at a time, before the kernel ends their renderers. Pressure is what
 * the kernel reports as time lost waiting for memory (PSI), never memory in
 * use: the browser's `memory.current` keeps the page cache charged, which
 * went 246 → 616 → 478 MiB on the reference Environment after two tabs were
 * opened and closed again. The rules here read and test on their own; the
 * hub applies them through the sleep it has for the idle rule. */

/** When the Environment counts as under pressure, and when no longer. Every
 * value is provisional until measured on Ring 0 (root decision 0204): on
 * 2026-10-20 the reference Environment (4 vCPU, 8 GiB, zswap, 28 tabs) saw
 * PSI `some avg10` peak at 19 % for about 20 s while heavy pages loaded and
 * stay under 5 % otherwise, with `MemAvailable` from 5.2 down to about 2.9
 * GiB and no renderer ended. The gap between start and stop is the
 * hysteresis: pressure that hovers near one limit does not flap. */
export const pressureLimits = Object.freeze({
  /** Under pressure once PSI `some avg10` of the browser or of the
   * Environment reaches this, in percent... */
  startSomePercent: 10,
  /** ...or `MemAvailable` falls under this share of `MemTotal`. */
  startAvailable: 0.1,
  /** No longer once every PSI read is under this... */
  stopSomePercent: 2,
  /** ...and `MemAvailable` is above this share. */
  stopAvailable: 0.15,
});

/** The rule's times, in milliseconds; provisional as `pressureLimits`. */
export const pressureTimes = Object.freeze({
  /** How often the hub reads the signals: three small files. */
  readEveryMs: 5_000,
  /** The cool-down: under pressure, at most one tab falls asleep in this
   * time, so PSI's ten-second average shows what the last one gave. */
  coolDownMs: 15_000,
  /** A tab in use this recently is not taken: the tab a person has just
   * opened, woken or left. */
  quietMs: 60_000,
});

/** What the hub knows of the memory now: the highest PSI `some avg10` it
 * could read, in percent, and `MemAvailable` as a share of `MemTotal`. Null
 * for what could not be read; both null and the rule does nothing. */
export type PressureReading = Readonly<{
  some: number | null;
  available: number | null;
}>;

export const noReading: PressureReading = Object.freeze({
  some: null,
  available: null,
});

/** Under pressure now, given whether it was at the last reading: it starts
 * at either start limit and ends only once every signal read is past its
 * stop limit. A signal that could not be read counts for neither. */
export function underPressure(was: boolean, reading: PressureReading): boolean {
  const { some, available } = reading;
  if (some === null && available === null) return false;
  if (
    (some !== null && some >= pressureLimits.startSomePercent) ||
    (available !== null && available < pressureLimits.startAvailable)
  )
    return true;
  if (!was) return false;
  const calm =
    (some === null || some < pressureLimits.stopSomePercent) &&
    (available === null || available > pressureLimits.stopAvailable);
  return !calm;
}

/** `some avg10` of a PSI file (`/proc/pressure/memory` or a cgroup's
 * `memory.pressure`), in percent; null for a text that is not one. The
 * `full` line is not read: it counts only the moments when every task
 * waits, so it is never higher than `some`. */
export function parsePressure(text: string): number | null {
  const match = /^some avg10=(\d{1,3}(?:\.\d{1,2})?) /m.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

/** `MemAvailable` as a share of `MemTotal` from `/proc/meminfo`; null for a
 * text without both. */
export function availableShare(text: string): number | null {
  const memory = parseMeminfo(text);
  if (memory === null || memory.total <= 0) return null;
  return (memory.total - memory.used) / memory.total;
}

/** One awake tab as the pressure rule sees it. */
export type PressureCandidate = Readonly<{
  /** Someone views it now, on a shown page. */
  viewed: boolean;
  /** An agent works in it or did recently: the idle rule's test (its
   * agent-browser daemon, or input and navigations nobody viewed). */
  agent: boolean;
  /** A T3 Code thread's strip holds it (F57 point 3). */
  thread: boolean;
  /** A holder file holds it: the Launchpad's strip, or another app's. */
  held: boolean;
  /** The hub found unsaved input in it when it last looked. */
  unsaved: boolean;
  /** Its quiet clock (`quietSince`), the hub's milliseconds. */
  quietSince: number;
  /** When the hub last asked its page to close and it stayed awake (its
   * `beforeunload` objected, or it hung); 0 for never. */
  askedAt: number;
}>;

/** The tabs the pressure rule may put to sleep, in the order it tries them:
 * - first the tabs nothing holds, whose tombstone F47's grace ends as it
 *   would have ended the tab;
 * - then the held tabs;
 * - last the tabs with unsaved input, which only their page's
 *   `beforeunload` can keep awake;
 * each the least recently used first. Never a tab someone views, an agent
 * works in or worked in recently, or a T3 Code thread holds; never one in
 * use within `quietMs`; never one whose page was asked to close and stayed
 * awake within `askAgainMs` (the idle time): it would only object again. */
export function pressureOrder<T extends PressureCandidate>(
  candidates: readonly T[],
  now: number,
  times: Readonly<{ quietMs: number; askAgainMs: number }>,
): T[] {
  const rank = (candidate: T) =>
    candidate.unsaved ? 2 : candidate.held ? 1 : 0;
  return candidates
    .filter(
      (candidate) =>
        !candidate.viewed &&
        !candidate.agent &&
        !candidate.thread &&
        now - candidate.quietSince >= times.quietMs &&
        now - candidate.askedAt >= times.askAgainMs,
    )
    .sort((a, b) => rank(a) - rank(b) || a.quietSince - b.quietSince);
}

/** Where the browser's cgroup keeps its PSI: the unit next to this one. The
 * view (`lazurio-browser-view.service`) and the browser are user services
 * the Platform writes without a `Slice=`, so the user manager puts both in
 * the same slice. Null without a cgroup of its own (cgroup v2) to start
 * from. */
export function browserPressurePath(ownControlGroup: string): string | null {
  if (!ownControlGroup.startsWith("/") || ownControlGroup.includes("\0"))
    return null;
  const parts = ownControlGroup.split("/").filter((part) => part !== "");
  if (parts.length < 2 || parts.includes("..")) return null;
  return posix.join(
    "/sys/fs/cgroup",
    ...parts.slice(0, -1),
    browserUnit,
    "memory.pressure",
  );
}

export type PressureSeams = Readonly<{
  log: (line: string) => void;
  /** Reads one file as text; `fs.readFile` unless given. */
  readFile?: (path: string) => Promise<string>;
  /** The view's own cgroup, from `/proc/self/cgroup`, unless given. */
  ownControlGroup?: () => Promise<string | null>;
}>;

/** The hub's pressure source on Linux: on each call it reads the browser
 * cgroup's `memory.pressure`, the Environment's `/proc/pressure/memory` and
 * `/proc/meminfo`, three small files, and never throws. A file that cannot
 * be read is left out and logged once; with none read the rule is off,
 * logged once too, until one can be read. The browser's cgroup is found
 * once, at the first call. */
export function pressureSource(
  seams: PressureSeams,
): () => Promise<PressureReading> {
  const read = seams.readFile ?? ((path: string) => readFile(path, "utf8"));
  const own =
    seams.ownControlGroup ?? (() => readProcessControlGroup(process.pid));
  let browser: Promise<string | null> | null = null;
  const logged = new Set<string>();
  const once = (key: string, line: string) => {
    if (logged.has(key)) return;
    logged.add(key);
    seams.log(line);
  };
  const value = async <T>(
    path: string,
    parse: (text: string) => T | null,
  ): Promise<T | null> => {
    try {
      const parsed = parse(await read(path));
      if (parsed === null)
        once(path, `memory pressure: ${path} reads as nothing it knows`);
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      once(path, `memory pressure: ${path} cannot be read (${code})`);
      return null;
    }
  };
  return async () => {
    browser ??= own()
      .catch(() => null)
      .then((group) => (group === null ? null : browserPressurePath(group)));
    const path = await browser;
    if (path === null)
      once(
        "browser",
        "memory pressure: the browser's cgroup is unknown; the rule reads the Environment's alone",
      );
    const [ofBrowser, ofEnvironment, available] = await Promise.all([
      path === null ? null : value(path, parsePressure),
      value("/proc/pressure/memory", parsePressure),
      value("/proc/meminfo", availableShare),
    ]);
    const psi = [ofBrowser, ofEnvironment].filter(
      (some): some is number => some !== null,
    );
    const reading: PressureReading = {
      some: psi.length === 0 ? null : Math.max(...psi),
      available,
    };
    if (reading.some === null && reading.available === null)
      once("off", "memory pressure: nothing to read; the pressure rule is off");
    return reading;
  };
}
