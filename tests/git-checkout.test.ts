import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubRemoteCoordinate,
  inspectGitCheckout,
} from "../src/providers/git-checkout";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

test("remote parsing returns only exact GitHub coordinates and rejects credential-bearing URLs", () => {
  for (const url of [
    "https://github.com/Example/fixture.git",
    "git@github.com:Example/fixture.git",
    "ssh://git@github.com/Example/fixture",
    "https://github.com/Example/fixture",
  ])
    expect(githubRemoteCoordinate(url)).toBe("Example/fixture");
  for (const url of [
    "https://user:synthetic@github.com/Example/fixture",
    "https://github.com/Example/fixture?x=1",
    "git@elsewhere:Example/fixture",
    "file:///fixture",
    "https://github.com/Example/../fixture",
    "https://github.com/Example/fixture\n",
    "https://github.com/Example/fixture#x",
    "https://github.com/Example/.git",
  ])
    expect(githubRemoteCoordinate(url)).toBe(null);
});

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Git checkout inspection preserves work and distinguishes nested paths and multiple origins",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "git-checkout-")));
    const directory = join(root, "repo");
    await mkdir(directory, { mode: 0o700 });
    const git = async (args: string[]) => {
      // Git creates its own metadata; constrain only this fixture subprocess.
      const child = Bun.spawn(
        [
          "/bin/sh",
          "-c",
          'umask 077; exec /usr/bin/git "$@"',
          "fixture-git",
          ...args,
        ],
        {
          cwd: directory,
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [error, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, error).toBe(0);
    };
    try {
      await git(["init", "--quiet"]);
      await git([
        "remote",
        "add",
        "origin",
        "https://github.com/Example/fixture.git",
      ]);
      await writeFile(join(directory, "untracked.txt"), "preserve this work");
      const configBefore = await readFile(join(directory, ".git/config"));
      expect(await inspectGitCheckout(directory, "/usr/bin/git")).toMatchObject(
        { kind: "checkout-observed", repository: "Example/fixture", directory },
      );
      expect(await readFile(join(directory, ".git/config"))).toEqual(
        configBefore,
      );
      expect(await readFile(join(directory, "untracked.txt"), "utf8")).toBe(
        "preserve this work",
      );
      const nested = join(directory, "nested");
      await mkdir(nested, { mode: 0o700 });
      expect(await inspectGitCheckout(nested, "/usr/bin/git")).toEqual({
        kind: "not-checkout-root",
      });
      await git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "fixture",
      ]);
      const linked = join(root, "linked");
      await git(["worktree", "add", "--detach", linked]);
      await writeFile(join(linked, "local-work.txt"), "keep linked work");
      const linkBefore = await readFile(join(linked, ".git"));
      expect(await inspectGitCheckout(linked, "/usr/bin/git")).toMatchObject({
        kind: "checkout-observed",
        repository: "Example/fixture",
        directory: linked,
        commonDirectory: join(directory, ".git"),
      });
      expect(await readFile(join(linked, ".git"))).toEqual(linkBefore);
      expect(await readFile(join(linked, "local-work.txt"), "utf8")).toBe(
        "keep linked work",
      );
      await git([
        "config",
        "--add",
        "remote.origin.url",
        "https://github.com/Other/fixture.git",
      ]);
      expect(await inspectGitCheckout(directory, "/usr/bin/git")).toEqual({
        kind: "remote-unavailable",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
