import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstructions } from "../src/folder/inventory";
import { planInstructions } from "../src/folder/reconcile";

test.skipIf(process.platform === "win32")(
  "owned fixture inventory feeds the planner without following links",
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "folder-inventory-"));
    const file = join(fixture, "AGENTS.md");
    const content = "Original instructions\n";
    const digest = createHash("sha256").update(content).digest("hex");
    try {
      expect(await inspectInstructions(fixture)).toEqual({ kind: "absent" });
      await expect(inspectInstructions("relative-folder")).rejects.toThrow(
        "Explicit absolute directory required",
      );
      await expect(
        inspectInstructions(join(fixture, "missing-root")),
      ).rejects.toThrow();
      const rootAlias = join(fixture, "root-alias");
      await symlink(fixture, rootAlias);
      expect(await inspectInstructions(rootAlias)).toEqual({ kind: "unsafe" });
      await writeFile(file, content);
      const observed = await inspectInstructions(fixture);
      expect(observed).toEqual({ kind: "regular", digest });
      expect(planInstructions(digest, digest, observed)).toEqual({
        kind: "unchanged",
      });
      await writeFile(file, "User edits");
      expect(
        planInstructions(digest, digest, await inspectInstructions(fixture)),
      ).toEqual({ kind: "blocked", reason: "drift" });
      await rm(file);
      const target = join(fixture, "untouched.txt");
      await writeFile(target, content);
      await symlink(target, file);
      expect(await inspectInstructions(fixture)).toEqual({ kind: "unsafe" });
      await rm(file);
      await link(target, file);
      expect(await inspectInstructions(fixture)).toEqual({ kind: "unsafe" });
      await rm(file);
      await mkdir(file);
      expect(await inspectInstructions(fixture)).toEqual({ kind: "unsafe" });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
