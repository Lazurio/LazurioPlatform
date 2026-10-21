import { browserUnit } from "../../browser/units";
import type { ServiceManagerProcess } from "../../modules/service-manager-process";
import { launchpadUnit } from "../../update/service-control";

// The Environment's memory for the overview of Nová karta (decision F47
// point 7): its total and what is in use (`/proc/meminfo`), the browser
// (`memory.current` of `lazurio-browser.service`, whose `MemoryMax` F38's
// addenda of 2026-10-10 and 2026-10-20 set), each running Module (its
// transient unit's), the protected core of root decision 0195 point 3 (the
// Launchpad and T3 Code) and the rest. Read only: one `systemctl --user
// show` through the service manager's process adapter
// (service-manager-process.ts), which runs nothing but the manager's own
// tools, and one file. Every value is in bytes,
// or null where it is unknown: off Linux, a unit that does not run (`[not
// set]`), a failed read.

/** T3 Code's unit: its launcher's, which Machines installs and owns
 * (decision F29). */
export const t3codeUnit = "t3code.service";

export type EnvironmentMemory = Readonly<{
  total: number | null;
  /** `MemTotal − MemAvailable`. */
  used: number | null;
  browser: number | null;
  core: Readonly<{ launchpad: number | null; t3code: number | null }>;
  /** The running Modules together. */
  modules: number | null;
  /** What none of the above names, never negative. Unknown when any part
   * is: an unread part may hold any of it. */
  rest: number | null;
}>;

export type MemorySeams = Readonly<{
  /** The service manager's tools; null off Linux or without the user's
   * runtime directory. */
  run: ServiceManagerProcess | null;
  readFile: (path: string) => Promise<string>;
}>;

/** `/proc/meminfo` in bytes, or null without `MemTotal` and `MemAvailable`. */
export function parseMeminfo(
  text: string,
): Readonly<{ total: number; used: number }> | null {
  const kibibytes = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d{1,15}) kB$`, "m").exec(text);
    return match === null ? null : Number(match[1]) * 1024;
  };
  const total = kibibytes("MemTotal");
  const available = kibibytes("MemAvailable");
  return total === null || available === null
    ? null
    : { total, used: Math.max(0, total - available) };
}

/** `memory.current` of each unit from `systemctl show --property=Id,
 * MemoryCurrent` of several units: one block per unit, separated by an empty
 * line. `[not set]`, the manager's "infinity" and anything else that is not
 * a byte count are null. */
export function parseUnitsMemory(text: string): Map<string, number | null> {
  const memory = new Map<string, number | null>();
  for (const block of text.split(/\n\s*\n/)) {
    let id: string | undefined;
    let current: number | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("Id=")) id = line.slice("Id=".length);
      else if (line.startsWith("MemoryCurrent=")) {
        const value = line.slice("MemoryCurrent=".length);
        current =
          /^\d{1,16}$/.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER
            ? Number(value)
            : null;
      }
    }
    if (id !== undefined && id !== "") memory.set(id, current);
  }
  return memory;
}

/** The memory of each unit now; null for each when the manager does not
 * answer. One call for all of them. */
export async function readUnitsMemory(
  run: ServiceManagerProcess | null,
  units: readonly string[],
): Promise<ReadonlyMap<string, number | null>> {
  const unknown = new Map(units.map((unit) => [unit, null]));
  if (run === null || units.length === 0) return unknown;
  try {
    const result = await run(
      "systemctl",
      [
        "--user",
        "show",
        "--no-pager",
        "--property=Id,MemoryCurrent",
        "--",
        ...units,
      ],
      { timeoutMs: 5_000 },
    );
    if (result.code !== 0) return unknown;
    const read = parseUnitsMemory(result.stdout);
    return new Map(units.map((unit) => [unit, read.get(unit) ?? null]));
  } catch {
    return unknown;
  }
}

const sum = (values: readonly (number | null)[]): number | null =>
  values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);

/** The Environment's memory, with the running Modules' units (null when
 * which run is unknown), and each unit's own reading for the Modules'
 * list. */
export async function readEnvironmentMemory(
  seams: MemorySeams,
  moduleUnits: readonly string[] | null,
): Promise<
  Readonly<{
    memory: EnvironmentMemory;
    units: ReadonlyMap<string, number | null>;
  }>
> {
  const [meminfo, units] = await Promise.all([
    seams
      .readFile("/proc/meminfo")
      .then(parseMeminfo)
      .catch(() => null),
    readUnitsMemory(seams.run, [
      browserUnit,
      launchpadUnit,
      t3codeUnit,
      ...(moduleUnits ?? []),
    ]),
  ]);
  const unit = (name: string) => units.get(name) ?? null;
  const browser = unit(browserUnit);
  const core = { launchpad: unit(launchpadUnit), t3code: unit(t3codeUnit) };
  const modules = moduleUnits === null ? null : sum(moduleUnits.map(unit));
  const used = meminfo?.used ?? null;
  const parts = sum([browser, core.launchpad, core.t3code, modules]);
  return Object.freeze({
    memory: Object.freeze({
      total: meminfo?.total ?? null,
      used,
      browser,
      core: Object.freeze(core),
      modules,
      rest: used === null || parts === null ? null : Math.max(0, used - parts),
    }),
    units,
  });
}
