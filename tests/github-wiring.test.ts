import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type PilotConfig,
  type PilotWiring,
  pilotSchema,
  readPilot,
  writePilot,
} from "../src/github/pilot";
import { removeStoredSignIn } from "../src/github/store";
import {
  githubCredentialHelpers,
  gitIncludeText,
  helperCommand,
  inspectWiring,
  launcherScript,
  unwire,
  type WiringHost,
  wire,
} from "../src/github/wiring";
import { runTool } from "../src/tools/status";
import { type FakeGithub, startFakeGithub } from "./fixtures/fake-github";
import {
  exampleOrganization,
  fakeGh,
  otherOrganization,
  type PilotWorld,
  pilotWorld,
  storeSignIn,
} from "./fixtures/github-pilot";
import { runChild } from "./fixtures/run-child";

// How gh and Git reach the pilot's sign-ins (decision F46) and are given
// back: the launcher at ~/.local/bin/gh with the official gh kept beside it,
// and one Git include for https://github.com — exercised with a real shell
// and a real Git against the fake GitHub.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A compiled Lazurio's place: a script that runs the pilot's entry. */
async function fakeLazurio(world: PilotWorld): Promise<string> {
  const path = join(world.root, "pilot build", "lazurio");
  await mkdir(join(world.root, "pilot build"), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures", "github-pilot-cli.ts")}' "$@"\n`,
  );
  await chmod(path, 0o755);
  return path;
}

async function setup(entry: "file" | "link" | "absent" = "file") {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  let official: string;
  if (entry === "file") official = await fakeGh(world.bin);
  else {
    official = await fakeGh(join(world.root, "elsewhere"));
    if (entry === "link") await symlink(official, join(world.bin, "gh"));
  }
  const env = {
    ...world.env,
    PATH:
      entry === "absent"
        ? `${world.bin}:${join(world.root, "elsewhere")}:${world.env.PATH}`
        : world.env.PATH,
  } as Record<string, string>;
  const config: PilotConfig = {
    schema: pilotSchema,
    organizations: [exampleOrganization, otherOrganization],
    wiring: null,
  };
  await writePilot(world.paths, config);
  const pair = await storeSignIn(world, github, exampleOrganization);
  const executable = await fakeLazurio(world);
  const host: WiringHost = {
    paths: world.paths,
    env,
    platform: process.platform,
    run: runTool,
  };
  const record = async (wiring: PilotWiring | null) =>
    writePilot(world.paths, { ...config, wiring });
  return {
    github,
    world,
    env,
    host,
    executable,
    official,
    pair,
    record,
    config,
  };
}

const git = (env: Record<string, string>, args: string[], cwd?: string) =>
  runChild(["git", ...args], { env, ...(cwd === undefined ? {} : { cwd }) });

async function credentialFill(
  env: Record<string, string>,
  github: FakeGithub,
  path: string,
) {
  const child = Bun.spawn(["git", "credential", "fill"], {
    env: {
      ...env,
      LAZURIO_TEST_GITHUB_ORIGIN: github.origins.web,
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: new Blob([`protocol=https\nhost=github.com\npath=${path}\n\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("wire keeps the official gh, puts the launcher first and moves Git to HTTPS; unwire gives both back", async () => {
  const { github, world, env, host, executable, pair, record } =
    await setup("file");
  const original = await readFile(join(world.bin, "gh"), "utf8");
  const outcome = await wire(host, {
    executable,
    current: null,
    now: () => Date.parse("2026-10-10T08:00:00Z"),
    record,
  });
  expect(outcome).toEqual({
    kind: "wired",
    repaired: false,
    wiring: {
      executable,
      gh: { previous: "file", real: world.paths.savedGh },
      wiredAt: "2026-10-10T08:00:00.000Z",
    },
  });
  // The record is written before the entry changes.
  const pilot = await readPilot(world.paths);
  expect(pilot.kind === "on" && pilot.config.wiring?.gh).toEqual({
    previous: "file",
    real: world.paths.savedGh,
  });
  if (outcome.kind !== "wired") throw new Error("not wired");
  const { wiring } = outcome;
  expect(await readFile(join(world.bin, "gh"), "utf8")).toBe(
    launcherScript(executable),
  );
  expect(await readFile(world.paths.savedGh, "utf8")).toBe(original);
  expect((await stat(join(world.bin, "gh"))).mode & 0o777).toBe(0o755);
  expect(await inspectWiring(host, wiring)).toEqual({ gh: "ok", git: "ok" });

  // Git: the include, HTTPS for SSH-form remotes, one helper for github.com.
  expect(await readFile(world.paths.gitInclude, "utf8")).toBe(
    gitIncludeText(executable),
  );
  const url = await git(env, [
    "ls-remote",
    "--get-url",
    "git@github.com:Example/app.git",
  ]);
  expect(url.stdout.trim()).toBe("https://github.com/Example/app.git");
  const ssh = await git(env, [
    "ls-remote",
    "--get-url",
    "ssh://git@github.com/Example/app.git",
  ]);
  expect(ssh.stdout.trim()).toBe("https://github.com/Example/app.git");
  expect(await githubCredentialHelpers(host)).toEqual([
    helperCommand(executable),
  ]);

  // A real Git asks the pilot's helper, through the shell line, by path.
  const filled = await credentialFill(env, github, "Example/app.git");
  expect(filled.exitCode).toBe(0);
  expect(filled.stdout).toContain("username=x-access-token\n");
  expect(filled.stdout).toContain(`password=${pair.access}\n`);
  expect(filled.stdout).toMatch(/password_expiry_utc=\d+\n/);
  // Another Organization's repository: the owning sign-in, GitHub decides.
  const foreign = await credentialFill(env, github, "Foreign/private.git");
  expect(foreign.stdout).toContain(`password=${pair.access}\n`);
  expect(foreign.stderr).toContain(
    "Foreign is not an Organization this Environment is signed in to",
  );
  // A configured Organization without its sign-in: Git stops, never prompts
  // and never asks another helper.
  const unsigned = await credentialFill(env, github, "Other/app.git");
  expect(unsigned.exitCode).not.toBe(0);
  expect(unsigned.stdout).not.toContain("password=");
  expect(unsigned.stderr).toContain("not signed in to GitHub for Other");

  // gh through the launcher script, a real shell and the kept official gh.
  const recordFile = join(world.root, "gh-record.txt");
  const launched = await runChild(
    [join(world.bin, "gh"), "pr", "list", "-R", "example/app"],
    {
      env: {
        ...env,
        LAZURIO_TEST_GITHUB_ORIGIN: github.origins.web,
        GH_FAKE_RECORD: recordFile,
        GH_TOKEN: "caller-token-value",
      },
    },
  );
  expect(launched.exitCode).toBe(0);
  expect(await readFile(recordFile, "utf8")).toBe(
    `token=${pair.access}\ngithub_token=none\nargs=pr list -R example/app\n`,
  );

  const restored = await unwire(host, wiring);
  expect(restored).toEqual({ kind: "unwired", gh: "restored", git: "removed" });
  expect(await readFile(join(world.bin, "gh"), "utf8")).toBe(original);
  expect(await lstat(world.paths.savedGh).catch(() => null)).toBeNull();
  expect(await lstat(world.paths.gitInclude).catch(() => null)).toBeNull();
  const after = await git(env, [
    "ls-remote",
    "--get-url",
    "git@github.com:Example/app.git",
  ]);
  expect(after.stdout.trim()).toBe("git@github.com:Example/app.git");
  expect(await githubCredentialHelpers(host)).toEqual([]);
  // Again: nothing left to do, nothing breaks.
  expect(await unwire(host, wiring)).toMatchObject({ git: "removed" });
}, 60_000);

test("a link at the entry is replaced and recreated with its own target", async () => {
  const { host, world, executable, official, record } = await setup("link");
  const outcome = await wire(host, {
    executable,
    current: null,
    now: Date.now,
    record,
  });
  expect(outcome.kind).toBe("wired");
  if (outcome.kind !== "wired") return;
  expect(outcome.wiring.gh).toEqual({
    previous: "link",
    real: official,
    target: official,
  });
  expect(await unwire(host, outcome.wiring)).toMatchObject({ gh: "restored" });
  expect(await readlink(join(world.bin, "gh"))).toBe(official);
});

test("a gh found elsewhere is used where it is; the launcher must be found first", async () => {
  const absent = await setup("absent");
  const outcome = await wire(absent.host, {
    executable: absent.executable,
    current: null,
    now: Date.now,
    record: absent.record,
  });
  expect(outcome.kind === "wired" && outcome.wiring.gh).toEqual({
    previous: "absent",
    real: absent.official,
  });
  if (outcome.kind !== "wired") return;
  expect(await unwire(absent.host, outcome.wiring)).toMatchObject({
    gh: "removed",
  });
  expect(
    await lstat(join(absent.world.bin, "gh")).catch(() => null),
  ).toBeNull();

  // ~/.local/bin after another gh on PATH: a launcher there would not be
  // used, so nothing is changed.
  const late = await setup("absent");
  const host = {
    ...late.host,
    env: {
      ...late.env,
      PATH: `${join(late.world.root, "elsewhere")}:${late.world.bin}:${late.world.env.PATH}`,
    },
  };
  expect(
    await wire(host, {
      executable: late.executable,
      current: null,
      now: Date.now,
      record: late.record,
    }),
  ).toEqual({ kind: "blocked", reason: "gh-not-first" });
  expect(await lstat(join(late.world.bin, "gh")).catch(() => null)).toBeNull();
  const pilot = await readPilot(late.world.paths);
  expect(pilot.kind === "on" && pilot.config.wiring).toBeNull();
  expect(await githubCredentialHelpers(host)).toEqual([]);
});

test("what the pilot does not replace stays untouched", async () => {
  const { host, world, executable, record } = await setup("absent");
  await mkdir(join(world.bin, "gh"));
  expect(
    await wire(host, { executable, current: null, now: Date.now, record }),
  ).toEqual({
    kind: "blocked",
    reason: "gh-entry-unsupported",
  });
  expect((await stat(join(world.bin, "gh"))).isDirectory()).toBe(true);
  // A path a shell line cannot carry safely, or no executable at all.
  for (const candidate of [
    join(world.root, "it's", "lazurio"),
    join(world.root, "missing"),
  ])
    expect(
      await wire(host, {
        executable: candidate,
        current: null,
        now: Date.now,
        record,
      }),
    ).toEqual({
      kind: "blocked",
      reason: "executable-unsupported",
    });
  expect(await lstat(world.paths.gitInclude).catch(() => null)).toBeNull();
});

test("a gh updated over the launcher is noticed and wire repairs it", async () => {
  const { host, world, executable, record } = await setup("file");
  const first = await wire(host, {
    executable,
    current: null,
    now: Date.now,
    record,
  });
  if (first.kind !== "wired") throw new Error("not wired");
  // The official installer writes a new gh over the entry.
  await writeFile(
    join(world.bin, "gh"),
    "#!/bin/sh\n# a newer official gh\nexit 0\n",
  );
  expect(await inspectWiring(host, first.wiring)).toEqual({
    gh: "broken",
    git: "ok",
  });
  const repaired = await wire(host, {
    executable,
    current: first.wiring,
    now: Date.now,
    record,
  });
  expect(repaired).toMatchObject({ kind: "wired", repaired: true });
  expect(await readFile(world.paths.savedGh, "utf8")).toContain(
    "a newer official gh",
  );
  expect(await inspectWiring(host, first.wiring)).toEqual({
    gh: "ok",
    git: "ok",
  });
});

test("the launcher answers for gh while the sign-in is gone: local commands only", async () => {
  const { github, world, env, host, executable, record } = await setup("file");
  const outcome = await wire(host, {
    executable,
    current: null,
    now: Date.now,
    record,
  });
  if (outcome.kind !== "wired") throw new Error("not wired");
  await removeStoredSignIn(world.paths, "Example");
  const environment = {
    ...env,
    LAZURIO_TEST_GITHUB_ORIGIN: github.origins.web,
  };
  const version = await runChild([join(world.bin, "gh"), "--version"], {
    env: environment,
  });
  expect(version.exitCode).toBe(0);
  const refused = await runChild([join(world.bin, "gh"), "api", "user"], {
    env: environment,
  });
  expect(refused.exitCode).toBe(4);
  expect(refused.stderr).toContain("not signed in to GitHub for Example");
  // The official gh's credential helper is never what Git falls back to.
  const filled = await credentialFill(env, github, "Example/app.git");
  expect(filled.exitCode).not.toBe(0);
  expect(filled.stdout).not.toContain("password=");
});
