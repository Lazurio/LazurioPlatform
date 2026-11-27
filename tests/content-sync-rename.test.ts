import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { processContentGit, rewrittenOrigin } from "../src/content/git";
import type { ContentGitHub, RepositoryAnswer } from "../src/content/github";
import {
  type SyncEntry,
  type SyncHost,
  syncContent,
} from "../src/content/sync";
import {
  type MachineBinding,
  machineIdentity,
  ownerOrganizationCorrection,
} from "../src/folder/machine-binding";
import { readFolderCatalog } from "../src/organizations/catalog";
import { runTool } from "../src/tools/status";
import { type Slot, writeModule } from "./fixtures/catalog-folder";
import {
  createWorld,
  presetFolder,
  remoteRepository,
  stubGitHub,
  type World,
  writeOrganizationRoot,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import { writeOwnedFixture as writeFile } from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// A GitHub Organization renamed from `Old` to `New` (#1281): the Work
// Environment's synchronization converges on its own, in each order the
// root and the handover change, and never follows a namesake who took the
// old login. Real git over bare remotes; GitHub's redirect is a symlink of
// the old owner's directory to the new one, GitHub's API answers are the
// test's. Synthetic names only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** The Organization's immutable GitHub id; a namesake's is another. */
const organizationId = 7001;
const namesakeId = 9009;
const repositoryIds: Record<string, number> = {
  example_GEN3: 1,
  web: 2,
};

async function git(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
) {
  const result = await runChild(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
    },
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** The Work Environment's binding: its Owner Organization by `login` (in
 * lower case, as the handover names it) and, where given, by its id. */
function machine(login: string, id?: number): MachineBinding {
  const base = bindings.organization;
  if (base?.owner.kind !== "organization") throw new Error("fixture");
  return Object.freeze({
    ...base,
    owner: Object.freeze({
      ...base.owner,
      organization: login,
      ...(id === undefined ? {} : { organizationId: id }),
    }),
  });
}

const slots = (owner: string): Slot[] => [
  {
    path: "workspace/web",
    slug: "web",
    git: { url: `git@github.com:${owner}/web.git`, branch: "main" },
  },
];

const writeRoot = (owner: string) => async (directory: string) => {
  await writeOrganizationRoot(directory, {
    slug: "example",
    forge: owner,
    slots: slots(owner),
    root: `${owner}/example_GEN3`,
  });
  await writeFile(join(directory, ".gitignore"), "workspace/\n.worktrees/\n");
};

type GitHubState = "before" | "renamed" | "namesake";

/** GitHub as the test has it: before the rename `Old` owns both
 * repositories; after it `New` does and `Old/<name>` redirects to it (same
 * repository id); with a namesake, `Old` is another Organization whose
 * repositories of the same names are its own. */
function github(world: World, state: () => GitHubState): ContentGitHub {
  const answer = (
    owner: string,
    id: number,
    name: string,
    repositoryId: number,
  ): RepositoryAnswer => ({
    kind: "observed",
    repository: {
      fullName: `${owner}/${name}`,
      databaseId: repositoryId,
      owner: { login: owner, databaseId: id, kind: "Organization" },
      private: true,
      archived: false,
      readable: true,
      permission: "admin",
    },
  });
  return {
    ...stubGitHub(world).github,
    async repository(owner, name) {
      const known = repositoryIds[name];
      if (known === undefined) return { kind: "missing" };
      const now = state();
      const lower = owner.toLowerCase();
      if (now === "before")
        return lower === "old"
          ? answer("Old", organizationId, name, known)
          : { kind: "missing" };
      if (lower === "new") return answer("New", organizationId, name, known);
      if (lower !== "old") return { kind: "missing" };
      return now === "renamed"
        ? answer("New", organizationId, name, known)
        : answer("Old", namesakeId, name, known + 100);
    },
  };
}

type Fixture = Readonly<{
  world: World;
  /** Where the root and its module are now. */
  root: () => string;
  web: () => string;
  state: { now: GitHubState };
  /** One synchronization of the Environment with its handover `binding`. */
  run: (binding: MachineBinding) => Promise<readonly SyncEntry[]>;
  origin: (directory: string) => Promise<string>;
  /** GitHub renames `Old` to `New`; `Old/…` then redirects. */
  renameOnGitHub: () => Promise<void>;
  /** The root's next commit on GitHub declares `owner`. */
  declareRoot: (owner: string) => Promise<string>;
}>;

/** A Work Environment of `Old` with its root and the module `web`,
 * installed before the rename. One Folder per handover binding, the same
 * checkouts moved into the one that runs: one Environment whose handover
 * changes. */
async function environment(): Promise<Fixture> {
  const current = await createWorld();
  world = current;
  await remoteRepository(current, "Old/example_GEN3", writeRoot("Old"));
  await remoteRepository(current, "Old/web", async (directory) => {
    await writeModule(directory, "example", { id: "web" });
    await writeFile(join(directory, ".gitignore"), ".worktrees/\n");
  });
  const state = { now: "before" as GitHubState };
  const folders = new Map<string, string>();
  const checkouts = await mkdtemp(join(current.root, "checkouts-"));
  let root = join(checkouts, "example_GEN3");
  const env = current.gitEnv;
  await git(
    checkouts,
    env,
    "clone",
    "--quiet",
    "git@github.com:Old/example_GEN3.git",
    root,
  );
  await git(
    checkouts,
    env,
    "clone",
    "--quiet",
    "git@github.com:Old/web.git",
    join(root, "workspace", "web"),
  );
  const gitHost = processContentGit({
    path: Bun.env.PATH,
    home: current.home,
    platform: process.platform,
    run: runTool,
    env,
  });
  // The catalog as the root declares it, with the Organization id its
  // verified binding records (the fixture's root is unverified).
  const readCatalog: SyncHost["readCatalog"] = async (folder) => {
    const catalog = await readFolderCatalog(folder);
    return {
      ...catalog,
      organizations: catalog.organizations.map((entry) =>
        entry.forgeLogin === undefined
          ? entry
          : { ...entry, forgeOrganizationId: organizationId },
      ),
    };
  };
  const folderFor = async (binding: MachineBinding) => {
    const key = JSON.stringify(binding.owner);
    const known = folders.get(key);
    if (known !== undefined) return known;
    const folder = await presetFolder(
      current,
      "hosted-organization-personal",
      binding,
    );
    folders.set(key, folder);
    return folder;
  };
  return {
    world: current,
    root: () => root,
    web: () => join(root, "workspace", "web"),
    state,
    async run(binding) {
      const folder = await folderFor(binding);
      const here = join(folder, "organizations", "example_GEN3");
      if (here !== root) {
        await rename(root, here);
        root = here;
      }
      const run = await syncContent(folder, {
        git: gitHost,
        github: github(current, () => state.now),
        lockDirectory: current.lockDirectory,
        readCatalog,
      });
      if (run.kind !== "content-sync") throw new Error(JSON.stringify(run));
      return run.entries;
    },
    origin: (directory) =>
      git(directory, env, "config", "--get", "remote.origin.url"),
    async renameOnGitHub() {
      await rename(join(current.remotes, "Old"), join(current.remotes, "New"));
      await symlink(join(current.remotes, "New"), join(current.remotes, "Old"));
      state.now = "renamed";
    },
    async declareRoot(owner) {
      const work = await mkdtemp(join(current.root, "advance-"));
      await git(
        current.root,
        env,
        "clone",
        "--quiet",
        "git@github.com:New/example_GEN3.git",
        work,
      );
      await writeRoot(owner)(work);
      await git(work, env, "add", "--all");
      await git(work, env, "commit", "--quiet", "-m", `declare ${owner}`);
      await git(work, env, "push", "--quiet", "origin", "HEAD:refs/heads/main");
      const commit = await git(work, env, "rev-parse", "HEAD");
      await rm(work, { recursive: true, force: true });
      return commit;
    },
  };
}

const byPath = (entries: readonly SyncEntry[]) =>
  Object.fromEntries(
    entries.map((entry) => [
      entry.path,
      entry.reason === undefined
        ? entry.result
        : `${entry.result}:${entry.reason}`,
    ]),
  );
const entryAt = (entries: readonly SyncEntry[], path: string) =>
  entries.find((entry) => entry.path === path);
const head = (fixture: Fixture, directory: string) =>
  git(directory, fixture.world.gitEnv, "rev-parse", "HEAD");

posixTest(
  "order 1, the root first: without the Organization id in the handover it is a finding and nothing changes; with it the Environment converges",
  async () => {
    const fixture = await environment();
    expect(byPath(await fixture.run(machine("old")))).toEqual({
      ".": "current",
      "workspace/web": "current",
    });
    await fixture.renameOnGitHub();
    const declared = await fixture.declareRoot("New");
    // The next hourly run before the handover changes still has the old
    // root here: it keeps syncing through GitHub's redirect, and the module
    // the new declaration names under `New` is pointed there by its id.
    const pulled = await fixture.run(machine("old"));
    expect(byPath(pulled)).toEqual({
      ".": "fast-forwarded",
      "workspace/web": "current",
    });
    expect(entryAt(pulled, "workspace/web")?.origin).toEqual({
      from: "Old/web",
      to: "New/web",
    });
    expect(await head(fixture, fixture.root())).toBe(declared);
    // Now the root declares `New` and the handover still `old`, with no id:
    // a finding, never a silent skip, and nothing is touched.
    const before = await head(fixture, fixture.web());
    const waiting = await fixture.run(machine("old"));
    expect(byPath(waiting)).toEqual({ ".": "blocked:organization-renamed" });
    expect(entryAt(waiting, ".")?.organization).toBe("old");
    expect(await fixture.origin(fixture.root())).toBe(
      "git@github.com:Old/example_GEN3.git",
    );
    expect(await head(fixture, fixture.web())).toBe(before);
    // The handover names the Organization id: the Organization is kept under
    // its new login, and every origin is pointed to it by repository id.
    const converged = await fixture.run(machine("old", organizationId));
    expect(byPath(converged)).toEqual({
      ".": "current",
      "workspace/web": "current",
    });
    expect(entryAt(converged, ".")).toMatchObject({
      organization: "New",
      origin: { from: "Old/example_GEN3", to: "New/example_GEN3" },
    });
    expect(entryAt(converged, "workspace/web")?.origin).toBeUndefined();
    expect(await fixture.origin(fixture.root())).toBe(
      "git@github.com:New/example_GEN3.git",
    );
    expect(await fixture.origin(fixture.web())).toBe(
      "git@github.com:New/web.git",
    );
    // From then on nothing is rewritten again.
    const again = await fixture.run(machine("old", organizationId));
    expect(again.every((entry) => entry.origin === undefined)).toBe(true);
  },
  60_000,
);

posixTest(
  "order 2, the handover first: the Organization is kept by its id, the root's origin follows, and the modules follow the root's new declaration",
  async () => {
    const fixture = await environment();
    await fixture.run(machine("old", organizationId));
    await fixture.renameOnGitHub();
    // The handover names `new` (refresh by id), the root still `Old`.
    const first = await fixture.run(machine("new", organizationId));
    expect(byPath(first)).toEqual({
      ".": "current",
      "workspace/web": "current",
    });
    expect(entryAt(first, ".")?.origin).toEqual({
      from: "Old/example_GEN3",
      to: "New/example_GEN3",
    });
    // The root still declares `Old/web`: kept through the redirect as
    // declared, not rewritten yet.
    expect(entryAt(first, "workspace/web")?.origin).toBeUndefined();
    const declared = await fixture.declareRoot("New");
    const second = await fixture.run(machine("new", organizationId));
    expect(byPath(second)).toEqual({
      ".": "fast-forwarded",
      "workspace/web": "current",
    });
    expect(await head(fixture, fixture.root())).toBe(declared);
    expect(entryAt(second, "workspace/web")?.origin).toEqual({
      from: "Old/web",
      to: "New/web",
    });
    expect(await fixture.origin(fixture.web())).toBe(
      "git@github.com:New/web.git",
    );
  },
  60_000,
);

posixTest(
  "order 3, both changed: every origin is pointed to the new login in the same run",
  async () => {
    const fixture = await environment();
    await fixture.renameOnGitHub();
    const declared = await fixture.declareRoot("New");
    const run = await fixture.run(machine("new", organizationId));
    expect(byPath(run)).toEqual({
      ".": "fast-forwarded",
      "workspace/web": "current",
    });
    expect(entryAt(run, ".")?.origin).toEqual({
      from: "Old/example_GEN3",
      to: "New/example_GEN3",
    });
    expect(entryAt(run, "workspace/web")?.origin).toEqual({
      from: "Old/web",
      to: "New/web",
    });
    expect(await head(fixture, fixture.root())).toBe(declared);
    expect(await fixture.origin(fixture.web())).toBe(
      "git@github.com:New/web.git",
    );
  },
  60_000,
);

test("an origin keeps its form when it is pointed to the new owner", () => {
  expect(
    rewrittenOrigin("git@github.com:Old/web.git", "old/web", "New/web"),
  ).toBe("git@github.com:New/web.git");
  expect(
    rewrittenOrigin("https://github.com/Old/web", "Old/web", "New/web"),
  ).toBe("https://github.com/New/web");
  expect(
    rewrittenOrigin("ssh://git@github.com/Old/web.git", "Old/web", "New/web"),
  ).toBe("ssh://git@github.com/New/web.git");
  // Never another repository's URL, credentials or another host.
  expect(
    rewrittenOrigin("git@github.com:Old/other.git", "Old/web", "New/web"),
  ).toBeNull();
  expect(
    rewrittenOrigin("https://token@github.com/Old/web", "Old/web", "New/web"),
  ).toBeNull();
  expect(
    rewrittenOrigin("git@example.invalid:Old/web.git", "Old/web", "New/web"),
  ).toBeNull();
});

posixTest(
  "a namesake who took the old login is never followed: an origin is rewritten only to the same repository id",
  async () => {
    const fixture = await environment();
    await fixture.renameOnGitHub();
    await fixture.declareRoot("New");
    fixture.state.now = "namesake";
    // GitHub answers the root's origin under the namesake's id: never read
    // from there, by a handover with the id or without it.
    for (const binding of [machine("new", organizationId), machine("old")]) {
      const run = await fixture.run(binding);
      expect(byPath(run)).toEqual({ ".": "blocked:unexpected-checkout" });
      expect(await fixture.origin(fixture.root())).toBe(
        "git@github.com:Old/example_GEN3.git",
      );
    }
  },
  60_000,
);

test("a refresh takes a renamed Owner Organization only by the same recorded id", () => {
  const recorded = machine("old", organizationId);
  expect(
    ownerOrganizationCorrection(
      recorded,
      machine("new", organizationId),
      undefined,
    ),
  ).toBe("owner-renamed");
  // No recorded id, another id, or no live id: another Owner.
  expect(
    ownerOrganizationCorrection(
      machine("old"),
      machine("new", organizationId),
      undefined,
    ),
  ).toBeNull();
  expect(
    ownerOrganizationCorrection(
      recorded,
      machine("new", namesakeId),
      undefined,
    ),
  ).toBeNull();
  expect(
    ownerOrganizationCorrection(recorded, machine("new"), undefined),
  ).toBeNull();
  // The id is not part of the identity: recording it is no other Machine.
  expect(JSON.stringify(machineIdentity(machine("old")))).toBe(
    JSON.stringify(machineIdentity(recorded)),
  );
  // The earlier correction by `organization_key` still holds.
  expect(
    ownerOrganizationCorrection(machine("label"), machine("old"), "Old"),
  ).toBe("owner-organization");
});
