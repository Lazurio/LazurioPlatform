import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectProfileChange } from "../src/folder/inspect-profile-change";
import { withFolderOperationLock } from "../src/folder/lock";
import { executionOs } from "../src/folder/platform";
import { previewFolder } from "../src/folder/preview";

test.skipIf(process.platform === "win32")(
  "stored profile inspection shares the lock, refuses incomplete state and preserves user bytes",
  async () => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "profile-state-")),
    );
    const folder = join(temporary, "folder");
    const state = join(folder, ".lazurio");
    const profile = {
      os: executionOs(process.platform),
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    };
    const requested = { ...profile, locale: "cs" };
    const request = { profile: requested };
    try {
      await mkdir(folder, { mode: 0o700 });
      await mkdir(state, { mode: 0o700 });
      const preview = await previewFolder(
        { preset: "local", machine: null, profile },
        null,
        async () => ({ kind: "absent" }),
      );
      const preferences = JSON.stringify({
        schemaVersion: 2,
        revision: 1,
        preset: { name: "local", version: 1, selection: "derived" },
        machine: null,
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
      expect((await inspectProfileChange(folder, 1, request)).kind).toBe(
        "profile-change",
      );
      const runCli = async (revision: string) => {
        const child = Bun.spawn(
          [
            process.execPath,
            resolve("src/cli.ts"),
            "profile-preview",
            "--folder",
            folder,
            "--profile",
            JSON.stringify(requested),
            "--expected-revision",
            revision,
          ],
          { env: {}, stdout: "pipe", stderr: "pipe" },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      };
      const cli = await runCli("1");
      expect(cli.code, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual(
        await inspectProfileChange(folder, 1, request),
      );
      const staleCli = await runCli("2");
      expect(staleCli.code).toBe(2);
      expect(JSON.parse(staleCli.stdout)).toEqual({
        kind: "blocked",
        reason: "stale-revision",
      });
      expect((await runCli("1.5")).code).toBe(1);
      expect(await inspectProfileChange(folder, 2, request)).toEqual({
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
        ".operation-lock",
        "instructions.json",
        "preferences.json",
      ]);
      await withFolderOperationLock(state, async () => {
        await expect(inspectProfileChange(folder, 1, request)).rejects.toThrow(
          "busy",
        );
      });
      await writeFile(
        join(state, "pending.json"),
        "preserve transaction evidence",
      );
      await expect(inspectProfileChange(folder, 1, request)).rejects.toThrow(
        "pending",
      );
      expect(await readFile(join(state, "pending.json"), "utf8")).toBe(
        "preserve transaction evidence",
      );
      await rm(join(state, "pending.json"));
      await writeFile(join(state, "preferences.json"), "invalid JSON");
      await expect(inspectProfileChange(folder, 1, request)).rejects.toThrow();
      await rm(join(state, "preferences.json"));
      await symlink(join(folder, "own-notes"), join(state, "preferences.json"));
      await expect(inspectProfileChange(folder, 1, request)).rejects.toThrow(
        "Unsafe",
      );
      expect(await readFile(join(folder, "own-notes"), "utf8")).toBe(
        "Preserve synthetic user work",
      );
      expect((await readdir(state)).sort()).toEqual([
        ".operation-lock",
        "instructions.json",
        "preferences.json",
      ]);
      const externalState = join(temporary, "other-state");
      await rename(state, externalState);
      await symlink(externalState, state);
      await expect(inspectProfileChange(folder, 1, request)).rejects.toThrow(
        "Canonical",
      );
      expect((await readdir(externalState)).sort()).toEqual([
        ".operation-lock",
        "instructions.json",
        "preferences.json",
      ]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
