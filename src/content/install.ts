import { join } from "node:path";
import { catalogChecks } from "../doctor/doctor";
import { inspectCanonicalInventory } from "../organizations/canonical-inventory";
import { locatePersonalspace } from "../organizations/personalspace";
import { readOrganizationDocuments } from "../organizations/read-documents";
import { rootApplicationPaths } from "../organizations/repository-slots";
import { resolveOrganizationRootDocuments } from "../organizations/root-resolution";
import { githubRemoteCoordinate } from "../providers/git-checkout";
import type { ContentGitHub, GitHubViewer, ViewerAnswer } from "./github";
import { type ContentHost, catalogOf, readFolderKind } from "./host";
import { tryContentLock } from "./lock";
import {
  ensureCheckoutDirectories,
  isDestinationName,
  materializeRepository,
} from "./materialize";
import {
  type ContentFailure,
  type ContentItemRef,
  type ContentRefusal,
  type ContentScope,
  type ContentStep,
  contentScope,
  type StepKey,
  sameRepository,
  scopeAdmits,
} from "./model";
import { resolveOrganizationRootRepository } from "./organization-root";
import {
  classifySlotAccess,
  type OrganizationRole,
  type RepositoryPermission,
  verifyOrganizationRole,
} from "./role";
import {
  organizationsOf,
  personalspaceRepositoryName,
  personalspaceTemplate,
  viewerMayHold,
} from "./status";

// The install use case of content (decision F9, addendum of 2026-10-04), one
// core for `lazurio organization install`, `lazurio personalspace install`
// and the Launchpad's `POST /api/content/install`. It runs only when called:
// no start, health check, status read or product update triggers it, and it
// never changes the installed product. Existing repositories are never
// fetched, switched or reset here; that is synchronization, a separate
// operation (docs/content-sync.md).

export type InstallRequest = Readonly<{
  /** Absent: everything this Environment holds. */
  items?: readonly ContentItemRef[] | undefined;
  /** The operator's explicit `<owner>/<repository>` root of an Organization
   * the Folder does not hold yet, by lowercase GitHub login (the CLI's
   * `--root`). */
  roots?: Readonly<Record<string, string>> | undefined;
  /** The role the caller asks for in an Organization, by lowercase GitHub
   * login: `admin` for the CLI's bare form, `builder` or `steward` for its
   * `--role`; absent (the Launchpad), the role is resolved live. Either
   * way GitHub must confirm it. */
  roles?: Readonly<Record<string, OrganizationRole>> | undefined;
}>;

export type ContentPlan =
  | Readonly<{ kind: "not-allowed"; reason: ContentRefusal }>
  | Readonly<{
      kind: "planned";
      scope: Extract<ContentScope, { allowed: true }>;
      items: readonly ContentItemRef[];
      roots: Readonly<Record<string, string>>;
      roles: Readonly<Record<string, OrganizationRole>>;
    }>;

/** What happened to one declared child repository of an Organization. */
export type RepositoryOutcome = Readonly<{
  path: string;
  repository?: string;
  result:
    | "materialized"
    | "present"
    | "denied"
    | "unavailable"
    | "blocked"
    | "failed"
    | "excluded_by_role_scope"
    | "excluded"
    | "no-repository";
  reason?: string;
}>;

export type PreparationOutcome = Readonly<{
  module: string;
  result: "prepared" | "not-prepared";
  reason?: string;
}>;

export type ItemOutcome = Readonly<{
  item: ContentItemRef;
  state: "succeeded" | "failed";
  /** The root repository, or the Personalspace repository. */
  repository?: string;
  /** Relative to the Folder. */
  directory?: string;
  /** The role GitHub confirmed in the Organization. */
  role?: OrganizationRole;
  repositories?: readonly RepositoryOutcome[];
  preparations?: readonly PreparationOutcome[];
}>;

export type InstallResult =
  | Readonly<{
      kind: "content-install";
      state: "succeeded" | "failed";
      items: readonly ItemOutcome[];
      failure?: ContentFailure;
    }>
  | Readonly<{ kind: "not-allowed"; reason: ContentRefusal }>
  | Readonly<{ kind: "busy" }>;

export type StepListener = (step: ContentStep) => void;

const sameItem = (a: ContentItemRef, b: ContentItemRef) =>
  a.kind === b.kind &&
  (a.kind === "personalspace" ||
    (b.kind === "organization" &&
      a.login.toLowerCase() === b.login.toLowerCase()));

/** Which items one request installs on this Folder, or why none. */
export async function planContentInstall(
  folder: string,
  request: InstallRequest,
  host: ContentHost,
): Promise<ContentPlan> {
  let scope: ContentScope;
  try {
    const kind = await readFolderKind(folder);
    scope = contentScope(kind.preset, kind.machine);
  } catch {
    return { kind: "not-allowed", reason: "folder-unreadable" };
  }
  if (!scope.allowed) return { kind: "not-allowed", reason: scope.reason };
  const items: ContentItemRef[] = [];
  const add = (item: ContentItemRef) => {
    if (!items.some((known) => sameItem(known, item))) items.push(item);
  };
  if (request.items !== undefined) {
    for (const item of request.items) {
      if (!scopeAdmits(scope, item))
        return { kind: "not-allowed", reason: "not-for-this-environment" };
      add(item);
    }
  } else {
    if (scope.organizations === "folder") {
      const catalog = await catalogOf(host, folder);
      for (const entry of catalog.organizations)
        if (entry.forgeLogin !== undefined)
          add({ kind: "organization", login: entry.forgeLogin });
    } else if (scope.organizations !== "none")
      add({ kind: "organization", login: scope.organizations.only });
    if (scope.personalspace) add({ kind: "personalspace" });
  }
  const roots: Record<string, string> = {};
  for (const [login, root] of Object.entries(request.roots ?? {}))
    roots[login.toLowerCase()] = root;
  const roles: Record<string, OrganizationRole> = {};
  for (const [login, role] of Object.entries(request.roles ?? {}))
    roles[login.toLowerCase()] = role;
  return {
    kind: "planned",
    scope,
    items: Object.freeze(items),
    roots: Object.freeze(roots),
    roles: Object.freeze(roles),
  };
}

/** The whole operation: plan, the Folder's content lock, run. */
export async function installContent(
  folder: string,
  request: InstallRequest,
  onStep: StepListener,
  host: ContentHost,
): Promise<InstallResult> {
  const plan = await planContentInstall(folder, request, host);
  if (plan.kind === "not-allowed") return plan;
  const lock = await tryContentLock(host.lockDirectory, folder);
  if (lock === null) return { kind: "busy" };
  try {
    return await runContentInstall(folder, plan, onStep, host);
  } finally {
    await lock.release();
  }
}

/** One planned install, under a content lock the caller holds. Items run in
 * order and independently: a failed item never stops the next one. */
export async function runContentInstall(
  folder: string,
  plan: Extract<ContentPlan, { kind: "planned" }>,
  onStep: StepListener,
  host: ContentHost,
): Promise<Extract<InstallResult, { kind: "content-install" }>> {
  let viewer: Promise<ViewerAnswer> | undefined;
  const context: RunContext = {
    folder,
    host,
    scope: plan.scope,
    roots: plan.roots,
    roles: plan.roles,
    viewer: () => {
      viewer ??= host.github.viewer();
      return viewer;
    },
  };
  const outcomes: ItemOutcome[] = [];
  let failure: ContentFailure | undefined;
  for (const item of plan.items) {
    const steps = stepper(item, (step) => {
      if (step.state === "failed" && failure === undefined)
        failure = Object.freeze({
          item: step.item,
          key: step.key,
          code: step.code ?? "operation-failed",
          detail: step.detail ?? "",
        });
      onStep(step);
    });
    let outcome: ItemOutcome;
    try {
      outcome =
        item.kind === "organization"
          ? await installOrganization(item, context, steps)
          : await installPersonalspace(item, context, steps);
    } catch {
      // An unexpected failure ends this item at the step that was running;
      // nothing raw (a path, a message) leaves.
      steps.fail(steps.current(), "operation-failed", "unexpected failure");
      outcome = { item, state: "failed" };
    }
    outcomes.push(outcome);
  }
  return Object.freeze({
    kind: "content-install",
    state: failure === undefined ? "succeeded" : "failed",
    items: Object.freeze(outcomes),
    ...(failure === undefined ? {} : { failure }),
  });
}

type RunContext = Readonly<{
  folder: string;
  host: ContentHost;
  scope: Extract<ContentScope, { allowed: true }>;
  roots: Readonly<Record<string, string>>;
  roles: Readonly<Record<string, OrganizationRole>>;
  viewer: () => Promise<ViewerAnswer>;
}>;

type Stepper = ReturnType<typeof stepper>;

/** Step events of one item; `fail` returns the item's failed outcome. */
function stepper(item: ContentItemRef, emit: (step: ContentStep) => void) {
  let current: StepKey = item.kind === "organization" ? "access" : "find";
  const event = (
    key: StepKey,
    state: ContentStep["state"],
    detail?: string,
    code?: string,
  ) => {
    current = key;
    emit(
      Object.freeze({
        item,
        key,
        state,
        ...(detail === undefined ? {} : { detail }),
        ...(code === undefined ? {} : { code }),
      }),
    );
  };
  return {
    current: () => current,
    running: (key: StepKey) => event(key, "running"),
    done: (key: StepKey, detail?: string) => event(key, "done", detail),
    skipped: (key: StepKey, detail?: string) => event(key, "skipped", detail),
    fail: (key: StepKey, code: string, detail: string): ItemOutcome => {
      event(key, "failed", detail, code);
      return { item, state: "failed" };
    },
  };
}

/** The viewer, or the failure of `key` when gh cannot say who it is. */
async function signedIn(
  context: RunContext,
  steps: Stepper,
  key: StepKey,
): Promise<GitHubViewer | ItemOutcome> {
  const answer = await context.viewer();
  if (answer.kind === "signed-in") return answer.viewer;
  return answer.kind === "signed-out"
    ? steps.fail(
        key,
        "github-signed-out",
        "gh is not signed in to GitHub on this Environment",
      )
    : steps.fail(
        key,
        "github-unavailable",
        "gh could not reach GitHub or is not installed",
      );
}

const isOutcome = (value: unknown): value is ItemOutcome =>
  typeof value === "object" && value !== null && "state" in value;

const relative = (folder: string, path: string) =>
  path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path;

// ---- Organization ----------------------------------------------------------

/** Verifies an Organization root's own declaration in the clone before it
 * is published: canonical documents that resolve, an Organization (not a
 * template) bound to `login`, and a declared `root_repository`, when there
 * is one, naming exactly the cloned repository. */
function rootDeclaration(login: string, repository: string) {
  return async (checkout: string): Promise<string | null> => {
    const documents = await readOrganizationDocuments(checkout);
    if (documents.kind !== "documents-observed")
      return "root-declaration-invalid";
    const resolution = resolveOrganizationRootDocuments(documents);
    if (
      ["missing", "legacy", "conflict"].includes(resolution.state) ||
      documents.canonical.kind !== "present" ||
      documents.modules.kind !== "present"
    )
      return "root-declaration-invalid";
    let inventory: ReturnType<typeof inspectCanonicalInventory>;
    try {
      inventory = inspectCanonicalInventory(
        documents.canonical.value,
        documents.modules.value,
      );
    } catch {
      return "root-declaration-invalid";
    }
    const canonical = inventory.canonical as Readonly<Record<string, unknown>>;
    if (canonical.kind !== "organization") return "organization-template";
    const organization = canonical.organization as Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    const owner = organization.forge_binding?.locator;
    const root = (
      canonical.root_repository as Readonly<Record<string, unknown>> | null
    )?.locator;
    if (
      typeof owner !== "string" ||
      owner.toLowerCase() !== login.toLowerCase() ||
      (typeof root === "string" && !sameRepository(root, repository))
    )
      return "root-declaration-mismatch";
    return null;
  };
}

const failureDetails: Readonly<Record<string, string>> = {
  "destination-invalid": "the destination is not a directory of this Folder",
  "clone-failed": "git clone failed; GitHub access or the network refused it",
  "checkout-unexpected":
    "the clone is not the expected repository on branch main",
  "publish-failed": "the verified clone could not be moved into place",
  "root-declaration-invalid":
    "the root has no readable canonical Organization declaration",
  "root-declaration-mismatch":
    "the root's declaration names another Organization or root repository",
  "organization-template": "the repository is a template, not an Organization",
};

type Child = Readonly<{
  path: string;
  segments: readonly string[];
  repository: string | null;
  kind: "module" | "productionspace";
  /** Not materialized, and nothing is asked of GitHub for it. */
  excluded?: "excluded" | "excluded_by_role_scope";
  /** A slot (or one above it) whose access declaration is malformed. */
  unclassified?: true;
}>;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

// The declared children content installation materializes (decision F33,
// 1.1 point 4): workspace modules, the root-level applications
// (`mission-control`, `design-system`) and the Production Space
// repositories. `infra` and repository databases (`mission-control/db`,
// `workspace/<module>/db`) are the Organization's own bootstrap (B7) and are
// left out. The role scope comes first, as the resident applies it
// (`R:lazurio/runtime/lazurio-update-lib.mjs`, restricted slot policy): a
// restricted (Admin-only) slot and every slot below one are in scope only for
// a verified Admin, and are otherwise `excluded_by_role_scope`; a slot whose
// access declaration (its own or one above it) is malformed is never
// materialized, for any role. Neither asks GitHub anything.
function declaredChildren(
  inventory: ReturnType<typeof inspectCanonicalInventory>,
  restricted: "include" | "exclude",
): Child[] {
  const raw = Array.isArray(inventory.modules.module_slots)
    ? (inventory.modules.module_slots as unknown[])
    : [];
  const conflicted = new Set(
    inventory.inventory.issues.flatMap((issue) => issue.indices),
  );
  // The access of a path and of every declared slot above it.
  const boundary = (path: string) => {
    let worst: "ordinary" | "restricted" | "unknown" = "ordinary";
    for (const candidate of raw) {
      const declaration = record(candidate);
      const at = declaration.path;
      if (typeof at !== "string" || (at !== path && !path.startsWith(`${at}/`)))
        continue;
      const access = classifySlotAccess(declaration);
      if (access === "unknown") return "unknown";
      if (access === "restricted") worst = "restricted";
    }
    return worst;
  };
  const children: Child[] = [];
  for (const slot of inventory.inventory.slots) {
    // A repository database may be declared without a slug; it is still
    // reported (and never materialized).
    if (
      slot === null ||
      (slot.id === null && !slot.nestedDatabase) ||
      conflicted.has(slot.index)
    )
      continue;
    const declaration = record(raw[slot.index]);
    const git = record(declaration.git);
    const remote = git.url ?? declaration.repo ?? declaration.repository;
    const repository =
      typeof remote === "string" ? githubRemoteCoordinate(remote.trim()) : null;
    const module =
      (slot.scope === "workspace" && !slot.nestedDatabase) ||
      (slot.scope === "root" && rootApplicationPaths.has(slot.path));
    const kind =
      slot.scope === "productionspace" ? "productionspace" : "module";
    const access = boundary(slot.path);
    children.push(
      Object.freeze({
        path: slot.path,
        segments: Object.freeze(slot.path.split("/")),
        repository,
        kind,
        ...(access === "unknown"
          ? { unclassified: true as const }
          : access === "restricted" && restricted === "exclude"
            ? { excluded: "excluded_by_role_scope" as const }
            : !module && kind !== "productionspace"
              ? { excluded: "excluded" as const }
              : {}),
      }),
    );
  }
  // Parents before children (a root application before anything below it).
  return children.sort(
    (a, b) =>
      a.segments.length - b.segments.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

async function materializeChild(
  root: string,
  child: Child,
  context: RunContext,
): Promise<RepositoryOutcome> {
  const where = {
    path: child.path,
    ...(child.repository === null ? {} : { repository: child.repository }),
  };
  if (child.unclassified)
    return {
      ...where,
      result: "blocked",
      reason: "access-classification-unknown",
    };
  if (child.excluded !== undefined) return { ...where, result: child.excluded };
  if (child.repository === null) return { ...where, result: "no-repository" };
  const parentSegments = child.segments.slice(0, -1);
  const name = child.segments.at(-1) as string;
  const destination = join(root, ...child.segments);
  // A present destination is reported, never entered or changed.
  const observed = await context.host.git.inspect(destination);
  if (observed.kind === "checkout")
    return sameRepository(observed.repository, child.repository)
      ? { ...where, result: "present" }
      : { ...where, result: "blocked", reason: "destination-occupied" };
  const [owner, repositoryName] = child.repository.split("/") as [
    string,
    string,
  ];
  const access = await context.host.github.repository(owner, repositoryName);
  if (
    access.kind === "missing" ||
    (access.kind === "observed" && !access.repository.readable)
  )
    return { ...where, result: "denied", reason: "repository-denied" };
  if (access.kind !== "observed")
    return { ...where, result: "unavailable", reason: "github-unavailable" };
  let parent: string;
  try {
    parent = await ensureCheckoutDirectories(root, parentSegments);
  } catch {
    return { ...where, result: "blocked", reason: "destination-invalid" };
  }
  const remote = await context.host.github.remote(access.repository.fullName);
  const result = await materializeRepository({
    parent,
    name,
    repository: child.repository,
    url: remote.url,
    credentialHelper: remote.credentialHelper,
    git: context.host.git,
  });
  if (result.kind === "materialized")
    return { ...where, result: "materialized" };
  if (result.kind === "occupied")
    return { ...where, result: "blocked", reason: "destination-occupied" };
  return { ...where, result: "failed", reason: result.code };
}

function childrenSummary(outcomes: readonly RepositoryOutcome[]): string {
  const counts = new Map<string, string[]>();
  for (const outcome of outcomes) {
    const list = counts.get(outcome.result) ?? [];
    list.push(outcome.path);
    counts.set(outcome.result, list);
  }
  if (counts.size === 0) return "no declared repositories";
  const order: RepositoryOutcome["result"][] = [
    "materialized",
    "present",
    "denied",
    "unavailable",
    "blocked",
    "failed",
    "excluded_by_role_scope",
    "excluded",
    "no-repository",
  ];
  return order
    .filter((result) => counts.has(result))
    .map((result) => {
      const paths = counts.get(result) as string[];
      return result === "materialized" || result === "present"
        ? `${paths.length} ${result}`
        : `${paths.length} ${result} (${paths.join(", ")})`;
    })
    .join("; ");
}

async function installOrganization(
  item: Extract<ContentItemRef, { kind: "organization" }>,
  context: RunContext,
  steps: Stepper,
): Promise<ItemOutcome> {
  const { folder, host } = context;
  const login = item.login;
  // access
  steps.running("access");
  const viewer = await signedIn(context, steps, "access");
  if (isOutcome(viewer)) return viewer;
  const resolution = await resolveOrganizationRootRepository({
    folder,
    login,
    catalog: await catalogOf(host, folder),
    git: host.git,
    github: host.github,
    root: context.roots[login.toLowerCase()],
  });
  if (resolution.kind === "ambiguous-in-folder")
    return steps.fail(
      "access",
      "organization-ambiguous",
      `more than one directory in organizations/ binds ${login}: ${resolution.directories.join(", ")}`,
    );
  if (resolution.kind === "failed")
    return steps.fail("access", resolution.code, resolution.detail);
  let rootRepository = resolution.repository;
  let rootPermission: RepositoryPermission | null = null;
  if (rootRepository !== null) {
    const [owner, name] = rootRepository.split("/") as [string, string];
    const access = await host.github.repository(owner, name);
    if (access.kind === "unavailable")
      return steps.fail(
        "access",
        "github-unavailable",
        "GitHub did not answer for the root repository",
      );
    if (access.kind === "missing" || !access.repository.readable)
      return steps.fail(
        "access",
        "root-denied",
        `${rootRepository} does not exist or ${viewer.login} cannot read it`,
      );
    if (access.repository.owner.login.toLowerCase() !== login.toLowerCase())
      return steps.fail(
        "access",
        "root-owner-mismatch",
        `${access.repository.fullName} does not belong to ${login}`,
      );
    rootRepository = access.repository.fullName;
    rootPermission = access.repository.permission;
  }
  // The person's live role decides the scope; nothing starts without one.
  const requested = context.roles[login.toLowerCase()] ?? null;
  const membership =
    requested === "steward" || requested === "builder"
      ? ({ kind: "none" } as const)
      : await host.github.membership(login);
  const role = verifyOrganizationRole({
    requested,
    membership,
    rootPermission,
  });
  if (role.kind === "unverified")
    return steps.fail(
      "access",
      "role-unverified",
      `${requested === null ? "no Organization role" : `the role ${requested}`} of ${viewer.login} in ${login} could not be verified: ${role.detail}`,
    );
  const found =
    resolution.kind === "resolved"
      ? ` (${resolution.source === "explicit" ? "named" : resolution.source === "name-candidate" ? "by name" : resolution.source === "scan" ? "by scan" : "from the Dashboard"})`
      : "";
  steps.done(
    "access",
    `as ${viewer.login} (${role.role}${role.restricted === "exclude" ? ", restricted slots excluded" : ""}); root ${rootRepository ?? "present in this Folder"}${found}`,
  );
  // root
  steps.running("root");
  let directory: string;
  if (resolution.kind === "present") {
    directory = resolution.directory;
    steps.done("root", `present at ${relative(folder, directory)}`);
  } else {
    const repository = rootRepository as string;
    const name = repository.split("/")[1] as string;
    if (!isDestinationName(name))
      return steps.fail(
        "root",
        "destination-invalid",
        failureDetails["destination-invalid"] as string,
      );
    let parent: string;
    try {
      parent = await ensureCheckoutDirectories(folder, ["organizations"]);
    } catch {
      return steps.fail(
        "root",
        "destination-invalid",
        "organizations/ is not a directory of this Folder",
      );
    }
    const remote = await host.github.remote(repository);
    const result = await materializeRepository({
      parent,
      name,
      repository,
      url: remote.url,
      credentialHelper: remote.credentialHelper,
      git: host.git,
      verify: rootDeclaration(login, repository),
    });
    if (result.kind === "occupied")
      return steps.fail(
        "root",
        "destination-occupied",
        `organizations/${name} exists and was left untouched`,
      );
    if (result.kind === "failed")
      return steps.fail(
        "root",
        result.code,
        failureDetails[result.code] ?? "materialization failed",
      );
    directory = result.directory;
    steps.done(
      "root",
      `materialized organizations/${name} at ${result.commit.slice(0, 12)}`,
    );
  }
  const base = {
    item,
    ...(rootRepository === null ? {} : { repository: rootRepository }),
    directory: relative(folder, directory),
    role: role.role,
  };
  // modules: children from the declaration of the root as it is now
  steps.running("modules");
  let inventory: ReturnType<typeof inspectCanonicalInventory>;
  try {
    const documents = await readOrganizationDocuments(directory);
    if (
      documents.kind !== "documents-observed" ||
      documents.canonical.kind !== "present" ||
      documents.modules.kind !== "present"
    )
      throw new Error("Organization documents unavailable");
    inventory = inspectCanonicalInventory(
      documents.canonical.value,
      documents.modules.value,
    );
  } catch {
    return {
      ...steps.fail(
        "modules",
        "organization-unreadable",
        "the root's declaration could not be read",
      ),
      ...base,
    };
  }
  const repositories: RepositoryOutcome[] = [];
  for (const child of declaredChildren(inventory, role.restricted))
    repositories.push(await materializeChild(directory, child, context));
  steps.done("modules", childrenSummary(repositories));
  // preparation: the modules this run materialized, by the module core
  steps.running("preparation");
  const materialized = new Set(
    repositories
      .filter((entry) => entry.result === "materialized")
      .map((entry) => entry.path),
  );
  const catalog = await catalogOf(host, folder);
  const held = organizationsOf(catalog.organizations, login);
  const entry = held.length === 1 ? held[0] : undefined;
  const preparations: PreparationOutcome[] = [];
  if (entry !== undefined && entry.organization !== null)
    for (const module of entry.modules) {
      if (!materialized.has(module.path)) continue;
      // A module whose own declaration cannot be read has nothing to
      // prepare; its catalog reason says why (a refused preparation is still
      // asked, the module core answers it).
      if (!module.executable && module.preparationRefused !== true) {
        preparations.push({
          module: module.module,
          result: "not-prepared",
          reason: module.reason ?? "module-unavailable",
        });
        continue;
      }
      const answer = await host.prepare(
        `${entry.organization}/${module.module}`,
      );
      preparations.push(
        answer.ok
          ? { module: module.module, result: "prepared" }
          : {
              module: module.module,
              result: "not-prepared",
              reason: answer.reason,
            },
      );
    }
  if (preparations.length === 0)
    steps.skipped("preparation", "no module was materialized by this run");
  else {
    const prepared = preparations.filter((p) => p.result === "prepared");
    const refused = preparations.filter((p) => p.result !== "prepared");
    steps.done(
      "preparation",
      [
        `${prepared.length} prepared`,
        ...(refused.length === 0
          ? []
          : [
              `${refused.length} not prepared (${refused
                .map((p) => `${p.module}: ${p.reason}`)
                .join(", ")}); a start prepares again`,
            ]),
      ].join("; "),
    );
  }
  const outcome = {
    ...base,
    repositories: Object.freeze(repositories),
    preparations: Object.freeze(preparations),
  };
  // check: the doctor's checks of this Organization in the catalog
  steps.running("check");
  if (entry === undefined)
    return {
      ...steps.fail(
        "check",
        held.length > 1 ? "organization-ambiguous" : "organization-missing",
        `the catalog does not list exactly one Organization bound to ${login}`,
      ),
      ...outcome,
    };
  const checks = catalogChecks({ kind: "catalog", organizations: [entry] });
  const organizationCheck = checks.find((check) => check.id === "organization");
  const warnings = checks.filter(
    (check) => check.id === "module" && check.outcome !== "ok",
  ).length;
  const modules = checks.filter((check) => check.id === "module").length;
  if (organizationCheck?.outcome !== "ok")
    return {
      ...steps.fail(
        "check",
        organizationCheck?.reason ?? "organization-not-executable",
        `the Organization cannot run its modules (${organizationCheck?.reason ?? "organization-not-executable"})`,
      ),
      ...outcome,
    };
  steps.done(
    "check",
    `executable; ${modules} modules${warnings === 0 ? "" : `, ${warnings} with a reason (see lazurio doctor)`}`,
  );
  return { ...outcome, state: "succeeded" };
}

// ---- Personalspace ---------------------------------------------------------

const personalspaceDescription = "Privátní Personalspace GEN3.";

async function findOnGitHub(
  github: ContentGitHub,
  viewer: GitHubViewer,
  steps: Stepper,
): Promise<{ repository: string; create: boolean } | ItemOutcome> {
  const name = personalspaceRepositoryName(viewer.login);
  const answer = await github.repository(viewer.login, name);
  if (answer.kind === "unavailable")
    return steps.fail(
      "find",
      "github-unavailable",
      "GitHub did not answer for the Personalspace repository",
    );
  if (answer.kind === "observed") {
    const repository = answer.repository;
    if (repository.owner.databaseId !== viewer.databaseId)
      return steps.fail(
        "find",
        "personalspace-not-owned",
        `${repository.fullName} is not owned by ${viewer.login}`,
      );
    if (!repository.private)
      return steps.fail(
        "find",
        "personalspace-public",
        `${repository.fullName} is public; a Personalspace must be private`,
      );
    steps.done("find", `found ${repository.fullName}`);
    return { repository: repository.fullName, create: false };
  }
  // Absent under its name: before creating one, make sure no repository of
  // the person was created from the template under another name (a renamed
  // repository, or a login renamed after it was created).
  const derived = await github.templateDerived(personalspaceTemplate);
  if (derived === "unavailable")
    return steps.fail(
      "find",
      "github-unavailable",
      "GitHub did not list the account's repositories",
    );
  if (derived.length > 0)
    return steps.fail(
      "find",
      "personalspace-elsewhere",
      `no ${viewer.login}/${name}, but created from the template: ${derived.join(", ")}; nothing was created`,
    );
  steps.done("find", `${viewer.login}/${name} does not exist yet`);
  return { repository: `${viewer.login}/${name}`, create: true };
}

async function installPersonalspace(
  item: Extract<ContentItemRef, { kind: "personalspace" }>,
  context: RunContext,
  steps: Stepper,
): Promise<ItemOutcome> {
  const { folder, host } = context;
  steps.running("find");
  const located = await locatePersonalspace(folder);
  if (located.kind === "blocked")
    return steps.fail(
      "find",
      located.reason,
      located.reason === "personalspace-ambiguous"
        ? "personalspace/ holds more than one directory; none is read"
        : "personalspace/ is not a directory of this Folder",
    );
  const viewer = await signedIn(context, steps, "find");
  if (isOutcome(viewer)) return viewer;
  if (!viewerMayHold(context.scope, viewer))
    return steps.fail(
      "find",
      "github-identity-mismatch",
      `gh works as ${viewer.login}, not as the owner of this Environment`,
    );
  let repository: string | null = null;
  if (located.kind === "owner") {
    steps.done("find", "present in personalspace/");
    steps.skipped("clone", "already present");
  } else {
    const found = await findOnGitHub(host.github, viewer, steps);
    if (isOutcome(found)) return found;
    repository = found.repository;
    const [owner, name] = repository.split("/") as [string, string];
    if (found.create) {
      steps.running("create");
      const created = await host.github.generate(
        personalspaceTemplate,
        owner,
        name,
        personalspaceDescription,
      );
      if (created.kind === "failed")
        return steps.fail(
          "create",
          "create-failed",
          `GitHub did not create ${repository} from ${personalspaceTemplate}`,
        );
      if (!created.private)
        return steps.fail(
          "create",
          "personalspace-not-private",
          `${repository} was created but is not private; make it private before cloning`,
        );
      if (!(await host.github.branchReady(owner, name)))
        return steps.fail(
          "create",
          "create-not-ready",
          `${repository} was created but its main branch is not ready yet; run the install again`,
        );
      steps.done("create", `created ${repository} (private)`);
    }
    steps.running("clone");
    let parent: string;
    try {
      parent = await ensureCheckoutDirectories(
        folder,
        ["personalspace"],
        0o700,
      );
    } catch {
      return steps.fail(
        "clone",
        "destination-invalid",
        "personalspace/ is not a directory of this Folder",
      );
    }
    const remote = await host.github.remote(repository);
    const result = await materializeRepository({
      parent,
      name,
      repository,
      url: remote.url,
      credentialHelper: remote.credentialHelper,
      git: host.git,
    });
    if (result.kind === "occupied")
      return steps.fail(
        "clone",
        "destination-occupied",
        `personalspace/${name} exists and was left untouched`,
      );
    if (result.kind === "failed")
      return steps.fail(
        "clone",
        result.code,
        failureDetails[result.code] ?? "materialization failed",
      );
    steps.done("clone", `cloned into personalspace/${name}`);
  }
  steps.running("check");
  const now = await locatePersonalspace(folder);
  const observed =
    now.kind === "owner" ? await host.git.inspect(now.directory) : null;
  if (
    now.kind !== "owner" ||
    observed?.kind !== "checkout" ||
    (repository !== null && !sameRepository(observed.repository, repository))
  )
    return steps.fail(
      "check",
      "check-failed",
      "personalspace/ does not hold exactly one checkout of the Personalspace",
    );
  steps.done("check", `checkout of ${observed.repository}`);
  return {
    item,
    state: "succeeded",
    repository: observed.repository,
    directory: relative(folder, now.directory),
  };
}
