import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { gitCheckoutReader } from "../src/modules/built/checkout";
import {
  type BunInstaller,
  type BunSystem,
  createModuleBunResolver,
  moduleBunRoot,
} from "../src/modules/bun-runtime";
import { runModuleCommand } from "../src/modules/module-cli";
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

// The Bun an App pins is that App's runtime (decision F62, root decision 0171
// addendum of 2026-10-24), on the real consumer: the module operations with
// real processes (the session runner and the compiled process guard). The
// npm distribution is a fake that lays out, for each version, a program
// named bun that logs every call, prints the version for --version and runs
// the real Bun otherwise; it exports LAZURIO_FIXTURE_BUN, so whatever a
// module process reports, it ran under that version. No network.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
let binary = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "module-bun-runtime-")));
  binary = join(root, "platform");
  await compilePlatform(binary);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const linuxArm: BunSystem = {
  platform: "linux",
  arch: "arm64",
  libc: "glibc",
  avx2: null,
};

function distribution(directory: string) {
  const offline = new Set<string>();
  const fetched: string[] = [];
  const install: BunInstaller = async (input) => {
    if (offline.has(input.version))
      return { kind: "refused", reason: "runtime-unavailable" };
    fetched.push(`${input.packageName}@${input.version}`);
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
        `LAZURIO_FIXTURE_BUN='${input.version}'; export LAZURIO_FIXTURE_BUN`,
        `exec '${process.execPath}' "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await chmod(program, 0o755);
    return { kind: "installed" };
  };
  return {
    install,
    offline,
    fetched,
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

// A module that reports, from its own process, the Bun it runs under and
// its PATH.
const reporter =
  'Bun.serve({ hostname: process.env.LAZURIO_RUNTIME_LISTENER_WEB_HOST, port: Number(process.env.LAZURIO_RUNTIME_LISTENER_WEB_PORT), fetch: () => Response.json({ bun: process.env.LAZURIO_FIXTURE_BUN ?? null, path: process.env.PATH ?? "" }) });';

// A static app's build (decision F58): its page names the checkout's
// page.txt and the Bun the build ran under.
const buildScript = `
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const page = readFileSync("page.txt", "utf8").trim();
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", "<p>" + page + " " + (process.env.LAZURIO_FIXTURE_BUN ?? "user") + "</p>");
`;

type Fixture = Readonly<{ id: string; pin: string; built?: boolean }>;

async function world(name: string, modules: readonly Fixture[]) {
  const parent = join(root, name);
  await mkdir(parent);
  const home = join(parent, "home");
  await mkdir(home);
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
    modules: modules.map(({ id }) => ({ id })),
  });
  const ports: Record<string, number> = {};
  const gits: Record<string, (...args: string[]) => string> = {};
  for (const module of modules) {
    const directory = join(organization, "workspace", module.id);
    ports[module.id] = await runnableModule(directory, home);
    const pkgPath = join(directory, "app/package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    pkg.packageManager = module.pin;
    await writeFile(join(directory, "app/server.ts"), reporter);
    if (module.built) {
      pkg.scripts.build = `"${process.execPath}" --no-env-file build.ts`;
      pkg.lazurio.runtime.build_script = "build";
      pkg.lazurio.runtime.build_output = "dist";
      await writeFile(join(directory, "app/build.ts"), buildScript);
      await writeFile(join(directory, "app/page.txt"), "one\n");
      await writeFile(join(directory, ".gitignore"), "node_modules/\ndist/\n");
    }
    await writeFile(pkgPath, JSON.stringify(pkg));
    if (module.built) {
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
      gits[module.id] = git;
    }
  }
  const npm = distribution(parent);
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
    resolveBun: createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: npm.install,
      system: async () => linuxArm,
      freeBytes: async () => 10 * 1024 ** 3,
    }),
  };
  const operations = createModuleOperations({
    folder,
    owner: "launchpad",
    host,
  });
  const git = (id: string) => gits[id] as (...args: string[]) => string;
  return {
    operations,
    npm,
    home,
    folder,
    host,
    app: (id: string) => join(organization, "workspace", id, "app"),
    /** What the app's own process reports, or null while nothing answers. */
    report: (id: string) =>
      fetch(`http://127.0.0.1:${ports[id]}/`)
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ bun: string | null; path: string }>)
            : null,
        )
        .catch(() => null),
    page: (id: string) =>
      fetch(`http://127.0.0.1:${ports[id]}/`)
        .then((response) => response.text())
        .catch(() => ""),
    head: (id: string) => git(id)("rev-parse", "HEAD"),
    commit: async (id: string, page: string) => {
      await writeFile(
        join(organization, "workspace", id, "app/page.txt"),
        `${page}\n`,
      );
      git(id)("commit", "-qam", page);
      return git(id)("rev-parse", "HEAD");
    },
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

const runtimeBin = (home: string, version: string) =>
  join(
    moduleBunRoot(home),
    version,
    "node_modules",
    "@oven",
    "bun-linux-aarch64",
    "bin",
  );

posixTest(
  "Apps with different pins run side by side, each prepared and started with its own Bun first on its PATH; an App whose pin is the user's Bun downloads nothing and keeps its PATH",
  async () => {
    const w = await world("side-by-side", [
      { id: "older", pin: "bun@1.4.98" },
      { id: "newer", pin: "bun@1.4.99" },
      { id: "same", pin: `bun@${Bun.version}` },
    ]);
    const { operations } = w;
    try {
      // An explicit preparation installs and checks with the pinned Bun.
      expect(answer(await operations.prepare("alpha/newer")).outcome).toBe(
        "prepared",
      );
      expect(await w.npm.calls("1.4.99")).toEqual([
        expect.stringMatching(/^--no-env-file install --frozen-lockfile\b/),
        "--no-env-file run check",
      ]);
      for (const id of ["older", "newer", "same"])
        expect(answer(await operations.start(`alpha/${id}`)).outcome).toBe(
          "started",
        );
      const reports = Object.fromEntries(
        await Promise.all(
          ["older", "newer", "same"].map(async (id) => [
            id,
            await until(
              () => w.report(id),
              (value) => value !== null,
            ),
          ]),
        ),
      );
      expect(reports.older?.bun).toBe("1.4.98");
      expect(reports.newer?.bun).toBe("1.4.99");
      expect(reports.same?.bun).toBeNull();
      // Its own version's directory ahead of the user's PATH, so nested
      // `bun` and `bunx` are that version too.
      for (const [id, version] of [
        ["older", "1.4.98"],
        ["newer", "1.4.99"],
      ] as const) {
        const path = (reports[id]?.path ?? "").split(":");
        const own = path.indexOf(runtimeBin(w.home, version));
        expect(own).toBeGreaterThanOrEqual(0);
        expect(own).toBeLessThan(path.indexOf("/usr/bin"));
      }
      expect(
        (reports.same?.path ?? "")
          .split(":")
          .some((entry: string) => entry.startsWith(moduleBunRoot(w.home))),
      ).toBe(false);
      // Fetched once each; nothing for the App on the user's Bun.
      expect([...w.npm.fetched].sort()).toEqual([
        "@oven/bun-linux-aarch64@1.4.98",
        "@oven/bun-linux-aarch64@1.4.99",
      ]);
      // The start's own step (the install, the check) and the app itself
      // ran with the pinned Bun.
      expect((await w.npm.calls("1.4.99")).slice(2)).toEqual([
        expect.stringMatching(/^--no-env-file install --frozen-lockfile\b/),
        "--no-env-file run check",
        "--no-env-file run dev",
      ]);
      // Stopped and started again: from the cache, nothing downloaded.
      expect(answer(await operations.stop("alpha/newer")).outcome).toBe(
        "group-stopped",
      );
      expect(answer(await operations.start("alpha/newer")).outcome).toBe(
        "started",
      );
      expect(
        (
          await until(
            () => w.report("newer"),
            (value) => value !== null,
          )
        )?.bun,
      ).toBe("1.4.99");
      expect(w.npm.fetched).toHaveLength(2);
    } finally {
      for (const id of ["older", "newer", "same"])
        await operations.stop(`alpha/${id}`);
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a pinned version that cannot be fetched refuses the start and the preparation with its reason and the package that pins it, starts and keeps nothing; once it can be fetched the same start runs it",
  async () => {
    const w = await world("refused", [{ id: "offline", pin: "bun@1.4.97" }]);
    const { operations } = w;
    w.npm.offline.add("1.4.97");
    try {
      const where = {
        kind: "blocked",
        reason: "runtime-unavailable",
        organization: "alpha",
        module: "offline",
        app: "app/package.json",
        file: "app/package.json",
      } as const;
      expect(await operations.start("alpha/offline")).toEqual({
        ...where,
        operation: "start",
      });
      expect(await operations.prepare("alpha/offline")).toEqual({
        ...where,
        operation: "prepare",
      });
      expect(await w.report("offline")).toBeNull();
      expect(await w.npm.calls("1.4.97")).toEqual([]);
      // Nothing kept, nothing left over of the fetch.
      expect(await readdir(moduleBunRoot(w.home))).toEqual([]);
      w.npm.offline.delete("1.4.97");
      expect(answer(await operations.start("alpha/offline")).outcome).toBe(
        "started",
      );
      expect(
        (
          await until(
            () => w.report("offline"),
            (value) => value !== null,
          )
        )?.bun,
      ).toBe("1.4.97");
    } finally {
      await operations.stop("alpha/offline");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "a built app pinned to another Bun builds with it when opened, after a pull in the background and by lazurio module build, while the Platform's static server stays on the operator's Bun; a build whose runtime could not be fetched is built by the next sweep with nobody present",
  async () => {
    const w = await world("built", [
      { id: "site", pin: "bun@1.4.99", built: true },
      { id: "next", pin: "bun@1.4.99", built: true },
      { id: "later", pin: "bun@1.4.96", built: true },
    ]);
    const { operations } = w;
    const builds = async () =>
      (await w.npm.calls("1.4.99")).filter(
        (line) => line === "--no-env-file run build",
      ).length;
    try {
      const first = w.head("site");
      expect(answer(await operations.start("alpha/site")).build).toMatchObject({
        mode: "built",
        served: { commit: first },
      });
      expect(
        await until(
          () => w.page("site"),
          (page) => page === "<p>one 1.4.99</p>",
        ),
      ).toBe("<p>one 1.4.99</p>");
      expect(await builds()).toBe(1);
      // The static server is the Platform's own process: never this App's
      // Bun.
      expect(
        (await w.npm.calls("1.4.99")).some((line) =>
          line.includes("static-server"),
        ),
      ).toBe(false);
      // `lazurio module build` of an app never opened (no start of its own
      // refreshes it in the background meanwhile).
      const next = answer(await operations.build("alpha/next"));
      expect(next.outcome).toBe("built");
      expect(next.build?.current?.commit).toBe(w.head("next"));
      expect(await builds()).toBe(2);
      // A pull: the Launchpad's watch builds it in the background, with the
      // pinned Bun, and swaps it in.
      const keeper = operations.keepBuilt({
        quietMs: 100,
        sweepMs: 3_600_000,
      });
      await w.commit("site", "two");
      expect(
        await until(
          () => w.page("site"),
          (page) => page === "<p>two 1.4.99</p>",
        ),
      ).toBe("<p>two 1.4.99</p>");
      expect(await builds()).toBe(3);
      expect(w.npm.fetched).toEqual(["@oven/bun-linux-aarch64@1.4.99"]);
      // A runtime that cannot be fetched: the build fails with the typed
      // reason, recorded as the app's build state…
      w.npm.offline.add("1.4.96");
      const later = w.head("later");
      expect(await operations.start("alpha/later")).toMatchObject({
        kind: "blocked",
        operation: "start",
        reason: "runtime-unavailable",
        file: "app/package.json",
        build: {
          current: null,
          failure: { commit: later, reason: "runtime-unavailable" },
        },
      });
      expect(
        answer(await operations.status("alpha/later")).build?.failure?.reason,
      ).toBe("runtime-unavailable");
      // …and the next sweep, which asks nobody, builds it once the registry
      // answers.
      w.npm.offline.delete("1.4.96");
      await keeper?.sweep();
      const built = answer(
        await until(
          () => operations.status("alpha/later"),
          (status) => status.kind === "module" && status.build?.current != null,
        ),
      );
      expect(built.build).toMatchObject({
        current: { commit: later },
        failure: null,
      });
      expect(
        (await w.npm.calls("1.4.96")).filter(
          (line) => line === "--no-env-file run build",
        ),
      ).toHaveLength(1);
    } finally {
      await operations.stop("alpha/site");
      await operations.close();
    }
  },
  120_000,
);

posixTest(
  "lazurio module build of an App whose pinned Bun cannot be fetched names the reason, the package that pins it and why",
  async () => {
    // No Launchpad holds this world's apps: the CLI builds beside none.
    const w = await world("cli", [
      { id: "later", pin: "bun@1.4.95", built: true },
    ]);
    w.npm.offline.add("1.4.95");
    try {
      const cli = await runModuleCommand(
        ["module", "build", "alpha/later", "--folder", w.folder],
        {
          identity: {
            version: "1.0.0",
            commit: "0".repeat(40),
            target: "fixture",
          },
          platform: process.platform,
          env: { HOME: w.home },
          executable: join(w.home, "lazurio"),
          hostedFolder: async () => undefined,
        },
        w.host,
      );
      expect(cli.code).toBe(2);
      expect(cli.text).toContain("runtime-unavailable (app/package.json)");
      expect(cli.text).toContain("could not be downloaded");
      expect(cli.result).toMatchObject({
        kind: "blocked",
        operation: "build",
        reason: "runtime-unavailable",
        build: { failure: { reason: "runtime-unavailable" } },
      });
    } finally {
      await w.operations.close();
    }
  },
  120_000,
);
