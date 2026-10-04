import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironmentOf } from "../src/content/git";
import {
  ghContentGitHub,
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
  expect(await calls()).toEqual([
    "api user",
    "api repos/Example/present",
    "api repos/Example/absent",
    "api repos/Example/offline",
  ]);
});

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
