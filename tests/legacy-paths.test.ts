import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLegacyPaths } from "../src/folder/inspect-legacy-paths";

test.skipIf(process.platform !== "darwin")(
  "legacy inventory rejects a regular canonical file and noncanonical home",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "legacy-paths-")));
    try {
      await writeFile(join(home, "Lazurio"), "preserve existing file");
      expect(await inspectLegacyPaths(home)).toEqual({
        kind: "blocked",
        reason: "unsafe-or-changing-paths",
      });
      expect(await readFile(join(home, "Lazurio"), "utf8")).toBe(
        "preserve existing file",
      );
      expect(await inspectLegacyPaths("relative-home")).toEqual({
        kind: "blocked",
        reason: "unsafe-or-changing-paths",
      });
      await symlink(home, join(home, "home-alias"));
      expect(await inspectLegacyPaths(join(home, "home-alias"))).toEqual({
        kind: "blocked",
        reason: "unsafe-or-changing-paths",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "darwin")(
  "legacy inventory refuses unqualified platform before accessing paths",
  async () => {
    expect(await inspectLegacyPaths("not-a-real-home")).toEqual({
      kind: "blocked",
      reason: "unqualified-platform",
    });
  },
);

test.skipIf(process.platform !== "darwin")(
  "legacy path inventory is read-only and never selects a tree to migrate",
  async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "legacy-paths-")));
    try {
      const empty = await inspectLegacyPaths(home);
      expect(empty.kind).toBe("observed");
      if (empty.kind !== "observed") throw new Error("Missing observation");
      expect(empty.paths.map((path) => path.kind)).toEqual([
        "missing",
        "missing",
        "missing",
      ]);
      await mkdir(join(home, "Lazurio"), { mode: 0o700 });
      await writeFile(join(home, "Lazurio", "owned.txt"), "preserve");
      await symlink("Lazurio", join(home, "Conglomerate"));
      await symlink(join(home, "Lazurio"), join(home, "Conglomerate_GEN3"));
      const aliases = await inspectLegacyPaths(home);
      expect(aliases.kind).toBe("observed");
      if (aliases.kind !== "observed") throw new Error("Missing observation");
      expect(aliases.paths.map((path) => path.kind)).toEqual([
        "directory",
        "alias",
        "alias",
      ]);
      expect(await readlink(join(home, "Conglomerate"))).toBe("Lazurio");
      expect(await readFile(join(home, "Lazurio", "owned.txt"), "utf8")).toBe(
        "preserve",
      );
      await rm(join(home, "Conglomerate"));
      await mkdir(join(home, "Conglomerate"), { mode: 0o700 });
      const multiple = await inspectLegacyPaths(home);
      expect(multiple.kind).toBe("observed");
      if (multiple.kind !== "observed") throw new Error("Missing observation");
      expect(
        multiple.paths.filter((path) => path.kind === "directory"),
      ).toHaveLength(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "legacy inventory refuses foreign, dangling and canonical aliases without exposing targets",
  async () => {
    for (const [name, target] of [
      ["Conglomerate", "private-foreign"],
      ["Conglomerate", "Lazurio"],
      ["Lazurio", "other"],
    ] as const) {
      const home = await realpath(
        await mkdtemp(join(tmpdir(), "legacy-paths-")),
      );
      try {
        await symlink(target, join(home, name));
        expect(await inspectLegacyPaths(home)).toEqual({
          kind: "blocked",
          reason: "unsafe-or-changing-paths",
        });
        expect(await readlink(join(home, name))).toBe(target);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  },
);
