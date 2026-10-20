import { watch as watchDirectory } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Catalog,
  type CatalogOrganization,
  readFolderCatalog,
} from "../organizations/catalog";
import type {
  PersonalspaceHolder,
  PersonalspaceHolderRead,
} from "../organizations/personalspace";

// The Folder's catalog as this Launchpad last read it (root decision 0195,
// plan DEV-6656). The page's boot document, `/.lazurio/shell.json` on every
// page of Chat, Apps and Automate, `/api/catalog` and Apps' questions about
// one Organization each read every Organization and module manifest of the
// Folder again: on a Folder of seventeen Organizations and 146 modules about
// 150 ms of a workstation's time per read, and the page's first paint waited
// for it.
//
// So a reading is kept while nothing it depends on has changed, and the
// reads share it. What tells: a watch of each directory the reading found
// (the Folder, `organizations/`, each Organization's root, each module's
// directory and its parent, each app's package directory, each repository
// slot and its parent, and the Personalspace's the same), where any entry
// that is created, removed, renamed or written drops the reading; the
// Launchpad's own changes to the content drop it as well (`forget`), and so
// does another decision whose Personalspace this is. A change made while a
// reading runs means that reading is not kept. The system tells of a change
// a moment after it (on macOS some 10 to 30 ms): a read right after a write
// may still answer the reading before it.
//
// A change outside those directories (a dependency elsewhere in the
// Organization) has no watch: a kept reading older than a minute still
// answers, and is read anew behind it, so such a change shows from the read
// after that one. So does a reading that found a directory for the first
// time, which it watches only from then on. Where the Folder cannot be
// watched (a directory refused, a watch that fails, more directories than the
// bound) a reading is kept only a moment, for the reads of one page load.

/** How long a watched reading answers as it is; an older one answers once
 * more while it is read anew. */
export const catalogKeptMs = 60_000;

/** How long a reading answers where the Folder cannot be watched. */
export const catalogUnwatchedKeptMs = 2_000;

/** The most directories watched for one Folder. */
export const catalogWatchLimit = 2_000;

/** Watches one directory: `changed` on any change of an entry in it, `lost`
 * when the watch ends on its own. Throws where the directory cannot be
 * watched (`ENOENT` where it does not exist). */
export type DirectoryWatch = (
  directory: string,
  changed: () => void,
  lost: () => void,
) => { close(): void };

/** The operating system's watch (`fs.watch`, not recursive, never keeping
 * the process alive). */
export const osDirectoryWatch: DirectoryWatch = (directory, changed, lost) => {
  const watcher = watchDirectory(directory, { persistent: false }, () =>
    changed(),
  );
  watcher.on("error", () => {
    watcher.close();
    lost();
  });
  return watcher;
};

// What whose Personalspace this is says to the catalog: a reading of another
// decision is another reading.
const decisionKey = (decided: PersonalspaceHolder) =>
  decided.kind === "held"
    ? `held:${decided.login}:${decided.directory}`
    : decided.kind === "blocked"
      ? `blocked:${decided.reason}`
      : "absent";

// The directories a reading depends on, as far as a watch can tell.
function directoriesOf(
  folder: string,
  catalog: Catalog,
  decided: PersonalspaceHolder,
): Set<string> {
  const directories = new Set([
    folder,
    join(folder, "organizations"),
    join(folder, "personalspace"),
  ]);
  const group = (root: string, organization: CatalogOrganization) => {
    directories.add(root);
    for (const module of organization.modules) {
      const directory = join(root, module.path);
      directories.add(dirname(directory));
      directories.add(directory);
      for (const app of module.apps)
        directories.add(dirname(join(directory, app.package)));
    }
    for (const repository of organization.repositories) {
      const directory = join(root, repository.path);
      directories.add(dirname(directory));
      directories.add(directory);
    }
  };
  for (const organization of catalog.organizations)
    group(join(folder, "organizations", organization.directory), organization);
  if (decided.kind === "held" && catalog.personalspace !== undefined)
    group(decided.directory, catalog.personalspace);
  return directories;
}

export function createCatalogReading(
  folder: string,
  options: Readonly<{
    /** Whose Personalspace this Environment holds (#186): the Launchpad's
     * last decision, never waiting for GitHub. */
    holder: PersonalspaceHolderRead;
    read?: (
      folder: string,
      holder: PersonalspaceHolderRead,
    ) => Promise<Catalog>;
    /** Null: nothing is watched. */
    watch?: DirectoryWatch | null;
    now?: () => number;
    keepMs?: number;
    unwatchedKeepMs?: number;
    watchLimit?: number;
  }>,
) {
  const read = options.read ?? readFolderCatalog;
  const watch = options.watch === undefined ? osDirectoryWatch : options.watch;
  const now = options.now ?? Date.now;
  const keepMs = options.keepMs ?? catalogKeptMs;
  const unwatchedKeepMs = options.unwatchedKeepMs ?? catalogUnwatchedKeptMs;
  const watchLimit = options.watchLimit ?? catalogWatchLimit;
  type Kept = Readonly<{
    key: string;
    at: number;
    generation: number;
    catalog: Catalog;
    /** Every directory it found that exists is watched. */
    watched: boolean;
    /** And was watched for the whole of its reading: a directory it found
     * for the first time was not, so the next read reads anew behind it. */
    settled: boolean;
  }>;
  let kept: Kept | null = null;
  let running: Readonly<{
    key: string;
    generation: number;
    done: Promise<Catalog>;
  }> | null = null;
  // Every change seen moves it: a reading of an older generation is not
  // kept, and a kept one of an older generation does not answer.
  let generation = 0;
  let closed = false;
  const watchers = new Map<string, { close(): void }>();
  const changed = () => {
    generation += 1;
  };

  // Watches the directories of a reading and closes those it no longer
  // has: whether every one that exists is watched, and whether each was
  // already watched before.
  function arm(directories: Set<string>): {
    watched: boolean;
    settled: boolean;
  } {
    if (closed || watch === null || directories.size > watchLimit) {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      return { watched: false, settled: false };
    }
    for (const [directory, watcher] of watchers)
      if (!directories.has(directory)) {
        watcher.close();
        watchers.delete(directory);
      }
    let watched = true;
    let settled = true;
    for (const directory of directories) {
      if (watchers.has(directory)) continue;
      try {
        watchers.set(
          directory,
          watch(directory, changed, () => {
            // Lost: no longer told, so nothing kept stays current.
            watchers.delete(directory);
            changed();
          }),
        );
        settled = false;
      } catch (error) {
        // A directory that is not there is its parent's to tell about.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") watched = false;
      }
    }
    return { watched, settled };
  }

  function start(key: string, decided: PersonalspaceHolder): Promise<Catalog> {
    const asked = generation;
    const at = now();
    const done = read(folder, async () => decided)
      .then((catalog) => {
        const { watched, settled } = arm(
          directoriesOf(folder, catalog, decided),
        );
        if (asked === generation && !closed)
          kept = { key, at, generation: asked, catalog, watched, settled };
        return catalog;
      })
      .finally(() => {
        if (running?.done === done) running = null;
      });
    running = { key, generation: asked, done };
    return done;
  }

  return {
    /** The Folder's catalog: the kept reading while nothing it depends on
     * changed (once older than a minute, or found directories not watched
     * before, it answers and is read anew behind it; where the Folder is not
     * watched it answers only a moment), else the reading running now, else
     * a new one. */
    async read(): Promise<Catalog> {
      const decided = await options.holder(folder).catch(
        (): PersonalspaceHolder => ({
          kind: "blocked",
          reason: "personalspace-unavailable",
          login: null,
        }),
      );
      const key = decisionKey(decided);
      if (kept !== null && kept.key === key && kept.generation === generation) {
        const age = now() - kept.at;
        if (kept.watched ? kept.settled && age < keepMs : age < unwatchedKeepMs)
          return kept.catalog;
        if (kept.watched) {
          if (running === null) void start(key, decided).catch(() => undefined);
          return kept.catalog;
        }
      }
      if (
        running !== null &&
        running.key === key &&
        running.generation === generation
      )
        return running.done;
      return start(key, decided);
    },
    /** The content changed through this Launchpad: the next read reads anew. */
    forget() {
      changed();
      kept = null;
    },
    /** No more watches; what is kept is not answered again. */
    close() {
      closed = true;
      changed();
      kept = null;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

export type CatalogReading = ReturnType<typeof createCatalogReading>;

/** The catalog without its Personalspace group: what the routes that ask
 * about one Organization read (owner, maintainer, prompts), as a reader that
 * cannot ask GitHub would. */
export function organizationsOnly(catalog: Catalog): Catalog {
  return Object.freeze({
    kind: "catalog",
    organizations: catalog.organizations,
  });
}
