import { afterEach, expect, test } from "bun:test";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { githubHttp } from "../src/github/oauth";
import type { PilotApplication } from "../src/github/pilot";
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

// The person's sign-in to the shared App (decision F48):
// GitHub's device flow with the public client id only, then the checks that
// the account is the Environment's assigned operator and that the token
// reaches the active owning installation, before anything is kept.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const subject = Object.freeze({ login: "example", id: 12345 });

async function run(
  options: FakeGithubOptions = {},
  extra: {
    organization?: PilotApplication;
    subject?: { login: string; id: number };
    signal?: AbortSignal;
    onSleep?: (milliseconds: number) => void;
    before?: (
      world: Awaited<ReturnType<typeof pilotWorld>>,
      github: ReturnType<typeof startFakeGithub>,
    ) => Promise<void>;
  } = {},
) {
  const github = startFakeGithub(options);
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world, extra.organization ?? exampleOrganization);
  await extra.before?.(world, github);
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
  expect((await stat(signInFile(world.paths))).mode & 0o777).toBe(0o600);
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

test("the shared App accepts multiple installations and keeps the owning installation even when it is not first", async () => {
  const { world, final } = await run({
    installations: [
      { id: 778, account: { login: "Other", id: 4243 } },
      { id: 777, account: { login: "Example", id: 4242 } },
    ],
  });
  expect(final).toMatchObject({ kind: "signed-in", installationId: 777 });
  expect(await readStoredSignIn(world.paths, "Example")).toMatchObject({
    organization: { login: "Example", id: 4242 },
    installationId: 777,
  });
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

test("the owning installation must exist, be active, and belong to the configured App", async () => {
  const cases: [
    NonNullable<FakeGithubOptions["installations"]>,
    SignInFailure,
  ][] = [
    [[], "app-not-installed"],
    [[{ id: 1, account: { login: "Other", id: 5 } }], "app-not-installed"],
    [
      [
        { id: 1, account: { login: "Example", id: 4242 } },
        { id: 2, account: { login: "EXAMPLE", id: 4242 } },
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
    ).not.toContain("sign-in.json");
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
  // An app whose tokens never expire is refused (decision F48).
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

test("sign-out removes only this Environment custody and makes no provider request", async () => {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  const pair = await storeSignIn(world, github, exampleOrganization);
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
    }),
  ).toEqual({
    kind: "signed-out",
    organization: "Example",
    scope: "environment",
  });
  expect(github.requests).toEqual([]);
  expect(github.accessValid(pair.access)).toBe(true);
  expect(github.refreshValid(pair.refresh)).toBe(true);
  expect(await readStoredSignIn(world.paths, "Example")).toBeNull();
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
    }),
  ).toEqual({
    kind: "not-signed-in",
    organization: "Example",
  });
});

test("sign-out leaves a second Environment sign-in usable and does not depend on GitHub", async () => {
  const github = startFakeGithub({ revokeStatus: 500 });
  const control = github.issue();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  await storeSignIn(world, github, exampleOrganization);
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
    }),
  ).toEqual({
    kind: "signed-out",
    organization: "Example",
    scope: "environment",
  });
  expect(github.requests).toEqual([]);
  expect(github.accessValid(control.access)).toBe(true);
  expect(github.refreshValid(control.refresh)).toBe(true);
  expect(
    await readFile(signInFile(world.paths), "utf8").catch(() => null),
  ).toBeNull();
});

test("sign-out preserves unreadable, other-owner and other-App credentials without revocation", async () => {
  for (const kind of ["unknown", "other-owner", "other-app"]) {
    const github = startFakeGithub();
    const world = await pilotWorld({ preset: null });
    cleanups.push(github.close, world.cleanup);
    await enablePilot(world);
    await storeSignIn(world, github, exampleOrganization);
    const path = signInFile(world.paths);
    const original = JSON.parse(await readFile(path, "utf8"));
    const value =
      kind === "unknown"
        ? { schema: "unknown", recovery: "keep these bytes" }
        : kind === "other-owner"
          ? { ...original, organization: { login: "Other", id: 999 } }
          : { ...original, clientId: "Iv23liOtherApp0001" };
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    const aside = join(
      world.paths.stateDirectory,
      ".sign-in.json.tmp-0123456789abcdef",
    );
    if (kind === "unknown") await writeFile(aside, JSON.stringify(original));
    const result = await signOut({
      paths: world.paths,
      organization: exampleOrganization,
    });
    expect(result).toMatchObject({
      kind: "failed",
      reason: "state-unreadable",
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
    if (kind === "unknown")
      expect(await readFile(aside, "utf8")).toBe(JSON.stringify(original));
    expect(github.requests).toEqual([]);
  }
});

test.each(["unknown", "malformed", "other-owner", "other-app"])(
  "sign-out preserves all custody before refusing a %s interrupted write",
  async (kind) => {
    for (const settled of [true, false]) {
      const github = startFakeGithub();
      const world = await pilotWorld({ preset: null });
      cleanups.push(github.close, world.cleanup);
      await enablePilot(world);
      await storeSignIn(world, github, exampleOrganization);
      const canonical = signInFile(world.paths);
      const originalBytes = await readFile(canonical, "utf8");
      const original = JSON.parse(originalBytes);
      const ownPath = join(
        world.paths.stateDirectory,
        ".sign-in.json.tmp-0123456789abcdef",
      );
      const ownBytes = JSON.stringify({
        ...original,
        refreshedAt: new Date(Date.now() + 1000).toISOString(),
      });
      await writeFile(ownPath, ownBytes);
      const foreignPath = join(
        world.paths.stateDirectory,
        ".sign-in.json.tmp-fedcba9876543210",
      );
      const foreignBytes =
        kind === "malformed"
          ? "{partial"
          : JSON.stringify(
              kind === "unknown"
                ? { schema: "unknown", recovery: "retain" }
                : kind === "other-owner"
                  ? { ...original, organization: { login: "Other", id: 999 } }
                  : { ...original, clientId: "Iv23liOtherApp0001" },
            );
      await writeFile(foreignPath, foreignBytes);
      if (!settled) await rm(canonical);
      expect(
        await signOut({
          paths: world.paths,
          organization: exampleOrganization,
        }),
      ).toMatchObject({ kind: "failed", reason: "state-unreadable" });
      expect(await readFile(canonical, "utf8").catch(() => null)).toBe(
        settled ? originalBytes : null,
      );
      expect(await readFile(ownPath, "utf8")).toBe(ownBytes);
      expect(await readFile(foreignPath, "utf8")).toBe(foreignBytes);
      expect(github.requests).toEqual([]);
    }
  },
);

test("sign-out removes a pair a killed write left aside without remote revocation", async () => {
  const github = startFakeGithub();
  const world = await pilotWorld({ preset: null });
  cleanups.push(github.close, world.cleanup);
  await enablePilot(world);
  await storeSignIn(world, github, exampleOrganization, {
    now: Date.now() - 3600 * 1000,
  });
  const stored = JSON.parse(await readFile(signInFile(world.paths), "utf8"));
  const aside = github.issue();
  await writeFile(
    join(world.paths.stateDirectory, ".sign-in.json.tmp-00112233445566aa"),
    JSON.stringify({
      ...stored,
      accessToken: aside.access,
      refreshToken: aside.refresh,
      refreshedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  expect(
    await signOut({
      paths: world.paths,
      organization: exampleOrganization,
    }),
  ).toMatchObject({ kind: "signed-out", scope: "environment" });
  expect(github.requests).toEqual([]);
  expect(github.accessValid(aside.access)).toBe(true);
  expect(
    (await readdir(world.paths.stateDirectory)).filter((name) =>
      name.includes("json"),
    ),
  ).toEqual([]);
});

test("an existing authorization cannot stand in for another assigned account", async () => {
  const { world, github, final } = await run(
    {},
    {
      subject: { login: "new-assignee", id: 999 },
      before: async (world, github) => {
        await storeSignIn(world, github, exampleOrganization);
      },
    },
  );
  expect(final).toMatchObject({
    kind: "failed",
    reason: "wrong-account",
    account: "example",
    expected: "new-assignee",
  });
  expect(github.requests).toHaveLength(0);
  expect(await readStoredSignIn(world.paths, "Example")).toMatchObject({
    account: { id: 12345 },
  });
});

test("unreadable credentials are preserved instead of replaced by a fresh authorization", async () => {
  const { world, github, final } = await run(
    {},
    {
      before: async (world, github) => {
        await storeSignIn(world, github, exampleOrganization);
        await writeFile(signInFile(world.paths), "unknown-state");
      },
    },
  );
  expect(final).toMatchObject({ kind: "failed", reason: "state-unreadable" });
  expect(github.requests).toHaveLength(0);
  expect(await readFile(signInFile(world.paths), "utf8")).toBe("unknown-state");
});
