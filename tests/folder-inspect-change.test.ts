import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { executionOs } from "../src/folder/platform";
import { previewFolder } from "../src/folder/preview";

test.skipIf(process.platform === "win32")(
  "stored profile inspection shares the lock, refuses incomplete state and preserves user bytes",
  async () => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "profile-state-")),
    );
    const folder = join(temporary, "folder");
    const state = join(temporary, "state");
    const profile = {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    };
    const requested = { ...profile, locale: "cs" };
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(state, { mode: 0o700 });
      const preview = await previewFolder(profile, null, async () => ({
        kind: "absent",
      }));
      const preferences = JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        profile,
        customInstructions: "",
      });
      const manifest = JSON.stringify({
        schemaVersion: 1,
        preferenceRevision: 1,
        templateRevision: preview.templateRevision,
        output: { path: "AGENTS.md", digest: preview.desired.digest },
      });
      await writeFile(join(folder, "AGENTS.md"), preview.desired.content);
      await writeFile(
        join(folder, "own-notes"),
        "Preserve synthetic user work",
      );
      await writeFile(join(state, "preferences.json"), preferences, {
        mode: 0o600,
      });
      await writeFile(join(state, "instructions.json"), manifest, {
        mode: 0o600,
      });
      expect(
        (await inspectProfileChange(folder, state, 1, requested)).kind,
      ).toBe("profile-change");
      expect(await inspectProfileChange(folder, state, 2, requested)).toEqual({
        kind: "blocked",
        reason: "stale-revision",
      });
      expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe(
        preview.desired.content,
      );
      expect(await readFile(join(state, "preferences.json"), "utf8")).toBe(
        preferences,
      );
      expect(await readFile(join(state, "instructions.json"), "utf8")).toBe(
        manifest,
      );
      expect((await readdir(state)).sort()).toEqual([
        "instructions.json",
        "preferences.json",
      ]);
      await mkdir(join(state, ".operation-lock"));
      await expect(
        inspectProfileChange(folder, state, 1, requested),
      ).rejects.toThrow("busy");
      await rm(join(state, ".operation-lock"), { recursive: true });
      await writeFile(
        join(state, "pending.json"),
        "preserve transaction evidence",
      );
      await expect(
        inspectProfileChange(folder, state, 1, requested),
      ).rejects.toThrow("pending");
      expect(await readFile(join(state, "pending.json"), "utf8")).toBe(
        "preserve transaction evidence",
      );
      await rm(join(state, "pending.json"));
      await writeFile(join(state, "preferences.json"), "invalid JSON");
      await expect(
        inspectProfileChange(folder, state, 1, requested),
      ).rejects.toThrow();
      await rm(join(state, "preferences.json"));
      await symlink(join(folder, "own-notes"), join(state, "preferences.json"));
      await expect(
        inspectProfileChange(folder, state, 1, requested),
      ).rejects.toThrow("Unsafe");
      expect(await readFile(join(folder, "own-notes"), "utf8")).toBe(
        "Preserve synthetic user work",
      );
      expect((await readdir(state)).sort()).toEqual([
        "instructions.json",
        "preferences.json",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
