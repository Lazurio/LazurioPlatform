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
import { join, resolve } from "node:path";
import { initializeFolder } from "../src/folder/initialize-folder";
import { previewFolder } from "../src/folder/preview";
import { updateProfile } from "../src/folder/update-profile";

test.skipIf(process.platform === "win32")(
  "compiled CLI initializes, updates and recovers a fresh fixture without ambient runtime",
  async () => {
    const temporary = await realpath(
      await mkdtemp(join(tmpdir(), "compiled-folder-cli-")),
    );
    let directory = join(temporary, "fixture");
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
      const interrupted = join(temporary, "interrupted-init");
      await expect(
        initializeFolder(interrupted, profile, async (step) => {
          if (step === "instructions")
            throw new Error("initialization interrupted");
        }),
      ).rejects.toThrow("initialization interrupted");
      for (const extra of [["--locale", "cs"], [], []]) {
        const recovery = Bun.spawn(
          [binary, "folder-resume", "--folder", interrupted, ...extra],
          { env: {}, stdout: "pipe", stderr: "pipe" },
        );
        const [output, error, status] = await Promise.all([
          new Response(recovery.stdout).text(),
          new Response(recovery.stderr).text(),
          recovery.exited,
        ]);
        expect(status, error).toBe(extra.length ? 1 : 0);
        if (!extra.length)
          expect(JSON.parse(output)).toEqual({
            kind: "recovered",
            revision: 1,
          });
      }
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
        await previewFolder(
          { preset: "local", machine: null, profile },
          null,
          async () => ({ kind: "absent" }),
        ),
      );
      expect(await readdir(directory)).toEqual([]);
      const initial = await previewFolder(
        { preset: "local", machine: null, profile },
        null,
        async () => ({ kind: "absent" }),
      );
      const initialize = async (path: string, extra: string[] = []) => {
        const child = Bun.spawn(
          [
            binary,
            "folder-init",
            "--folder",
            path,
            "--profile",
            JSON.stringify(profile),
            ...extra,
          ],
          { cwd: temporary, env: {}, stdout: "pipe", stderr: "pipe" },
        );
        const [out, error, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { out, error, exit };
      };
      expect((await initialize(directory)).exit).toBe(1);
      expect(await readdir(directory)).toEqual([]);
      directory = join(temporary, "new-folder");
      expect(
        (await initialize(directory, ["--expected-revision", "1"])).exit,
      ).toBe(1);
      expect(await readdir(temporary)).not.toContain("new-folder");
      const created = await initialize(directory);
      expect(created.exit, created.error).toBe(0);
      expect(JSON.parse(created.out)).toEqual({
        kind: "initialized",
        revision: 1,
        preset: { name: "local", version: 1, selection: "derived" },
      });
      expect((await initialize(directory)).exit).toBe(1);
      const state = join(directory, ".lazurio");
      await writeFile(join(directory, "unrelated"), "Preserve work");
      const invoke = async (
        revision: string | null,
        locale: string,
        extra: string[] = [],
      ) => {
        const args = [
          binary,
          "profile-update",
          "--folder",
          directory,
          "--profile",
          JSON.stringify({ ...profile, locale }),
        ];
        if (revision !== null) args.push("--expected-revision", revision);
        args.push(...extra);
        const process = Bun.spawn(args, {
          cwd: directory,
          env: {},
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, error, exit] = await Promise.all([
          new Response(process.stdout).text(),
          new Response(process.stderr).text(),
          process.exited,
        ]);
        return { out, error, exit };
      };
      expect((await invoke(null, "cs")).exit).toBe(1);
      for (const duplicate of [
        ["--folder", directory],
        ["--expected-revision=1"],
        ["--profile", JSON.stringify({ ...profile, locale: "cs" })],
      ]) {
        const rejected = await invoke("1", "cs", duplicate);
        expect(rejected.exit).toBe(1);
        expect(rejected.out).toBe("");
        expect(rejected.error).not.toContain(directory);
        expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
          initial.desired.content,
        );
        expect(await readdir(state)).not.toContain("transaction");
      }
      expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
        initial.desired.content,
      );
      const updated = await invoke("1", "cs");
      expect(updated.exit, updated.error).toBe(0);
      expect(JSON.parse(updated.out)).toEqual({ kind: "updated", revision: 2 });
      const stale = await invoke("1", "en");
      expect(stale.exit).toBe(2);
      expect(JSON.parse(stale.out)).toEqual({
        kind: "blocked",
        reason: "stale-revision",
      });
      const unchanged = await invoke("2", "cs");
      expect(unchanged.exit).toBe(0);
      expect(JSON.parse(unchanged.out)).toEqual({ kind: "unchanged" });
      await expect(
        updateProfile(directory, 2, { profile }, async (step) => {
          if (step === "prepared") throw new Error("Prepared interruption");
        }),
      ).rejects.toThrow("Prepared interruption");
      const beforeResume = await readFile(join(directory, "AGENTS.md"));
      const resume = async (revision: string, extra: string[] = []) => {
        const child = Bun.spawn(
          [
            binary,
            "profile-resume",
            "--folder",
            directory,
            "--target-revision",
            revision,
            ...extra,
          ],
          { cwd: directory, env: {}, stdout: "pipe", stderr: "pipe" },
        );
        const [out, error, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { out, error, exit };
      };
      expect((await resume("4")).exit).toBe(1);
      expect((await resume("3", ["--target-revision=3"])).exit).toBe(1);
      expect((await resume("3", ["--locale", "cs"])).exit).toBe(1);
      expect(await readFile(join(directory, "AGENTS.md"))).toEqual(
        beforeResume,
      );
      expect(
        JSON.parse(await readFile(join(state, "preferences.json"), "utf8"))
          .revision,
      ).toBe(2);
      const recovered = await resume("3");
      expect(recovered.exit, recovered.error).toBe(0);
      expect(JSON.parse(recovered.out)).toEqual({
        kind: "recovered",
        revision: 3,
      });
      expect((await resume("3")).exit).toBe(0);
      expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
        initial.desired.content,
      );
      await writeFile(
        join(directory, "AGENTS.md"),
        "Preserve manual instruction edit",
      );
      expect((await invoke("3", "cs")).exit).toBe(2);
      expect((await resume("3")).exit).toBe(1);
      expect(await readFile(join(directory, "AGENTS.md"), "utf8")).toBe(
        "Preserve manual instruction edit",
      );
      expect(await readFile(join(directory, "unrelated"), "utf8")).toBe(
        "Preserve work",
      );
      expect((await readdir(join(state, "history"))).sort()).toEqual([
        "initialization",
        "revision-2",
        "revision-3",
      ]);
      expect(await readdir(state)).not.toContain("transaction");
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
