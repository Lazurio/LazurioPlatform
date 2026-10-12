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
  githubHelp,
  pilotStatus,
  runGithubCommand,
  sharedReach,
  wiringExecutable,
} from "../src/github/cli";
import { credentialHelper } from "../src/github/credential";
import { findLeftovers } from "../src/github/leftovers";
import { githubHttp } from "../src/github/oauth";
import {
  pilotRefusesCuratedGh,
  readPilot,
  writePilot,
} from "../src/github/pilot";
import { readStoredSignIn, signInFile } from "../src/github/store";
import { runToolsCommand } from "../src/tools/cli";
import { runTool } from "../src/tools/status";
import { startFakeGithub } from "./fixtures/fake-github";
import {
  exampleOrganization,
  fakeGh,
  pilotWorld,
} from "./fixtures/github-pilot";
import { bindings } from "./fixtures/machine-bindings";

// `lazurio github` (decision F48): an explicit pilot switch, the Work
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

const enable = ["pilot", "enable", "--client-id", exampleOrganization.clientId];

test("help and invalid usage distinguish local sign-out from global App revocation", async () => {
  const { run } = await setup();
  const invalid = await run(["invalid-command"]);
  expect(invalid.code).toBe(2);
  for (const text of [githubHelp, invalid.stderr]) {
    expect(text).toContain(
      "Removes saved credentials only in this Environment",
    );
    expect(text).toContain("No provider revocation");
    expect(text).toContain("copied credentials remain valid");
    expect(text).toContain(
      "GitHub Settings → Applications → Authorized GitHub Apps",
    );
    expect(text).not.toContain("requests token revocation");
  }
});

test.each(["unknown", "other-app"])(
  "status and Git give usable local recovery guidance for %s credentials",
  async (kind) => {
    const { world, github, context, run } = await setup();
    expect((await signIn(run)).code).toBe(0);
    const path = signInFile(world.paths);
    const stored = JSON.parse(await readFile(path, "utf8"));
    const bytes = JSON.stringify(
      kind === "unknown"
        ? { schema: "unknown", recovery: "retain" }
        : { ...stored, clientId: "Iv23liOtherApp0001" },
    );
    await writeFile(path, bytes);
    const before = github.requests.length;
    const status = await run(["status", "--json"]);
    expect(JSON.parse(status.stdout as string).application.signIn.state).toBe(
      "unreadable",
    );
    const text = (await run(["status"])).stdout as string;
    expect(text).toContain("local recovery");
    expect(text).not.toContain("sign-out, then");
    expect(text).not.toContain("not signed in:");
    const advice: string[] = [];
    const answer = await credentialHelper(
      "get",
      "protocol=https\nhost=github.com\npath=Example/repo.git\n\n",
      {
        paths: world.paths,
        http: context.http ?? githubHttp(),
        now: Date.now,
        writeStderr: (value) => advice.push(value),
      },
    );
    expect(answer.stdout).toBe("quit=1\n");
    expect(advice.join()).toContain("local recovery");
    expect(advice.join()).not.toContain("sign-out, then");
    expect((await run(["sign-out"])).code).toBe(1);
    const disable = await run(["pilot", "disable"]);
    expect(disable.code).toBe(2);
    expect(disable.stdout).toContain("local recovery");
    expect((await run(["sign-in"])).code).toBe(1);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(github.requests).toHaveLength(before);
  },
);

test("interrupted unknown custody blocks sign-in, sign-out and disable with recovery guidance", async () => {
  const { world, github, run } = await setup();
  expect((await signIn(run)).code).toBe(0);
  const path = signInFile(world.paths);
  const original = await readFile(path, "utf8");
  const aside = join(
    world.paths.stateDirectory,
    ".sign-in.json.tmp-0123456789abcdef",
  );
  const unknown = "{partial";
  await writeFile(aside, unknown);
  const before = github.requests.length;
  for (const args of [["sign-out"], ["sign-in"], ["pilot", "disable"]]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("local recovery");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(aside, "utf8")).toBe(unknown);
  }
  expect(github.requests).toHaveLength(before);
});

test("sign-out waits for an in-flight device flow and removes its resulting authorization", async () => {
  const { world, run } = await setup();
  expect((await run(enable)).code).toBe(0);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signing = run(["sign-in", "--json"], {
    sleep: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  let returned = false;
  const ending = run(["sign-out", "--json"]).then((value) => {
    returned = true;
    return value;
  });
  await Bun.sleep(40);
  const returnedDuringFlow = returned;
  release.resolve();
  expect((await signing).code).toBe(0);
  const out = await ending;
  expect(returnedDuringFlow).toBe(false);
  expect(JSON.parse(out.stdout as string)).toMatchObject({
    kind: "signed-out",
    scope: "environment",
  });
  expect(await readStoredSignIn(world.paths, "example")).toBeNull();
});

test("disable cannot strand credentials produced by an in-flight device flow", async () => {
  const { world, run } = await setup();
  expect((await run(enable)).code).toBe(0);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signing = run(["sign-in", "--json"], {
    sleep: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  let returned = false;
  const disabling = run(["pilot", "disable", "--json"]).then((value) => {
    returned = true;
    return value;
  });
  await Bun.sleep(40);
  const returnedDuringFlow = returned;
  release.resolve();
  expect((await signing).code).toBe(0);
  const result = await disabling;
  expect(returnedDuringFlow).toBe(false);
  expect(JSON.parse(result.stdout as string)).toMatchObject({
    reason: "signed-in",
  });
  expect((await readPilot(world.paths)).kind).toBe("on");
  expect(await readStoredSignIn(world.paths, "example")).not.toBeNull();
});

test("a sign-in that read configuration before disable rechecks it before starting device flow", async () => {
  const { world, github, run } = await setup();
  expect((await run(enable)).code).toBe(0);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signing = run(["sign-in", "--json"], {
    hostedFolder: async () => {
      entered.resolve();
      await release.promise;
      return world.folder;
    },
  });
  await entered.promise;
  const disabled = await run(["pilot", "disable"]);
  release.resolve();
  const result = await signing;
  expect(disabled.code).toBe(0);
  expect(JSON.parse(result.stdout as string)).toMatchObject({
    kind: "failed",
    reason: "pilot-changed",
  });
  expect(await readStoredSignIn(world.paths, "example")).toBeNull();
  expect(github.requests).toEqual([]);
});

test("off: status says so, every other command but enable refuses, nothing is written", async () => {
  const { world, run } = await setup();
  expect(await run(["status"])).toEqual({
    code: 0,
    stdout:
      "GitHub sign-in pilot (decision F48): off. gh and Git work as everywhere.",
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
  // Giving gh and Git back works in every state, and finds nothing here.
  expect(await run(["pilot", "unwire"])).toEqual({
    code: 0,
    stdout: "gh and Git are not wired to the pilot.",
  });
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

test("one shared App is configured from the handover; no per-Organization sign-ins can be added", async () => {
  const { world, run } = await setup();
  for (const id of ["Ov23liFixtureOAuth01", "0123456789abcdef0123", "Iv1"])
    expect(
      JSON.parse(
        (await run(["pilot", "enable", "--client-id", id, "--json"]))
          .stdout as string,
      ),
    ).toMatchObject({ reason: "client-id-invalid" });
  expect((await run(enable)).code).toBe(0);
  expect(await readPilot(world.paths)).toMatchObject({
    kind: "on",
    config: {
      application: { login: "example", clientId: exampleOrganization.clientId },
      wiring: null,
    },
  });
  expect(
    JSON.parse((await run([...enable, "--json"])).stdout as string),
  ).toMatchObject({ reason: "pilot-on" });
  for (const args of [
    [
      "pilot",
      "add",
      "--organization",
      "Other",
      "--client-id",
      exampleOrganization.clientId,
    ],
    ["pilot", "remove", "--organization", "Other"],
    ["sign-in", "--organization", "Other"],
    [
      "pilot",
      "enable",
      "--organization",
      "Other",
      "--client-id",
      exampleOrganization.clientId,
    ],
  ])
    expect((await run(args)).code).toBe(2);
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
    "Sign in to GitHub for example: open https://github.com/login/device in your own browser (not this Environment's browser) and enter the code WDJB-MJHT.",
  );
  expect(result.stdout).toBe(
    [
      "Signed in to GitHub as example; owning installation Example (777). The sign-in renews itself while it is used at least every six months.",
      sharedReach,
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
    application: {
      login: "example",
      signIn: { state: "signed-in", account: "example", installationId: 777 },
    },
    reach: "user-and-app-intersection",
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
  });
  const out = await run(["sign-out"]);
  expect(out.stdout).toBe(
    "Signed out of GitHub in this Environment. Saved credentials were removed here; the GitHub authorization and any copied credentials remain valid. To end the App authorization in all your Environments, use GitHub Settings → Applications → Authorized GitHub Apps.",
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
  expect(await pilotRefusesCuratedGh(world.env)).toEqual({ owning: "example" });
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
  expect(text.text).toContain("lazurio github sign-in");
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
      context: { organization: "example", signIn: "signed-out" },
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
      reach: "user-and-app-intersection",
      application: {
        login: "Example",
        clientId: exampleOrganization.clientId,
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

test("disabling the switch never strands a pair a killed write left aside", async () => {
  const { world, run } = await setup();
  expect((await run(enable)).code).toBe(0);
  // A first shared sign-in killed between its sync and its rename.
  await mkdir(world.paths.stateDirectory, { recursive: true, mode: 0o700 });
  const now = new Date();
  await writeFile(
    join(world.paths.stateDirectory, ".sign-in.json.tmp-0123456789abcdef"),
    JSON.stringify({
      schema: "lazurio.github-sign-in.v2",
      organization: { login: "example", id: 4242 },
      clientId: exampleOrganization.clientId,
      installationId: 9,
      account: { login: "example", id: 12345 },
      accessToken: "ghu_fake-access-aside",
      accessTokenExpiresAt: new Date(now.getTime() + 3600 * 1000).toISOString(),
      refreshToken: "ghr_fake-refresh-aside",
      refreshTokenExpiresAt: new Date(
        now.getTime() + 86400 * 1000,
      ).toISOString(),
      signedInAt: now.toISOString(),
      refreshedAt: null,
    }),
    { mode: 0o600 },
  );
  expect(
    JSON.parse((await run(["pilot", "disable", "--json"])).stdout as string),
  ).toMatchObject({ kind: "blocked", reason: "signed-in" });
  // It was put in place, so sign-out finds and removes its local custody.
  expect(
    JSON.parse((await run(["sign-out", "--json"])).stdout as string),
  ).toMatchObject({
    kind: "signed-out",
    organization: "example",
  });
  expect(await run(["pilot", "disable"])).toMatchObject({ code: 0 });
});

test("unknown configuration is preserved and a changed owning Organization cannot silently reuse the sign-in", async () => {
  const { world, run } = await setup();
  expect((await run(enable)).code).toBe(0);
  const pilot = await readPilot(world.paths);
  if (pilot.kind !== "on") throw new Error("pilot off");
  await writePilot(world.paths, {
    ...pilot.config,
    application: { ...pilot.config.application, login: "Other" },
  });
  expect(
    JSON.parse((await run(["sign-in", "--json"])).stdout as string),
  ).toMatchObject({ reason: "owning-organization-changed" });
  const unknown = '{"schema":"unknown-pilot"}';
  await writeFile(world.paths.config, unknown);
  expect(
    JSON.parse((await run(["sign-in", "--json"])).stdout as string),
  ).toMatchObject({ reason: "pilot-unreadable" });
  expect(await readFile(world.paths.config, "utf8")).toBe(unknown);
});
