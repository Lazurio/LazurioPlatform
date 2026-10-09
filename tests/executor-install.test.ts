import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  executorWrapper,
  inspectEntry,
  installPinnedExecutor,
  type PinnedInstallInput,
  pinnedBinary,
  removeOlderInstallations,
} from "../src/executor/install";
import { executorPin } from "../src/executor/pin";
import { runTool } from "../src/tools/status";
import {
  type ExecutorWorld,
  executorWorld,
  fakeVersion,
  writeExecutable,
} from "./fixtures/fake-executor";

// The pinned Executor (decision F44): exactly the pinned tarballs, verified
// before npm sees them, installed by npm offline and without scripts into
// ~/.local/share/executor-cli/<version>, and the standard entry
// ~/.local/bin/executor as Lazurio's wrapper.

const inputOf = (world: ExecutorWorld): PinnedInstallInput => ({
  root: world.host.root,
  bin: world.host.bin,
  home: world.home,
  path: world.path,
  platform: "linux",
  arch: "x64",
  run: runTool,
  fetch: world.registry.fetch,
  pin: world.pin,
});

const entryOf = (world: ExecutorWorld) => join(world.host.bin, "executor");
const binaryOf = (world: ExecutorWorld) =>
  pinnedBinary(world.host.root, "linux-x64", world.pin);

test("the pin names version 1.6.10 and the registry's sha512 of the launcher and both glibc builds", () => {
  expect(executorPin.version).toBe("1.6.10");
  expect(executorPin.main.url).toBe(
    "https://registry.npmjs.org/executor/-/executor-1.6.10.tgz",
  );
  expect(Object.keys(executorPin.platforms).sort()).toEqual([
    "linux-arm64",
    "linux-x64",
  ]);
  for (const tarball of [
    executorPin.main,
    ...Object.values(executorPin.platforms),
  ]) {
    expect(
      tarball.url.startsWith(
        "https://registry.npmjs.org/executor/-/executor-1.6.10",
      ),
    ).toBe(true);
    expect(tarball.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
  }
});

test("installs exactly the pinned tarballs, verified before npm runs, npm offline without scripts and without the operator's npm configuration; the wrapper turns both switches off", async () => {
  const world = await executorWorld();
  try {
    // The operator's own npm configuration must never steer the install.
    await writeFile(
      join(world.home, ".npmrc"),
      "registry=https://registry.invalid/\nignore-scripts=false\n",
    );
    const result = await installPinnedExecutor(inputOf(world));
    expect(result).toEqual({
      kind: "installed",
      version: fakeVersion,
      binary: binaryOf(world),
      entry: "written",
    });
    expect(world.registry.requests).toEqual([
      world.pin.main.url,
      world.pin.platforms["linux-x64"].url,
    ]);
    const npm = await world.calls("npm.calls");
    expect(npm).toHaveLength(2);
    for (const line of npm) {
      const [args, ...settings] = line.split("|");
      expect(args).toContain("install --global --prefix ");
      expect(args).toContain(
        " --offline --ignore-scripts --no-audit --no-fund ",
      );
      const value = Object.fromEntries(
        settings.map((part) => part.split("=") as [string, string]),
      );
      expect(value.offline).toBe("true");
      expect(value.scripts).toBe("true");
      expect(value.home).toBe(world.home);
      // A private, empty configuration and cache, never the operator's.
      for (const path of [value.userconfig, value.globalconfig, value.cache])
        expect(path?.startsWith(`${world.host.root}/.lazurio-download-`)).toBe(
          true,
        );
    }
    // The launcher first, then the one platform package under its alias.
    expect(npm[0]).toMatch(/ \S+\/executor\.tgz\|/);
    expect(npm[1]).toMatch(
      / executor-linux-x64@file:\S+\/executor-linux-x64\.tgz\|/,
    );
    // The runbook's layout, with Lazurio's marker; nothing else is left.
    expect((await readdir(world.host.root)).sort()).toEqual([fakeVersion]);
    const prefix = join(world.host.root, fakeVersion);
    expect(await readlink(join(prefix, "bin", "executor"))).toBe(
      "../lib/node_modules/executor/bin/executor",
    );
    expect(
      JSON.parse(await readFile(join(prefix, ".lazurio-install.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      version: fakeVersion,
      target: "linux-x64",
      main: world.pin.main.integrity,
      platform: world.pin.platforms["linux-x64"].integrity,
    });
    // The entry is the wrapper; any run of it has both switches off, also
    // when the caller's environment says otherwise.
    expect(await readFile(entryOf(world), "utf8")).toBe(
      executorWrapper(fakeVersion, binaryOf(world)),
    );
    expect((await stat(entryOf(world))).mode & 0o777).toBe(0o755);
    const run = await runTool([entryOf(world), "--version"], 10_000, {
      HOME: world.home,
      PATH: world.path,
      EXECUTOR_DISABLE_ANALYTICS: "0",
      EXECUTOR_DISABLE_UPDATE_CHECK: "",
    });
    expect(run).toMatchObject({ exitCode: 0 });
    expect((await world.calls("executor.calls")).at(-1)).toContain(
      "--version|analytics=1|update=1|",
    );
    // The install's own version probe wrote nothing of the Environment's.
    expect(
      await lstat(join(world.home, ".executor")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await world.close();
  }
}, 20_000);

test("a tarball that does not match its pinned integrity runs nothing and leaves nothing", async () => {
  for (const which of ["main", "platform"] as const) {
    const world = await executorWorld();
    try {
      world.registry.tamper(
        which === "main"
          ? world.pin.main.url
          : world.pin.platforms["linux-x64"].url,
      );
      expect(await installPinnedExecutor(inputOf(world))).toEqual({
        kind: "install-failed",
        stage: "integrity",
        reason: "integrity-mismatch",
      });
      expect(await world.calls("npm.calls")).toEqual([]);
      expect(await readdir(world.host.root)).toEqual([]);
      expect(await inspectEntry(world.host.bin, world.host.root)).toEqual({
        kind: "absent",
      });
    } finally {
      await world.close();
    }
  }
}, 20_000);

test("without npm or node the result is a clear preflight failure before anything is downloaded", async () => {
  for (const missing of ["npm", "node"] as const) {
    const world = await executorWorld({ [missing]: false });
    try {
      expect(await installPinnedExecutor(inputOf(world))).toEqual({
        kind: "install-failed",
        stage: "preflight",
        reason: `${missing}-missing`,
      });
      expect(world.registry.requests).toEqual([]);
      expect(await inspectEntry(world.host.bin, world.host.root)).toEqual({
        kind: "absent",
      });
    } finally {
      await world.close();
    }
  }
}, 20_000);

test("the program must answer the pinned version; npm failing or laying out something else places nothing", async () => {
  const liar = await executorWorld({ programVersion: "1.6.9" });
  try {
    expect(await installPinnedExecutor(inputOf(liar))).toEqual({
      kind: "install-failed",
      stage: "verify",
      reason: "version-mismatch",
    });
    expect(await readdir(liar.host.root)).toEqual([]);
    expect(await inspectEntry(liar.host.bin, liar.host.root)).toEqual({
      kind: "absent",
    });
  } finally {
    await liar.close();
  }
  const failing = await executorWorld();
  try {
    await failing.flag("npm-world/fail");
    expect(await installPinnedExecutor(inputOf(failing))).toEqual({
      kind: "install-failed",
      stage: "npm",
      reason: "exit-1",
    });
    expect(await readdir(failing.host.root)).toEqual([]);
    await failing.flag("npm-world/fail", false);
    await failing.flag("npm-world/skip-platform");
    expect(await installPinnedExecutor(inputOf(failing))).toEqual({
      kind: "install-failed",
      stage: "verify",
      reason: "layout-unexpected",
    });
    expect(await readdir(failing.host.root)).toEqual([]);
  } finally {
    await failing.close();
  }
}, 20_000);

test("an entry that is not Lazurio's is never replaced and nothing is downloaded", async () => {
  const world = await executorWorld();
  try {
    await mkdir(world.host.bin, { recursive: true });
    const foreign = "#!/bin/sh\necho someone else's executor\n";
    await writeExecutable(entryOf(world), foreign);
    expect(await installPinnedExecutor(inputOf(world))).toEqual({
      kind: "entry-conflict",
    });
    expect(await readFile(entryOf(world), "utf8")).toBe(foreign);
    expect(world.registry.requests).toEqual([]);
    // A link elsewhere is someone else's too.
    await rm(entryOf(world));
    await symlink("/bin/sh", entryOf(world));
    expect(await installPinnedExecutor(inputOf(world))).toEqual({
      kind: "entry-conflict",
    });
    expect(await readlink(entryOf(world))).toBe("/bin/sh");
  } finally {
    await world.close();
  }
  // ~/.local/bin that is a link is never written through.
  const linked = await executorWorld();
  try {
    const elsewhere = join(linked.parent, "elsewhere");
    await mkdir(elsewhere);
    await mkdir(join(linked.home, ".local"), { recursive: true });
    await symlink(elsewhere, linked.host.bin);
    expect(await installPinnedExecutor(inputOf(linked))).toEqual({
      kind: "entry-conflict",
    });
    expect(await readdir(elsewhere)).toEqual([]);
  } finally {
    await linked.close();
  }
}, 20_000);

test("the runbook's manual installation is adopted: its link becomes the wrapper and its unverified directory moves aside", async () => {
  const world = await executorWorld();
  try {
    // `npm install -g --prefix …/1.6.10 executor@1.6.10` and `ln -sfn` by
    // hand: no marker of Lazurio's.
    const manual = join(world.host.root, fakeVersion);
    await mkdir(join(manual, "bin"), { recursive: true });
    await writeExecutable(
      join(manual, "bin", "executor"),
      "#!/bin/sh\necho manual\n",
    );
    await mkdir(world.host.bin, { recursive: true });
    await symlink(join(manual, "bin", "executor"), entryOf(world));
    expect(await inspectEntry(world.host.bin, world.host.root)).toEqual({
      kind: "replaceable",
    });
    expect(await installPinnedExecutor(inputOf(world))).toMatchObject({
      kind: "installed",
      entry: "written",
    });
    expect(await readFile(entryOf(world), "utf8")).toBe(
      executorWrapper(fakeVersion, binaryOf(world)),
    );
    const names = (await readdir(world.host.root)).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^\.lazurio-previous-[0-9a-f]{16}$/);
    expect(names[1]).toBe(fakeVersion);
  } finally {
    await world.close();
  }
}, 20_000);

test("a second run finds the pin in place: nothing is downloaded, run through npm or rewritten", async () => {
  const world = await executorWorld();
  try {
    await installPinnedExecutor(inputOf(world));
    const written = await stat(entryOf(world));
    world.registry.requests.length = 0;
    expect(await installPinnedExecutor(inputOf(world))).toEqual({
      kind: "present",
      version: fakeVersion,
      binary: binaryOf(world),
      entry: "present",
    });
    expect(world.registry.requests).toEqual([]);
    expect(await world.calls("npm.calls")).toHaveLength(2);
    expect((await stat(entryOf(world))).mtimeMs).toBe(written.mtimeMs);
  } finally {
    await world.close();
  }
}, 20_000);

test("a newer pin of Lazurio's is never replaced by an older release", async () => {
  const world = await executorWorld();
  try {
    const newer = join(world.parent, "newer-executor");
    await writeExecutable(newer, "#!/bin/sh\necho executor v1.7.0\n");
    await mkdir(world.host.bin, { recursive: true });
    await writeExecutable(entryOf(world), executorWrapper("1.7.0", newer));
    expect(await installPinnedExecutor(inputOf(world))).toEqual({
      kind: "newer-installed",
      version: "1.7.0",
      binary: newer,
    });
    expect(world.registry.requests).toEqual([]);
    expect(await readFile(entryOf(world), "utf8")).toBe(
      executorWrapper("1.7.0", newer),
    );
  } finally {
    await world.close();
  }
}, 20_000);

test("an older version stays until the switch; then older versions and Lazurio's leftovers go, a newer one and foreign names stay", async () => {
  const world = await executorWorld();
  try {
    for (const name of [
      "1.6.9",
      "1.7.0",
      "notes",
      ".lazurio-previous-0011223344556677",
      ".lazurio-staging-abcdef",
    ])
      await mkdir(join(world.host.root, name), { recursive: true });
    await installPinnedExecutor(inputOf(world));
    expect(await readdir(world.host.root)).toContain("1.6.9");
    await removeOlderInstallations(world.host.root, world.pin);
    expect((await readdir(world.host.root)).sort()).toEqual(
      [fakeVersion, "1.7.0", "notes"].sort(),
    );
  } finally {
    await world.close();
  }
}, 20_000);

test("only the glibc builds of Linux are installed: elsewhere nothing happens", async () => {
  const world = await executorWorld();
  try {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "ia32"],
      ["win32", "x64"],
    ] as const)
      expect(
        await installPinnedExecutor({ ...inputOf(world), platform, arch }),
      ).toEqual({ kind: "unsupported-platform", platform, arch });
    expect(world.registry.requests).toEqual([]);
  } finally {
    await world.close();
  }
}, 20_000);
