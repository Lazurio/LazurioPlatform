import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  changeHolderFile,
  type HolderFile,
  holderDirectory,
  liveTabsPath,
  watchHolds,
} from "../../browser/contract/node";
import {
  type BootTime,
  browserTimes,
  isStrip,
  launchpadStrip,
  parseHolder,
  targetIdOf,
} from "../../browser/contract/pure";
import { embeddedIdentity } from "../../update/identity";

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
// everything. Times come from the boot clock only, never the wall clock. Each
// write is the contract's write of one strip's holder file
// (`changeHolderFile`, decision F50 point 1), which T3 Code's threads write
// too; this keeps the Launchpad's beat, watch and one operation at a time.

export const launchpadLabel = "Launchpad";

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
  const read = seams.readFile ?? ((file: string) => readFile(file, "utf8"));
  const file: HolderFile = {
    directory: seams.directory,
    strip: launchpadStrip,
    label: launchpadLabel,
    // The file names the Platform release whose contract module writes it,
    // this executable's (decision F50 point 3).
    contract: embeddedIdentity().version,
    bound: maxLaunchpadHolds,
    list: seams.listPath,
  };
  const log = seams.log ?? (() => undefined);
  const everyMs = seams.everyMs ?? browserTimes.holdsEveryMs;
  const debounceMs = seams.debounceMs ?? browserTimes.changesJoinMs;
  /** The tabs the file held at the last change, in the order they were
   * first recorded. Only `tabs()` answers from it; every change reads the
   * file again first (`changeHolderFile`). */
  let held: readonly string[] = [];
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

  /** One change of the file at the boot clock's time now: written, or
   * nothing to write. A file that cannot be read takes no change and is
   * never written over (`unreadable`); a hold past the bound is `full`. */
  async function change(
    what: Readonly<{ hold?: readonly string[]; release?: readonly string[] }>,
  ): Promise<"done" | "unreadable" | "full"> {
    const done = await changeHolderFile(
      file,
      what,
      await seams.bootClock(),
      read,
    );
    if (done.kind === "refused") return done.reason;
    held = done.tabs.map((tab) => tab.id);
    return "done";
  }

  /** A person's change: a file that cannot be read rejects it, journalled,
   * and a hold past the bound is `HolderFull`. */
  async function personal(
    what: Readonly<{ hold?: readonly string[]; release?: readonly string[] }>,
  ): Promise<void> {
    const done = await change(what);
    if (done === "full") throw new HolderFull();
    if (done === "unreadable") {
      log("holder-unreadable");
      throw new Error("The holder file cannot be read");
    }
  }

  // Never fails: the beat, a change and the start only journal it. A file
  // that cannot be read is left as it is.
  const reconcile = (): Promise<void> =>
    serialized(async () => {
      if (!stopped && (await change({})) !== "done")
        throw new Error("The holder file cannot be read");
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
      const tab = targetIdOf(id);
      if (tab === null) throw new Error("Invalid target id");
      await serialized(async () => {
        if (stopped) throw new Error("The Launchpad is closing");
        await personal({ hold: [tab] });
      });
    },
    async release(id: string) {
      const tab = targetIdOf(id);
      if (tab === null) throw new Error("Invalid target id");
      await serialized(async () => {
        if (stopped) throw new Error("The Launchpad is closing");
        await personal({ release: [tab] });
      });
    },
    reconcile,
    tabs: () => held,
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
