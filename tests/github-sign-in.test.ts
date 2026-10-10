import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { githubHttp } from "../src/github/oauth";
import type { PilotOrganization } from "../src/github/pilot";
import {
  installationProblem,
  type SignInFailure,
  type SignInState,
  signIn,
  signOut,
} from "../src/github/sign-in";
import { readStoredSignIn, signInFile } from "../src/github/store";
import {
  type FakeGithubOptions,
  startFakeGithub,
} from "./fixtures/fake-github";
import {
  enablePilot,
  exampleOrganization,
  pilotWorld,
  storeSignIn,
} from "./fixtures/github-pilot";

// The person's sign-in to one Organization's sign-in app (decision F46):
// GitHub's device flow with the public client id only, then the checks that
// the account is the Environment's assigned operator and that the token
// reaches exactly that Organization's installation, before anything is kept.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const subject = Object.freeze({ login: "example", id: 12345 });

async function run(
  options: FakeGithubOptions = {},
  extra: {
    organization?: PilotOrganization;
    subject?: { login: string; id: number };
    signal?: AbortSignal;
    onSleep?: (milliseconds: number) => void;
  } = {},
) {
  const github = startFakeGithub(options);
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  const states: SignInState[] = [];
  const sleeps: number[] = [];
  let clock = Date.parse("2026-10-10T08:00:00Z");
  const final = await signIn({
    paths: world.paths,
    organization: extra.organization ?? exampleOrganization,
    subject: extra.subject ?? subject,
    http: githubHttp({ origins: github.origins }),
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      extra.onSleep?.(milliseconds);
    },
    emit: (state) => states.push(state),
    signal: extra.signal,
  });
  return { github, world, states, sleeps, final };
}

test("the device flow signs in with the public client id and keeps the checked tokens", async () => {
  const { github, world, states, sleeps, final } = await run();
  // One challenge for the person: GitHub's page and the code.
  expect(states).toEqual([
    {
      kind: "pending",
      organization: "Example",
      challenge: { url: "https://github.com/login/device", code: "WDJB-MJHT" },
      expiresAt: "2026-10-10T08:15:00.000Z",
    },
  ]);
  expect(sleeps).toEqual([5000, 5000]);
  expect(final).toEqual({
    kind: "signed-in",
    organization: "Example",
    account: "example",
    installationId: 777,
  });
  // offline_access: an expiring token even if the app's owner turned expiry
  // off; never a client secret.
  const device = github.requests.find(
    (entry) => entry.path === "/login/device/code",
  );
  expect(device?.form).toEqual({
    client_id: exampleOrganization.clientId,
    scope: "offline_access",
  });
  for (const entry of github.requests)
    expect(Object.keys(entry.form ?? {})).not.toContain("client_secret");
  expect(
    github.requests.map((entry) => `${entry.method} ${entry.path}`),
  ).toEqual([
    "POST /login/device/code",
    "POST /login/oauth/access_token",
    "POST /login/oauth/access_token",
    "GET /user",
    "GET /user/installations?per_page=100",
  ]);
  const stored = await readStoredSignIn(world.paths, "Example");
  expect(stored).toMatchObject({
    organization: { login: "Example", id: 4242 },
    clientId: exampleOrganization.clientId,
    installationId: 777,
    account: { login: "example", id: 12345 },
    accessTokenExpiresAt: "2026-10-10T16:00:10.000Z",
    refreshedAt: null,
  });
  expect((await stat(signInFile(world.paths, "Example"))).mode & 0o777).toBe(
    0o600,
  );
  // No state a caller prints carries a token.
  expect(JSON.stringify([states, final])).not.toMatch(/gh[ur]_/);
});

test("slow_down lengthens the polling interval as GitHub says", async () => {
  const { sleeps, final } = await run({
    polls: ["authorization_pending", "slow_down", "unreachable", "tokens"],
  });
  expect(final.kind).toBe("signed-in");
  // pending, slow_down → GitHub's 10 s, a short outage, then the tokens.
  expect(sleeps).toEqual([5000, 5000, 10000, 10000]);
});

test("another account approving the code keeps nothing", async () => {
  const { world, final } = await run({
    account: { login: "someone", id: 999 },
  });
  expect(final).toEqual({
    kind: "failed",
    organization: "Example",
    reason: "wrong-account",
    account: "someone",
    expected: "example",
  });
  expect(await readStoredSignIn(world.paths, "Example")).toBeNull();
});

test("the token must reach exactly the Organization's own installation of the app", async () => {
  const cases: [
    NonNullable<FakeGithubOptions["installations"]>,
    SignInFailure,
  ][] = [
    [[], "app-not-installed"],
    [
      [{ id: 1, account: { login: "Other", id: 5 } }],
      "installation-unexpected",
    ],
    [
      [
        { id: 1, account: { login: "Example", id: 4242 } },
        { id: 2, account: { login: "Other", id: 5 } },
      ],
      "installation-unexpected",
    ],
    [
      [{ id: 1, account: { login: "Example", id: 4242 }, target_type: "User" }],
      "installation-unexpected",
    ],
    [
      [
        {
          id: 1,
          account: { login: "Example", id: 4242 },
          client_id: "Iv23liSomeOtherApp001",
        },
      ],
      "installation-unexpected",
    ],
    [
      [
        {
          id: 1,
          account: { login: "Example", id: 4242 },
          suspended_at: "2026-10-01T00:00:00Z",
        },
      ],
      "app-suspended",
    ],
  ];
  for (const [installations, reason] of cases) {
    const { world, final } = await run({ installations });
    expect(final).toEqual({ kind: "failed", organization: "Example", reason });
    expect(
      await readdir(world.paths.stateDirectory).catch(() => []),
    ).not.toContain("example.json");
  }
  // The login of the Organization is compared without case.
  expect(
    installationProblem(
      [
        {
          id: 1,
          account: { login: "EXAMPLE", id: 4242 },
          targetType: "Organization",
          clientId: null,
          suspended: false,
        },
      ],
      exampleOrganization,
    ),
  ).toBeNull();
});

test("the app's settings and the person's choice end the flow with what to do", async () => {
  expect((await run({ deviceFlow: "disabled" })).final).toEqual({
    kind: "failed",
    organization: "Example",
    reason: "device-flow-disabled",
  });
  expect(
    (
      await run(
        {},
        {
          organization: { login: "Example", clientId: "Iv23liUnknownApp0001" },
        },
      )
    ).final,
  ).toEqual({
    kind: "failed",
    organization: "Example",
    reason: "client-id-rejected",
  });
  expect((await run({ polls: ["access_denied"] })).final).toEqual({
    kind: "failed",
    organization: "Example",
    reason: "access-denied",
  });
  expect((await run({ polls: ["expired_token"] })).final).toEqual({
    kind: "expired",
    organization: "Example",
  });
  // An app whose tokens never expire is refused (decision F46).
  const lasting = await run({ expiring: false });
  expect(lasting.final).toEqual({
    kind: "failed",
    organization: "Example",
    reason: "token-not-expiring",
  });
  expect(await readStoredSignIn(lasting.world.paths, "Example")).toBeNull();
});

test("the code ends after its lifetime, and Ctrl-C cancels", async () => {
  const pending = Array.from({ length: 400 }, () => "authorization_pending");
  expect((await run({ polls: pending })).final).toEqual({
    kind: "expired",
    organization: "Example",
  });
  const controller = new AbortController();
  const cancelled = await run(
    { polls: pending },
    { signal: controller.signal, onSleep: () => controller.abort() },
  );
  expect(cancelled.final).toEqual({
    kind: "cancelled",
    organization: "Example",
  });
  expect(await readStoredSignIn(cancelled.world.paths, "Example")).toBeNull();
});

test("an existing sign-in is kept; signing in again needs a sign-out first", async () => {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  await storeSignIn(world, github, exampleOrganization);
  const final = await signIn({
    paths: world.paths,
    organization: exampleOrganization,
    subject,
    http: githubHttp({ origins: github.origins }),
    now: () => Date.now(),
    sleep: async () => {},
    emit: () => {},
  });
  expect(final).toMatchObject({ kind: "signed-in", already: true });
  expect(github.requests).toEqual([]);
});

test("sign-out revokes both tokens without authentication and removes the sign-in", async () => {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  const pair = await storeSignIn(world, github, exampleOrganization);
  const http = githubHttp({ origins: github.origins });
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
      http,
    }),
  ).toEqual({
    kind: "signed-out",
    organization: "Example",
    revoked: true,
  });
  expect(github.revoked).toEqual([pair.access, pair.refresh]);
  expect(github.accessValid(pair.access)).toBe(false);
  expect(await readStoredSignIn(world.paths, "Example")).toBeNull();
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
      http,
    }),
  ).toEqual({
    kind: "not-signed-in",
    organization: "Example",
  });
});

test("a sign-out that GitHub does not confirm still removes the sign-in and says so", async () => {
  const github = startFakeGithub({ revokeStatus: 500 });
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  await storeSignIn(world, github, exampleOrganization);
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
      http: githubHttp({ origins: github.origins }),
    }),
  ).toEqual({ kind: "signed-out", organization: "Example", revoked: false });
  expect(
    await readFile(signInFile(world.paths, "Example"), "utf8").catch(
      () => null,
    ),
  ).toBeNull();
});
