import { basename, join } from "node:path";
import { catalogChecks } from "../doctor/doctor";
import { inspectCanonicalInventory } from "../organizations/canonical-inventory";
import { locatePersonalspace } from "../organizations/personalspace";
import { readOrganizationDocuments } from "../organizations/read-documents";
import { rootApplicationPaths } from "../organizations/repository-slots";
import { resolveOrganizationRootDocuments } from "../organizations/root-resolution";
import { githubRemoteCoordinate } from "../providers/git-checkout";
import { githubCommitIdentity } from "./commit-identity";
import {
  anonymousGitHub,
  type ContentGitHub,
  type GitHubViewer,
  type ViewerAnswer,
} from "./github";
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
  type ContentWarningCode,
  contentScope,
  repositoryPattern,
  type StepKey,
  sameRepository,
  scopeAdmits,
} from "./model";
import {
  type RootResolution,
  resolveAnonymousRoot,
  resolveOrganizationRootRepository,
} from "./organization-root";
import {
  gbrainCommitMessage,
  isTemplateCheckout,
  personalspaceCommitMessage,
  personalspaceIdentityFiles,
  personalspaceOwnerOf,
  templateOwnerPlaceholder,
} from "./personalspace-bootstrap";
import {
  classifySlotAccess,
  type OrganizationRole,
  type RepositoryPermission,
  type RoleVerification,
  verifyOrganizationRole,
} from "./role";
import {
  organizationsOf,
  personalspaceRepositoryName,
  personalspaceTemplate,
  verifyPersonalspaceCheckout,
  viewerMayHold,
} from "./status";

// The install use case of content (decision F9, addendum of 2026-10-04), one
// core for `lazurio organization install`, `lazurio personalspace install`
// and the Launchpad's `POST /api/content/install`. It runs only when called:
// no start, health check, status read or product update triggers it, and it
// never changes the installed product. Existing repositories are never
// fetched, switched or reset here; that is synchronization, a separate
// operation (docs/content-sync.md). On a public Environment (the scope's
// `github` anonymous, decision F55's addendum of 2026-10-17) the same steps
// run without any GitHub identity: no gh account, no read of GitHub's API,
// the reader's scope, and every clone over anonymous HTTPS with no
// credential helper, in an isolated git (`anonymousGitEnvironment`); nothing
// is created, granted or pushed there.

export type InstallRequest = Readonly<{
  /** Absent: everything this Environment holds. */
  items?: readonly ContentItemRef[] | undefined;
  /** The operator's explicit `<owner>/<repository>` root of an Organization
   * the Folder does not hold yet, by lowercase GitHub login (the CLI's
   * `--root`). */
  roots?: Readonly<Record<string, string>> | undefined;
  /** The role the caller asks for in an Organization, by lowercase GitHub
   * login: `admin` for the CLI's bare form, `builder`, `steward` or
   * `reader` for its `--role`; absent (the Launchpad), the role is resolved
   * live. Either way GitHub must confirm it. */
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
  /** A succeeded item's warnings; the steps' details name the next step. */
  warnings?: readonly ContentWarningCode[];
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
    anonymous: plan.scope.github === "anonymous",
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
  /** A public Environment's run (`scope.github` anonymous): `host.github` is
   * never asked; every clone goes through `anonymousGitHub`. */
  anonymous: boolean;
}>;

/** The Git remote of a repository for this run: this Environment's sign-in,
 * or on a public Environment anonymous HTTPS without any credential helper. */
const remoteOf = async (context: RunContext, fullName: string) =>
  context.anonymous
    ? anonymousGitHub.remote(fullName)
    : await context.host.github.remote(fullName);

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

/** An Organization root's own declaration in the clone: canonical documents
 * that resolve, an Organization (not a template) bound to `login`, and a
 * declared `root_repository` naming exactly the cloned repository; the
 * `root` it declares, as it spells it, or why not. */
async function readRootDeclaration(
  login: string,
  repository: string,
  checkout: string,
): Promise<Readonly<{ refused: string }> | Readonly<{ root: string }>> {
  const refused = (code: string) => ({ refused: code });
  const documents = await readOrganizationDocuments(checkout);
  if (documents.kind !== "documents-observed")
    return refused("root-declaration-invalid");
  const resolution = resolveOrganizationRootDocuments(documents);
  if (
    ["missing", "legacy", "conflict"].includes(resolution.state) ||
    documents.canonical.kind !== "present" ||
    documents.modules.kind !== "present"
  )
    return refused("root-declaration-invalid");
  let inventory: ReturnType<typeof inspectCanonicalInventory>;
  try {
    inventory = inspectCanonicalInventory(
      documents.canonical.value,
      documents.modules.value,
    );
  } catch {
    return refused("root-declaration-invalid");
  }
  const canonical = inventory.canonical as Readonly<Record<string, unknown>>;
  if (canonical.kind !== "organization")
    return refused("organization-template");
  const organization = canonical.organization as Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  const owner = organization.forge_binding?.locator;
  const root = (
    canonical.root_repository as Readonly<Record<string, unknown>> | null
  )?.locator;
  // The same criterion as discovery (`declaresRoot`): a commit that does
  // not name this repository its root is never published (review of #183).
  if (
    typeof owner !== "string" ||
    owner.toLowerCase() !== login.toLowerCase() ||
    typeof root !== "string" ||
    !sameRepository(root, repository)
  )
    return refused("root-declaration-mismatch");
  return { root };
}

/** Verifies an Organization root's own declaration in the clone before it
 * is published (`readRootDeclaration`): a failure code, or null. */
function rootDeclaration(login: string, repository: string) {
  return async (checkout: string): Promise<string | null> => {
    const declared = await readRootDeclaration(login, repository, checkout);
    return "refused" in declared ? declared.refused : null;
  };
}

/** The name a public Environment publishes its root under: the repository
 * name its verified declaration spells (decision F55's addendum of
 * 2026-10-17), as GitHub spells it for every member's install, not the
 * handover's lowercase slug the request was named by. Asked only after
 * `rootDeclaration` verified the same clone; it differs from the requested
 * name by letter case only (`sameRepository`). */
function declaredRootName(login: string, repository: string) {
  return async (checkout: string): Promise<string> => {
    const declared = await readRootDeclaration(login, repository, checkout);
    if ("refused" in declared)
      throw new Error("The root's declaration changed after its verification");
    return declared.root.split("/")[1] as string;
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
  // GitHub's spelling of it, as this identity reads it. A public Environment
  // asks GitHub nothing first: anonymous Git reads a public repository, and
  // the clone of one it cannot read fails and is reported (`clone-failed`).
  let fullName = child.repository;
  if (!context.anonymous) {
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
    fullName = access.repository.fullName;
  }
  let parent: string;
  try {
    parent = await ensureCheckoutDirectories(root, parentSegments);
  } catch {
    return { ...where, result: "blocked", reason: "destination-invalid" };
  }
  const remote = await remoteOf(context, fullName);
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

/** What the access step established: where the root is, and the role that
 * scopes the install. */
type Access = Readonly<{
  resolution: Extract<RootResolution, { kind: "present" | "resolved" }>;
  /** The root repository, or null for a root present without an origin. */
  rootRepository: string | null;
  role: Extract<RoleVerification, { kind: "verified" }>;
}>;

/** The failure of a root resolution that names no root to install. */
function unusableRoot(
  login: string,
  resolution: Extract<
    RootResolution,
    { kind: "ambiguous-in-folder" | "failed" }
  >,
  steps: Stepper,
): ItemOutcome {
  return resolution.kind === "ambiguous-in-folder"
    ? steps.fail(
        "access",
        "organization-ambiguous",
        `more than one directory in organizations/ binds ${login}: ${resolution.directories.join(", ")}`,
      )
    : steps.fail("access", resolution.code, resolution.detail);
}

/** How the root was found, for the access step's line. */
const foundBy = (resolution: Access["resolution"]) =>
  resolution.kind === "resolved"
    ? ` (${resolution.source === "explicit" ? "named" : resolution.source === "name-candidate" ? "by name" : resolution.source === "scan" ? "by scan" : "from the Dashboard"})`
    : "";

/** The access of a public Environment (root decision 0204 point 5, decision
 * F55's addendum of 2026-10-17): no GitHub identity, so no account, no read
 * of GitHub's API and no role GitHub confirms. The Organization is read
 * anonymously as a reader: restricted slots are excluded as for every
 * Reader. Only the reader's role is asked for; any other one cannot be
 * confirmed here and fails closed. */
async function anonymousAccess(
  login: string,
  context: RunContext,
  steps: Stepper,
): Promise<Access | ItemOutcome> {
  const { folder, host } = context;
  const requested = context.roles[login.toLowerCase()] ?? null;
  if (requested !== null && requested !== "reader")
    return steps.fail(
      "access",
      "role-unverified",
      `the role ${requested} in ${login} could not be verified: this public Environment has no GitHub identity and installs only as a reader${requested === "admin" ? "; name it with --role reader" : ""}`,
    );
  const resolution = await resolveAnonymousRoot({
    folder,
    login,
    catalog: await catalogOf(host, folder),
    git: host.git,
    root: context.roots[login.toLowerCase()],
  });
  if (resolution.kind === "ambiguous-in-folder" || resolution.kind === "failed")
    return unusableRoot(login, resolution, steps);
  const rootRepository = resolution.repository;
  steps.done(
    "access",
    `anonymously (reader, restricted slots excluded); root ${rootRepository ?? "present in this Folder"}${foundBy(resolution)}`,
  );
  return {
    resolution,
    rootRepository,
    role: { kind: "verified", role: "reader", restricted: "exclude" },
  };
}

/** The access through this Environment's gh account: the account, the root
 * GitHub answers for, and the person's live role GitHub confirms. */
async function accountAccess(
  login: string,
  context: RunContext,
  steps: Stepper,
): Promise<Access | ItemOutcome> {
  const { folder, host } = context;
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
  if (resolution.kind === "ambiguous-in-folder" || resolution.kind === "failed")
    return unusableRoot(login, resolution, steps);
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
  // A Steward or Builder is confirmed by the root's permission alone; an
  // Admin, a Reader and a live resolution also need the membership.
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
  // Only the CLI's bare form asks for `admin`; its agent learns there that
  // the narrower roles are named with --role (the Launchpad's prompt for
  // Chat names the bare command).
  if (role.kind === "unverified")
    return steps.fail(
      "access",
      "role-unverified",
      `${requested === null ? "no Organization role" : `the role ${requested}`} of ${viewer.login} in ${login} could not be verified: ${role.detail}${requested === "admin" ? "; without --role this is the Admin installation: name the role GitHub confirms with --role steward, --role builder or --role reader" : ""}`,
    );
  steps.done(
    "access",
    `as ${viewer.login} (${role.role}${role.restricted === "exclude" ? ", restricted slots excluded" : ""}); root ${rootRepository ?? "present in this Folder"}${foundBy(resolution)}`,
  );
  return { resolution, rootRepository, role };
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
  const access = context.anonymous
    ? await anonymousAccess(login, context, steps)
    : await accountAccess(login, context, steps);
  if (isOutcome(access)) return access;
  const { resolution, rootRepository, role } = access;
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
    const remote = await remoteOf(context, repository);
    const result = await materializeRepository({
      parent,
      name,
      repository,
      url: remote.url,
      credentialHelper: remote.credentialHelper,
      git: host.git,
      verify: rootDeclaration(login, repository),
      ...(context.anonymous
        ? { finalName: declaredRootName(login, repository) }
        : {}),
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
      `materialized organizations/${basename(directory)} at ${result.commit.slice(0, 12)}`,
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
  // The checkout this run created, or null for an existing Personalspace.
  let createdCheckout: string | null = null;
  if (located.kind === "owner") {
    // Only the account's own, private Personalspace counts (review of
    // #183); anything else fails closed and is left untouched.
    const present = await verifyPersonalspaceCheckout(
      located.directory,
      viewer,
      host,
    );
    if (!present.ok) return steps.fail("find", present.code, present.detail);
    repository = present.repository;
    steps.done("find", `${repository} present in personalspace/`);
    steps.skipped("clone", "already present");
  } else {
    const found = await findOnGitHub(host.github, viewer, steps);
    if (isOutcome(found)) return found;
    repository = found.repository;
    const [owner, name] = repository.split("/") as [string, string];
    if (found.create) {
      steps.running("create");
      // What the template's bootstrap needs after the creation is asked
      // first: a creation that could not be set up is not started.
      const ready = await host.personalspace.ready(
        folder,
        githubCommitIdentity(viewer),
      );
      if (!ready.ok) return steps.fail("create", ready.code, ready.detail);
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
    if (found.create) {
      createdCheckout = result.directory;
      const failed = await setUpCreated(
        result.directory,
        repository,
        viewer,
        context,
        steps,
      );
      if (failed !== null) return failed;
    }
  }
  const warnings =
    createdCheckout === null
      ? await reportExisting(folder, repository, viewer, steps)
      : [];
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
    ...(warnings.length === 0 ? {} : { warnings: Object.freeze(warnings) }),
  };
}

/** The template's bootstrap in the Personalspace this run has just created
 * and cloned, then the commit and push of what it wrote (decision F9,
 * addendum of 2026-10-14). The failed outcome, or null when it is set up. */
async function setUpCreated(
  checkout: string,
  repository: string,
  viewer: GitHubViewer,
  context: RunContext,
  steps: Stepper,
): Promise<ItemOutcome | null> {
  const { folder, host } = context;
  const where = relative(folder, checkout);
  steps.running("bootstrap");
  if (
    !(await isTemplateCheckout(checkout, personalspaceTemplate)) ||
    !(await host.personalspace.clean(checkout))
  )
    return steps.fail(
      "bootstrap",
      "personalspace-template-unexpected",
      `${where} is not a clean checkout of ${personalspaceTemplate}, so its bootstrap was not run; ${repository} is created and cloned but does not name its owner`,
    );
  const displayName = viewer.name ?? viewer.login;
  const again = `bun run bootstrap -- --login ${viewer.login} --display-name ${JSON.stringify(displayName)} --apply`;
  const ran = await host.personalspace.run(checkout, {
    login: viewer.login,
    displayName,
  });
  if (!ran.ok)
    return steps.fail(
      "bootstrap",
      "personalspace-bootstrap-failed",
      `the template's bootstrap failed (${ran.detail}). ${repository} is created and cloned into ${where} but does not name its owner on GitHub; nothing was committed or pushed and nothing was removed. Fix the cause, run \`${again}\` in ${where} (it reuses a gbrain repository and clone it already made), then commit and push what it changed as its manual/bootstrap-personalspace.md, step 7, says`,
    );
  const owner = await personalspaceOwnerOf(checkout);
  if (
    owner.kind !== "named" ||
    owner.login.toLowerCase() !== viewer.login.toLowerCase() ||
    owner.gbrain === null ||
    !repositoryPattern.test(owner.gbrain)
  )
    return steps.fail(
      "bootstrap",
      "personalspace-bootstrap-failed",
      `the template's bootstrap finished, but ${where} does not name ${viewer.login} its owner with a gbrain repository; nothing was committed or pushed`,
    );
  steps.done(
    "bootstrap",
    `named ${viewer.login} (${displayName}) its owner; ${owner.gbrain} is private and cloned into ${where}/gbrain`,
  );
  steps.running("push");
  const own = await host.personalspace.publish(
    checkout,
    personalspaceIdentityFiles,
    personalspaceCommitMessage,
    (await host.github.remote(repository)).credentialHelper,
    githubCommitIdentity(viewer),
  );
  if (!own.ok)
    return steps.fail(
      "push",
      `personalspace-${own.stage}-failed`,
      `${own.detail}. ${where} names its owner but ${repository} does not yet: commit and push ${personalspaceIdentityFiles.join(" and ")} there`,
    );
  const gbrain = await host.personalspace.publish(
    join(checkout, "gbrain"),
    [".gitignore"],
    gbrainCommitMessage,
    (await host.github.remote(owner.gbrain)).credentialHelper,
    githubCommitIdentity(viewer),
  );
  if (!gbrain.ok)
    return steps.fail(
      "push",
      `gbrain-${gbrain.stage}-failed`,
      `${gbrain.detail}. ${repository} names its owner; ${where}/gbrain/.gitignore is not in ${owner.gbrain} yet: commit and push it there`,
    );
  steps.done(
    "push",
    `pushed the owner to ${repository} and gbrain/.gitignore to ${owner.gbrain}`,
  );
  return null;
}

/** An existing Personalspace is never set up here: its `main` is the
 * person's Publication and the bootstrap would run code of a repository this
 * run did not create. `bootstrap` is skipped with what was found, and one
 * that still holds the template's placeholders gets the next step. */
async function reportExisting(
  folder: string,
  repository: string | null,
  viewer: GitHubViewer,
  steps: Stepper,
): Promise<ContentWarningCode[]> {
  const located = await locatePersonalspace(folder);
  if (located.kind !== "owner") return [];
  const where = relative(folder, located.directory);
  const owner = await personalspaceOwnerOf(located.directory);
  if (owner.kind === "named") {
    steps.skipped("bootstrap", `${where} names its owner ${owner.login}`);
    return [];
  }
  if (owner.kind === "unreadable") {
    steps.skipped(
      "bootstrap",
      `${where} has no readable personal.gen3.json and modules.manifest.json of the template; nothing was changed`,
    );
    return [];
  }
  const displayName = viewer.name ?? viewer.login;
  steps.skipped(
    "bootstrap",
    `${where} still holds the template's placeholders (${templateOwnerPlaceholder}): it was created without the template's bootstrap. Its main is the person's, so nothing was changed. Next step: in a task worktree of it (personalspace/.worktrees/<task>) run \`bun run bootstrap -- --login ${viewer.login} --display-name ${JSON.stringify(displayName)} --apply\`, commit ${personalspaceIdentityFiles.join(" and ")} and open a pull request into ${repository ?? `${viewer.login}/${personalspaceRepositoryName(viewer.login)}`}; it creates the private gbrain repository when it is missing (the template's manual/bootstrap-personalspace.md)`,
  );
  return ["personalspace-placeholders"];
}
