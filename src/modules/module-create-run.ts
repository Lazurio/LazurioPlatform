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
import { readFolderCatalog } from "../organizations/catalog";
import { personalspaceName } from "../organizations/personalspace";
import { readCheckoutFileBytes } from "../providers/owned-json";
import {
  baseReport,
  type ModuleCreateHost,
  type ModuleCreateIssue,
  ModuleCreateRefusal,
  type ModuleCreateReport,
  type ModuleCreateRequest,
  type PlannedPersonalModule,
  preparePersonalModule,
  refusedReport,
} from "./module-create";
import {
  insertModulePortPoolText,
  insertModuleSlotText,
  ModuleScaffoldError,
} from "./scaffold";

// The real run of `lazurio module create personalspace/<slug>` (decision
// F52), only for the plan the person confirmed (`--confirm <plan>`, the
// dry run's digest), under the Folder's content lock, from a task worktree
// of the held Personalspace. In order:
//   write    the plan's files into a temporary sibling of `workspace/<slug>`
//            (`publishNewCheckout`, as a clone of the content install);
//   prepare  `bun install` or `uv lock` (a failure is reported, the run goes on);
//   commit   `git init` with `main` and one commit by the operator's identity;
//   create   the private repository on the person's own account, verified
//            private and theirs, or the run stops and nothing is placed;
//   place    the no-replace rename into the Personalspace's `workspace/<slug>`:
//            a gitignored nested checkout, which the catalog lists at once;
//   push     `main` to it (a failure leaves the module placed, with the exact
//            command);
//   declare  the slot (and, without one, the pool) into the task worktree's
//            `modules.manifest.json`, byte for byte; the Personalspace's own
//            tracked files are never touched;
//   check    the catalog lists `personalspace/<slug>`.
// Nothing is ever adopted, overwritten or deleted on GitHub.

export const moduleCreateSteps = [
  "plan",
  "write",
  "prepare",
  "commit",
  "create",
  "place",
  "push",
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

export type InstallAnswer =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; detail: string }>;

/** What a real run writes with, besides what the plan reads. */
export type ModuleCreateRunHost = ModuleCreateHost &
  Readonly<{
    github: Pick<
      ContentGitHub,
      "viewer" | "repository" | "createRepository" | "remote"
    >;
    git: Pick<ContentGit, "worktree" | "ignored" | "commitAll" | "push">;
    /** The directory of the per-Folder content locks. */
    lockDirectory: string;
    /** The app's lockfile from its declaration: `bun install` or `uv lock`
     * in `app` by the operator's own toolchain. */
    install: (app: string, toolchain: "bun" | "uv") => Promise<InstallAnswer>;
  }>;

/** The description of the repository the run creates. */
export const personalModuleDescription = "Osobní Modul Lazuria.";

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
 * Creates the confirmed plan (see the module comment). Never throws for a
 * refusal or a failed step: `blocked` when nothing was written anywhere,
 * `action_required` when something was and a step is left to the person,
 * `completed` when every step succeeded.
 */
export async function createPersonalModule(
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
    const prepared = await preparePersonalModule(request, host);
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

// The real run's own refusals, after every check of the plan: the plan the
// person confirmed, and a task worktree of the Personalspace to declare the
// slot in.
async function runRefusal(
  request: ModuleCreateRunRequest,
  report: ModuleCreateReport,
  module: PlannedPersonalModule,
): Promise<ModuleCreateRefusal | null> {
  if (report.plan !== request.confirm)
    return new ModuleCreateRefusal(
      "plan-changed",
      `The plan is not the one confirmed: ${request.confirm} was confirmed, this run would create ${report.plan}.`,
      "Show the person this plan again (the same command with --dry-run) and run it with its own --confirm only after they confirm it.",
    );
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

async function run(
  report: ModuleCreateReport,
  module: PlannedPersonalModule,
  host: ModuleCreateRunHost,
  steps: ReturnType<typeof stepper>,
): Promise<ModuleCreateReport> {
  const { plan } = module;
  const fullName = `${module.login}/${plan.module}`;
  const issues: ModuleCreateIssue[] = [];
  // The repository this run created, when it did.
  let created: GitHubRepository | null = null;
  // Whether a step of `fill` already reported its own failure.
  let reported = false;
  let workspace: string;
  steps.running("write");
  try {
    workspace = await ensureCheckoutDirectories(module.space, ["workspace"]);
  } catch {
    const refusal = new ModuleCreateRefusal(
      "personalspace-unavailable",
      "The Personalspace's workspace/ is not a real directory of your own account.",
    );
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
      // none; the curated gh sign-in sets it, F19 addendum 2026-10-14).
      const viewer = await host.github.viewer();
      const committed = await host.git.commitAll(
        checkout,
        `Create ${plan.module} with lazurio module create (${plan.stack})`,
        viewer.kind === "signed-in" &&
          viewer.viewer.login.toLowerCase() === module.login.toLowerCase()
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
        personalModuleDescription,
      );
      if (answer.kind === "failed") {
        const now = await host.github.repository(module.login, plan.module);
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
          module.login.toLowerCase()
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
    return stopped(report, code, created, fullName, module);
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

  // declare
  steps.running("declare");
  const declared = await declare(module);
  if (declared === null)
    steps.done(
      "declare",
      `${plan.slot.path}${module.addsPool ? ` and module_port_pool ${module.pool.start}-${module.pool.end}` : ""} in ${module.manifestPath}`,
    );
  else {
    issues.push(declared);
    steps.failed("declare", declared.code, declared.message);
  }

  // check
  steps.running("check");
  const catalog = await readFolderCatalog(module.folder, host.holder).catch(
    () => null,
  );
  const listed = catalog?.personalspace?.modules.find(
    (entry) => entry.module === plan.module,
  );
  if (listed !== undefined)
    steps.done(
      "check",
      `listed as ${personalspaceName}/${plan.module}${listed.executable ? "" : ` (${listed.reason})`}`,
    );
  else {
    issues.push({
      code: "check-failed",
      message: `The catalog does not list ${personalspaceName}/${plan.module}.`,
      action: `See lazurio module list ${personalspaceName} --json.`,
    });
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
    ...createdSteps(module, declared === null),
  ];
  return report;
}

// A run that stopped before the module was placed: nothing under
// `workspace/` (the temporary sibling is gone); `action_required` only when
// this run created a repository on GitHub, which it never deletes.
function stopped(
  report: ModuleCreateReport,
  code: string,
  created: GitHubRepository | null,
  fullName: string,
  module: PlannedPersonalModule,
): ModuleCreateReport {
  const messages: Readonly<Record<string, [string, string]>> = {
    "commit-failed": [
      "Git could not make the module's first commit; nothing was created.",
      "Set your Git identity (git config --global user.name and user.email), or sign in gh so the module is committed with your GitHub identity, and run the command again.",
    ],
    "create-failed": [
      created === null
        ? `GitHub did not create ${fullName}; nothing was placed.`
        : `GitHub created ${created.fullName}, not ${fullName} of ${module.login}; nothing was placed.`,
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
): Promise<ModuleCreateIssue | null> {
  const path = module.manifestPath;
  const action = `Add the slot of ${module.plan.slot.path} to ${path} by hand (the report's slot${module.addsPool ? `, and module_port_pool ${module.pool.start}-${module.pool.end}` : ""}), in the pull request into the Personalspace.`;
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
    const next = insertModuleSlotText(withPool, module.plan.slot);
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
