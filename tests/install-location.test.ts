import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareInstallLocation,
  resolveInstallLocation,
} from "../src/distribution/install-location";

test("resolves per-user locations outside any Lazurio Folder and ignores relative XDG", () => {
  expect(
    resolveInstallLocation({
      platform: "darwin",
      env: {},
      homedir: "/Users/x",
    }),
  ).toEqual({
    base: "/Users/x/Library/Application Support/Lazurio",
    owner: "/Users/x/Library/Application Support/Lazurio/distribution",
    versions: "/Users/x/Library/Application Support/Lazurio/versions",
  });
  expect(
    resolveInstallLocation({ platform: "linux", env: {}, homedir: "/home/x" })
      .base,
  ).toBe("/home/x/.local/share/lazurio");
  expect(
    resolveInstallLocation({
      platform: "linux",
      env: { XDG_DATA_HOME: "/data" },
      homedir: "/home/x",
    }).base,
  ).toBe("/data/lazurio");
  expect(
    resolveInstallLocation({
      platform: "linux",
      env: { XDG_DATA_HOME: "relative/data" },
      homedir: "/home/x",
    }).base,
  ).toBe("/home/x/.local/share/lazurio");
  expect(() =>
    resolveInstallLocation({
      platform: "win32",
      env: {},
      homedir: "/Users/x",
    }),
  ).toThrow("Unqualified");
  expect(() =>
    resolveInstallLocation({
      platform: "darwin",
      env: {},
      homedir: "relative",
    }),
  ).toThrow("Absolute");
});

test("prepare creates private directories once and refuses a linked base", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "install-home-")));
  try {
    const location = resolveInstallLocation({
      platform: "linux",
      env: { XDG_DATA_HOME: home },
      homedir: home,
    });
    expect(await prepareInstallLocation(location)).toEqual(location);
    for (const path of [location.base, location.owner, location.versions])
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect(await prepareInstallLocation(location)).toEqual(location);
    expect((await readdir(location.base)).sort()).toEqual([
      "distribution",
      "versions",
    ]);
    const linked = resolveInstallLocation({
      platform: "linux",
      env: { XDG_DATA_HOME: join(home, "linked") },
      homedir: home,
    });
    await symlink(location.base, join(home, "linked"));
    await expect(prepareInstallLocation(linked)).rejects.toThrow("Canonical");
  } finally {
    await rm(home, { recursive: true });
  }
});
