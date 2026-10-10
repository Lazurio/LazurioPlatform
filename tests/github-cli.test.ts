import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  doctorCheckIds,
  doctorContextRules,
  doctorReasons,
  githubChecks,
} from "../src/doctor/doctor";
import {
  type GithubContext,
  pilotStatus,
  runGithubCommand,
  wiringExecutable,
} from "../src/github/cli";
import { findLeftovers } from "../src/github/leftovers";
import { githubHttp } from "../src/github/oauth";
import { pilotRefusesCuratedGh, readPilot } from "../src/github/pilot";
import { readStoredSignIn } from "../src/github/store";
import { runToolsCommand } from "../src/tools/cli";
import { runTool } from "../src/tools/status";
import { startFakeGithub } from "./fixtures/fake-github";
import {
  exampleOrganization,
  fakeGh,
  pilotWorld,
} from "./fixtures/github-pilot";
import { bindings } from "./fixtures/machine-bindings";

// `lazurio github` (decision F46): an explicit pilot switch, the Work
// Environment gate, the sign-in, wiring and its reversal, and what doctor and
// the curated gh flows of F19 do while the pilot is on. Nothing changes where
// it is off.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: Parameters<typeof pilotWorld>[0] = {}) {
  const github = startFakeGithub();
  const world = await pilotWorld(options);
  cleanups.push(github.close, world.cleanup);
  const lines: string[] = [];
  const executable = join(world.root, "pilot", "lazurio");
  await mkdir(join(world.root, "pilot"), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  const context: GithubContext = {
    env: world.env,
    platform: process.platform,
    executable,
    hostedFolder: world.hostedFolder,
    http: githubHttp({ origins: github.origins }),
    sleep: async () => {},
    write: (line) => lines.push(line),
    run: runTool,
  };
  const github_ = (args: string[], extra: Partial<GithubContext> = {}) =>
    runGithubCommand(args, { ...context, ...extra });
  return { github, world, lines, context, run: github_, executable };
}

const enable = [
  "pilot",
  "enable",
  "--organization",
  "Example",
  "--client-id",
  exampleOrganization.clientId,
];

test("off: status says so, every other command but enable refuses, nothing is written", async () => {
  const { world, run } = await setup();
  expect(await run(["status"])).toEqual({
    code: 0,
    stdout:
      "GitHub sign-in pilot (decision F46): off. gh and Git work as everywhere.",
  });
  for (const args of [
    ["sign-in"],
    ["sign-out"],
    ["pilot", "wire"],
    ["pilot", "disable"],
  ])
    expect(await run([...args, "--json"])).toMatchObject({
      code: 2,
      stdout: JSON.stringify({ kind: "blocked", reason: "pilot-off" }),
    });
  expect(await readPilot(world.paths)).toEqual({ kind: "off" });
  expect((await run(["pilot", "frob"])).code).toBe(2);
  expect((await run(["constructor"])).code).toBe(2);
  expect((await run(["status", "--organization", "Example"])).code).toBe(2);
});

test("the pilot is enabled only in an individual Work Environment with an assigned operator", async () => {
  const refusals: [Parameters<typeof pilotWorld>[0], string][] = [
    [{ preset: null }, "not-hosted"],
    [{ preset: "hosted-organization-team" }, "not-work-environment"],
    [{ preset: "hosted-personal" }, "not-work-environment"],
    [
      {
        preset: "hosted-organization-personal",
        machine: bindings.organization,
      },
      "subject-unknown",
    ],
  ];
  for (const [options, reason] of refusals) {
    const { world, run } = await setup(options);
    const result = await run([...enable, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout as string)).toMatchObject({
      kind: "blocked",
      reason,
    });
    expect(await readPilot(world.paths)).toEqual({ kind: "off" });
  }
  const unreadable = await setup();
  expect(
    JSON.parse(
      (
        await unreadable.run([...enable, "--json"], {
          hostedFolder: async () => {
            throw new Error("handover unreadable");
          },
        })
      ).stdout as string,
    ),
  ).toMatchObject({ reason: "environment-unreadable" });
});

test("only a GitHub App's client id is accepted, once per Organization", async () => {
  const { run } = await setup();
  for (const id of ["Ov23liFixtureOAuth01", "0123456789abcdef0123", "Iv1"])
    expect(
      JSON.parse(
        (
          await run([
            "pilot",
            "enable",
            "--organization",
            "Example",
            "--client-id",
            id,
            "--json",
          ])
        ).stdout as string,
      ),
    ).toMatchObject({ reason: "client-id-invalid" });
  expect(
    JSON.parse(
      (
        await run([
          "pilot",
          "enable",
          "--organization",
          "bad_login",
          "--client-id",
          exampleOrganization.clientId,
          "--json",
        ])
      ).stdout as string,
    ),
  ).toMatchObject({ reason: "organization-invalid" });
  expect(await run(enable)).toMatchObject({ code: 0 });
  expect(
    JSON.parse((await run([...enable, "--json"])).stdout as string),
  ).toMatchObject({ reason: "pilot-on" });
  expect(
    JSON.parse(
      (
        await run([
          "pilot",
          "add",
          "--organization",
          "example",
          "--client-id",
          "Iv23liFixture0000009",
          "--json",
        ])
      ).stdout as string,
    ),
  ).toMatchObject({ reason: "organization-configured" });
  expect(
    JSON.parse(
      (
        await run([
          "pilot",
          "add",
          "--organization",
          "Other",
          "--client-id",
          exampleOrganization.clientId,
          "--json",
        ])
      ).stdout as string,
    ),
  ).toMatchObject({ reason: "client-id-configured" });
  expect(
    await run([
      "pilot",
      "add",
      "--organization",
      "Other",
      "--client-id",
      "Iv23liFixture0000002",
    ]),
  ).toMatchObject({
    code: 0,
  });
  expect(
    JSON.parse(
      (await run(["pilot", "remove", "--organization", "Example", "--json"]))
        .stdout as string,
    ),
  ).toMatchObject({
    reason: "owning-organization",
  });
  expect(
    await run(["pilot", "remove", "--organization", "Other"]),
  ).toMatchObject({ code: 0 });
});

async function signIn(run: Awaited<ReturnType<typeof setup>>["run"]) {
  expect((await run(enable)).code).toBe(0);
  return run(["sign-in"]);
}

test("the sign-in shows the code, then who is signed in and the next step; no token is printed", async () => {
  const { world, lines, run } = await setup();
  const result = await signIn(run);
  expect(result.code).toBe(0);
  expect(lines[0]).toBe(
    "Sign in to GitHub for Example: open https://github.com/login/device in your own browser (not this Environment's browser) and enter the code WDJB-MJHT.",
  );
  expect(result.stdout).toBe(
    [
      "Signed in to GitHub as example for Example only (installation 777). The sign-in renews itself while it is used at least every six months.",
      "Next: lazurio github pilot wire",
    ].join("\n"),
  );
  const stored = await readStoredSignIn(world.paths, "Example");
  if (stored === null || stored === "unreadable") throw new Error("no sign-in");
  const status = await run(["status", "--json"]);
  for (const output of [result.stdout, status.stdout, ...lines]) {
    expect(output).not.toContain(stored.accessToken);
    expect(output).not.toContain(stored.refreshToken);
  }
  expect(JSON.parse(status.stdout as string)).toMatchObject({
    state: "on",
    organizations: [
      {
        login: "Example",
        owning: true,
        signIn: { state: "signed-in", account: "example", installationId: 777 },
      },
    ],
    wiring: { state: "not-wired" },
  });
  // JSON lines while it runs.
  const again = await run(["sign-in", "--json"]);
  expect(JSON.parse(again.stdout as string)).toMatchObject({
    kind: "signed-in",
    already: true,
  });
});

test("a failed sign-in says what to do and exits 1", async () => {
  const { run } = await setup();
  // An account other than the assigned operator approves the code.
  const wrong = startFakeGithub({ account: { login: "someone", id: 999 } });
  cleanups.push(wrong.close);
  expect((await run(enable)).code).toBe(0);
  const result = await run(["sign-in"], {
    http: githubHttp({ origins: wrong.origins }),
  });
  expect(result).toEqual({
    code: 1,
    stdout:
      "GitHub signed in someone, but this Environment is assigned to example; nothing was kept. Sign in again and approve the code as example.",
  });
});

test("wire needs the owning sign-in and a compiled executable; unwire and sign-out lead back to off", async () => {
  const { world, run, executable } = await setup();
  expect((await run(enable)).code).toBe(0);
  await fakeGh(world.bin);
  expect(
    JSON.parse((await run(["pilot", "wire", "--json"])).stdout as string),
  ).toMatchObject({
    reason: "owning-not-signed-in",
  });
  expect((await run(["sign-in"])).code).toBe(0);
  expect(
    JSON.parse(
      (await run(["pilot", "wire", "--json"], { executable: process.execPath }))
        .stdout as string,
    ),
  ).toMatchObject({ reason: "executable-unsupported" });
  const wired = await run(["pilot", "wire", "--json"]);
  expect(JSON.parse(wired.stdout as string)).toEqual({
    kind: "wired",
    gh: "file",
  });
  const status = JSON.parse((await run(["status", "--json"])).stdout as string);
  expect(status.wiring).toMatchObject({
    state: "wired",
    gh: "ok",
    git: "ok",
    executable,
  });
  expect(
    JSON.parse((await run(["pilot", "wire", "--json"])).stdout as string),
  ).toEqual({
    kind: "repaired",
    gh: "file",
  });
  // Off only after unwire and sign-out.
  expect(
    JSON.parse((await run(["pilot", "disable", "--json"])).stdout as string),
  ).toMatchObject({ reason: "wired" });
  expect(await run(["pilot", "unwire", "--json"])).toMatchObject({ code: 0 });
  expect(await readFile(join(world.bin, "gh"), "utf8")).toContain(
    "fake official gh",
  );
  expect(
    JSON.parse((await run(["pilot", "disable", "--json"])).stdout as string),
  ).toMatchObject({
    reason: "signed-in",
    organizations: ["Example"],
  });
  const out = await run(["sign-out"]);
  expect(out.stdout).toBe(
    "Signed out of GitHub for Example here; GitHub revoked both tokens and tells you so by email.",
  );
  expect(await run(["pilot", "disable"])).toEqual({
    code: 0,
    stdout: "The GitHub sign-in pilot is off.",
  });
  expect(await readPilot(world.paths)).toEqual({ kind: "off" });
});

test("an installed version wires the install base's selector, which follows updates", () => {
  const env = { HOME: "/home/operator", PATH: "/usr/bin" };
  expect(
    wiringExecutable({
      env,
      platform: "linux",
      executable: "/home/operator/.local/share/lazurio/versions/0.1.9/lazurio",
    }),
  ).toBe("/home/operator/.local/share/lazurio/bin/lazurio");
  expect(
    wiringExecutable({
      env,
      platform: "linux",
      executable: "/home/operator/pilot/lazurio",
    }),
  ).toBe("/home/operator/pilot/lazurio");
});

test("while gh and Git are wired, the curated gh sign-in and sign-out of F19 are refused", async () => {
  const { world, run } = await setup();
  expect((await run(enable)).code).toBe(0);
  expect((await run(["sign-in"])).code).toBe(0);
  // On but not wired yet: the migration and rollback path stays.
  expect(await pilotRefusesCuratedGh(world.env)).toBeUndefined();
  await fakeGh(world.bin);
  expect((await run(["pilot", "wire"])).code).toBe(0);
  expect(await pilotRefusesCuratedGh(world.env)).toEqual({ owning: "Example" });
  const context = {
    env: world.env,
    platform: process.platform,
    hostedFolder: world.hostedFolder,
  };
  for (const args of [
    ["login", "gh"],
    ["login", "gh", "--ssh-key"],
    ["logout", "gh"],
  ]) {
    const result = await runToolsCommand([...args, "--json"], context);
    expect(result.code).toBe(2);
    expect(result.result).toMatchObject({
      kind: "blocked",
      reason: "github-sign-in-pilot",
      tool: "gh",
    });
  }
  const text = await runToolsCommand(["login", "gh"], context);
  expect(text.text).toContain("lazurio github sign-in --organization Example");
});

test("left-over account-wide credentials are named, never their values", async () => {
  const { world } = await setup({ preset: null });
  const home = world.home;
  await mkdir(join(home, ".config", "gh"), { recursive: true });
  await writeFile(
    join(home, ".config", "gh", "hosts.yml"),
    "github.com:\n    users:\n        example:\n    git_protocol: ssh\n    user: example\n",
  );
  await writeFile(
    join(home, ".git-credentials"),
    "https://example:fixture-secret@github.com\n",
  );
  await writeFile(
    join(home, ".bashrc"),
    "alias ll='ls -l'\nexport GH_TOKEN=fixture-secret\n",
  );
  // A helper Git would consult for github.com, set by gh auth setup-git.
  await runTool(
    [
      "git",
      "config",
      "--global",
      "--add",
      "credential.https://github.com.helper",
      "!gh auth git-credential",
    ],
    10_000,
    world.env,
  );
  const sshDirectory = join(world.root, "ssh-bin");
  await mkdir(sshDirectory);
  await writeFile(
    join(sshDirectory, "ssh"),
    '#!/bin/sh\necho "Hi example! You\'ve successfully authenticated, but GitHub does not provide shell access." >&2\nexit 1\n',
  );
  await chmod(join(sshDirectory, "ssh"), 0o755);
  const report = await findLeftovers({
    paths: world.paths,
    env: {
      ...world.env,
      PATH: `${sshDirectory}:${world.env.PATH}`,
      GITHUB_TOKEN: "fixture-secret",
    },
    platform: process.platform,
    run: runTool,
    ssh: true,
    wiring: null,
  });
  expect(report).toEqual({
    leftovers: [
      { kind: "gh-sign-in", file: "~/.config/gh/hosts.yml" },
      { kind: "git-credentials", file: "~/.git-credentials" },
      { kind: "token-variable", variable: "GITHUB_TOKEN" },
      { kind: "token-variable", variable: "GH_TOKEN", file: "~/.bashrc" },
      { kind: "git-helper" },
      { kind: "ssh-key" },
    ],
    ssh: "checked",
  });
  expect(JSON.stringify(report)).not.toContain("fixture-secret");
});

test("doctor adds the pilot's rows only while it is on, in its contract", async () => {
  const { world, context, run } = await setup();
  expect(githubChecks(await pilotStatus(context, world.paths))).toEqual([]);
  expect(githubChecks(null)).toEqual([]);
  expect((await run(enable)).code).toBe(0);
  await writeFile(
    join(world.home, ".bashrc"),
    "export GH_TOKEN=fixture-secret\n",
  );
  const checks = githubChecks(await pilotStatus(context, world.paths));
  expect(checks).toEqual([
    {
      id: "github-sign-in",
      outcome: "warn",
      reason: "github-not-signed-in",
      context: { organization: "Example", signIn: "signed-out" },
    },
    { id: "github-sign-in", outcome: "warn", reason: "github-not-wired" },
    {
      id: "github-leftover",
      outcome: "warn",
      reason: "leftover-token-variable",
      context: { file: "~/.bashrc", variable: "GH_TOKEN" },
    },
  ]);
  for (const check of checks) {
    expect(doctorCheckIds).toContain(check.id);
    expect(doctorReasons).toContain(check.reason as string);
  }
  expect(doctorContextRules.wiring?.("gh")).toBe(true);
  expect(doctorContextRules.variable?.("PATH")).toBe(false);
  expect(
    githubChecks({
      kind: "github-pilot",
      state: "on",
      organizations: [
        {
          login: "Example",
          clientId: exampleOrganization.clientId,
          owning: true,
          signIn: {
            state: "signed-in",
            account: "example",
            installationId: 1,
            accessTokenExpiresAt: "2026-10-10T16:00:00.000Z",
            refreshTokenExpiresAt: "2027-04-10T16:00:00.000Z",
            signedInAt: "2026-10-10T08:00:00.000Z",
            refreshedAt: null,
          },
        },
      ],
      wiring: {
        state: "broken",
        gh: "broken",
        git: "ok",
        executable: "/x",
        official: "/y",
      },
      leftovers: [],
      ssh: "not-checked",
    }),
  ).toEqual([
    {
      id: "github-sign-in",
      outcome: "ok",
      context: { organization: "Example", signIn: "signed-in" },
    },
    {
      id: "github-sign-in",
      outcome: "warn",
      reason: "github-wiring-broken",
      context: { wiring: "gh" },
    },
    { id: "github-leftover", outcome: "ok" },
  ]);
});
