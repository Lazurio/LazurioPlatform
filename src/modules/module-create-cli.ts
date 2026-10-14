import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPersonalspaceHolder } from "../content/holder";
import { processGitHubHost } from "../content/host";
import { shown } from "../organizations/cli";
import { type CliContext, operatorFolder } from "../update/cli";
import {
  type ModuleCreateHost,
  type ModuleCreateReport,
  planModuleCreate,
} from "./module-create";
import { moduleScaffoldStacks } from "./scaffold";

/** `lazurio module create`: the terminal surface of module creation
 * (decision F52). CLI first (root decision 0167): the Launchpad has no route
 * for it; an agent runs it for the person. */
export const moduleCreateHelp = `module create personalspace/<module> --stack <stack> [--name <name>] [--port N] --dry-run [--folder <absolute Folder>] [--json]
  Plans a module of your own in your Personalspace (decision F52): a private
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
  without one the slot's pull request declares it); its Git ignores
  workspace/<module> (personalspace-workspace-tracked); no directory and no slot
  has that name (directory_exists, slot_exists; letter case ignored); the name
  is valid and reserved by neither Lazurio nor the gateway (invalid_slug,
  reserved_slug); GitHub has no <login>/<module>, letter case ignored
  (repository-exists: an existing repository is never taken over); and a port is
  free (port_outside_pool, port_taken, pool_exhausted). A Personalspace that
  still names the template's placeholder owner is only a warning (#377).
  --dry-run prints the plan and writes nothing: the repository, the slot, the
  lease, the files with their tree_hash and the plan's digest (plan). The real
  run follows in a later version. --teams is refused (a personal module has no
  Teams), and an Organization's module (<Organization>/<module>) is refused with
  organization-form-unavailable until Lazurio/LazurioPlatform#267. --json prints
  one JSON line per step, then the report (lazurio.module_create.report.v1).
  Exit status: 0 planned, 2 refused or usage.`;

export class ModuleCreateUsageError extends Error {}

const usage =
  "Usage: module create personalspace/<module> --stack <stack> [--name <name>] [--port N] --dry-run [--folder <Folder>] [--json]";

export type ModuleCreateStep = Readonly<{
  key: "plan";
  state: "running" | "done" | "failed";
  detail?: string;
  code?: string;
}>;

function parse(args: string[]) {
  let values: {
    folder?: string | undefined;
    json?: boolean | undefined;
    stack?: string | undefined;
    name?: string | undefined;
    port?: string | undefined;
    teams?: string | undefined;
    "dry-run"?: boolean | undefined;
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
        "dry-run": { type: "boolean" },
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
      `module create takes one module, personalspace/<module>; also given: ${rest.map(shown).join(" ")}\n${usage}`,
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
  if (values.teams !== undefined && personal)
    throw new ModuleCreateUsageError(
      `A personal module has no Teams: leave out --teams.\n${usage}`,
    );
  if (values["dry-run"] !== true && personal)
    throw new ModuleCreateUsageError(
      `This version plans only (--dry-run): show the person the plan; the real run follows in a later version.\n${usage}`,
    );
  return {
    selector,
    stack: values.stack,
    name: values.name,
    port: values.port === undefined ? undefined : Number(values.port),
    folder: values.folder,
    json: values.json === true,
  };
}

/** The report in a few lines for a person reading the terminal. */
export function renderModuleCreate(report: ModuleCreateReport): string {
  const title =
    {
      actionable: "plan ready, nothing written (--dry-run)",
      completed: "module created",
      action_required: "module created, something is left to do",
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
    lines.push(`Refused ${issue.code}: ${shown(issue.message)}`);
  if (report.next_steps.length > 0) {
    lines.push("Next steps:");
    report.next_steps.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${shown(step)}`);
    });
  }
  return lines.join("\n");
}

/** This process's gh and git and the holder decision over them (#186). */
export function processModuleCreateHost(
  context: Pick<CliContext, "env" | "platform">,
): ModuleCreateHost {
  const host = processGitHubHost({
    env: context.env,
    platform: context.platform,
  });
  return Object.freeze({
    holder: createPersonalspaceHolder(() => host).decide,
    github: host.github,
    git: host.git,
  });
}

export async function runModuleCreateCommand(
  args: string[],
  context: CliContext & Readonly<{ cwd: string }>,
  write: (line: string) => void,
  // Test seam: the host; the product asks this process's gh and git.
  hostFor: (folder: string) => ModuleCreateHost = () =>
    processModuleCreateHost(context),
): Promise<number> {
  const options = parse(args);
  const step = (entry: ModuleCreateStep) =>
    write(
      options.json
        ? JSON.stringify({ kind: "module-create-step", ...entry })
        : `${shown(options.selector)}  ${entry.key} ${entry.state}${entry.code === undefined ? "" : ` ${entry.code}`}${entry.detail === undefined ? "" : `: ${shown(entry.detail)}`}`,
    );
  const folder = options.folder ?? (await operatorFolder(context));
  if (folder === undefined) {
    write(
      options.json
        ? JSON.stringify({ kind: "blocked", reason: "folder-unknown" })
        : "No Folder known: name it with --folder <absolute Folder>.",
    );
    return 2;
  }
  step({ key: "plan", state: "running" });
  const report = await planModuleCreate(
    {
      folder,
      cwd: context.cwd,
      selector: options.selector,
      stack: options.stack,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.port === undefined ? {} : { port: options.port }),
    },
    hostFor(folder),
  );
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
  write(options.json ? JSON.stringify(report) : renderModuleCreate(report));
  return report.status === "actionable" ? 0 : 2;
}
