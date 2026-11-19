import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentGit } from "../src/content/git";
import {
  type ContentGitHub,
  type DeclarationAnswer,
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
import { canonicalDocument } from "./fixtures/catalog-folder";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// `lazurio organization role` (#866): the live role from the core that scopes
// content install, the root as the Folder or GitHub has it, the appointed
// Organization Admins from the root's organization_admins (decision 0245,
// amended 2026-11-18: the Owner role is never the Admin role), and GitHub
// not answering is never a role. The role values are the identifiers of root
// decision 0234. The viewer is `ada`, GitHub id 1.

/** The root `Acme/Acme_GEN3`'s lazurio.organization.json, declaring itself
 * the root of Acme, with `admins` as its organization_admins (absent when
 * undefined). */
function rootDeclaration(admins?: unknown): DeclarationAnswer {
  const document: Record<string, unknown> = {
    ...canonicalDocument("acme", "organization", [], "Acme"),
    root_repository: {
      forge: "github",
      locator: "Acme/Acme_GEN3",
      default_branch: "main",
      binding_state: "unverified",
    },
  };
  if (admins !== undefined) document.organization_admins = admins;
  return { kind: "file", value: document };
}
const ada = { github_id: "1", github_login: "ada" };
const cy = { github_id: "3", github_login: "cy" };

type Answers = Readonly<{
  viewer?: "signed-in" | "signed-out" | "unavailable";
  membership?: MembershipAnswer;
  root?: RepositoryAnswer;
  /** The root's lazurio.organization.json; by default it declares itself
   * and appoints no one. */
  declaration?: DeclarationAnswer;
  /** Collects the repositories whose declaration was asked. */
  declared?: string[];
  /** The root's branch-rule capability; absent, the method is missing. */
  branchRules?: "available" | "unavailable" | "unknown";
  /** Collects the repositories whose branch rules were asked. */
  asked?: string[];
  /** The listing of the viewer's memberships; by default it answers and
   * names none. */
  memberships?:
    | readonly {
        organization: string;
        state: "active";
        role: "admin" | "member";
      }[]
    | "unavailable";
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
    async memberships() {
      return answers.memberships ?? [];
    },
    async declaration(owner: string, name: string) {
      answers.declared?.push(`${owner}/${name}`);
      return answers.declaration ?? rootDeclaration();
    },
    ...(answers.branchRules === undefined
      ? {}
      : {
          async branchRules(owner: string, name: string) {
            answers.asked?.push(`${owner}/${name}`);
            return answers.branchRules;
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

test("an appointed Organization Admin who is also an Organization Owner is the Organization Admin, with the root and the appointed Admins", async () => {
  const declared: string[] = [];
  expect(
    await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership: { kind: "member", state: "active", role: "admin" },
        declaration: rootDeclaration([cy, ada]),
        declared,
      }),
      root: resolved,
    }),
  ).toEqual({
    kind: "organization-role",
    organization: "Acme",
    login: "ada",
    role: "organization-admin",
    verified: true,
    rootRepository: "Acme/Acme_GEN3",
    admins: ["cy", "ada"],
    source: "github",
  });
  expect(declared).toEqual(["Acme/Acme_GEN3"]);
});

test("an appointed Organization Admin who is no Organization Owner is the Organization Admin, whatever the root's permission", async () => {
  for (const permission of ["read", "write", "maintain", null] as const) {
    const answer = await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership: { kind: "member", state: "active", role: "member" },
        declaration: rootDeclaration([ada]),
        ...(permission === null
          ? {}
          : {
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
      }),
      root: resolved,
    });
    expect([permission, answer.role, answer.verified, answer.admins]).toEqual([
      permission,
      "organization-admin",
      true,
      ["ada"],
    ]);
  }
});

test("an Organization Owner who is not appointed is the Organization Owner, never the Organization Admin", async () => {
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "member", state: "active", role: "admin" },
      declaration: rootDeclaration([cy]),
    }),
    root: resolved,
  });
  expect(answer).toMatchObject({
    role: "organization-owner",
    verified: true,
    admins: ["cy"],
  });
  expect("detail" in answer).toBe(false);
  // The same login under another id is not the account: the id decides.
  expect(
    (
      await readOrganizationRole({
        organization: "Acme",
        github: fakeGitHub({
          membership: { kind: "member", state: "active", role: "admin" },
          declaration: rootDeclaration([
            { github_id: "9", github_login: "ada" },
          ]),
        }),
        root: resolved,
      })
    ).role,
  ).toBe("organization-owner");
});

test("an appointed Admin without an active membership is no Organization Admin", async () => {
  const writer = {
    kind: "observed" as const,
    repository: {
      fullName: "Acme/Acme_GEN3",
      owner: { login: "Acme", databaseId: 2, kind: "Organization" as const },
      private: true,
      archived: false,
      readable: true,
      permission: "write" as const,
    },
  };
  const roleOf = (membership: MembershipAnswer, root?: RepositoryAnswer) =>
    readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership,
        declaration: rootDeclaration([ada]),
        ...(root === undefined ? {} : { root }),
      }),
      root: resolved,
    });
  // A pending invitation, even of an Owner: nothing is confirmed from it.
  for (const role of ["member", "admin"] as const)
    expect(
      await roleOf({ kind: "member", state: "pending", role }),
    ).toMatchObject({ role: null, verified: false, admins: ["ada"] });
  // No membership (the listing confirms it): write on the root names only
  // the Module role.
  expect(await roleOf({ kind: "none" }, writer)).toMatchObject({
    role: "module-contributor",
    verified: true,
    admins: ["ada"],
  });
});

test("a root without organization_admins, or with an empty list, appoints no one", async () => {
  for (const declaration of [rootDeclaration(), rootDeclaration([])]) {
    const owner = await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership: { kind: "member", state: "active", role: "admin" },
        declaration,
      }),
      root: resolved,
    });
    expect(owner).toMatchObject({ role: "organization-owner", admins: [] });
    const member = await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({ declaration }),
      root: resolved,
    });
    expect(member).toMatchObject({ role: "module-reader", admins: [] });
  }
});

test("a root whose organization_admins cannot be read confirms no role for an active member, and says why", async () => {
  const cases: [DeclarationAnswer, string][] = [
    [
      { kind: "unavailable" },
      "GitHub did not answer for the lazurio.organization.json of Acme/Acme_GEN3",
    ],
    [
      { kind: "missing" },
      "Acme/Acme_GEN3 has no lazurio.organization.json this account can read",
    ],
    [
      { kind: "file", value: { schema_version: "lazurio.organization.v1" } },
      "does not declare it the root of Acme",
    ],
    [rootDeclaration([ada, ada]), "github_id 1 is named more than once"],
    [
      rootDeclaration([{ github_id: 1, github_login: "ada" }]),
      "github_id must be a decimal string",
    ],
    [rootDeclaration({ ada: 1 }), "organization_admins must be a list"],
  ];
  for (const [declaration, reason] of cases)
    for (const role of ["admin", "member"] as const) {
      const answer = await readOrganizationRole({
        organization: "Acme",
        github: fakeGitHub({
          membership: { kind: "member", state: "active", role },
          declaration,
        }),
        root: resolved,
      });
      expect([reason, role, answer.role, answer.verified]).toEqual([
        reason,
        role,
        null,
        false,
      ]);
      expect(answer.detail).toContain(
        "whether the account is an appointed Organization Admin is not known",
      );
      expect(answer.detail).toContain(reason);
      expect("admins" in answer).toBe(false);
    }
  // Without a membership no one can be an appointed Admin: the Module role
  // stands, and the answer says why the Admins are missing.
  const outside = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "none" },
      declaration: { kind: "unavailable" },
      root: {
        kind: "observed",
        repository: {
          fullName: "Acme/Acme_GEN3",
          owner: { login: "Acme", databaseId: 2, kind: "Organization" },
          private: true,
          archived: false,
          readable: true,
          permission: "write",
        },
      },
    }),
    root: resolved,
  });
  expect(outside).toMatchObject({ role: "module-contributor", verified: true });
  expect(outside.detail).toContain(
    "the appointed Organization Admins are not known",
  );
  expect("admins" in outside).toBe(false);
});

test("a member who reads the root is a Module Reader; write and maintain name a Module Contributor and a Module Maintainer", async () => {
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
  expect(await roleWith("read")).toBe("module-reader");
  expect(await roleWith("write")).toBe("module-contributor");
  expect(await roleWith("maintain")).toBe("module-maintainer");
});

test("write on a private root is the Module Maintainer where it cannot have branch rules, a public root always can, and only write asks", async () => {
  const roleWith = async (
    permission: "read" | "write" | "maintain",
    branchRules: "available" | "unavailable" | "unknown" | undefined,
    isPrivate = true,
  ) => {
    const asked: string[] = [];
    const answer = await readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        root: {
          kind: "observed",
          repository: {
            fullName: "Acme/Acme_GEN3",
            owner: { login: "Acme", databaseId: 2, kind: "Organization" },
            private: isPrivate,
            archived: false,
            readable: true,
            permission,
          },
        },
        ...(branchRules === undefined ? {} : { branchRules }),
        asked,
      }),
      root: resolved,
    });
    return { role: answer.role, asked };
  };
  expect(await roleWith("write", "unavailable")).toEqual({
    role: "module-maintainer",
    asked: ["Acme/Acme_GEN3"],
  });
  expect(await roleWith("write", "available")).toEqual({
    role: "module-contributor",
    asked: ["Acme/Acme_GEN3"],
  });
  // GitHub not saying, or no way to ask, names the lower role.
  expect((await roleWith("write", "unknown")).role).toBe("module-contributor");
  expect((await roleWith("write", undefined)).role).toBe("module-contributor");
  // A public repository can always have branch rules: nothing is asked.
  expect(await roleWith("write", "unavailable", false)).toEqual({
    role: "module-contributor",
    asked: [],
  });
  // Only write depends on it.
  expect(await roleWith("maintain", "available")).toEqual({
    role: "module-maintainer",
    asked: [],
  });
  expect(await roleWith("read", "unavailable")).toEqual({
    role: "module-reader",
    asked: [],
  });
});

test("GitHub not answering is no role: not verified, with the reason, and no Organization Admins when it serves no list", async () => {
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "unavailable" },
      root: { kind: "unavailable" },
      declaration: { kind: "unavailable" },
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

test("an Organization Owner is not confirmed when the root is not found: an appointed Admin is not ruled out, and the answer says why", async () => {
  const declared: string[] = [];
  const answer = await readOrganizationRole({
    organization: "Acme",
    github: fakeGitHub({
      membership: { kind: "member", state: "active", role: "admin" },
      declared,
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
    role: null,
    verified: false,
    rootRepository: null,
  });
  expect(answer.detail).toBe(
    "whether the account is an appointed Organization Admin is not known: the root repository of Acme was not found, so its organization_admins could not be read; no repository of Acme this account can read declares itself the root",
  );
  expect("admins" in answer).toBe(false);
  expect(declared).toEqual([]);
});

test("without the membership no role is confirmed, not even a Module Contributor or Module Maintainer from the root", async () => {
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
    expect(answer.detail).toContain(
      "whether the account is an Organization Owner",
    );
  }
});

test("a 404 membership counts as no membership only when the listing of memberships confirms it", async () => {
  const writer = {
    kind: "observed" as const,
    repository: {
      fullName: "Acme/Acme_GEN3",
      owner: { login: "Acme", databaseId: 2, kind: "Organization" as const },
      private: true,
      archived: false,
      readable: true,
      permission: "write" as const,
    },
  };
  const roleOf = (memberships: NonNullable<Answers["memberships"]>) =>
    readOrganizationRole({
      organization: "Acme",
      github: fakeGitHub({
        membership: { kind: "none" },
        root: writer,
        memberships,
      }),
      root: resolved,
    });
  // The listing does not answer: the 404 may hide an Organization Owner.
  const hidden = await roleOf("unavailable");
  expect(hidden).toMatchObject({ role: null, verified: false });
  expect(hidden.detail).toContain("this sign-in may not see it");
  // It answers without Acme: an outside collaborator with write is a Module
  // Contributor.
  expect((await roleOf([])).role).toBe("module-contributor");
  // It answers with Acme: that is the membership, of an Owner the root
  // appoints no Admin.
  expect(
    (await roleOf([{ organization: "acme", state: "active", role: "admin" }]))
      .role,
  ).toBe("organization-owner");
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
  // The Folder holds the root; its appointed Admins are read through
  // GitHub from the default branch of the checkout's origin.
  const declared: string[] = [];
  const admin = await run(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio", "--json"],
    {
      membership: { kind: "member", state: "active", role: "admin" },
      declaration: rootDeclaration([ada, cy]),
      declared,
    },
  );
  expect(admin.code).toBe(0);
  expect(JSON.parse(admin.text)).toMatchObject({
    role: "organization-admin",
    rootRepository: "Acme/Acme_GEN3",
    admins: ["ada", "cy"],
  });
  expect(inspected).toEqual(["/srv/Lazurio/organizations/Acme_GEN3"]);
  expect(declared).toEqual(["Acme/Acme_GEN3"]);
  const human = await run(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio"],
    {
      membership: { kind: "member", state: "active", role: "admin" },
      declaration: rootDeclaration([ada, cy]),
    },
  );
  expect(human.text.split("\n")).toEqual([
    "Acme: organization-admin (GitHub, as ada)",
    "  root: Acme/Acme_GEN3",
    "  Organization Admins: ada, cy",
  ]);
  const owner = await run(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio"],
    { membership: { kind: "member", state: "active", role: "admin" } },
  );
  expect(owner.code).toBe(0);
  expect(owner.text.split("\n")).toEqual([
    "Acme: organization-owner (GitHub, as ada)",
    "  root: Acme/Acme_GEN3",
    "  Organization Admins: none appointed (organization_admins of the root)",
  ]);
  const unknown = await run(
    ["organization", "role", "Acme", "--folder", "/srv/Lazurio"],
    { membership: { kind: "unavailable" }, root: { kind: "unavailable" } },
  );
  expect(unknown.code).toBe(1);
  expect(unknown.text).toContain("Acme: role not verified");
  expect(unknown.text).toContain("proceed as for an Organization Member");
});

test("the command does not take a Folder-held root of another owner: Acme's checkout of Other/root with write is no Module Contributor", async () => {
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
  "through gh, an Organization Owner whose membership answers 404 to this sign-in is no confirmed non-Admin of the Organization",
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
case "$*" in
  "api user") echo '{"login":"ada","id":1}' ;;
  "api user/memberships/orgs/Acme") echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
  "api --paginate user/memberships/orgs?per_page=100 --jq "*) echo '{"message":"Forbidden","status":"403"}'; exit 1 ;;
  "api repos/Acme/Acme_GEN3") echo '{"full_name":"Acme/Acme_GEN3","private":true,"archived":false,"owner":{"login":"Acme","id":2,"type":"Organization"},"permissions":{"admin":false,"maintain":false,"push":true,"triage":true,"pull":true}}' ;;
  "api --header Accept: application/vnd.github.raw+json repos/Acme/Acme_GEN3/contents/lazurio.organization.json") echo '${JSON.stringify((rootDeclaration([ada]) as { value: unknown }).value)}' ;;
  *) echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
esac
`,
    );
    await chmod(join(bin, "gh"), 0o755);
    const github = ghContentGitHub(
      { path: bin, home, platform: process.platform, run: runTool },
      { sleep: async () => {} },
    );
    expect(await github.membership("Acme")).toEqual({ kind: "none" });
    expect(await github.memberships?.()).toBe("unavailable");
    const answer = await readOrganizationRole({
      organization: "Acme",
      github,
      root: resolved,
    });
    expect(answer).toMatchObject({
      login: "ada",
      role: null,
      verified: false,
      rootRepository: "Acme/Acme_GEN3",
      admins: ["ada"],
    });
    expect(answer.detail).toContain("this sign-in may not see it");
  },
);

posixTest(
  "through gh, a root's rulesets answering is branch rules available, GitHub's refusal by plan is unavailable, anything else unknown",
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
case "$*" in
  "api repos/Acme/Paid/rulesets") echo '[]' ;;
  "api repos/Acme/Free/rulesets") echo '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}'; echo 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' >&2; exit 1 ;;
  "api repos/Acme/Forbidden/rulesets") echo '{"message":"Resource not accessible by integration","status":"403"}'; exit 1 ;;
  *) echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
esac
`,
    );
    await chmod(join(bin, "gh"), 0o755);
    const github = ghContentGitHub(
      { path: bin, home, platform: process.platform, run: runTool },
      { sleep: async () => {} },
    );
    expect(await github.branchRules?.("Acme", "Paid")).toBe("available");
    expect(await github.branchRules?.("Acme", "Free")).toBe("unavailable");
    expect(await github.branchRules?.("Acme", "Forbidden")).toBe("unknown");
    expect(await github.branchRules?.("Acme", "Missing")).toBe("unknown");
  },
);

posixTest(
  "gh lists the viewer's memberships by Organization, state and role, and a garbled listing is unavailable",
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
read -r mode < "${join(parent, "mode")}"
case "$mode" in
  good) printf 'Acme\\tactive\\tadmin\\nOther\\tpending\\tmember\\n' ;;
  bad) printf 'Acme\\towner\\tadmin\\n' ;;
esac
`,
    );
    await chmod(join(bin, "gh"), 0o755);
    const github = ghContentGitHub(
      { path: bin, home, platform: process.platform, run: runTool },
      { sleep: async () => {} },
    );
    await writeFile(join(parent, "mode"), "good");
    expect(await github.memberships?.()).toEqual([
      { organization: "Acme", state: "active", role: "admin" },
      { organization: "Other", state: "pending", role: "member" },
    ]);
    await writeFile(join(parent, "mode"), "bad");
    expect(await github.memberships?.()).toBe("unavailable");
  },
);
