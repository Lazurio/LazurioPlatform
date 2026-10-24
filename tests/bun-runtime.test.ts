import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type BunInstaller,
  type BunInstallInput,
  type BunSystem,
  bunInstaller,
  bunTargets,
  createModuleBunResolver,
  type ModuleBun,
  moduleBunRoot,
  prewarmModuleRuntimes,
  runtimeFreeBytesMin,
  withModuleBun,
} from "../src/modules/bun-runtime";
import { PreparationRefused } from "../src/modules/preparation-refusal";
import { acquireFileLock } from "../src/platform/flock";

// The Bun an App pins is that App's runtime (decision F62, root decision 0171
// addendum of 2026-10-24): the user's Bun when it is exactly that version,
// otherwise the runtime cache under the user's home, otherwise a verified
// fetch with Bun's own installer. Every case runs without the network: an
// injected installer lays out the package Bun's installer would, and the
// real `bun add` runs only against a registry on the loopback interface. One
// opt-in case (LAZURIO_TEST_NETWORK=1) fetches a real Bun from npm.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let root = "";
beforeAll(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "bun-runtime-")));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const plenty = async () => 10 * 1024 ** 3;
/** A fixed system, so that every machine resolves the same package names;
 * the fake binaries are shell scripts and run anywhere. */
const linuxArm: BunSystem = {
  platform: "linux",
  arch: "arm64",
  libc: "glibc",
  avx2: null,
};

async function place(name: string) {
  const directory = join(root, name);
  const home = join(directory, "home");
  const owner = join(directory, "module", "app");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(owner, { recursive: true });
  return { directory, home, owner, file: join(owner, "package.json") };
}

/** A program named bun: `--version` prints `version`; anything else runs
 * the real Bun with `LAZURIO_FIXTURE_BUN` naming the version. `broken`
 * cannot run at all (as a build for another CPU). */
async function fakeBun(
  path: string,
  version: string,
  mode: "runs" | "broken" = "runs",
) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    mode === "broken"
      ? "#!/bin/sh\nexit 132\n"
      : [
          "#!/bin/sh",
          `if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi`,
          `LAZURIO_FIXTURE_BUN='${version}'; export LAZURIO_FIXTURE_BUN`,
          `exec '${process.execPath}' "$@"`,
          "",
        ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
}

/** Bun's installer as the resolver sees it: what it was asked for, whether
 * its private directory was a project of its own when it ran, and the
 * package it lays out (or the refusal it answers). */
function fakeInstaller(
  options: {
    refuse?: (input: BunInstallInput) => string | undefined;
    reports?: (input: BunInstallInput) => string | "broken";
    gate?: () => Promise<void>;
  } = {},
) {
  const calls: (BunInstallInput & { ownProject: boolean })[] = [];
  const install: BunInstaller = async (input) => {
    calls.push({
      ...input,
      ownProject: existsSync(join(input.directory, "package.json")),
    });
    await options.gate?.();
    const refused = options.refuse?.(input);
    if (refused !== undefined)
      return { kind: "refused", reason: refused } as Awaited<
        ReturnType<BunInstaller>
      >;
    const reported = options.reports?.(input) ?? input.version;
    await fakeBun(
      join(input.directory, "node_modules", input.packageName, "bin", "bun"),
      reported === "broken" ? input.version : reported,
      reported === "broken" ? "broken" : "runs",
    );
    return { kind: "installed" };
  };
  return { install, calls };
}

const refusalOf = async (
  pending: Promise<ModuleBun>,
): Promise<{ reason: string; path: string }> => {
  const error = await pending.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof PreparationRefused))
    throw new Error(`Expected a refusal, got ${String(error)}`);
  return { reason: error.reason, path: error.path };
};

const cachedExecutable = (home: string, version: string, target: string) =>
  join(
    moduleBunRoot(home),
    version,
    "node_modules",
    "@oven",
    `bun-${target}`,
    "bin",
    "bun",
  );

const run = (executable: string, args: string[], env = {}) =>
  execFileSync(executable, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...env },
  }).trim();

posixTest(
  "an App whose pin is the user's Bun gets the user's Bun and nothing is downloaded; a package that pins none keeps the user's Bun (decision F25)",
  async () => {
    const { home, owner } = await place("same");
    const fake = fakeInstaller();
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: fake.install,
      system: async () => linuxArm,
      freeBytes: plenty,
    });
    const user: ModuleBun = {
      executable: process.execPath,
      binDir: null,
      source: "user",
    };
    expect(
      await resolve({ packageManager: `bun@${Bun.version}`, owner }),
    ).toEqual(user);
    expect(await resolve({ packageManager: null, owner })).toEqual(user);
    expect(fake.calls).toEqual([]);
    expect(existsSync(moduleBunRoot(home))).toBe(false);
    // Its process environment stays exactly as it is.
    const env = { HOME: home, PATH: "/usr/bin:/bin", BUN_OPTIONS: "--x" };
    expect(withModuleBun(env, user)).toEqual(env);
  },
);

posixTest(
  "another version is fetched once with Bun's own installer into the runtime cache, verified by its version and kept: the next resolution downloads nothing",
  async () => {
    const { home, owner } = await place("fetch");
    const fake = fakeInstaller();
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: fake.install,
      system: async () => linuxArm,
      freeBytes: plenty,
    });
    const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable,
      binDir: dirname(executable),
      source: "fetched",
    });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0] as (typeof fake.calls)[number];
    expect(call).toMatchObject({
      installer: process.execPath,
      packageName: "@oven/bun-linux-aarch64",
      version: "1.4.99",
      path: "/usr/bin:/bin",
      // Its own project: `bun add` never walks up to a package.json above.
      ownProject: true,
    });
    // A private directory beside the cache, with a home and a cache of its
    // own: nothing of the user's Bun or npm configuration or cache.
    const runtimes = moduleBunRoot(home);
    expect(runtimes).toBe(join(home, ".local/share/lazurio/runtimes/bun"));
    expect(dirname(call.directory)).toBe(runtimes);
    expect(basename(call.directory).startsWith(".tmp-")).toBe(true);
    expect(call.home.startsWith(`${call.directory}/`)).toBe(true);
    expect(call.cache.startsWith(`${call.directory}/`)).toBe(true);
    // Placed whole: only the version's directory, no private directory left,
    // nor its home and cache inside it.
    expect(await readdir(runtimes)).toEqual(["1.4.99"]);
    for (const leftover of ["home", "cache"])
      expect(existsSync(join(runtimes, "1.4.99", leftover))).toBe(false);
    expect(run(executable, ["--version"])).toBe("1.4.99");
    // `bunx` beside it is the same version; with its directory first on
    // PATH, nested `bun` and `bun x` are too.
    expect(await readlink(join(dirname(executable), "bunx"))).toBe("bun");
    expect(
      withModuleBun(
        { HOME: home, PATH: `/usr/bin:${dirname(executable)}:/bin` },
        { executable, binDir: dirname(executable), source: "cache" },
      ),
    ).toEqual({ HOME: home, PATH: `${dirname(executable)}:/usr/bin:/bin` });
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable,
      binDir: dirname(executable),
      source: "cache",
    });
    expect(fake.calls).toHaveLength(1);
    // Never written into the user's own tools.
    expect(existsSync(join(home, ".local/bin"))).toBe(false);
    expect(existsSync(join(home, ".bun"))).toBe(false);
  },
);

posixTest(
  "a version that cannot be fetched is a typed refusal named by the package that pins it, never another version: offline, an integrity failure, a wrong version reported, an unknown version, a full disk",
  async () => {
    const cases: [string, Parameters<typeof fakeInstaller>[0], number?][] = [
      ["runtime-unavailable", { refuse: () => "runtime-unavailable" }],
      [
        "runtime-integrity-failed",
        { refuse: () => "runtime-integrity-failed" },
      ],
      // Installed, but the program says another version.
      ["runtime-integrity-failed", { reports: () => "1.4.98" }],
      ["runtime-version-unknown", { refuse: () => "runtime-version-unknown" }],
      // Less than the minimum free: nothing is downloaded.
      ["runtime-disk-full", {}, runtimeFreeBytesMin - 1],
    ];
    for (const [index, [reason, options, free]] of cases.entries()) {
      const { home, owner, file } = await place(`refused-${index}`);
      const fake = fakeInstaller(options);
      const resolve = createModuleBunResolver({
        home,
        userBun: process.execPath,
        path: "/usr/bin:/bin",
        install: fake.install,
        system: async () => linuxArm,
        freeBytes: async () => free ?? 10 * 1024 ** 3,
      });
      expect(
        await refusalOf(resolve({ packageManager: "bun@1.4.99", owner })),
      ).toEqual({ reason, path: file });
      expect(fake.calls).toHaveLength(reason === "runtime-disk-full" ? 0 : 1);
      // Nothing kept and nothing left behind; the user's Bun is untouched.
      expect(await readdir(moduleBunRoot(home))).toEqual([]);
    }
  },
);

test("the package of Bun's npm distribution for each system, the baseline build for an x64 CPU without AVX2, and a typed refusal for every other system", () => {
  const system = (overrides: Partial<BunSystem>): BunSystem => ({
    platform: "linux",
    arch: "x64",
    libc: "glibc",
    avx2: null,
    ...overrides,
  });
  const bun = (name: string) => ({ name, executable: "bun" as const });
  const exe = (name: string) => ({ name, executable: "bun.exe" as const });
  expect(
    bunTargets(
      system({ platform: "darwin", arch: "arm64", libc: null }),
      "1.4.3",
    ),
  ).toEqual([bun("darwin-aarch64")]);
  // Elsewhere than Linux the plain build first, its baseline when it does
  // not run.
  expect(
    bunTargets(system({ platform: "darwin", libc: null }), "1.4.3"),
  ).toEqual([bun("darwin-x64"), bun("darwin-x64-baseline")]);
  // On Linux /proc/cpuinfo decides up front; unreadable, as elsewhere.
  expect(bunTargets(system({ avx2: true }), "1.4.3")).toEqual([
    bun("linux-x64"),
  ]);
  expect(bunTargets(system({ avx2: false }), "1.4.3")).toEqual([
    bun("linux-x64-baseline"),
  ]);
  expect(bunTargets(system({}), "1.4.3")).toEqual([
    bun("linux-x64"),
    bun("linux-x64-baseline"),
  ]);
  expect(bunTargets(system({ arch: "arm64" }), "1.4.3")).toEqual([
    bun("linux-aarch64"),
  ]);
  expect(
    bunTargets(system({ platform: "win32", libc: null }), "1.4.3"),
  ).toEqual([exe("windows-x64"), exe("windows-x64-baseline")]);
  expect(
    bunTargets(
      system({ platform: "win32", arch: "arm64", libc: null }),
      "1.3.10",
    ),
  ).toEqual([exe("windows-aarch64")]);
  // Windows on ARM from Bun 1.3.10 only; Linux with musl, FreeBSD and every
  // other system are refused for now.
  for (const [overrides, version] of [
    [{ platform: "win32", arch: "arm64", libc: null }, "1.3.9"],
    [{ libc: "musl" }, "1.4.3"],
    [{ arch: "arm64", libc: "musl" }, "1.4.3"],
    [{ platform: "freebsd", libc: null }, "1.4.3"],
    [{ arch: "ia32" }, "1.4.3"],
  ] as const)
    expect(bunTargets(system(overrides), version)).toBeNull();
});

posixTest(
  "an unsupported system is refused before anything is downloaded; a plain x64 build that does not run is replaced by its baseline once, and on Linux without AVX2 only the baseline is fetched",
  async () => {
    const { home, owner, file } = await place("systems");
    const unsupported = fakeInstaller();
    expect(
      await refusalOf(
        createModuleBunResolver({
          home,
          userBun: process.execPath,
          path: "/usr/bin:/bin",
          install: unsupported.install,
          system: async () => ({
            platform: "freebsd",
            arch: "x64",
            libc: null,
            avx2: null,
          }),
          freeBytes: plenty,
        })({ packageManager: "bun@1.4.99", owner }),
      ),
    ).toEqual({ reason: "runtime-unsupported-platform", path: file });
    expect(unsupported.calls).toEqual([]);
    // macOS on an Intel CPU without AVX2: the plain build cannot run.
    const intel = fakeInstaller({
      reports: (input) =>
        input.packageName.endsWith("-baseline") ? input.version : "broken",
    });
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: intel.install,
      system: async () => ({
        platform: "darwin",
        arch: "x64",
        libc: null,
        avx2: null,
      }),
      freeBytes: plenty,
    });
    const baseline = cachedExecutable(home, "1.4.99", "darwin-x64-baseline");
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable: baseline,
      binDir: dirname(baseline),
      source: "fetched",
    });
    expect(intel.calls.map((call) => call.packageName)).toEqual([
      "@oven/bun-darwin-x64",
      "@oven/bun-darwin-x64-baseline",
    ]);
    expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
      executable: baseline,
      binDir: dirname(baseline),
      source: "cache",
    });
    expect(intel.calls).toHaveLength(2);
    // A build that does not run where there is no baseline to try.
    const arm = await place("systems-arm");
    const broken = fakeInstaller({ reports: () => "broken" });
    expect(
      await refusalOf(
        createModuleBunResolver({
          home: arm.home,
          userBun: process.execPath,
          path: "/usr/bin:/bin",
          install: broken.install,
          system: async () => linuxArm,
          freeBytes: plenty,
        })({ packageManager: "bun@1.4.99", owner: arm.owner }),
      ),
    ).toEqual({ reason: "runtime-unsupported-platform", path: arm.file });
    expect(await readdir(moduleBunRoot(arm.home))).toEqual([]);
    // Linux without AVX2: decided up front.
    const old = await place("systems-old");
    const plain = fakeInstaller();
    await createModuleBunResolver({
      home: old.home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: plain.install,
      system: async () => ({
        platform: "linux",
        arch: "x64",
        libc: "glibc",
        avx2: false,
      }),
      freeBytes: plenty,
    })({ packageManager: "bun@1.4.99", owner: old.owner });
    expect(plain.calls.map((call) => call.packageName)).toEqual([
      "@oven/bun-linux-x64-baseline",
    ]);
  },
);

posixTest(
  "concurrent resolutions of one version fetch it once in a process; two processes racing both get it, the first placed copy is kept and the other discarded",
  async () => {
    const { home, owner } = await place("concurrent");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeInstaller({ gate: () => gate });
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: fake.install,
      system: async () => linuxArm,
      freeBytes: plenty,
    });
    const pending = Array.from({ length: 5 }, () =>
      resolve({ packageManager: "bun@1.4.99", owner }),
    );
    await Bun.sleep(100);
    release();
    const results = await Promise.all(pending);
    const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
    for (const result of results) expect(result.executable).toBe(executable);
    expect(fake.calls).toHaveLength(1);
    // Two processes: each its own in-flight fetches, one cache. The first
    // fetches under the version's exclusion; the second waits for it and
    // then reads the placed copy, so the version is fetched once.
    const racing = await place("racing");
    const fetched = gated();
    const racer = fakeInstaller({ gate: () => fetched.wait });
    const locks = countedLock();
    const processes = [0, 1].map(() =>
      createModuleBunResolver({
        home: racing.home,
        userBun: process.execPath,
        path: "/usr/bin:/bin",
        install: racer.install,
        system: async () => linuxArm,
        freeBytes: plenty,
        fetches: new Map(),
        lock: locks.lock,
      }),
    );
    const first = processes[0]?.({
      packageManager: "bun@1.4.99",
      owner: racing.owner,
    });
    await until(() => racer.calls.length === 1);
    const second = processes[1]?.({
      packageManager: "bun@1.4.99",
      owner: racing.owner,
    });
    await until(() => locks.attempts === 2);
    fetched.open();
    const raced = await Promise.all([first, second]);
    const placed = cachedExecutable(racing.home, "1.4.99", "linux-aarch64");
    expect(racer.calls).toHaveLength(1);
    for (const result of raced) expect(result?.executable).toBe(placed);
    expect(raced.map((result) => result?.source)).toEqual(["fetched", "cache"]);
    expect(run(placed, ["--version"])).toBe("1.4.99");
    expect(await readdir(moduleBunRoot(racing.home))).toEqual(["1.4.99"]);
  },
);

posixTest(
  "two processes repairing one broken cached version at once: one moves it aside and places a fetched copy, the other waits and reads that copy, and neither removes the replacement",
  async () => {
    const { home, owner } = await place("repair-race");
    const versionDirectory = join(moduleBunRoot(home), "1.4.99");
    // A broken copy: its program says another version.
    await fakeBun(
      join(
        versionDirectory,
        "node_modules",
        "@oven",
        "bun-linux-aarch64",
        "bin",
        "bun",
      ),
      "1.4.97",
    );
    const fetched = gated();
    const fake = fakeInstaller({ gate: () => fetched.wait });
    const locks = countedLock();
    const [repairing, waiting] = [0, 1].map(() =>
      createModuleBunResolver({
        home,
        userBun: process.execPath,
        path: "/usr/bin:/bin",
        install: fake.install,
        system: async () => linuxArm,
        freeBytes: plenty,
        fetches: new Map(),
        lock: locks.lock,
      }),
    );
    const first = repairing?.({ packageManager: "bun@1.4.99", owner });
    // The first holds the exclusion, has moved the broken copy aside and is
    // fetching; the second sees no ready copy and waits for the exclusion.
    await until(() => fake.calls.length === 1);
    const second = waiting?.({ packageManager: "bun@1.4.99", owner });
    await until(() => locks.attempts === 2);
    fetched.open();
    const placed = await first;
    const identity = await lstat(versionDirectory);
    const read = await second;
    const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
    expect(placed?.executable).toBe(executable);
    expect(read?.executable).toBe(executable);
    expect([placed?.source, read?.source]).toEqual(["fetched", "cache"]);
    // The copy the first placed (and handed out) is the one still there.
    const after = await lstat(versionDirectory);
    expect(`${after.dev}:${after.ino}`).toBe(`${identity.dev}:${identity.ino}`);
    expect(run(executable, ["--version"])).toBe("1.4.99");
    expect(fake.calls).toHaveLength(1);
    expect(await readdir(moduleBunRoot(home))).toEqual(["1.4.99"]);
  },
);

/** A gate a test opens. */
function gated() {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/** The real exclusion, counting how often it was asked for. */
function countedLock() {
  const counted = {
    attempts: 0,
    lock: async (path: string, timeoutMs: number) => {
      counted.attempts++;
      return acquireFileLock(path, { timeoutMs });
    },
  };
  return counted;
}

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await Bun.sleep(10);
  }
}

posixTest(
  "a cached version whose program does not run or says another version is fetched again once, never in a loop",
  async () => {
    const { home, owner, file } = await place("corrupt");
    let reports = "1.4.99";
    const fake = fakeInstaller({ reports: () => reports });
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: fake.install,
      system: async () => linuxArm,
      freeBytes: plenty,
    });
    const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
    await resolve({ packageManager: "bun@1.4.99", owner });
    for (const corruption of ["broken", "1.4.97"] as const) {
      await fakeBun(
        executable,
        "1.4.97",
        corruption === "broken" ? "broken" : "runs",
      );
      const calls = fake.calls.length;
      expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
        executable,
        binDir: dirname(executable),
        source: "fetched",
      });
      expect(fake.calls).toHaveLength(calls + 1);
      expect(run(executable, ["--version"])).toBe("1.4.99");
    }
    // A fetch again that gives a wrong program too: refused, one fetch.
    await fakeBun(executable, "1.4.97");
    reports = "1.4.96";
    const calls = fake.calls.length;
    expect(
      await refusalOf(resolve({ packageManager: "bun@1.4.99", owner })),
    ).toEqual({ reason: "runtime-integrity-failed", path: file });
    expect(fake.calls).toHaveLength(calls + 1);
    expect(await readdir(moduleBunRoot(home))).toEqual([]);
  },
);

posixTest(
  "a pre-warm (root decision 0212) makes each distinct pinned Bun available with the resolver a start uses: one result per pin, cached, fetched or refused with the start's reason, never a throw",
  async () => {
    const { home, owner } = await place("prewarm");
    const fake = fakeInstaller({
      refuse: (input) =>
        input.version === "1.4.98" ? "runtime-version-unknown" : undefined,
    });
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
      install: fake.install,
      system: async () => linuxArm,
      freeBytes: plenty,
    });
    const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
    expect(
      await prewarmModuleRuntimes(resolve, [
        "bun@1.4.99",
        null,
        "bun@1.4.99",
        `bun@${Bun.version}`,
        "bun@1.4.98",
        "npm@10.0.0",
      ]),
    ).toEqual([
      { packageManager: "bun@1.4.99", kind: "fetched", executable },
      {
        packageManager: `bun@${Bun.version}`,
        kind: "cached",
        executable: process.execPath,
      },
      {
        packageManager: "bun@1.4.98",
        kind: "refused",
        reason: "runtime-version-unknown",
      },
      {
        packageManager: "npm@10.0.0",
        kind: "refused",
        reason: "preparation-package-manager-unsupported",
      },
    ]);
    expect(fake.calls.map((call) => call.version)).toEqual([
      "1.4.99",
      "1.4.98",
    ]);
    // Again: there already, nothing downloaded; a start then finds it.
    expect(await prewarmModuleRuntimes(resolve, ["bun@1.4.99"])).toEqual([
      { packageManager: "bun@1.4.99", kind: "cached", executable },
    ]);
    expect(fake.calls).toHaveLength(2);
    expect(
      await resolve({ packageManager: "bun@1.4.99", owner }),
    ).toMatchObject({ executable, source: "cache" });
  },
);

// A registry on the loopback interface, as npm's answers it: a package
// document per name and its tarballs, each version with its integrity or
// deliberately another one.
async function loopbackRegistry(
  directory: string,
  packageName: string,
  versions: Record<string, { reports: string; integrity: "good" | "bad" }>,
  marker: string,
) {
  const tarballs = new Map<string, ArrayBuffer>();
  const documents: Record<string, unknown> = {};
  for (const [version, { reports, integrity }] of Object.entries(versions)) {
    const staging = join(directory, `tarball-${version}`);
    await mkdir(join(staging, "package", "bin"), { recursive: true });
    await writeFile(
      join(staging, "package", "package.json"),
      JSON.stringify({
        name: packageName,
        version,
        // Never run: Bun's installer runs no install scripts here.
        scripts: { postinstall: `echo ran > '${marker}'` },
      }),
    );
    await fakeBun(join(staging, "package", "bin", "bun"), reports);
    const file = join(directory, `${version}.tgz`);
    const tar = Bun.spawnSync(["tar", "-czf", file, "-C", staging, "package"], {
      env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
    });
    expect(tar.exitCode).toBe(0);
    const bytes = await Bun.file(file).arrayBuffer();
    tarballs.set(version, bytes);
    const digest = createHash("sha512")
      .update(
        integrity === "good"
          ? new Uint8Array(bytes)
          : Buffer.from("another tarball"),
      )
      .digest("base64");
    documents[version] = { name: packageName, version, digest };
  }
  let port = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      const tarball = /^\/tarballs\/(.+)\.tgz$/.exec(url.pathname);
      if (tarball !== null) {
        const bytes = tarballs.get(tarball[1] as string);
        return bytes === undefined
          ? new Response("not found", { status: 404 })
          : new Response(bytes);
      }
      if (decodeURIComponent(url.pathname) !== `/${packageName}`)
        return new Response("not found", { status: 404 });
      return Response.json({
        name: packageName,
        "dist-tags": {},
        versions: Object.fromEntries(
          Object.entries(documents).map(([version, value]) => [
            version,
            {
              name: packageName,
              version,
              dist: {
                tarball: `http://127.0.0.1:${port}/tarballs/${version}.tgz`,
                integrity: `sha512-${(value as { digest: string }).digest}`,
              },
            },
          ]),
        ),
      });
    },
  });
  port = server.port ?? 0;
  return server;
}

posixTest(
  "Bun's own installer fetches the version from the registry it is given, verifies its sha512 integrity before anything is kept, runs no install scripts, reads none of the user's configuration and never writes a package.json above its private directory",
  async () => {
    const { directory, home, owner, file } = await place("installer");
    const marker = join(directory, "postinstall-ran");
    // The user's home is a project of its own, with a registry in its npm
    // and Bun configuration that would answer nothing.
    const homePackage = '{"name":"someone-elses-project","private":true}\n';
    await writeFile(join(home, "package.json"), homePackage);
    await writeFile(join(home, ".npmrc"), "registry=http://127.0.0.1:9/\n");
    await writeFile(
      join(home, ".bunfig.toml"),
      '[install]\nregistry = "http://127.0.0.1:9/"\n',
    );
    const registry = await loopbackRegistry(
      join(directory, "registry"),
      "@oven/bun-linux-aarch64",
      {
        "1.4.99": { reports: "1.4.99", integrity: "good" },
        "1.4.98": { reports: "1.4.98", integrity: "bad" },
      },
      marker,
    );
    try {
      const resolve = createModuleBunResolver({
        home,
        userBun: process.execPath,
        path: "/usr/bin:/bin",
        install: bunInstaller(`http://127.0.0.1:${registry.port}/`),
        system: async () => linuxArm,
        freeBytes: plenty,
      });
      const executable = cachedExecutable(home, "1.4.99", "linux-aarch64");
      expect(await resolve({ packageManager: "bun@1.4.99", owner })).toEqual({
        executable,
        binDir: dirname(executable),
        source: "fetched",
      });
      expect(run(executable, ["--version"])).toBe("1.4.99");
      expect((await lstat(executable)).isFile()).toBe(true);
      // Its own project, with what Bun's installer recorded.
      const own = JSON.parse(
        await readFile(
          join(moduleBunRoot(home), "1.4.99", "package.json"),
          "utf8",
        ),
      );
      expect(own.dependencies).toEqual({ "@oven/bun-linux-aarch64": "1.4.99" });
      expect(existsSync(join(moduleBunRoot(home), "1.4.99", "bun.lock"))).toBe(
        true,
      );
      // Nothing of the user's: the project above stays as it was.
      expect(await readFile(join(home, "package.json"), "utf8")).toBe(
        homePackage,
      );
      for (const name of ["bun.lock", "node_modules"])
        expect(existsSync(join(home, name))).toBe(false);
      expect(existsSync(marker)).toBe(false);
      // A tarball that does not match its integrity is never kept.
      expect(
        await refusalOf(resolve({ packageManager: "bun@1.4.98", owner })),
      ).toEqual({ reason: "runtime-integrity-failed", path: file });
      // A version the registry does not know.
      expect(
        await refusalOf(resolve({ packageManager: "bun@1.4.97", owner })),
      ).toEqual({ reason: "runtime-version-unknown", path: file });
      expect(await readdir(moduleBunRoot(home))).toEqual(["1.4.99"]);
    } finally {
      registry.stop(true);
    }
    // A registry that does not answer.
    const closed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const port = closed.port;
    closed.stop(true);
    const offline = await place("installer-offline");
    expect(
      await refusalOf(
        createModuleBunResolver({
          home: offline.home,
          userBun: process.execPath,
          path: "/usr/bin:/bin",
          install: bunInstaller(`http://127.0.0.1:${port}/`),
          system: async () => linuxArm,
          freeBytes: plenty,
        })({ packageManager: "bun@1.4.99", owner: offline.owner }),
      ),
    ).toEqual({ reason: "runtime-unavailable", path: offline.file });
    expect(await readdir(moduleBunRoot(offline.home))).toEqual([]);
  },
  60_000,
);

// Opt-in: the real distribution. Fetches Bun from the npm registry for this
// system and runs it, nested `bun` and `bunx` included.
test.skipIf(!supported || process.env.LAZURIO_TEST_NETWORK !== "1")(
  "opt-in (LAZURIO_TEST_NETWORK=1): a real Bun version is fetched from npm for this system, verified, and runs as the pinned version, nested bun and bunx included",
  async () => {
    const pinned = Bun.version === "1.4.3" ? "1.4.4" : "1.4.3";
    const { directory, home, owner } = await place("network");
    const resolve = createModuleBunResolver({
      home,
      userBun: process.execPath,
      path: "/usr/bin:/bin",
    });
    const started = performance.now();
    const bun = await resolve({ packageManager: `bun@${pinned}`, owner });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    expect(bun.source).toBe("fetched");
    expect(bun.binDir).not.toBeNull();
    expect(run(bun.executable, ["--version"])).toBe(pinned);
    expect(
      run(bun.executable, ["-e", "console.log(Bun.version)"], { HOME: home }),
    ).toBe(pinned);
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        name: "nested",
        private: true,
        scripts: { nested: "bun --version", bunx: "bunx --version" },
      }),
    );
    const env = withModuleBun(
      { HOME: home, PATH: "/usr/bin:/bin" },
      bun,
    ) as Record<string, string>;
    for (const script of ["nested", "bunx"])
      expect(
        execFileSync(bun.executable, ["--no-env-file", "run", script], {
          cwd: project,
          encoding: "utf8",
          env,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      ).toBe(pinned);
    expect(
      await resolve({ packageManager: `bun@${pinned}`, owner }),
    ).toMatchObject({ executable: bun.executable, source: "cache" });
    console.log(
      `opt-in network: fetched bun@${pinned} for ${process.platform}-${process.arch} in ${seconds} s: ${bun.executable}`,
    );
  },
  300_000,
);
