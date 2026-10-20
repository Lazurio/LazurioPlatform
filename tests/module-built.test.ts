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
const page = readFileSync("page.txt", "utf8").trim();
if (page === "fail") process.exit(1);
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

async function staticModule(name: string, home: string) {
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
  });
  const commit = async (page: string) => {
    await writeFile(join(site, "app/page.txt"), `${page}\n`);
    git("commit", "-qam", page);
    return git("rev-parse", "HEAD");
  };
  return {
    operations,
    site,
    next,
    port,
    port2,
    port3,
    commit,
    head: () => git("rev-parse", "HEAD"),
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
  "the Launchpad keeps a static app built after a pull: a development run from before builds moves onto a build at its first sweep, and a commit is built and swapped in without a request",
  async () => {
    const home = join(root, "home-watch");
    await mkdir(home);
    const fixture = await staticModule("watch", home);
    const { operations } = fixture;
    try {
      // A development run from before builds existed: no build, no record.
      answer(await operations.start("alpha/site", { dev: true }));
      await until(fixture.page, (page) => page.text === "synthetic module");
      await rm(join(root, "watch", "cache"), { recursive: true, force: true });
      operations.keepBuilt({ quietMs: 100, sweepMs: 60_000 });
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
