import { type FSWatcher, watch as watchDirectory } from "node:fs";
import { join } from "node:path";

// After a pull, the next open gets a build again (decision F58 point 7, root
// decision 0195 point 19): inside the Launchpad's own process, never a
// daemon of its own (F8). It watches the Git directories of the checkouts
// its built apps read (`HEAD` and `packed-refs` in the Git directory, and
// `refs/heads/`), and when one of them changed and stayed quiet for a while
// it asks for the app's refresh: a background build of the checkout as it
// is then (nothing when that key is built, or when its build failed), and a
// swap of what runs built from an older key. A sweep does the same for every
// app at the Launchpad's start and every few minutes, which also covers a
// change no event reported (a branch of nested refs, a watch the platform
// dropped). A refresh never runs twice at once for one app: a change during
// one runs it once more after it.

/** An app the Launchpad keeps built, with the Git directories its build
 * reads. */
export type WatchedApp = Readonly<{
  /** Its build directory: one app, one refresh at a time. */
  id: string;
  gitDirectories: readonly string[];
}>;

export type DirectoryWatch = (
  directory: string,
  changed: (name: string | null) => void,
) => Readonly<{ close: () => void }>;

/** `fs.watch` of one directory, non-recursive; a directory that cannot be
 * watched is left to the sweep. */
export const fsDirectoryWatch: DirectoryWatch = (directory, changed) => {
  let watcher: FSWatcher | null = null;
  try {
    watcher = watchDirectory(directory, { persistent: false }, (_event, name) =>
      changed(typeof name === "string" ? name : null),
    );
    watcher.on("error", () => watcher?.close());
  } catch {
    watcher = null;
  }
  return { close: () => watcher?.close() };
};

/** The files of a Git directory whose change means `HEAD` may have moved:
 * the ref it names (under `refs/heads/`), `HEAD` itself and `packed-refs`,
 * also as their lock files while Git writes them. */
const relevant = (name: string | null) =>
  name === null || /^(HEAD|packed-refs)(\.lock)?$/.test(name);

export const buildQuietMs = 5_000;
export const buildSweepMs = 300_000;

export function createBuildWatcher(input: {
  /** The apps to keep built now (read at every sweep). */
  apps: () => Promise<readonly WatchedApp[]>;
  /** Build the app's checkout if its key moved, and swap. */
  refresh: (app: WatchedApp) => Promise<void>;
  watch?: DirectoryWatch | undefined;
  quietMs?: number | undefined;
  sweepMs?: number | undefined;
}) {
  const watch = input.watch ?? fsDirectoryWatch;
  const quietMs = input.quietMs ?? buildQuietMs;
  const sweepMs = input.sweepMs ?? buildSweepMs;
  const apps = new Map<string, WatchedApp>();
  // One watch per directory, shared by the apps that read it.
  const watches = new Map<string, Readonly<{ close: () => void }>>();
  const quiet = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | null = null;
  // The apps added while a sweep reads the apps (a first open meanwhile):
  // kept when the sweep installs what it read, which may not list them.
  let addedDuringSweep: Map<string, WatchedApp> | null = null;
  let closed = false;

  function run(id: string) {
    if (closed) return;
    const app = apps.get(id);
    if (app === undefined) return;
    if (running.has(id)) {
      again.add(id);
      return;
    }
    const done = input
      .refresh(app)
      .catch(() => undefined)
      .finally(() => {
        running.delete(id);
        if (again.delete(id)) run(id);
      });
    running.set(id, done);
  }

  function changed(directory: string) {
    if (closed) return;
    for (const app of apps.values()) {
      if (
        !app.gitDirectories.some(
          (git) =>
            directory === git || directory === join(git, "refs", "heads"),
        )
      )
        continue;
      clearTimeout(quiet.get(app.id));
      quiet.set(
        app.id,
        setTimeout(() => {
          quiet.delete(app.id);
          run(app.id);
        }, quietMs),
      );
    }
  }

  function watchAll() {
    const wanted = new Set<string>();
    for (const app of apps.values())
      for (const git of app.gitDirectories) {
        wanted.add(git);
        wanted.add(join(git, "refs", "heads"));
      }
    for (const [directory, watcher] of watches)
      if (!wanted.has(directory)) {
        watcher.close();
        watches.delete(directory);
      }
    for (const directory of wanted)
      if (!watches.has(directory)) {
        const root = !directory.endsWith(join("refs", "heads"));
        watches.set(
          directory,
          watch(directory, (name) => {
            if (!root || relevant(name)) changed(directory);
          }),
        );
      }
  }

  async function sweep() {
    if (closed) return;
    const added = new Map<string, WatchedApp>();
    addedDuringSweep = added;
    let listed: readonly WatchedApp[];
    try {
      listed = await input.apps();
    } catch {
      return;
    } finally {
      addedDuringSweep = null;
    }
    if (closed) return;
    apps.clear();
    for (const app of added.values()) apps.set(app.id, app);
    for (const app of listed) apps.set(app.id, app);
    watchAll();
    for (const app of listed) run(app.id);
  }

  return Object.freeze({
    /** Watch one more app now (one that just started built), until the
     * next sweep reads them all again. */
    add(app: WatchedApp) {
      if (closed) return;
      apps.set(app.id, app);
      addedDuringSweep?.set(app.id, app);
      watchAll();
    },
    /** The first sweep, then one every few minutes. */
    start() {
      if (closed || timer !== undefined) return;
      void this.sweep();
      timer = setInterval(() => void this.sweep(), sweepMs);
      timer.unref?.();
    },
    /** Read the apps again, watch their checkouts and refresh each. A sweep
     * under way is joined. */
    sweep() {
      sweeping ??= sweep().finally(() => {
        sweeping = null;
      });
      return sweeping;
    },
    /** Resolves when no refresh runs and none waits for quiet. */
    async settled() {
      while (running.size > 0 || sweeping !== null)
        await Promise.all([sweeping, ...running.values()]);
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const pending of quiet.values()) clearTimeout(pending);
      quiet.clear();
      for (const watcher of watches.values()) watcher.close();
      watches.clear();
      again.clear();
      return Promise.all([...running.values()]).then(() => undefined);
    },
  });
}

export type BuildWatcher = ReturnType<typeof createBuildWatcher>;
