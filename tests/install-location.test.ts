import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareInstallLocation,
  resolveInstallLocation,
  verifyInstallLocation,
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

test("prepare creates the layout once, verifies it afterwards and refuses foreign or uninitialized content", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "install-home-")));
  const resolve = (name: string) =>
    resolveInstallLocation({
      platform: "linux",
      env: { XDG_DATA_HOME: join(home, name) },
      homedir: home,
    });
  try {
    const location = resolve("data");
    expect(await prepareInstallLocation(location)).toEqual(location);
    for (const path of [location.base, location.owner, location.versions])
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await readdir(location.base)).sort()).toEqual([
      "distribution",
      "location.json",
      "versions",
    ]);
    expect((await readdir(join(home, "data"))).sort()).toEqual(["lazurio"]);
    expect(await prepareInstallLocation(location)).toEqual(location);
    expect(await verifyInstallLocation(location)).toEqual(location);
    // A pre-existing base without this product's record is never adopted.
    const foreign = resolve("foreign");
    await mkdir(foreign.versions, { recursive: true, mode: 0o700 });
    await writeFile(join(foreign.versions, "foreign-owned-content"), "x", {
      mode: 0o600,
    });
    await expect(prepareInstallLocation(foreign)).rejects.toThrow();
    await expect(verifyInstallLocation(foreign)).rejects.toThrow();
    expect((await readdir(foreign.base)).sort()).toEqual(["versions"]);
    expect(await readdir(foreign.versions)).toEqual(["foreign-owned-content"]);
    // Unknown content inside an initialized location is refused, not removed.
    await writeFile(join(location.versions, "foreign-owned-content"), "x", {
      mode: 0o600,
    });
    await expect(prepareInstallLocation(location)).rejects.toThrow("Unknown");
    await rm(join(location.versions, "foreign-owned-content"));
    await mkdir(join(location.owner, "unexpected"), { mode: 0o700 });
    await expect(verifyInstallLocation(location)).rejects.toThrow("Unknown");
    await rm(join(location.owner, "unexpected"), { recursive: true });
    await writeFile(join(location.base, "note.txt"), "x", { mode: 0o600 });
    await expect(verifyInstallLocation(location)).rejects.toThrow("Unknown");
    await rm(join(location.base, "note.txt"));
    await chmod(join(location.base, "location.json"), 0o600);
    await writeFile(join(location.base, "location.json"), "{}");
    await expect(verifyInstallLocation(location)).rejects.toThrow();
    // A linked base is refused before any record is read.
    const linked = resolve("linked");
    await mkdir(join(home, "linked"), { mode: 0o700 });
    await symlink(location.base, linked.base);
    await expect(prepareInstallLocation(linked)).rejects.toThrow("Canonical");
  } finally {
    await rm(home, { recursive: true });
  }
});
