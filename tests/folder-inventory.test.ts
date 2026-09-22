import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectOutput } from "../src/folder/inventory";
import { planInstructions } from "../src/folder/reconcile";

test.skipIf(process.platform === "win32")(
  "owned fixture inventory feeds the planner without following links",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "folder-inventory-"));
    const file = join(fixture, "AGENTS.md");
    const content = "Original instructions\n";
    const digest = createHash("sha256").update(content).digest("hex");
    try {
      expect(await inspectOutput(fixture, "AGENTS.md")).toEqual({
        kind: "absent",
      });
      await expect(
        inspectOutput("relative-folder", "AGENTS.md"),
      ).rejects.toThrow("Explicit absolute directory required");
      await expect(
        inspectOutput(join(fixture, "missing-root"), "AGENTS.md"),
      ).rejects.toThrow();
      const rootAlias = join(fixture, "root-alias");
      await symlink(fixture, rootAlias);
      expect(await inspectOutput(rootAlias, "AGENTS.md")).toEqual({
        kind: "unsafe",
      });
      await writeFile(file, content);
      const observed = await inspectOutput(fixture, "AGENTS.md");
      expect(observed).toEqual({ kind: "regular", digest });
      expect(planInstructions("AGENTS.md", digest, digest, observed)).toEqual({
        kind: "unchanged",
      });
      await writeFile(file, "User edits");
      expect(
        planInstructions(
          "AGENTS.md",
          digest,
          digest,
          await inspectOutput(fixture, "AGENTS.md"),
        ),
      ).toEqual({ kind: "blocked", reason: "drift", path: "AGENTS.md" });
      // A manual file: absent directory means absent files; a link or a file
      // in place of the directory is unsafe.
      expect(await inspectOutput(fixture, "manual/roles.md")).toEqual({
        kind: "absent",
      });
      await symlink(fixture, join(fixture, "manual"));
      expect(await inspectOutput(fixture, "manual/roles.md")).toEqual({
        kind: "unsafe",
      });
      await rm(join(fixture, "manual"));
      await writeFile(join(fixture, "manual"), "not a directory");
      expect(await inspectOutput(fixture, "manual/roles.md")).toEqual({
        kind: "unsafe",
      });
      await rm(join(fixture, "manual"));
      await mkdir(join(fixture, "manual"));
      await writeFile(join(fixture, "manual", "roles.md"), content);
      expect(await inspectOutput(fixture, "manual/roles.md")).toEqual({
        kind: "regular",
        digest,
      });
      await rm(file);
      const target = join(fixture, "untouched.txt");
      await writeFile(target, content);
      await symlink(target, file);
      expect(await inspectOutput(fixture, "AGENTS.md")).toEqual({
        kind: "unsafe",
      });
      await rm(file);
      await link(target, file);
      expect(await inspectOutput(fixture, "AGENTS.md")).toEqual({
        kind: "unsafe",
      });
      await rm(file);
      await mkdir(file);
      expect(await inspectOutput(fixture, "AGENTS.md")).toEqual({
        kind: "unsafe",
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
