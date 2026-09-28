import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallCommand } from "../src/update/cli";
import { performInstall } from "../src/update/install";
import { swapSelector } from "../src/update/layout";
import { ensurePathEntry } from "../src/update/path-entry";
import { commitOf, executable, target } from "./fixtures/update-world";

// HOME is always a temporary directory: the person's real `~/.local/bin` is
// never read or written by these tests.
let root: string;
afterEach(async () => rm(root, { recursive: true, force: true }));

async function scene() {
  root = await realpath(await mkdtemp(join(tmpdir(), "upd-entry-")));
  const home = join(root, "home");
  await mkdir(home);
  const base = join(home, ".local/share/lazurio");
  const downloaded = join(root, "lazurio");
  await writeFile(downloaded, executable("1.0.0"), { mode: 0o755 });
  const install = (env: Record<string, string | undefined> = {}) =>
    performInstall({
      base,
      executable: downloaded,
      identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
      platform: "linux",
      env: { HOME: home, ...env },
    });
  return {
    home,
    base,
    bin: join(home, ".local/bin"),
    entry: join(home, ".local/bin/lazurio"),
    selector: join(base, "bin/lazurio"),
    install,
  };
}

test("install creates ~/.local/bin (0755 whatever the umask) and the entry linking the selector; repeated, it is present", async () => {
  const { bin, entry, selector, install } = await scene();
  const before = process.umask(0o077);
  try {
    expect(await install()).toMatchObject({
      kind: "installed",
      path: bin,
      entry: { state: "created", path: entry, target: selector },
    });
  } finally {
    process.umask(before);
  }
  expect((await stat(bin)).mode & 0o777).toBe(0o755);
  expect(await readlink(entry)).toBe(selector);
  // The entry runs what the selector names.
  expect(await realpath(entry)).toBe(
    await realpath(join(selector, "../../versions/1.0.0/lazurio")),
  );
  const inode = (await lstat(entry)).ino;
  expect(await install()).toMatchObject({ entry: { state: "present" } });
  expect((await lstat(entry)).ino).toBe(inode);
});

test("a dangling link and a link into another Lazurio install base are replaced", async () => {
  const { home, bin, entry, selector, install } = await scene();
  await mkdir(bin, { recursive: true });
  await symlink(join(home, "gone/bin/lazurio"), entry);
  expect(await install()).toMatchObject({ entry: { state: "replaced" } });
  expect(await readlink(entry)).toBe(selector);

  // An older install base elsewhere: its `bin/lazurio` is a Lazurio selector.
  const older = join(home, "old-data/lazurio");
  await mkdir(join(older, "versions/0.9.0"), { recursive: true });
  await writeFile(join(older, "versions/0.9.0/lazurio"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  await mkdir(join(older, "bin"));
  await swapSelector(older, "0.9.0");
  await rm(entry);
  await symlink(join(older, "bin/lazurio"), entry);
  expect(await install()).toMatchObject({ entry: { state: "replaced" } });
  expect(await readlink(entry)).toBe(selector);
});

test("a regular file, a foreign link or a directory is never overwritten; install succeeds and says what to do", async () => {
  const { home, bin, entry, selector, base, install } = await scene();
  await mkdir(bin, { recursive: true });
  // Someone's own program under the same name.
  await writeFile(entry, "#!/bin/sh\necho mine\n", { mode: 0o755 });
  const file = await install();
  expect(file).toMatchObject({
    kind: "installed",
    // Without the entry the directory to put on PATH is the base's.
    path: join(base, "bin"),
    entry: { state: "conflict", occupant: { kind: "file" } },
  });
  expect(await readFile(entry, "utf8")).toBe("#!/bin/sh\necho mine\n");
  expect(file.kind === "installed" && file.entry?.next[0]).toBe(
    `${entry} is a regular file that is not Lazurio's; it was left unchanged. Until it is resolved, run Lazurio as ${selector}. Move that entry aside only on the operator's instruction, then run \`lazurio install\` again.`,
  );

  // A link to something that exists and is not an install base: the legacy
  // root CLI, for example.
  await rm(entry);
  const legacy = join(home, "Lazurio/lazurio/cli.mjs");
  await mkdir(join(home, "Lazurio/lazurio"), { recursive: true });
  await writeFile(legacy, "#!/usr/bin/env node\n", { mode: 0o755 });
  await symlink(legacy, entry);
  expect(await install()).toMatchObject({
    entry: { state: "conflict", occupant: { kind: "link", target: legacy } },
  });
  expect(await readlink(entry)).toBe(legacy);

  await rm(entry);
  await mkdir(entry);
  expect(await install()).toMatchObject({
    entry: { state: "conflict", occupant: { kind: "other" } },
  });
  expect((await lstat(entry)).isDirectory()).toBe(true);
});

test("PATH is reported, never changed: on PATH, and another lazurio that resolves first", async () => {
  const { home, bin, entry, base, install } = await scene();
  expect(await install({ PATH: `/usr/bin:${bin}` })).toMatchObject({
    entry: { directoryOnPath: true, shadowedBy: null, next: [] },
  });
  // The selector's own directory before it is the same program.
  expect(await install({ PATH: `${join(base, "bin")}:${bin}` })).toMatchObject({
    entry: { shadowedBy: null, next: [] },
  });

  // The legacy root CLI linked by Bun resolves first.
  const bun = join(home, ".bun/bin");
  await mkdir(bun, { recursive: true });
  await writeFile(join(bun, "lazurio"), "#!/bin/sh\n", { mode: 0o755 });
  const shadowed = await install({ PATH: `${bun}:${bin}` });
  expect(shadowed).toMatchObject({
    entry: {
      state: "present",
      directoryOnPath: true,
      shadowedBy: join(bun, "lazurio"),
    },
  });
  expect(shadowed.kind === "installed" && shadowed.entry?.next).toEqual([
    `Another program named lazurio resolves first on PATH: ${join(bun, "lazurio")}. This installation is ${entry}. Nothing was changed about ${join(bun, "lazurio")}; remove it or put ${bin} before its directory on PATH only on the operator's instruction.`,
  ]);
  expect(await readFile(join(bun, "lazurio"), "utf8")).toBe("#!/bin/sh\n");
});

test("no entry without an absolute home or on a platform without an install base design", async () => {
  await scene();
  expect(
    await ensurePathEntry({
      base: "/b",
      home: undefined,
      pathVariable: undefined,
      platform: "linux",
    }),
  ).toBeNull();
  expect(
    await ensurePathEntry({
      base: "/b",
      home: "relative",
      pathVariable: undefined,
      platform: "linux",
    }),
  ).toBeNull();
  expect(
    await ensurePathEntry({
      base: "/b",
      home: root,
      pathVariable: undefined,
      platform: "win32",
    }),
  ).toBeNull();
});

test("the command surface prints the entry and every warning, and --json carries them", async () => {
  const { home, bin, entry, base } = await scene();
  const bun = join(home, ".bun/bin");
  await mkdir(bun, { recursive: true });
  await writeFile(join(bun, "lazurio"), "#!/bin/sh\n", { mode: 0o755 });
  const context = {
    identity: { version: "1.0.0", commit: commitOf("1.0.0"), target },
    platform: "linux",
    env: { HOME: home, PATH: `${bun}:/usr/bin` },
    executable: join(root, "lazurio"),
  };
  expect(await runInstallCommand(["--base", base], context)).toEqual({
    code: 0,
    stdout: [
      "Lazurio 1.0.0 is installed.",
      `The command is ${entry}.`,
      `Put ${bin} on your PATH. Lazurio never edits shell profiles.`,
      `Another program named lazurio resolves first on PATH: ${join(bun, "lazurio")}. This installation is ${entry}. Nothing was changed about ${join(bun, "lazurio")}; remove it or put ${bin} before its directory on PATH only on the operator's instruction.`,
    ].join("\n"),
  });
  const json = JSON.parse(
    (await runInstallCommand(["--base", base, "--json"], context)).stdout ?? "",
  );
  expect(json).toMatchObject({
    kind: "installed",
    path: bin,
    entry: {
      path: entry,
      state: "present",
      directoryOnPath: false,
      shadowedBy: join(bun, "lazurio"),
    },
  });
  expect(json.entry.next).toHaveLength(2);
});
