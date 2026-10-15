import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironmentOf } from "../src/content/git";
import {
  ghContentGitHub,
  parseMembership,
  parseRepository,
  parseViewer,
} from "../src/content/github";
import { runTool } from "../src/tools/status";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";

// The gh side of content installation, against a fake gh on a private PATH:
// the REST reads and their 404, gh's own "not signed in" exit, the template
// generation as a private repository, and the remote by gh's git protocol.
// No network, no real account.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

let parent = "";
afterEach(async () => {
  if (parent) await rm(parent, { recursive: true, force: true });
  parent = "";
});

async function fakeGh(script: string) {
  parent = await realpath(await mkdtemp(join(tmpdir(), "content-gh-")));
  const bin = join(parent, "bin");
  const home = join(parent, "home");
  await mkdir(bin);
  await mkdir(home);
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${join(parent, "calls")}"
${script}
`,
  );
  await chmod(gh, 0o755);
  const github = ghContentGitHub(
    { path: bin, home, platform: process.platform, run: runTool },
    { sleep: async () => {} },
  );
  return {
    gh,
    github,
    calls: async () =>
      (await readFile(join(parent, "calls"), "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== ""),
  };
}

test("the GitHub answers are read strictly", () => {
  expect(parseViewer('{"login":"example","id":12345,"node_id":"U_x"}')).toEqual(
    {
      login: "example",
      databaseId: 12345,
    },
  );
  // The profile's name, when set, names the owner of a new Personalspace.
  expect(
    parseViewer('{"login":"example","id":12345,"name":"  Ex\\u0007 Ample "}'),
  ).toEqual({ login: "example", databaseId: 12345, name: "Ex Ample" });
  for (const name of ["null", '""', '"   "', "42"])
    expect(
      parseViewer(`{"login":"example","id":12345,"name":${name}}`),
    ).toEqual({ login: "example", databaseId: 12345 });
  for (const bad of ['{"login":"-x","id":1}', '{"login":"x","id":"1"}', "nope"])
    expect(parseViewer(bad)).toBeNull();
  const repository = {
    full_name: "Example/repo",
    private: true,
    archived: false,
    owner: { login: "Example", id: 7, type: "Organization" },
    permissions: { pull: true },
  };
  expect(parseRepository(JSON.stringify(repository))).toEqual({
    fullName: "Example/repo",
    owner: { login: "Example", databaseId: 7, kind: "Organization" },
    private: true,
    archived: false,
    readable: true,
    permission: "read",
  });
  expect(
    parseRepository(
      JSON.stringify({
        ...repository,
        permissions: { pull: true, triage: true, push: true, maintain: false },
      }),
    )?.permission,
  ).toBe("write");
  expect(parseMembership('{"state":"active","role":"admin"}')).toEqual({
    kind: "member",
    state: "active",
    role: "admin",
  });
  expect(parseMembership('{"state":"active","role":"owner"}')).toEqual({
    kind: "unavailable",
  });
  expect(
    parseRepository(JSON.stringify({ ...repository, permissions: undefined }))
      ?.readable,
  ).toBe(false);
  expect(
    parseRepository(JSON.stringify({ ...repository, private: "yes" })),
  ).toBeNull();
});

posixTest("gh's sign-in, a repository and its 404", async () => {
  const { github, calls } = await fakeGh(`
case "$*" in
  "api user") echo '{"login":"example","id":12345}' ;;
  "api repos/Example/present") echo '{"full_name":"Example/present","private":true,"archived":false,"owner":{"login":"Example","id":7,"type":"Organization"},"permissions":{"pull":true}}' ;;
  "api repos/Example/absent") echo '{"message":"Not Found","status":"404"}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
  "api user/memberships/orgs/Example") echo '{"state":"active","role":"admin","organization":{"login":"Example"}}' ;;
  "api user/memberships/orgs/Other") echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
  *) echo 'error connecting to api.github.com' >&2; exit 1 ;;
esac`);
  expect(await github.viewer()).toEqual({
    kind: "signed-in",
    viewer: { login: "example", databaseId: 12345 },
  });
  expect((await github.repository("Example", "present")).kind).toBe("observed");
  expect(await github.repository("Example", "absent")).toEqual({
    kind: "missing",
  });
  // Any other failure is not a 404: never read as "absent".
  expect(await github.repository("Example", "offline")).toEqual({
    kind: "unavailable",
  });
  expect(await github.membership("Example")).toEqual({
    kind: "member",
    state: "active",
    role: "admin",
  });
  expect(await github.membership("Other")).toEqual({ kind: "none" });
  expect(await calls()).toEqual([
    "api user",
    "api repos/Example/present",
    "api repos/Example/absent",
    "api repos/Example/offline",
    "api user/memberships/orgs/Example",
    "api user/memberships/orgs/Other",
  ]);
});

posixTest(
  "a root's declaration is read raw from the default branch, and the Organization's repositories are listed",
  async () => {
    const { github, calls } = await fakeGh(`
case "$*" in
  "api --header Accept: application/vnd.github.raw+json repos/Example/root/contents/lazurio.organization.json") echo '{"kind":"organization"}' ;;
  "api --header Accept: application/vnd.github.raw+json repos/Example/plain/contents/lazurio.organization.json") echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
  "api --paginate orgs/Example/repos?per_page=100&type=all --jq "*) printf 'Example/root\\nExample/plain\\n' ;;
  "api --paginate orgs/Missing/repos?per_page=100&type=all --jq "*) echo '{"message":"Not Found","status":"404"}'; exit 1 ;;
  *) exit 1 ;;
esac`);
    expect(await github.declaration("Example", "root")).toEqual({
      kind: "file",
      value: { kind: "organization" },
    });
    expect(await github.declaration("Example", "plain")).toEqual({
      kind: "missing",
    });
    expect(await github.declaration("Example", "offline")).toEqual({
      kind: "unavailable",
    });
    expect(await github.organizationRepositories("Example")).toEqual([
      "Example/root",
      "Example/plain",
    ]);
    expect(await github.organizationRepositories("Missing")).toEqual([]);
    expect(await github.organizationRepositories("Other")).toBe("unavailable");
    expect((await calls()).at(-3)).toBe(
      "api --paginate orgs/Example/repos?per_page=100&type=all --jq .[] | select(.archived | not) | .full_name",
    );
  },
);

posixTest("gh without a sign-in is signed out, never unavailable", async () => {
  const { github } = await fakeGh(`
echo 'To get started with GitHub CLI, please run:  gh auth login' >&2
exit 4`);
  expect(await github.viewer()).toEqual({ kind: "signed-out" });
});

posixTest(
  "a Personalspace is generated private from the template",
  async () => {
    const { github, calls } = await fakeGh(`
case "$*" in
  "api --method POST repos/Lazurio/PersonalspaceTemplate_GEN3/generate "*) echo '{"full_name":"example/example_GEN3","private":true,"archived":false,"owner":{"login":"example","id":12345,"type":"User"},"permissions":{"pull":true}}' ;;
  "api repos/example/example_GEN3/branches/main") echo '{"name":"main"}' ;;
  "config get git_protocol --host github.com") echo ssh ;;
  "api graphql --paginate "*) printf 'example/old_GEN3\\tLazurio/PersonalspaceTemplate_GEN3\\nexample/other\\tSomeone/Else\\n' ;;
  *) exit 1 ;;
esac`);
    expect(
      await github.generate(
        "Lazurio/PersonalspaceTemplate_GEN3",
        "example",
        "example_GEN3",
        "Privátní Personalspace GEN3.",
      ),
    ).toEqual({ kind: "created", private: true });
    expect(await github.branchReady("example", "example_GEN3")).toBe(true);
    expect(await github.remote("example/example_GEN3")).toEqual({
      url: "git@github.com:example/example_GEN3.git",
    });
    expect(
      await github.templateDerived("Lazurio/PersonalspaceTemplate_GEN3"),
    ).toEqual(["example/old_GEN3"]);
    const generate = (await calls())[0] as string;
    expect(generate).toContain("--field private=true");
    expect(generate).toContain("--raw-field owner=example");
    expect(generate).toContain("--raw-field name=example_GEN3");
  },
);

posixTest(
  "a personal module's repository is created empty and private on the viewer's account; GitHub's answer is read strictly",
  async () => {
    const { github, calls } = await fakeGh(`
case "$*" in
  "api --method POST user/repos --raw-field name=notes "*) echo '{"full_name":"example/notes","private":true,"archived":false,"owner":{"login":"example","id":12345,"type":"User"},"permissions":{"admin":true,"pull":true}}' ;;
  "api --method POST user/repos --raw-field name=public "*) echo '{"full_name":"example/public","private":false,"archived":false,"owner":{"login":"example","id":12345,"type":"User"},"permissions":{"admin":true,"pull":true}}' ;;
  "api --method POST user/repos --raw-field name=taken "*) echo '{"message":"Repository creation failed.","errors":[{"resource":"Repository","code":"custom","field":"name","message":"name already exists on this account"}],"status":"422"}'; exit 1 ;;
  "api --method POST user/repos --raw-field name=garbled "*) echo 'not json' ;;
  *) exit 1 ;;
esac`);
    expect(
      await github.createRepository("notes", "Osobní Modul Lazuria."),
    ).toEqual({
      kind: "created",
      repository: {
        fullName: "example/notes",
        owner: { login: "example", databaseId: 12345, kind: "User" },
        private: true,
        archived: false,
        readable: true,
        permission: "admin",
      },
    });
    // GitHub's answer is the caller's to verify: here, public.
    expect(
      await github.createRepository("public", "Osobní Modul Lazuria."),
    ).toMatchObject({ kind: "created", repository: { private: false } });
    expect(
      await github.createRepository("taken", "Osobní Modul Lazuria."),
    ).toEqual({ kind: "failed" });
    expect(
      await github.createRepository("garbled", "Osobní Modul Lazuria."),
    ).toEqual({ kind: "failed" });
    // A name GitHub would not take is never sent.
    expect(
      await github.createRepository("no/slash", "Osobní Modul Lazuria."),
    ).toEqual({ kind: "failed" });
    const sent = await calls();
    expect(sent).toHaveLength(4);
    expect(sent[0]).toBe(
      "api --method POST user/repos --raw-field name=notes --raw-field description=Osobní Modul Lazuria. --field private=true --field auto_init=false",
    );
  },
);

posixTest("an HTTPS remote takes gh as git's credential helper", async () => {
  const { github, gh } = await fakeGh("exit 1");
  expect(await github.remote("Example/repo")).toEqual({
    url: "https://github.com/Example/repo.git",
    credentialHelper: `!${JSON.stringify(gh)} auth git-credential`,
  });
});

test("git gets the operator's SSH and Git configuration, never a token", () => {
  expect(
    gitEnvironmentOf({
      SSH_AUTH_SOCK: "/tmp/agent",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.x.insteadOf",
      GIT_CONFIG_VALUE_0: "y",
      GH_TOKEN: "not passed",
      GITHUB_TOKEN: "not passed",
      PATH: "/bin",
    }),
  ).toEqual({
    SSH_AUTH_SOCK: "/tmp/agent",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.x.insteadOf",
    GIT_CONFIG_VALUE_0: "y",
  });
});
