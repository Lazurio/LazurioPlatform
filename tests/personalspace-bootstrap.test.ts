import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommitIdentity,
  githubCommitIdentity,
} from "../src/content/commit-identity";
import {
  bootstrapFailureDetail,
  isTemplateCheckout,
  personalspaceOwnerOf,
  processPersonalspaceBootstrap,
} from "../src/content/personalspace-bootstrap";
import { runTool, type ToolRunner } from "../src/tools/status";
import {
  createWorld,
  operatorGitEnv,
  remoteRepository,
  type World,
  writeTemplate,
} from "./fixtures/content-world";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// The Platform's half of running the template's bootstrap (decision F9,
// addendum of 2026-10-14): the command line it runs, the reason it reports,
// and the commit and push of exactly the files the template's manual names.
// Real git over local bare repositories; synthetic names only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const github: CommitIdentity = githubCommitIdentity({
  login: "example",
  databaseId: 12345,
});

const tools = (current: World, run: ToolRunner = runTool) => ({
  path: Bun.env.PATH,
  home: current.home,
  platform: process.platform,
  run,
});

async function git(cwd: string, ...args: string[]) {
  const result = await runChild(["git", "-C", cwd, ...args], {
    env: {
      PATH: Bun.env.PATH ?? "/usr/bin:/bin",
      HOME: (world as World).home,
      ...operatorGitEnv(world as World),
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

posixTest(
  "the template's bootstrap runs as `bun run bootstrap` in the checkout, with the same Bun first on its PATH",
  async () => {
    world = await createWorld();
    const seen: { command: readonly string[]; env: Record<string, string> }[] =
      [];
    const capture: ToolRunner = async (command, _timeout, env) => {
      seen.push({ command, env: { ...env } });
      return { exitCode: 0, stdout: "Bootstrap dokončen.", stderr: "" };
    };
    const bootstrap = processPersonalspaceBootstrap(
      tools(world, capture),
      { ...operatorGitEnv(world), SECRET_TOKEN: "never-passed" },
      { bunExecutable: process.execPath },
    );
    expect(
      await bootstrap.run("/folder/personalspace/example_GEN3", {
        login: "example",
        displayName: "Ex Ample",
      }),
    ).toEqual({ ok: true });
    expect(seen[0]?.command).toEqual([
      process.execPath,
      "run",
      "--cwd",
      "/folder/personalspace/example_GEN3",
      "bootstrap",
      "--",
      "--login",
      "example",
      "--display-name",
      "Ex Ample",
      "--apply",
    ]);
    const env = seen[0]?.env ?? {};
    expect(env.PATH?.startsWith(`${join(process.execPath, "..")}:`)).toBe(true);
    expect(env.HOME).toBe(world.home);
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe(world.gitEnv.GIT_CONFIG_KEY_0);
    // Only what git and gh legitimately take from the environment.
    expect(env.SECRET_TOKEN).toBeUndefined();
    // Without --install-gbrain: installing the gbrain CLI stays the person's.
    expect(seen[0]?.command).not.toContain("--install-gbrain");
  },
);

test("a failed bootstrap reports its own reason line", () => {
  expect(
    bootstrapFailureDetail(
      '$ bun scripts/bootstrap-personalspace.mjs --apply\nBootstrap selhal: gh selhal (exit 1): HTTP 403\nerror: script "bootstrap" exited with code 1',
      "Personalspace preflight PASS",
    ),
  ).toBe("Bootstrap selhal: gh selhal (exit 1): HTTP 403");
  expect(bootstrapFailureDetail("", "")).toBe("no output");
  expect(bootstrapFailureDetail("killed\n", "")).toBe("killed");
});

posixTest(
  "ready asks for Bun and the operator's Git identity before anything is created",
  async () => {
    world = await createWorld();
    const folder = join(world.root, "folder");
    await mkdir(folder);
    const ready = (identity: boolean, bun: string, fallback?: CommitIdentity) =>
      processPersonalspaceBootstrap(
        tools(world as World),
        operatorGitEnv(world as World, identity),
        { bunExecutable: bun },
      ).ready(folder, fallback);
    expect(await ready(true, process.execPath)).toEqual({ ok: true });
    // No Git identity: GitHub's will do; refused only without either.
    expect(await ready(false, process.execPath, github)).toEqual({ ok: true });
    expect(await ready(false, process.execPath)).toMatchObject({
      ok: false,
      code: "git-identity-missing",
    });
    expect(await ready(true, join(world.root, "no-bun"))).toMatchObject({
      ok: false,
      code: "personalspace-toolchain-missing",
    });
  },
);

posixTest(
  "publish commits only the named files, pushes the branch, and says which stage failed",
  async () => {
    world = await createWorld();
    const bare = await remoteRepository(world, "example/space", (directory) =>
      writeTemplate(directory, "template"),
    );
    const checkout = join(world.root, "space");
    await git(world.root, "clone", "--quiet", bare, checkout);
    const bootstrap = processPersonalspaceBootstrap(
      tools(world),
      operatorGitEnv(world),
    );
    await writeFile(join(checkout, "modules.manifest.json"), '{"owner":"x"}');
    await writeFile(join(checkout, "unrelated.txt"), "left alone");
    expect(
      await bootstrap.publish(
        checkout,
        ["personal.gen3.json", "modules.manifest.json"],
        "Nastav Personalspace GEN3",
      ),
    ).toEqual({ ok: true, committed: true });
    expect(await git(bare, "show", "main:modules.manifest.json")).toBe(
      '{"owner":"x"}',
    );
    expect(await git(checkout, "status", "--porcelain")).toBe(
      "?? unrelated.txt",
    );
    // Unchanged: nothing to commit, the push is a no-op.
    expect(
      await bootstrap.publish(checkout, ["modules.manifest.json"], "again"),
    ).toEqual({ ok: true, committed: false });
    // No Git identity: the GitHub one, given to this commit only.
    const bare2 = await remoteRepository(world, "example/other", (directory) =>
      writeTemplate(directory, "template"),
    );
    const other = join(world.root, "other");
    await git(world.root, "clone", "--quiet", bare2, other);
    await writeFile(join(other, "modules.manifest.json"), '{"owner":"z"}');
    const anonymous = processPersonalspaceBootstrap(
      tools(world),
      operatorGitEnv(world, false),
    );
    expect(
      await anonymous.publish(
        other,
        ["modules.manifest.json"],
        "Nastav Personalspace GEN3",
        undefined,
        github,
      ),
    ).toEqual({ ok: true, committed: true });
    expect(
      await git(bare2, "log", "-1", "--format=%an <%ae>|%cn <%ce>", "main"),
    ).toBe(
      "example <12345+example@users.noreply.github.com>|example <12345+example@users.noreply.github.com>",
    );
    // Nothing configured: neither in the checkout nor in the home.
    expect(
      (
        await runChild(
          ["git", "-C", other, "config", "--local", "--get", "user.email"],
          { env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" } },
        )
      ).stdout,
    ).toBe("");
    expect(existsSync(join(world.home, ".gitconfig"))).toBe(false);
    // GitHub refuses the push: the stage and git's own last line.
    const hook = join(bare, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeFile(join(checkout, "personal.gen3.json"), '{"owner":"y"}');
    const refused = await bootstrap.publish(
      checkout,
      ["personal.gen3.json"],
      "Nastav Personalspace GEN3",
    );
    expect(refused).toMatchObject({ ok: false, stage: "push" });
    expect(refused.ok === false && refused.detail).toContain("git push failed");
  },
  30_000,
);

posixTest(
  "the owner is read from the template's two declarations, never written",
  async () => {
    world = await createWorld();
    const directory = join(world.root, "space");
    await mkdir(directory);
    await writeTemplate(directory, "template");
    expect(await personalspaceOwnerOf(directory)).toEqual({
      kind: "placeholder",
    });
    expect(
      await isTemplateCheckout(directory, "lazurio/personalspacetemplate_gen3"),
    ).toBe(true);
    expect(await isTemplateCheckout(directory, "Other/Template")).toBe(false);
    await writeFile(
      join(directory, "personal.gen3.json"),
      JSON.stringify({
        owner: { github_username: "example" },
        gbrain: { repository: { github_repo: "example/example-gbrain" } },
      }),
    );
    await writeFile(
      join(directory, "modules.manifest.json"),
      JSON.stringify({ owner: "example" }),
    );
    expect(await personalspaceOwnerOf(directory)).toEqual({
      kind: "named",
      login: "example",
      gbrain: "example/example-gbrain",
    });
    await writeFile(join(directory, "modules.manifest.json"), "not json");
    expect(await personalspaceOwnerOf(directory)).toEqual({
      kind: "unreadable",
    });
  },
);
