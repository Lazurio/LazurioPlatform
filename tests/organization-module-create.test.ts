import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { processContentGit } from "../src/content/git";
import type { MembershipAnswer } from "../src/content/role";
import type { PresetName } from "../src/folder/presets";
import {
  type ModuleCreateHost,
  type ModuleCreateReport,
  type ModuleCreateRequest,
  planModuleCreate,
} from "../src/modules/module-create";
import { runModuleCreateCommand } from "../src/modules/module-create-cli";
import {
  createModule,
  type DataInitRequest,
  type ModuleCreateRunHost,
  type ModuleCreateStep,
} from "../src/modules/module-create-run";
import { insertModuleSlotText, type ModuleSlot } from "../src/modules/scaffold";
import { readFolderCatalog } from "../src/organizations/catalog";
import { expectedLegacyProjection } from "../src/organizations/legacy-projection";
import { resolveOrganizationRoot } from "../src/organizations/root-resolution";
import { runTool } from "../src/tools/status";
import { canonicalDocument, writeModule } from "./fixtures/catalog-folder";
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

// `lazurio module create <Organization>/<slug>` (decision F52's addendum of
// 2026-10-14, #267): the plan, every refusal before anything is written, and
// the real run only for the plan the person confirmed. A world without a
// network (tests/fixtures/content-world.ts): a stub GitHub that logs every
// call and creates bare repositories, the product's git for real, and an
// Organization root checkout `organizations/Acme_GEN3` in `transition` (its
// projection `company.gen3.json` beside the canonical manifest) with one
// module and a task worktree in `.worktrees/root/<task>`. Synthetic names
// only.

const supported = ["darwin", "linux"].includes(process.platform);
const posixTest = test.skipIf(!supported);
let world: World | undefined;
beforeAll(async () => {
  if (supported) world = await createWorld();
});
afterAll(async () => {
  await world?.close();
});

const viewer = { login: "owner", databaseId: 777 };
const webPort = 24_510;

type Scenario = {
  preset?: PresetName;
  membership?: MembershipAnswer;
  /** The Teams GitHub knows, `<org>/<slug>` with their id. */
  githubTeams?: Record<string, number | "unavailable">;
  refuseGrants?: readonly string[];
  create?: NonNullable<Parameters<typeof stubGitHub>[1]>["create"];
  repositories?: NonNullable<Parameters<typeof stubGitHub>[1]>["repositories"];
  /** Changes to the canonical manifest before it is written. */
  canonical?: (document: Record<string, unknown>) => void;
  /** No `company.gen3.json`: the root is `current`. */
  current?: boolean;
  gitignore?: string;
  worktree?: boolean;
};

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(
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
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: cwd,
        // git@github.com: reaches the world's bare repositories.
        ...(world?.gitEnv ?? {}),
      },
    },
  );
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${error}`);
  return out.trim();
};

/** The Organization's documents, formatted as people write them. */
function organizationDocuments(options: Scenario) {
  const canonical: Record<string, unknown> & {
    compatibility: { legacy_projection: { sha256: string } };
  } = canonicalDocument(
    "acme",
    "organization",
    [
      {
        slug: "core",
        display_name: "Core",
        // Bound: GitHub calls this Team core-builders.
        forge_binding: {
          schema_version: "lazurio.team-forge-binding.github.v0",
          provider: "github",
          team: { id: "501", asserted_slug: "core-builders" },
        },
      } as { slug: string; display_name: string },
      { slug: "sales", display_name: "Sales" },
    ],
    "Acme",
  );
  canonical.root_repository = {
    forge: "github",
    locator: "Acme/Acme_GEN3",
    default_branch: "main",
    binding_state: "unverified",
  };
  canonical.module_port_pool = { start: 24_500, end: 24_599 };
  options.canonical?.(canonical);
  const modules = {
    organization_generation: "gen3",
    company: "acme",
    github_org: (
      canonical.organization as { forge_binding: { locator: string } }
    ).forge_binding.locator,
    module_slots: [
      {
        path: "workspace/web",
        slug: "web",
        teams: ["core"],
        category: "application",
        default_access: "expected",
        required_roles: ["*"],
        source_of_truth: "git-native",
        notes: "Web.",
        git: { url: "git@github.com:Acme/web.git", branch: "main" },
      },
      // Declared, not created yet: no repository, no directory.
      { path: "workspace/later", slug: "later", status: "planned_slot" },
    ],
  };
  const projection = expectedLegacyProjection(canonical, modules);
  canonical.compatibility.legacy_projection.sha256 = projection.hash;
  return {
    canonical: `${JSON.stringify(canonical, null, 2)}\n`,
    modules: `${JSON.stringify(modules, null, 2)}\n`,
    legacy: `${JSON.stringify(projection.projection, null, 2)}\n`,
  };
}

/** A Folder of `preset` with the Organization root checkout, its module
 * `web` (holding a lease), its task worktree when asked, and a stub GitHub
 * on which the viewer is an active Owner of Acme with the Teams core-builders
 * and sales. */
async function scenario(options: Scenario = {}) {
  const current = world as World;
  const preset = options.preset ?? "local";
  const folder = await presetFolder(
    current,
    preset,
    preset === "local"
      ? null
      : preset === "hosted-organization-team"
        ? bindings.team
        : bindings.organization,
  );
  await mkdir(join(folder, "organizations"), { recursive: true });
  const root = join(folder, "organizations", "Acme_GEN3");
  await mkdir(root);
  const documents = organizationDocuments(options);
  await writeFile(join(root, "lazurio.organization.json"), documents.canonical);
  await writeFile(join(root, "modules.manifest.json"), documents.modules);
  if (!options.current)
    await writeFile(join(root, "company.gen3.json"), documents.legacy);
  await writeFile(
    join(root, ".gitignore"),
    options.gitignore ?? "/workspace/*/\n/.worktrees/\n",
  );
  await git(root, "init", "--quiet");
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "Organization root");
  await writeModule(join(root, "workspace", "web"), "acme", { id: "web" });
  // The module's lease, at a port of the pool the plan must avoid.
  const webManifest = join(root, "workspace", "web", "lazurio.module.json");
  const web = JSON.parse(await readFile(webManifest, "utf8"));
  web.port_leases[0].port = webPort;
  await writeFile(webManifest, JSON.stringify(web));
  const worktree = join(root, ".worktrees", "root", "portal-task");
  if (options.worktree) {
    await mkdir(join(root, ".worktrees", "root"), { recursive: true });
    await git(
      root,
      "worktree",
      "add",
      "--quiet",
      "-b",
      "agent/portal",
      worktree,
    );
  }
  const { github, calls, grants } = stubGitHub(current, {
    viewer: { kind: "signed-in", viewer },
    membership: options.membership ?? {
      kind: "member",
      state: "active",
      role: "admin",
    },
    teams: options.githubTeams ?? {
      "Acme/core-builders": 501,
      "Acme/sales": 502,
    },
    ...(options.refuseGrants === undefined
      ? {}
      : { refuseGrants: options.refuseGrants }),
    ...(options.create === undefined ? {} : { create: options.create }),
    ...(options.repositories === undefined
      ? {}
      : { repositories: options.repositories }),
  });
  const content = contentHost(current, github);
  const host: ModuleCreateHost = {
    holder: async () => ({ kind: "absent" }),
    github,
    git: content.git,
  };
  return {
    folder,
    root,
    worktree,
    documents,
    host,
    github,
    calls,
    grants,
  };
}

type Setup = Awaited<ReturnType<typeof scenario>>;

const request = (
  setup: Setup,
  overrides: Partial<ModuleCreateRequest> = {},
): ModuleCreateRequest => ({
  folder: setup.folder,
  cwd: setup.worktree,
  selector: "acme/portal",
  stack: "vite-react",
  teams: ["core", "sales"],
  ...overrides,
});

const dryRun = (setup: Setup, overrides: Partial<ModuleCreateRequest> = {}) =>
  planModuleCreate(request(setup, overrides), setup.host);

/** Every entry below `root` with its size and change time. */
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
      const report = await dryRun(setup, { name: "Zákaznický portál" });
      expect(await snapshot(setup.folder)).toEqual(before);
      expect(setup.calls).toEqual([
        { kind: "viewer", args: [] },
        { kind: "membership", args: ["Acme"] },
        { kind: "team", args: ["Acme", "core-builders"] },
        { kind: "team", args: ["Acme", "sales"] },
        { kind: "repository", args: ["Acme", "portal"] },
      ]);
      const worktree = await realpath(setup.worktree);
      expect(report).toMatchObject({
        schema_version: "lazurio.module_create.report.v1",
        status: "actionable",
        reason: "scaffold_planned",
        dry_run: true,
        scope: "organization",
        module: {
          name: "acme/portal",
          slug: "portal",
          stack: "vite-react",
          display_name: "Zákaznický portál",
        },
        organization: { slug: "acme", github: "Acme", directory: "Acme_GEN3" },
        repository: { full_name: "Acme/portal", private: true, create: true },
        teams: [
          { slug: "core", github_slug: "core-builders", permission: "push" },
          { slug: "sales", github_slug: "sales", permission: "push" },
        ],
        slot: {
          path: "workspace/portal",
          slug: "portal",
          space: "workspace",
          teams: ["core", "sales"],
          category: "application",
          default_access: "expected",
          required_roles: ["*"],
          source_of_truth: "git-native",
          status: "active",
          git: { url: "git@github.com:Acme/portal.git", branch: "main" },
        },
        manifest: {
          path: join(worktree, "modules.manifest.json"),
          module_port_pool: { start: 24_500, end: 24_599 },
          adds_pool: false,
        },
        worktree: { path: worktree, branch: "agent/portal" },
        module_root: join(setup.root, "workspace", "portal"),
        issues: [],
      });
      expect(report.lease?.port).toBeGreaterThanOrEqual(24_500);
      expect(report.lease?.port).toBeLessThanOrEqual(24_599);
      expect(report.plan).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.next_steps.join("\n")).toContain(
        `--teams core,sales --name 'Zákaznický portál' --confirm ${report.plan} --json`,
      );
      expect(report.next_steps.join("\n")).not.toContain("worktree add");
      // The same state gives the same plan; other Teams another.
      expect((await dryRun(setup, { name: "Zákaznický portál" })).plan).toBe(
        report.plan,
      );
      expect(
        (await dryRun(setup, { name: "Zákaznický portál", teams: ["core"] }))
          .plan,
      ).not.toBe(report.plan);
    },
  );

  posixTest(
    "the lease avoids every module's port; outside a task worktree it says where the worktree goes",
    async () => {
      const setup = await scenario();
      // A port of the pool another module holds is refused by name.
      expect(
        (await dryRun(setup, { cwd: setup.folder, port: webPort })).reason,
      ).toBe("port_taken");
      const report = await dryRun(setup, { cwd: setup.folder });
      expect(report.status).toBe("actionable");
      expect(report.lease?.port).not.toBe(webPort);
      expect(report.worktree).toBeNull();
      expect(report.manifest?.path).toBe(
        join(setup.root, "modules.manifest.json"),
      );
      expect(report.next_steps[0]).toContain(
        `worktree add -b <branch> '${join(setup.root, ".worktrees", "root", "<task>")}' main`,
      );
    },
  );
});

describe("refusals, before anything is written", () => {
  const refusal = async (
    options: Scenario,
    reason: string,
    overrides: Partial<ModuleCreateRequest> = {},
  ) => {
    const setup = await scenario({ worktree: true, ...options });
    const before = await snapshot(setup.folder);
    const report = await dryRun(setup, overrides);
    expect({ status: report.status, reason: report.reason }).toEqual({
      status: "blocked",
      reason,
    });
    expect(report.issues[0]?.code).toBe(reason);
    expect(await snapshot(setup.folder)).toEqual(before);
    expect(
      setup.calls.every((call) =>
        ["viewer", "membership", "team", "repository"].includes(call.kind),
      ),
    ).toBe(true);
    return { report, setup };
  };

  posixTest("the Teams, the Organization and the Environment", async () => {
    const teamless = await refusal({}, "teams-required", { teams: [] });
    expect(teamless.setup.calls).toEqual([]);
    const team = await refusal(
      { preset: "hosted-organization-team" },
      "team-environment",
    );
    expect(team.setup.calls).toEqual([]);
    expect(team.report.scope).toBe("organization");
    // A Folder whose preset cannot be read might be a Team Environment.
    const unreadable = await scenario({ worktree: true });
    await writeFile(
      join(unreadable.folder, ".lazurio", "preferences.json"),
      "{not json",
    );
    const blind = await dryRun(unreadable);
    expect(blind.reason).toBe("folder-unavailable");
    expect(unreadable.calls).toEqual([]);
    const blindRun = await createModule(
      { ...request(unreadable), confirm: `sha256:${"0".repeat(64)}` },
      runHost(unreadable),
    );
    expect(blindRun.reason).toBe("folder-unavailable");
    expect(unreadable.calls.map((call) => call.kind)).not.toContain(
      "createRepository",
    );
    const missing = await refusal({}, "organization_not_found", {
      selector: "Globex/portal",
    });
    expect(missing.setup.calls).toEqual([]);
    // By the directory's name too, as the Launchpad selects it, and by the
    // GitHub login the "+ Nový modul" prompt names.
    const other = await scenario({
      worktree: true,
      githubTeams: { "AcmeHQ/core-builders": 501, "AcmeHQ/sales": 502 },
      canonical: (document) => {
        (
          document.organization as { forge_binding: { locator: string } }
        ).forge_binding.locator = "AcmeHQ";
        (document.root_repository as { locator: string }).locator =
          "AcmeHQ/Acme_GEN3";
      },
    });
    for (const selector of ["Acme_GEN3/portal", "acmehq/portal"])
      expect((await dryRun(other, { selector })).status, selector).toBe(
        "actionable",
      );
    // A pool overlapping the personal range (HumanAndMachines/Lazurio#545).
    await refusal(
      {
        canonical: (document) => {
          document.module_port_pool = { start: 23_050, end: 23_149 };
        },
      },
      "organization-pool-invalid",
    );
    // A module with an app needs the Organization's pool.
    await refusal(
      {
        canonical: (document) => {
          delete document.module_port_pool;
        },
      },
      "pool_missing",
    );
  });

  posixTest("who asks: an active Owner, by GitHub's answer", async () => {
    for (const membership of [
      { kind: "member", state: "active", role: "member" },
      { kind: "member", state: "pending", role: "admin" },
      { kind: "none" },
    ] as const) {
      const { setup } = await refusal(
        { membership },
        "organization-owner-required",
      );
      expect(setup.calls.map((call) => call.kind)).toEqual([
        "viewer",
        "membership",
      ]);
    }
    await refusal(
      { membership: { kind: "unavailable" } },
      "github-unavailable",
    );
  });

  posixTest("the Teams of the manifest, as GitHub knows them", async () => {
    await refusal({}, "unknown_team", { teams: ["core", "marketing"] });
    await refusal({}, "invalid_team", { teams: ["core", "core"] });
    await refusal(
      { githubTeams: { "Acme/core-builders": 501 } },
      "team-not-on-github",
    );
    await refusal(
      { githubTeams: { "Acme/core-builders": 999, "Acme/sales": 502 } },
      "team-binding-mismatch",
    );
    await refusal(
      {
        githubTeams: {
          "Acme/core-builders": "unavailable",
          "Acme/sales": 502,
        },
      },
      "github-unavailable",
    );
  });

  posixTest("the name, the directory and the repository", async () => {
    await refusal({}, "reserved_slug", { selector: "acme/infra" });
    await refusal({}, "directory_exists", { selector: "acme/web" });
    await refusal({}, "slot_exists", { selector: "acme/later" });
    // GitHub has it already (letter case ignored).
    const taken = await scenario({
      worktree: true,
      repositories: { "Acme/Portal": {} },
    });
    expect((await dryRun(taken)).reason).toBe("repository-exists");
    const occupied = await scenario({ worktree: true });
    await mkdir(join(occupied.root, "workspace", "Portal"));
    expect((await dryRun(occupied)).reason).toBe("directory_exists");
    await refusal(
      { gitignore: "/.worktrees/\n" },
      "organization-workspace-tracked",
    );
  });

  posixTest(
    "a task branch whose documents do not resolve cleanly",
    async () => {
      const setup = await scenario({ worktree: true });
      // The slot added by hand, without the projection: `conflict`.
      const path = join(setup.worktree, "modules.manifest.json");
      const document = JSON.parse(await readFile(path, "utf8"));
      document.module_slots.push({
        path: "workspace/hand",
        slug: "hand",
        git: { url: "git@github.com:Acme/hand.git", branch: "main" },
      });
      await writeFile(path, JSON.stringify(document, null, 2));
      expect((await dryRun(setup)).reason).toBe(
        "organization_manifest_not_mutation_safe",
      );
    },
  );
});

// ---- the real run ------------------------------------------------------------

function operatorGit() {
  const current = world as World;
  const env: Record<string, string> = { ...current.gitEnv };
  const base = Number(env.GIT_CONFIG_COUNT ?? "0");
  [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
  ].forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${base + index}`] = key as string;
    env[`GIT_CONFIG_VALUE_${base + index}`] = value as string;
  });
  env.GIT_CONFIG_COUNT = String(base + 2);
  return processContentGit({
    path: Bun.env.PATH,
    home: current.home,
    platform: process.platform,
    run: runTool,
    env,
  });
}

/** An install that writes the lockfile Bun would (no network in tests). */
const install =
  (during?: () => Promise<void>) =>
  async (app: string, toolchain: "bun" | "uv") => {
    await during?.();
    await writeFile(
      join(app, toolchain === "uv" ? "uv.lock" : "bun.lock"),
      "lockfile\n",
    );
    return { ok: true as const };
  };

function runHost(
  setup: Setup,
  overrides: Partial<ModuleCreateRunHost> = {},
): ModuleCreateRunHost {
  return {
    ...setup.host,
    github: setup.github,
    git: operatorGit(),
    lockDirectory: (world as World).lockDirectory,
    install: install(),
    initData: async () => ({ ok: false, detail: "no data in this test" }),
    ...overrides,
  };
}

async function created(
  setup: Setup,
  overrides: Partial<ModuleCreateRequest> & { confirm?: string } = {},
  host: ModuleCreateRunHost = runHost(setup),
) {
  const plan = await dryRun(setup, { ...overrides, cwd: setup.worktree });
  const steps: ModuleCreateStep[] = [];
  const report = await createModule(
    {
      ...request(setup, overrides),
      confirm: overrides.confirm ?? (plan.plan as string),
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

/** The files `git status` names as changed in `checkout`. */
const changedFiles = async (checkout: string) =>
  (await git(checkout, "status", "--porcelain"))
    .split("\n")
    .map((line) => line.trim().replace(/^\S+\s+/, ""))
    .sort();

const bareLog = (bare: string) =>
  git(bare, "--git-dir", bare, "log", "--format=%s", "main");

describe("the real run", () => {
  posixTest(
    "creates the confirmed plan: the Organization's private repository, main pushed, the Teams granted, the module placed, the slot and the projection declared in the task worktree only",
    async () => {
      const setup = await scenario({ worktree: true });
      const { plan, report, steps } = await created(setup);
      expect(steps).toEqual([
        "plan done",
        "write done",
        "prepare done",
        "commit done",
        "create done",
        "place done",
        "push done",
        "grant done",
        "declare done",
        "check done",
      ]);
      expect(report).toMatchObject({
        status: "completed",
        reason: "module_created",
        dry_run: false,
        scope: "organization",
        repository: { full_name: "Acme/portal", private: true, create: true },
        plan: plan.plan,
        issues: [],
      });
      // GitHub's writes: the creation in the Organization, then the grants.
      expect(
        setup.calls.filter((call) =>
          ["createRepository", "grantTeam"].includes(call.kind),
        ),
      ).toEqual([
        {
          kind: "createRepository",
          args: ["portal", "Modul Lazuria.", "Acme"],
        },
        {
          kind: "grantTeam",
          args: ["Acme", "core-builders", "Acme/portal", "push"],
        },
        { kind: "grantTeam", args: ["Acme", "sales", "Acme/portal", "push"] },
      ]);
      expect(setup.grants).toEqual([
        "Acme/core-builders Acme/portal push",
        "Acme/sales Acme/portal push",
      ]);
      const bare = join((world as World).remotes, "Acme", "portal.git");
      expect(await bareLog(bare)).toBe(
        "Create portal with lazurio module create (vite-react)",
      );
      // The module: a checkout in the Organization root's workspace/,
      // which the root's Git ignores.
      const module = join(setup.root, "workspace", "portal");
      expect(report.module_root).toBe(module);
      expect(await git(module, "config", "--get", "remote.origin.url")).toBe(
        "git@github.com:Acme/portal.git",
      );
      expect(await git(module, "status", "--porcelain")).toBe("");
      expect(
        JSON.parse(await readFile(join(module, "lazurio.module.json"), "utf8")),
      ).toMatchObject({ id: "portal", company: "acme" });
      expect(await git(setup.root, "status", "--porcelain")).toBe("");
      // The primary checkout's documents are untouched.
      expect(
        await readFile(join(setup.root, "modules.manifest.json"), "utf8"),
      ).toBe(setup.documents.modules);
      // The task worktree: the slot byte for byte, the projection after it.
      const slot = report.slot as ModuleSlot;
      expect(
        await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
      ).toBe(insertModuleSlotText(setup.documents.modules, slot));
      const canonical = await readFile(
        join(setup.worktree, "lazurio.organization.json"),
        "utf8",
      );
      const changed = canonical
        .split("\n")
        .filter(
          (line, index) =>
            line !== setup.documents.canonical.split("\n")[index],
        );
      expect(changed).toHaveLength(1);
      expect(changed[0]).toContain('"sha256": "sha256:');
      const resolved = await resolveOrganizationRoot(setup.worktree);
      expect(resolved).toMatchObject({
        kind: "root-resolved",
        state: "transition",
        issues: [],
      });
      expect(await changedFiles(setup.worktree)).toEqual([
        "company.gen3.json",
        "lazurio.organization.json",
        "modules.manifest.json",
      ]);
      expect(report.next_steps[0]).toContain(
        "open a pull request into Acme/Acme_GEN3",
      );
      // The merge: the catalog lists the module, executable.
      expect(
        (await readFolderCatalog(setup.folder)).organizations[0]?.modules.map(
          (entry) => entry.module,
        ),
      ).toEqual(["web", "later"]);
      await git(setup.worktree, "commit", "--quiet", "-am", "Declare portal");
      await git(setup.root, "merge", "--quiet", "--ff-only", "agent/portal");
      const merged = (await readFolderCatalog(setup.folder)).organizations[0];
      expect(merged).toMatchObject({ state: "transition", executable: true });
      expect(
        merged?.modules.find((entry) => entry.module === "portal"),
      ).toMatchObject({
        organization: "acme",
        teams: ["core", "sales"],
        executable: true,
      });
      expect(report.next_steps.join("\n")).toContain(
        "lazurio module start acme/portal --json",
      );
    },
  );

  posixTest(
    "a root without the projection (current) gets only its slot and the digest",
    async () => {
      const setup = await scenario({ worktree: true, current: true });
      const { report } = await created(setup, {
        selector: "acme/current-notes",
        stack: "none",
      });
      expect(report.status).toBe("completed");
      expect(await changedFiles(setup.worktree)).toEqual([
        "lazurio.organization.json",
        "modules.manifest.json",
      ]);
      expect(await resolveOrganizationRoot(setup.worktree)).toMatchObject({
        state: "current",
        issues: [],
      });
    },
  );

  posixTest(
    "a grant GitHub refuses leaves the module created and declared, with the exact command",
    async () => {
      const setup = await scenario({
        worktree: true,
        refuseGrants: ["Acme/sales"],
      });
      const { report, steps } = await created(setup, {
        selector: "acme/granted",
      });
      expect(steps).toContain("grant failed grant-failed");
      expect(steps.slice(-2)).toEqual(["declare done", "check done"]);
      expect(report).toMatchObject({
        status: "action_required",
        reason: "module_created_with_issues",
        issues: [{ code: "grant-failed" }],
      });
      expect(report.next_steps[0]).toBe(
        "Grant it as an Owner of Acme: gh api --method PUT orgs/Acme/teams/sales/repos/Acme/granted --raw-field permission=push",
      );
      expect(setup.grants).toEqual(["Acme/core-builders Acme/granted push"]);
    },
  );

  posixTest(
    "a creation that fails or creates something GitHub should not have: nothing placed, nothing declared, nothing adopted",
    async () => {
      for (const [create, status, reason] of [
        ["failed", "blocked", "create-failed"],
        ["taken", "action_required", "create-uncertain"],
        ["public", "action_required", "not-private"],
        ["other-owner", "action_required", "create-failed"],
      ] as const) {
        const setup = await scenario({ worktree: true, create });
        const { report } = await created(setup, {
          selector: `acme/refused-${create}`,
          stack: "none",
        });
        expect({
          create,
          status: report.status,
          reason: report.reason,
        }).toEqual({ create, status, reason });
        expect(await readdir(join(setup.root, "workspace"))).toEqual(["web"]);
        expect(await git(setup.worktree, "status", "--porcelain")).toBe("");
        expect(setup.grants).toEqual([]);
      }
    },
  );

  posixTest(
    "documents changed during the run: the module stays, nothing is written over them",
    async () => {
      const setup = await scenario({ worktree: true });
      const path = join(setup.worktree, "modules.manifest.json");
      const host = runHost(setup, {
        install: install(async () => {
          await writeFile(path, `${await readFile(path, "utf8")}\n`);
        }),
      });
      const { report, steps } = await created(
        setup,
        { selector: "acme/changed" },
        host,
      );
      expect(steps).toContain("declare failed manifest_changed");
      expect(steps).toContain("check failed check-failed");
      expect(report.status).toBe("action_required");
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "manifest_changed",
        "check-failed",
      ]);
      expect(await readFile(path, "utf8")).toBe(`${setup.documents.modules}\n`);
      expect(
        await readFile(
          join(setup.worktree, "lazurio.organization.json"),
          "utf8",
        ),
      ).toBe(setup.documents.canonical);
    },
  );

  posixTest(
    "the run's own refusals: the confirmed plan, a task worktree in .worktrees/root on a branch of its own",
    async () => {
      const setup = await scenario({ worktree: true });
      const plan = (await dryRun(setup)).plan as string;
      const refused = async (
        overrides: Partial<ModuleCreateRequest> & { confirm?: string },
        reason: string,
      ) => {
        const report = await createModule(
          { ...request(setup, overrides), confirm: overrides.confirm ?? plan },
          runHost(setup),
        );
        expect({ reason: report.reason, status: report.status }).toEqual({
          reason,
          status: "blocked",
        });
      };
      await refused({ confirm: `sha256:${"0".repeat(64)}` }, "plan-changed");
      // From the primary checkout: its plan, then no worktree.
      const primaryPlan = (await dryRun(setup, { cwd: setup.root }))
        .plan as string;
      await refused(
        { cwd: setup.root, confirm: primaryPlan },
        "organization_root_not_task_worktree",
      );
      const elsewhere = join(setup.folder, "portal-elsewhere");
      await git(
        setup.root,
        "worktree",
        "add",
        "--quiet",
        "-b",
        "agent/elsewhere",
        elsewhere,
      );
      await refused({ cwd: elsewhere }, "organization_worktree_misplaced");
      const detached = join(setup.root, ".worktrees", "root", "detached");
      await git(setup.root, "worktree", "add", "--quiet", "--detach", detached);
      await refused({ cwd: detached }, "organization_root_on_main");
      expect(setup.calls.map((call) => call.kind)).not.toContain(
        "createRepository",
      );
    },
  );

  posixTest(
    "through the CLI: --teams reaches the plan and the run",
    async () => {
      const setup = await scenario({ worktree: true });
      const cli = async (args: string[]) => {
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
          () => runHost(setup),
        );
        return { code, lines: lines.map((line) => JSON.parse(line)) };
      };
      const dry = await cli([
        "Acme/handbook",
        "--stack",
        "none",
        "--teams",
        "sales",
        "--dry-run",
      ]);
      expect(dry.code).toBe(0);
      const report = dry.lines.at(-1) as ModuleCreateReport;
      expect(report.teams).toEqual([
        { slug: "sales", github_slug: "sales", permission: "push" },
      ]);
      expect(report.next_steps.join("\n")).toContain(
        `lazurio module create Acme/handbook --stack none --teams sales --confirm ${report.plan} --json`,
      );
      const run = await cli([
        "Acme/handbook",
        "--stack",
        "none",
        "--teams",
        "sales",
        "--confirm",
        report.plan as string,
      ]);
      expect(run.code).toBe(0);
      expect(run.lines.at(-1)).toMatchObject({ status: "completed" });
      expect(setup.grants).toEqual(["Acme/sales Acme/handbook push"]);
    },
  );
});

// ---- a module with data (--data) ----------------------------------------------

/** `repository-db init` as the engine does it against an empty repository
 * (no network, no engine installed in tests): clone it into the mount,
 * bootstrap `v3` with the config, push it. */
function fakeInit(requests: DataInitRequest[], fail?: string) {
  return async (request: DataInitRequest) => {
    requests.push(request);
    if (fail !== undefined) return { ok: false as const, detail: fail };
    await git(
      dirname(request.mount),
      "clone",
      "--quiet",
      request.remote,
      request.mount,
    );
    await git(request.mount, "checkout", "--quiet", "-B", request.branch);
    await writeFile(
      join(request.mount, "repository-db.yaml"),
      `schema_version: repository-db.config.v1\napp: ${request.name}\ndata_repo:\n  remote: ${request.remote}\n  branch: ${request.branch}\nschema:\n  name: ${request.schemaName}\n  version: ${request.schemaVersion}\n`,
    );
    await writeFile(join(request.mount, ".gitignore"), "/.repository-db/\n");
    await git(request.mount, "add", "--all");
    await git(request.mount, "commit", "--quiet", "-m", "bootstrap");
    await git(request.mount, "push", "--quiet", "-u", "origin", request.branch);
    return { ok: true as const };
  };
}

describe("a module with data (--data)", () => {
  posixTest(
    "the dry run plans the data repository and asks GitHub whether it exists",
    async () => {
      const setup = await scenario({ worktree: true });
      const report = await dryRun(setup, { data: true });
      expect(report.status).toBe("actionable");
      expect(setup.calls.at(-1)).toEqual({
        kind: "repository",
        args: ["Acme", "portal-data"],
      });
      expect(report.data).toMatchObject({
        repository: {
          full_name: "Acme/portal-data",
          private: true,
          create: true,
        },
        mount: join(setup.root, "workspace", "portal", "db"),
        branch: "v3",
        schema: { name: "portal-data", version: "0.1.0" },
        slot: {
          path: "workspace/portal/db",
          slug: "portal-data",
          teams: ["core", "sales"],
          materialization: "repository_db_mount",
        },
      });
      expect(report.plan).not.toBe((await dryRun(setup)).plan);
      expect(report.next_steps.join("\n")).toContain(
        "--teams core,sales --data --confirm",
      );
      // Its repository exists already: never taken over.
      const taken = await scenario({
        worktree: true,
        repositories: { "Acme/portal-data": {} },
      });
      expect((await dryRun(taken, { data: true })).reason).toBe(
        "data-repository-exists",
      );
      expect((await dryRun(taken, { data: true, stack: "none" })).reason).toBe(
        "data_needs_bun_app",
      );
    },
  );

  posixTest(
    "the run creates the data repository, grants it, mounts it as db/ on v3 and declares both slots",
    async () => {
      const setup = await scenario({ worktree: true });
      const requests: DataInitRequest[] = [];
      const { report, steps } = await created(
        setup,
        { selector: "acme/ledger", data: true },
        runHost(setup, { initData: fakeInit(requests) }),
      );
      expect(steps).toEqual([
        "plan done",
        "write done",
        "prepare done",
        "commit done",
        "create done",
        "place done",
        "push done",
        "grant done",
        "data done",
        "declare done",
        "check done",
      ]);
      expect(report).toMatchObject({ status: "completed", issues: [] });
      expect(
        setup.calls.filter((call) =>
          ["createRepository", "grantTeam"].includes(call.kind),
        ),
      ).toEqual([
        {
          kind: "createRepository",
          args: ["ledger", "Modul Lazuria.", "Acme"],
        },
        {
          kind: "grantTeam",
          args: ["Acme", "core-builders", "Acme/ledger", "push"],
        },
        { kind: "grantTeam", args: ["Acme", "sales", "Acme/ledger", "push"] },
        {
          kind: "createRepository",
          args: ["ledger-data", "Data Modulu Lazuria (repository-db).", "Acme"],
        },
        {
          kind: "grantTeam",
          args: ["Acme", "core-builders", "Acme/ledger-data", "push"],
        },
        {
          kind: "grantTeam",
          args: ["Acme", "sales", "Acme/ledger-data", "push"],
        },
      ]);
      const module = join(setup.root, "workspace", "ledger");
      expect(requests).toEqual([
        {
          app: join(module, "app", "v1"),
          name: "ledger",
          remote: "git@github.com:Acme/ledger-data.git",
          branch: "v3",
          mount: join(module, "db"),
          schemaName: "ledger-data",
          schemaVersion: "0.1.0",
        },
      ]);
      // The mount: a checkout of the data repository on v3, which the
      // module's Git ignores.
      expect(await git(join(module, "db"), "branch", "--show-current")).toBe(
        "v3",
      );
      expect(await git(module, "status", "--porcelain")).toBe("");
      const bare = join((world as World).remotes, "Acme", "ledger-data.git");
      expect(await git(bare, "--git-dir", bare, "branch", "--list")).toContain(
        "v3",
      );
      // The app depends on the engine; both slots are declared, and the
      // root still resolves cleanly with them.
      const pkg = JSON.parse(
        await readFile(join(module, "app", "v1", "package.json"), "utf8"),
      );
      expect(pkg.dependencies["@lazurio/repository-db"]).toMatch(
        /^github:Lazurio\/repository-db#v\d+\.\d+\.\d+$/,
      );
      const declared = JSON.parse(
        await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
      ).module_slots.map((slot: { path: string }) => slot.path);
      expect(declared.slice(-2)).toEqual([
        "workspace/ledger",
        "workspace/ledger/db",
      ]);
      expect(await resolveOrganizationRoot(setup.worktree)).toMatchObject({
        state: "transition",
        issues: [],
      });
      await git(setup.worktree, "commit", "--quiet", "-am", "Declare ledger");
      await git(setup.root, "merge", "--quiet", "--ff-only", "agent/portal");
      const merged = (await readFolderCatalog(setup.folder)).organizations[0];
      expect(merged).toMatchObject({ executable: true });
      expect(
        merged?.modules.find((entry) => entry.module === "ledger"),
      ).toMatchObject({ executable: true });
    },
  );

  posixTest(
    "a mount that fails leaves the data repository created and declared, with the exact init command",
    async () => {
      const setup = await scenario({ worktree: true });
      const { report, steps } = await created(
        setup,
        { selector: "acme/archive", data: true },
        runHost(setup, {
          initData: fakeInit([], "it ended with exit code 1: clone_failed"),
        }),
      );
      expect(steps).toContain("data failed data-init-failed");
      expect(steps.slice(-2)).toEqual(["declare done", "check done"]);
      expect(report).toMatchObject({
        status: "action_required",
        issues: [{ code: "data-init-failed" }],
      });
      expect(report.next_steps[0]).toContain(
        "bun ./node_modules/@lazurio/repository-db/src/cli.ts init --app archive --remote git@github.com:Acme/archive-data.git --branch v3 --mount",
      );
      const declared = JSON.parse(
        await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
      ).module_slots.map((slot: { path: string }) => slot.path);
      expect(declared).toContain("workspace/archive/db");
    },
  );

  posixTest(
    "a data repository GitHub does not create: the module stays, its data slot is not declared",
    async () => {
      const setup = await scenario({ worktree: true });
      const host = runHost(setup, {
        initData: fakeInit([]),
        github: {
          ...setup.github,
          createRepository: async (name, description, organization) =>
            name.endsWith("-data")
              ? { kind: "failed" }
              : setup.github.createRepository(name, description, organization),
        },
      });
      const { report, steps } = await created(
        setup,
        { selector: "acme/notes", data: true },
        host,
      );
      expect(steps).toContain("data failed data-create-failed");
      expect(report.status).toBe("action_required");
      const declared = JSON.parse(
        await readFile(join(setup.worktree, "modules.manifest.json"), "utf8"),
      ).module_slots.map((slot: { path: string }) => slot.path);
      expect(declared).toContain("workspace/notes");
      expect(declared).not.toContain("workspace/notes/db");
    },
  );
});
