import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBuildWatcher,
  type DirectoryWatch,
  type WatchedApp,
} from "../src/modules/built/watcher";

// After a pull the Launchpad builds again (decision F58 point 7): the
// changes of a checkout's Git directory wait for quiet and become one
// refresh per app; a change during a refresh becomes exactly one more; the
// sweep reads the apps again and watches what they read now; nothing runs
// after shutdown. Then once with a real repository and `fs.watch`.
let root = "";
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "build-watcher-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeWatch() {
  const listeners = new Map<string, (name: string | null) => void>();
  const watch: DirectoryWatch = (directory, changed) => {
    listeners.set(directory, changed);
    return { close: () => listeners.delete(directory) };
  };
  return {
    watch,
    watched: () => [...listeners.keys()].sort(),
    emit: (directory: string, name: string | null) =>
      listeners.get(directory)?.(name),
  };
}

test("changes wait for quiet and become one refresh per app; a change during a refresh runs it once more; unrelated files are ignored", async () => {
  const files = fakeWatch();
  const web: WatchedApp = { id: "web", gitDirectories: ["/c/web/.git"] };
  const docs: WatchedApp = {
    id: "docs",
    gitDirectories: ["/c/docs/.git", "/c/docs/db/.git"],
  };
  const refreshed: string[] = [];
  let gate: (() => void) | null = null;
  const watcher = createBuildWatcher({
    apps: async () => [web, docs],
    refresh: async (app) => {
      refreshed.push(app.id);
      if (app.id === "web" && gate === null)
        await new Promise<void>((resolve) => {
          gate = resolve;
        });
    },
    watch: files.watch,
    quietMs: 40,
    sweepMs: 60_000,
  });
  await watcher.sweep();
  // The sweep refreshes every app and watches each Git directory and its
  // refs/heads.
  expect(files.watched()).toEqual([
    "/c/docs/.git",
    "/c/docs/.git/refs/heads",
    "/c/docs/db/.git",
    "/c/docs/db/.git/refs/heads",
    "/c/web/.git",
    "/c/web/.git/refs/heads",
  ]);
  expect(refreshed.sort()).toEqual(["docs", "web"]);
  refreshed.length = 0;
  // A pull of the data repository: a burst of events, one refresh.
  for (const name of ["packed-refs.lock", "packed-refs", "HEAD"])
    files.emit("/c/docs/db/.git", name);
  files.emit("/c/docs/db/.git/refs/heads", "main");
  // Git's other files are not a move of HEAD.
  files.emit("/c/web/.git", "FETCH_HEAD");
  files.emit("/c/web/.git", "index");
  await Bun.sleep(120);
  expect(refreshed).toEqual(["docs"]);
  // The web refresh from the sweep still runs (gated): two pulls meanwhile
  // become exactly one more refresh after it.
  files.emit("/c/web/.git/refs/heads", "main");
  await Bun.sleep(80);
  files.emit("/c/web/.git", "HEAD");
  await Bun.sleep(80);
  expect(refreshed).toEqual(["docs"]);
  (gate as unknown as () => void)();
  await watcher.settled();
  expect(refreshed).toEqual(["docs", "web"]);
  await watcher.close();
  files.emit("/c/docs/.git", "HEAD");
  await Bun.sleep(80);
  expect(refreshed).toEqual(["docs", "web"]);
  expect(files.watched()).toEqual([]);
});

test("each sweep reads the apps again: a new one is watched and refreshed, a gone one is no longer watched", async () => {
  const files = fakeWatch();
  let listed: WatchedApp[] = [{ id: "a", gitDirectories: ["/c/a/.git"] }];
  const refreshed: string[] = [];
  const watcher = createBuildWatcher({
    apps: async () => listed,
    refresh: async (app) => {
      refreshed.push(app.id);
    },
    watch: files.watch,
    quietMs: 20,
    sweepMs: 60_000,
  });
  await watcher.sweep();
  await watcher.settled();
  listed = [{ id: "b", gitDirectories: ["/c/b/.git"] }];
  await watcher.sweep();
  await watcher.settled();
  expect(refreshed).toEqual(["a", "b"]);
  expect(files.watched()).toEqual(["/c/b/.git", "/c/b/.git/refs/heads"]);
  files.emit("/c/a/.git", "HEAD");
  await Bun.sleep(60);
  expect(refreshed).toEqual(["a", "b"]);
  await watcher.close();
});

test("a real commit in a real checkout is noticed through fs.watch", async () => {
  const checkout = join(root, "site");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  execFileSync("git", ["init", "-q", "-b", "main", checkout]);
  await writeFile(join(checkout, "page.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "one");
  const gitDirectory = git("rev-parse", "--absolute-git-dir");
  let refreshes = 0;
  const watcher = createBuildWatcher({
    apps: async () => [{ id: "site", gitDirectories: [gitDirectory] }],
    refresh: async () => {
      refreshes++;
    },
    quietMs: 100,
    sweepMs: 60_000,
  });
  await watcher.sweep();
  await watcher.settled();
  expect(refreshes).toBe(1);
  await writeFile(join(checkout, "page.txt"), "two\n");
  git("commit", "-qam", "two");
  const deadline = Date.now() + 5000;
  while (refreshes < 2 && Date.now() < deadline) await Bun.sleep(50);
  await watcher.settled();
  expect(refreshes).toBe(2);
  await watcher.close();
});
