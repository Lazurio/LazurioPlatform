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
  boundInstallLocation,
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
  const bound = resolveInstallLocation({
    platform: "linux",
    env: {},
    homedir: "/home/x",
  });
  const snapshot = boundInstallLocation(bound);
  expect(snapshot).toEqual(bound);
  expect(snapshot).not.toBe(bound);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(() =>
    boundInstallLocation({
      ...bound,
      versions: "/home/y/.local/share/lazurio/versions",
    }),
  ).toThrow("Unbound");
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
    await writeFile(
      join(location.base, "location.json"),
      JSON.stringify({ schemaVersion: 1, kind: "lazurio-install-location" }),
    );
    await chmod(join(location.base, "location.json"), 0o400);
    expect(await verifyInstallLocation(location)).toEqual(location);
    // A validly named entry in versions/ must prove it is this product's
    // staged layout: a foreign directory, a regular file and a link are refused.
    const valid = "1.2.3+0123456789abcdef";
    await mkdir(join(location.versions, valid), { mode: 0o700 });
    await writeFile(join(location.versions, valid, "foreign"), "x", {
      mode: 0o600,
    });
    await expect(verifyInstallLocation(location)).rejects.toThrow(
      "Unrecognized staged version layout",
    );
    expect(await readdir(join(location.versions, valid))).toEqual(["foreign"]);
    await rm(join(location.versions, valid), { recursive: true });
    await writeFile(join(location.versions, valid), "x", { mode: 0o600 });
    await expect(verifyInstallLocation(location)).rejects.toThrow();
    await rm(join(location.versions, valid));
    await symlink(location.owner, join(location.versions, valid));
    await expect(verifyInstallLocation(location)).rejects.toThrow("Canonical");
    await rm(join(location.versions, valid));
    await writeFile(join(location.versions, ".staging-0123456789abcdef"), "x", {
      mode: 0o600,
    });
    await expect(verifyInstallLocation(location)).rejects.toThrow("Unknown");
    await rm(join(location.versions, ".staging-0123456789abcdef"));
    expect(await verifyInstallLocation(location)).toEqual(location);
    // Two prepared locations never combine: a mixed tuple is refused before
    // inspection, and a malformed first prepare creates neither base nor
    // a sibling .lazurio-location-* layout.
    const other = await prepareInstallLocation(resolve("other"));
    for (const mixed of [
      { base: location.base, owner: location.owner, versions: other.versions },
      { base: location.base, owner: other.owner, versions: location.versions },
      {
        base: location.base,
        owner: location.owner,
        versions: `${location.base}/versions/../versions`,
      },
      {
        base: `${location.base}/`,
        owner: location.owner,
        versions: location.versions,
      },
    ]) {
      await expect(verifyInstallLocation(mixed)).rejects.toThrow("Unbound");
      await expect(prepareInstallLocation(mixed)).rejects.toThrow("Unbound");
    }
    const malformed = {
      base: join(home, "fresh", "lazurio"),
      owner: other.owner,
      versions: join(home, "fresh", "lazurio", "versions"),
    };
    await expect(prepareInstallLocation(malformed)).rejects.toThrow("Unbound");
    await expect(stat(join(home, "fresh"))).rejects.toThrow();
    expect(
      (await readdir(home)).filter((entry) => entry.startsWith(".lazurio")),
    ).toEqual([]);
    // The tuple is snapshotted once: mutating the caller's object after the
    // call, or a component that changes on re-read, never yields a mixed tuple.
    const mutable = { ...location };
    const verifying = verifyInstallLocation(mutable);
    mutable.versions = other.versions;
    expect(await verifying).toEqual(location);
    expect(Object.isFrozen(await verifying)).toBe(true);
    let reads = 0;
    const rereading = {
      base: location.base,
      owner: location.owner,
      get versions() {
        reads += 1;
        return reads === 1 ? location.versions : other.versions;
      },
    };
    expect(await verifyInstallLocation(rereading)).toEqual(location);
    expect(reads).toBe(1);
    const preparing = prepareInstallLocation({ ...location });
    expect(await preparing).toEqual(location);
    // A linked base is refused before any record is read.
    const linked = resolve("linked");
    await mkdir(join(home, "linked"), { mode: 0o700 });
    await symlink(location.base, linked.base);
    await expect(prepareInstallLocation(linked)).rejects.toThrow("Canonical");
  } finally {
    await rm(home, { recursive: true });
  }
});
