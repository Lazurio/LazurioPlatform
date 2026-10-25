import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processContentGit } from "../src/content/git";
import type { ContentGitHub } from "../src/content/github";
import { syncContent } from "../src/content/sync";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { messages } from "../src/launchpad/messages";
import { moduleStatusView } from "../src/launchpad/module-view";
import type { ApplicationRunner } from "../src/modules/application-runner";
import { gitCheckoutReader } from "../src/modules/built/checkout";
import {
  type BunInstaller,
  createModuleBunResolver,
  type ModuleBunResolver,
} from "../src/modules/bun-runtime";
import type { DataMountHost } from "../src/modules/data-mounts";
import { observeConnected } from "../src/modules/listener-ownership";
import {
  createModuleOperations,
  type ModuleAnswer,
  type ModuleBlocked,
  type ModuleHost,
  type RunningApp,
} from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import { type Catalog, readFolderCatalog } from "../src/organizations/catalog";
import { runTool } from "../src/tools/status";
import { type CliContext, runUpdateCommand } from "../src/update/cli";
import { updateEverything } from "../src/update/everything";
import { writeOrganization } from "./fixtures/catalog-folder";
import { compilePlatform, runnableModule } from "./fixtures/module-host";
import { mkdirOwnedFixture as mkdir } from "./fixtures/owned-files";
import {
  closeSharedSigstore,
  commitOf,
  createWorld as createUpdateWorld,
  target,
} from "./fixtures/update-world";

// A static app through the module lifecycle (decision F58, root decision
// 0195 point 19), with real processes: a synthetic module whose build script
// writes a page from its checkout, its Git commits as the pulls, the session
// runner with the compiled process guard, and the Platform's static server
// as the started app. Synthetic names only; nothing touches the account's
// home, cache or user manager.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "module-built-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  await closeSharedSigstore();
});

// The build script: a page naming the checkout's `page.txt`, a content-named
// asset per build, a wait while `hold` exists and a failure for `fail`.
const buildScript = `
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
while (existsSync("hold")) await Bun.sleep(20);
if (existsSync("flaky")) process.exit(1);
const own = readFileSync("page.txt", "utf8").trim();
if (own === "fail") process.exit(1);
// The module's data mount, when it has one (workspace/<module>/db).
const data = existsSync("../db/data.txt") ? readFileSync("../db/data.txt", "utf8").trim() : "";
const page = data ? own + "+" + data : own;
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/_astro", { recursive: true });
writeFileSync("dist/index.html", "<p>" + page + "</p>");
writeFileSync("dist/_astro/app." + page + ".js", "/* " + page + " */");
`;

// The start script of an app with its own server (decision F58, addendum of
// 2026-10-21): it ends at once at a commit whose page is `crash`, and
// otherwise answers with its mode, the client it was handed, the module's
// data as it reads it now and its process.
const startScript = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
if (readFileSync("page.txt", "utf8").trim() === "crash") process.exit(2);
const output = process.env.LAZURIO_RUNTIME_BUILD_OUTPUT ?? null;
Bun.serve({
  hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST,
  port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT),
  fetch: () =>
    Response.json({
      mode: process.env.NODE_ENV,
      output,
      page: output === null ? null : readFileSync(join(output, "index.html"), "utf8"),
      data: existsSync("../db/data.txt") ? readFileSync("../db/data.txt", "utf8").trim() : null,
      pid: process.pid,
    }),
});
`;

// A module made static: its build script and page, and its own Git
// repository; returns the repository's git. With `server`, the app runs its
// own server from main (`start_script`), and its build is its client.
async function makeStatic(directory: string, server = false) {
  const pkgPath = join(directory, "app/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.scripts.build = `"${process.execPath}" --no-env-file build.ts`;
  pkg.lazurio.runtime.build_script = "build";
  pkg.lazurio.runtime.build_output = "dist";
  if (server) {
    pkg.scripts.start = `"${process.execPath}" --no-env-file start.ts`;
    pkg.lazurio.runtime.start_script = "start";
    await writeFile(join(directory, "app/start.ts"), startScript);
  }
  await writeFile(pkgPath, JSON.stringify(pkg));
  await writeFile(join(directory, "app/build.ts"), buildScript);
  await writeFile(join(directory, "app/page.txt"), "one\n");
  await writeFile(
    join(directory, ".gitignore"),
    "node_modules/\ndist/\nhold\nflaky\ndb/\n",
  );
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        directory,
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
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "Static module");
  return git;
}

async function staticModule(
  name: string,
  home: string,
  options: Readonly<{
    /** The catalog's reader (the module operations' test seam). */
    readCatalog?: (folder: string) => Promise<Catalog>;
    /** `workspace/site/db`: a data mount of its own Git repository. */
    dataMount?: boolean;
    /** One runner for every owner of this host's apps, as the service
     * manager outlives a Launchpad; otherwise one per lifecycle. */
    runner?: ApplicationRunner;
    /** More of plain's runtime declaration (its required slots). */
    plain?: Record<string, unknown>;
    /** site runs its own server (`start_script`), its build its client. */
    server?: boolean;
    /** site's slot declares its GitHub repository, `alpha/site`. */
    published?: boolean;
    /** This host's gh, git and content locks (data mounts, and the record
     * of the synchronization). */
    dataMounts?: DataMountHost;
    /** The resolver of the Bun each app pins (decision F62): the module
     * operations' test seam. */
    resolveBun?: ModuleBunResolver;
  }> = {},
) {
  const parent = join(root, name);
  await mkdir(parent);
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "en",
    detail: "concise",
    coordination: "direct",
  });
  const organization = await writeOrganization(folder, "alpha", {
    slug: "alpha",
    state: "current",
    modules: [
      {
        id: "site",
        ...(options.published
          ? { slot: { git: { url: "git@github.com:alpha/site.git" } } }
          : {}),
      },
      {
        id: "plain",
        ...(options.plain === undefined ? {} : { runtime: options.plain }),
      },
      { id: "next" },
    ],
    ...(options.dataMount
      ? {
          slots: [
            {
              path: "workspace/site/db",
              slug: "site-db",
              materialization: "repository_db_mount",
            },
          ],
        }
      : {}),
  });
  const site = join(organization, "workspace/site");
  const next = join(organization, "workspace/next");
  const port = await runnableModule(site, home);
  const port2 = await runnableModule(
    join(organization, "workspace/plain"),
    home,
  );
  const port3 = await runnableModule(next, home);
  const git = await makeStatic(site, options.server);
  await makeStatic(next);
  const host: ModuleHost = {
    platform: process.platform,
    home,
    path: "/usr/bin:/bin",
    runtimeDirectory: undefined,
    platformExecutable: binary,
    bunExecutable: process.execPath,
    runnerKind: async () => "session",
    createRunner: () => options.runner ?? createSessionRunner(binary),
    readJournal: async () => ({ kind: "unavailable" }) as const,
    ...(options.dataMounts === undefined
      ? {}
      : { dataMounts: options.dataMounts }),
    ...(options.resolveBun === undefined
      ? {}
      : { resolveBun: options.resolveBun }),
    builds: {
      cacheRoot: join(parent, "cache"),
      lockFile: join(parent, "state/lazurio/builds.lock"),
      readCheckout: gitCheckoutReader(
        async () => Bun.which("git") ?? undefined,
      ),
    },
  };
  const operations = createModuleOperations({
    folder,
    owner: "launchpad",
    host,
    ...(options.readCatalog === undefined
      ? {}
      : { readCatalog: options.readCatalog }),
  });
  // The data repository: its own checkout below the module, ignored by it.
  const database = join(site, "db");
  const data = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        database,
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
  if (options.dataMount) {
    await mkdir(database);
    await writeFile(join(database, "data.txt"), "d1\n");
    data("init", "-q", "-b", "main");
    data("add", "-A");
    data("commit", "-qm", "Data");
  }
  const commit = async (page: string) => {
    await writeFile(join(site, "app/page.txt"), `${page}\n`);
    git("commit", "-qam", page);
    return git("rev-parse", "HEAD");
  };
  return {
    operations,
    host,
    folder,
    git,
    site,
    next,
    port,
    port2,
    port3,
    commit,
    head: () => git("rev-parse", "HEAD"),
    /** A data-only pull: a new commit of the data repository. */
    publishData: async (value: string) => {
      await writeFile(join(database, "data.txt"), `${value}\n`);
      data("commit", "-qam", value);
    },
    hold: () => writeFile(join(site, "app/hold"), ""),
    flaky: (on: boolean) =>
      on
        ? writeFile(join(site, "app/flaky"), "")
        : rm(join(site, "app/flaky"), { force: true }),
    release: () => rm(join(site, "app/hold"), { force: true }),
    page: async (path = "/") =>
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (response) => ({
          status: response.status,
          text: await response.text(),
        }))
        .catch(() => ({ status: 0, text: "" })),
    /** What site's own server answers, or null while nothing does. */
    server: async () =>
      fetch(`http://127.0.0.1:${port}/`)
        .then(
          (response) =>
            response.json() as Promise<{
              mode: string;
              output: string | null;
              page: string | null;
              data: string | null;
              pid: number;
            }>,
        )
        .catch(() => null),
  };
}

const answer = (result: ModuleAnswer | ModuleBlocked) => {
  if (result.kind !== "module") throw new Error(JSON.stringify(result));
  return result;
};

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(50);
  }
}

posixTest(
  "a static app starts as its build, --dev as its development script; after a pull it serves the build there is until the new one is built, then swaps; a failed build keeps it serving",
  async () => {
    const home = join(root, "home-start");
    await mkdir(home);
    const fixture = await staticModule("start", home);
    const { operations } = fixture;
    try {
      const first = fixture.head();
      const started = answer(await operations.start("alpha/site"));
      expect(started.outcome).toBe("started");
      expect(started.build).toMatchObject({
        mode: "built",
        served: { commit: first },
        current: { commit: first, dirty: false },
        building: null,
        failure: null,
      });
      const healthy = await until(
        () => operations.status("alpha/site"),
        (status) => status.kind === "module" && status.healthy,
      );
      expect(answer(healthy).runtime?.url).toBe(
        `http://127.0.0.1:${fixture.port}/`,
      );
      expect(await fixture.page()).toEqual({ status: 200, text: "<p>one</p>" });
      // The development version, explicitly, replaces the built run.
      const dev = answer(await operations.start("alpha/site", { dev: true }));
      expect(dev.outcome).toBe("started");
      expect(dev.build?.mode).toBe("dev");
      await until(fixture.page, (page) => page.text === "synthetic module");
      expect(answer(await operations.stop("alpha/site")).outcome).toBe(
        "group-stopped",
      );
      // A pull: the build there is serves at once, the new commit builds
      // in the background, and the app is swapped onto it.
      const second = await fixture.commit("two");
      await fixture.hold();
      const reopened = answer(await operations.start("alpha/site"));
      expect(reopened.build?.served?.commit).toBe(first);
      await until(fixture.page, (page) => page.status === 200);
      expect((await fixture.page()).text).toBe("<p>one</p>");
      const building = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" && status.build?.building != null,
        ),
      );
      expect(building.build?.building?.commit).toBe(second);
      expect((await fixture.page()).text).toBe("<p>one</p>");
      await fixture.release();
      const swapped = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.healthy &&
            status.build?.served?.commit === second,
        ),
      );
      expect(swapped.build).toMatchObject({
        mode: "built",
        current: { commit: second },
      });
      expect(await fixture.page()).toEqual({ status: 200, text: "<p>two</p>" });
      // A page opened before the swap still gets its assets.
      expect((await fixture.page("/_astro/app.one.js")).status).toBe(200);
      expect((await fixture.page("/_astro/app.two.js")).status).toBe(200);
      // A build that fails keeps the build there was, with its log.
      const third = await fixture.commit("fail");
      const failed = await operations.build("alpha/site");
      expect(failed).toMatchObject({
        kind: "blocked",
        operation: "build",
        reason: "build-script-failed",
        build: {
          current: { commit: second },
          failure: { commit: third, reason: "build-script-failed" },
        },
      });
      const log = failed.kind === "blocked" ? failed.build?.failure?.log : "";
      expect(log?.endsWith(`/logs/${third}.log`)).toBe(true);
      expect(await readFile(log as string, "utf8")).toContain(
        "exited with code 1",
      );
      const after = answer(await operations.status("alpha/site"));
      expect(after.healthy).toBe(true);
      expect(after.build?.served?.commit).toBe(second);
      expect(after.build?.failure?.commit).toBe(third);
      expect((await fixture.page()).text).toBe("<p>two</p>");
      // An explicit build of a fixed checkout builds and swaps.
      const fourth = await fixture.commit("four");
      const rebuilt = answer(await operations.build("alpha/site"));
      expect(rebuilt.outcome).toBe("built");
      expect(rebuilt.build?.head).toEqual({
        commit: fourth,
        branch: "main",
        dirty: false,
      });
      expect(rebuilt.build?.failure).toBeNull();
      await until(fixture.page, (page) => page.text === "<p>four</p>");
      // An app without build_output runs its development script, as before.
      const plain = answer(await operations.start("alpha/plain"));
      expect(plain.outcome).toBe("started");
      expect(plain.build).toBeUndefined();
      expect(await operations.build("alpha/plain")).toMatchObject({
        kind: "blocked",
        reason: "not-static",
      });
    } finally {
      await operations.stop("alpha/site");
      await operations.stop("alpha/plain");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "the gateway's ensure answers build-pending while the first build runs, then healthy",
  async () => {
    const home = join(root, "home-ensure");
    await mkdir(home);
    const fixture = await staticModule("ensure", home);
    const { operations } = fixture;
    try {
      await fixture.hold();
      const pending = answer(
        await operations.ensure("site", { mayStart: true, waitMs: 400 }),
      );
      expect(pending).toMatchObject({
        operation: "ensure",
        outcome: "build-pending",
        healthy: false,
        build: { building: { commit: fixture.head() }, current: null },
      });
      // A background request only reports, and starts nothing more.
      expect(
        answer(await operations.ensure("site", { mayStart: false })).outcome,
      ).toBe("not-managed");
      await fixture.release();
      const ready = answer(
        await until(
          () => operations.ensure("site", { mayStart: true, waitMs: 2000 }),
          (result) => result.kind === "module" && result.healthy,
        ),
      );
      expect(ready.build?.mode).toBe("built");
      expect(await fixture.page()).toEqual({ status: 200, text: "<p>one</p>" });
    } finally {
      await fixture.release();
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a failed build is built again only when a person asks: the gateway's ensure never retries it, a Start does",
  async () => {
    const home = join(root, "home-retry");
    await mkdir(home);
    const fixture = await staticModule("retry", home);
    const { operations } = fixture;
    try {
      await fixture.flaky(true);
      const failed = await operations.ensure("site", {
        mayStart: true,
        waitMs: 20_000,
      });
      expect(failed).toMatchObject({
        kind: "blocked",
        reason: "build-script-failed",
      });
      // The cause is gone, but the same commit is not built by itself.
      await fixture.flaky(false);
      expect(
        await operations.ensure("site", { mayStart: true, waitMs: 20_000 }),
      ).toMatchObject({ kind: "blocked", reason: "build-script-failed" });
      // A person's Start builds it again.
      const started = answer(await operations.start("alpha/site"));
      expect(started.outcome).toBe("started");
      expect(started.build).toMatchObject({ mode: "built", failure: null });
      await until(fixture.page, (page) => page.text === "<p>one</p>");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "two apps compete for the one build: the one waiting behind the other's build answers build-pending, recorded as queued, then builds",
  async () => {
    const home = join(root, "home-compete");
    await mkdir(home);
    const fixture = await staticModule("compete", home);
    const { operations } = fixture;
    try {
      await fixture.hold();
      // site's build runs (held); next's waits for the one build.
      const first = operations.ensure("site", { mayStart: true, waitMs: 300 });
      expect(answer(await first).outcome).toBe("build-pending");
      const waiting = answer(
        await operations.ensure("next", { mayStart: true, waitMs: 300 }),
      );
      expect(waiting).toMatchObject({
        outcome: "build-pending",
        healthy: false,
        build: { building: { commit: null, queued: true }, current: null },
      });
      await fixture.release();
      for (const [id, port] of [
        ["site", fixture.port],
        ["next", fixture.port3],
      ] as const) {
        const ready = answer(
          await until(
            () => operations.ensure(id, { mayStart: true, waitMs: 2000 }),
            (result) => result.kind === "module" && result.healthy,
          ),
        );
        expect(ready.build).toMatchObject({ mode: "built", building: null });
        expect(
          await fetch(`http://127.0.0.1:${port}/`).then((response) =>
            response.text(),
          ),
        ).toBe("<p>one</p>");
      }
    } finally {
      await fixture.release();
      await operations.stop("alpha/site");
      await operations.stop("alpha/next");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "the Launchpad keeps a static app built after a pull: a development run from before builds moves onto a build at the first sweep that reads the catalog, and a commit is built and swapped in without a request",
  async () => {
    const home = join(root, "home-watch");
    await mkdir(home);
    // The catalog can fail to be read, as at a start while the Folder is
    // being written.
    let catalogFails = false;
    const fixture = await staticModule("watch", home, {
      readCatalog: (folder) =>
        catalogFails
          ? Promise.reject(new Error("catalog unreadable now"))
          : readFolderCatalog(folder),
    });
    const { operations } = fixture;
    try {
      // A development run from before builds existed: no build, no record.
      answer(await operations.start("alpha/site", { dev: true }));
      await until(fixture.page, (page) => page.text === "synthetic module");
      await rm(join(root, "watch", "cache"), { recursive: true, force: true });
      // The first sweep cannot read the catalog: nothing is moved yet…
      catalogFails = true;
      const keeper = operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      await keeper?.sweep();
      await keeper?.settled();
      catalogFails = false;
      expect(answer(await operations.status("alpha/site")).build?.mode).toBe(
        "dev",
      );
      // …and the next sweep, which can, moves it.
      await keeper?.sweep();
      const first = fixture.head();
      const moved = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.healthy &&
            status.build?.served?.commit === first,
        ),
      );
      expect(moved.build?.mode).toBe("built");
      expect((await fixture.page()).text).toBe("<p>one</p>");
      // A pull: nothing is asked of the Launchpad but its status.
      const second = await fixture.commit("two");
      const swapped = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.healthy &&
            status.build?.served?.commit === second,
        ),
      );
      expect(swapped.build?.current?.commit).toBe(second);
      expect((await fixture.page()).text).toBe("<p>two</p>");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "the Launchpad's sweep fast-forwards a built app's clean primary checkout to its published commit, and the served build swaps onto it (decision F9's amendment of 2026-10-24)",
  async () => {
    const home = join(root, "home-sync");
    await mkdir(home);
    // The published side: bare repositories reached as github.com through
    // git's own `insteadOf`, as an operator's configuration may.
    const remotes = join(root, "sync-remotes");
    await mkdir(join(remotes, "alpha"), { recursive: true });
    const gitEnv = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "git@github.com:",
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "always",
    };
    const content: DataMountHost = {
      github: {
        remote: async (name: string) => ({ url: `git@github.com:${name}.git` }),
      } as unknown as ContentGitHub,
      git: processContentGit({
        path: Bun.env.PATH,
        home,
        platform: process.platform,
        run: runTool,
        env: gitEnv,
      }),
      lockDirectory: join(root, "sync-base", "content"),
    };
    const fixture = await staticModule("sync", home, {
      published: true,
      dataMounts: content,
    });
    const { operations, folder, site } = fixture;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          cwd,
          "-c",
          "user.name=fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8", env: { ...process.env, ...gitEnv } },
      ).trim();
    // The Organization root and site, each a primary checkout of its
    // published repository.
    const organization = join(folder, "organizations", "alpha");
    await writeFile(join(organization, ".gitignore"), "workspace/\n");
    git(organization, "init", "-q", "-b", "main");
    git(organization, "add", "-A");
    git(organization, "commit", "-qm", "Root");
    for (const [directory, name] of [
      [organization, "alpha"],
      [site, "site"],
    ] as const) {
      git(remotes, "clone", "-q", "--bare", directory, `alpha/${name}.git`);
      git(
        directory,
        "remote",
        "add",
        "origin",
        `git@github.com:alpha/${name}.git`,
      );
      git(directory, "fetch", "-q", "origin");
    }
    const sync = () => syncContent(folder, content);
    try {
      const started = answer(await operations.start("alpha/site"));
      expect(started.build?.mode).toBe("built");
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      const keeper = operations.keepBuilt({
        quietMs: 100,
        sweepMs: 60_000,
        sync,
        // Every sweep here; the cadence has its own test below.
        syncEveryMs: 0,
      });
      await keeper?.sweep();
      await keeper?.settled();
      // Someone publishes: a new commit on site's main, nowhere else.
      const scratch = join(root, "sync", "scratch");
      git(root, "clone", "-q", "git@github.com:alpha/site.git", scratch);
      await writeFile(join(scratch, "app/page.txt"), "two\n");
      git(scratch, "commit", "-qam", "two");
      git(scratch, "push", "-q", "origin", "main");
      const published = git(scratch, "rev-parse", "HEAD");
      // One sweep: the checkout fast-forwards, the build follows.
      await keeper?.sweep();
      expect(fixture.head()).toBe(published);
      const swapped = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.healthy &&
            status.build?.served?.commit === published,
        ),
      );
      expect(swapped.build?.served?.commit).toBe(published);
      expect((await fixture.page()).text).toBe("<p>two</p>");
      expect(git(site, "status", "--porcelain")).toBe("");
      expect(swapped.sync).toBeUndefined();
      // Unfinished work in site's main version: the next sweep leaves it,
      // and its page says so in one line.
      await writeFile(join(site, "notes.txt"), "draft\n");
      await keeper?.sweep();
      const left = answer(await operations.status("alpha/site"));
      expect(left.sync).toEqual({ result: "blocked", reason: "dirty" });
      expect(moduleStatusView(left, messages("en")).syncNote).toBe(
        "This module doesn't update by itself because its main version has unfinished changes.",
      );
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "the sweep synchronizes content at its first round and then once its own interval has passed, not at every 5-minute round",
  async () => {
    const home = join(root, "home-cadence");
    await mkdir(home);
    const { operations } = await staticModule("cadence", home);
    let clock = 1_000_000;
    let runs = 0;
    try {
      const keeper = operations.keepBuilt({
        quietMs: 100,
        sweepMs: 60_000,
        now: () => clock,
        // A synchronization that fails never stops the sweep.
        sync: async () => {
          runs += 1;
          throw new Error("unreachable");
        },
        syncEveryMs: 60 * 60 * 1000,
      });
      await keeper?.sweep();
      expect(runs).toBe(1);
      for (const minutes of [5, 30, 59]) {
        clock = 1_000_000 + minutes * 60 * 1000;
        await keeper?.sweep();
      }
      expect(runs).toBe(1);
      clock = 1_000_000 + 60 * 60 * 1000;
      await keeper?.sweep();
      expect(runs).toBe(2);
    } finally {
      await operations.close();
    }
  },
  60_000,
);

/** `staticModule` whose Organization root and site are primary checkouts of
 * their published repositories (bare repositories reached as github.com
 * through git's own `insteadOf`), with the content host that reaches them;
 * `publish` puts a new page on site's published main from elsewhere, and
 * with `pin` the Bun its app pins (`packageManager`). */
async function publishedSite(
  name: string,
  home: string,
  resolveBun?: ModuleBunResolver,
) {
  const remotes = join(root, `${name}-remotes`);
  await mkdir(join(remotes, "alpha"), { recursive: true });
  const gitEnv = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "git@github.com:",
    GIT_CONFIG_KEY_1: "protocol.file.allow",
    GIT_CONFIG_VALUE_1: "always",
  };
  const content: DataMountHost = {
    github: {
      remote: async (repository: string) => ({
        url: `git@github.com:${repository}.git`,
      }),
    } as unknown as ContentGitHub,
    git: processContentGit({
      path: Bun.env.PATH,
      home,
      platform: process.platform,
      run: runTool,
      env: gitEnv,
    }),
    lockDirectory: join(root, `${name}-base`, "content"),
  };
  const fixture = await staticModule(name, home, {
    published: true,
    dataMounts: content,
    ...(resolveBun === undefined ? {} : { resolveBun }),
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        cwd,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, ...gitEnv } },
    ).trim();
  const organization = join(fixture.folder, "organizations", "alpha");
  await writeFile(join(organization, ".gitignore"), "workspace/\n");
  git(organization, "init", "-q", "-b", "main");
  git(organization, "add", "-A");
  git(organization, "commit", "-qm", "Root");
  for (const [directory, repository] of [
    [organization, "alpha"],
    [fixture.site, "site"],
  ] as const) {
    git(remotes, "clone", "-q", "--bare", directory, `alpha/${repository}.git`);
    git(
      directory,
      "remote",
      "add",
      "origin",
      `git@github.com:alpha/${repository}.git`,
    );
    git(directory, "fetch", "-q", "origin");
  }
  const scratch = join(root, name, "scratch");
  git(root, "clone", "-q", "git@github.com:alpha/site.git", scratch);
  return {
    ...fixture,
    content,
    publish: async (page: string, pin?: string) => {
      await writeFile(join(scratch, "app/page.txt"), `${page}\n`);
      if (pin !== undefined) {
        const file = join(scratch, "app/package.json");
        const pkg = JSON.parse(await readFile(file, "utf8"));
        pkg.packageManager = pin;
        await writeFile(file, JSON.stringify(pkg));
      }
      git(scratch, "commit", "-qam", page);
      git(scratch, "push", "-q", "origin", "main");
      return git(scratch, "rev-parse", "HEAD");
    },
  };
}

posixTest(
  "lazurio update with no newer Lazurio and a module behind: its checkout fast-forwards, --json lists every item with Lazurio last, and the new commit is built and swapped in (root decision 0212 point 3)",
  async () => {
    const home = join(root, "home-update");
    await mkdir(home);
    const fixture = await publishedSite("update", home);
    const { operations, folder } = fixture;
    // No newer Lazurio: the latest release is the running version.
    const product = await createUpdateWorld();
    await product.release("1.0.0");
    const context: CliContext = {
      identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
      platform: process.platform,
      env: { HOME: product.root, XDG_DATA_HOME: product.root },
      executable: join(product.root, "downloaded-lazurio"),
      environment: product.environment("1.0.0"),
      modules: () => ({ host: fixture.host }),
    };
    const update = (...args: string[]) =>
      runUpdateCommand(
        ["--base", product.base, "--folder", folder, ...args],
        context,
      );
    try {
      // site runs as its build, a session's app of this Launchpad.
      const started = answer(await operations.start("alpha/site"));
      expect(started.build?.mode).toBe("built");
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      const keeper = operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      await keeper?.sweep();
      await keeper?.settled();
      const published = await fixture.publish("two");
      const ran = await update("--json");
      expect(ran.code).toBe(0);
      const result = JSON.parse(ran.stdout ?? "");
      expect(result).toMatchObject({ kind: "up-to-date", running: "1.0.0" });
      // One item per repository, pinned Bun and the product, in the order
      // the parts ran, Lazurio last. site pins the user's own Bun, which is
      // there already. A session's apps are built by their Launchpad, which
      // owns their dependency trees: no build item from the CLI.
      expect(
        result.items.map((item: Record<string, string>) =>
          [item.part, item.path ?? item.packageManager ?? "", item.result].join(
            " ",
          ),
        ),
      ).toEqual([
        "content . current",
        "content workspace/site fast-forwarded",
        `tools bun@${Bun.version} cached`,
        "product  current",
      ]);
      expect(result.items[1]).toMatchObject({
        organization: "alpha",
        branch: "main",
        to: published,
      });
      expect(fixture.head()).toBe(published);
      // The Launchpad's watch of site's checkout builds the new commit and
      // swaps it in.
      const swapped = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.build?.served?.commit === published,
        ),
      );
      expect(swapped.build?.served?.commit).toBe(published);
      expect((await fixture.page()).text).toBe("<p>two</p>");
      // In words: the content's summary, then Lazurio's own line.
      expect((await update()).stdout).toBe(
        [
          "Content: 2 repositories checked, 0 fast-forwarded, 0 left as they are.",
          "Lazurio 1.0.0 is up to date.",
        ].join("\n"),
      );
      // A product that fails still answers what the content did.
      await product.close();
      const offline = await update("--json");
      expect(offline.code).toBe(1);
      const failed = JSON.parse(offline.stdout ?? "");
      expect(failed.kind).toBe("error");
      expect(
        failed.items.map((item: Record<string, string>) => item.result),
      ).toEqual(["current", "current", "failed"]);
      const words = await update();
      expect(words.stdout).toContain("Content: 2 repositories checked");
      expect(words.stderr).toStartWith("Update failed: ");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
      await product.close().catch(() => undefined);
    }
  },
  120_000,
);

posixTest(
  "the Launchpad's own run builds what changed and swaps it at once; a commit whose build failed is not built again, and an app nobody opened is not built for the first time",
  async () => {
    const home = join(root, "home-refresh");
    await mkdir(home);
    const fixture = await publishedSite("refresh", home);
    const { operations, folder, content } = fixture;
    const run = () =>
      updateEverything({
        content: (onProgress) => syncContent(folder, content, { onProgress }),
        builds: (onProgress) => operations.refreshBuilt(onProgress),
        product: async () => ({
          part: "product",
          result: "current",
          version: "1.0.0",
        }),
      });
    try {
      answer(await operations.start("alpha/site"));
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      const two = await fixture.publish("two");
      const items = await run();
      expect(items.filter((item) => item.part === "build")).toEqual([
        {
          part: "build",
          organization: "alpha",
          module: "site",
          app: "app/package.json",
          result: "built",
          commit: two,
        },
      ]);
      // Swapped by this run itself, no sweep.
      expect((await fixture.page()).text).toBe("<p>two</p>");
      // A commit whose build fails: the previous build keeps serving, and
      // the next run does not build it again.
      const broken = await fixture.publish("fail");
      const failed = (await run()).find((item) => item.part === "build");
      expect(failed).toMatchObject({
        result: "failed",
        reason: "build-script-failed",
        commit: broken,
      });
      expect((await fixture.page()).text).toBe("<p>two</p>");
      const failure = async () =>
        answer(await operations.status("alpha/site")).build?.failure;
      const recorded = await failure();
      expect(recorded?.commit).toBe(broken);
      expect((await run()).find((item) => item.part === "build")).toMatchObject(
        { result: "failed", reason: "build-script-failed" },
      );
      // The same failure, not a new attempt.
      expect(await failure()).toEqual(recorded);
      // next was never opened: it has no build state, and gets none here.
      expect(
        (await run()).some(
          (item) =>
            item.part === "build" && "module" in item && item.module === "next",
        ),
      ).toBe(false);
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

/** Bun's npm distribution as a fake for the resolver (decision F62): for
 * each version a program named bun that logs every call, reports the version
 * and runs the real Bun otherwise; a version in `offline` is refused as a
 * registry that does not answer. No network. */
function bunDistribution(directory: string) {
  const offline = new Set<string>();
  const asked: string[] = [];
  const install: BunInstaller = async (input) => {
    asked.push(input.version);
    if (offline.has(input.version))
      return { kind: "refused", reason: "runtime-unavailable" };
    const program = join(
      input.directory,
      "node_modules",
      input.packageName,
      "bin",
      "bun",
    );
    await mkdir(dirname(program), { recursive: true });
    await writeFile(
      program,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${join(directory, `bun-${input.version}.log`)}'`,
        `if [ "$1" = "--version" ]; then echo '${input.version}'; exit 0; fi`,
        `exec '${process.execPath}' "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(program, 0o755);
    return { kind: "installed" };
  };
  return {
    install,
    offline,
    asked,
    /** What that version's program ran, its version probes left out. */
    calls: async (version: string) =>
      (
        await readFile(join(directory, `bun-${version}.log`), "utf8").catch(
          () => "",
        )
      )
        .split("\n")
        .filter((line) => line !== "" && line !== "--version"),
  };
}

posixTest(
  "the tools part fetches the Bun a fast-forwarded module's new commit pins before its build, which runs with it; offline, the build fails for its runtime and a later run builds it (decision F62, root decision 0212 point 3)",
  async () => {
    const home = join(root, "home-tools");
    await mkdir(home);
    const distribution = bunDistribution(join(root, "tools-distribution"));
    await mkdir(join(root, "tools-distribution"));
    const resolveBun = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: distribution.install,
      system: async () => ({
        platform: "linux",
        arch: "arm64",
        libc: "glibc",
        avx2: null,
      }),
      freeBytes: async () => 10 * 1024 ** 3,
      fetches: new Map(),
    });
    const fixture = await publishedSite("tools", home, resolveBun);
    const { operations, folder, content } = fixture;
    // What the installer had been asked for when each build began.
    const atBuild: string[][] = [];
    const run = () =>
      updateEverything(
        {
          content: (onProgress) => syncContent(folder, content, { onProgress }),
          tools: {
            pins: (moved) => operations.runtimePins(moved),
            resolve: operations.resolveBun,
          },
          builds: (onProgress) =>
            operations.refreshBuilt((progress) => {
              atBuild.push([...distribution.asked]);
              onProgress(progress);
            }),
          product: async () => ({
            part: "product",
            result: "current",
            version: "1.0.0",
          }),
        },
        () => {},
      );
    const parts = (items: Awaited<ReturnType<typeof run>>) =>
      items.map((item) =>
        [
          item.part,
          "path" in item
            ? item.path
            : "packageManager" in item
              ? item.packageManager
              : "module" in item
                ? item.module
                : "",
          item.result,
          "reason" in item ? (item.reason ?? "") : "",
        ]
          .filter((word) => word !== "")
          .join(" "),
      );
    try {
      answer(await operations.start("alpha/site"));
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      // A new commit that pins a Bun the cache does not hold.
      const two = await fixture.publish("two", "bun@1.4.99");
      const first = await run();
      expect(parts(first)).toEqual([
        "content . current",
        "content workspace/site fast-forwarded",
        "tools bun@1.4.99 fetched",
        "build site built",
        "product current",
      ]);
      // Fetched once, by the tools part, before the build began.
      expect(distribution.asked).toEqual(["1.4.99"]);
      expect(atBuild).toEqual([["1.4.99"]]);
      // The build ran with exactly that Bun, and its page is served.
      expect(await distribution.calls("1.4.99")).toContain(
        "--no-env-file run build",
      );
      expect(first.find((item) => item.part === "build")).toMatchObject({
        result: "built",
        commit: two,
      });
      expect((await fixture.page()).text).toBe("<p>two</p>");
      // Offline: a commit that pins another Bun. The pre-warm stops at the
      // registry that does not answer; the build, which resolves its own
      // pin, fails for it and what runs stays as it was.
      distribution.offline.add("1.4.98");
      await fixture.publish("three", "bun@1.4.98");
      const offline = await run();
      expect(parts(offline)).toEqual([
        "content . current",
        "content workspace/site fast-forwarded",
        "tools bun@1.4.98 refused runtime-unavailable",
        "build site failed runtime-unavailable",
        "product current",
      ]);
      expect((await fixture.page()).text).toBe("<p>two</p>");
      // Online again: nothing new to fast-forward, so no pins; the build
      // whose runtime could not be had is built again (decision F62 point
      // 7) and fetches its Bun itself.
      distribution.offline.delete("1.4.98");
      const later = await run();
      expect(parts(later)).toEqual([
        "content . current",
        "content workspace/site current",
        "build site built",
        "product current",
      ]);
      expect(await distribution.calls("1.4.98")).toContain(
        "--no-env-file run build",
      );
      expect((await fixture.page()).text).toBe("<p>three</p>");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a data-only pull rebuilds: the Launchpad watches the data repository its build reads, and the new build of the same module commit is swapped in",
  async () => {
    const home = join(root, "home-data");
    await mkdir(home);
    const fixture = await staticModule("data", home, { dataMount: true });
    const { operations } = fixture;
    try {
      const started = answer(await operations.start("alpha/site"));
      expect(started.build?.mode).toBe("built");
      await until(fixture.page, (page) => page.text === "<p>one+d1</p>");
      const before = answer(await operations.status("alpha/site")).build;
      // The key is the digest of the module's and the data's commits.
      expect(before?.current?.key).toMatch(/^[0-9a-f]{64}$/);
      operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      await fixture.publishData("d2");
      await until(fixture.page, (page) => page.text === "<p>one+d2</p>");
      const after = answer(await operations.status("alpha/site")).build;
      // Same module commit, another key, served.
      expect(after?.current?.commit).toBe(before?.current?.commit as string);
      expect(after?.current?.key).not.toBe(before?.current?.key as string);
      expect(after?.served?.key).toBe(after?.current?.key as string);
      expect((await fixture.page()).text).toBe("<p>one+d2</p>");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a first sweep that reads the catalog but cannot name the app keeps the move pending: the next sweep moves the development run from before builds onto a build",
  async () => {
    const home = join(root, "home-resolve");
    await mkdir(home);
    // Every catalog read is counted; one chosen read fails.
    let reads = 0;
    let failing = -1;
    const fixture = await staticModule("resolve", home, {
      readCatalog: (folder) => {
        reads++;
        return reads === failing
          ? Promise.reject(new Error("catalog unreadable now"))
          : readFolderCatalog(folder);
      },
    });
    const { operations } = fixture;
    try {
      // A development run from before builds existed: no build, no record.
      answer(await operations.start("alpha/site", { dev: true }));
      await until(fixture.page, (page) => page.text === "synthetic module");
      await rm(join(root, "resolve", "cache"), {
        recursive: true,
        force: true,
      });
      // The first sweep reads the catalog (its first read), then names each
      // app it lists, one read each, in the catalog's order: the read that
      // names the site fails. Where the site is first, that is the sweep's
      // second read.
      const listed = (await readFolderCatalog(fixture.folder)).organizations
        .flatMap((organization) => organization.modules)
        .flatMap((module) =>
          module.apps
            .filter((app) => app.kind === "runtime-declared")
            .map(() => module.module),
        );
      failing = reads + 1 + listed.indexOf("site") + 1;
      const keeper = operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      await keeper?.sweep();
      await keeper?.settled();
      expect(reads).toBeGreaterThanOrEqual(failing);
      expect(answer(await operations.status("alpha/site")).build?.mode).toBe(
        "dev",
      );
      // Recovered: the next sweep moves it.
      await keeper?.sweep();
      const moved = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.healthy &&
            status.build?.mode === "built",
        ),
      );
      expect(moved.build?.served?.commit).toBe(fixture.head());
      expect((await fixture.page()).text).toBe("<p>one</p>");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a swap onto a new build refuses no connection: the static server keeps its listener and serves the new build from the record, also when the pull changed the package (#560)",
  async () => {
    const home = join(root, "home-gapless");
    await mkdir(home);
    const fixture = await staticModule("gapless", home);
    const { operations } = fixture;
    try {
      const started = answer(await operations.start("alpha/site"));
      expect(started.build?.mode).toBe("built");
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      // The start leaves a background check of its build. An explicit build
      // joins it and answers when it ends, so the pull below lands after it,
      // and the explicit build after the pull is the one that builds.
      expect(answer(await operations.build("alpha/site")).outcome).toBe(
        "current",
      );
      // Probe the app every 20 ms for the whole swap.
      let probes = 0;
      let refused = 0;
      let probing = true;
      const probe = (async () => {
        while (probing) {
          probes++;
          if ((await fixture.page()).status !== 200) refused++;
          await Bun.sleep(20);
        }
      })();
      let second = "";
      try {
        // A pull that changes the page and the package (not its serving
        // declaration): its build is swapped in by the explicit build.
        const pkgPath = join(fixture.site, "app/package.json");
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        pkg.description = "changed by the pull";
        await writeFile(pkgPath, JSON.stringify(pkg));
        second = await fixture.commit("two");
        const built = answer(await operations.build("alpha/site"));
        expect(built.outcome).toBe("built");
        await until(fixture.page, (page) => page.text === "<p>two</p>");
        await Bun.sleep(300);
      } finally {
        // A failed expectation must not leave the probe fetching into the
        // tests after this one.
        probing = false;
        await probe;
      }
      expect(probes).toBeGreaterThan(20);
      expect(refused).toBe(0);
      // Still the same healthy run of the static server, serving the new
      // build of the changed package.
      const status = answer(await operations.status("alpha/site"));
      expect(status).toMatchObject({ state: "running", healthy: true });
      expect(status.build).toMatchObject({
        mode: "built",
        served: { commit: second },
      });
      expect((await fixture.page("/_astro/app.one.js")).status).toBe(200);
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "an app first opened after the Launchpad started is watched at once: a commit is built and swapped in after the quiet, not at the next sweep (#559)",
  async () => {
    const home = join(root, "home-first-open");
    await mkdir(home);
    const fixture = await staticModule("first-open", home);
    const { operations } = fixture;
    try {
      // The Launchpad started and swept with nothing opened yet; its next
      // sweep is a minute away.
      const keeper = operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      await keeper?.sweep();
      await keeper?.settled();
      answer(await operations.start("alpha/site"));
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      const committed = performance.now();
      const second = await fixture.commit("two");
      const swapped = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" && status.build?.served?.commit === second,
        ),
      );
      expect(swapped.build?.served?.commit).toBe(second);
      // Well within the sweep's minute: the watch saw the commit.
      expect(performance.now() - committed).toBeLessThan(20_000);
      expect((await fixture.page()).text).toBe("<p>two</p>");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "an app first opened while a sweep reads the catalog stays watched when that sweep's catalog does not list it (#559, the review of #561)",
  async () => {
    const home = join(root, "home-interleave");
    await mkdir(home);
    // The sweep's catalog read waits on a gate and then answers without
    // the site: the sweep began before the site was opened.
    let gate: Promise<void> | null = null;
    let open: () => void = () => {};
    const fixture = await staticModule("interleave", home, {
      readCatalog: async (folder) => {
        const held = gate;
        if (held === null) return readFolderCatalog(folder);
        gate = null;
        await held;
        const catalog = await readFolderCatalog(folder);
        return {
          ...catalog,
          organizations: catalog.organizations.map((organization) => ({
            ...organization,
            modules: organization.modules.filter(
              (module) => module.module !== "site",
            ),
          })),
        };
      },
    });
    const { operations } = fixture;
    try {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const keeper = operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      // The first sweep holds its catalog read; the site is opened now.
      while (gate !== null) await Bun.sleep(10);
      answer(await operations.start("alpha/site"));
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      open();
      await keeper?.sweep();
      await keeper?.settled();
      // A commit is still built and swapped in after the quiet.
      const second = await fixture.commit("two");
      const swapped = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" && status.build?.served?.commit === second,
        ),
      );
      expect(swapped.build?.served?.commit).toBe(second);
      expect((await fixture.page()).text).toBe("<p>two</p>");
    } finally {
      open();
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

// The Launchpad's sweeps at chosen minutes of an injected clock, each one
// awaited with everything it started.
function sweepsOf(
  operations: ReturnType<typeof createModuleOperations>,
  seams: Readonly<{
    connected?: (port: number) => Promise<boolean | null>;
    running?: () => Promise<readonly RunningApp[] | null>;
    siblings?: (organizationDirectory: string) => Promise<ReadonlySet<string>>;
  }>,
) {
  let clock = 0;
  const keeper = operations.keepBuilt({
    quietMs: 100,
    sweepMs: 3_600_000,
    now: () => clock,
    ...seams,
  });
  return async (minute: number) => {
    clock = minute * 60_000;
    await keeper?.settled();
    await keeper?.sweep();
    await keeper?.settled();
  };
}

posixTest(
  "an app nobody uses falls asleep at a sweep after a tab's idle time without a connection: one with a connection stays, a connection meanwhile starts its clock again, a development run sleeps by the same rule, an explicit Stop stays as it was, and the gateway's ensure wakes it as its newest build (root decision 0195 point 23)",
  async () => {
    const home = join(root, "home-sleep");
    await mkdir(home);
    const fixture = await staticModule("sleep", home);
    const { operations } = fixture;
    // The ports with an open connection at the next sweep.
    const open = new Set<number>();
    const sweepAt = sweepsOf(operations, {
      connected: async (port) => open.has(port),
    });
    const state = async (name: string) =>
      answer(await operations.status(name)).state;
    try {
      await sweepAt(0);
      // site as its build, nobody uses it; next explicitly as its
      // development version, in use; plain (its development script) used
      // once, at minute 10.
      answer(await operations.start("alpha/site"));
      answer(await operations.start("alpha/next", { dev: true }));
      answer(await operations.start("alpha/plain"));
      await until(fixture.page, (page) => page.text === "<p>one</p>");
      open.add(fixture.port3);
      await sweepAt(0);
      await sweepAt(5);
      open.add(fixture.port2);
      await sweepAt(10);
      open.delete(fixture.port2);
      await sweepAt(15);
      expect(await state("alpha/site")).toBe("running");
      // Twenty minutes without a connection: asleep, which is stopped like
      // any app, with no record of its own.
      await sweepAt(20);
      expect(answer(await operations.status("alpha/site"))).toMatchObject({
        state: "stopped",
        outcome: "not-managed",
        healthy: false,
        build: { mode: null, current: { commit: fixture.head() } },
      });
      expect((await fixture.page()).status).toBe(0);
      expect(await state("alpha/plain")).toBe("running");
      expect(await state("alpha/next")).toBe("running");
      // A pull while it sleeps is built by the sweep, which starts nothing.
      const second = await fixture.commit("two");
      await sweepAt(25);
      const built = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.build?.current?.commit === second,
        ),
      );
      expect(built.state).toBe("stopped");
      // Used at minute 10: asleep at 30, not at 20.
      await sweepAt(30);
      expect(await state("alpha/plain")).toBe("stopped");
      expect(await state("alpha/next")).toBe("running");
      // A signed-in direct link: the gateway's ensure starts it again as
      // its newest build.
      const woken = answer(
        await until(
          () => operations.ensure("site", { mayStart: true, waitMs: 5_000 }),
          (result) => result.kind === "module" && result.healthy,
        ),
      );
      expect(woken.build).toMatchObject({
        mode: "built",
        served: { commit: second },
      });
      expect(await fixture.page()).toEqual({ status: 200, text: "<p>two</p>" });
      // An explicit Stop: stopped as it was, never started by a sweep.
      answer(await operations.start("alpha/plain"));
      expect(answer(await operations.stop("alpha/plain")).outcome).toBe(
        "group-stopped",
      );
      // The woken app's clock starts again; the development run, its
      // connection gone at 50, sleeps twenty minutes later.
      await sweepAt(35);
      await sweepAt(50);
      expect(await state("alpha/site")).toBe("running");
      open.delete(fixture.port3);
      await sweepAt(55);
      expect(await state("alpha/site")).toBe("stopped");
      expect(await state("alpha/next")).toBe("running");
      await sweepAt(70);
      expect(await state("alpha/next")).toBe("stopped");
      expect(await state("alpha/plain")).toBe("stopped");
    } finally {
      for (const name of ["alpha/site", "alpha/next", "alpha/plain"])
        await operations.stop(name);
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "an app the service manager runs that this Launchpad did not start (before its restart, or by the CLI) is found and sleeps too; unknown evidence counts as in use, and an app stopped and started again between two sweeps starts a new clock",
  async () => {
    const home = join(root, "home-found");
    await mkdir(home);
    const runner = createSessionRunner(binary);
    const fixture = await staticModule("found", home, { runner });
    // The owner that started it, and the Launchpad that runs now.
    const earlier = fixture.operations;
    const operations = createModuleOperations({
      folder: fixture.folder,
      owner: "launchpad",
      host: fixture.host,
    });
    let evidence: boolean | null = null;
    let listed: RunningApp[] = [];
    const sweepAt = sweepsOf(operations, {
      connected: async () => evidence,
      running: async () => listed,
    });
    const state = async () =>
      answer(await operations.status("alpha/plain")).state;
    try {
      const started = answer(await earlier.start("alpha/plain"));
      const plain = { org: "alpha", module: "plain", app: started.app };
      listed = [plain];
      await sweepAt(0);
      // Whether it has a connection cannot be told: in use.
      await sweepAt(30);
      evidence = false;
      await sweepAt(45);
      expect(await state()).toBe("running");
      // Stopped and started again outside this Launchpad: the manager did
      // not list it at minute 48, so it is found anew at 50.
      answer(await earlier.stop("alpha/plain"));
      listed = [];
      await sweepAt(48);
      answer(await earlier.start("alpha/plain"));
      listed = [plain];
      await sweepAt(50);
      await sweepAt(65);
      expect(await state()).toBe("running");
      await sweepAt(70);
      expect(await state()).toBe("stopped");
    } finally {
      await operations.close();
      await earlier.stop("alpha/plain");
      await earlier.close();
    }
  },
  120_000,
);

posixTest(
  "the sweep sees a real connection to the static server: held open, the app stays; closed, it sleeps (root decision 0195 point 23)",
  async () => {
    const home = join(root, "home-evidence");
    await mkdir(home);
    const fixture = await staticModule("evidence", home);
    const { operations } = fixture;
    // The product's own evidence (lsof); no request of this test keeps a
    // connection but the one it holds.
    const sweepAt = sweepsOf(operations, {});
    const state = async () =>
      answer(await operations.status("alpha/site")).state;
    let socket: ReturnType<typeof createConnection> | undefined;
    try {
      await sweepAt(0);
      answer(await operations.start("alpha/site"));
      await until(
        () => operations.status("alpha/site"),
        (status) => status.kind === "module" && status.healthy,
      );
      socket = createConnection({ host: "127.0.0.1", port: fixture.port });
      await new Promise((resolve) => socket?.once("connect", resolve));
      await sweepAt(0);
      await sweepAt(25);
      expect(await state()).toBe("running");
      // Last seen at 25: asleep at 45. The next sweep comes once lsof no
      // longer sees the closed connection.
      socket.destroy();
      await until(
        () => observeConnected(fixture.port),
        (connected) => connected === false,
      );
      await sweepAt(30);
      await sweepAt(40);
      expect(await state()).toBe("running");
      await sweepAt(45);
      expect(await state()).toBe("stopped");
    } finally {
      socket?.destroy();
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a sibling an app of its Organization declares never falls asleep: without a connection it runs past the idle time, also after its caller slept (root decisions 0176 and 0195 point 23)",
  async () => {
    const home = join(root, "home-sibling");
    await mkdir(home);
    // plain calls next at its loopback address.
    const fixture = await staticModule("sibling", home, {
      plain: { required_module_slots: ["workspace/next"] },
    });
    const { operations } = fixture;
    const sweepAt = sweepsOf(operations, { connected: async () => false });
    const state = async (name: string) =>
      answer(await operations.status(name)).state;
    try {
      await sweepAt(0);
      answer(await operations.start("alpha/next"));
      answer(await operations.start("alpha/plain"));
      await sweepAt(0);
      // Nobody connects to either: the caller sleeps, its sibling runs on.
      await sweepAt(20);
      expect(await state("alpha/plain")).toBe("stopped");
      expect(await state("alpha/next")).toBe("running");
      await sweepAt(45);
      await sweepAt(90);
      expect(await state("alpha/next")).toBe("running");
    } finally {
      await operations.stop("alpha/plain");
      await operations.stop("alpha/next");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a declaration that cannot be read keeps a declared sibling awake: unreadable is unknown, never declaring none (review of #573)",
  async () => {
    const home = join(root, "home-unreadable");
    await mkdir(home);
    const fixture = await staticModule("unreadable", home, {
      plain: { required_module_slots: ["workspace/next"] },
    });
    const { operations } = fixture;
    const sweepAt = sweepsOf(operations, { connected: async () => false });
    try {
      await sweepAt(0);
      answer(await operations.start("alpha/next"));
      // plain, which declares next, can no longer be read.
      await writeFile(join(fixture.site, "../plain/app/package.json"), "{");
      await sweepAt(0);
      await sweepAt(20);
      await sweepAt(45);
      expect(answer(await operations.status("alpha/next")).state).toBe(
        "running",
      );
    } finally {
      await operations.stop("alpha/next");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "an Open, or a Stop and a Start, while the sweep decides keeps the app running: the use is read again at the stop (review of #573)",
  async () => {
    const home = join(root, "home-race");
    await mkdir(home);
    const fixture = await staticModule("race", home);
    const { operations } = fixture;
    // The sweep's read of the declared siblings waits until released.
    let reading: () => void = () => {};
    let release: () => void = () => {};
    const sweepAt = sweepsOf(operations, {
      connected: async () => false,
      siblings: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
          reading();
        });
        return new Set<string>();
      },
    });
    const meanwhile = async (minute: number, act: () => Promise<void>) => {
      const read = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const sweeping = sweepAt(minute);
      await read;
      await act();
      release();
      await sweeping;
    };
    const state = async () =>
      answer(await operations.status("alpha/plain")).state;
    try {
      await sweepAt(0);
      answer(await operations.start("alpha/plain"));
      await sweepAt(0);
      // Due at 20: an Open while the sweep reads.
      await meanwhile(20, async () => {
        answer(await operations.start("alpha/plain"));
      });
      expect(await state()).toBe("running");
      // Due at 45: a Stop and a Start while the sweep reads.
      await sweepAt(25);
      await meanwhile(45, async () => {
        answer(await operations.stop("alpha/plain"));
        answer(await operations.start("alpha/plain"));
      });
      expect(await state()).toBe("running");
    } finally {
      release();
      await operations.stop("alpha/plain");
      await operations.close();
    }
  },
  120_000,
);

// Apps with their own server (decision F58, addendum of 2026-10-21; root
// decision 0195 point 24): site runs `start_script` from main, handed its
// client's build; its data is the module's data mount, which it reads at run
// time.

posixTest(
  "an app with its own server starts from main as its start_script in production mode, handed its client's build keyed by the module's commit; --dev runs its development script, which a build never replaces",
  async () => {
    const home = join(root, "home-server");
    await mkdir(home);
    const fixture = await staticModule("server", home, {
      server: true,
      dataMount: true,
    });
    const { operations } = fixture;
    try {
      const first = fixture.head();
      const started = answer(await operations.start("alpha/site"));
      expect(started.outcome).toBe("started");
      // The key is the module's commit alone, data mount or not.
      expect(started.build).toMatchObject({
        mode: "built",
        served: { key: first, commit: first },
        current: { key: first, commit: first, dirty: false },
        failure: null,
      });
      const served = await until(fixture.server, (page) => page !== null);
      expect(served).toMatchObject({
        mode: "production",
        page: "<p>one+d1</p>",
        data: "d1",
      });
      // The installed output of that key, outside the checkout.
      const cache = fixture.host.builds?.cacheRoot as string;
      expect(served?.output?.startsWith(`${cache}/alpha/site/`)).toBe(true);
      expect(served?.output?.endsWith(`/${first}`)).toBe(true);
      const healthy = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) => status.kind === "module" && status.healthy,
        ),
      );
      expect(healthy.runtime?.url).toBe(`http://127.0.0.1:${fixture.port}/`);
      // The start's background check, joined: the key is built.
      expect(answer(await operations.build("alpha/site")).outcome).toBe(
        "current",
      );
      // The development version, explicitly.
      const dev = answer(await operations.start("alpha/site", { dev: true }));
      expect(dev.build?.mode).toBe("dev");
      await until(fixture.page, (page) => page.text === "synthetic module");
      // A new commit builds, but never replaces the development run.
      const second = await fixture.commit("two");
      const built = answer(await operations.build("alpha/site"));
      expect(built.outcome).toBe("built");
      expect(built.build).toMatchObject({
        mode: "dev",
        current: { commit: second },
      });
      expect((await fixture.page()).text).toBe("synthetic module");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "after a pull an app's own server restarts onto its new build: a data-only pull neither builds nor restarts it, and a pull that changes only a dependency leaves it current until the restart (#570)",
  async () => {
    const home = join(root, "home-server-pull");
    await mkdir(home);
    const fixture = await staticModule("server-pull", home, {
      server: true,
      dataMount: true,
    });
    const { operations } = fixture;
    try {
      const first = fixture.head();
      answer(await operations.start("alpha/site"));
      const before = await until(fixture.server, (page) => page !== null);
      expect(answer(await operations.build("alpha/site")).outcome).toBe(
        "current",
      );
      const keeper = operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
      await keeper?.sweep();
      await keeper?.settled();
      // A data-only pull: the running server reads it; its client, keyed by
      // the module's commit, is not built again and the process stays.
      await fixture.publishData("d2");
      await Bun.sleep(300);
      await keeper?.sweep();
      await keeper?.settled();
      expect(await fixture.server()).toEqual({
        ...(before as NonNullable<typeof before>),
        data: "d2",
      });
      expect(answer(await operations.status("alpha/site")).build).toMatchObject(
        {
          served: { key: first },
          current: { key: first },
          building: null,
        },
      );
      // A pull that adds a dependency and changes nothing else; its build
      // waits, so the running server is read while it is still the old one.
      await fixture.hold();
      const app = join(fixture.site, "app");
      await mkdir(join(app, "two"));
      await writeFile(
        join(app, "two/package.json"),
        JSON.stringify({ name: "fixture-two", version: "1.0.0" }),
      );
      const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
      pkg.dependencies["fixture-two"] = "file:./two";
      await writeFile(join(app, "package.json"), JSON.stringify(pkg));
      const lockfile = Bun.spawn(
        [process.execPath, "install", "--lockfile-only"],
        {
          cwd: app,
          env: { HOME: home, PATH: "/usr/bin:/bin" },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(await lockfile.exited).toBe(0);
      fixture.git("add", "-A");
      fixture.git("commit", "-qm", "A dependency");
      const second = fixture.head();
      const building = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) =>
            status.kind === "module" &&
            status.build?.building?.commit === second,
        ),
      );
      // Still the running server of the first commit: healthy, with its link,
      // never "declaration changed".
      expect(building).toMatchObject({
        state: "running",
        healthy: true,
        runtime: { url: `http://127.0.0.1:${fixture.port}/` },
        build: { served: { commit: first } },
      });
      expect((await fixture.server())?.pid).toBe(before?.pid as number);
      // The build ends: the app is stopped and started onto it, a new
      // process handed the new client.
      await fixture.release();
      const restarted = await until(
        fixture.server,
        (page) => page !== null && page.pid !== before?.pid,
      );
      expect(restarted).toMatchObject({
        mode: "production",
        page: "<p>one+d2</p>",
      });
      expect(restarted?.output?.endsWith(`/${second}`)).toBe(true);
      await keeper?.settled();
      expect(
        answer(
          await until(
            () => operations.status("alpha/site"),
            (status) => status.kind === "module" && status.healthy,
          ),
        ).build,
      ).toMatchObject({
        mode: "built",
        served: { commit: second },
        current: { commit: second },
      });
    } finally {
      await fixture.release();
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a failed build keeps an app's own server running the version there was; a commit that builds but does not start ends, and its page offers the development version",
  async () => {
    const home = join(root, "home-server-fail");
    await mkdir(home);
    const fixture = await staticModule("server-fail", home, { server: true });
    const { operations } = fixture;
    try {
      const first = fixture.head();
      answer(await operations.start("alpha/site"));
      const before = await until(fixture.server, (page) => page !== null);
      expect(answer(await operations.build("alpha/site")).outcome).toBe(
        "current",
      );
      // A build that fails: no restart, the running version serves on.
      const failing = await fixture.commit("fail");
      expect(await operations.build("alpha/site")).toMatchObject({
        kind: "blocked",
        reason: "build-script-failed",
        build: {
          current: { commit: first },
          failure: { commit: failing, reason: "build-script-failed" },
        },
      });
      const serving = answer(await operations.status("alpha/site"));
      expect(serving).toMatchObject({
        healthy: true,
        build: { mode: "built", served: { commit: first } },
      });
      expect(moduleStatusView(serving, messages("cs")).buildNote).toBe(
        "Nejnovější verzi se nepodařilo sestavit. Dál běží předchozí verze.",
      );
      expect((await fixture.server())?.pid).toBe(before?.pid as number);
      // A commit whose client builds but whose server ends at its start.
      const crashing = await fixture.commit("crash");
      expect(answer(await operations.build("alpha/site")).outcome).toBe(
        "built",
      );
      const ended = answer(
        await until(
          () => operations.status("alpha/site"),
          (status) => status.kind === "module" && status.state === "ended",
        ),
      );
      expect(ended).toMatchObject({
        healthy: false,
        build: { mode: "built", served: { commit: crashing } },
      });
      expect(moduleStatusView(ended, messages("cs"))).toMatchObject({
        dot: "failed",
        action: "stop",
        development: true,
      });
      // The explicit development start.
      const dev = answer(await operations.start("alpha/site", { dev: true }));
      expect(dev).toMatchObject({ outcome: "started", build: { mode: "dev" } });
      await until(fixture.page, (page) => page.text === "synthetic module");
      expect((await fixture.page()).text).toBe("synthetic module");
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);
