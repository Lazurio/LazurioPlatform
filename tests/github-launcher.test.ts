import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyGh,
  type LauncherHost,
  runGhLauncher,
  runInherited,
} from "../src/github/launcher";
import { githubHttp } from "../src/github/oauth";
import { removeStoredSignIn } from "../src/github/store";
import { type FakeGithub, startFakeGithub } from "./fixtures/fake-github";
import {
  enablePilot,
  exampleOrganization,
  fakeGh,
  otherOrganization,
  type PilotWorld,
  pilotWorld,
  storeSignIn,
} from "./fixtures/github-pilot";

// The gh launcher (decision F46): the official gh with GH_TOKEN of the
// repository owner's Organization sign-in, chosen per command; gh's own
// arguments, output and exit status otherwise.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Call = {
  gh: string;
  args: readonly string[];
  env: Record<string, string>;
};

async function setup() {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world, [exampleOrganization, otherOrganization]);
  const gh = await fakeGh(join(world.root, "official"));
  const example = await storeSignIn(world, github, exampleOrganization);
  const other = await storeSignIn(world, github, otherOrganization);
  return { github, world, gh, example, other };
}

function launcher(
  world: PilotWorld,
  github: FakeGithub,
  gh: string,
  extra: {
    env?: Record<string, string>;
    origin?: string | null;
    exit?: number;
    stdin?: string;
  } = {},
) {
  const calls: Call[] = [];
  const stderr: string[] = [];
  const stdout: string[] = [];
  const host: LauncherHost = {
    env: {
      ...world.env,
      PATH: `${join(world.root, "official")}:${world.env.PATH}`,
      ...extra.env,
    },
    paths: world.paths,
    http: githubHttp({ origins: github.origins }),
    now: () => Date.now(),
    readOrigin: async () => extra.origin ?? null,
    runGh: async (path, args, env) => {
      calls.push({ gh: path, args, env: { ...env } });
      return extra.exit ?? 0;
    },
    writeStderr: (text) => stderr.push(text),
    readStdin: async () => extra.stdin ?? "",
    writeStdout: (text) => stdout.push(text),
  };
  return {
    calls,
    stderr,
    stdout,
    run: (args: string[]) => runGhLauncher(args, host),
    gh,
  };
}

test("what the launcher runs without an account, refuses, or gives an account", () => {
  const cases: [string[], Record<string, string>, string][] = [
    [[], {}, "local"],
    [["--version"], {}, "local"],
    [["help", "pr"], {}, "local"],
    [["pr", "list", "--help"], {}, "local"],
    [["config", "get", "git_protocol"], {}, "local"],
    [["completion", "-s", "bash"], {}, "local"],
    [["auth"], {}, "local"],
    [["auth", "status"], {}, "account"],
    [["auth", "status", "--json", "hosts"], {}, "account"],
    [["auth", "logout", "--hostname", "github.com"], {}, "logout"],
    [["auth", "login", "--web"], {}, "refused-auth"],
    [["auth", "refresh"], {}, "refused-auth"],
    [["auth", "switch"], {}, "refused-auth"],
    [["auth", "setup-git"], {}, "refused-auth"],
    [["auth", "token"], {}, "refused-auth"],
    // Answered by the pilot's helper (Git names gh as its helper).
    [["auth", "git-credential", "get"], {}, "git-credential"],
    // Within gh auth, -h is the host, never help.
    [["auth", "login", "-h", "github.com", "-w"], {}, "refused-auth"],
    [["auth", "setup-git", "-h", "github.com"], {}, "refused-auth"],
    [["auth", "refresh", "-h", "github.com", "-s", "repo"], {}, "refused-auth"],
    [["auth", "token", "-h", "github.com"], {}, "refused-auth"],
    [["auth", "status", "-h", "github.com"], {}, "account"],
    [["auth", "status", "-h", "ghe.example.com"], {}, "refused-host"],
    [["auth", "status", "--show-token=true"], {}, "refused-token"],
    [["auth", "status", "-at"], {}, "refused-token"],
    [["auth", "status", "-t=true"], {}, "refused-token"],
    // A flag between auth and its subcommand: gh resolves it, the launcher
    // would not.
    [["auth", "-h", "github.com", "token"], {}, "refused-order"],
    [["auth", "--hostname", "github.com", "setup-git"], {}, "refused-order"],
    [["auth", "-h", "github.com", "login", "--web"], {}, "refused-order"],
    [["auth", "--help"], {}, "local"],
    [["auth", "-h"], {}, "local"],
    // A GitHub Enterprise Cloud tenant's URL in any command.
    [
      ["pr", "view", "https://tenant.ghe.com/Example/app/pull/1"],
      {},
      "refused-host",
    ],
    [
      ["repo", "clone", "https://Tenant.GHE.com/Example/app"],
      {},
      "refused-host",
    ],
    [
      ["issue", "create", "--body", "https://example.com/report"],
      {},
      "account",
    ],
    // gh resolves a command after a leading flag; the launcher would not.
    [["--hostname", "github.com", "auth", "token"], {}, "refused-order"],
    [["-R", "Example/app", "pr", "list"], {}, "refused-order"],
    // A whole URL for gh api: GitHub's API only.
    [["api", "https://api.github.com/user"], {}, "account"],
    [
      ["api", "https://uploads.github.com/repos/Example/app/releases/1/assets"],
      {},
      "account",
    ],
    [["api", "https://api.tenant.ghe.com/user"], {}, "refused-host"],
    [["api", "http://api.github.com/user"], {}, "refused-host"],
    // A URL as a field value is a value.
    [
      ["api", "repos/Example/app/issues", "-f", "body=https://example.com"],
      {},
      "account",
    ],
    [["auth", "status", "--show-token"], {}, "refused-token"],
    [["auth", "status", "-t"], {}, "refused-token"],
    [["api", "user", "--show-token"], {}, "refused-token"],
    // -t is --template outside gh auth.
    [["pr", "list", "-t", "{{.title}}"], {}, "account"],
    [["api", "user", "--hostname", "ghe.example.com"], {}, "refused-host"],
    [["api", "user", "--hostname=ghe.example.com"], {}, "refused-host"],
    [["api", "user", "--hostname", "github.com"], {}, "account"],
    [["api", "user"], { GH_HOST: "ghe.example.com" }, "refused-host"],
    // Help and versions need no account and no host.
    [["--version"], { GH_HOST: "ghe.example.com" }, "local"],
    [["api", "user"], { GH_HOST: "github.com" }, "account"],
    [["pr", "create", "--fill"], {}, "account"],
    // After -- the arguments are another program's.
    [["repo", "clone", "Example/app", "--", "--show-token"], {}, "account"],
  ];
  for (const [args, env, expected] of cases)
    expect([args, classifyGh(args, env)]).toEqual([args, expected as never]);
});

test("each command gets the token of its repository owner's Organization", async () => {
  const { github, world, gh, example, other } = await setup();
  const run = launcher(world, github, gh);
  expect(await run.run(["pr", "list", "-R", "Example/app"])).toBe(0);
  expect(await run.run(["pr", "list", "--repo", "other/app"])).toBe(0);
  expect(await run.run(["api", "repos/Other/app/pulls"])).toBe(0);
  expect(await run.run(["repo", "clone", "Example/app"])).toBe(0);
  // Naming no repository: the owning Organization.
  expect(await run.run(["api", "user"])).toBe(0);
  expect(run.calls.map((call) => call.env.GH_TOKEN)).toEqual([
    example.access,
    other.access,
    other.access,
    example.access,
    example.access,
  ]);
  // The official gh, with its own arguments.
  expect(run.calls[0]?.gh).toBe(gh);
  expect(run.calls[0]?.args).toEqual(["pr", "list", "-R", "Example/app"]);
  expect(run.stderr).toEqual([]);
});

test("the checkout's origin names the owner when the command does not", async () => {
  const { github, world, gh, other } = await setup();
  const run = launcher(world, github, gh, {
    origin: "git@github.com:Other/app.git",
  });
  expect(await run.run(["pr", "list"])).toBe(0);
  expect(run.calls[0]?.env.GH_TOKEN).toBe(other.access);
  const https = launcher(world, github, gh, {
    origin: "https://github.com/Other/app.git",
  });
  expect(await https.run(["pr", "status"])).toBe(0);
  expect(https.calls[0]?.env.GH_TOKEN).toBe(other.access);
});

test("another owner gets the owning Organization's sign-in and GitHub decides", async () => {
  const { github, world, gh, example } = await setup();
  const succeeded = launcher(world, github, gh);
  expect(await succeeded.run(["api", "repos/cli/cli/releases/latest"])).toBe(0);
  expect(succeeded.calls[0]?.env.GH_TOKEN).toBe(example.access);
  expect(succeeded.stderr).toEqual([]);
  // A refusal of GitHub's is explained, never retried with anything else.
  const refused = launcher(world, github, gh, { exit: 1 });
  expect(await refused.run(["repo", "view", "Foreign/private"])).toBe(1);
  expect(refused.calls).toHaveLength(1);
  expect(refused.stderr.join("")).toContain(
    "Foreign is not an Organization this Environment is signed in to (Example, Other)",
  );
});

test("an Organization without its sign-in fails closed and says what to do", async () => {
  const { github, world, gh } = await setup();
  await removeStoredSignIn(world.paths, "Other");
  const run = launcher(world, github, gh);
  expect(await run.run(["pr", "list", "-R", "Other/app"])).toBe(4);
  expect(run.calls).toEqual([]);
  expect(run.stderr.join("")).toContain(
    "not signed in to GitHub for Other. The Operator signs in with lazurio github sign-in --organization Other",
  );
});

test("other credentials never reach gh beside the chosen sign-in", async () => {
  const { github, world, gh, example } = await setup();
  const run = launcher(world, github, gh, {
    env: {
      GH_TOKEN: "caller-token-value",
      GITHUB_TOKEN: "caller-token-value",
      GH_ENTERPRISE_TOKEN: "caller-token-value",
    },
  });
  expect(await run.run(["api", "user"])).toBe(0);
  expect(run.calls[0]?.env.GH_TOKEN).toBe(example.access);
  expect(run.calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
  expect(run.calls[0]?.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
  // Local commands and gh auth logout run without any token: a sign-out
  // removes only what gh stored itself.
  expect(await run.run(["--version"])).toBe(0);
  expect(await run.run(["auth", "logout", "--hostname", "github.com"])).toBe(0);
  for (const call of run.calls.slice(1)) {
    expect(call.env.GH_TOKEN).toBeUndefined();
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
  }
});

test("local commands work while signed out; refusals never run gh", async () => {
  const { github, world, gh } = await setup();
  await removeStoredSignIn(world.paths, "Example");
  const run = launcher(world, github, gh);
  expect(await run.run(["--version"])).toBe(0);
  expect(run.calls).toHaveLength(1);
  for (const args of [
    ["auth", "login", "--web"],
    ["auth", "token"],
    ["auth", "status", "--show-token"],
    ["api", "user", "--hostname", "ghe.example.com"],
  ])
    expect(await run.run(args)).toBe(1);
  expect(
    await run.run(["pr", "list", "-R", "Example/a", "-R", "Other/b"]),
  ).toBe(1);
  expect(run.calls).toHaveLength(1);
  expect(run.stderr.join("")).toContain("gh auth login is not used here");
  expect(run.stderr.join("")).toContain("tokens are never printed");
  expect(run.stderr.join("")).toContain("serves github.com only");
  expect(run.stderr.join("")).toContain("repositories of different owners");
});

test("gh auth git-credential answers Git with the owner's sign-in, never gh's own", async () => {
  const { github, world, gh, example, other } = await setup();
  const request = (path: string) =>
    `protocol=https\nhost=github.com\npath=${path}\n\n`;
  const forOther = launcher(world, github, gh, {
    stdin: request("Other/app.git"),
  });
  expect(await forOther.run(["auth", "git-credential", "get"])).toBe(0);
  expect(forOther.stdout.join("")).toContain(`password=${other.access}\n`);
  expect(forOther.calls).toEqual([]);
  const forExample = launcher(world, github, gh, {
    stdin: request("Example/app.git"),
  });
  expect(await forExample.run(["auth", "git-credential", "get"])).toBe(0);
  expect(forExample.stdout.join("")).toContain(`password=${example.access}\n`);
  // store and erase keep nothing.
  const store = launcher(world, github, gh, {
    stdin: request("Example/app.git"),
  });
  expect(await store.run(["auth", "git-credential", "store"])).toBe(0);
  expect(store.stdout.join("")).toBe("");
  // Signed out: Git stops, never falls back.
  await removeStoredSignIn(world.paths, "Other");
  const signedOut = launcher(world, github, gh, {
    stdin: request("Other/app.git"),
  });
  expect(await signedOut.run(["auth", "git-credential", "get"])).toBe(0);
  expect(signedOut.stdout.join("")).toBe("quit=1\n");
});

test("without the pilot or the official gh, the launcher refuses", async () => {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  const off = launcher(world, github, "/nonexistent/gh");
  expect(await off.run(["api", "user"])).toBe(1);
  expect(off.stderr.join("")).toContain("pilot is off");
  await enablePilot(world);
  const missing: string[] = [];
  const code = await runGhLauncher(["api", "user"], {
    env: { ...world.env, PATH: "/nonexistent" },
    paths: world.paths,
    http: githubHttp({ origins: github.origins }),
    now: () => Date.now(),
    readOrigin: async () => null,
    runGh: async () => 0,
    writeStderr: (text) => missing.push(text),
    readStdin: async () => "",
    writeStdout: () => {},
  });
  expect(code).toBe(1);
  expect(missing.join("")).toContain("the official gh is not on PATH");
});

test("the official gh runs on this terminal with its own exit status", async () => {
  const { github, world, gh, example } = await setup();
  const record = join(world.root, "record.txt");
  const host = (exit: string): LauncherHost => ({
    env: {
      ...world.env,
      PATH: `${join(world.root, "official")}:${world.env.PATH}`,
      GH_FAKE_RECORD: record,
      GH_FAKE_EXIT: exit,
    },
    paths: world.paths,
    http: githubHttp({ origins: github.origins }),
    now: () => Date.now(),
    readOrigin: async () => null,
    runGh: runInherited,
    writeStderr: () => {},
    readStdin: async () => "",
    writeStdout: () => {},
  });
  expect(
    await runGhLauncher(["pr", "view", "12", "-R", "Example/app"], host("0")),
  ).toBe(0);
  expect(await readFile(record, "utf8")).toBe(
    `token=${example.access}\ngithub_token=none\nargs=pr view 12 -R Example/app\n`,
  );
  expect(
    await runGhLauncher(["pr", "merge", "12", "-R", "Example/app"], host("3")),
  ).toBe(3);
  expect(gh.endsWith("/official/gh")).toBe(true);
});
