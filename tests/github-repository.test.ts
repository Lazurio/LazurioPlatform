import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareGitHubBindings } from "../src/providers/github-binding";
import {
  parseGitHubRepositoryObservation,
  readGitHubRepositoryAccess,
} from "../src/providers/github-repository";

const expected = {
  owner: "Example",
  repository: "fixture",
  expectedViewerId: "User_fixture",
};
const response = () => ({
  data: {
    viewer: { id: "User_fixture", login: "fixture-user" },
    repository: {
      id: "Repository_fixture",
      databaseId: 123,
      owner: {
        __typename: "Organization",
        id: "Org_fixture",
        login: "Example",
        databaseId: 456,
      },
      nameWithOwner: "Example/fixture",
      viewerPermission: "WRITE",
      isArchived: false,
      isDisabled: false,
    },
  },
});

test("provider observation binds viewer and repository without granting an operation", () => {
  const value = parseGitHubRepositoryObservation(response(), expected);
  expect(value).toEqual({
    kind: "observed",
    viewer: { id: "User_fixture", login: "fixture-user" },
    repository: {
      id: "Repository_fixture",
      databaseId: "123",
      owner: {
        kind: "Organization",
        id: "Org_fixture",
        login: "Example",
        databaseId: "456",
      },
      name: "Example/fixture",
      permission: "WRITE",
      archived: false,
      disabled: false,
    },
  });
  expect(Object.isFrozen(value)).toBe(true);
  expect(
    parseGitHubRepositoryObservation(response(), {
      ...expected,
      expectedViewerId: "Other",
    }),
  ).toEqual({ kind: "identity-mismatch" });
  expect(
    parseGitHubRepositoryObservation(response(), {
      ...expected,
      repository: "other",
    }),
  ).toEqual({ kind: "repository-mismatch" });
  const valueWithNoGrant = response();
  expect(
    parseGitHubRepositoryObservation(
      {
        data: {
          ...valueWithNoGrant.data,
          repository: {
            ...valueWithNoGrant.data.repository,
            viewerPermission: null,
            isArchived: true,
          },
        },
      },
      expected,
    ),
  ).toMatchObject({
    kind: "observed",
    repository: { permission: null, archived: true },
  });
  expect(
    parseGitHubRepositoryObservation(
      { data: { ...valueWithNoGrant.data, repository: null } },
      expected,
    ),
  ).toEqual({ kind: "repository-unavailable" });
});

test("existing forge bindings require exact repository and Organization identities", () => {
  const org = {
    forge: "github",
    locator: "Example",
    binding_state: "verified",
    organization_id: "456",
  };
  const repo = {
    forge: "github",
    locator: "Example/fixture",
    default_branch: "main",
    binding_state: "verified",
    repository_id: "123",
  };
  const observed = parseGitHubRepositoryObservation(response(), expected);
  expect(compareGitHubBindings(org, repo, observed)).toEqual({
    kind: "binding-matches",
  });
  expect(
    compareGitHubBindings(
      { ...org, locator: "EXAMPLE" },
      { ...repo, locator: "example/FIXTURE" },
      observed,
    ),
  ).toEqual({ kind: "binding-matches" });
  for (const changed of [
    { ...repo, repository_id: "999" },
    { ...repo, locator: "Example/renamed" },
    { ...repo, locator: "Other/fixture" },
  ])
    expect(compareGitHubBindings(org, changed, observed)).toEqual({
      kind: "binding-mismatch",
    });
  expect(
    compareGitHubBindings({ ...org, organization_id: "999" }, repo, observed),
  ).toEqual({ kind: "binding-mismatch" });
  expect(
    compareGitHubBindings(
      { forge: "github", locator: "Example", binding_state: "unverified" },
      repo,
      observed,
    ),
  ).toEqual({ kind: "binding-unverified" });
  expect(() =>
    compareGitHubBindings(
      { ...org, binding_state: "unverified" },
      repo,
      observed,
    ),
  ).toThrow();
  expect(compareGitHubBindings(org, repo, { kind: "unavailable" })).toEqual({
    kind: "provider-unavailable",
  });
  for (const databaseId of [null, Number.MAX_SAFE_INTEGER + 1, "123", -1]) {
    const data = response();
    const observation = parseGitHubRepositoryObservation(
      {
        data: {
          ...data.data,
          repository: { ...data.data.repository, databaseId },
        },
      },
      expected,
    );
    expect(compareGitHubBindings(org, repo, observation).kind).not.toBe(
      "binding-matches",
    );
  }
  const personal = response();
  const userOwned = parseGitHubRepositoryObservation(
    {
      data: {
        ...personal.data,
        repository: {
          ...personal.data.repository,
          owner: { __typename: "User", id: "User_owner", login: "Example" },
        },
      },
    },
    expected,
  );
  expect(compareGitHubBindings(org, repo, userOwned)).toEqual({
    kind: "provider-identity-unavailable",
  });
});

test("partial errors malformed metadata and executable objects never become provider evidence", () => {
  for (const input of [
    { ...response(), errors: [{ message: "synthetic" }] },
    {},
    { data: null },
    {
      data: {
        ...response().data,
        repository: {
          ...response().data.repository,
          viewerPermission: "OWNER",
        },
      },
    },
    {
      data: {
        ...response().data,
        repository: { ...response().data.repository, isDisabled: "false" },
      },
    },
  ])
    expect(parseGitHubRepositoryObservation(input, expected)).toEqual({
      kind: "unavailable",
    });
  let invoked = false;
  expect(
    parseGitHubRepositoryObservation(
      {
        get data() {
          invoked = true;
          return response().data;
        },
      },
      expected,
    ),
  ).toEqual({ kind: "unavailable" });
  expect(invoked).toBe(false);
});

test("provider fails closed without exposing invocation errors or accepting injected requests", async () => {
  expect(
    await readGitHubRepositoryAccess(expected, {
      executable: "/nonexistent-lazurio-fixture-gh",
      cwd: "/",
      env: {},
    }),
  ).toEqual({ kind: "unavailable" });
  for (const patch of [
    { owner: "@file" },
    { repository: "../other" },
    { expectedViewerId: "bad\nidentity" },
    { extra: true },
  ])
    await expect(
      readGitHubRepositoryAccess(
        { ...expected, ...patch },
        { executable: "/nonexistent-lazurio-fixture-gh", cwd: "/", env: {} },
      ),
    ).rejects.toThrow();
});

test("provider subprocess uses fixed read query sanitized environment and bounded output/time", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "provider-transport-")),
  );
  const executable = join(
    root,
    process.platform === "win32" ? "provider.exe" : "provider",
  );
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        resolve("tests/fixtures/github-cli.ts"),
        "--compile",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--outfile",
        executable,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [error, code] = await Promise.all([
      new Response(build.stderr).text(),
      build.exited,
    ]);
    expect(code, error).toBe(0);
    const context = {
      executable,
      cwd: root,
      env: {
        GH_DEBUG: "api",
        HTTPS_PROXY: "http://invalid.example",
        GH_HOST: "invalid.example",
      },
    };
    const observed = await readGitHubRepositoryAccess(expected, context);
    expect(observed.kind).toBe("observed");
    if (observed.kind === "observed") {
      expect(Date.parse(observed.completedAt)).toBeGreaterThanOrEqual(
        Date.parse(observed.startedAt),
      );
      expect(observed.repository.permission).toBe("READ");
    }
    for (const mode of ["warning", "oversize", "slow"])
      expect(
        await readGitHubRepositoryAccess(expected, {
          ...context,
          env: { ...context.env, GH_CONFIG_DIR: mode },
          timeoutMs: mode === "slow" ? 30 : 1000,
        }),
      ).toEqual({ kind: "unavailable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
