import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gitEnvironmentOf } from "../content/git";
import { createPersonalspaceHolder } from "../content/holder";
import { contentLockDirectory, processGitHubHost } from "../content/host";
import { shown } from "../organizations/cli";
import { toolsEnvironmentOf } from "../tools/overview";
import { resolveOnPath, runTool } from "../tools/status";
import { type CliContext, installBase, operatorFolder } from "../update/cli";
import { type ModuleCreateReport, planModuleCreate } from "./module-create";
import {
  createModule,
  type InstallAnswer,
  type ModuleCreateRunHost,
  type ModuleCreateStep,
} from "./module-create-run";
import { processModuleHost } from "./module-operations";
import { moduleScaffoldStacks } from "./scaffold";

/** `lazurio module create`: the terminal surface of module creation
 * (decision F52). CLI first (root decision 0167): the Launchpad has no route
 * for it; an agent runs it for the person. */
export const moduleCreateHelp = `module create personalspace/<module> --stack <stack> [--name <name>] [--port N] [--data] (--dry-run | --confirm <plan>) [--folder <absolute Folder>] [--json]
module create <Organization>/<module> --stack <stack> --teams <team,team> [--name <name>] [--port N] [--data] (--dry-run | --confirm <plan>) [--folder <absolute Folder>] [--json]
  Creates a module of your own in your Personalspace (decision F52): a private
  repository <login>/<module> on the GitHub account gh is signed in with here,
  checked out in the Personalspace's workspace/<module>, with no Organization
  and no Teams, its slot declared by a pull request into your Personalspace.
  Stacks: ${moduleScaffoldStacks.join(", ")}. --name is the display name
  (default: the module name in sentence case); --port a port of the
  Personalspace's module_port_pool (default: a free port derived from the
  name). Every check reads only: this Environment holds a Personalspace and gh's
  account holds it (personalspace-not-here, personalspace-absent and the
  reasons of module list); its modules.manifest.json is readable
  (modules_manifest_missing, manifest_invalid) and its module_port_pool, when
  declared, lies in the reserved range 23000-23099 (personalspace-pool-invalid;
  without one the run declares it with the slot); its Git ignores
  workspace/<module> (personalspace-workspace-tracked); no directory and no slot
  has that name (directory_exists, slot_exists; letter case ignored); the name
  is valid and reserved by neither Lazurio nor the gateway (invalid_slug,
  reserved_slug); GitHub has no <login>/<module>, letter case ignored
  (repository-exists: an existing repository is never taken over); and a port is
  free (port_outside_pool, port_taken, pool_exhausted). A Personalspace that
  still names the template's placeholder owner is only a warning (#377).
  --dry-run prints the plan and writes nothing: the repository, the slot, the
  lease, the files with their tree_hash and the plan's digest (plan). Show it
  to the person; only after they confirm it, --confirm <plan> creates exactly
  that plan, from a task worktree of the Personalspace beside it
  (personalspace/.worktrees/<task>; personalspace_root_not_task_worktree,
  personalspace_root_on_main), and only one content operation at a time
  (content-busy); a plan that changed since is refused (plan-changed). The run
  writes the module in a temporary sibling, installs its app's lockfile (bun
  install with ~/.local/bin/bun, or uv lock), makes its first commit with your Git
  identity (commit-failed), creates the private repository on your account and
  verifies it private and yours (create-failed, not-private; nothing is placed
  then), moves it into workspace/<module> without replacing anything, pushes
  main (push-failed keeps it placed), and declares the slot (and the pool) in the
  task worktree's modules.manifest.json, never in the Personalspace's own
  checkout; then commit that and open a pull request into your Personalspace.
  --teams is refused for a personal module (it has no Teams).
  An Organization's module (decision F52's addendum of 2026-10-14) is the
  same flow for an Organization of this Folder, named by its slug (or its
  directory, or its GitHub login): a private
  repository <GitHub login>/<module> of the Organization, Write for each Team
  of --teams (required; Teams of lazurio.organization.json that exist on
  GitHub: unknown_team, team-not-on-github, team-binding-mismatch), checked out
  in the Organization root's workspace/<module>. Only an active Owner of the
  Organization creates one (organization-owner-required), never a Team
  Environment (team-environment; a Folder whose preset cannot be read is
  folder-unavailable); the Organization root resolves cleanly
  (organization_not_found, organization_manifest_not_mutation_safe) and its
  module_port_pool stays out of 23000-23099 (organization-pool-invalid). The
  real run runs from a task worktree of the Organization root in
  <Organization root>/.worktrees/root/<task> on a branch of its own
  (organization_root_not_task_worktree, organization_worktree_misplaced,
  organization_root_on_main), grants the Teams after the push (grant-failed
  keeps the module and names the command) and declares the slot in the task
  worktree's modules.manifest.json with the Organization's projection
  (lazurio.organization.json, company.gen3.json); then commit those and open a
  pull request into the Organization root. --data (either form, a stack with
  a Bun app: data_needs_bun_app) starts the module's data in repository-db:
  its app depends on one released repository-db, and the run creates the
  private repository <owner>/<module>-data (data-repository-exists in the
  plan), grants it to the Teams, mounts it as the module's db/ on v3 with
  repository-db init (data-init-failed names the exact command), and declares
  its slot workspace/<module>/db (repository_db_mount) with the module's.
  --json prints one JSON line per
  step, then the report (lazurio.module_create.report.v1). Exit status: 0
  planned or created, 1 created with a step left to you (its next step says
  which), 2 refused (nothing written) or usage.`;

export class ModuleCreateUsageError extends Error {}

const usage = [
  "Usage: module create personalspace/<module> --stack <stack> [--name <name>] [--port N] [--data] (--dry-run | --confirm <plan>) [--folder <Folder>] [--json]",
  "       module create <Organization>/<module> --stack <stack> --teams <team,team> [--name <name>] [--port N] [--data] (--dry-run | --confirm <plan>) [--folder <Folder>] [--json]",
].join("\n");

function parse(args: string[]) {
  let values: {
    folder?: string | undefined;
    json?: boolean | undefined;
    stack?: string | undefined;
    name?: string | undefined;
    port?: string | undefined;
    teams?: string | undefined;
    confirm?: string | undefined;
    "dry-run"?: boolean | undefined;
    data?: boolean | undefined;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: {
        folder: { type: "string" },
        json: { type: "boolean" },
        stack: { type: "string" },
        name: { type: "string" },
        port: { type: "string" },
        teams: { type: "string" },
        confirm: { type: "string" },
        "dry-run": { type: "boolean" },
        data: { type: "boolean" },
      },
    });
    ({ values, positionals } = parsed);
    const supplied = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (supplied.has(token.name)) throw new Error("Duplicate command option");
      supplied.add(token.name);
    }
  } catch (error) {
    throw new ModuleCreateUsageError(
      `${error instanceof Error ? error.message : String(error)}\n${usage}`,
    );
  }
  const [noun, verb, selector, ...rest] = positionals;
  if (noun !== "module" || verb !== "create" || selector === undefined)
    throw new ModuleCreateUsageError(usage);
  if (rest.length !== 0)
    throw new ModuleCreateUsageError(
      `module create takes one module, personalspace/<module> or <Organization>/<module>; also given: ${rest.map(shown).join(" ")}\n${usage}`,
    );
  if (values.stack === undefined)
    throw new ModuleCreateUsageError(
      `module create needs --stack (${moduleScaffoldStacks.join(", ")}).\n${usage}`,
    );
  if (values.port !== undefined && !/^[1-9][0-9]{0,4}$/.test(values.port))
    throw new ModuleCreateUsageError(`--port is a port number.\n${usage}`);
  if (
    values.folder !== undefined &&
    (!isAbsolute(values.folder) || resolve(values.folder) !== values.folder)
  )
    throw new ModuleCreateUsageError(usage);
  const personal = /^personalspace\//i.test(selector);
  const dryRun = values["dry-run"] === true;
  if (values.teams !== undefined && personal)
    throw new ModuleCreateUsageError(
      `A personal module has no Teams: leave out --teams.\n${usage}`,
    );
  const teams =
    values.teams === undefined
      ? undefined
      : values.teams.split(",").map((team) => team.trim());
  if (
    !personal &&
    selector.includes("/") &&
    (teams === undefined || teams.some((team) => team === ""))
  )
    throw new ModuleCreateUsageError(
      `An Organization's module names its Teams: --teams <team,team>, the Teams of lazurio.organization.json that work on it.\n${usage}`,
    );
  if (dryRun && values.confirm !== undefined)
    throw new ModuleCreateUsageError(
      `Either --dry-run or --confirm <plan>, not both.\n${usage}`,
    );
  if (!dryRun && values.confirm === undefined)
    throw new ModuleCreateUsageError(
      `Show the person the plan with --dry-run first; only after they confirm it, run the command with --confirm <plan>, the plan's digest.\n${usage}`,
    );
  if (
    values.confirm !== undefined &&
    !/^sha256:[0-9a-f]{64}$/.test(values.confirm)
  )
    throw new ModuleCreateUsageError(
      `--confirm takes the plan's digest (sha256:…) from the dry run's report.\n${usage}`,
    );
  return {
    selector,
    stack: values.stack,
    name: values.name,
    port: values.port === undefined ? undefined : Number(values.port),
    teams,
    data: values.data === true,
    folder: values.folder,
    json: values.json === true,
    confirm: dryRun ? undefined : values.confirm,
  };
}

/** The report in a few lines for a person reading the terminal. */
export function renderModuleCreate(report: ModuleCreateReport): string {
  const title =
    {
      actionable: "plan ready, nothing written (--dry-run)",
      completed: "module created",
      action_required: "created, with a step left to do",
      blocked: "refused, nothing written",
    }[report.status] ?? report.status;
  const lines = [`Lazurio module create: ${report.status}, ${title}`];
  if (report.module.name !== null)
    lines.push(
      `Module: ${shown(report.module.name)} (stack ${shown(report.module.stack ?? "?")}${report.module.display_name === null ? "" : `, ${shown(report.module.display_name)}`})`,
    );
  if (report.repository !== null)
    lines.push(
      `Repository: ${shown(report.repository.full_name)} on GitHub, private${report.repository.create ? (report.dry_run ? ", to be created by the real run" : ", created") : ""}`,
    );
  if (report.data !== null)
    lines.push(
      `Data: ${shown(report.data.repository.full_name)} on GitHub, private, mounted as ${shown(report.data.mount)} (repository-db, ${report.data.branch})`,
    );
  if (report.teams.length > 0)
    lines.push(
      `Teams: ${report.teams.map((team) => `${shown(team.slug)} (${team.permission})`).join(", ")}`,
    );
  if (report.slot !== null && report.manifest !== null)
    lines.push(
      `Slot: ${report.slot.path} into ${shown(report.manifest.path)}${report.manifest.adds_pool ? ` (with module_port_pool ${report.manifest.module_port_pool.start}-${report.manifest.module_port_pool.end})` : ""}`,
    );
  if (report.lease !== null)
    lines.push(
      `Lease: ${report.lease.id} ${report.lease.host}:${report.lease.port}`,
    );
  else if (report.slot !== null)
    lines.push("Lease: none (a module without an app)");
  if (report.tree_hash !== null)
    lines.push(`Content: ${report.files.length} files, ${report.tree_hash}`);
  if (report.plan !== null) lines.push(`Plan: ${report.plan}`);
  if (report.status === "actionable")
    lines.push(
      report.worktree === null
        ? "Task worktree: none (the real run needs one)"
        : `Task worktree: ${shown(report.worktree.path)} (branch ${shown(report.worktree.branch ?? "detached")})`,
    );
  for (const warning of report.warnings)
    lines.push(`Warning: ${shown(warning)}`);
  for (const issue of report.issues)
    lines.push(
      `${report.status === "blocked" ? "Refused" : "Left to do"} ${issue.code}: ${shown(issue.message)}`,
    );
  if (report.next_steps.length > 0) {
    lines.push("Next steps:");
    report.next_steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${shown(step)}`);
    });
  }
  return lines.join("\n");
}

const installTimeoutMs = 10 * 60_000;

/** The app's lockfile by the operator's own toolchain: the standard Bun at
 * `~/.local/bin/bun` (as the module lifecycle runs it), or `uv` from the same
 * PATH, with the account's HOME, PATH and TMPDIR only. Never this process's
 * executable: compiled, that is Lazurio itself. */
export function processModuleInstall(
  context: Pick<CliContext, "env" | "platform">,
): ModuleCreateRunHost["install"] {
  const host = processModuleHost(context.env, context.platform);
  return async (app, toolchain): Promise<InstallAnswer> => {
    const home = host.home;
    if (home === undefined)
      return { ok: false, detail: "the account's home (HOME) is not known" };
    const environment: Record<string, string> = { HOME: home, PATH: host.path };
    if (host.tmpdir) environment.TMPDIR = host.tmpdir;
    let argv: string[];
    if (toolchain === "bun") {
      const bun = host.bunExecutable ?? join(home, ".local/bin/bun");
      if (
        !(await access(bun).then(
          () => true,
          () => false,
        ))
      )
        return {
          ok: false,
          detail: "Bun is not at ~/.local/bin/bun (see lazurio tools status)",
        };
      argv = [bun, "install", "--cwd", app];
    } else {
      const uv = await resolveOnPath("uv", host.path, context.platform);
      if (uv === undefined) return { ok: false, detail: "uv is not on PATH" };
      argv = [uv, "lock", "--directory", app];
    }
    try {
      const result = await runTool(argv, installTimeoutMs, environment);
      if (result === "timeout")
        return { ok: false, detail: "it did not end within 10 minutes" };
      if (result.exitCode === 0) return { ok: true };
      const last = `${result.stderr}${result.stdout}`
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .at(-1);
      return {
        ok: false,
        detail: `it ended with exit code ${result.exitCode}${last === undefined ? "" : `: ${last.slice(0, 300)}`}`,
      };
    } catch {
      return { ok: false, detail: "it could not be run" };
    }
  };
}

const dataInitTimeoutMs = 5 * 60_000;

/** `repository-db init` by the engine the module's app installed
 * (`node_modules/@lazurio/repository-db`, the one released tag its
 * `package.json` names), with the operator's Bun. Init clones and pushes
 * with git and asks gh (`gh auth status`, the default branch), so it runs
 * with what the module's own push runs with: the operator's HOME, PATH and
 * XDG directories (gh's sign-in) and the part of the environment git takes
 * for SSH and its configuration (`gitEnvironmentOf`: the agent socket, an
 * SSH command, `GIT_CONFIG_*`), plus TMPDIR. Nothing else, never a token,
 * never this process's executable. */
export function processDataInit(
  context: Pick<CliContext, "env" | "platform">,
  run: typeof runTool = runTool,
): ModuleCreateRunHost["initData"] {
  const host = processModuleHost(context.env, context.platform);
  const tools = toolsEnvironmentOf(context.env, context.platform, run);
  return async (request): Promise<InstallAnswer> => {
    const home = host.home;
    if (home === undefined)
      return { ok: false, detail: "the account's home (HOME) is not known" };
    const bun = host.bunExecutable ?? join(home, ".local/bin/bun");
    const engine = join(
      request.app,
      "node_modules",
      "@lazurio",
      "repository-db",
      "src",
      "cli.ts",
    );
    for (const [path, missing] of [
      [bun, "Bun is not at ~/.local/bin/bun (see lazurio tools status)"],
      [
        engine,
        "the app has no repository-db installed (bun install did not finish)",
      ],
    ] as const)
      if (
        !(await access(path).then(
          () => true,
          () => false,
        ))
      )
        return { ok: false, detail: missing };
    const environment: Record<string, string> = {
      ...gitEnvironmentOf(context.env),
      ...(tools.xdg ?? {}),
      HOME: home,
      PATH: tools.path ?? host.path,
      GIT_TERMINAL_PROMPT: "0",
    };
    if (host.tmpdir) environment.TMPDIR = host.tmpdir;
    try {
      const result = await run(
        [
          bun,
          engine,
          "init",
          "--app",
          request.name,
          "--remote",
          request.remote,
          "--branch",
          request.branch,
          "--mount",
          request.mount,
          "--schema-name",
          request.schemaName,
          "--schema-version",
          request.schemaVersion,
        ],
        dataInitTimeoutMs,
        environment,
      );
      if (result === "timeout")
        return { ok: false, detail: "it did not end within 5 minutes" };
      if (result.exitCode === 0) return { ok: true };
      const last = `${result.stderr}${result.stdout}`
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .at(-1);
      return {
        ok: false,
        detail: `it ended with exit code ${result.exitCode}${last === undefined ? "" : `: ${last.slice(0, 300)}`}`,
      };
    } catch {
      return { ok: false, detail: "it could not be run" };
    }
  };
}

/** This process's gh and git, the holder decision over them (#186), the
 * Folder's content lock in this account's install base, and the
 * operator's toolchain. */
export function processModuleCreateHost(
  context: CliContext,
): ModuleCreateRunHost {
  const host = processGitHubHost({
    env: context.env,
    platform: context.platform,
  });
  return Object.freeze({
    holder: createPersonalspaceHolder(() => host).decide,
    github: host.github,
    git: host.git,
    lockDirectory: contentLockDirectory(installBase(context, undefined)),
    install: processModuleInstall(context),
    initData: processDataInit(context),
  });
}

export async function runModuleCreateCommand(
  args: string[],
  context: CliContext & Readonly<{ cwd: string }>,
  write: (line: string) => void,
  // Test seam: the host; the product asks this process's gh and git.
  hostFor: (folder: string) => ModuleCreateRunHost = () =>
    processModuleCreateHost(context),
): Promise<number> {
  const options = parse(args);
  const step = (entry: ModuleCreateStep) =>
    write(
      options.json
        ? JSON.stringify({ kind: "module-create-step", ...entry })
        : `${shown(options.selector)}  ${entry.key} ${entry.state}${entry.code === undefined ? "" : ` ${entry.code}`}${entry.detail === undefined ? "" : `: ${shown(entry.detail)}`}`,
    );
  const blocked = (reason: string, text: string) =>
    write(options.json ? JSON.stringify({ kind: "blocked", reason }) : text);
  const folder = options.folder ?? (await operatorFolder(context));
  if (folder === undefined) {
    blocked(
      "folder-unknown",
      "No Folder known: name it with --folder <absolute Folder>.",
    );
    return 2;
  }
  let host: ModuleCreateRunHost;
  try {
    host = hostFor(folder);
  } catch {
    blocked("base-unknown", "No per-user install base on this platform.");
    return 1;
  }
  const request = {
    folder,
    cwd: context.cwd,
    selector: options.selector,
    stack: options.stack,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.teams === undefined ? {} : { teams: options.teams }),
    ...(options.data ? { data: true } : {}),
  };
  let report: ModuleCreateReport;
  if (options.confirm === undefined) {
    step({ key: "plan", state: "running" });
    report = await planModuleCreate(request, host);
    if (report.status === "blocked")
      step({
        key: "plan",
        state: "failed",
        code: report.reason,
        ...(report.issues[0] === undefined
          ? {}
          : { detail: report.issues[0].message }),
      });
    else
      step({
        key: "plan",
        state: "done",
        detail: `private ${report.repository?.full_name}, ${report.files.length} files, ${report.lease === null ? "no lease" : `lease ${report.lease.port}`}`,
      });
  } else
    report = await createModule(
      { ...request, confirm: options.confirm },
      host,
      step,
    );
  write(options.json ? JSON.stringify(report) : renderModuleCreate(report));
  return report.status === "actionable" || report.status === "completed"
    ? 0
    : report.status === "action_required"
      ? 1
      : 2;
}
