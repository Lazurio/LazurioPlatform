import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GithubOAuthError,
  githubHttp,
  refreshTokenPair,
} from "../src/github/oauth";
import { ensurePrivateDirectory } from "../src/github/pilot";
import {
  lockOrganization,
  organizationToken,
  readStoredSignIn,
  signInFile,
} from "../src/github/store";
import { type FakeGithub, startFakeGithub } from "./fixtures/fake-github";
import {
  enablePilot,
  exampleOrganization,
  type PilotWorld,
  pilotWorld,
  storeSignIn,
} from "./fixtures/github-pilot";
import { runChild } from "./fixtures/run-child";

// One Organization's sign-in (decision F46): the access token renews itself
// ten minutes before its end, under the Organization's kernel lock, because a
// refresh token works once (GitHub's rotation ends the pair it replaced).

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: Parameters<typeof startFakeGithub>[0] = {}) {
  const github = startFakeGithub(options);
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  return { github, world, http: githubHttp({ origins: github.origins }) };
}

const tokenOf = (
  world: PilotWorld,
  github: FakeGithub,
  extra: { now?: () => number; lockTimeoutMs?: number } = {},
) =>
  organizationToken({
    paths: world.paths,
    organization: exampleOrganization,
    http: githubHttp({ origins: github.origins }),
    now: extra.now ?? (() => Date.now()),
    ...(extra.lockTimeoutMs === undefined
      ? {}
      : { lockTimeoutMs: extra.lockTimeoutMs }),
  });

test("a token far from its end is handed out without asking GitHub", async () => {
  const { github, world } = await setup();
  const pair = await storeSignIn(world, github, exampleOrganization);
  const answer = await tokenOf(world, github);
  expect(answer).toMatchObject({
    kind: "token",
    token: pair.access,
    account: "example",
    refreshed: false,
  });
  expect(github.requests).toEqual([]);
});

test("a token near its end is refreshed once, and GitHub's rotation ends the old pair", async () => {
  const { github, world } = await setup();
  const old = await storeSignIn(world, github, exampleOrganization, {
    accessMs: 5 * 60 * 1000,
  });
  const answer = await tokenOf(world, github);
  expect(answer.kind).toBe("token");
  if (answer.kind !== "token") return;
  expect(answer.refreshed).toBe(true);
  expect(answer.token).not.toBe(old.access);
  expect(github.refreshes()).toBe(1);
  // No client secret is ever sent: the device-flow token refreshes without.
  const refresh = github.requests.find(
    (entry) => entry.form?.grant_type === "refresh_token",
  );
  expect(Object.keys(refresh?.form ?? {}).sort()).toEqual([
    "client_id",
    "grant_type",
    "refresh_token",
  ]);
  expect(github.accessValid(old.access)).toBe(false);
  expect(github.refreshValid(old.refresh)).toBe(false);
  const stored = await readStoredSignIn(world.paths, "Example");
  expect(stored).not.toBe("unreadable");
  if (stored === null || stored === "unreadable") return;
  expect(stored.accessToken).toBe(answer.token);
  expect(stored.refreshedAt).not.toBeNull();
  // Fresh now: the next caller asks GitHub nothing.
  expect(await tokenOf(world, github)).toMatchObject({ refreshed: false });
  expect(github.refreshes()).toBe(1);
});

test("concurrent callers in one process refresh once and share the new pair", async () => {
  const { github, world } = await setup({ refreshDelayMs: 200 });
  await storeSignIn(world, github, exampleOrganization, { accessMs: 60_000 });
  const answers = await Promise.all(
    Array.from({ length: 5 }, () => tokenOf(world, github)),
  );
  expect(github.refreshes()).toBe(1);
  const tokens = new Set(
    answers.map((answer) =>
      answer.kind === "token" ? answer.token : answer.kind,
    ),
  );
  expect(tokens.size).toBe(1);
  expect(
    answers.filter((answer) => answer.kind === "token" && answer.refreshed),
  ).toHaveLength(1);
});

test("concurrent processes refresh once and share the new pair", async () => {
  const { github, world } = await setup({ refreshDelayMs: 300 });
  await storeSignIn(world, github, exampleOrganization, { accessMs: 60_000 });
  const child = join(import.meta.dir, "fixtures", "github-token-child.ts");
  const runs = await Promise.all(
    Array.from({ length: 4 }, () =>
      runChild([process.execPath, child], {
        env: {
          ...world.env,
          LAZURIO_TEST_GITHUB_ORIGIN: github.origins.web,
        },
        timeout: 30_000,
      }),
    ),
  );
  for (const run of runs) expect(run.exitCode).toBe(0);
  const answers = runs.map(
    (run) =>
      JSON.parse(run.stdout.trim()) as { token?: string; refreshed?: boolean },
  );
  expect(github.refreshes()).toBe(1);
  expect(new Set(answers.map((answer) => answer.token)).size).toBe(1);
  expect(answers.filter((answer) => answer.refreshed)).toHaveLength(1);
}, 60_000);

test("without the lock, two refreshes with one refresh token end the chain", async () => {
  // Why the lock is mandatory: GitHub accepts a refresh token once.
  const { github, http } = await setup({ refreshDelayMs: 100 });
  const pair = github.issue();
  const results = await Promise.allSettled([
    refreshTokenPair(
      http,
      exampleOrganization.clientId,
      pair.refresh,
      Date.now,
    ),
    refreshTokenPair(
      http,
      exampleOrganization.clientId,
      pair.refresh,
      Date.now,
    ),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
    GithubOAuthError,
  );
});

test("a refresh GitHub refuses ends the sign-in; one that cannot reach GitHub keeps it", async () => {
  const refused = await setup({ refreshAnswer: "bad_refresh_token" });
  await storeSignIn(refused.world, refused.github, exampleOrganization, {
    accessMs: 60_000,
  });
  expect(await tokenOf(refused.world, refused.github)).toEqual({
    kind: "signed-out",
    reason: "refresh-rejected",
  });
  expect(await readStoredSignIn(refused.world.paths, "Example")).toBeNull();

  const unreachable = await setup({ refreshAnswer: "unreachable" });
  const pair = await storeSignIn(
    unreachable.world,
    unreachable.github,
    exampleOrganization,
    {
      accessMs: 5 * 60 * 1000,
    },
  );
  // The current token still works for minutes: it is used meanwhile.
  expect(await tokenOf(unreachable.world, unreachable.github)).toMatchObject({
    kind: "token",
    token: pair.access,
    refreshed: false,
  });
  // A spent one is not handed out; the sign-in stays for the next attempt.
  await storeSignIn(
    unreachable.world,
    unreachable.github,
    exampleOrganization,
    {
      accessMs: 10_000,
    },
  );
  expect(await tokenOf(unreachable.world, unreachable.github)).toEqual({
    kind: "unavailable",
    reason: "unreachable",
  });
  expect(
    await readStoredSignIn(unreachable.world.paths, "Example"),
  ).not.toBeNull();
});

test("a sign-in unused for six months has ended", async () => {
  const { github, world } = await setup();
  await storeSignIn(world, github, exampleOrganization, {
    accessMs: -1000,
    refreshMs: -1000,
  });
  expect(await tokenOf(world, github)).toEqual({
    kind: "signed-out",
    reason: "sign-in-expired",
  });
  expect(await readStoredSignIn(world.paths, "Example")).toBeNull();
  expect(github.requests).toEqual([]);
});

test("no sign-in, an unreadable one and another app's are never used", async () => {
  const { github, world } = await setup();
  expect(await tokenOf(world, github)).toEqual({
    kind: "signed-out",
    reason: "not-signed-in",
  });
  await ensurePrivateDirectory(world.paths.stateDirectory);
  await writeFile(signInFile(world.paths, "Example"), "{not json");
  expect(await tokenOf(world, github)).toEqual({
    kind: "unavailable",
    reason: "unreadable",
  });
  await storeSignIn(world, github, {
    login: "Example",
    clientId: "Iv23liAnotherApp00009",
  });
  expect(await tokenOf(world, github)).toEqual({
    kind: "signed-out",
    reason: "app-changed",
  });
});

test("the sign-in is kept owner-only and whole", async () => {
  const { github, world } = await setup();
  const pair = await storeSignIn(world, github, exampleOrganization);
  const file = signInFile(world.paths, "Example");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(world.paths.stateDirectory)).mode & 0o777).toBe(0o700);
  // Keyed by the login in lower case: GitHub logins ignore case.
  expect(file.endsWith("/example.json")).toBe(true);
  const text = await readFile(file, "utf8");
  expect(JSON.parse(text).accessToken).toBe(pair.access);
});

test("while another process holds the lock, a still-working token is used, a spent one waits", async () => {
  const { github, world } = await setup();
  await storeSignIn(world, github, exampleOrganization, {
    accessMs: 5 * 60 * 1000,
  });
  const lock = await lockOrganization(world.paths, "Example");
  cleanups.push(() => lock.release());
  expect(await tokenOf(world, github, { lockTimeoutMs: 50 })).toMatchObject({
    kind: "token",
    refreshed: false,
  });
  await storeSignIn(world, github, exampleOrganization, { accessMs: 10_000 });
  expect(await tokenOf(world, github, { lockTimeoutMs: 50 })).toEqual({
    kind: "unavailable",
    reason: "busy",
  });
  expect(github.refreshes()).toBe(0);
});

test("a refresh killed before its rename leaves its pair aside; the next locked caller puts it in place", async () => {
  const { github, world } = await setup();
  const now = Date.now();
  // The file still holds the pair GitHub ended at the refresh…
  const ended = await storeSignIn(world, github, exampleOrganization, {
    now: now - 8 * 3600 * 1000,
    accessMs: 8 * 3600 * 1000 - 5 * 60 * 1000,
  });
  const file = signInFile(world.paths, "Example");
  const stored = JSON.parse(await readFile(file, "utf8"));
  // …and the killed write's temporary file the one that works.
  const working = github.issue();
  const aside = {
    ...stored,
    accessToken: working.access,
    accessTokenExpiresAt: new Date(now + 8 * 3600 * 1000).toISOString(),
    refreshToken: working.refresh,
    refreshedAt: new Date(now - 1000).toISOString(),
  };
  const directory = world.paths.stateDirectory;
  await writeFile(
    join(directory, ".example.json.tmp-0123456789abcdef"),
    `${JSON.stringify(aside)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, ".example.json.tmp-fedcba9876543210"),
    "{par",
  );
  // Another Organization's write in flight is never touched.
  await writeFile(join(directory, ".other.json.tmp-0123456789abcdef"), "{}");
  const answer = await tokenOf(world, github);
  expect(answer).toMatchObject({
    kind: "token",
    token: working.access,
    refreshed: false,
  });
  expect(github.refreshes()).toBe(0);
  expect(ended.access).not.toBe(working.access);
  expect((await readdir(directory)).sort()).toEqual(
    [".other.json.tmp-0123456789abcdef", "example.json", "example.lock"].sort(),
  );
});
