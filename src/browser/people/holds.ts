import { randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** Who keeps a remote tab of the Environment browser (decision F47 points 4
 * and 5), read by the view's hub, which alone ends a tab:
 * - the places that hold it: one file per strip that the app's server writes,
 *   `$XDG_RUNTIME_DIR/lazurio-browser/holders/<strip>.json` =
 *   `{"strip", "label", "tabs": [<target id>…]}` (a T3 Code thread, the
 *   Launchpad), with the writer's own `recordedAt`, which the hub ignores;
 * - the agents that work in it: an agent-browser session bound to it
 *   (`<socket dir>/<session>.target`) whose daemon runs (`<session>.pid`
 *   names a live process). The binding alone does not count: agent-browser
 *   keeps it past the daemon on purpose, and the daemon ends after an hour
 *   without a command. */

export type Hold = Readonly<{ strip: string; label: string }>;

export type Holds = Readonly<{
  /** The strips that hold each target. */
  holders: ReadonlyMap<string, readonly Hold[]>;
  /** The sessions whose agent works in each target: bound, daemon running. */
  working: ReadonlyMap<string, readonly string[]>;
  /** Every session bound to each target, its daemon running or not: who
   * opened an agent's window. */
  bound: ReadonlyMap<string, readonly string[]>;
}>;

export const noHolds: Holds = Object.freeze({
  holders: new Map(),
  working: new Map(),
  bound: new Map(),
});

/** What the files said at their last reading, by file name (root decision
 * 0191 point 32, which changes F47 point 5): a holder file that cannot be
 * read keeps holding what it held then, and only that, and a binding that
 * cannot be read keeps its tab. A file never read holds nothing. */
export type HoldsMemory = Readonly<{
  holders: ReadonlyMap<string, HolderReading>;
  /** Each session's target id, by its binding's file name. */
  bindings: ReadonlyMap<string, string>;
}>;

export const noHoldsMemory: HoldsMemory = Object.freeze({
  holders: new Map(),
  bindings: new Map(),
});

/** What one holder file holds. */
export type HolderReading = Readonly<{
  strip: string;
  label: string;
  tabs: readonly string[];
}>;

/** One reading of both directories: the holds, what the next reading
 * remembers, and the files this one could not read. */
export type HoldsReading = Readonly<{
  holds: Holds;
  memory: HoldsMemory;
  /** Holder files (`<strip>.json`) and bindings (`<session>.target`). */
  unreadable: readonly string[];
  /** Every holder file and binding there was at this reading, read or not:
   * one missing here is gone. */
  present: readonly string[];
}>;

/** A strip's name is a file name: agent-browser's session alphabet, as T3
 * Code's `t3-<thread>` and the Launchpad's `launchpad` are. */
const stripPattern = /^[A-Za-z0-9_-]{1,64}$/;
const targetIdPattern = /^[0-9A-Fa-f]{32}$/;
const maxHolderBytes = 64 * 1024;
const maxTabsPerHolder = 500;
const maxLabelLength = 200;

export function isStrip(value: unknown): value is string {
  return typeof value === "string" && stripPattern.test(value);
}

/** `$XDG_RUNTIME_DIR/lazurio-browser/holders`, where the apps' servers write
 * their holds; undefined without an absolute runtime directory. */
export function holderDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "lazurio-browser", "holders")
    : undefined;
}

/** `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json`: the hub's list of the
 * browser's live page targets, which every app's server reconciles its holds
 * with (F47 point 4). */
export function liveTabsPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "lazurio-browser", "tabs.json")
    : undefined;
}

/** A time on the Environment's boot clock (F47 point 4): the boot's id and
 * the seconds since it. Unlike the wall clock it never steps back, and every
 * process of the Environment reads the same one, so it orders an app's record
 * against the hub's snapshot. */
export type BootTime = Readonly<{ boot: string; at: number }>;

const bootIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads the boot clock: `/proc/sys/kernel/random/boot_id` and the first
 * number of `/proc/uptime` (CLOCK_BOOTTIME). Null where there is none: not
 * Linux, where no Environment browser runs. */
export async function readBootClock(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<BootTime | null> {
  try {
    const boot = (await read("/proc/sys/kernel/random/boot_id")).trim();
    const at = Number.parseFloat(
      (await read("/proc/uptime")).trim().split(/\s+/)[0] ?? "",
    );
    return bootIdPattern.test(boot) && Number.isFinite(at) && at >= 0
      ? { boot, at }
      : null;
  } catch {
    return null;
  }
}

/** A boot-clock time as it is stored, or null when the value is not one. */
export function parseBootTime(value: unknown): BootTime | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.boot === "string" &&
    bootIdPattern.test(record.boot) &&
    typeof record.at === "number" &&
    Number.isFinite(record.at) &&
    record.at >= 0
    ? { boot: record.boot, at: record.at }
    : null;
}

/** A stored tab of an app with the boot-clock time it recorded the tab, or
 * null for a tab without one, which counts as recorded long ago (F47 point
 * 4). */
export type RecordedTab = Readonly<{ id: string; recordedAt: BootTime | null }>;

/** One snapshot of the browser's page targets: `takenAt` is the boot-clock
 * time the hub began it, before it asked the browser. */
export type LiveTabs = Readonly<{ tabs: readonly string[]; takenAt: BootTime }>;

/** Replaces one file of `lazurio-browser` atomically and owner-only (F47
 * point 4): a temporary file of mode 0600 renamed over it, so a reader sees
 * the old text or the new one, never a part. Its directory is made with mode
 * 0700 when missing. */
export async function replaceOwnerFile(
  path: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Writes the list atomically: a reader sees the old list or the new one. */
export async function writeLiveTabs(
  path: string,
  tabs: readonly string[],
  takenAt: BootTime,
): Promise<void> {
  await replaceOwnerFile(path, `${JSON.stringify({ tabs, takenAt })}\n`);
}

/** The list a reader finds, or null when the file is not one. */
export function parseLiveTabs(text: string): LiveTabs | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const takenAt = parseBootTime(record.takenAt);
  if (!Array.isArray(record.tabs) || takenAt === null) return null;
  if (
    !record.tabs.every(
      (id): id is string => typeof id === "string" && targetIdPattern.test(id),
    )
  )
    return null;
  return {
    tabs: record.tabs.map((id) => (id as string).toUpperCase()),
    takenAt,
  };
}

/** An app's reconciliation (F47 point 4): the ids it keeps from its stored
 * ones, `boot` being the current boot. A list of another boot is ignored.
 * An id the list lacks goes when the list was taken after the app recorded
 * it: a snapshot lists every target that exists when it begins, so such an
 * id had ended by then, while a tab recorded after the snapshot began stays.
 * A record from an earlier boot, or without a time, is older than every list
 * of this boot. Without a list, or without the boot clock, it keeps
 * everything. */
export function keptTabs(
  stored: readonly RecordedTab[],
  list: LiveTabs | null,
  boot: string | null,
): string[] {
  if (list === null || boot === null || list.takenAt.boot !== boot)
    return stored.map((tab) => tab.id);
  const live = new Set(list.tabs);
  return stored
    .filter(
      (tab) =>
        live.has(tab.id.toUpperCase()) ||
        (tab.recordedAt !== null &&
          tab.recordedAt.boot === boot &&
          tab.recordedAt.at >= list.takenAt.at),
    )
    .map((tab) => tab.id);
}

/** The hold one holder file records, or null when the file is not one: its
 * `strip` must be its file name, and only target ids count. */
export function parseHolder(
  fileName: string,
  text: string,
): HolderReading | null {
  if (!fileName.endsWith(".json")) return null;
  const name = fileName.slice(0, -".json".length);
  if (!isStrip(name) || text.length > maxHolderBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.strip !== name || !Array.isArray(record.tabs)) return null;
  const label =
    typeof record.label === "string"
      ? record.label.trim().slice(0, maxLabelLength)
      : "";
  const tabs = [
    ...new Set(
      record.tabs
        .filter(
          (id): id is string =>
            typeof id === "string" && targetIdPattern.test(id),
        )
        .map((id) => id.toUpperCase()),
    ),
  ].slice(0, maxTabsPerHolder);
  return { strip: name, label, tabs };
}

/** The text of a holder file that also keeps each tab's record time,
 * `recordedAt`, by its id: the hub ignores it, and only the app that writes
 * the file reads it back (`parseHolderRecords`), so its reconciliation
 * survives a restart. A tab without a time has no entry. */
export function holderFileText(
  strip: string,
  label: string,
  tabs: readonly RecordedTab[],
): string {
  const recordedAt: Record<string, BootTime> = {};
  for (const tab of tabs)
    if (tab.recordedAt !== null)
      recordedAt[tab.id] = { boot: tab.recordedAt.boot, at: tab.recordedAt.at };
  return `${JSON.stringify({
    strip,
    label,
    tabs: tabs.map((tab) => tab.id),
    recordedAt,
  })}\n`;
}

/** A holder file with the record time of each of its tabs, or null when the
 * file is not a holder file (`parseHolder`'s rules). A tab whose time is
 * missing or not a boot-clock time has null. */
export function parseHolderRecords(
  fileName: string,
  text: string,
): Readonly<{
  strip: string;
  label: string;
  tabs: readonly RecordedTab[];
}> | null {
  const hold = parseHolder(fileName, text);
  if (hold === null) return null;
  const times = new Map<string, BootTime>();
  const stored = (JSON.parse(text) as Record<string, unknown>).recordedAt;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored))
    for (const [id, value] of Object.entries(stored)) {
      const at = parseBootTime(value);
      if (targetIdPattern.test(id) && at !== null)
        times.set(id.toUpperCase(), at);
    }
  return {
    strip: hold.strip,
    label: hold.label,
    tabs: hold.tabs.map((id) => ({ id, recordedAt: times.get(id) ?? null })),
  };
}

/** True while a process with this id runs (one of another user counts too,
 * as `kill -0` answers EPERM for it). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const add = (map: Map<string, string[]>, key: string, value: string) => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
};

/** True for "no such file or directory": the one read failure that means
 * nothing is there. */
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** A directory's names; one that does not exist is empty (no app wrote a
 * hold, no agent ran). Any other failure is thrown. */
async function names(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** A file's text; null when it is gone (removed between the listing and the
 * read). Any other failure is thrown. */
async function text(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** A file's text, null when it is gone, or "unreadable" for any other
 * failure: a permission, an I/O error. */
const textOf = (path: string) => text(path).catch(() => "unreadable" as const);

/** Reads both directories (F47 point 5 as root decision 0191 point 32
 * changes it). Only a directory or file that does not exist reads as holding
 * nothing. A directory that cannot be listed is thrown, so the hub keeps its
 * last reading and no tab ends. A file that cannot be read (a permission, an
 * I/O error) or is not a holder file stops the ending of its own tabs only:
 * it keeps holding what it held at its last reading in `memory`, the other
 * files count as they read now, and it is named in `unreadable`. A holder
 * file is replaced atomically by its app, so a broken one is a fault to see,
 * not a release. Names that are no strip's file (an app's temporary file)
 * are skipped. An agent-browser session counts as ended only when its `.pid`
 * is gone or names a well-formed process id that no longer runs; one that
 * cannot be read or understood (empty, signed, zero) counts as working,
 * which keeps its tab. */
export async function readHolds(
  directories: Readonly<{
    holders?: string | undefined;
    sockets?: string | undefined;
  }>,
  alive: (pid: number) => boolean = processAlive,
  memory: HoldsMemory = noHoldsMemory,
): Promise<HoldsReading> {
  const holders = new Map<string, Hold[]>();
  const working = new Map<string, string[]>();
  const bound = new Map<string, string[]>();
  const remembered = {
    holders: new Map<string, HolderReading>(),
    bindings: new Map<string, string>(),
  };
  const unreadable: string[] = [];
  const present: string[] = [];
  if (directories.holders !== undefined) {
    const directory = directories.holders;
    for (const name of await names(directory)) {
      if (!name.endsWith(".json") || !isStrip(name.slice(0, -".json".length)))
        continue;
      const content = await textOf(join(directory, name));
      if (content === null) continue;
      present.push(name);
      let hold = content === "unreadable" ? null : parseHolder(name, content);
      if (hold === null) {
        unreadable.push(name);
        hold = memory.holders.get(name) ?? null;
        if (hold === null) continue;
      }
      remembered.holders.set(name, hold);
      for (const id of hold.tabs) {
        const list = holders.get(id);
        const entry = { strip: hold.strip, label: hold.label };
        if (list === undefined) holders.set(id, [entry]);
        else list.push(entry);
      }
    }
  }
  if (directories.sockets !== undefined) {
    const directory = directories.sockets;
    for (const name of await names(directory)) {
      if (!name.endsWith(".target")) continue;
      const session = name.slice(0, -".target".length);
      if (!isStrip(session)) continue;
      const content = await textOf(join(directory, name));
      if (content === null) continue;
      present.push(name);
      let targetId: unknown;
      let read = content !== "unreadable";
      if (read)
        try {
          targetId = (JSON.parse(content) as { targetId?: unknown } | null)
            ?.targetId;
        } catch {
          read = false;
        }
      if (!read) {
        unreadable.push(name);
        targetId = memory.bindings.get(name);
      }
      if (typeof targetId !== "string" || !targetIdPattern.test(targetId))
        continue;
      const id = targetId.toUpperCase();
      remembered.bindings.set(name, id);
      add(bound, id, session);
      const pidText = await textOf(join(directory, `${session}.pid`));
      if (pidText === null) continue;
      // Only a well-formed process id proven ended releases the tab; an
      // unreadable, empty, signed or zero one is unclear, and unclear keeps
      // it.
      const digits = pidText === "unreadable" ? "" : pidText.trim();
      const pid = /^[0-9]{1,10}$/.test(digits) ? Number(digits) : Number.NaN;
      if (!(Number.isSafeInteger(pid) && pid >= 2) || alive(pid))
        add(working, id, session);
    }
  }
  return {
    holds: { holders, working, bound },
    memory: remembered,
    unreadable,
    present,
  };
}

/** The hub's reading of the holds: one reading at a time, each remembering
 * what the files it could read held, so a file that cannot be read keeps
 * holding what it held (root decision 0191 point 32). It logs when a file
 * becomes unreadable, and then whether it can be read again or is gone,
 * which lets go of what it held. A directory that cannot be listed is
 * thrown, as `readHolds` does. */
export function holdsReader(
  directories: Readonly<{
    holders?: string | undefined;
    sockets?: string | undefined;
  }>,
  options: Readonly<{
    alive?: (pid: number) => boolean;
    log?: (line: string) => void;
  }> = {},
): () => Promise<Holds> {
  let memory = noHoldsMemory;
  let reported: ReadonlySet<string> = new Set();
  let last: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Holds> => {
    const reading = await readHolds(directories, options.alive, memory);
    memory = reading.memory;
    const now = new Set(reading.unreadable);
    for (const name of now) {
      if (reported.has(name)) continue;
      const tabs = memory.holders.get(name)?.tabs.length;
      const kept = name.endsWith(".target")
        ? memory.bindings.has(name)
          ? "it keeps its tab"
          : "it was never read, so it binds no tab"
        : tabs !== undefined
          ? `it keeps the ${tabs === 1 ? "tab" : `${tabs} tabs`} it held when it was last read`
          : "it was never read, so it holds no tab";
      options.log?.(`${name} cannot be read: ${kept}; other files count`);
    }
    const present = new Set(reading.present);
    for (const name of reported)
      if (!now.has(name))
        options.log?.(
          present.has(name)
            ? `${name} can be read again`
            : `${name} is gone: it holds nothing now`,
        );
    reported = now;
    return reading.holds;
  };
  return () => {
    const next = last.then(read, read);
    last = next.catch(() => undefined);
    return next;
  };
}

/** The holder files that cannot be read or are not holder files, for
 * `lazurio doctor` (root decision 0191 point 32): their names, or the
 * directory itself when it cannot be listed. Empty without the directory. */
export async function unreadableHolderFiles(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const directory = holderDirectory(env);
  if (directory === undefined) return [];
  let found: string[];
  try {
    found = await names(directory);
  } catch {
    return [directory];
  }
  const failed: string[] = [];
  for (const name of found) {
    if (!name.endsWith(".json") || !isStrip(name.slice(0, -".json".length)))
      continue;
    const content = await textOf(join(directory, name));
    if (content === null) continue;
    if (content === "unreadable" || parseHolder(name, content) === null)
      failed.push(name);
  }
  return failed;
}

/** Calls `changed` whenever something in one of the directories changes.
 * A directory that does not exist yet is watched once it does: `retry` is
 * called by the hub on its periodic read. */
export function watchHolds(
  directories: readonly (string | undefined)[],
  changed: () => void,
): Readonly<{ retry: () => void; stop: () => void }> {
  const watchers = new Map<string, FSWatcher>();
  const retry = () => {
    for (const directory of directories) {
      if (directory === undefined || watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, () =>
          changed(),
        );
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(directory);
        });
        watchers.set(directory, watcher);
      } catch {}
    }
  };
  retry();
  return Object.freeze({
    retry,
    stop: () => {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  });
}
