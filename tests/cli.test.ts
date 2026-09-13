import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { previewFolder } from "../src/folder/preview";

test.skipIf(process.platform === "win32")(
  "compiled CLI matches shared preview without ambient runtime",
  async () => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "compiled-folder-cli-")),
    );
    const directory = join(temporary, "fixture");
    const binary = join(temporary, "lazurio-dev");
    try {
      await mkdir(directory, { mode: 0o700 });
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          resolve("src/cli.ts"),
          "--compile",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [, buildError, buildCode] = await Promise.all([
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
        build.exited,
      ]);
      expect(buildCode, buildError).toBe(0);
      const profile = {
        os: process.platform === "darwin" ? "macos" : "linux",
        access: "local",
        purpose: "human",
        locale: "en",
        detail: "concise",
        coordination: "direct",
      };
      const child = Bun.spawn(
        [
          binary,
          "folder-preview",
          "--folder",
          directory,
          "--profile",
          JSON.stringify(profile),
        ],
        { cwd: directory, env: {}, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual(
        await previewFolder(profile, null, async () => ({ kind: "absent" })),
      );
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "CLI previews explicit fixture and reports conflicts without writes",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "folder-cli-")),
    );
    const profile = JSON.stringify({
      os: process.platform === "darwin" ? "macos" : "linux",
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
      const wrongOs = JSON.stringify({ ...JSON.parse(profile), os: "windows" });
      expect(
        (
          await run([
            "folder-preview",
            "--folder",
            directory,
            "--profile",
            wrongOs,
          ])
        ).code,
      ).toBe(1);
      expect(fresh.code).toBe(0);
      expect(JSON.parse(fresh.stdout).plan.kind).toBe("create");
      const choices = [
        "--access",
        "local",
        "--purpose",
        "human",
        "--locale",
        "en",
        "--detail",
        "concise",
        "--coordination",
        "direct",
      ];
      const fromChoices = await run([
        "folder-preview",
        "--folder",
        directory,
        ...choices,
      ]);
      expect(fromChoices.code).toBe(0);
      expect(JSON.parse(fromChoices.stdout)).toEqual(JSON.parse(fresh.stdout));
      expect((await run([...args, ...choices])).code).toBe(1);
      expect(
        (
          await run([
            "folder-preview",
            "--folder",
            directory,
            ...choices.slice(2),
          ])
        ).code,
      ).toBe(1);
      const help = await run(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("No files are written");
      expect((await run(["--help", "--folder", directory])).code).toBe(1);
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
