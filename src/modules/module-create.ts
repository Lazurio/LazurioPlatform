import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ContentGit } from "../content/git";
import type { ContentGitHub } from "../content/github";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import {
  folderHasPersonalspace,
  type PersonalspaceHolderRead,
  personalspaceName,
} from "../organizations/personalspace";
import {
  readCheckoutFileBytes,
  readCheckoutJson,
} from "../providers/owned-json";
import {
  assertSlug,
  assertStack,
  defaultScaffoldVersions,
  environmentPorts,
  ModuleScaffoldError,
  type ModuleScaffoldPlan,
  type ModuleSlot,
  type PortPool,
  personalModulePortPool,
  planModuleScaffold,
  type ScaffoldLease,
  type ScaffoldTemplates,
  scaffoldBunVersion,
} from "./scaffold";
import { moduleTemplates } from "./scaffold-templates";

// `lazurio module create personalspace/<slug>` (decision F52; root decision
// 0171, addendum of 2026-10-13): a module of the person who holds this
// Environment's Personalspace, in a private repository `<login>/<slug>` of
// their own GitHub account, checked out in `personalspace/<owner>/workspace/
// <slug>`, its slot declared by a pull request into their Personalspace.
// This half is the plan: every check reads only, and `--dry-run` writes
// nothing and asks GitHub only GETs. The report is the root's
// `lazurio.module_create.report.v1` with the person's repository added.

export const moduleCreateReportVersion = "lazurio.module_create.report.v1";

/** The owner the template's `modules.manifest.json` names until the
 * template's own bootstrap replaces it (its `OWNER_PLACEHOLDER`), which
 * `lazurio personalspace install` does not run (Lazurio/LazurioPlatform#377). */
export const templateOwnerPlaceholder = "owner-github-username";

export type ModuleCreateRequest = Readonly<{
  folder: string;
  /** Where the command runs: a task worktree of the held Personalspace, for
   * the real run. */
  cwd: string;
  selector: string;
  stack: string;
  name?: string | undefined;
  port?: number | undefined;
}>;

/** What the plan reads: whose Personalspace this is (#186), gh for the
 * repository's name, git for the layout, and the templates. */
export type ModuleCreateHost = Readonly<{
  holder: PersonalspaceHolderRead;
  github: Pick<ContentGitHub, "repository">;
  git: Pick<ContentGit, "worktree" | "ignored">;
  /** Test seam: the embedded templates by default. */
  templates?: ScaffoldTemplates | undefined;
}>;

export type ModuleCreateIssue = Readonly<{
  code: string;
  message: string;
  action?: string;
}>;

export type ModuleCreateStatus =
  | "actionable"
  | "blocked"
  | "completed"
  | "action_required";

export type ModuleCreateReport = {
  schema_version: typeof moduleCreateReportVersion;
  status: ModuleCreateStatus;
  reason: string;
  dry_run: boolean;
  scope: "personalspace" | "organization" | null;
  module: {
    name: string | null;
    slug: string | null;
    stack: string | null;
    display_name: string | null;
  };
  /** The person's repository the run creates; private, never adopted. */
  repository: { full_name: string; private: true; create: boolean } | null;
  slot: ModuleSlot | null;
  lease: ScaffoldLease | null;
  files: { path: string; bytes: number; mode?: string }[];
  generated_by_install: string[];
  tree_hash: string | null;
  /** The digest of everything the person confirms (see `planDigest`). */
  plan: string | null;
  /** The manifest the slot goes into, with the pool it declares. */
  manifest: {
    path: string;
    module_port_pool: PortPool;
    adds_pool: boolean;
  } | null;
  /** The task worktree of the Personalspace the command runs in, if any. */
  worktree: { path: string; branch: string | null } | null;
  /** Where the module is placed: the held Personalspace's
   * `workspace/<slug>`. */
  module_root: string | null;
  warnings: string[];
  issues: ModuleCreateIssue[];
  next_steps: string[];
  /** The Lazurio Module Standard checks, once the Platform has them (#267). */
  standard: null;
};

/** A refusal before anything is written, with its stable code. */
export class ModuleCreateRefusal extends Error {
  readonly code: string;
  readonly action: string | undefined;
  constructor(code: string, message: string, action?: string) {
    super(message);
    this.name = "ModuleCreateRefusal";
    this.code = code;
    this.action = action;
  }
}

/** The task worktree of the held Personalspace the command runs in. */
export type TaskWorktree = Readonly<{
  path: string;
  branch: string | null;
  /** A linked worktree (its own Git directory), not the primary checkout. */
  linked: boolean;
}>;

/** What a real run needs besides the report: the planned module and the
 * places it goes. */
export type PlannedPersonalModule = Readonly<{
  folder: string;
  login: string;
  /** The held Personalspace's primary checkout. */
  space: string;
  worktree: TaskWorktree | null;
  manifestPath: string;
  manifestText: string;
  pool: PortPool;
  addsPool: boolean;
  plan: ModuleScaffoldPlan;
  moduleRoot: string;
}>;

const selectorPattern = /^([^/\s]+)\/([^/\s]+)$/;

const holderActions: Readonly<Record<string, string>> = {
  "github-signed-out":
    "Sign in to GitHub here (gh auth login), then run the command again.",
  "github-unavailable":
    "GitHub did not answer; run the command again in a moment.",
  "github-identity-mismatch":
    "Sign gh in with this Environment's Owner's GitHub account; another account's modules do not belong here.",
  "personalspace-ambiguous":
    "Leave exactly one directory in personalspace/, the person's own Personalspace; a task worktree goes to personalspace/.worktrees/<task>.",
  "personalspace-unavailable":
    "personalspace/ and its one directory must be real directories of your own account.",
  "personalspace-foreign":
    "personalspace/ holds another account's checkout; it is left untouched. Install your own with lazurio personalspace install.",
  "personalspace-not-owned":
    "GitHub does not know this Personalspace as your own repository; see gh auth status.",
  "personalspace-public":
    "Make the Personalspace repository private on GitHub first; a Personalspace is never public.",
  "personalspace-unverified":
    "Whose Personalspace this is has not been verified with GitHub yet; run the command again.",
};

function baseReport(request: ModuleCreateRequest): ModuleCreateReport {
  return {
    schema_version: moduleCreateReportVersion,
    status: "blocked",
    reason: "",
    dry_run: true,
    scope: null,
    module: {
      name: null,
      slug: null,
      stack: request.stack ?? null,
      display_name: null,
    },
    repository: null,
    slot: null,
    lease: null,
    files: [],
    generated_by_install: [],
    tree_hash: null,
    plan: null,
    manifest: null,
    worktree: null,
    module_root: null,
    warnings: [],
    issues: [],
    next_steps: [],
    standard: null,
  };
}

/** The report of a refusal: `blocked`, its code as the reason, its action
 * as the next step. */
export function refusedReport(
  report: ModuleCreateReport,
  error: ModuleCreateRefusal | ModuleScaffoldError,
): ModuleCreateReport {
  report.status = "blocked";
  report.reason = error.code;
  report.issues.push({
    code: error.code,
    message: error.message,
    ...(error.action === undefined ? {} : { action: error.action }),
  });
  report.next_steps = report.issues.flatMap((issue) =>
    issue.action === undefined ? [] : [issue.action],
  );
  return report;
}

/**
 * Plans a personal module and checks everything a real run checks, reading
 * only (see the module comment). Never throws for a refusal: it is the
 * report's `blocked` with its code.
 */
export async function planModuleCreate(
  request: ModuleCreateRequest,
  host: ModuleCreateHost,
): Promise<ModuleCreateReport> {
  const planned = await preparePersonalModule(request, host);
  if (!planned.ok) return planned.report;
  planned.report.next_steps = dryRunSteps(planned.report, planned.module);
  return planned.report;
}

/**
 * Every read-only check and the plan, for the dry run and the real run
 * alike: the report (actionable) and the planned module, or the report of
 * the refusal.
 */
export async function preparePersonalModule(
  request: ModuleCreateRequest,
  host: ModuleCreateHost,
): Promise<
  | Readonly<{
      ok: true;
      report: ModuleCreateReport;
      module: PlannedPersonalModule;
    }>
  | Readonly<{ ok: false; report: ModuleCreateReport }>
> {
  const report = baseReport(request);
  try {
    const module = await plan(request, host, report);
    return { ok: true, report, module };
  } catch (error) {
    if (
      !(error instanceof ModuleCreateRefusal) &&
      !(error instanceof ModuleScaffoldError)
    )
      throw error;
    return { ok: false, report: refusedReport(report, error) };
  }
}

async function plan(
  request: ModuleCreateRequest,
  host: ModuleCreateHost,
  report: ModuleCreateReport,
): Promise<PlannedPersonalModule> {
  // The name and the stack first: they need nothing read.
  const match = selectorPattern.exec(String(request.selector ?? ""));
  if (match === null)
    throw new ModuleCreateRefusal(
      "invalid_selector",
      `${JSON.stringify(request.selector)} is not personalspace/<slug>.`,
      "Name the module as personalspace/<slug>.",
    );
  const [, scope, name] = match as unknown as [string, string, string];
  if (scope.toLowerCase() !== personalspaceName) {
    report.scope = "organization";
    report.module.name = `${scope}/${name}`;
    throw new ModuleCreateRefusal(
      "organization-form-unavailable",
      `This Lazurio creates only personal modules (personalspace/<slug>); an Organization's module (${scope}/${name}) comes with Lazurio/LazurioPlatform#267.`,
      "Until then, create an Organization's module with the Lazurio root's lazurio module create <Organization>/<slug>, from a task worktree of the Organization root.",
    );
  }
  report.scope = "personalspace";
  report.module.name = `${personalspaceName}/${name}`;
  report.module.slug = name;
  assertStack(request.stack);
  const slug = assertSlug(name);

  // 1. A Personalspace in this Environment, 2. held by gh's account (#186).
  if (!(await folderHasPersonalspace(request.folder)))
    throw new ModuleCreateRefusal(
      "personalspace-not-here",
      "This Environment holds no Personalspace: personal modules live on a workstation or on the person's personal Remote Environment.",
      "Create the personal module on your own computer or on your personal Remote Environment.",
    );
  const holder = await host.holder(request.folder);
  if (holder.kind === "absent")
    throw new ModuleCreateRefusal(
      "personalspace-absent",
      "This Environment has no Personalspace installed yet.",
      "Install it first: lazurio personalspace install.",
    );
  if (holder.kind === "blocked")
    throw new ModuleCreateRefusal(
      holder.reason,
      `The Personalspace is not held by this Environment's GitHub account (${holder.reason}).`,
      holderActions[holder.reason],
    );
  const { login, directory: space } = holder;

  // 3. The layout: the task worktree, the manifest, workspace/ and its slug.
  const worktree = await locateTaskWorktree(request.cwd, space, host.git);
  report.worktree =
    worktree === null ? null : { path: worktree.path, branch: worktree.branch };
  const primary = await readManifest(space);
  const target =
    worktree === null ? primary : await readManifest(worktree.path);
  const pool = poolOf(target.document);
  report.manifest = {
    path: target.path,
    module_port_pool: pool.pool,
    adds_pool: pool.adds,
  };
  const declaredOwner = (target.document as { owner?: unknown }).owner;
  if (declaredOwner === templateOwnerPlaceholder)
    report.warnings.push(
      `This Personalspace still names the template's placeholder owner (${templateOwnerPlaceholder} in modules.manifest.json): it was installed without the template's bootstrap. The module is created all the same; naming the owner is Lazurio/LazurioPlatform#377.`,
    );
  else if (
    typeof declaredOwner !== "string" ||
    declaredOwner.toLowerCase() !== login.toLowerCase()
  )
    report.warnings.push(
      `modules.manifest.json names the owner ${JSON.stringify(declaredOwner)}, not ${login}, whose Personalspace this is.`,
    );
  const workspace = join(space, "workspace");
  const moduleRoot = join(workspace, slug);
  report.module_root = moduleRoot;
  if (!(await absent(workspace)))
    try {
      await inspectCheckoutDirectory(workspace);
    } catch {
      throw new ModuleCreateRefusal(
        "personalspace-unavailable",
        "The Personalspace's workspace/ is not a real directory of your own account.",
        holderActions["personalspace-unavailable"],
      );
    }
  const ignored = await host.git.ignored(space, `workspace/${slug}`);
  if (ignored === null)
    throw new ModuleCreateRefusal(
      "personalspace-unavailable",
      "Git could not say whether the Personalspace ignores workspace/<slug>.",
      "Check that the Personalspace is a Git checkout and git runs here, then run the command again.",
    );
  if (!ignored)
    throw new ModuleCreateRefusal(
      "personalspace-workspace-tracked",
      `The Personalspace's Git does not ignore workspace/${slug}: a module there would become part of the Personalspace repository.`,
      "Let the Personalspace's .gitignore ignore workspace/* (as Lazurio/PersonalspaceTemplate_GEN3 does) in a pull request, then run the command again.",
    );
  if (await occupied(workspace, slug))
    throw new ModuleCreateRefusal(
      "directory_exists",
      `${moduleRoot} already exists (letter case ignored); a module is never written over an existing directory.`,
      "Choose another slug, or work in the existing module.",
    );

  // 4. The plan: slug rules, the slot and the lease (the generator, F52).
  const takenPorts = [
    ...(await folderLeasePorts(request.folder, space)),
    ...environmentPorts,
  ];
  const planned = planModuleScaffold({
    owner: { kind: "personal", login },
    slug,
    stack: request.stack,
    displayName: request.name,
    port: request.port ?? null,
    pool: pool.pool,
    existingSlots: [...slotsOf(primary.document), ...slotsOf(target.document)],
    takenPorts,
    templates: host.templates ?? moduleTemplates,
    versions: { bun: scaffoldBunVersion, ...defaultScaffoldVersions },
  });

  // 5. The person's repository `<login>/<slug>`: never one that exists.
  const fullName = `${login}/${slug}`;
  const existing = await host.github.repository(login, slug);
  if (existing.kind === "observed")
    throw new ModuleCreateRefusal(
      "repository-exists",
      `GitHub already has ${existing.repository.fullName} (names are compared ignoring letter case); an existing repository is never taken over.`,
      "Ask the person for another name of the module (its slug).",
    );
  if (existing.kind === "unavailable")
    throw new ModuleCreateRefusal(
      "github-unavailable",
      `GitHub did not answer whether ${fullName} exists.`,
      holderActions["github-unavailable"],
    );

  report.status = "actionable";
  report.reason = "scaffold_planned";
  report.module.display_name = planned.displayName;
  report.repository = { full_name: fullName, private: true, create: true };
  report.slot = planned.slot;
  report.lease = planned.lease;
  report.files = planned.files.map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.content),
    ...(file.mode === undefined ? {} : { mode: file.mode }),
  }));
  report.generated_by_install = [...planned.generatedByInstall];
  report.tree_hash = planned.treeHash;
  report.warnings.push(...planned.warnings);
  report.plan = planDigest({
    repository: fullName,
    plan: planned,
    pool: pool.pool,
    addsPool: pool.adds,
  });
  return Object.freeze({
    folder: request.folder,
    login,
    space,
    worktree,
    manifestPath: target.path,
    manifestText: target.text,
    pool: pool.pool,
    addsPool: pool.adds,
    plan: planned,
    moduleRoot,
  });
}

/**
 * The digest of everything the person confirms of a plan: the repository
 * (always private), the module, its stack and name, its slot, lease and
 * files, and the pool its manifest gains. A real run creates exactly the
 * plan of this digest.
 */
export function planDigest(
  input: Readonly<{
    repository: string;
    plan: ModuleScaffoldPlan;
    pool: PortPool;
    addsPool: boolean;
  }>,
): string {
  const confirmed = {
    scope: personalspaceName,
    repository: input.repository,
    private: true,
    module: input.plan.module,
    stack: input.plan.stack,
    display_name: input.plan.displayName,
    slot: input.plan.slot,
    lease: input.plan.lease,
    tree_hash: input.plan.treeHash,
    module_port_pool: input.pool,
    adds_pool: input.addsPool,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(confirmed)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

function dryRunSteps(
  report: ModuleCreateReport,
  module: PlannedPersonalModule,
): string[] {
  const steps: string[] = [];
  if (module.worktree === null || !module.worktree.linked)
    steps.push(
      `The real run needs a task worktree of the Personalspace beside it in personalspace/.worktrees/ (never inside it, never a second directory in personalspace/): git -C '${module.space}' worktree add -b <branch> '${join(module.folder, personalspaceName, ".worktrees", "<task>")}' main, then run the command from it.`,
    );
  steps.push(
    `Show the person this plan in the thread: the private repository ${report.repository?.full_name} on their own GitHub account, the stack ${module.plan.stack}, the files and the port ${module.plan.lease?.port ?? "(none, no app)"}. Create it only after they confirm it.`,
    "The real run (creating the repository, the first push and the slot) is not in this version of Lazurio yet; it follows on Lazurio/LazurioPlatform#359.",
  );
  if (module.addsPool)
    steps.push(
      `The pull request that declares the slot also declares module_port_pool ${module.pool.start}-${module.pool.end} in modules.manifest.json, which this Personalspace does not declare yet.`,
    );
  if (report.warnings.some((warning) => warning.includes("#377")))
    steps.push(
      "The Personalspace still names the template's placeholder owner; naming it is Lazurio/LazurioPlatform#377 and not part of creating this module (do not run the template's bootstrap for it).",
    );
  return steps;
}

// ---- reads -------------------------------------------------------------------

const absent = (path: string) =>
  lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );

/** Whether `name`, or an entry differing from it only by letter case (one
 * entry on a case-insensitive filesystem), is in `directory`. */
async function occupied(directory: string, name: string): Promise<boolean> {
  if (!(await absent(join(directory, name)))) return true;
  const lower = name.toLowerCase();
  const entries = await readdir(directory).catch(() => [] as string[]);
  return entries.some((entry) => entry.toLowerCase() === lower);
}

type Manifest = Readonly<{ path: string; text: string; document: unknown }>;

async function readManifest(directory: string): Promise<Manifest> {
  const path = join(directory, "modules.manifest.json");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readCheckoutFileBytes(path),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      throw new ModuleCreateRefusal(
        "modules_manifest_missing",
        `${path} is missing: the Personalspace declares its modules there.`,
        "Add modules.manifest.json from Lazurio/PersonalspaceTemplate_GEN3 in the pull request that declares the slot, then run the command again.",
      );
    throw new ModuleCreateRefusal(
      "manifest_invalid",
      `${path} cannot be read as a file of your own checkout.`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new ModuleCreateRefusal(
      "manifest_invalid",
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "Fix modules.manifest.json in a pull request, then run the command again.",
    );
  }
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    !Array.isArray((document as { module_slots?: unknown }).module_slots)
  )
    throw new ModuleCreateRefusal(
      "manifest_invalid",
      `${path} has no module_slots array.`,
      "Fix modules.manifest.json in a pull request (Lazurio/PersonalspaceTemplate_GEN3 shows its shape), then run the command again.",
    );
  return { path, text, document };
}

const slotsOf = (document: unknown): readonly unknown[] =>
  (document as { module_slots: unknown[] }).module_slots;

/** The personal pool the manifest declares, which must lie in the reserved
 * range; or the reserved range itself, to be declared by the slot's pull
 * request (`adds`). */
function poolOf(
  document: unknown,
): Readonly<{ pool: PortPool; adds: boolean }> {
  if (!Object.hasOwn(document as object, "module_port_pool"))
    return { pool: personalModulePortPool, adds: true };
  const declared = (document as { module_port_pool?: unknown })
    .module_port_pool as Record<string, unknown> | null;
  const keys =
    declared !== null &&
    typeof declared === "object" &&
    !Array.isArray(declared)
      ? Object.keys(declared)
      : null;
  const start = declared?.start;
  const end = declared?.end;
  if (
    keys === null ||
    keys.some((key) => key !== "start" && key !== "end") ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start > end ||
    start < personalModulePortPool.start ||
    end > personalModulePortPool.end
  )
    throw new ModuleCreateRefusal(
      "personalspace-pool-invalid",
      `modules.manifest.json declares module_port_pool ${JSON.stringify(declared)}; a Personalspace's pool lies in the reserved range ${personalModulePortPool.start}-${personalModulePortPool.end}, which no Organization uses.`,
      `Declare "module_port_pool": {"start": ${personalModulePortPool.start}, "end": ${personalModulePortPool.end}} in modules.manifest.json in a pull request, then run the command again.`,
    );
  return { pool: { start, end }, adds: false };
}

/** The task worktree `cwd` is in, when it is a checkout of the held
 * Personalspace's repository other than the Personalspace itself. */
async function locateTaskWorktree(
  cwd: string,
  space: string,
  git: Pick<ContentGit, "worktree">,
): Promise<TaskWorktree | null> {
  const [here, primary] = await Promise.all([
    git.worktree(cwd).catch(() => null),
    git.worktree(space).catch(() => null),
  ]);
  if (here === null || primary === null) return null;
  const [hereCommon, primaryCommon, hereTop, spaceReal] = await Promise.all([
    realpathOrNull(here.commonDir),
    realpathOrNull(primary.commonDir),
    realpathOrNull(here.top),
    realpathOrNull(space),
  ]);
  if (
    hereCommon === null ||
    hereCommon !== primaryCommon ||
    hereTop === null ||
    hereTop === spaceReal
  )
    return null;
  const [gitDir, commonDir] = await Promise.all([
    realpathOrNull(here.gitDir),
    realpathOrNull(here.commonDir),
  ]);
  return Object.freeze({
    path: hereTop,
    branch: here.branch,
    linked: gitDir !== null && gitDir !== commonDir,
  });
}

const realpathOrNull = (path: string) => realpath(path).catch(() => null);

/**
 * Every port a module of the Folder leases, as far as it can be read: the
 * modules of every Organization (`workspace/*`, `mission-control`,
 * `design-system`), the gateway's globs, and of the held Personalspace. A
 * declaration that cannot be read holds no port this plan could see.
 */
export async function folderLeasePorts(
  folder: string,
  space: string,
): Promise<number[]> {
  const manifests: string[] = [];
  const visible = async (directory: string) =>
    (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(directory, entry.name));
  for (const root of await visible(join(folder, "organizations"))) {
    for (const module of await visible(join(root, "workspace")))
      manifests.push(join(module, "lazurio.module.json"));
    manifests.push(
      join(root, "mission-control", "lazurio.module.json"),
      join(root, "design-system", "lazurio.module.json"),
    );
  }
  for (const module of await visible(join(space, "workspace")))
    manifests.push(join(module, "lazurio.module.json"));
  const ports = new Set<number>();
  for (const path of manifests) {
    const document = await readCheckoutJson(path).catch(() => null);
    const leases = (document as { port_leases?: unknown } | null)?.port_leases;
    if (!Array.isArray(leases)) continue;
    for (const lease of leases) {
      const port = (lease as { port?: unknown } | null)?.port;
      if (typeof port === "number" && Number.isInteger(port)) ports.add(port);
    }
  }
  return [...ports].sort((left, right) => left - right);
}
