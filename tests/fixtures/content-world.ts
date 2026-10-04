import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processContentGit } from "../../src/content/git";
import type {
  ContentGitHub,
  GitHubRepository,
  ViewerAnswer,
} from "../../src/content/github";
import type { ContentHost, PreparationAnswer } from "../../src/content/host";
import { contentLockDirectory } from "../../src/content/host";
import type { MembershipAnswer } from "../../src/content/role";
import {
  initializeFolder,
  initializeHandoverFolder,
} from "../../src/folder/initialize-folder";
import type { MachineBinding } from "../../src/folder/machine-binding";
import { executionOs } from "../../src/folder/platform";
import {
  type PresetName,
  presetProfile,
  workspacePreset,
} from "../../src/folder/presets";
import { expectedLegacyProjection } from "../../src/organizations/legacy-projection";
import { runTool } from "../../src/tools/status";
import { canonicalDocument, type Slot, writeModule } from "./catalog-folder";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./owned-files";

// The world of content installation without a network (synthetic names
// only): bare repositories under `<world>/remotes/<Owner>/<Repo>.git` reached
// as `git@github.com:<Owner>/<Repo>.git` through git's own `insteadOf`
// (given as GIT_CONFIG_* in git's environment, as an operator may), a stub
// of the GitHub side, and Folders of every preset. The product's git adapter
// runs for real.

export type World = Readonly<{
  root: string;
  remotes: string;
  home: string;
  gitEnv: Readonly<Record<string, string>>;
  lockDirectory: string;
  close(): Promise<void>;
}>;

export async function createWorld(): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "content-")));
  const remotes = join(root, "remotes");
  const home = join(root, "home");
  await mkdir(remotes);
  await mkdir(home);
  return Object.freeze({
    root,
    remotes,
    home,
    gitEnv: Object.freeze({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "git@github.com:",
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "always",
    }),
    lockDirectory: contentLockDirectory(join(home, "base")),
    close: () => rm(root, { recursive: true, force: true }),
  });
}

async function git(cwd: string, ...args: string[]) {
  const process = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
    },
  );
  const [error, code] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${error}`);
}

/** A bare repository `<owner>/<name>` whose `main` holds what `write` puts
 * in its working tree. Returns the bare repository's path. */
export async function remoteRepository(
  world: World,
  fullName: string,
  write: (directory: string) => Promise<void>,
): Promise<string> {
  const [owner, name] = fullName.split("/") as [string, string];
  const bare = join(world.remotes, owner, `${name}.git`);
  await mkdir(join(world.remotes, owner), { recursive: true });
  await git(world.remotes, "init", "--quiet", "--bare", bare);
  const work = await mkdtemp(join(world.root, "work-"));
  await git(work, "init", "--quiet");
  await write(work);
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  await git(work, "push", "--quiet", bare, "HEAD:refs/heads/main");
  await rm(work, { recursive: true, force: true });
  return bare;
}

/** The documents of an Organization root (and nothing else) in `directory`. */
export async function writeOrganizationRoot(
  directory: string,
  options: {
    slug: string;
    forge: string;
    slots: Slot[];
    root?: string;
    kind?: "organization" | "template";
  },
) {
  const inventory = {
    company: options.slug,
    github_org: options.forge,
    module_slots: options.slots,
  };
  const document: Record<string, unknown> &
    ReturnType<typeof canonicalDocument> = canonicalDocument(
    options.slug,
    options.kind ?? "organization",
    [],
    options.forge,
  );
  if (options.root !== undefined)
    document.root_repository = {
      forge: "github",
      locator: options.root,
      default_branch: "main",
      binding_state: "unverified",
    };
  const expected = expectedLegacyProjection(document, inventory);
  document.compatibility.legacy_projection.sha256 = expected.hash;
  await writeFile(
    join(directory, "lazurio.organization.json"),
    JSON.stringify(document),
  );
  await writeFile(
    join(directory, "modules.manifest.json"),
    JSON.stringify(inventory),
  );
  await writeFile(
    join(directory, ".gitignore"),
    "workspace/\nproductionspace/\n",
  );
}

/** The fixture Organization `alpha` (GitHub login `Alpha`, root
 * `Alpha/alpha_GEN3`) with every kind of declared child. */
export const alphaSlots: Slot[] = [
  {
    path: "workspace/web",
    slug: "web",
    git: { url: "git@github.com:Alpha/web.git", branch: "main" },
  },
  {
    path: "workspace/docs",
    slug: "docs",
    git: { url: "https://github.com/Alpha/docs.git", branch: "main" },
  },
  {
    path: "mission-control",
    slug: "mission-control",
    git: { url: "git@github.com:Alpha/mission-control.git", branch: "main" },
  },
  {
    path: "mission-control/db",
    slug: "mission-control-db",
    git: { url: "git@github.com:Alpha/mission-control-data.git" },
  },
  {
    path: "infra",
    slug: "infra",
    git: { url: "git@github.com:Alpha/infra.git", branch: "main" },
  },
  {
    path: "productionspace/firmware",
    slug: "firmware",
    git: { url: "git@github.com:Alpha/firmware.git", branch: "main" },
  },
  {
    path: "workspace/secret",
    slug: "secret",
    default_access: "restricted",
    git: { url: "git@github.com:Alpha/secret.git", branch: "main" },
  },
  // A repository database below the restricted slot: out of the install
  // anyway, and out of a Builder's or Steward's scope as a descendant.
  {
    path: "workspace/secret/db",
    git: { url: "git@github.com:Alpha/secret-data.git" },
  },
  // An access mode no one declared: never materialized, for any role.
  {
    path: "workspace/odd",
    slug: "odd",
    default_access: "everyone",
    git: { url: "git@github.com:Alpha/odd.git", branch: "main" },
  },
  { path: "workspace/planned", slug: "planned" },
];

/** The remote repositories of `alpha`; `docs` is declared but this identity
 * cannot read it (the stub answers 404). */
export async function alphaRemotes(
  world: World,
  root: Partial<Parameters<typeof writeOrganizationRoot>[1]> = {},
) {
  await remoteRepository(world, "Alpha/alpha_GEN3", (directory) =>
    writeOrganizationRoot(directory, {
      slug: "alpha",
      forge: "Alpha",
      slots: alphaSlots,
      root: "Alpha/alpha_GEN3",
      ...root,
    }),
  );
  for (const id of ["web", "mission-control"])
    await remoteRepository(world, `Alpha/${id}`, (directory) =>
      writeModule(directory, "alpha", { id }),
    );
  for (const name of ["firmware", "infra", "secret", "mission-control-data"])
    await remoteRepository(world, `Alpha/${name}`, (directory) =>
      writeFile(join(directory, "README.md"), name),
    );
}

export type StubCalls = { kind: string; args: readonly string[] }[];

/** The GitHub side: the viewer, which repositories it can read (anything
 * not named is 404), the account's template-derived repositories, and a
 * generation that creates the repository among the remotes. */
export function stubGitHub(
  world: World,
  options: {
    viewer?: ViewerAnswer;
    repositories?: Record<string, Partial<GitHubRepository> | "unavailable">;
    derived?: readonly string[] | "unavailable";
    generate?: "private" | "public" | "failed";
    gate?: Promise<void>;
    /** The viewer's membership in every Organization asked; by default an
     * active Owner's. */
    membership?: MembershipAnswer;
    /** The Organization's repository listing fails. */
    listing?: "unavailable";
  } = {},
) {
  const calls: StubCalls = [];
  const known = new Map<string, Partial<GitHubRepository> | "unavailable">();
  const names = new Map<string, string>();
  for (const [name, entry] of Object.entries(options.repositories ?? {})) {
    known.set(name.toLowerCase(), entry);
    names.set(name.toLowerCase(), name);
  }
  const viewer: ViewerAnswer = options.viewer ?? {
    kind: "signed-in",
    viewer: { login: "example", databaseId: 12345 },
  };
  const github: ContentGitHub = {
    async viewer() {
      calls.push({ kind: "viewer", args: [] });
      await options.gate;
      return viewer;
    },
    async repository(owner, name) {
      calls.push({ kind: "repository", args: [owner, name] });
      const entry = known.get(`${owner}/${name}`.toLowerCase());
      if (entry === undefined) return { kind: "missing" };
      if (entry === "unavailable") return { kind: "unavailable" };
      return {
        kind: "observed",
        repository: {
          // As GitHub spells it, whatever case was asked.
          fullName:
            names.get(`${owner}/${name}`.toLowerCase()) ?? `${owner}/${name}`,
          owner: { login: owner, databaseId: 1, kind: "Organization" },
          private: true,
          archived: false,
          readable: true,
          permission: "admin",
          ...entry,
        },
      };
    },
    async membership(organization) {
      calls.push({ kind: "membership", args: [organization] });
      return (
        options.membership ?? { kind: "member", state: "active", role: "admin" }
      );
    },
    // The default branch's lazurio.organization.json of a readable
    // repository, read from its bare remote as GitHub would serve it.
    async declaration(owner, name) {
      calls.push({ kind: "declaration", args: [owner, name] });
      const key = `${owner}/${name}`.toLowerCase();
      const entry = known.get(key);
      if (entry === undefined) return { kind: "missing" };
      if (entry === "unavailable") return { kind: "unavailable" };
      // The bare remote by the repository's own spelling (Linux is
      // case-sensitive).
      const spelled = names.get(key) ?? `${owner}/${name}`;
      const shown = Bun.spawnSync(
        [
          "git",
          "--git-dir",
          join(world.remotes, `${spelled}.git`),
          "show",
          "HEAD:lazurio.organization.json",
        ],
        { env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin" } },
      );
      if (shown.exitCode !== 0) return { kind: "missing" };
      try {
        return { kind: "file", value: JSON.parse(shown.stdout.toString()) };
      } catch {
        return { kind: "file", value: null };
      }
    },
    async organizationRepositories(organization) {
      calls.push({ kind: "organizationRepositories", args: [organization] });
      if (options.listing === "unavailable") return "unavailable";
      return [...known.entries()]
        .filter(
          ([key, entry]) =>
            entry !== "unavailable" &&
            key.startsWith(`${organization.toLowerCase()}/`),
        )
        .map(([key]) => names.get(key) as string);
    },
    async templateDerived(template) {
      calls.push({ kind: "templateDerived", args: [template] });
      return options.derived ?? [];
    },
    async generate(template, owner, name, description) {
      calls.push({
        kind: "generate",
        args: [template, owner, name, description],
      });
      if (options.generate === "failed") return { kind: "failed" };
      await remoteRepository(world, `${owner}/${name}`, (directory) =>
        writeFile(join(directory, "personalspace.template.json"), "{}"),
      );
      const isPrivate = options.generate !== "public";
      known.set(`${owner}/${name}`.toLowerCase(), {
        private: isPrivate,
        owner: { login: owner, databaseId: 12345, kind: "User" },
      });
      return { kind: "created", private: isPrivate };
    },
    async branchReady(owner, name) {
      calls.push({ kind: "branchReady", args: [owner, name] });
      return true;
    },
    async remote(fullName) {
      return { url: `git@github.com:${fullName}.git` };
    },
  };
  return { github, calls };
}

/** A host over the stub GitHub, the real git and a recorded preparation. */
export function contentHost(
  world: World,
  github: ContentGitHub,
  prepare: (name: string) => Promise<PreparationAnswer> = async () => ({
    ok: true,
    outcome: "prepared",
  }),
): ContentHost & { prepared: string[] } {
  const prepared: string[] = [];
  return {
    github,
    git: processContentGit({
      path: Bun.env.PATH,
      home: world.home,
      platform: process.platform,
      run: runTool,
      env: world.gitEnv,
    }),
    lockDirectory: world.lockDirectory,
    prepare: async (name) => {
      prepared.push(name);
      return prepare(name);
    },
    prepared,
  };
}

/** A Folder of `preset` in the world: a workstation for `local`, otherwise
 * adopted from `machine`'s handover. */
export async function presetFolder(
  world: World,
  preset: PresetName,
  machine: MachineBinding | null = null,
): Promise<string> {
  const folder = join(
    await realpath(await mkdtemp(join(world.root, "folder-"))),
    "Lazurio",
  );
  if (preset === "local") {
    await initializeFolder(
      folder,
      presetProfile("local", executionOs(process.platform)),
    );
    return folder;
  }
  if (machine === null) throw new Error("A hosted preset needs its Machine");
  // Machines delivers the Folder with organizations/ and, where the preset
  // has one, personalspace/ (both empty).
  await mkdir(folder);
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  if (workspacePreset(preset).personalspace === "present")
    await mkdir(join(folder, "personalspace"));
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform)),
  });
  return folder;
}
