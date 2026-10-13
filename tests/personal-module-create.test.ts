import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { processContentGit } from "../src/content/git";
import type { GitHubRepository, ViewerAnswer } from "../src/content/github";
import { tryContentLock } from "../src/content/lock";
import { personalspaceHolder } from "../src/content/status";
import type { PresetName } from "../src/folder/presets";
import {
  type ModuleCreateHost,
  type ModuleCreateReport,
  planModuleCreate,
} from "../src/modules/module-create";
import { runModuleCreateCommand } from "../src/modules/module-create-cli";
import {
  createPersonalModule,
  type ModuleCreateRunHost,
  type ModuleCreateRunRequest,
  type ModuleCreateStep,
} from "../src/modules/module-create-run";
import { personalModulePortPool } from "../src/modules/scaffold";
import { readFolderCatalog } from "../src/organizations/catalog";
import { runTool } from "../src/tools/status";
import {
  contentHost,
  createWorld,
  presetFolder,
  stubGitHub,
  type World,
} from "./fixtures/content-world";
import { bindings } from "./fixtures/machine-bindings";
import {
  mkdirOwnedFixture as mkdir,
  writeOwnedFixture as writeFile,
} from "./fixtures/owned-files";
import {
  addTaskWorktree,
  type PersonalspaceFiles,
  personalspaceTemplateManifest,
  writePersonalspaceCheckout,
} from "./fixtures/personalspace-template";

// `lazurio module create personalspace/<slug>` (decision F52): its plan, the
// checks a dry run and a real run share, all reading only; and its real run,
// only for the plan the person confirmed. A world without a
// network (tests/fixtures/content-world.ts): a stub GitHub that logs every
// call, the product's git for real, and Personalspaces exactly as `lazurio
// personalspace install` leaves them today, with the template's placeholders
// and example slot (#377). Synthetic names only.

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let world: World | undefined;
beforeAll(async () => {
  if (supported) world = await createWorld();
});
afterAll(async () => {
  await world?.close();
});

const login = "example";
const loginId = 12345;
const owner = `${login}_GEN3`;

type Scenario = {
  preset?: PresetName;
  viewer?: ViewerAnswer;
  repositories?: Record<string, Partial<GitHubRepository> | "unavailable">;
  files?: PersonalspaceFiles;
  /** The Personalspace's origin, when not the account's own. */
  origin?: string;
  /** No Personalspace in the Folder. */
  noPersonalspace?: boolean;
  worktree?: boolean;
  /** How GitHub answers the creation of the module's repository. */
  create?: NonNullable<Parameters<typeof stubGitHub>[1]>["create"];
};

/** A Folder of `preset` with the account's Personalspace, its task
 * worktree when asked, a stub GitHub that knows the Personalspace as the
 * account's own private repository, and the host the plan reads. */
async function scenario(options: Scenario = {}) {
  const current = world as World;
  const preset = options.preset ?? "local";
  const folder = await presetFolder(
    current,
    preset,
    preset === "local"
      ? null
      : bindings[preset === "hosted-personal" ? "personal" : "organization"],
  );
  const space = join(folder, "personalspace", owner);
  if (!options.noPersonalspace)
    await writePersonalspaceCheckout(
      space,
      options.origin ?? `${login}/${owner}`,
      options.files,
    );
  const worktree = join(folder, "personalspace", ".worktrees", "notes-task");
  if (options.worktree)
    await addTaskWorktree(space, worktree, "agent/notes-task");
  const { github, calls } = stubGitHub(current, {
    viewer: options.viewer ?? {
      kind: "signed-in",
      viewer: { login, databaseId: loginId },
    },
    repositories: options.repositories ?? {
      [`${login}/${owner}`]: {
        owner: { login, databaseId: loginId, kind: "User" },
      },
    },
    ...(options.create === undefined ? {} : { create: options.create }),
  });
  const content = contentHost(current, github);
  const host: ModuleCreateHost = {
    holder: (at) => personalspaceHolder(at, content),
    github,
    git: content.git,
  };
  return { folder, space, worktree, host, github, calls };
}

async function dryRun(
  setup: Awaited<ReturnType<typeof scenario>>,
  overrides: Partial<Parameters<typeof planModuleCreate>[0]> = {},
): Promise<ModuleCreateReport> {
  return planModuleCreate(
    {
      folder: setup.folder,
      cwd: setup.worktree,
      selector: "personalspace/notes",
      stack: "vite-react",
      ...overrides,
    },
    setup.host,
  );
}

/** Every entry below `root` with its size and change time: what a dry run
 * must leave exactly as it was. */
async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      entries.push(
        `${relative(root, path)} ${stat.isDirectory() ? "d" : stat.size} ${stat.mtimeMs} ${stat.ctimeMs}`,
      );
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return entries.sort();
}

describe("the dry run", () => {
  posixTest(
    "from the task worktree: the exact plan, nothing written, only GitHub reads",
    async () => {
      const setup = await scenario({ worktree: true });
      const before = await snapshot(setup.folder);
      const report = await dryRun(setup, { name: "Poznámky" });
      expect(await snapshot(setup.folder)).toEqual(before);
      expect(setup.calls).toEqual([
        { kind: "viewer", args: [] },
        { kind: "repository", args: [login, owner] },
        { kind: "repository", args: [login, "notes"] },
      ]);
      const worktree = await realpath(setup.worktree);
      expect(report).toMatchObject({
        schema_version: "lazurio.module_create.report.v1",
        status: "actionable",
        reason: "scaffold_planned",
        dry_run: true,
        scope: "personalspace",
        module: {
          name: "personalspace/notes",
          slug: "notes",
          stack: "vite-react",
          display_name: "Poznámky",
        },
        repository: { full_name: "example/notes", private: true, create: true },
        slot: {
          path: "workspace/notes",
          slug: "notes",
          space: "workspace",
          category: "application",
          default_access: "private",
          required_roles: ["owner"],
          source_of_truth: "git-native",
          status: "active",
          git: { url: "git@github.com:example/notes.git", branch: "main" },
        },
        lease: { id: "main", host: "127.0.0.1", port: 23_052 },
        generated_by_install: ["app/v1/bun.lock"],
        manifest: {
          path: join(worktree, "modules.manifest.json"),
          module_port_pool: personalModulePortPool,
          adds_pool: true,
        },
        worktree: { path: worktree, branch: "agent/notes-task" },
        module_root: join(setup.space, "workspace", "notes"),
        issues: [],
        standard: null,
      });
      expect(report.slot?.teams).toBeUndefined();
      expect(report.tree_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.plan).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.files.map((file) => file.path)).toContain(
        "app/v1/src/App.tsx",
      );
      // The template's placeholder owner is a warning with its next step.
      expect(report.warnings).toEqual([
        expect.stringContaining("Lazurio/LazurioPlatform#377"),
      ]);
      expect(report.next_steps.join("\n")).toContain("#377");
      expect(report.next_steps.join("\n")).toContain(
        "also declares module_port_pool 23000-23099",
      );
      expect(report.next_steps.join("\n")).not.toContain("worktree add");
      // The same state gives the same plan.
      expect((await dryRun(setup, { name: "Poznámky" })).plan).toBe(
        report.plan,
      );
      expect((await dryRun(setup, { name: "Jiné" })).plan).not.toBe(
        report.plan,
      );
    },
  );

  posixTest(
    "outside a task worktree it plans too and says where the worktree goes",
    async () => {
      const setup = await scenario();
      const report = await dryRun(setup, { cwd: setup.folder });
      expect(report.status).toBe("actionable");
      expect(report.worktree).toBeNull();
      expect(report.manifest?.path).toBe(
        join(setup.space, "modules.manifest.json"),
      );
      expect(report.next_steps[0]).toContain(
        `worktree add -b <branch> '${join(setup.folder, "personalspace", ".worktrees", "<task>")}'`,
      );
    },
  );

  posixTest(
    "on a personal Remote Environment the Owner's own Personalspace plans the same",
    async () => {
      const setup = await scenario({
        preset: "hosted-personal",
        worktree: true,
      });
      const report = await dryRun(setup);
      expect(report).toMatchObject({
        status: "actionable",
        repository: { full_name: "example/notes" },
        lease: { port: 23_052 },
      });
    },
  );

  posixTest(
    "the lease avoids every lease in the Folder, an Organization's and the Personalspace's",
    async () => {
      const setup = await scenario({ worktree: true });
      // An Organization module on the port `notes` would take, a personal
      // module on the next one.
      const lease = async (path: string, company: string, port: number) => {
        await mkdir(path, { recursive: true });
        await writeFile(
          join(path, "lazurio.module.json"),
          JSON.stringify({
            schema_version: "lazurio.module.v1",
            id: "x",
            company,
            tcp_port_policy: { mode: "single" },
            port_leases: [{ id: "main", host: "127.0.0.1", port }],
          }),
        );
      };
      await lease(
        join(setup.folder, "organizations", "alpha_GEN3", "workspace", "web"),
        "alpha",
        23_052,
      );
      await lease(join(setup.space, "workspace", "diary"), login, 23_053);
      expect((await dryRun(setup)).lease?.port).toBe(23_054);
      expect((await dryRun(setup, { port: 23_053 })).reason).toBe("port_taken");
      expect((await dryRun(setup, { port: 24_009 })).reason).toBe(
        "port_outside_pool",
      );
    },
  );

  posixTest(
    "the template's example slot is a declared slot, not a conflict; a declared pool is used",
    async () => {
      const declared = personalspaceTemplateManifest.replace(
        '"owner": "owner-github-username",',
        '"owner": "example",\n  "module_port_pool": { "start": 23010, "end": 23019 },',
      );
      const setup = await scenario({
        worktree: true,
        files: { "modules.manifest.json": declared },
      });
      const report = await dryRun(setup);
      expect(report.status).toBe("actionable");
      expect(report.warnings).toEqual([]);
      expect(report.manifest).toMatchObject({
        module_port_pool: { start: 23_010, end: 23_019 },
        adds_pool: false,
      });
      const port = report.lease?.port as number;
      expect(port >= 23_010 && port <= 23_019).toBe(true);
      expect(
        (await dryRun(setup, { selector: "personalspace/personal-notes" }))
          .reason,
      ).toBe("slot_exists");
    },
  );
});

describe("refusals, before anything is written", () => {
  const refusal = async (
    options: Scenario,
    code: string,
    request: Partial<Parameters<typeof planModuleCreate>[0]> = {},
    prepare?: (setup: Awaited<ReturnType<typeof scenario>>) => Promise<void>,
  ) => {
    const setup = await scenario({
      worktree: !options.noPersonalspace,
      ...options,
    });
    await prepare?.(setup);
    const before = await snapshot(setup.folder);
    const report = await dryRun(setup, {
      ...(options.noPersonalspace ? { cwd: setup.folder } : {}),
      ...request,
    });
    expect({ status: report.status, reason: report.reason }).toEqual({
      status: "blocked",
      reason: code,
    });
    expect(report.issues[0]?.code).toBe(code);
    expect(await snapshot(setup.folder)).toEqual(before);
    // Nothing but reads was asked of GitHub.
    expect(
      setup.calls.every((call) => ["viewer", "repository"].includes(call.kind)),
    ).toBe(true);
    return { report, setup };
  };

  posixTest("the name, the stack and the form", async () => {
    await refusal({}, "invalid_selector", { selector: "notes" });
    await refusal({}, "invalid_slug", { selector: "personalspace/Notes" });
    for (const label of ["browser", "mausbot-webhook", "launchpad"])
      await refusal({}, "reserved_slug", {
        selector: `personalspace/${label}`,
      });
    await refusal({}, "unknown_stack", { stack: "rails" });
    const { report, setup } = await refusal(
      {},
      "organization-form-unavailable",
      { selector: "Acme/portal" },
    );
    expect(report.issues[0]?.message).toContain("#267");
    expect(report.scope).toBe("organization");
    // Refused by name alone: GitHub was never asked.
    expect(setup.calls).toEqual([]);
  });

  posixTest("where the Personalspace is, and whose it is (#186)", async () => {
    await refusal(
      { preset: "hosted-organization-personal", noPersonalspace: true },
      "personalspace-not-here",
    );
    const absent = await refusal(
      { noPersonalspace: true },
      "personalspace-absent",
    );
    expect(absent.report.next_steps).toEqual([
      "Install it first: lazurio personalspace install.",
    ]);
    await refusal({ viewer: { kind: "signed-out" } }, "github-signed-out");
    await refusal({ viewer: { kind: "unavailable" } }, "github-unavailable");
    await refusal(
      {
        preset: "hosted-personal",
        viewer: {
          kind: "signed-in",
          viewer: { login: "other", databaseId: 7 },
        },
      },
      "github-identity-mismatch",
    );
    await refusal({ origin: "other/other_GEN3" }, "personalspace-foreign");
    await refusal({ repositories: {} }, "personalspace-not-owned");
    await refusal(
      {
        repositories: {
          [`${login}/${owner}`]: {
            owner: { login, databaseId: loginId, kind: "User" },
            private: false,
          },
        },
      },
      "personalspace-public",
    );
    await refusal({}, "personalspace-ambiguous", {}, async (setup) => {
      await mkdir(join(setup.folder, "personalspace", "other_GEN3"));
    });
  });

  posixTest("the Personalspace's layout", async () => {
    await refusal(
      { files: { "modules.manifest.json": null } },
      "modules_manifest_missing",
    );
    await refusal(
      { files: { "modules.manifest.json": "{ not json" } },
      "manifest_invalid",
    );
    await refusal(
      { files: { "modules.manifest.json": '{"owner": "example"}\n' } },
      "manifest_invalid",
    );
    await refusal(
      {
        files: {
          "modules.manifest.json": personalspaceTemplateManifest.replace(
            '"owner": "owner-github-username",',
            '"owner": "example",\n  "module_port_pool": { "start": 24000, "end": 24099 },',
          ),
        },
      },
      "personalspace-pool-invalid",
    );
    await refusal(
      { files: { ".gitignore": "node_modules/\n" } },
      "personalspace-workspace-tracked",
    );
    await refusal({}, "directory_exists", {}, async (setup) => {
      await mkdir(join(setup.space, "workspace", "Notes"));
    });
    // A slot the task branch already declares.
    await refusal({}, "slot_exists", {}, async (setup) => {
      await writeFile(
        join(setup.worktree, "modules.manifest.json"),
        personalspaceTemplateManifest.replace(
          '"path": "workspace/personal-notes"',
          '"path": "workspace/notes"',
        ),
      );
    });
  });

  posixTest("a taken repository name is never taken over", async () => {
    const taken = await refusal(
      {
        repositories: {
          [`${login}/${owner}`]: {
            owner: { login, databaseId: loginId, kind: "User" },
          },
          // GitHub compares names ignoring letter case.
          "Example/NOTES": {
            owner: { login, databaseId: loginId, kind: "User" },
          },
        },
      },
      "repository-exists",
    );
    expect(taken.report.issues[0]?.message).toContain("Example/NOTES");
    expect(taken.report.repository).toBeNull();
    await refusal(
      {
        repositories: {
          [`${login}/${owner}`]: {
            owner: { login, databaseId: loginId, kind: "User" },
          },
          [`${login}/notes`]: "unavailable",
        },
      },
      "github-unavailable",
    );
  });

  posixTest(
    "a port outside the personal pool, or one for a module without an app",
    async () => {
      // The Launchpad's own port lies outside the personal pool, as every
      // port of the Environment does.
      await refusal({}, "port_outside_pool", { port: 20_000 });
      await refusal({}, "port_not_allowed", { stack: "none", port: 23_001 });
    },
  );
});

// ---- the real run ------------------------------------------------------------

/** The operator's git with an identity (or, with `identity: false`, one
 * that refuses to guess it), over the world's remotes. */
function operatorGit(identity = true) {
  const current = world as World;
  const extra = identity
    ? [
        ["user.name", "Fixture"],
        ["user.email", "fixture@example.invalid"],
      ]
    : [["user.useConfigOnly", "true"]];
  const env: Record<string, string> = { ...current.gitEnv };
  const base = Number(env.GIT_CONFIG_COUNT ?? "0");
  extra.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${base + index}`] = key as string;
    env[`GIT_CONFIG_VALUE_${base + index}`] = value as string;
  });
  env.GIT_CONFIG_COUNT = String(base + extra.length);
  return processContentGit({
    path: Bun.env.PATH,
    home: current.home,
    platform: process.platform,
    run: runTool,
    env,
  });
}

/** An install that writes the lockfile Bun would, mirroring package.json
 * (there is no network in tests), or fails. */
function fakeInstall(installs: string[], fail?: string) {
  return async (app: string, toolchain: "bun" | "uv") => {
    installs.push(toolchain);
    if (fail !== undefined) return { ok: false as const, detail: fail };
    if (toolchain === "uv") {
      await writeFile(
        join(app, "uv.lock"),
        'version = 1\nrequires-python = ">=3.12"\n',
      );
      return { ok: true as const };
    }
    const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    await writeFile(
      join(app, "bun.lock"),
      `${JSON.stringify(
        {
          lockfileVersion: 1,
          workspaces: {
            "": {
              name: pkg.name,
              dependencies: pkg.dependencies,
              devDependencies: pkg.devDependencies,
            },
          },
          packages: {},
        },
        null,
        2,
      )}\n`,
    );
    return { ok: true as const };
  };
}

function runHost(
  setup: Awaited<ReturnType<typeof scenario>>,
  overrides: Partial<ModuleCreateRunHost> = {},
  installs: string[] = [],
): ModuleCreateRunHost {
  return {
    ...setup.host,
    github: setup.github,
    git: operatorGit(),
    lockDirectory: (world as World).lockDirectory,
    install: fakeInstall(installs),
    ...overrides,
  };
}

async function created(
  setup: Awaited<ReturnType<typeof scenario>>,
  request: Partial<Parameters<typeof planModuleCreate>[0]> & {
    confirm?: string;
  } = {},
  host: ModuleCreateRunHost = runHost(setup),
) {
  const plan = await dryRun(setup, request);
  expect(plan.status).toBe("actionable");
  const steps: ModuleCreateStep[] = [];
  const report = await createPersonalModule(
    {
      folder: setup.folder,
      cwd: setup.worktree,
      selector: "personalspace/notes",
      stack: "vite-react",
      ...request,
      confirm: request.confirm ?? (plan.plan as string),
    },
    host,
    (step) => steps.push(step),
  );
  return {
    plan,
    report,
    steps: steps
      .filter((step) => step.state !== "running")
      .map(
        (step) =>
          `${step.key} ${step.state}${step.code === undefined ? "" : ` ${step.code}`}`,
      ),
  };
}

async function gitOutput(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
  });
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { code, out: out.trim() };
}

/** The template's manifest with the pool and the slot of `notes`, as the
 * run writes it into the task worktree: every other byte as it was. */
const declaredManifest = `{
  "personal_generation": "gen3",
  "owner": "owner-github-username",
  "module_port_pool": {
    "start": 23000,
    "end": 23099
  },
  "module_slots": [
    {
      "path": "workspace/personal-notes",
      "category": "knowledge",
      "default_access": "private",
      "required_roles": [
        "owner"
      ],
      "source_of_truth": "git-native",
      "notes": "Example personal module slot; replace or remove when creating real private nested modules."
    },
    {
      "path": "workspace/notes",
      "slug": "notes",
      "space": "workspace",
      "category": "application",
      "default_access": "private",
      "required_roles": [
        "owner"
      ],
      "source_of_truth": "git-native",
      "status": "active",
      "notes": "Notes: osobní Modul založený příkazem lazurio module create (stack vite-react).",
      "git": {
        "url": "git@github.com:example/notes.git",
        "branch": "main"
      }
    }
  ]
}
`;

describe("the real run", () => {
  posixTest(
    "creates the confirmed plan: a private repository, main pushed, the module placed, the slot and the pool declared in the task worktree only",
    async () => {
      const setup = await scenario({ worktree: true });
      const installs: string[] = [];
      const { plan, report, steps } = await created(
        setup,
        {},
        runHost(setup, {}, installs),
      );
      expect(steps).toEqual([
        "plan done",
        "write done",
        "prepare done",
        "commit done",
        "create done",
        "place done",
        "push done",
        "declare done",
        "check done",
      ]);
      expect(report).toMatchObject({
        status: "completed",
        reason: "module_created",
        dry_run: false,
        repository: { full_name: "example/notes", private: true, create: true },
        lease: plan.lease,
        tree_hash: plan.tree_hash,
        plan: plan.plan,
        issues: [],
      });
      expect(installs).toEqual(["bun"]);
      // The only write asked of GitHub: the creation, once.
      expect(
        setup.calls.filter(
          (call) => !["viewer", "repository"].includes(call.kind),
        ),
      ).toEqual([
        {
          kind: "createRepository",
          args: ["notes", "Osobní Modul Lazuria."],
        },
      ]);
      // The repository has main with the first commit: every planned file
      // and the lockfile.
      const bare = join((world as World).remotes, "example", "notes.git");
      expect(
        (await gitOutput(bare, "--git-dir", bare, "log", "--format=%s", "main"))
          .out,
      ).toBe("Create notes with lazurio module create (vite-react)");
      expect(
        (
          await gitOutput(
            bare,
            "--git-dir",
            bare,
            "ls-tree",
            "-r",
            "--name-only",
            "main",
          )
        ).out.split("\n"),
      ).toEqual(
        [...plan.files.map((file) => file.path), "app/v1/bun.lock"].sort(),
      );
      // The module: a checkout of it in the Personalspace's workspace/.
      const module = join(setup.space, "workspace", "notes");
      expect(report.module_root).toBe(module);
      expect((await gitOutput(module, "branch", "--show-current")).out).toBe(
        "main",
      );
      expect((await gitOutput(module, "remote", "get-url", "origin")).out).toBe(
        "git@github.com:example/notes.git",
      );
      expect((await gitOutput(module, "status", "--porcelain")).out).toBe("");
      expect((await gitOutput(module, "rev-parse", "HEAD")).out).toBe(
        (await gitOutput(bare, "--git-dir", bare, "rev-parse", "main")).out,
      );
      expect((await readdir(join(setup.space, "workspace"))).sort()).toEqual([
        ".gitkeep",
        "notes",
      ]);
      // The slot and the pool, byte for byte, in the task worktree only.
      expect(
        await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
      ).toBe(declaredManifest);
      expect(
        await readFile(join(setup.space, "modules.manifest.json"), "utf8"),
      ).toBe(personalspaceTemplateManifest);
      expect((await gitOutput(setup.space, "status", "--porcelain")).out).toBe(
        "",
      );
      // The catalog lists it at once, executable.
      const catalog = await readFolderCatalog(setup.folder, setup.host.holder);
      expect(
        catalog.personalspace?.modules.find(
          (entry) => entry.module === "notes",
        ),
      ).toMatchObject({ organization: "personalspace", executable: true });
      expect(report.next_steps[0]).toContain(
        "open a pull request into example/example_GEN3",
      );
      expect(report.next_steps.join("\n")).toContain(
        "lazurio module start personalspace/notes --json",
      );
      // The same plan again: the module is there now.
      const again = await dryRun(setup);
      expect(again.reason).toBe("directory_exists");
    },
  );

  posixTest(
    "creation that fails, is taken meanwhile, or creates something GitHub should not have: nothing is placed, nothing is adopted",
    async () => {
      for (const [create, slug, status, reason] of [
        ["failed", "diary", "blocked", "create-failed"],
        ["taken", "journal", "blocked", "repository-exists"],
        ["public", "ledger", "action_required", "not-private"],
        ["other-owner", "atlas", "action_required", "create-failed"],
      ] as const) {
        const setup = await scenario({ worktree: true, create });
        const manifest = await readFile(
          join(setup.worktree, "modules.manifest.json"),
          "utf8",
        );
        const { report, steps } = await created(setup, {
          selector: `personalspace/${slug}`,
        });
        expect({
          create,
          status: report.status,
          reason: report.reason,
        }).toEqual({
          create,
          status,
          reason,
        });
        expect(steps.at(-1)).toBe(`create failed ${reason}`);
        // Nothing under workspace/, not even a temporary sibling.
        expect(await readdir(join(setup.space, "workspace"))).toEqual([
          ".gitkeep",
        ]);
        expect(
          await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
        ).toBe(manifest);
        // Nothing was pushed anywhere.
        for (const owner of ["example", "other"]) {
          const bare = join((world as World).remotes, owner, `${slug}.git`);
          if ((await lstat(bare).catch(() => null)) === null) continue;
          expect(
            (await gitOutput(bare, "--git-dir", bare, "show-ref")).out,
          ).toBe("");
        }
        expect(report.next_steps.length).toBeGreaterThan(0);
      }
    },
  );

  posixTest(
    "a failed push keeps the module placed and committed, with the exact command; the slot is declared",
    async () => {
      const setup = await scenario({ worktree: true });
      const host = runHost(setup, {
        github: {
          ...setup.github,
          remote: async () => ({ url: "git@github.com:missing/nothing.git" }),
        },
      });
      const { report, steps } = await created(
        setup,
        { selector: "personalspace/scratch" },
        host,
      );
      expect(report).toMatchObject({
        status: "action_required",
        reason: "module_created_with_issues",
        issues: [{ code: "push-failed" }],
      });
      expect(steps).toContain("push failed push-failed");
      expect(steps.at(-1)).toBe("check done");
      const module = join(setup.space, "workspace", "scratch");
      expect(report.next_steps[0]).toContain(
        `git -C '${module}' push -u origin main`,
      );
      expect((await gitOutput(module, "log", "--format=%s")).out).toBe(
        "Create scratch with lazurio module create (vite-react)",
      );
      expect(
        JSON.parse(
          await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
        ).module_slots.at(-1).path,
      ).toBe("workspace/scratch");
    },
  );

  posixTest(
    "a failed install is reported and the run goes on without the lockfile",
    async () => {
      const setup = await scenario({ worktree: true });
      const installs: string[] = [];
      const host = runHost(setup, {
        install: fakeInstall(installs, "it ended with exit code 1: offline"),
      });
      const { report, steps } = await created(
        setup,
        { selector: "personalspace/planner", stack: "bun-service" },
        host,
      );
      expect(report).toMatchObject({
        status: "action_required",
        issues: [{ code: "install-failed" }],
      });
      expect(steps).toContain("prepare failed install-failed");
      expect(steps).toContain("push done");
      const bare = join((world as World).remotes, "example", "planner.git");
      expect(
        (
          await gitOutput(
            bare,
            "--git-dir",
            bare,
            "ls-tree",
            "-r",
            "--name-only",
            "main",
          )
        ).out,
      ).not.toContain("bun.lock");
      expect(report.next_steps[0]).toContain("bun install");
    },
  );

  posixTest(
    "without a Git identity nothing is committed, created or placed",
    async () => {
      const setup = await scenario({ worktree: true });
      const { report, steps } = await created(
        setup,
        { selector: "personalspace/sketch", stack: "none" },
        runHost(setup, { git: operatorGit(false) }),
      );
      expect(report).toMatchObject({
        status: "blocked",
        reason: "commit-failed",
      });
      expect(steps).toEqual([
        "plan done",
        "write done",
        "prepare skipped",
        "commit failed commit-failed",
      ]);
      expect(setup.calls.map((call) => call.kind)).not.toContain(
        "createRepository",
      );
      expect(await readdir(join(setup.space, "workspace"))).toEqual([
        ".gitkeep",
      ]);
    },
  );

  posixTest(
    "the real run's own refusals: another plan, no task worktree, a detached worktree, a busy Folder",
    async () => {
      const setup = await scenario({ worktree: true });
      const before = await snapshot(setup.folder);
      const refused = async (
        request: Partial<ModuleCreateRunRequest>,
        reason: string,
      ) => {
        const plan = await dryRun(setup);
        const report = await createPersonalModule(
          {
            folder: setup.folder,
            cwd: setup.worktree,
            selector: "personalspace/notes",
            stack: "vite-react",
            confirm: plan.plan as string,
            ...request,
          },
          runHost(setup),
        );
        expect({ status: report.status, reason: report.reason }).toEqual({
          status: "blocked",
          reason,
        });
      };
      await refused({ confirm: `sha256:${"0".repeat(64)}` }, "plan-changed");
      // Another name gives another plan.
      await refused({ name: "Jiné" }, "plan-changed");
      await refused(
        { cwd: setup.folder },
        "personalspace_root_not_task_worktree",
      );
      await refused(
        { cwd: setup.space },
        "personalspace_root_not_task_worktree",
      );
      const lock = await tryContentLock(
        (world as World).lockDirectory,
        setup.folder,
      );
      try {
        await refused({}, "content-busy");
      } finally {
        await lock?.release();
      }
      expect(await snapshot(setup.folder)).toEqual(before);
      expect(setup.calls.map((call) => call.kind)).not.toContain(
        "createRepository",
      );
      const detached = join(
        setup.folder,
        "personalspace",
        ".worktrees",
        "detached",
      );
      await gitOutput(
        setup.space,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        detached,
      );
      await refused({ cwd: detached }, "personalspace_root_on_main");
    },
  );

  posixTest(
    "through the CLI: steps as JSON lines, then the report; exit 0 created, 1 with a step left, 2 refused",
    async () => {
      const setup = await scenario({ worktree: true });
      const cli = async (args: string[], host = runHost(setup)) => {
        const lines: string[] = [];
        const code = await runModuleCreateCommand(
          ["module", "create", ...args, "--folder", setup.folder, "--json"],
          {
            identity: {
              version: "1.0.0",
              commit: "0".repeat(40),
              target: "fixture",
            },
            platform: process.platform,
            env: { HOME: (world as World).home },
            executable: join((world as World).home, "lazurio"),
            hostedFolder: async () => undefined,
            cwd: setup.worktree,
          },
          (line) => lines.push(line),
          () => host,
        );
        return { code, lines: lines.map((line) => JSON.parse(line)) };
      };
      const dry = await cli([
        "personalspace/memo",
        "--stack",
        "none",
        "--dry-run",
      ]);
      expect(dry.code).toBe(0);
      const plan = dry.lines.at(-1).plan as string;
      expect(dry.lines.at(-1).next_steps.join("\n")).toContain(
        `lazurio module create personalspace/memo --stack none --confirm ${plan} --json`,
      );
      const run = await cli([
        "personalspace/memo",
        "--stack",
        "none",
        "--confirm",
        plan,
      ]);
      expect(run.code).toBe(0);
      expect(
        run.lines
          .filter(
            (line) =>
              line.kind === "module-create-step" && line.state !== "running",
          )
          .map((line) => `${line.key} ${line.state}`),
      ).toEqual([
        "plan done",
        "write done",
        "prepare skipped",
        "commit done",
        "create done",
        "place done",
        "push done",
        "declare done",
        "check done",
      ]);
      expect(run.lines.at(-1)).toMatchObject({ status: "completed" });
      const again = await cli([
        "personalspace/memo",
        "--stack",
        "none",
        "--confirm",
        plan,
      ]);
      expect(again.code).toBe(2);
      expect(again.lines.at(-1)).toMatchObject({ reason: "directory_exists" });
      // A push GitHub refuses leaves a step to the person: exit 1.
      const unpushed = runHost(setup, {
        github: {
          ...setup.github,
          remote: async () => ({ url: "git@github.com:missing/nothing.git" }),
        },
      });
      const draft = await cli(
        ["personalspace/draft", "--stack", "none", "--dry-run"],
        unpushed,
      );
      const left = await cli(
        [
          "personalspace/draft",
          "--stack",
          "none",
          "--confirm",
          draft.lines.at(-1).plan as string,
        ],
        unpushed,
      );
      expect(left.code).toBe(1);
      expect(left.lines.at(-1)).toMatchObject({
        status: "action_required",
        issues: [{ code: "push-failed" }],
      });
    },
  );
});
