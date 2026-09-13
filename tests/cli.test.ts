import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform === "win32")(
  "CLI previews explicit fixture and reports conflicts without writes",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "folder-cli-")),
    );
    const profile = JSON.stringify({
      os: "macos",
      access: "local",
      purpose: "human",
      locale: "en",
      detail: "concise",
      coordination: "direct",
    });
    const entry = resolve("src/cli.ts");
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, entry, ...args], {
        cwd: directory,
        env: {},
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };
    try {
      const args = [
        "folder-preview",
        "--folder",
        directory,
        "--profile",
        profile,
      ];
      const fresh = await run(args);
      expect(fresh.code).toBe(0);
      expect(JSON.parse(fresh.stdout).plan.kind).toBe("create");
      expect(await readdir(directory)).toEqual([]);
      await writeFile(join(directory, "AGENTS.md"), "Own instructions");
      const conflict = await run(args);
      expect(conflict.code).toBe(2);
      expect(JSON.parse(conflict.stdout).plan.reason).toBe("unowned-file");
      expect((await run(["folder-preview", "--profile", profile])).code).toBe(
        1,
      );
      const bad = await run([...args, "--unexpected"]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).not.toContain(directory);
      const alias = join(directory, "alias");
      await symlink(directory, alias);
      expect(
        (await run(["folder-preview", "--folder", alias, "--profile", profile]))
          .code,
      ).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
