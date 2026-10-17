import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type CloneRequest, processContentGit } from "../src/content/git";
import { anonymousGitHub } from "../src/content/github";
import { installContent, planContentInstall } from "../src/content/install";
import { publishNewCheckout } from "../src/content/materialize";
import { type ContentStep, contentScope } from "../src/content/model";
import { contentStatus } from "../src/content/status";
import type { MachineBinding } from "../src/folder/machine-binding";
import { renderManual } from "../src/folder/manual";
import { presetProfile } from "../src/folder/presets";
import { renderInstructions } from "../src/folder/render";
import { toolPrompt } from "../src/tools/catalog";
import { githubRefusalText } from "../src/tools/github-gate";
import { runTool, type ToolRunner } from "../src/tools/status";
import {
  publicGithubLogoutText,
  publicGithubText,
  teamGithubText,
} from "../src/tools/team-github";
import { writeModule } from "./fixtures/catalog-folder";
import {
  alphaRemotes,
  contentHost,
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
  writeOrganizationRoot,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";

// Decision F55's addendum of 2026-10-17 (root decision 0204 point 5, plan
// DEV-6668): a public Environment has no GitHub identity at all, neither a
// broker nor an App nor a person's sign-in. Its content install reads its
// Organization's root and public modules anonymously, as a reader: no gh
// account, no read of GitHub's API, every clone over anonymous HTTPS with no
// credential helper, and nothing created, granted or pushed. Its texts say
// so instead of Lazurio for GitHub. Real git over local bare repositories,
// a stub GitHub that records every question, synthetic names only.
const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const summary = (steps: ContentStep[]) =>
  steps
    .filter((step) => step.state !== "running")
    .map(
      (step) => `${step.key}:${step.state}${step.code ? `:${step.code}` : ""}`,
    );

/** A public Environment of the Organization `organization` (a lowercase
 * slug, as the handover records it), on a Team Environment as try-01 is or
 * on a work Environment of one operator. */
function publicBinding(
  organization: string,
  of: "team" | "operator" = "team",
): MachineBinding {
  const base =
    of === "team" ? bindings.teamPublic : bindings.organizationPublic;
  if (base.owner.kind !== "organization") throw new Error("Wrong fixture");
  return { ...base, owner: { ...base.owner, organization } };
}

/** The world's git configuration, with github.com over HTTPS reaching the
 * same bare repositories as SSH does (`insteadOf`, as an operator may). */
function httpsGitEnv(target: World): Record<string, string> {
  const env: Record<string, string> = { ...target.gitEnv };
  const index = Number(env.GIT_CONFIG_COUNT ?? "0");
  env[`GIT_CONFIG_KEY_${index}`] = `url.${target.remotes}/.insteadOf`;
  env[`GIT_CONFIG_VALUE_${index}`] = "https://github.com/";
  env.GIT_CONFIG_COUNT = String(index + 1);
  return env;
}

/** The content host over the stub GitHub, with the product's own git
 * reaching the world over HTTPS too, and every clone request recorded. */
function anonymousHost(
  target: World,
  github: ReturnType<typeof stubGitHub>["github"],
  /** Runs after each clone, before the install goes on. */
  afterClone: (request: CloneRequest) => Promise<void> = async () => {},
) {
  const host = contentHost(target, github);
  const git = processContentGit({
    path: Bun.env.PATH,
    home: target.home,
    platform: process.platform,
    run: runTool,
    env: httpsGitEnv(target),
  });
  const clones: CloneRequest[] = [];
  return {
    ...host,
    git: {
      ...git,
      clone: async (request: CloneRequest) => {
        clones.push(request);
        const answer = await git.clone(request);
        await afterClone(request);
        return answer;
      },
    },
    clones,
  };
}

/** No temporary sibling of this operation under `directory`. */
const leftovers = async (directory: string) =>
  (await readdir(directory)).filter((name) =>
    name.includes(".lazurio-content-"),
  );

// ---- The scope ---------------------------------------------------------------

test("audience public: any preset holds its own Organization only, anonymously, and never a Personalspace; without the member nothing changes", async () => {
  for (const [preset, machine] of [
    ["hosted-organization-team", bindings.teamPublic],
    ["hosted-organization-personal", bindings.organizationPublic],
  ] as const)
    expect(contentScope(preset, machine)).toEqual({
      allowed: true,
      organizations: { only: "example" },
      personalspace: false,
      personalOwner: null,
      github: "anonymous",
    });
  // The brokered Team Environment stays prepared by the hosting, and a work
  // Environment keeps its own sign-in: the member decides, not the preset.
  expect(
    contentScope("hosted-organization-team", bindings.assignedTeam),
  ).toEqual({ allowed: false, reason: "prepared-by-hosting" });
  const work = contentScope(
    "hosted-organization-personal",
    bindings.organizationEntry,
  );
  expect(work).toEqual({
    allowed: true,
    organizations: { only: "example" },
    personalspace: false,
    personalOwner: null,
  });
  expect(Object.hasOwn(work, "github")).toBe(false);
});

posixTest(
  "a public Environment refuses a Personalspace and lists its Organization without asking GitHub",
  async () => {
    world = await createWorld();
    const folder = await presetFolder(
      world,
      "hosted-organization-team",
      publicBinding("alpha"),
    );
    const { github, calls } = stubGitHub(world, {
      viewer: { kind: "signed-out" },
    });
    const host = anonymousHost(world, github);
    expect(
      await planContentInstall(
        folder,
        { items: [{ kind: "personalspace" }] },
        host,
      ),
    ).toEqual({ kind: "not-allowed", reason: "not-for-this-environment" });
    expect(await contentStatus(folder, host)).toEqual({
      allowed: true,
      items: [{ kind: "organization", login: "alpha", state: "absent" }],
    });
    expect(calls).toEqual([]);
  },
  30_000,
);

// ---- The install ---------------------------------------------------------------

posixTest(
  "a public Team Environment installs the root and its public modules anonymously as a reader: no gh, no GitHub API, no credential helper, nothing created or pushed",
  async () => {
    world = await createWorld();
    await alphaRemotes(world);
    const folder = await presetFolder(
      world,
      "hosted-organization-team",
      publicBinding("alpha"),
    );
    // gh signed out, as on try-01; the stub records every question.
    const { github, calls, grants } = stubGitHub(world, {
      viewer: { kind: "signed-out" },
    });
    const host = anonymousHost(world, github);
    const steps: ContentStep[] = [];
    // The CLI's `--role reader --root Alpha/alpha_GEN3`.
    const result = await installContent(
      folder,
      { roots: { alpha: "Alpha/alpha_GEN3" }, roles: { alpha: "reader" } },
      (step) => steps.push(step),
      host,
    );
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    if (result.kind !== "content-install") return;
    expect(summary(steps)).toEqual([
      "access:done",
      "root:done",
      "modules:done",
      "preparation:done",
      "check:done",
    ]);
    expect(
      steps.find((step) => step.key === "access" && step.state === "done")
        ?.detail,
    ).toBe(
      "anonymously (reader, restricted slots excluded); root Alpha/alpha_GEN3 (named)",
    );
    const outcome = result.items[0];
    expect(outcome?.role).toBe("reader");
    expect(outcome?.repository).toBe("Alpha/alpha_GEN3");
    expect(outcome?.directory).toBe("organizations/alpha_GEN3");
    expect(
      Object.fromEntries(
        (outcome?.repositories ?? []).map((entry) => [
          entry.path,
          `${entry.result}${entry.reason === undefined ? "" : `:${entry.reason}`}`,
        ]),
      ),
    ).toEqual({
      infra: "excluded",
      "mission-control": "materialized",
      "mission-control/db": "excluded",
      "productionspace/firmware": "materialized",
      // Declared, but anonymous Git cannot read it: reported, not a failure
      // of the Organization.
      "workspace/docs": "failed:clone-failed",
      "workspace/odd": "blocked:access-classification-unknown",
      "workspace/planned": "no-repository",
      // A reader's scope: the restricted slot and what is below it.
      "workspace/secret": "excluded_by_role_scope",
      "workspace/secret/db": "excluded_by_role_scope",
      "workspace/web": "materialized",
    });
    const root = join(folder, "organizations", "alpha_GEN3");
    for (const path of [
      "workspace/web",
      "mission-control",
      "productionspace/firmware",
    ])
      expect(await exists(join(root, path, ".git"))).toBe(true);
    for (const path of ["workspace/docs", "workspace/secret", "infra"])
      expect(await exists(join(root, path))).toBe(false);
    // Every clone: anonymous HTTPS of github.com and git's empty helper, which
    // resets every configured one; never gh's `auth git-credential`.
    expect(host.clones.map((clone) => clone.url).sort()).toEqual([
      "https://github.com/Alpha/alpha_GEN3.git",
      "https://github.com/Alpha/docs.git",
      "https://github.com/Alpha/firmware.git",
      "https://github.com/Alpha/mission-control.git",
      "https://github.com/Alpha/web.git",
    ]);
    for (const clone of host.clones) expect(clone.credentialHelper).toBe("");
    // The checkouts' origin is that anonymous remote.
    expect(await host.git.inspect(root)).toMatchObject({
      kind: "checkout",
      repository: "Alpha/alpha_GEN3",
      branch: "main",
    });
    // GitHub was asked nothing: no viewer, no repository, no membership, no
    // declaration, and nothing created, generated or granted.
    expect(calls).toEqual([]);
    expect(grants).toEqual([]);
    // The modules it cloned are prepared, as anywhere.
    expect(host.prepared.sort()).toEqual([
      "alpha/mission-control",
      "alpha/web",
    ]);
    for (const directory of [
      join(folder, "organizations"),
      root,
      join(root, "workspace"),
      join(root, "productionspace"),
    ])
      expect(await leftovers(directory)).toEqual([]);
    // A second install finds it present: nothing is cloned or asked.
    const again: ContentStep[] = [];
    const before = host.clones.length;
    const second = await installContent(
      folder,
      {},
      (step) => again.push(step),
      host,
    );
    expect(second.kind === "content-install" && second.state).toBe("succeeded");
    expect(summary(again)).toEqual([
      "access:done",
      "root:done",
      "modules:done",
      "preparation:skipped",
      "check:done",
    ]);
    // Only the child anonymous Git could not read is tried again.
    expect(host.clones.slice(before).map((clone) => clone.url)).toEqual([
      "https://github.com/Alpha/docs.git",
    ]);
    expect(calls).toEqual([]);
  },
  90_000,
);

/** An Organization `<login>` (lowercase, as a handover names it) whose root
 * `<login>/<login>_GEN3` declares `root` its root, with one module `web`. */
async function lowercaseOrganization(
  target: World,
  login: string,
  root = `${login}/${login}_GEN3`,
) {
  await remoteRepository(target, `${login}/${login}_GEN3`, (directory) =>
    writeOrganizationRoot(directory, {
      slug: login,
      forge: login,
      root,
      slots: [
        {
          path: "workspace/web",
          slug: "web",
          git: { url: `git@github.com:${login}/web.git`, branch: "main" },
        },
      ],
    }),
  );
  await remoteRepository(target, `${login}/web`, (directory) =>
    writeModule(directory, login, { id: "web" }),
  );
}

posixTest(
  "the Launchpad's install of a public Environment takes the name candidate, verified in the clone",
  async () => {
    world = await createWorld();
    await lowercaseOrganization(world, "beta");
    const folder = await presetFolder(
      world,
      "hosted-organization-team",
      publicBinding("beta"),
    );
    const { github, calls } = stubGitHub(world, {
      viewer: { kind: "signed-out" },
    });
    const host = anonymousHost(world, github);
    const steps: ContentStep[] = [];
    // No role and no root: what the Launchpad's button asks.
    const result = await installContent(
      folder,
      {},
      (step) => steps.push(step),
      host,
    );
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    expect(
      steps.find((step) => step.key === "access" && step.state === "done")
        ?.detail,
    ).toBe(
      "anonymously (reader, restricted slots excluded); root beta/beta_GEN3 (by name)",
    );
    expect(
      await exists(
        join(folder, "organizations", "beta_GEN3", "workspace", "web", ".git"),
      ),
    ).toBe(true);
    expect(calls).toEqual([]);
  },
  60_000,
);

posixTest(
  "a public Environment installs only as a reader: any other role fails closed before anything is cloned",
  async () => {
    world = await createWorld();
    await lowercaseOrganization(world, "beta");
    for (const role of ["admin", "steward", "builder"] as const) {
      const folder = await presetFolder(
        world,
        "hosted-organization-team",
        publicBinding("beta"),
      );
      const { github, calls } = stubGitHub(world, {
        viewer: { kind: "signed-out" },
      });
      const host = anonymousHost(world, github);
      const steps: ContentStep[] = [];
      const result = await installContent(
        folder,
        { roles: { beta: role } },
        (step) => steps.push(step),
        host,
      );
      expect(summary(steps)).toEqual(["access:failed:role-unverified"]);
      expect(result.kind === "content-install" && result.failure?.detail).toBe(
        `the role ${role} in beta could not be verified: this public Environment has no GitHub identity and installs only as a reader${role === "admin" ? "; name it with --role reader" : ""}`,
      );
      expect(await readdir(join(folder, "organizations"))).toEqual([]);
      expect(host.clones).toEqual([]);
      expect(calls).toEqual([]);
    }
  },
  60_000,
);

posixTest(
  "on a public Environment a root anonymous Git cannot read, or one that names another root, stops at root with its reason and leaves nothing behind",
  async () => {
    world = await createWorld();
    // `delta/delta_GEN3` declares another repository its root.
    await lowercaseOrganization(world, "delta", "delta/elsewhere");
    for (const [login, code] of [
      // No such repository, or a private one: the anonymous clone fails.
      ["gamma", "clone-failed"],
      ["delta", "root-declaration-mismatch"],
    ] as const) {
      const folder = await presetFolder(
        world,
        "hosted-organization-team",
        publicBinding(login),
      );
      const { github, calls } = stubGitHub(world, {
        viewer: { kind: "signed-out" },
      });
      const host = anonymousHost(world, github);
      const steps: ContentStep[] = [];
      const result = await installContent(
        folder,
        {},
        (step) => steps.push(step),
        host,
      );
      expect(result.kind === "content-install" && result.state).toBe("failed");
      expect(summary(steps)).toEqual(["access:done", `root:failed:${code}`]);
      expect(result.kind === "content-install" && result.failure).toEqual({
        item: { kind: "organization", login },
        key: "root",
        code,
        detail:
          code === "clone-failed"
            ? "git clone failed; GitHub access or the network refused it"
            : "the root's declaration names another Organization or root repository",
      });
      // Nothing published, no temporary sibling, nothing of GitHub asked.
      expect(await readdir(join(folder, "organizations"))).toEqual([]);
      expect(calls).toEqual([]);
      expect(host.clones.map((clone) => clone.credentialHelper)).toEqual([""]);
    }
  },
  60_000,
);

// ---- The root's name: as its own declaration spells it -----------------------

/** An Organization whose handover names it by the lowercase slug `gamma`
 * while GitHub, and its own declaration, spell it `Gamma`: the root
 * `Gamma/Gamma_GEN3` (reached at the lowercase URL, as GitHub serves any
 * letter case), one module and one Production Space repository whose slot
 * path keeps a capital letter. */
async function mixedCaseOrganization(target: World) {
  await remoteRepository(target, "gamma/gamma_GEN3", (directory) =>
    writeOrganizationRoot(directory, {
      slug: "gamma",
      forge: "Gamma",
      root: "Gamma/Gamma_GEN3",
      slots: [
        {
          path: "workspace/web",
          slug: "web",
          git: { url: "git@github.com:Gamma/web.git", branch: "main" },
        },
        {
          path: "productionspace/Firmware",
          slug: "firmware",
          git: { url: "git@github.com:Gamma/Firmware.git", branch: "main" },
        },
      ],
    }),
  );
  await remoteRepository(target, "Gamma/web", (directory) =>
    writeModule(directory, "gamma", { id: "web" }),
  );
  await remoteRepository(target, "Gamma/Firmware", (directory) =>
    writeFile(join(directory, "README.md"), "firmware"),
  );
}

posixTest(
  "a public Environment publishes its root under the name its own declaration spells, not the handover's lowercase slug; children keep their declared paths",
  async () => {
    world = await createWorld();
    await mixedCaseOrganization(world);
    const folder = await presetFolder(
      world,
      "hosted-organization-team",
      publicBinding("gamma"),
    );
    const { github, calls } = stubGitHub(world, {
      viewer: { kind: "signed-out" },
    });
    const host = anonymousHost(world, github);
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      {},
      (step) => steps.push(step),
      host,
    );
    expect(result.kind === "content-install" && result.state).toBe("succeeded");
    // The request knows only the slug; the published directory is the
    // declaration's spelling, as every member's install names it.
    expect(
      steps.find((step) => step.key === "access" && step.state === "done")
        ?.detail,
    ).toBe(
      "anonymously (reader, restricted slots excluded); root gamma/gamma_GEN3 (by name)",
    );
    expect(
      steps.find((step) => step.key === "root" && step.state === "done")
        ?.detail,
    ).toMatch(/^materialized organizations\/Gamma_GEN3 at [0-9a-f]{12}$/);
    expect(await readdir(join(folder, "organizations"))).toEqual([
      "Gamma_GEN3",
    ]);
    expect(
      result.kind === "content-install" && result.items[0]?.directory,
    ).toBe("organizations/Gamma_GEN3");
    // The children come from the manifest's slot paths, as declared.
    const root = join(folder, "organizations", "Gamma_GEN3");
    expect(await readdir(join(root, "productionspace"))).toEqual(["Firmware"]);
    expect(await exists(join(root, "workspace", "web", ".git"))).toBe(true);
    expect(calls).toEqual([]);
    // A second install finds the root the Folder holds, under that name.
    const again: ContentStep[] = [];
    await installContent(folder, {}, (step) => again.push(step), host);
    expect(
      again.find((step) => step.key === "root" && step.state === "done")
        ?.detail,
    ).toBe("present at organizations/Gamma_GEN3");
    expect(await readdir(join(folder, "organizations"))).toEqual([
      "Gamma_GEN3",
    ]);
  },
  60_000,
);

posixTest(
  "an entry in another letter case that appears during the root's clone stays untouched, and nothing is published beside it",
  async () => {
    world = await createWorld();
    await mixedCaseOrganization(world);
    const folder = await presetFolder(
      world,
      "hosted-organization-team",
      publicBinding("gamma"),
    );
    const { github } = stubGitHub(world, { viewer: { kind: "signed-out" } });
    const occupant = join(folder, "organizations", "gamma_GEN3");
    // While the root is cloned, someone makes the slug's directory: a
    // different path from the final name on a case-sensitive filesystem.
    const host = anonymousHost(world, github, async (request) => {
      if (request.url.endsWith("/gamma_GEN3.git")) {
        await mkdir(occupant);
        await writeFile(join(occupant, "mine.txt"), "someone's work");
      }
    });
    const steps: ContentStep[] = [];
    const result = await installContent(
      folder,
      {},
      (step) => steps.push(step),
      host,
    );
    expect(summary(steps)).toEqual([
      "access:done",
      "root:failed:destination-occupied",
    ]);
    expect(result.kind === "content-install" && result.state).toBe("failed");
    expect(await readdir(join(folder, "organizations"))).toEqual([
      "gamma_GEN3",
    ]);
    expect(await readdir(occupant)).toEqual(["mine.txt"]);
  },
  60_000,
);

posixTest(
  "a final name differs from the requested one by letter case only, or nothing is published",
  async () => {
    world = await createWorld();
    const parent = join(world.root, "parent");
    await mkdir(parent);
    for (const name of ["other_GEN3", "gamma_GEN3/x", ".Gamma_GEN3"]) {
      const result = await publishNewCheckout({
        parent,
        name: "gamma_GEN3",
        fill: async (checkout) => {
          await mkdir(checkout);
          return { kind: "ready", value: null, name };
        },
      });
      expect(result).toEqual({ kind: "failed", code: "destination-invalid" });
      expect(await readdir(parent)).toEqual([]);
    }
  },
  30_000,
);

// ---- git: no credential helper answers an anonymous clone ---------------------

test("git runs an anonymous clone with every credential helper reset and none added; gh's clone is as before", async () => {
  const commands: (readonly string[])[] = [];
  const run: ToolRunner = async (command) => {
    commands.push(command);
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  const git = processContentGit({
    path: Bun.env.PATH,
    home: "/home/operator",
    platform: process.platform,
    run,
    env: {},
  });
  // What the last clone was given before its subcommand.
  const settings = () => {
    const command = commands.at(-1) ?? [];
    expect(command).toContain("clone");
    return command.slice(1, command.indexOf("clone"));
  };
  const remote = anonymousGitHub.remote("Alpha/web");
  expect(remote).toEqual({
    url: "https://github.com/Alpha/web.git",
    credentialHelper: "",
  });
  await git.clone({
    url: remote.url,
    directory: "/tmp/x",
    branch: "main",
    credentialHelper: remote.credentialHelper,
  });
  expect(settings()).toEqual(["-c", "credential.helper="]);
  await git.clone({
    url: "https://github.com/Alpha/web.git",
    directory: "/tmp/x",
    branch: "main",
    credentialHelper: '!"/usr/bin/gh" auth git-credential',
  });
  expect(settings()).toEqual([
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    'credential.https://github.com.helper=!"/usr/bin/gh" auth git-credential',
  ]);
  await git.clone({
    url: "git@github.com:Alpha/web.git",
    directory: "/tmp/x",
    branch: "main",
  });
  expect(settings()).toEqual([]);
  expect(() => anonymousGitHub.remote("not a repository")).toThrow();
});

posixTest(
  "a credential helper the operator's configuration names never answers an anonymous clone, even behind a rewritten URL",
  async () => {
    world = await createWorld();
    const marker = join(world.root, "helper-asked");
    const helper = join(world.root, "helper.sh");
    await writeFile(helper, `#!/bin/sh\necho asked >> "${marker}"\n`);
    await chmod(helper, 0o700);
    // GitHub as it answers a repository anonymous Git cannot read.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="GitHub"' },
        }),
    });
    try {
      const env = {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: helper,
        GIT_CONFIG_KEY_1: `url.http://127.0.0.1:${server.port}/.insteadOf`,
        GIT_CONFIG_VALUE_1: "https://github.com/",
      };
      const git = processContentGit({
        path: Bun.env.PATH,
        home: world.home,
        platform: process.platform,
        run: runTool,
        env,
      });
      const remote = anonymousGitHub.remote("Alpha/private");
      expect(
        await git.clone({
          url: remote.url,
          directory: join(world.root, "anonymous"),
          branch: "main",
          credentialHelper: remote.credentialHelper,
        }),
      ).toBe("failed");
      expect(await exists(marker)).toBe(false);
      // The control: without the reset the configured helper is asked.
      expect(
        await git.clone({
          url: remote.url,
          directory: join(world.root, "configured"),
          branch: "main",
        }),
      ).toBe("failed");
      expect(await exists(marker)).toBe(true);
    } finally {
      server.stop(true);
    }
  },
  30_000,
);

// ---- The texts -------------------------------------------------------------------

test("a public Environment's agents' texts say it has no GitHub identity, reads anonymously and publishes nothing; a Team's keep Lazurio for GitHub", () => {
  const render = (
    machine: MachineBinding,
    preset: "hosted-organization-team" | "hosted-organization-personal",
    locale: "cs" | "en",
  ) => {
    const source = {
      preset,
      machine,
      profile: presetProfile(preset, "linux", { locale }),
      tools: [],
      toolNotes: {},
    };
    return {
      agents: renderInstructions(source),
      manual: Object.values(renderManual(source)).join("\n"),
    };
  };
  const expected = {
    en: [
      "- Identity: no GitHub identity. This Environment is public: it reads the Organization's public repositories anonymously and nothing is published from here.",
      "- GitHub: this Environment has no GitHub identity. It reads the Organization's public repositories anonymously and nothing is published from here: no push, pull request or issue. Sign nobody in to GitHub.",
    ],
    cs: [
      "- Identita: žádná identita GitHubu. Tento Environment je veřejný: veřejné repozitáře Organizace čte anonymně a nic se odsud nepublikuje.",
      "- GitHub: tento Environment nemá žádnou identitu GitHubu. Veřejné repozitáře Organizace čte anonymně a nic se odsud nepublikuje: žádný push, pull request ani issue. Nikoho ke GitHubu nepřihlašuj.",
    ],
  };
  const publication = {
    en: "**In a public Environment** you have no GitHub identity: you only read the Organization's public repositories anonymously and publish nothing from here, no push, pull request or issue, also where another rule here asks for one.",
    cs: "**Na veřejném Environmentu** nemáš na GitHubu žádnou identitu: veřejné repozitáře Organizace jen čteš anonymně a nic odsud nepublikuješ, žádný push, pull request ani issue, ani tam, kde o ně žádá jiné pravidlo tady.",
  };
  const draft = {
    en: "- Your work is a Draft in a worktree. Nothing is published from this public Environment: no push, pull request, issue or merge, also where another rule here asks for one.",
    cs: "- Tvoje práce je Draft ve worktree. Z tohoto veřejného Environmentu se nic nepublikuje: žádný push, pull request, issue ani merge, ani tam, kde o ně žádá jiné pravidlo tady.",
  };
  // What a Team's texts say about its GitHub identity and its ways to
  // propose a change or ask for a right, none of which a public one has.
  const teamOnly = {
    en: [
      "On GitHub you act as the brokered Organization identity",
      "check live whether the Team's identity may push to it",
      "file an issue for them in the Organization's root repository",
      "## A repository you only read: propose the change in an issue",
    ],
    cs: [
      "Na GitHubu jednáš jako brokerovaná identita Organizace",
      "ověř živě, jestli do něj identita Teamu smí pushovat",
      "zapiš mu issue do kořenového repozitáře Organizace",
      "## Repozitář, který jen čteš: změnu navrhni v issue",
    ],
  };
  for (const locale of ["en", "cs"] as const) {
    for (const [preset, machine] of [
      ["hosted-organization-team", bindings.teamPublic],
      ["hosted-organization-personal", bindings.organizationPublic],
    ] as const) {
      const { agents, manual } = render(machine, preset, locale);
      for (const line of expected[locale]) {
        expect(agents).toContain(line);
        expect(manual).toContain(line);
      }
      expect(manual).toContain(publication[locale]);
      expect(agents).toContain(draft[locale]);
      // The preset's own meaning stays, with what the public Environment
      // changes of it.
      expect(manual).toContain(
        locale === "en"
          ? "This Environment, though, is public (root decision 0204): its visitors share it and it has no GitHub identity, neither a brokered nor a personal one."
          : "Tento Environment je ale veřejný (root decision 0204): sdílí ho jeho návštěvníci a nemá žádnou identitu GitHubu, ani brokerovanou, ani osobní.",
      );
      for (const text of [agents, manual]) {
        expect(text).not.toContain("Lazurio for GitHub");
        for (const line of teamOnly[locale]) expect(text).not.toContain(line);
      }
    }
    // Without the member the Team Environment is as it was.
    const team = render(bindings.teamEntry, "hosted-organization-team", locale);
    expect(team.agents).toContain("(Lazurio for GitHub)");
    expect(team.manual).toContain("(Lazurio for GitHub)");
    const both = `${team.agents}\n${team.manual}`;
    for (const line of teamOnly[locale]) expect(both).toContain(line);
    for (const line of [...expected[locale], draft[locale]])
      expect(both).not.toContain(line);
  }
});

test("a public Environment's gh prompt and refusals say there is no GitHub identity; the Team's refusal itself is unchanged", () => {
  for (const locale of ["en", "cs"] as const) {
    const prompt = toolPrompt("gh", locale, {
      team: true,
      audience: "public",
    }) as string;
    expect(prompt).toContain(
      locale === "en"
        ? "This Environment has no GitHub identity: it reads the Organization's public repositories anonymously and nothing is published from here."
        : "Toto Prostředí nemá žádnou identitu GitHubu: veřejné repozitáře Organizace čte anonymně a nic se odsud nepublikuje.",
    );
    expect(prompt).not.toContain("Lazurio for GitHub");
    expect(prompt).not.toContain("gh auth login");
    // The same on a public Environment of one operator, whose gh would
    // otherwise be signed in.
    expect(toolPrompt("gh", locale, { audience: "public" })).toBe(prompt);
    // Without it, the Team's prompt.
    expect(toolPrompt("gh", locale, { team: true })).toContain(
      "Lazurio for GitHub",
    );
    // A tool without a public target state keeps its prompt.
    expect(toolPrompt("composio", locale, { audience: "public" })).toBe(
      toolPrompt("composio", locale),
    );
    const login = {
      kind: "blocked",
      reason: "team-environment",
      tool: "gh",
      action: "login",
    } as const;
    expect(githubRefusalText(login, locale, "public")).toBe(
      publicGithubText[locale],
    );
    expect(
      githubRefusalText({ ...login, action: "logout" }, locale, "public"),
    ).toBe(`${publicGithubText[locale]} ${publicGithubLogoutText[locale]}`);
    expect(githubRefusalText(login, locale)).toBe(teamGithubText[locale]);
  }
  // Czech for people: Prostředí, Organizace, toto, no Lazurio for GitHub.
  expect(publicGithubText.cs).toBe(
    "Toto Prostředí je veřejné a nemá žádnou identitu GitHubu. Veřejné repozitáře Organizace čte anonymně a nic se odsud nepublikuje. Účty GitHubu se tady nepřihlašují.",
  );
});
