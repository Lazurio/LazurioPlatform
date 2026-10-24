import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { runContentCommand } from "../src/content/cli";
import { processContentGit } from "../src/content/git";
import type { ContentHost } from "../src/content/host";
import { tryContentLock } from "../src/content/lock";
import {
  readSyncRecord,
  type SyncEntry,
  type SyncHost,
  type SyncProgress,
  syncContent,
  syncFindings,
  syncScope,
} from "../src/content/sync";
import { syncChecks } from "../src/doctor/doctor";
import { messages } from "../src/launchpad/messages";
import { moduleStatusView } from "../src/launchpad/module-view";
import type { ModuleAnswer } from "../src/modules/module-operations";
import { runTool } from "../src/tools/status";
import type { CliContext } from "../src/update/cli";
import { type Slot, writeModule } from "./fixtures/catalog-folder";
import {
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
  writeOrganizationRoot,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// Synchronization of existing repositories (decision F9's amendment of
// 2026-10-24, docs/content-sync.md "Existing repositories"): real git over
// bare remotes in a temporary world reached as `git@github.com:<owner>/…`
// through git's own `insteadOf`, clones in a workstation Folder, synthetic
// names only.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function git(cwd: string, ...args: string[]) {
  const result = await runChild(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: cwd,
        GIT_EDITOR: "true",
        ...(world?.gitEnv ?? {}),
      },
    },
  );
  return { ...result, stdout: result.stdout.trim() };
}

async function ok(cwd: string, ...args: string[]) {
  const result = await git(cwd, ...args);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** A new commit on `branch` of the bare remote `fullName`, written by
 * `write` in a scratch clone; its commit. */
async function advance(
  current: World,
  fullName: string,
  write: (directory: string) => Promise<void>,
  branch = "main",
) {
  const work = await mkdtemp(join(current.root, "advance-"));
  await ok(
    current.root,
    "clone",
    "--quiet",
    "--branch",
    branch,
    `git@github.com:${fullName}.git`,
    work,
  );
  await write(work);
  await ok(work, "add", "--all");
  await ok(work, "commit", "--quiet", "--allow-empty", "-m", "advance");
  await ok(work, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
  const commit = await ok(work, "rev-parse", "HEAD");
  await rm(work, { recursive: true, force: true });
  return commit;
}

const head = (directory: string) => ok(directory, "rev-parse", "HEAD");

/** Every byte of a checkout that synchronization may not change: its refs
 * (with or without the remote-tracking ones), `HEAD`, its index entries
 * and every file of its working tree. */
async function snapshot(directory: string, remotes = true) {
  const refs = await ok(
    directory,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  );
  const files: string[] = [];
  const walk = async (path: string, relative: string) => {
    for (const name of (await readdir(path)).sort()) {
      if (relative === "" && name === ".git") continue;
      const full = join(path, name);
      const stat = await lstat(full);
      if (stat.isDirectory()) await walk(full, `${relative}${name}/`);
      else
        files.push(
          `${relative}${name} ${createHash("sha256")
            .update(await readFile(full))
            .digest("hex")}`,
        );
    }
  };
  await walk(directory, "");
  return {
    refs: refs
      .split("\n")
      .filter((line) => remotes || !line.startsWith("refs/remotes/")),
    head: await readFile(join(directory, ".git", "HEAD"), "utf8"),
    index: await ok(
      directory,
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--stage",
    ),
    files,
  };
}

const slot = (path: string, repository: string, extra = {}): Slot => ({
  path,
  slug: path.split("/").at(-1) as string,
  git: { url: `git@github.com:${repository}.git`, branch: "main" },
  ...extra,
});

type Fixture = Readonly<{
  folder: string;
  root: string;
  host: SyncHost;
  at: (path: string) => string;
}>;

/** The Organization `alpha` (login `Alpha`) in a workstation Folder: its
 * root and every declared child cloned as an installation leaves them.
 * `modules` are extra workspace modules (`workspace/<name>`, repository
 * `Alpha/<name>`). */
async function organization(
  current: World,
  options: Readonly<{
    modules?: readonly string[];
    extraSlots?: readonly Slot[];
    gitEnv?: Record<string, string>;
    timeoutMs?: number;
  }> = {},
): Promise<Fixture> {
  const modules = ["web", ...(options.modules ?? [])];
  const slots: Slot[] = [
    ...modules.map((name) => slot(`workspace/${name}`, `Alpha/${name}`)),
    slot("mission-control", "Alpha/mission-control"),
    {
      path: "mission-control/db",
      slug: "mission-control-db",
      materialization: "repository_db_mount",
      git: {
        url: "git@github.com:Alpha/mission-control-data.git",
        branch: "v3",
      },
    },
    slot("productionspace/firmware", "Alpha/firmware"),
    slot("infra", "Alpha/infra"),
    ...(options.extraSlots ?? []),
  ];
  await remoteRepository(current, "Alpha/alpha_GEN3", async (directory) => {
    await writeOrganizationRoot(directory, {
      slug: "alpha",
      forge: "Alpha",
      slots,
      root: "Alpha/alpha_GEN3",
    });
    await writeFile(
      join(directory, ".gitignore"),
      "workspace/\nproductionspace/\nmission-control/\ninfra/\n.worktrees/\n",
    );
  });
  for (const name of [...modules, "mission-control"])
    await remoteRepository(current, `Alpha/${name}`, async (directory) => {
      await writeModule(directory, "alpha", { id: name });
      await writeFile(join(directory, ".gitignore"), "db/\n");
      await writeFile(join(directory, "a.txt"), "1\n");
    });
  await remoteRepository(
    current,
    "Alpha/mission-control-data",
    (directory) => writeFile(join(directory, "data.json"), "{}\n"),
    "v3",
  );
  for (const name of ["firmware", "infra"])
    await remoteRepository(current, `Alpha/${name}`, (directory) =>
      writeFile(join(directory, "README.md"), name),
    );
  const folder = await presetFolder(current, "local");
  const root = join(folder, "organizations", "alpha_GEN3");
  const clone = async (repository: string, path: string, branch = "main") =>
    ok(
      folder,
      "clone",
      "--quiet",
      "--branch",
      branch,
      `git@github.com:${repository}.git`,
      path,
    );
  await clone("Alpha/alpha_GEN3", root);
  for (const name of modules)
    await clone(`Alpha/${name}`, join(root, "workspace", name));
  await clone("Alpha/mission-control", join(root, "mission-control"));
  await clone(
    "Alpha/mission-control-data",
    join(root, "mission-control", "db"),
    "v3",
  );
  await clone("Alpha/firmware", join(root, "productionspace", "firmware"));
  await clone("Alpha/infra", join(root, "infra"));
  const { github } = stubGitHub(current);
  const host: SyncHost = {
    github,
    git: processContentGit({
      path: Bun.env.PATH,
      home: current.home,
      platform: process.platform,
      run: runTool,
      env: { ...current.gitEnv, ...(options.gitEnv ?? {}) },
    }),
    lockDirectory: current.lockDirectory,
  };
  return { folder, root, host, at: (path) => join(root, path) };
}

const byPath = (entries: readonly SyncEntry[]) =>
  Object.fromEntries(
    entries.map((entry) => [
      entry.path,
      entry.reason === undefined
        ? entry.result
        : `${entry.result}:${entry.reason}`,
    ]),
  );

const ran = async (fixture: Fixture, request = {}) => {
  const run = await syncContent(fixture.folder, fixture.host, request);
  if (run.kind !== "content-sync") throw new Error(JSON.stringify(run));
  return run;
};

posixTest(
  "a clean checkout that is behind is fast-forwarded to exactly the commit its remote has, a data mount on its declared branch, and an equal one is current",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    const webBefore = await head(fixture.at("workspace/web"));
    const web = await advance(world, "Alpha/web", (directory) =>
      writeFile(join(directory, "a.txt"), "2\n"),
    );
    const data = await advance(
      world,
      "Alpha/mission-control-data",
      (directory) => writeFile(join(directory, "data.json"), '{"a":1}\n'),
      "v3",
    );
    const run = await ran(fixture);
    expect(byPath(run.entries)).toEqual({
      ".": "current",
      "workspace/web": "fast-forwarded",
      "mission-control": "current",
      "mission-control/db": "fast-forwarded",
    });
    const entry = run.entries.find((e) => e.path === "workspace/web");
    expect(entry).toMatchObject({
      organization: "Alpha",
      root: "organizations/alpha_GEN3",
      kind: "module",
      branch: "main",
      from: webBefore,
      to: web,
    });
    expect(await head(fixture.at("workspace/web"))).toBe(web);
    expect(await readFile(fixture.at("workspace/web/a.txt"), "utf8")).toBe(
      "2\n",
    );
    expect(await ok(fixture.at("workspace/web"), "status", "--porcelain")).toBe(
      "",
    );
    // The data mount stays on its branch, at its remote's commit.
    expect(
      run.entries.find((e) => e.path === "mission-control/db"),
    ).toMatchObject({ kind: "data", branch: "v3", to: data });
    expect(
      await ok(
        fixture.at("mission-control/db"),
        "symbolic-ref",
        "--short",
        "HEAD",
      ),
    ).toBe("v3");
    expect(await head(fixture.at("mission-control/db"))).toBe(data);
    // The remote-tracking ref follows too, so `git status` reads true.
    expect(
      await ok(fixture.at("workspace/web"), "rev-parse", "origin/main"),
    ).toBe(web);
    // Again: everything current, nothing changes.
    const before = await snapshot(fixture.at("workspace/web"));
    const again = await ran(fixture);
    expect(new Set(again.entries.map((e) => e.result))).toEqual(
      new Set(["current"]),
    );
    expect(await snapshot(fixture.at("workspace/web"))).toEqual(before);
    // The record says the same, and the doctor finds nothing.
    const record = await readSyncRecord(world.lockDirectory, fixture.folder);
    expect(record?.map((e) => e.result)).toEqual(
      again.entries.map((e) => e.result),
    );
    expect(syncChecks(record, true, new Date())).toEqual([
      { id: "content-sync", outcome: "ok", context: { organizations: 1 } },
    ]);
  },
  60_000,
);

posixTest(
  "a checkout's own core.fsmonitor program never runs: not for a checkout on another branch, not for a dirty one, not for a fast-forward (Pablo's review of #620)",
  async () => {
    world = await createWorld();
    const root = world.root;
    const fixture = await organization(world, { modules: ["dirty", "other"] });
    const marker = join(root, "fsmonitor-ran");
    // A program that, if Git ran it, would leave a marker and change the
    // checkout's tracked file a.txt.
    const monitor = async (name: string) => {
      const directory = fixture.at(`workspace/${name}`);
      const script = join(root, `fsmonitor-${name}.sh`);
      await writeFile(
        script,
        `#!/bin/sh\necho ${name} >> '${marker}'\nprintf 'changed\\n' >> '${join(directory, "a.txt")}'\nexit 1\n`,
      );
      await chmod(script, 0o755);
      await ok(directory, "config", "core.fsmonitor", script);
      return directory;
    };
    const web = await advance(world, "Alpha/web", (directory) =>
      writeFile(join(directory, "a.txt"), "2\n"),
    );
    const behind = await monitor("web");
    const dirty = await monitor("dirty");
    await writeFile(join(dirty, "draft.txt"), "draft\n");
    await ok(fixture.at("workspace/other"), "switch", "--quiet", "-c", "other");
    const other = await monitor("other");
    const before = {
      dirty: await snapshot(dirty),
      other: await snapshot(other),
    };
    // Only the synchronization's own Git commands from here on.
    await rm(marker, { force: true });
    const run = await ran(fixture);
    const ranMonitor = await lstat(marker).then(
      () => true,
      () => false,
    );
    expect(byPath(run.entries)).toMatchObject({
      "workspace/web": "fast-forwarded",
      "workspace/dirty": "blocked:dirty",
      "workspace/other": "blocked:wrong-branch",
    });
    // Git never ran any of the three programs.
    expect(ranMonitor).toBe(false);
    expect(await snapshot(dirty)).toEqual(before.dirty);
    expect(await snapshot(other)).toEqual(before.other);
    expect(await head(behind)).toBe(web);
    expect(await readFile(join(behind, "a.txt"), "utf8")).toBe("2\n");
  },
  60_000,
);

posixTest(
  "dirty tracked, untracked, another branch, ahead, diverged, detached and every operation in progress are blocked, and the checkout stays byte for byte as it was",
  async () => {
    world = await createWorld();
    const cases = [
      "dirty",
      "untracked",
      "branch",
      "ahead",
      "diverged",
      "detached",
      "merge",
      "rebase",
      "cherry",
      "revert",
      "bisect",
      "am",
    ];
    // Each module's remote main: a=1, a=2, a=3, and a side branch from the
    // first commit with a=x, so that every operation can stop in conflict.
    const fixture = await organization(world, { modules: cases });
    for (const name of cases) {
      const repository = `Alpha/${name}`;
      await advance(world, repository, (d) =>
        writeFile(join(d, "a.txt"), "2\n"),
      );
      await advance(world, repository, (d) =>
        writeFile(join(d, "a.txt"), "3\n"),
      );
      const work = await mkdtemp(join(world.root, "side-"));
      await ok(
        world.root,
        "clone",
        "--quiet",
        `git@github.com:${repository}.git`,
        work,
      );
      await ok(work, "checkout", "--quiet", "-b", "side", "HEAD~2");
      await writeFile(join(work, "a.txt"), "x\n");
      await ok(work, "commit", "--quiet", "-am", "side");
      await ok(work, "push", "--quiet", "origin", "side");
      await rm(work, { recursive: true, force: true });
      const checkout = fixture.at(`workspace/${name}`);
      await ok(checkout, "fetch", "--quiet", "origin");
      await ok(checkout, "merge", "--quiet", "--ff-only", "origin/main");
    }
    const at = (name: string) => fixture.at(`workspace/${name}`);
    await writeFile(join(at("dirty"), "a.txt"), "local\n");
    await writeFile(join(at("untracked"), "new.txt"), "local\n");
    await ok(at("branch"), "checkout", "--quiet", "-b", "feature");
    await writeFile(join(at("ahead"), "a.txt"), "mine\n");
    await ok(at("ahead"), "commit", "--quiet", "-am", "mine");
    await writeFile(join(at("diverged"), "a.txt"), "mine\n");
    await ok(at("diverged"), "commit", "--quiet", "-am", "mine");
    await ok(at("detached"), "checkout", "--quiet", "--detach", "HEAD");
    await git(at("merge"), "merge", "--no-ff", "--no-commit", "origin/side");
    await git(at("rebase"), "rebase", "origin/side");
    await git(at("cherry"), "cherry-pick", "origin/side");
    await git(at("revert"), "revert", "--no-edit", "HEAD~1");
    await ok(at("bisect"), "bisect", "start");
    const patch = await ok(
      at("am"),
      "format-patch",
      "-1",
      "origin/side",
      "-o",
      world.root,
    );
    await git(at("am"), "am", patch);
    // Each published branch moves on, except ahead's: a fast-forward would
    // be due everywhere else.
    for (const name of cases)
      if (name !== "ahead")
        await advance(world, `Alpha/${name}`, (d) =>
          writeFile(join(d, "b.txt"), "next\n"),
        );
    const before = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
    for (const name of cases)
      before.set(name, await snapshot(at(name), name !== "diverged"));
    const run = await ran(fixture);
    const results = byPath(run.entries);
    expect(
      Object.fromEntries(
        cases.map((name) => [name, results[`workspace/${name}`]]),
      ),
    ).toEqual({
      dirty: "blocked:dirty",
      untracked: "blocked:dirty",
      branch: "blocked:wrong-branch",
      ahead: "blocked:ahead",
      diverged: "blocked:diverged",
      detached: "blocked:detached",
      merge: "blocked:operation-in-progress",
      rebase: "blocked:operation-in-progress",
      cherry: "blocked:operation-in-progress",
      revert: "blocked:operation-in-progress",
      bisect: "blocked:operation-in-progress",
      am: "blocked:operation-in-progress",
    });
    // Byte for byte; only a diverged checkout's remote-tracking ref moved,
    // by the fetch that showed it diverged.
    for (const name of cases)
      expect({
        name,
        ...(await snapshot(at(name), name !== "diverged")),
      }).toEqual({
        name,
        ...(before.get(name) as Awaited<ReturnType<typeof snapshot>>),
      });
    // The doctor names each blocked checkout with its reason and place.
    const checks = syncChecks(
      await readSyncRecord(world.lockDirectory, fixture.folder),
      true,
      new Date(),
    );
    expect(checks).toContainEqual({
      id: "content-sync",
      outcome: "warn",
      reason: "sync-dirty",
      context: { organization: "Alpha", file: "workspace/dirty" },
    });
    expect(checks.filter((check) => check.outcome === "warn")).toHaveLength(
      cases.length,
    );
  },
  120_000,
);

posixTest(
  "a remote that refuses this identity or does not answer leaves the checkout as it was",
  async () => {
    world = await createWorld();
    // `slow`'s remote is reached over SSH by an SSH command that never
    // answers; the run's bound for one repository ends it.
    const fixture = await organization(world, {
      modules: ["gone", "slow"],
      gitEnv: { GIT_SSH_COMMAND: "sleep 30 #" },
    });
    await advance(world, "Alpha/gone", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    await advance(world, "Alpha/slow", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    await rename(
      join(world.remotes, "Alpha", "gone.git"),
      join(world.remotes, "Alpha", "moved.git"),
    );
    await ok(
      fixture.at("workspace/slow"),
      "config",
      "url.ssh://git@unreachable.example.invalid/slow.git.insteadOf",
      "git@github.com:Alpha/slow.git",
    );
    const gone = await snapshot(fixture.at("workspace/gone"));
    const slow = await snapshot(fixture.at("workspace/slow"));
    const started = Date.now();
    const run = await ran(fixture, { timeoutMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(20_000);
    const results = byPath(run.entries);
    expect(results["workspace/gone"]).toBe("denied:repository-denied");
    expect(results["workspace/slow"]).toBe("unavailable:remote-unavailable");
    // A sibling is never stopped by them.
    expect(results["workspace/web"]).toBe("current");
    expect(await snapshot(fixture.at("workspace/gone"))).toEqual(gone);
    expect(await snapshot(fixture.at("workspace/slow"))).toEqual(slow);
    // The doctor names it only once it lasts: a day later.
    const record = await readSyncRecord(world.lockDirectory, fixture.folder);
    expect(
      syncChecks(record, true, new Date()).every((c) => c.outcome === "ok"),
    ).toBe(true);
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(
      syncFindings(record ?? [], later).map((entry) => entry.path),
    ).toEqual(["workspace/gone", "workspace/slow"]);
  },
  60_000,
);

posixTest(
  "the root first: its children come from its new declaration (present ones synchronized, absent ones never cloned), and a blocked root stops its Organization",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    // The root's next commit declares two more modules: one already in the
    // Folder, one not.
    await remoteRepository(world, "Alpha/fresh", (d) =>
      writeModule(d, "alpha", { id: "fresh" }),
    );
    await remoteRepository(world, "Alpha/later", (d) =>
      writeModule(d, "alpha", { id: "later" }),
    );
    await ok(
      fixture.folder,
      "clone",
      "--quiet",
      "git@github.com:Alpha/fresh.git",
      fixture.at("workspace/fresh"),
    );
    const fresh = await advance(world, "Alpha/fresh", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    const root = await advance(world, "Alpha/alpha_GEN3", (directory) =>
      writeOrganizationRoot(directory, {
        slug: "alpha",
        forge: "Alpha",
        root: "Alpha/alpha_GEN3",
        slots: [
          slot("workspace/web", "Alpha/web"),
          slot("workspace/fresh", "Alpha/fresh"),
          slot("workspace/later", "Alpha/later"),
          slot("mission-control", "Alpha/mission-control"),
        ],
      }).then(() =>
        writeFile(
          join(directory, ".gitignore"),
          "workspace/\nproductionspace/\nmission-control/\ninfra/\n.worktrees/\n",
        ),
      ),
    );
    const run = await ran(fixture);
    expect(run.entries[0]).toMatchObject({
      path: ".",
      kind: "root",
      result: "fast-forwarded",
      to: root,
    });
    expect(byPath(run.entries)).toEqual({
      ".": "fast-forwarded",
      "workspace/web": "current",
      "workspace/fresh": "fast-forwarded",
      "workspace/later": "absent",
      "mission-control": "current",
    });
    expect(await head(fixture.at("workspace/fresh"))).toBe(fresh);
    expect(
      await lstat(fixture.at("workspace/later")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);

    // A dirty root stops the Organization: its behind children stay.
    const web = await head(fixture.at("workspace/web"));
    await advance(world, "Alpha/web", (d) =>
      writeFile(join(d, "a.txt"), "9\n"),
    );
    await writeFile(join(fixture.root, "notes.txt"), "local\n");
    const blocked = await ran(fixture);
    expect(byPath(blocked.entries)).toEqual({ ".": "blocked:dirty" });
    expect(await head(fixture.at("workspace/web"))).toBe(web);
  },
  60_000,
);

posixTest(
  "a data mount with a draft is left as it is, and Production Space, infra, worktrees and the Personalspace are never touched",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    // A draft in the data app's working tree.
    await writeFile(
      join(fixture.at("mission-control/db"), "data.json"),
      '{"draft":1}\n',
    );
    await advance(
      world,
      "Alpha/mission-control-data",
      (d) => writeFile(join(d, "other.json"), "{}\n"),
      "v3",
    );
    for (const name of ["firmware", "infra", "web"])
      await advance(world, `Alpha/${name}`, (d) =>
        writeFile(join(d, "n.txt"), "n\n"),
      );
    // A worktree of the module, on its own branch, behind too.
    const worktree = join(fixture.root, ".worktrees", "web-task");
    await ok(
      fixture.at("workspace/web"),
      "worktree",
      "add",
      "--quiet",
      "-b",
      "task",
      worktree,
      "HEAD",
    );
    // The Personalspace of a workstation, behind its remote.
    await remoteRepository(world, "example/example_GEN3", (d) =>
      writeFile(join(d, "README.md"), "mine"),
    );
    const personal = join(fixture.folder, "personalspace", "example_GEN3");
    await mkdir(join(fixture.folder, "personalspace"), { recursive: true });
    await ok(
      fixture.folder,
      "clone",
      "--quiet",
      "git@github.com:example/example_GEN3.git",
      personal,
    );
    await advance(world, "example/example_GEN3", (d) =>
      writeFile(join(d, "n.txt"), "n\n"),
    );
    const untouched = {
      data: await snapshot(fixture.at("mission-control/db")),
      firmware: await snapshot(fixture.at("productionspace/firmware")),
      infra: await snapshot(fixture.at("infra")),
      worktree: await ok(worktree, "rev-parse", "HEAD"),
      personal: await snapshot(personal),
    };
    const run = await ran(fixture);
    expect(byPath(run.entries)).toEqual({
      ".": "current",
      "workspace/web": "fast-forwarded",
      "mission-control": "current",
      "mission-control/db": "blocked:dirty",
    });
    expect({
      data: await snapshot(fixture.at("mission-control/db")),
      firmware: await snapshot(fixture.at("productionspace/firmware")),
      infra: await snapshot(fixture.at("infra")),
      worktree: await ok(worktree, "rev-parse", "HEAD"),
      personal: await snapshot(personal),
    }).toEqual(untouched);
    expect(await ok(worktree, "symbolic-ref", "--short", "HEAD")).toBe("task");
  },
  60_000,
);

posixTest(
  "while an install holds the content lock the synchronization is busy and changes nothing",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    const before = await head(fixture.at("workspace/web"));
    await advance(world, "Alpha/web", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    const lock = await tryContentLock(world.lockDirectory, fixture.folder);
    try {
      expect(await syncContent(fixture.folder, fixture.host)).toEqual({
        kind: "busy",
      });
      expect(await head(fixture.at("workspace/web"))).toBe(before);
    } finally {
      await lock?.release();
    }
    expect(byPath((await ran(fixture)).entries)["workspace/web"]).toBe(
      "fast-forwarded",
    );
  },
  60_000,
);

posixTest(
  "one Organization's explicit run keeps the record of the others and the order of answers",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    const all = await ran(fixture);
    const only = await ran(fixture, { organization: "alpha" });
    expect(only.organizations).toEqual(["Alpha"]);
    expect(only.entries.map((e) => e.path)).toEqual(
      all.entries.map((e) => e.path),
    );
    expect(
      await syncContent(fixture.folder, fixture.host, {
        organization: "Other",
      }),
    ).toMatchObject({ kind: "content-sync", organizations: [], entries: [] });
  },
  60_000,
);

posixTest(
  "one repository on its own: its root first, then only it and its data mounts, with progress per repository as it goes",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    await ran(fixture);
    const mission = await advance(world, "Alpha/mission-control", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    const web = await head(fixture.at("workspace/web"));
    await advance(world, "Alpha/web", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    const progress: string[] = [];
    const run = await ran(fixture, {
      organization: "Alpha",
      repository: "mission-control",
      onProgress: (event: SyncProgress) =>
        progress.push(
          `${event.path} ${event.step}${event.entry ? ` ${event.entry.result}` : ""}`,
        ),
    });
    expect(byPath(run.entries)).toEqual({
      ".": "current",
      "mission-control": "fast-forwarded",
      "mission-control/db": "current",
    });
    expect(await head(fixture.at("mission-control"))).toBe(mission);
    // web is behind, but not asked for.
    expect(await head(fixture.at("workspace/web"))).toBe(web);
    // Each repository's own steps in their order; repositories overlap.
    const steps = (path: string) =>
      progress
        .filter((line) => line.split(" ")[0] === path)
        .map((line) => line.split(" ").slice(1).join(" "));
    expect(steps(".")).toEqual(["checking", "done current"]);
    expect(steps("mission-control")).toEqual([
      "checking",
      "fetching",
      "fast-forwarding",
      "done fast-forwarded",
    ]);
    expect(steps("mission-control/db")).toEqual(["checking", "done current"]);
    expect(progress.indexOf(". done current")).toBeLessThan(
      progress.indexOf("mission-control checking"),
    );
    expect(new Set(progress)).toEqual(
      new Set([
        ". checking",
        ". done current",
        "mission-control checking",
        "mission-control fetching",
        "mission-control fast-forwarding",
        "mission-control done fast-forwarded",
        "mission-control/db checking",
        "mission-control/db done current",
      ]),
    );
    // The record keeps the other repositories' last answers.
    const record = await readSyncRecord(world.lockDirectory, fixture.folder);
    expect(byPath(record ?? [])).toEqual({
      ".": "current",
      "workspace/web": "current",
      "mission-control": "fast-forwarded",
      "mission-control/db": "current",
    });
  },
  60_000,
);

test("which Organizations an Environment keeps on their published branch, and through which identity", () => {
  expect(syncScope("local", null)).toEqual({
    organizations: "folder",
    remote: "account",
  });
  expect(syncScope("hosted-personal", bindings.personal)).toEqual({
    organizations: "none",
    remote: "account",
  });
  const organization =
    bindings.organization.owner.kind === "organization"
      ? bindings.organization.owner.organization
      : "";
  expect(
    syncScope("hosted-organization-personal", bindings.organization),
  ).toEqual({ organizations: { only: organization }, remote: "account" });
  // A Team Environment: the hosting prepared its content; it follows it
  // through the broker the hosting configured as git's helper.
  expect(syncScope("hosted-organization-team", bindings.assignedTeam)).toEqual({
    organizations: { only: organization },
    remote: "configured",
  });
  // A public Environment: anonymously, whatever its preset.
  expect(
    syncScope("hosted-organization-team", bindings.teamPublic).remote,
  ).toBe("anonymous");
  expect(
    syncScope("hosted-organization-personal", bindings.organizationPublic)
      .remote,
  ).toBe("anonymous");
});

test("a module whose checkout is blocked says so in one line, in words; nothing for other answers", () => {
  const status = (sync?: ModuleAnswer["sync"]): ModuleAnswer => ({
    kind: "module",
    operation: "status",
    organization: "alpha",
    module: "web",
    app: "app",
    runner: "session",
    survivesLaunchpadRestart: false,
    outcome: "not-managed",
    state: "stopped",
    healthy: false,
    service: null,
    runtime: null,
    ...(sync === undefined ? {} : { sync }),
  });
  const cs = messages("cs");
  expect(
    moduleStatusView(status({ result: "blocked", reason: "dirty" }), cs)
      .syncNote,
  ).toBe(
    "Tento modul se sám neaktualizuje, protože jeho hlavní verze má rozpracované změny.",
  );
  expect(
    moduleStatusView(status({ result: "blocked", reason: "wrong-branch" }), cs)
      .syncNote,
  ).toBe(
    "Tento modul se sám neaktualizuje, protože jeho hlavní verze je na jiné větvi.",
  );
  expect(
    moduleStatusView(
      status({ result: "blocked", reason: "unexpected-checkout" }),
      cs,
    ).syncNote,
  ).toBeUndefined();
  expect(moduleStatusView(status(), messages("en")).syncNote).toBeUndefined();
});

posixTest(
  "lazurio organization sync: the same core, one JSON line, its exit status",
  async () => {
    world = await createWorld();
    const fixture = await organization(world);
    await advance(world, "Alpha/web", (d) =>
      writeFile(join(d, "a.txt"), "2\n"),
    );
    const context: CliContext = {
      identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
      platform: process.platform,
      env: { HOME: world.home },
      executable: join(world.home, "lazurio"),
      hostedFolder: async () => undefined,
    };
    const command = async (...args: string[]) => {
      const lines: string[] = [];
      const code = await runContentCommand(
        ["organization", "sync", ...args, "--folder", fixture.folder],
        context,
        (line) => lines.push(line),
        () => fixture.host as ContentHost,
      );
      return { code, lines };
    };
    const json = await command("Alpha", "--json");
    expect(json.code).toBe(0);
    expect(json.lines).toHaveLength(1);
    const result = JSON.parse(json.lines[0] as string);
    expect(result.kind).toBe("content-sync");
    expect(
      result.entries.find((e: SyncEntry) => e.path === "workspace/web").result,
    ).toBe("fast-forwarded");
    // A blocked checkout: exit 1, its line names the reason.
    await writeFile(join(fixture.at("workspace/web"), "a.txt"), "local\n");
    const text = await command();
    expect(text.code).toBe(1);
    expect(text.lines).toContain(
      "organizations/alpha_GEN3/workspace/web (main)  blocked dirty",
    );
    // An Organization this Folder does not hold.
    expect((await command("Other")).code).toBe(1);
    // Usage.
    await expect(command("Alpha", "--role", "builder")).rejects.toThrow();
  },
  60_000,
);
