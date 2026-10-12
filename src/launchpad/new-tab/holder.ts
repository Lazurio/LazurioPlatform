import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  holderDirectory,
  liveTabsPath,
  replaceOwnerFile,
  watchHolds,
} from "../../browser/contract/node";
import {
  type BootTime,
  holderFileText,
  isStrip,
  keptTabs,
  parseHolder,
  parseHolderRecords,
  parseLiveTabs,
} from "../../browser/contract/pure";

// The Launchpad's own holder file (decision F47 point 4): the remote tabs a
// person opened in the Launchpad, from its Nová karta or as a page's new tab
// viewed there, which the view's hub keeps while the file lists them. It is
// `$XDG_RUNTIME_DIR/lazurio-browser/holders/launchpad.json`, which only this
// server replaces, atomically and owner-only. Beside the ids it keeps each
// tab's record time on the boot clock (`recordedAt`), so that after a restart
// the Launchpad still knows which lists of live tabs are newer than its
// records. It goes at a reboot with the runtime directory, as the tabs do.
//
// The Launchpad keeps its holds true to the browser: it reconciles them with
// the hub's list of live tabs (`tabs.json`) when it starts, whenever that file
// changes (watched, and read again every 30 s) and before each write, and
// drops only what `keptTabs` lets go: an id that a list of the current boot,
// taken after its record, lacks. A list that is missing or unreadable keeps
// everything. Times come from the boot clock only, never the wall clock.

export const launchpadStrip = "launchpad";
export const launchpadLabel = "Launchpad";
const fileName = `${launchpadStrip}.json`;

/** At most this many tabs, so the file stays well inside what the hub reads
 * of a holder file (64 KiB, `parseHolder`): a hold past it is refused, never
 * one dropped to make room. */
export const maxLaunchpadHolds = 256;

/** A hold refused at `maxLaunchpadHolds`. */
export class HolderFull extends Error {
  constructor() {
    super("The Launchpad holds as many tabs as it may");
  }
}

const targetIdPattern = /^[0-9A-Fa-f]{32}$/;

export type LaunchpadHolder = Readonly<{
  /** Reads the file, reconciles, then watches the list and reads it again
   * on its beat. */
  start: () => Promise<void>;
  /** Ends the watch and the beat once the operation under way is done. */
  stop: () => Promise<void>;
  /** Records the Launchpad's hold of a tab at the boot clock's time now and
   * writes the file before it resolves. `HolderFull` at the bound; a failed
   * write rejects and records nothing. */
  hold: (id: string) => Promise<void>;
  /** Lets go of the Launchpad's hold of a tab (× in its strip, F47 point 9's
   * addendum of 2026-10-12) and writes the file before it resolves, on the
   * same path as `hold`: one operation at a time, the file read again first,
   * nothing written over a file that cannot be read. A tab the file does not
   * hold is released already, and nothing is written for it. */
  release: (id: string) => Promise<void>;
  /** Reconciles with the list now, writing only when a hold went. */
  reconcile: () => Promise<void>;
  /** The held tabs, in the order they were first recorded. */
  tabs: () => readonly string[];
}>;

export type HolderSeams = Readonly<{
  /** `holders/`, where the file is. */
  directory: string;
  /** The hub's `tabs.json`; its directory is the one watched. */
  listPath: string;
  /** The boot clock (`readBootClock`); null off Linux. */
  bootClock: () => Promise<BootTime | null>;
  readFile?: ((path: string) => Promise<string>) | undefined;
  watch?: typeof watchHolds | undefined;
  /** The beat (30 s) and the wait that joins a burst of changes. */
  everyMs?: number | undefined;
  debounceMs?: number | undefined;
  log?: ((event: string) => void) | undefined;
}>;

export function createLaunchpadHolder(seams: HolderSeams): LaunchpadHolder {
  const path = join(seams.directory, fileName);
  const read = seams.readFile ?? ((file: string) => readFile(file, "utf8"));
  const log = seams.log ?? (() => undefined);
  const everyMs = seams.everyMs ?? 30_000;
  const debounceMs = seams.debounceMs ?? 100;
  /** What the file held at the last read: id → when the Launchpad recorded
   * it, null for a tab without a time. Only `tabs()` answers from it; every
   * operation that may write reads the file again first. */
  const records = new Map<string, BootTime | null>();
  // One operation at a time, so a write never carries an older state than
  // the one before it.
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let beat: ReturnType<typeof setInterval> | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watchHolds> | null = null;

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The file as it is now, read before every operation that may write it:
   * only a file that does not exist holds nothing. One that cannot be read,
   * or is not a holder file, throws, so the operation takes no hold and
   * writes nothing over it, which would drop the holds it keeps, until a
   * later read succeeds (F47 point 5's rule for the hub, kept by its writer
   * too). A read from earlier never stands in for the file. */
  async function current(): Promise<Map<string, BootTime | null>> {
    let text: string;
    try {
      text = await read(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
        return new Map();
      throw error;
    }
    const file = parseHolderRecords(fileName, text);
    if (file === null) throw new Error("unreadable holder file");
    return new Map(file.tabs.map((tab) => [tab.id, tab.recordedAt]));
  }

  /** The ids of `held` the hub's list lets go (`keptTabs`). */
  async function letGo(
    held: ReadonlyMap<string, BootTime | null>,
  ): Promise<string[]> {
    if (held.size === 0) return [];
    const text = await read(seams.listPath).catch(() => null);
    const list = text === null ? null : parseLiveTabs(text);
    if (list === null) return [];
    const boot = (await seams.bootClock())?.boot ?? null;
    const kept = new Set(
      keptTabs(
        [...held].map(([id, recordedAt]) => ({ id, recordedAt })),
        list,
        boot,
      ),
    );
    return [...held.keys()].filter((id) => !kept.has(id));
  }

  const write = (held: ReadonlyMap<string, BootTime | null>) =>
    replaceOwnerFile(
      path,
      holderFileText(
        launchpadStrip,
        launchpadLabel,
        [...held].map(([id, recordedAt]) => ({ id, recordedAt })),
      ),
    );

  /** What the file holds now, as `tabs()` answers it, after each read. */
  const remember = (held: ReadonlyMap<string, BootTime | null>) => {
    records.clear();
    for (const [id, recordedAt] of held) records.set(id, recordedAt);
  };

  // Never fails: the beat, a change and the start only journal it. A file
  // that cannot be read is left as it is.
  const reconcile = (): Promise<void> =>
    serialized(async () => {
      if (stopped) return;
      const held = await current();
      const gone = await letGo(held);
      for (const id of gone) held.delete(id);
      if (gone.length > 0) await write(held);
      remember(held);
    }).catch(() => log("holder-reconcile-failed"));

  const changed = () => {
    if (soon !== null || stopped) return;
    soon = setTimeout(() => {
      soon = null;
      void reconcile();
    }, debounceMs);
  };

  return Object.freeze({
    async start() {
      stopped = false;
      // The hub replaces `tabs.json` in `lazurio-browser`, which may not
      // exist yet: the beat watches it once it does.
      watcher = (seams.watch ?? watchHolds)([dirname(seams.listPath)], changed);
      beat = setInterval(() => {
        watcher?.retry();
        void reconcile();
      }, everyMs);
      await reconcile();
    },
    async stop() {
      stopped = true;
      if (beat !== null) clearInterval(beat);
      if (soon !== null) clearTimeout(soon);
      beat = null;
      soon = null;
      watcher?.stop();
      watcher = null;
      await queue;
    },
    async hold(id: string) {
      if (!targetIdPattern.test(id)) throw new Error("Invalid target id");
      const tab = id.toUpperCase();
      await serialized(async () => {
        if (stopped) throw new Error("The Launchpad is closing");
        let held: Map<string, BootTime | null>;
        try {
          held = await current();
        } catch {
          log("holder-unreadable");
          throw new Error("The holder file cannot be read");
        }
        const at = await seams.bootClock();
        for (const gone of await letGo(held)) held.delete(gone);
        if (!held.has(tab) && held.size >= maxLaunchpadHolds)
          throw new HolderFull();
        held.set(tab, at);
        await write(held);
        remember(held);
      });
    },
    async release(id: string) {
      if (!targetIdPattern.test(id)) throw new Error("Invalid target id");
      const tab = id.toUpperCase();
      await serialized(async () => {
        if (stopped) throw new Error("The Launchpad is closing");
        let held: Map<string, BootTime | null>;
        try {
          held = await current();
        } catch {
          log("holder-unreadable");
          throw new Error("The holder file cannot be read");
        }
        const gone = await letGo(held);
        for (const id of gone) held.delete(id);
        if (held.delete(tab) || gone.length > 0) await write(held);
        remember(held);
      });
    },
    reconcile,
    tabs: () => [...records.keys()],
  });
}

/** The Launchpad's holder for this process's runtime directory, or null
 * where there is none (`XDG_RUNTIME_DIR` unset or relative). */
export function launchpadHolderOf(
  runtimeDirectory: string | undefined,
  seams: Omit<HolderSeams, "directory" | "listPath">,
): LaunchpadHolder | null {
  const env = { XDG_RUNTIME_DIR: runtimeDirectory };
  const directory = holderDirectory(env);
  const listPath = liveTabsPath(env);
  return directory === undefined || listPath === undefined
    ? null
    : createLaunchpadHolder({ ...seams, directory, listPath });
}

/** The label of another strip's holder file (a T3 Code thread's title), or
 * null when it has none or the file is not one. */
export async function readHolderLabel(
  runtimeDirectory: string | undefined,
  strip: string,
  read: (path: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<string | null> {
  const directory = holderDirectory({ XDG_RUNTIME_DIR: runtimeDirectory });
  if (directory === undefined || !isStrip(strip)) return null;
  const text = await read(join(directory, `${strip}.json`)).catch(() => null);
  const label =
    text === null ? "" : (parseHolder(`${strip}.json`, text)?.label ?? "");
  return label === "" ? null : label;
}
