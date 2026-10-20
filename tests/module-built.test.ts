import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { gitCheckoutReader } from "../src/modules/built/checkout";
import {
  createModuleOperations,
  type ModuleAnswer,
  type ModuleBlocked,
  type ModuleHost,
} from "../src/modules/module-operations";
import { createSessionRunner } from "../src/modules/session-runner";
import { type Catalog, readFolderCatalog } from "../src/organizations/catalog";
import { writeOrganization } from "./fixtures/catalog-folder";
import { compilePlatform, runnableModule } from "./fixtures/module-host";
import { mkdirOwnedFixture as mkdir } from "./fixtures/owned-files";

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

// A module made static: its build script and page, and its own Git
// repository; returns the repository's git.
async function makeStatic(directory: string) {
  const pkgPath = join(directory, "app/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  pkg.scripts.build = `"${process.execPath}" --no-env-file build.ts`;
  pkg.lazurio.runtime.build_script = "build";
  pkg.lazurio.runtime.build_output = "dist";
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
    modules: [{ id: "site" }, { id: "plain" }, { id: "next" }],
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
  const git = await makeStatic(site);
  await makeStatic(next);
  const host: ModuleHost = {
    platform: process.platform,
    home,
    path: "/usr/bin:/bin",
    runtimeDirectory: undefined,
    platformExecutable: binary,
    bunExecutable: process.execPath,
    runnerKind: async () => "session",
    createRunner: () => createSessionRunner(binary),
    readJournal: async () => ({ kind: "unavailable" }) as const,
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
    folder,
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
      // A pull that changes the page and the package (not its serving
      // declaration): its build is swapped in by the explicit build.
      const pkgPath = join(fixture.site, "app/package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      pkg.description = "changed by the pull";
      await writeFile(pkgPath, JSON.stringify(pkg));
      const second = await fixture.commit("two");
      const built = answer(await operations.build("alpha/site"));
      expect(built.outcome).toBe("built");
      await until(fixture.page, (page) => page.text === "<p>two</p>");
      await Bun.sleep(300);
      probing = false;
      await probe;
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
