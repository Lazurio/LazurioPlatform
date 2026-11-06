import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  removalConfirmAfterMs,
  removalIdentity,
  removalStep,
} from "../src/content/access-ended";
import { contentHelp } from "../src/content/cli";
import { processContentGit } from "../src/content/git";
import {
  type ContentGitHub,
  ghContentGitHub,
  type RepositoryAnswer,
  type ViewerAnswer,
} from "../src/content/github";
import {
  readSyncRecord,
  type SyncEntry,
  type SyncHost,
  syncContent,
  syncRecordFile,
} from "../src/content/sync";
import type { MachineBinding } from "../src/folder/machine-binding";
import type { PresetName } from "../src/folder/presets";
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
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import { runChild } from "./fixtures/run-child";

// A copy leaves an Environment only on proof that access ended (decision F72):
// deleting cannot be undone, so every answer that is not that proof keeps the
// copy and starts the count over. Real git and a real deletion in a temporary
// world; GitHub's API answers are the test's, synthetic names only.
const posixTest = test.skipIf(!["darwin", "linux"].includes(process.platform));

let world: World | undefined;
let parent = "";
afterEach(async () => {
  await world?.close();
  world = undefined;
  if (parent) await rm(parent, { recursive: true, force: true });
  parent = "";
});

const login = "example";
const operator = 12345;
const rootRepository = `${login}/example_GEN3`;
const minutes = (count: number) =>
  new Date(Date.parse("2026-11-06T10:00:00.000Z") + count * 60_000);
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

async function git(cwd: string, ...args: string[]) {
  const result = await runChild(
    [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, ...(world as World).gitEnv },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const slot = (path: string, repository: string): Slot => ({
  path,
  slug: path.split("/").at(-1) as string,
  git: { url: `git@github.com:${repository}.git`, branch: "main" },
});

type Answers = Readonly<{
  viewer?: ViewerAnswer;
  /** By full name; a repository not named answers 404. */
  repositories?: Readonly<Record<string, RepositoryAnswer>>;
}>;

const observed = (
  fullName: string,
  fields: Readonly<{ readable?: boolean; owner?: string }> = {},
): RepositoryAnswer => ({
  kind: "observed",
  repository: {
    fullName,
    owner: {
      login: fields.owner ?? (fullName.split("/")[0] as string),
      databaseId: 1,
      kind: "Organization",
    },
    private: true,
    archived: false,
    readable: fields.readable ?? true,
    permission: "read",
  },
});

const signedIn = (databaseId = operator): ViewerAnswer => ({
  kind: "signed-in",
  viewer: { login: "someone", databaseId },
});

/** GitHub as the test says, for one run. */
function github(current: World, answers: Answers = {}): ContentGitHub {
  const repositories: Readonly<Record<string, RepositoryAnswer>> = {
    [rootRepository]: observed(rootRepository),
    ...answers.repositories,
  };
  return {
    ...stubGitHub(current).github,
    viewer: async () => answers.viewer ?? signedIn(),
    repository: async (owner: string, name: string) =>
      repositories[`${owner}/${name}`] ?? { kind: "missing" },
  };
}

type Fixture = Readonly<{
  folder: string;
  root: string;
  at: (path: string) => string;
  retired: string[];
  run: (
    time: Date,
    answers?: Answers,
    options?: Readonly<{ retire?: SyncHost["retire"] | null }>,
  ) => Promise<readonly SyncEntry[]>;
}>;

const entryOf = (entries: readonly SyncEntry[], path: string) =>
  entries.find((entry) => entry.path === path);

/** A Work Environment of the operator with the root, the modules `web` and
 * `plans` (with its data mount `db`) and a module of another owner. */
async function environment(
  current: World,
  preset: PresetName = "hosted-organization-personal",
  machine: MachineBinding | null = bindings.assignedOperator,
): Promise<Fixture> {
  const slots: Slot[] = [
    slot("workspace/web", `${login}/web`),
    slot("workspace/plans", `${login}/plans`),
    {
      path: "workspace/plans/db",
      slug: "plans-data",
      materialization: "repository_db_mount",
      git: { url: `git@github.com:${login}/plans-data.git`, branch: "v3" },
    },
    slot("workspace/shared", "Other/shared"),
  ];
  await remoteRepository(current, rootRepository, async (directory) => {
    await writeOrganizationRoot(directory, {
      slug: "example",
      forge: login,
      slots,
      root: rootRepository,
    });
    await writeFile(join(directory, ".gitignore"), "workspace/\n.worktrees/\n");
  });
  for (const repository of [`${login}/web`, `${login}/plans`, "Other/shared"])
    await remoteRepository(current, repository, async (directory) => {
      await writeModule(directory, "example", {
        id: repository.split("/")[1] as string,
      });
      await writeFile(join(directory, ".gitignore"), "db/\n.worktrees/\n");
    });
  await remoteRepository(
    current,
    `${login}/plans-data`,
    (directory) => writeFile(join(directory, "data.json"), "{}\n"),
    "v3",
  );
  const folder = await presetFolder(current, preset, machine);
  const root = join(folder, "organizations", "example_GEN3");
  const clone = (repository: string, path: string, branch = "main") =>
    git(
      folder,
      "clone",
      "--quiet",
      "--branch",
      branch,
      `git@github.com:${repository}.git`,
      path,
    );
  await clone(rootRepository, root);
  await clone(`${login}/web`, join(root, "workspace", "web"));
  await clone(`${login}/plans`, join(root, "workspace", "plans"));
  await clone(`${login}/plans-data`, join(root, "workspace/plans/db"), "v3");
  await clone("Other/shared", join(root, "workspace", "shared"));
  const retired: string[] = [];
  const gitHost = processContentGit({
    path: Bun.env.PATH,
    home: current.home,
    platform: process.platform,
    run: runTool,
    env: current.gitEnv,
  });
  return {
    folder,
    root,
    retired,
    at: (path) => join(root, path),
    run: async (time, answers = {}, options = {}) => {
      const retire =
        options.retire === null
          ? {}
          : {
              retire:
                options.retire ??
                (async (organization: string, path: string) => {
                  // What runs stops while the copy is still there.
                  expect(await exists(join(root, path))).toBe(true);
                  retired.push(`${organization} ${path}`);
                  return true;
                }),
            };
      const run = await syncContent(
        folder,
        {
          github: github(current, answers),
          git: gitHost,
          lockDirectory: current.lockDirectory,
          ...retire,
        },
        { now: () => time },
      );
      if (run.kind !== "content-sync") throw new Error(JSON.stringify(run));
      console.log(
        JSON.stringify(run.entries.map((e) => [e.path, e.result, e.reason])),
      );
      return run.entries;
    },
  };
}

/** GitHub with access to everything of the fixture but `web`. */
const webGone: Answers = {
  repositories: {
    [`${login}/plans`]: observed(`${login}/plans`),
    [`${login}/plans-data`]: observed(`${login}/plans-data`),
    "Other/shared": observed("Other/shared"),
  },
};

/** The remote of `web` is gone too, as for an identity without access. */
const dropRemote = (current: World, repository: string) => {
  const [owner, name] = repository.split("/") as [string, string];
  return rm(join(current.remotes, owner, `${name}.git`), {
    recursive: true,
    force: true,
  });
};

posixTest(
  "two proofs at least half an hour apart remove the copy with its unsaved work and its worktrees; the slot stays declared, absent, with a trace",
  async () => {
    world = await createWorld();
    const fixture = await environment(world);
    const web = fixture.at("workspace/web");
    await writeFile(join(web, "unsaved.txt"), "work nothing saved\n");
    await git(web, "worktree", "add", "-q", "-b", "task", ".worktrees/task");
    const commit = await git(web, "rev-parse", "HEAD");
    // Unsaved work blocks a synchronization before it asks the remote, and
    // is no reason to keep the copy.
    const first = await fixture.run(minutes(0), webGone);
    expect(entryOf(first, "workspace/web")).toMatchObject({
      result: "blocked",
      reason: "dirty",
      removal: {
        since: minutes(0).toISOString(),
        viewer: operator,
        repository: `${login}/web`,
      },
    });
    expect(await exists(web)).toBe(true);
    // Zkontrolovat přístupy a moment later is no second proof.
    const soon = await fixture.run(minutes(29), webGone);
    expect(entryOf(soon, "workspace/web")?.removal?.since).toBe(
      minutes(0).toISOString(),
    );
    expect(await exists(web)).toBe(true);
    expect(fixture.retired).toEqual([]);

    const second = await fixture.run(minutes(60), webGone);
    expect(entryOf(second, "workspace/web")).toMatchObject({
      result: "absent",
      reason: "access-ended",
      removed: {
        at: minutes(60).toISOString(),
        repository: `${login}/web`,
        commit,
        unsaved: true,
        worktrees: 1,
        worktreesOutside: 0,
      },
    });
    expect(await exists(web)).toBe(false);
    expect(fixture.retired).toEqual([`${login} workspace/web`]);
    // Nothing else moved, and no trace of the deletion is left beside it.
    expect(await exists(fixture.at("workspace/plans/db"))).toBe(true);
    expect(await exists(fixture.at("workspace/shared"))).toBe(true);
    expect(await git(fixture.root, "status", "--porcelain")).toBe("");

    // The slot stays declared and absent, and the record keeps the trace.
    const later = await fixture.run(minutes(120), webGone);
    expect(entryOf(later, "workspace/web")).toMatchObject({
      result: "absent",
      reason: "repository-denied",
      removed: { at: minutes(60).toISOString() },
    });
    const record = await readSyncRecord(
      (world as World).lockDirectory,
      fixture.folder,
    );
    expect(entryOf(record ?? [], "workspace/web")?.removed?.commit).toBe(
      commit,
    );
  },
  60_000,
);

posixTest(
  "a clean checkout whose remote refuses this identity goes the same way, and access given back brings a fresh clone without the trace",
  async () => {
    world = await createWorld();
    const current = world;
    const fixture = await environment(current);
    const web = fixture.at("workspace/web");
    const remote = join(current.remotes, login, "web.git");
    const away = `${remote}.away`;
    await rename(remote, away);
    expect(
      entryOf(await fixture.run(minutes(0), webGone), "workspace/web"),
    ).toMatchObject({ result: "denied", removal: { viewer: operator } });
    expect(
      entryOf(await fixture.run(minutes(60), webGone), "workspace/web"),
    ).toMatchObject({
      result: "absent",
      reason: "access-ended",
      removed: { unsaved: false, worktrees: 0 },
    });
    await rename(away, remote);
    const back = await fixture.run(minutes(120), {
      repositories: {
        ...webGone.repositories,
        [`${login}/web`]: observed(`${login}/web`),
      },
    });
    const entry = entryOf(back, "workspace/web");
    expect(entry?.result).toBe("materialized");
    expect(entry?.removed).toBeUndefined();
    expect(await exists(join(web, ".git"))).toBe(true);
  },
  60_000,
);

// Everything that is not proof, each as the second run: the copy stays and the
// first proof is gone, so a later proof starts the count again.
const noProof: readonly (readonly [string, Answers])[] = [
  [
    "the network is down",
    {
      viewer: { kind: "unavailable" },
      repositories: {
        [rootRepository]: { kind: "unavailable" },
        [`${login}/web`]: { kind: "unavailable" },
      },
    },
  ],
  [
    "GitHub answers 5xx or a rate limit for the repository",
    {
      repositories: { [`${login}/web`]: { kind: "unavailable" } },
    },
  ],
  [
    "GitHub answers 5xx or a rate limit for the Organization's root",
    {
      repositories: { [rootRepository]: { kind: "unavailable" } },
    },
  ],
  ["the token is invalid or missing", { viewer: { kind: "unavailable" } }],
  ["gh is signed out", { viewer: { kind: "signed-out" } }],
  ["another identity is signed in", { viewer: signedIn(operator + 1) }],
  // A token that lost its scope, or a single sign-on that expired, refuses
  // the root as well: everything 404, nothing proved about one module.
  [
    "the identity no longer reads the root",
    {
      repositories: { [rootRepository]: { kind: "missing" } },
    },
  ],
  [
    "the root answers without read access",
    {
      repositories: {
        [rootRepository]: observed(rootRepository, { readable: false }),
      },
    },
  ],
  [
    "the root answers as another owner's",
    {
      repositories: {
        [rootRepository]: observed(rootRepository, { owner: "Moved" }),
      },
    },
  ],
  [
    "the repository answers but says nothing of a refusal",
    {
      repositories: {
        [`${login}/web`]: observed(`${login}/web`, { readable: false }),
      },
    },
  ],
  [
    "the identity reads the repository again",
    {
      repositories: { [`${login}/web`]: observed(`${login}/web`) },
    },
  ],
];

for (const [name, answers] of noProof)
  posixTest(
    `no copy goes when ${name}, and the count starts over`,
    async () => {
      world = await createWorld();
      const fixture = await environment(world);
      const web = fixture.at("workspace/web");
      await writeFile(join(web, "unsaved.txt"), "work\n");
      expect(
        entryOf(await fixture.run(minutes(0), webGone), "workspace/web")
          ?.removal,
      ).toBeDefined();
      const second = await fixture.run(minutes(60), {
        ...answers,
        repositories: { ...webGone.repositories, ...answers.repositories },
      });
      expect(await exists(join(web, "unsaved.txt"))).toBe(true);
      expect(fixture.retired).toEqual([]);
      expect(entryOf(second, "workspace/web")?.removal).toBeUndefined();
      // Proof again: only a first one, not the second.
      const third = await fixture.run(minutes(120), webGone);
      expect(entryOf(third, "workspace/web")?.removal?.since).toBe(
        minutes(120).toISOString(),
      );
      expect(await exists(join(web, "unsaved.txt"))).toBe(true);
    },
    60_000,
  );

posixTest(
  "without a live identity not even a first proof is recorded",
  async () => {
    world = await createWorld();
    const fixture = await environment(world);
    await writeFile(join(fixture.at("workspace/web"), "unsaved.txt"), "work\n");
    for (const viewer of [
      { kind: "signed-out" },
      { kind: "unavailable" },
      signedIn(operator + 1),
    ] as const) {
      const entries = await fixture.run(minutes(0), { ...webGone, viewer });
      expect(entryOf(entries, "workspace/web")?.removal).toBeUndefined();
    }
  },
  60_000,
);

posixTest(
  "a run stopped by a blocked root proves nothing: the first proof is gone",
  async () => {
    world = await createWorld();
    const current = world;
    const fixture = await environment(current);
    const web = fixture.at("workspace/web");
    const remote = join(current.remotes, login, "web.git");
    await rename(remote, `${remote}.away`);
    expect(
      entryOf(await fixture.run(minutes(0), webGone), "workspace/web")?.removal,
    ).toBeDefined();
    const dirt = fixture.at("dirt.txt");
    await writeFile(dirt, "x\n");
    await fixture.run(minutes(60), webGone);
    await rm(dirt);
    const after = await fixture.run(minutes(120), webGone);
    expect(entryOf(after, "workspace/web")?.removal?.since).toBe(
      minutes(120).toISOString(),
    );
    expect(await exists(web)).toBe(true);
  },
  60_000,
);

posixTest(
  "the root, another owner's module and what no slot declares are never removed",
  async () => {
    world = await createWorld();
    const current = world;
    const fixture = await environment(current);
    const undeclared = fixture.at("workspace/notes");
    await mkdir(undeclared);
    await writeFile(join(undeclared, "keep.txt"), "mine\n");
    // A guest of another Organization: its 404 is not proved by this root.
    await writeFile(join(fixture.at("workspace/shared"), "unsaved.txt"), "x\n");
    const answers: Answers = {
      repositories: {
        [`${login}/web`]: observed(`${login}/web`),
        [`${login}/plans`]: observed(`${login}/plans`),
        [`${login}/plans-data`]: observed(`${login}/plans-data`),
      },
    };
    await fixture.run(minutes(0), answers);
    await fixture.run(minutes(60), answers);
    expect(await exists(fixture.at("workspace/shared"))).toBe(true);
    expect(await exists(join(undeclared, "keep.txt"))).toBe(true);
    // The root itself refused: it stops its Organization and stays.
    await dropRemote(current, rootRepository);
    await fixture.run(minutes(120), webGone);
    await fixture.run(minutes(180), webGone);
    expect(await exists(join(fixture.root, ".git"))).toBe(true);
    expect(await exists(fixture.at("workspace/web"))).toBe(true);
    expect(fixture.retired).toEqual([]);
  },
  60_000,
);

posixTest(
  "a link at the slot is not a copy: neither it nor what it points to is touched",
  async () => {
    world = await createWorld();
    const fixture = await environment(world);
    const web = fixture.at("workspace/web");
    await writeFile(join(web, "unsaved.txt"), "work\n");
    await fixture.run(minutes(0), webGone);
    const elsewhere = join(dirname(fixture.folder), "elsewhere");
    await rename(web, elsewhere);
    await symlink(elsewhere, web);
    await fixture.run(minutes(60), webGone);
    expect((await lstat(web)).isSymbolicLink()).toBe(true);
    expect(await exists(join(elsewhere, "unsaved.txt"))).toBe(true);
  },
  60_000,
);

posixTest(
  "only a data mount's access ended: its module's apps stop and only the mount goes",
  async () => {
    world = await createWorld();
    const fixture = await environment(world);
    const db = fixture.at("workspace/plans/db");
    await writeFile(join(db, "draft.yaml"), "unsaved\n");
    const answers: Answers = {
      repositories: {
        [`${login}/web`]: observed(`${login}/web`),
        [`${login}/plans`]: observed(`${login}/plans`),
        "Other/shared": observed("Other/shared"),
      },
    };
    await fixture.run(minutes(0), answers);
    const second = await fixture.run(minutes(60), answers);
    expect(entryOf(second, "workspace/plans/db")).toMatchObject({
      result: "absent",
      reason: "access-ended",
    });
    expect(await exists(db)).toBe(false);
    expect(await exists(fixture.at("workspace/plans/.git"))).toBe(true);
    expect(fixture.retired).toEqual([`${login} workspace/plans`]);
  },
  60_000,
);

posixTest(
  "what cannot be stopped keeps its copy until a later run can stop it, and without a way to stop nothing is removed at all",
  async () => {
    world = await createWorld();
    const fixture = await environment(world);
    const web = fixture.at("workspace/web");
    await writeFile(join(web, "unsaved.txt"), "work\n");
    // No way to stop what runs: no copy goes and no proof is recorded.
    const blind = await fixture.run(minutes(0), webGone, { retire: null });
    expect(entryOf(blind, "workspace/web")?.removal).toBeUndefined();
    await fixture.run(minutes(10), webGone);
    for (const retire of [
      async () => false,
      async () => {
        throw new Error("stop failed");
      },
    ]) {
      const entries = await fixture.run(minutes(60), webGone, { retire });
      expect(await exists(web)).toBe(true);
      expect(entryOf(entries, "workspace/web")?.removal?.since).toBe(
        minutes(10).toISOString(),
      );
    }
    await fixture.run(minutes(120), webGone);
    expect(await exists(web)).toBe(false);
  },
  60_000,
);

posixTest(
  "what an interrupted removal left beside the slot goes at the next run, and only that",
  async () => {
    world = await createWorld();
    const fixture = await environment(world);
    await fixture.run(minutes(0), webGone);
    await writeFile(join(fixture.at("workspace/web"), "unsaved.txt"), "w\n");
    await fixture.run(minutes(0), webGone);
    await fixture.run(minutes(60), webGone);
    const left = fixture.at("workspace/.web.removing-abcdef012345");
    const other = fixture.at("workspace/.web.removing-other");
    await mkdir(left);
    await mkdir(other);
    await fixture.run(minutes(120), webGone);
    expect(await exists(left)).toBe(false);
    expect(await exists(other)).toBe(true);
  },
  60_000,
);

posixTest(
  "a computer never removes a copy, whatever GitHub answers, and neither does a Work Environment that names nobody",
  async () => {
    for (const [preset, machine] of [
      ["local", null],
      ["hosted-organization-personal", bindings.organization],
    ] as const) {
      world = await createWorld();
      const fixture = await environment(world, preset, machine);
      const web = fixture.at("workspace/web");
      await fixture.run(minutes(0), webGone);
      const entries = await fixture.run(minutes(60), webGone);
      expect(await exists(web)).toBe(true);
      expect(entryOf(entries, "workspace/web")?.removal).toBeUndefined();
      await world.close();
      world = undefined;
    }
  },
  90_000,
);

posixTest(
  "a record that cannot be read proves nothing: the count starts again",
  async () => {
    world = await createWorld();
    const current = world;
    const fixture = await environment(current);
    const web = fixture.at("workspace/web");
    await writeFile(join(web, "unsaved.txt"), "work\n");
    await fixture.run(minutes(0), webGone);
    const file = syncRecordFile(current.lockDirectory, fixture.folder);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.entries = record.entries.map((entry: Record<string, unknown>) =>
      entry.removal === undefined ? entry : { ...entry, removal: { since: 1 } },
    );
    await writeFile(file, JSON.stringify(record));
    await fixture.run(minutes(60), webGone);
    expect(await exists(web)).toBe(true);
  },
  60_000,
);

test("one more proof: first, too soon, or far enough from a proof of the same identity and repository", () => {
  const proof = { viewer: operator, repository: `${login}/web` };
  const mark = { since: minutes(0).toISOString(), ...proof };
  expect(removalStep(undefined, proof, minutes(0))).toBe("mark");
  expect(
    removalStep(
      mark,
      proof,
      new Date(minutes(0).getTime() + removalConfirmAfterMs - 1),
    ),
  ).toBe("wait");
  expect(
    removalStep(
      mark,
      proof,
      new Date(minutes(0).getTime() + removalConfirmAfterMs),
    ),
  ).toBe("remove");
  expect(
    removalStep(mark, { ...proof, repository: `${login}/WEB` }, minutes(60)),
  ).toBe("remove");
  expect(
    removalStep(mark, { ...proof, viewer: operator + 1 }, minutes(60)),
  ).toBe("mark");
  expect(
    removalStep(mark, { ...proof, repository: `${login}/other` }, minutes(60)),
  ).toBe("mark");
  expect(
    removalStep({ ...mark, since: "not a date" }, proof, minutes(60)),
  ).toBe("mark");
  expect(removalStep(mark, proof, minutes(-60))).toBe("mark");
});

test("only a Work Environment that names its person can prove an identity", () => {
  expect(
    removalIdentity("hosted-organization-personal", bindings.assignedOperator),
  ).toBe(operator);
  for (const [preset, machine] of [
    ["local", null],
    ["hosted-personal", bindings.personal],
    ["hosted-organization-personal", bindings.organization],
    ["hosted-organization-personal", bindings.organizationPublic],
    ["hosted-organization-team", bindings.team],
    ["hosted-organization-team", bindings.teamPublic],
    ["hosted-organization-steward", bindings.automated],
  ] as const)
    expect([preset, removalIdentity(preset, machine)]).toEqual([preset, null]);
});

// gh's own answers: only GitHub's 404 in its error body is `missing`, the one
// answer a removal can rest on.
async function ghAnswering(script: string) {
  parent = await realpath(await mkdtemp(join(tmpdir(), "content-ended-")));
  const bin = join(parent, "bin");
  const home = join(parent, "home");
  await mkdir(bin);
  await mkdir(home);
  const gh = join(bin, "gh");
  await writeFile(gh, `#!/bin/sh\n${script}\n`);
  await chmod(gh, 0o755);
  return ghContentGitHub(
    { path: bin, home, platform: process.platform, run: runTool },
    { sleep: async () => {} },
  );
}

const fails = (body: string, exit = 1) =>
  `echo '${body}'; echo 'gh: failed' >&2; exit ${exit}`;

posixTest(
  "gh's 404 is the only answer that says a repository cannot be reached",
  async () => {
    const cases: readonly (readonly [
      string,
      string,
      RepositoryAnswer["kind"],
    ])[] = [
      ["404", fails('{"message":"Not Found","status":"404"}'), "missing"],
      [
        "500",
        fails('{"message":"Server Error","status":"500"}'),
        "unavailable",
      ],
      ["502", fails('{"message":"Bad Gateway","status":"502"}'), "unavailable"],
      ["503", fails('{"message":"Unavailable","status":"503"}'), "unavailable"],
      [
        "a rate limit by 403",
        fails('{"message":"API rate limit exceeded","status":"403"}'),
        "unavailable",
      ],
      [
        "a rate limit by 429",
        fails('{"message":"Too Many Requests","status":"429"}'),
        "unavailable",
      ],
      [
        "an invalid token",
        fails('{"message":"Bad credentials","status":"401"}'),
        "unavailable",
      ],
      [
        "a signed-out gh",
        "echo 'To get started with GitHub CLI' >&2; exit 4",
        "unavailable",
      ],
      [
        "no network",
        "echo 'dial tcp: lookup api.github.com: no such host' >&2; exit 1",
        "unavailable",
      ],
      ["a proxy's own 404 page", fails("<html>404</html>"), "unavailable"],
      ["a 200 nobody can read", "echo 'not json'", "unavailable"],
    ];
    for (const [name, script, kind] of cases) {
      const github = await ghAnswering(script);
      expect([name, (await github.repository("example", "web")).kind]).toEqual([
        name,
        kind,
      ]);
      await rm(parent, { recursive: true, force: true });
      parent = "";
    }
  },
);

test("the help of organization sync says when a copy goes", () => {
  expect(contentHelp).toContain("access-ended");
  expect(contentHelp).toContain("removal-pending");
});
