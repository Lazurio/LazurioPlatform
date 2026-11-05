import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentGit } from "../src/content/git";
import {
  type ContentGitHub,
  ghContentGitHub,
  type RepositoryAnswer,
} from "../src/content/github";
import type { MembershipAnswer } from "../src/content/role";
import type {
  Catalog,
  CatalogOrganization,
} from "../src/organizations/catalog";
import {
  RoleUsageError,
  readOrganizationRole,
  runOrganizationRoleCommand,
} from "../src/organizations/role-cli";
import { runTool } from "../src/tools/status";
import type { CliContext } from "../src/update/cli";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// `lazurio organization role` (#866): the live role from the core that scopes
// content install, the root as the Folder or GitHub has it, the Owners, and
// GitHub not answering is never a role.

type Answers = Readonly<{
  viewer?: "signed-in" | "signed-out" | "unavailable";
  membership?: MembershipAnswer;
  root?: RepositoryAnswer;
  owners?: readonly string[] | "unavailable" | "absent";
}>;

function fakeGitHub(answers: Answers = {}): ContentGitHub {
  const github = {
    async viewer() {
      const kind = answers.viewer ?? "signed-in";
      return kind === "signed-in"
        ? { kind, viewer: { login: "ada", databaseId: 1 } }
        : { kind };
    },
    async repository(owner: string, name: string): Promise<RepositoryAnswer> {
      return (
        answers.root ?? {
          kind: "observed",
          repository: {
            fullName: `${owner}/${name}`,
            owner: { login: owner, databaseId: 2, kind: "Organization" },
            private: true,
            archived: false,
            readable: true,
            permission: "read",
          },
        }
      );
    },
    async membership() {
      return (
        answers.membership ?? {
          kind: "member",
          state: "active",
          role: "member",
        }
      );
    },
    ...(answers.owners === "absent"
      ? {}
      : {
          async owners() {
            return answers.owners ?? ["ada", "bob"];
          },
        }),
  };
  return github as unknown as ContentGitHub;
}

const resolved = async () =>
  Object.freeze({
    kind: "resolved" as const,
    source: "name-candidate" as const,
    repository: "Acme/Acme_GEN3",
  });

test("an active Owner is the Admin, with the root and the Owners", async () => {
  expect(
    await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership: { kind: "member", state: "active", role: "admin" },
      }),
      root: resolved,
    }),
  ).toEqual({
    kind: "organization-role",
    organization: "Acme",
    login: "ada",
    role: "admin",
    verified: true,
    rootRepository: "Acme/Acme_GEN3",
    admins: ["ada", "bob"],
    source: "github",
  });
});

test("a member who reads the root is a reader; write and maintain name Builder and Steward", async () => {
  const roleWith = async (permission: "read" | "write" | "maintain") =>
    (
      await readOrganizationRole({
        organization: "Acme",
        github: fakeGitHub({
          root: {
            kind: "observed",
            repository: {
              fullName: "Acme/Acme_GEN3",
              owner: { login: "Acme", databaseId: 2, kind: "Organization" },
              private: true,
              archived: false,
              readable: true,
              permission,
            },
          },
        }),
        root: resolved,
      })
    ).role;
  expect(await roleWith("read")).toBe("reader");
  expect(await roleWith("write")).toBe("builder");
  expect(await roleWith("maintain")).toBe("steward");
});

test("GitHub not answering is no role: not verified, with the reason, and no Owners when it lists none", async () => {
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "unavailable" },
      root: { kind: "unavailable" },
      owners: "unavailable",
    }),
    root: resolved,
  });
  expect(answer).toMatchObject({ role: null, verified: false, login: "ada" });
  expect(answer.detail).toContain("GitHub did not answer");
  expect("admins" in answer).toBe(false);
  for (const viewer of ["signed-out", "unavailable"] as const)
    expect(
      await readOrganizationRole({
        organization: "Acme",
        github: fakeGitHub({ viewer }),
        root: resolved,
      }),
    ).toMatchObject({
      login: null,
      role: null,
      verified: false,
      rootRepository: null,
    });
});

test("an Owner stays the Admin when the root is not found, and the answer says why", async () => {
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "member", state: "active", role: "admin" },
      owners: "absent",
    }),
    root: async () =>
      Object.freeze({
        kind: "failed" as const,
        code: "root-not-found" as const,
        detail:
          "no repository of Acme this account can read declares itself the root",
      }),
  });
  expect(answer).toMatchObject({
    role: "admin",
    verified: true,
    rootRepository: null,
    detail:
      "no repository of Acme this account can read declares itself the root",
  });
  expect("admins" in answer).toBe(false);
});

test("without the membership no role is confirmed, not even Builder or Steward from the root", async () => {
  for (const permission of ["read", "write", "maintain"] as const) {
    const answer = await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership: { kind: "unavailable" },
        root: {
          kind: "observed",
          repository: {
            fullName: "Acme/Acme_GEN3",
            owner: { login: "Acme", databaseId: 2, kind: "Organization" },
            private: true,
            archived: false,
            readable: true,
            permission,
          },
        },
      }),
      root: resolved,
    });
    expect([permission, answer.role, answer.verified]).toEqual([
      permission,
      null,
      false,
    ]);
    expect(answer.detail).toContain("whether the account is an Owner");
  }
});

test("a root the Folder holds of another owner names no role here", async () => {
  const asked: string[] = [];
  const github = fakeGitHub({
    membership: { kind: "none" },
    root: {
      kind: "observed",
      repository: {
        fullName: "Other/root",
        owner: { login: "Other", databaseId: 3, kind: "Organization" },
        private: true,
        archived: false,
        readable: true,
        permission: "write",
      },
    },
  });
  const repository = github.repository.bind(github);
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: {
      ...github,
      async repository(owner, name) {
        asked.push(`${owner}/${name}`);
        return repository(owner, name);
      },
    },
    root: async () =>
      Object.freeze({
        kind: "present" as const,
        directory: "/srv/Lazurio/organizations/Acme_GEN3",
        name: "Acme_GEN3",
        slug: "acme",
        repository: "Other/root",
      }),
  });
  expect(answer).toMatchObject({
    role: null,
    verified: false,
    rootRepository: null,
  });
  expect(answer.detail).toContain(
    "is a checkout of Other/root, which does not belong to Acme",
  );
  expect(asked).toEqual([]);
  // The owner's case does not matter.
  expect(
    (
      await readOrganizationRole({
        organization: "acme",
        github: fakeGitHub({
          membership: { kind: "member", state: "active", role: "member" },
        }),
        root: resolved,
      })
    ).rootRepository,
  ).toBe("Acme/Acme_GEN3");
});

test("an empty listing of the Owners is left out, never an empty list of Admins", async () => {
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "member", state: "active", role: "admin" },
      owners: [],
    }),
    root: resolved,
  });
  expect(answer.role).toBe("admin");
  expect("admins" in answer).toBe(false);
});

const context = {
  identity: { version: "1.0.0", commit: "0".repeat(40), target: "fixture" },
  platform: process.platform,
  env: {},
  executable: "lazurio",
} as unknown as CliContext;

test("the command finds the root the Folder holds, prints JSON, and exits 0 verified and 1 not", async () => {
  const catalog = {
    kind: "catalog",
    organizations: [
      {
        directory: "Acme_GEN3",
        organization: "acme",
        forgeLogin: "Acme",
      } as unknown as CatalogOrganization,
    ],
  } as Catalog;
  const inspected: string[] = [];
  const git = {
    async inspect(directory: string) {
      inspected.push(directory);
      return { kind: "checkout", repository: "Acme/Acme_GEN3" };
    },
  } as unknown as ContentGit;
  const run = (args: string[], answers: Answers) =>
    runOrganizationRoleCommand(
      args,
      context,
      { github: fakeGitHub(answers), git },
      async () => catalog,
    );
  const owner = await run(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio", "--json"],
    { membership: { kind: "member", state: "active", role: "admin" } },
  );
  expect(owner.code).toBe(0);
  expect(JSON.parse(owner.text)).toMatchObject({
    role: "admin",
    rootRepository: "Acme/Acme_GEN3",
    admins: ["ada", "bob"],
  });
  expect(inspected).toEqual(["/srv/Lazurio/organizations/Acme_GEN3"]);
  const unknown = await run(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio"],
    { membership: { kind: "unavailable" }, root: { kind: "unavailable" } },
  );
  expect(unknown.code).toBe(1);
  expect(unknown.text).toContain("Acme: role not verified");
  expect(unknown.text).toContain("proceed as for a member");
});

test("the command does not take a Folder-held root of another owner: Acme's checkout of Other/root with write is no Builder", async () => {
  const catalog = {
    kind: "catalog",
    organizations: [
      {
        directory: "Acme_GEN3",
        organization: "acme",
        forgeLogin: "Acme",
      } as unknown as CatalogOrganization,
    ],
  } as Catalog;
  const git = {
    async inspect() {
      return { kind: "checkout", repository: "Other/root" };
    },
  } as unknown as ContentGit;
  const listed = await runOrganizationRoleCommand(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio", "--json"],
    context,
    {
      github: fakeGitHub({
        membership: { kind: "none" },
        root: {
          kind: "observed",
          repository: {
            fullName: "Other/root",
            owner: { login: "Other", databaseId: 3, kind: "Organization" },
            private: true,
            archived: false,
            readable: true,
            permission: "write",
          },
        },
      }),
      git,
    },
    async () => catalog,
  );
  expect(listed.code).toBe(1);
  expect(JSON.parse(listed.text)).toMatchObject({
    role: null,
    verified: false,
    rootRepository: null,
  });
});

test("usage: one Organization by its GitHub login and an absolute Folder", async () => {
  for (const args of [
    ["organization", "role"],
    ["organization", "role", "-bad-"],
    ["organization", "role", "Acme", "extra"],
    ["organization", "role", "Acme", "--folder", "relative/Folder"],
    ["organization", "role", "Acme", "--unknown"],
  ])
    await expect(
      runOrganizationRoleCommand(args, context, {
        github: fakeGitHub(),
        git: {} as ContentGit,
      }),
    ).rejects.toBeInstanceOf(RoleUsageError);
});

const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));
let parent = "";
afterEach(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
  parent = "";
});

posixTest(
  "gh lists the Owners without bots, and a listing it refuses or garbles is unavailable",
  async () => {
    parent = await realpath(
      await mkdtemp(join(tmpdir(), "organization-role-")),
    );
    const bin = join(parent, "bin");
    const home = join(parent, "home");
    await mkdir(bin);
    await mkdir(home);
    await writeFile(
      join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${join(parent, "calls")}"
case "$*" in
  "api --paginate orgs/Acme/members?role=admin&per_page=100 --jq "*) printf 'ada\\nbob\\n' ;;
  "api --paginate orgs/Garbled/members?role=admin&per_page=100 --jq "*) printf 'ada\\n-not a login-\\n' ;;
  *) echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
esac
`,
    );
    await chmod(join(bin, "gh"), 0o755);
    const github = ghContentGitHub(
      { path: bin, home, platform: process.platform, run: runTool },
      { sleep: async () => {} },
    );
    expect(await github.owners?.("Acme")).toEqual(["ada", "bob"]);
    expect(await github.owners?.("Garbled")).toBe("unavailable");
    expect(await github.owners?.("Missing")).toBe("unavailable");
    expect(await github.owners?.("-bad-")).toBe("unavailable");
    const calls = (await readFile(join(parent, "calls"), "utf8")).split("\n");
    expect(calls[0]).toBe(
      'api --paginate orgs/Acme/members?role=admin&per_page=100 --jq .[] | select(.type != "Bot") | .login',
    );
  },
);
