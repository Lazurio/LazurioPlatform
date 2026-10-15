import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processContentGit } from "../src/content/git";
import { runTool } from "../src/tools/status";

// Lazurio's own git writes (`processContentGit`: init, add, commit, remote,
// push) start no background maintenance (#442). Git ends `git commit` by
// starting `git maintenance run --auto --detach`, which outlives the command
// and keeps writing into the repository; a temporary sibling removed right
// after a commit (`publishNewCheckout`, a refused `lazurio module create`)
// then sometimes survived its removal, and the module-create tests that read
// `workspace/` right after a refusal failed now and then. Real git, a private
// home and a local bare remote; nothing of the machine's configuration.

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
const identity = { name: "Test", email: "test@example.com" } as const;

async function scratch() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "content-git-maintenance-")),
  );
  const home = join(root, "home");
  await mkdir(home);
  const trace = join(root, "trace");
  const git = processContentGit({
    path: process.env.PATH,
    home,
    platform: process.platform,
    run: runTool,
    // Git writes every command it runs, and each one it starts, here.
    env: { GIT_TRACE: trace },
  });
  return { root, home, trace, git };
}

posixTest(
  "a commit and a push of Lazurio start no background maintenance",
  async () => {
    const { root, trace, git } = await scratch();
    try {
      const checkout = join(root, "checkout");
      await mkdir(checkout);
      await writeFile(join(checkout, "README.md"), "x\n");
      expect(await git.commitAll(checkout, "First", identity)).toEqual({
        ok: true,
      });
      // The bare remote stands for GitHub: its own receive-pack's maintenance
      // (`receive.autogc`, the server's side, which never runs on this
      // machine with a real remote) is off, so the trace holds only what
      // Lazurio runs.
      const remote = join(root, "remote.git");
      expect(
        spawnSync("git", ["init", "--quiet", "--bare", remote]).status,
      ).toBe(0);
      expect(
        spawnSync("git", ["-C", remote, "config", "receive.autogc", "false"])
          .status,
      ).toBe(0);
      expect(await git.push(checkout, { url: remote })).toEqual({ ok: true });
      const commands = await readFile(trace, "utf8");
      // The writes ran, and nothing of git's maintenance did.
      expect(commands).toContain("built-in: git commit");
      expect(commands).toContain("built-in: git push");
      expect(commands).not.toContain("maintenance run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
