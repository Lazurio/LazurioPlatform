import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { GitHubRepository, ViewerAnswer } from "../src/content/github";
import { personalspaceHolder } from "../src/content/status";
import type { PresetName } from "../src/folder/presets";
import {
  type ModuleCreateHost,
  type ModuleCreateReport,
  planModuleCreate,
} from "../src/modules/module-create";
import { personalModulePortPool } from "../src/modules/scaffold";
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

// `lazurio module create personalspace/<slug>` (decision F52), its plan: the
// checks a dry run and a real run share, all reading only. A world without a
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
  });
  const content = contentHost(current, github);
  const host: ModuleCreateHost = {
    holder: (at) => personalspaceHolder(at, content),
    github,
    git: content.git,
  };
  return { folder, space, worktree, host, calls };
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
