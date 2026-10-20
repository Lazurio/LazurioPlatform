import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { githubCommitIdentity } from "../content/commit-identity";
import type { ContentGit } from "../content/git";
import type { ContentGitHub, GitHubRepository } from "../content/github";
import { tryContentLock } from "../content/lock";
import {
  ensureCheckoutDirectories,
  type FillOutcome,
  publishNewCheckout,
} from "../content/materialize";
import { sameRepository } from "../content/model";
import { personalspaceRepositoryName } from "../content/status";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { readFolderCatalog } from "../organizations/catalog";
import {
  compileOrganizationModulesIndex,
  organizationModulesIndexPath,
} from "../organizations/modules-index";
import { personalspaceName } from "../organizations/personalspace";
import {
  observeModuleDirectory,
  readOrganizationApplications,
} from "../organizations/read-applications";
import { organizationDocumentFiles } from "../organizations/read-documents";
import { readCheckoutFileBytes } from "../providers/owned-json";
import {
  baseReport,
  type ModuleCreateHost,
  type ModuleCreateIssue,
  ModuleCreateRefusal,
  type ModuleCreateReport,
  type ModuleCreateRequest,
  type PlannedModule,
  type PlannedPersonalModule,
  prepareModule,
  refusedReport,
} from "./module-create";
import {
  organizationTaskWorktrees,
  type PlannedOrganizationModule,
  readOrganizationDocumentTexts,
} from "./module-create-organization";
import {
  declareOrganizationSlots,
  type OrganizationDocumentTexts,
} from "./organization-declaration";
import {
  type DataSlot,
  insertModulePortPoolText,
  insertModuleSlotText,
  ModuleScaffoldError,
  type ModuleSlot,
} from "./scaffold";

// The real run of `lazurio module create personalspace/<slug>` (decision
// F52) and of `lazurio module create <Organization>/<slug>` (its addendum of
// 2026-10-14), only for the plan the person confirmed (`--confirm <plan>`,
// the dry run's digest), under the Folder's content lock, from a task
// worktree of the held Personalspace or of the Organization root. In order:
//   write    the plan's files into a temporary sibling of `workspace/<slug>`
//            (`publishNewCheckout`, as a clone of the content install);
//   prepare  `bun install` or `uv lock` (a failure is reported, the run goes on);
//   commit   `git init` with `main` and one commit by the operator's identity;
//   create   the private repository on the person's own account (or of the
//            Organization), verified private and its owner's, or the run
//            stops and nothing is placed;
//   place    the no-replace rename into the Personalspace's (or the
//            Organization root's) `workspace/<slug>`: a gitignored nested
//            checkout;
//   push     `main` to it (a failure leaves the module placed, with the exact
//            command);
//   grant    an Organization's module only: each named Team gets Write on
//            the repository, read back (a failure is reported, the run goes
//            on);
//   declare  the slot (and, without one, the personal pool) into the task
//            worktree's `modules.manifest.json`, byte for byte, and for an
//            Organization its compatibility projection
//            (`organization-declaration.ts`); the primary checkout's tracked
//            files are never touched;
//   check    the catalog lists `personalspace/<slug>`; for an Organization,
//            the task worktree's documents declare it and the placed module
//            reads as the Organization's (the catalog lists it after the
//            merge).
// Nothing is ever adopted, overwritten or deleted on GitHub.

export const moduleCreateSteps = [
  "plan",
  "write",
  "prepare",
  "commit",
  "create",
  "place",
  "push",
  "grant",
  "data",
  "declare",
  "check",
] as const;
export type ModuleCreateStepKey = (typeof moduleCreateSteps)[number];

export type ModuleCreateStep = Readonly<{
  key: ModuleCreateStepKey;
  state: "running" | "done" | "failed" | "skipped";
  detail?: string;
  code?: string;
}>;

export type ModuleCreateRunRequest = ModuleCreateRequest &
  Readonly<{
    /** The plan's digest the person confirmed (the dry run's `plan`). */
    confirm: string;
  }>;

export type DataInitRequest = Readonly<{
  /** The module's app, where the engine is installed. */
  app: string;
  /** The app's name (`--app`): the module's slug. */
  name: string;
  remote: string;
  branch: string;
  mount: string;
  schemaName: string;
  schemaVersion: string;
}>;

export type InstallAnswer =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; detail: string }>;

/** What a real run writes with, besides what the plan reads. */
export type ModuleCreateRunHost = ModuleCreateHost &
  Readonly<{
    github: Pick<
      ContentGitHub,
      | "viewer"
      | "repository"
      | "membership"
      | "team"
      | "createRepository"
      | "grantTeam"
      | "remote"
    >;
    git: Pick<ContentGit, "worktree" | "ignored" | "commitAll" | "push">;
    /** The directory of the per-Folder content locks. */
    lockDirectory: string;
    /** The app's lockfile from its declaration: `bun install` or `uv lock`
     * in `app` by the operator's own toolchain. */
    install: (app: string, toolchain: "bun" | "uv") => Promise<InstallAnswer>;
    /** `repository-db init` of a module with data (`--data`), by the engine
     * its app installed: clones the empty data repository into `mount`,
     * bootstraps `branch`, pushes it and makes it the default branch. */
    initData: (request: DataInitRequest) => Promise<InstallAnswer>;
  }>;

/** The description of the repository the run creates. */
export const personalModuleDescription = "Osobní Modul Lazuria.";
export const organizationModuleDescription = "Modul Lazuria.";

function stepper(onStep: (step: ModuleCreateStep) => void) {
  let current: ModuleCreateStepKey = "plan";
  const event = (
    key: ModuleCreateStepKey,
    state: ModuleCreateStep["state"],
    detail?: string,
    code?: string,
  ) => {
    current = key;
    onStep(
      Object.freeze({
        key,
        state,
        ...(detail === undefined ? {} : { detail }),
        ...(code === undefined ? {} : { code }),
      }),
    );
  };
  return {
    current: () => current,
    running: (key: ModuleCreateStepKey) => event(key, "running"),
    done: (key: ModuleCreateStepKey, detail?: string) =>
      event(key, "done", detail),
    skipped: (key: ModuleCreateStepKey, detail?: string) =>
      event(key, "skipped", detail),
    failed: (key: ModuleCreateStepKey, code: string, detail?: string) =>
      event(key, "failed", detail, code),
  };
}

/**
 * Creates the confirmed plan (see the module comment), of either form. Never
 * throws for a refusal or a failed step: `blocked` when nothing was written
 * anywhere, `action_required` when something was and a step is left to the
 * person, `completed` when every step succeeded.
 */
export async function createModule(
  request: ModuleCreateRunRequest,
  host: ModuleCreateRunHost,
  onStep: (step: ModuleCreateStep) => void = () => {},
): Promise<ModuleCreateReport> {
  const steps = stepper(onStep);
  steps.running("plan");
  const lock = await tryContentLock(host.lockDirectory, request.folder);
  if (lock === null) {
    const report = refusedReport(
      baseReport(request),
      new ModuleCreateRefusal(
        "content-busy",
        "Another content operation runs on this Folder (an install, or another module being created).",
        "Run the command again when it has ended.",
      ),
    );
    report.dry_run = false;
    steps.failed("plan", "content-busy", report.issues.at(-1)?.message);
    return report;
  }
  try {
    // Every check again under the lock: the state may have changed since the
    // dry run the person saw.
    const prepared = await prepareModule(request, host);
    prepared.report.dry_run = false;
    if (!prepared.ok) {
      steps.failed(
        "plan",
        prepared.report.reason,
        prepared.report.issues[0]?.message,
      );
      return prepared.report;
    }
    const { report, module } = prepared;
    const refusal = await runRefusal(request, report, module);
    if (refusal !== null) {
      refusedReport(report, refusal);
      steps.failed("plan", refusal.code, refusal.message);
      return report;
    }
    steps.done(
      "plan",
      `the confirmed plan ${report.plan}, from ${module.worktree?.path}`,
    );
    return await run(report, module, host, steps);
  } finally {
    await lock.release();
  }
}

/** The real run of a personal module (decision F52), as before the
 * Organization form: `createModule`. */
export const createPersonalModule = createModule;

// The real run's own refusals, after every check of the plan: the plan the
// person confirmed, and a task worktree to declare the slot in.
async function runRefusal(
  request: ModuleCreateRunRequest,
  report: ModuleCreateReport,
  module: PlannedModule,
): Promise<ModuleCreateRefusal | null> {
  if (report.plan !== request.confirm)
    return new ModuleCreateRefusal(
      "plan-changed",
      `The plan is not the one confirmed: ${request.confirm} was confirmed, this run would create ${report.plan}.`,
      "Show the person this plan again (the same command with --dry-run) and run it with its own --confirm only after they confirm it.",
    );
  if (module.scope === "organization") return organizationRunRefusal(module);
  const create = `git -C '${module.space}' worktree add -b <branch> '${join(module.folder, personalspaceName, ".worktrees", "<task>")}' main`;
  if (module.worktree === null || !module.worktree.linked)
    return new ModuleCreateRefusal(
      "personalspace_root_not_task_worktree",
      "The command does not run in a task worktree of the Personalspace; the slot is declared there, never in the Personalspace's own checkout.",
      `Create one beside the Personalspace (${create}) and run the command from it.`,
    );
  // Exactly personalspace/.worktrees/<task> of this Folder: a linked
  // worktree of the same repository anywhere else (inside another checkout,
  // say) would carry the slot somewhere no one looks for it.
  const tasks = await realpath(
    join(module.folder, personalspaceName, ".worktrees"),
  ).catch(() => null);
  if (tasks === null || dirname(module.worktree.path) !== tasks)
    return new ModuleCreateRefusal(
      "personalspace_worktree_misplaced",
      `The task worktree ${module.worktree.path} is not in ${join(module.folder, personalspaceName, ".worktrees")}; the Personalspace's task worktrees live there, beside it.`,
      `Create one there (${create}) and run the command from it.`,
    );
  if (module.worktree.branch === null || module.worktree.branch === "main")
    return new ModuleCreateRefusal(
      "personalspace_root_on_main",
      `The task worktree ${module.worktree.path} is on ${module.worktree.branch ?? "a detached HEAD"}; the slot is declared on a branch of its own, for a pull request.`,
      `Switch it to a new branch (git -C '${module.worktree.path}' switch -c <branch>), or create another (${create}), and run the command from it.`,
    );
  return null;
}

// The Organization's: a linked worktree of its root in exactly
// `<root>/.worktrees/root/<task>` (the root's worktree discipline; anywhere
// else, `organizations/<other>` say, it would be a second catalog candidate
// of the same Organization), on a branch of its own.
async function organizationRunRefusal(
  module: PlannedOrganizationModule,
): Promise<ModuleCreateRefusal | null> {
  const { root } = module.organization;
  const create = `git -C '${root}' worktree add -b <branch> '${join(organizationTaskWorktrees(root), "<task>")}' main`;
  if (module.worktree === null || !module.worktree.linked)
    return new ModuleCreateRefusal(
      "organization_root_not_task_worktree",
      "The command does not run in a task worktree of the Organization root; the slot is declared there, never in the Organization root's own checkout.",
      `Create one (${create}) and run the command from it.`,
    );
  const tasks = await realpath(organizationTaskWorktrees(root)).catch(
    () => null,
  );
  if (tasks === null || dirname(module.worktree.path) !== tasks)
    return new ModuleCreateRefusal(
      "organization_worktree_misplaced",
      `The task worktree ${module.worktree.path} is not in ${organizationTaskWorktrees(root)}; the Organization root's task worktrees live there.`,
      `Create one there (${create}) and run the command from it.`,
    );
  if (module.worktree.branch === null || module.worktree.branch === "main")
    return new ModuleCreateRefusal(
      "organization_root_on_main",
      `The task worktree ${module.worktree.path} is on ${module.worktree.branch ?? "a detached HEAD"}; the slot is declared on a branch of its own, for a pull request.`,
      `Switch it to a new branch (git -C '${module.worktree.path}' switch -c <branch>), or create another (${create}), and run the command from it.`,
    );
  return null;
}

/** What differs between the two forms in a real run. */
type Target = Readonly<{
  /** The GitHub login that owns the repository. */
  owner: string;
  /** The checkout whose `workspace/` receives the module. */
  parent: string;
  /** The Organization the repository is created in, if any. */
  organization: string | undefined;
  description: string;
  unavailable: ModuleCreateRefusal;
}>;

function targetOf(module: PlannedModule): Target {
  if (module.scope === "organization")
    return {
      owner: module.organization.github,
      parent: module.organization.root,
      organization: module.organization.github,
      description: organizationModuleDescription,
      unavailable: new ModuleCreateRefusal(
        "organization-workspace-unavailable",
        "The Organization root's workspace/ is not a real directory of your own account.",
      ),
    };
  return {
    owner: module.login,
    parent: module.space,
    organization: undefined,
    description: personalModuleDescription,
    unavailable: new ModuleCreateRefusal(
      "personalspace-unavailable",
      "The Personalspace's workspace/ is not a real directory of your own account.",
    ),
  };
}

async function run(
  report: ModuleCreateReport,
  module: PlannedModule,
  host: ModuleCreateRunHost,
  steps: ReturnType<typeof stepper>,
): Promise<ModuleCreateReport> {
  const { plan } = module;
  const target = targetOf(module);
  const fullName = `${target.owner}/${plan.module}`;
  const issues: ModuleCreateIssue[] = [];
  // The repository this run created, when it did.
  let created: GitHubRepository | null = null;
  // Whether a step of `fill` already reported its own failure.
  let reported = false;
  let workspace: string;
  steps.running("write");
  try {
    workspace = await ensureCheckoutDirectories(target.parent, ["workspace"]);
  } catch {
    const refusal = target.unavailable;
    steps.failed("write", refusal.code, refusal.message);
    return refusedReport(report, refusal);
  }

  const published = await publishNewCheckout<GitHubRepository>({
    parent: workspace,
    name: plan.module,
    fill: async (checkout): Promise<FillOutcome<GitHubRepository>> => {
      // write: every file new (`wx`), nothing of an earlier run reused.
      await mkdir(checkout, { mode: 0o755 });
      for (const file of plan.files) {
        const path = join(checkout, ...file.path.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content, {
          encoding: "utf8",
          flag: "wx",
          mode: file.mode === undefined ? 0o644 : Number.parseInt(file.mode, 8),
        });
      }
      steps.done("write", `${plan.files.length} files`);
      // prepare
      if (plan.toolchain === null)
        steps.skipped("prepare", "a module without an app installs nothing");
      else {
        steps.running("prepare");
        const installed = await host.install(
          join(checkout, "app", "v1"),
          plan.toolchain,
        );
        if (installed.ok)
          steps.done("prepare", plan.generatedByInstall.join(", "));
        else {
          const command = plan.toolchain === "uv" ? "uv lock" : "bun install";
          issues.push({
            code: "install-failed",
            message: `${command} did not finish: ${installed.detail}. The module was created without ${plan.generatedByInstall.join(", ")}.`,
            action: `Run ${command} in ${join(module.moduleRoot, "app", "v1")} and commit ${plan.generatedByInstall.join(", ")} in a pull request of the module.`,
          });
          steps.failed("prepare", "install-failed", installed.detail);
        }
      }
      // commit
      steps.running("commit");
      // By the operator's Git identity, else the person's GitHub one given
      // per commit (an Environment whose gh Lazurio did not sign in may have
      // none; the curated gh sign-in sets it, F19 addendum 2026-10-14). For
      // a personal module only the holder's; for an Organization's, the
      // Owner the plan verified.
      const viewer = await host.github.viewer();
      const committed = await host.git.commitAll(
        checkout,
        `Create ${plan.module} with lazurio module create (${plan.stack})`,
        viewer.kind === "signed-in" &&
          (module.scope === "organization" ||
            viewer.viewer.login.toLowerCase() === module.login.toLowerCase())
          ? githubCommitIdentity(viewer.viewer)
          : undefined,
      );
      if (!committed.ok) {
        steps.failed("commit", "commit-failed", committed.detail);
        reported = true;
        return { kind: "failed", code: "commit-failed" };
      }
      steps.done("commit", "main");
      // create
      steps.running("create");
      const answer = await host.github.createRepository(
        plan.module,
        target.description,
        target.organization,
      );
      if (answer.kind === "failed") {
        const now = await host.github.repository(target.owner, plan.module);
        // GitHub has it now, but this run cannot tell whether its own
        // request created it (and the answer was lost) or another took the
        // name first: never adopted, and the person decides.
        const code =
          now.kind === "observed" ? "create-uncertain" : "create-failed";
        steps.failed("create", code);
        reported = true;
        return { kind: "failed", code };
      }
      created = answer.repository;
      if (
        !sameRepository(answer.repository.fullName, fullName) ||
        answer.repository.owner.login.toLowerCase() !==
          target.owner.toLowerCase()
      ) {
        steps.failed(
          "create",
          "create-failed",
          `GitHub created ${answer.repository.fullName}, not ${fullName}`,
        );
        reported = true;
        return { kind: "failed", code: "create-failed" };
      }
      if (!answer.repository.private) {
        steps.failed(
          "create",
          "not-private",
          `${answer.repository.fullName} is not private`,
        );
        reported = true;
        return { kind: "failed", code: "not-private" };
      }
      steps.done("create", `${answer.repository.fullName} (private)`);
      steps.running("place");
      return { kind: "ready", value: answer.repository };
    },
  });

  if (published.kind !== "published") {
    const code =
      published.kind === "occupied" ? "directory_exists" : published.code;
    if (published.kind === "occupied") steps.failed("place", code);
    else if (!reported) steps.failed(steps.current(), code);
    return stopped(report, code, created, fullName, target.owner, module);
  }
  steps.done("place", module.moduleRoot);
  const repository = published.value;

  // push
  steps.running("push");
  const remote = await host.github.remote(repository.fullName);
  const pushed = await host.git.push(module.moduleRoot, remote);
  if (pushed.ok) steps.done("push", `main to ${repository.fullName}`);
  else {
    issues.push({
      code: "push-failed",
      message: `The first commit was not pushed to ${repository.fullName}: ${pushed.detail}. The module is placed and committed.`,
      action: `Push it: git -C '${module.moduleRoot}' push -u origin main (origin ${remote.url}; add it with git -C '${module.moduleRoot}' remote add origin ${remote.url} when it is missing).`,
    });
    steps.failed("push", "push-failed", pushed.detail);
  }

  // grant
  if (module.scope === "organization") {
    steps.running("grant");
    const refused = await grantTeams(module, repository.fullName, host);
    issues.push(...refused);
    if (refused.length === 0)
      steps.done(
        "grant",
        module.grants
          .map((grant) => `${grant.github} ${grant.permission}`)
          .join(", "),
      );
    else steps.failed("grant", "grant-failed", `${refused.length} Teams`);
  }

  // data
  const data = await createData(report, module, target, host, steps);
  issues.push(...data.issues);

  // declare: the module's slot, and its data's once the data repository is
  // there (one this run created, verified private and its owner's).
  const slots =
    data.declare && plan.data !== null
      ? [plan.slot, plan.data.slot]
      : [plan.slot];
  steps.running("declare");
  const declared =
    module.scope === "organization"
      ? await declareOrganization(module, slots)
      : await declare(module, slots);
  if (declared === null)
    steps.done(
      "declare",
      module.scope === "organization"
        ? `${slots.map((slot) => slot.path).join(" and ")} in ${module.manifestPath}, with the Organization's projection`
        : `${slots.map((slot) => slot.path).join(" and ")}${module.addsPool ? ` and module_port_pool ${module.pool.start}-${module.pool.end}` : ""} in ${module.manifestPath}`,
    );
  else {
    issues.push(declared);
    steps.failed("declare", declared.code, declared.message);
  }

  // check
  steps.running("check");
  const checked =
    module.scope === "organization"
      ? await checkOrganization(module, declared === null)
      : await checkPersonal(module, host);
  if (checked.kind === "done") steps.done("check", checked.detail);
  else {
    issues.push(checked.issue);
    steps.failed("check", "check-failed");
  }

  report.repository = {
    full_name: repository.fullName,
    private: true,
    create: true,
  };
  report.issues.push(...issues);
  report.status = issues.length === 0 ? "completed" : "action_required";
  report.reason =
    issues.length === 0 ? "module_created" : "module_created_with_issues";
  report.next_steps = [
    ...issues.flatMap((issue) =>
      issue.action === undefined ? [] : [issue.action],
    ),
    ...(module.scope === "organization"
      ? organizationCreatedSteps(module, declared === null)
      : createdSteps(module, declared === null)),
  ];
  return report;
}

/** Write for each of the module's Teams on `fullName`, read back; an issue
 * with the exact command for each grant GitHub did not make. */
async function grantTeams(
  module: PlannedOrganizationModule,
  fullName: string,
  host: ModuleCreateRunHost,
): Promise<ModuleCreateIssue[]> {
  const issues: ModuleCreateIssue[] = [];
  for (const grant of module.grants) {
    const answer = await host.github.grantTeam(
      module.organization.github,
      grant.github,
      fullName,
      grant.permission,
    );
    if (answer === "granted") continue;
    issues.push({
      code: "grant-failed",
      message: `GitHub did not grant the Team ${grant.github} ${grant.permission} on ${fullName}; until it does, the Team does not reach it.`,
      action: `Grant it as an Owner of ${module.organization.github}: gh api --method PUT orgs/${module.organization.github}/teams/${grant.github}/repos/${fullName} --raw-field permission=${grant.permission}`,
    });
  }
  return issues;
}

/** The description of a module's data repository. */
export const dataRepositoryDescription = "Data Modulu Lazuria (repository-db).";

/** The module's data (`--data`, step `data`): its empty private repository,
 * created and verified as the module's, granted to the module's Teams, then
 * initialized and mounted as the module's `db/` by the engine the app
 * installed (`repository-db init`, which bootstraps `v3`, pushes it and
 * makes it the default branch). Never adopted, never deleted. `declare`:
 * whether the data slot is declared (its repository exists and is the
 * module's). */
async function createData(
  report: ModuleCreateReport,
  module: PlannedModule,
  target: Target,
  host: ModuleCreateRunHost,
  steps: ReturnType<typeof stepper>,
): Promise<Readonly<{ issues: ModuleCreateIssue[]; declare: boolean }>> {
  const data = module.plan.data;
  if (data === null) return { issues: [], declare: false };
  steps.running("data");
  const fullName = `${target.owner}/${data.repository}`;
  const issues: ModuleCreateIssue[] = [];
  const answer = await host.github.createRepository(
    data.repository,
    dataRepositoryDescription,
    target.organization,
  );
  if (answer.kind === "failed") {
    const now = await host.github.repository(target.owner, data.repository);
    const uncertain = now.kind === "observed";
    const code = uncertain ? "data-create-uncertain" : "data-create-failed";
    issues.push({
      code,
      message: uncertain
        ? `GitHub did not confirm creating ${fullName}, but has it now; it is not taken over and the module has no data mount.`
        : `GitHub did not create ${fullName}; the module was created without its data.`,
      action: uncertain
        ? `Look at ${fullName} on GitHub with the person: if it is empty and was created just now, mount it with repository-db init (${initCommand(module, data)}) and declare its slot by hand; otherwise leave it.`
        : `Create the data later: the private repository ${fullName}, then ${initCommand(module, data)}, and declare the report's data slot by hand.`,
    });
    steps.failed("data", code);
    return { issues, declare: false };
  }
  const created = answer.repository;
  if (
    !sameRepository(created.fullName, fullName) ||
    created.owner.login.toLowerCase() !== target.owner.toLowerCase() ||
    !created.private
  ) {
    const code = created.private ? "data-create-failed" : "data-not-private";
    issues.push({
      code,
      message: created.private
        ? `GitHub created ${created.fullName}, not ${fullName}; the module has no data mount.`
        : `GitHub created ${created.fullName} public, not private; it is not mounted.`,
      action: `Delete ${created.fullName} on GitHub (or make it private), then create the data by hand: ${initCommand(module, data)}.`,
    });
    steps.failed("data", code);
    return { issues, declare: false };
  }
  if (report.data !== null)
    report.data.repository = {
      full_name: created.fullName,
      private: true,
      create: true,
    };
  if (module.scope === "organization")
    issues.push(...(await grantTeams(module, created.fullName, host)));
  const initialized = await host.initData({
    app: join(module.moduleRoot, "app", "v1"),
    name: module.plan.module,
    remote: data.slot.repository_db.url,
    branch: data.branch,
    mount: join(module.moduleRoot, data.mount),
    schemaName: data.schemaName,
    schemaVersion: data.schemaVersion,
  });
  if (!initialized.ok)
    issues.push({
      code: "data-init-failed",
      message: `repository-db init did not mount ${fullName} as ${join(module.moduleRoot, data.mount)}: ${initialized.detail}. The repository is created, empty.`,
      action: `Mount it: ${initCommand(module, data)}`,
    });
  if (issues.length === 0)
    steps.done(
      "data",
      `${created.fullName} (private) on ${data.branch} in ${join(module.moduleRoot, data.mount)}`,
    );
  else steps.failed("data", issues[0]?.code as string);
  return { issues, declare: true };
}

/** The exact `repository-db init` a person or agent runs to mount the
 * module's data, by the engine the app installed. */
function initCommand(
  module: PlannedModule,
  data: NonNullable<PlannedModule["plan"]["data"]>,
): string {
  const app = join(module.moduleRoot, "app", "v1");
  return `cd '${app}' && bun install && bun ./node_modules/@lazurio/repository-db/src/cli.ts init --app ${module.plan.module} --remote ${data.slot.repository_db.url} --branch ${data.branch} --mount '${join(module.moduleRoot, data.mount)}' --schema-name ${data.schemaName} --schema-version ${data.schemaVersion}`;
}

type CheckAnswer =
  | Readonly<{ kind: "done"; detail: string }>
  | Readonly<{ kind: "failed"; issue: ModuleCreateIssue }>;

async function checkPersonal(
  module: PlannedPersonalModule,
  host: ModuleCreateRunHost,
): Promise<CheckAnswer> {
  const { plan } = module;
  const catalog = await readFolderCatalog(module.folder, host.holder).catch(
    () => null,
  );
  const listed = catalog?.personalspace?.modules.find(
    (entry) => entry.module === plan.module,
  );
  if (listed !== undefined)
    return {
      kind: "done",
      detail: `listed as ${personalspaceName}/${plan.module}${listed.executable ? "" : ` (${listed.reason})`}`,
    };
  return {
    kind: "failed",
    issue: {
      code: "check-failed",
      message: `The catalog does not list ${personalspaceName}/${plan.module}.`,
      action: `See lazurio module list ${personalspaceName} --json.`,
    },
  };
}

// The catalog reads the Organization root's `main`, which declares the slot
// only after the merge. So: the task worktree's documents resolve and declare
// it, and the placed checkout reads as a module of the Organization.
async function checkOrganization(
  module: PlannedOrganizationModule,
  declared: boolean,
): Promise<CheckAnswer> {
  const { plan, organization } = module;
  const name = `${organization.slug}/${plan.module}`;
  const failed = (message: string): CheckAnswer => ({
    kind: "failed",
    issue: {
      code: "check-failed",
      message,
      action: `See lazurio module list ${organization.slug} --json after the pull request is merged.`,
    },
  });
  const placed = await observeModuleDirectory(
    module.moduleRoot,
    (found) => found.company === organization.slug && found.id === plan.module,
  ).catch(() => null);
  if (placed?.kind !== "module-observed")
    return failed(`${module.moduleRoot} does not read as the module ${name}.`);
  if (!declared)
    return failed(
      `The task worktree does not declare ${name}; the catalog will not list it.`,
    );
  const observed = await readOrganizationApplications(
    module.documents.directory,
  );
  if (
    observed.kind !== "applications-observed" ||
    observed.admission !== "executable" ||
    !observed.entries.some((entry) => entry.module === plan.module)
  )
    return failed(
      `The Organization root in ${module.documents.directory} does not resolve with ${name} declared.`,
    );
  return {
    kind: "done",
    detail: `${name} declared in ${module.documents.directory} and placed in ${module.moduleRoot}; the catalog lists it once the pull request is merged`,
  };
}

// A run that stopped before the module was placed: nothing under
// `workspace/` (the temporary sibling is gone); `action_required` only when
// this run created a repository on GitHub, which it never deletes.
function stopped(
  report: ModuleCreateReport,
  code: string,
  created: GitHubRepository | null,
  fullName: string,
  owner: string,
  module: PlannedModule,
): ModuleCreateReport {
  const messages: Readonly<Record<string, [string, string]>> = {
    "commit-failed": [
      "Git could not make the module's first commit; nothing was created.",
      "Set your Git identity (git config --global user.name and user.email), or sign in gh so the module is committed with your GitHub identity, and run the command again.",
    ],
    "create-failed": [
      created === null
        ? `GitHub did not create ${fullName}; nothing was placed.`
        : `GitHub created ${created.fullName}, not ${fullName} of ${owner}; nothing was placed.`,
      created === null
        ? "Check gh auth status and run the command again."
        : `Delete ${created.fullName} on GitHub if it is not wanted, check gh auth status and run the command again.`,
    ],
    "create-uncertain": [
      `GitHub did not confirm creating ${fullName}, but has it now: either this run created it and GitHub's answer was lost, or another request took the name first. It is not taken over and nothing was placed or pushed.`,
      `Look at ${fullName} on GitHub with the person: if it is empty and was created just now by this run, delete it (or keep it private and empty) and run the command again; otherwise ask the person for another name of the module.`,
    ],
    "not-private": [
      `GitHub created ${created?.fullName ?? fullName} public, not private; nothing was placed or pushed.`,
      `Make ${created?.fullName ?? fullName} private on GitHub (or delete it), then run the command again with another name or after deleting it.`,
    ],
    directory_exists: [
      `${module.moduleRoot} appeared while the module was being created; it was left untouched and nothing was placed.`,
      created === null
        ? "Choose another name, or work in the existing directory."
        : `Delete the empty ${created.fullName} on GitHub, or choose another name.`,
    ],
  };
  const [message, action] = messages[code] ?? [
    `The module could not be written (${code}); nothing was placed.`,
    "Run the command again.",
  ];
  refusedReport(report, new ModuleCreateRefusal(code, message, action));
  if (code === "create-uncertain") report.status = "action_required";
  if (created !== null) {
    report.status = "action_required";
    report.repository = {
      full_name: created.fullName,
      private: true,
      create: true,
    };
  }
  return report;
}

// The slot (and the pool, without one) into the task worktree's manifest,
// unchanged since the plan read it; written with a rename. An issue when it
// could not be.
async function declare(
  module: PlannedPersonalModule,
  slots: readonly (ModuleSlot | DataSlot)[],
): Promise<ModuleCreateIssue | null> {
  const path = module.manifestPath;
  const action = `Add the slot of ${slots.map((slot) => slot.path).join(" and the slot of ")} to ${path} by hand (the report's slot${slots.length > 1 ? " and its data's" : ""}${module.addsPool ? `, and module_port_pool ${module.pool.start}-${module.pool.end}` : ""}), in the pull request into the Personalspace.`;
  try {
    const current = new TextDecoder("utf-8", { fatal: true }).decode(
      await readCheckoutFileBytes(path),
    );
    if (current !== module.manifestText)
      return {
        code: "manifest_changed",
        message: `${path} changed while the module was being created; the slot was not added.`,
        action,
      };
    const withPool = module.addsPool
      ? insertModulePortPoolText(current, module.pool)
      : current;
    const next = slots.reduce(
      (text, slot) => insertModuleSlotText(text, slot),
      withPool,
    );
    const { mode } = await stat(path);
    const temporary = `${path}.lazurio-module-create-${process.pid}.tmp`;
    await writeFile(temporary, next, {
      encoding: "utf8",
      flag: "wx",
      mode: mode & 0o777,
    });
    await rename(temporary, path);
    return null;
  } catch (error) {
    return {
      code:
        error instanceof ModuleScaffoldError ? error.code : "declare-failed",
      message: `The slot could not be added to ${path}: ${error instanceof Error ? error.message : String(error)}`,
      action,
    };
  }
}

// The slot into the task worktree's `modules.manifest.json` and the
// Organization's projection after it (`declareOrganizationSlots`), computed
// and verified in full before any write, from the documents unchanged since
// the plan read them. Each file is written with a rename; an issue names the
// files written when a later one could not be.
async function declareOrganization(
  module: PlannedOrganizationModule,
  slots: readonly (ModuleSlot | DataSlot)[],
): Promise<ModuleCreateIssue | null> {
  const directory = module.documents.directory;
  const action = `Add the slot of ${slots.map((slot) => slot.path).join(" and the slot of ")} (the report's${slots.length > 1 ? " slot and its data's" : " slot"}) to ${module.manifestPath} by hand in the pull request into the Organization root, then regenerate its projection with lazurio migrate organization-manifest '${directory}' --write from a Lazurio root checkout.`;
  let next: OrganizationDocumentTexts;
  try {
    const current = await readOrganizationDocumentTexts(directory);
    const before = module.documents.texts;
    if (
      current.canonical !== before.canonical ||
      current.modules !== before.modules ||
      current.legacy !== before.legacy ||
      current.modulesIndex !== before.modulesIndex
    )
      return {
        code: "manifest_changed",
        message: `The Organization's documents in ${directory} changed while the module was being created; the slot was not added.`,
        action,
      };
    next = declareOrganizationSlots(current, slots);
    if (next.modulesIndex !== undefined) {
      await mkdir(join(directory, "generated"), { recursive: true });
      await inspectCheckoutDirectory(join(directory, "generated"));
    }
  } catch (error) {
    return {
      code:
        error instanceof ModuleScaffoldError ||
        error instanceof ModuleCreateRefusal
          ? error.code
          : "declare-failed",
      message: `The slot could not be declared in ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      action,
    };
  }
  const writes: [string, string][] = [
    ...(next.modulesIndex === undefined
      ? []
      : [
          [organizationModulesIndexPath, next.modulesIndex] as [string, string],
        ]),
    [organizationDocumentFiles.modules, next.modules],
    [organizationDocumentFiles.canonical, next.canonical],
    ...(next.legacy === null
      ? []
      : [[organizationDocumentFiles.legacy, next.legacy] as [string, string]]),
  ];
  const written: string[] = [];
  try {
    for (const [file, text] of writes) {
      await replaceFile(join(directory, file), text);
      written.push(file);
    }
    return null;
  } catch (error) {
    return {
      code: "declare-failed",
      message: `The Organization's documents in ${directory} were written only in part (${written.length === 0 ? "none" : written.join(", ")}): ${error instanceof Error ? error.message : String(error)}`,
      action:
        written.length === 0
          ? action
          : `Restore them (git -C '${directory}' checkout -- ${written.join(" ")}), then: ${action}`,
    };
  }
}

// `text` into `path` with a rename, keeping the file's mode.
async function replaceFile(path: string, text: string) {
  const mode = await stat(path)
    .then((value) => value.mode)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0o644;
      throw error;
    });
  const temporary = `${path}.lazurio-module-create-${process.pid}.tmp`;
  await writeFile(temporary, text, {
    encoding: "utf8",
    flag: "wx",
    mode: mode & 0o777,
  });
  await rename(temporary, path);
}

function organizationCreatedSteps(
  module: PlannedOrganizationModule,
  declared: boolean,
): string[] {
  const { plan, worktree, organization } = module;
  const files = [
    ...(compileOrganizationModulesIndex(
      JSON.parse(module.documents.texts.canonical),
      JSON.parse(module.documents.texts.modules),
    ) === null
      ? []
      : [organizationModulesIndexPath]),
    organizationDocumentFiles.modules,
    organizationDocumentFiles.canonical,
    ...(module.documents.texts.legacy === null
      ? []
      : [organizationDocumentFiles.legacy]),
  ].join(", ");
  const rootRepository = (
    JSON.parse(module.documents.texts.canonical) as {
      root_repository?: { locator?: unknown };
    }
  ).root_repository?.locator;
  const steps = [
    `${declared ? "Commit" : "Once the slot is in them, commit"} ${files} in the task worktree ${worktree?.path} (the slot ${plan.slot.path}), push its branch and open a pull request into ${typeof rootRepository === "string" ? rootRepository : "the Organization root's repository"}; merging it is the Publication of an Operator GitHub lets merge there.`,
    `After the merge, remove the task worktree: git -C '${organization.root}' worktree remove '${worktree?.path}'.`,
  ];
  const name = `${organization.slug}/${plan.module}`;
  if (plan.lease === null)
    steps.push(
      `The module has no app; after the merge lazurio module list ${organization.slug} --json lists it.`,
    );
  else if (plan.toolchain === "uv")
    steps.push(
      `Check the app by hand with uv run --no-sync ${plan.module} in ${join(module.moduleRoot, "app", "v1")}; this Platform does not start a uv app yet.`,
    );
  else
    steps.push(
      `After the merge, start it: lazurio module start ${name} --json, and open result.runtime.url.`,
    );
  return steps;
}

function createdSteps(
  module: PlannedPersonalModule,
  declared: boolean,
): string[] {
  const { plan, worktree } = module;
  const personalspace = `${module.login}/${personalspaceRepositoryName(module.login)}`;
  const steps = [
    `${declared ? "Commit" : "Once the slot is in it, commit"} modules.manifest.json in the task worktree ${worktree?.path} (the slot ${plan.slot.path}${module.addsPool ? ` and module_port_pool ${module.pool.start}-${module.pool.end}` : ""}), push its branch and open a pull request into ${personalspace}; merging it is the person's Publication.`,
    `After the merge, remove the task worktree: git -C '${module.space}' worktree remove '${worktree?.path}'.`,
  ];
  if (plan.lease === null)
    steps.push(
      `The module has no app; lazurio module list ${personalspaceName} --json lists it.`,
    );
  else if (plan.toolchain === "uv")
    steps.push(
      `Check the app by hand with uv run --no-sync ${plan.module} in ${join(module.moduleRoot, "app", "v1")}; this Platform does not start a uv app yet.`,
    );
  else
    steps.push(
      `Start it: lazurio module start ${personalspaceName}/${plan.module} --json, and open result.runtime.url.`,
    );
  return steps;
}
