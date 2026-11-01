import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import { inspectCanonicalInventory } from "../organizations/canonical-inventory";
import { readFolderCatalog } from "../organizations/catalog";
import { readOrganizationDocuments } from "../organizations/read-documents";
import type { ContentGit, RemoteAnswer, SyncRemote } from "./git";
import { type ContentHost, readFolderKind } from "./host";
import { declaredChildren } from "./install";
import { tryContentLock } from "./lock";
import { contentScope, sameRepository } from "./model";
import { type ProvideOutcome, provideRepository } from "./provide";
import {
  recordSync,
  type SyncBlockedReason,
  type SyncEntry,
  type SyncResult,
} from "./sync-record";

export {
  contentSyncEveryMs,
  readSyncRecord,
  type SyncBlockedReason,
  type SyncEntry,
  type SyncResult,
  syncBlockedReasons,
  syncFindings,
  syncRecordFile,
} from "./sync-record";

// Synchronization of existing repositories (docs/content-sync.md, "Existing
// repositories"; decision F9's amendment of 2026-10-24, root decision 0212
// points 2 and 4): the primary checkouts of an
// Organization's root, its modules (workspace modules and the root-level
// applications) and their declared data mounts are kept on their published
// branch. Per repository: one `ls-remote` of its branch, and only when that
// differs from the checkout, a fetch, then a strict fast-forward to exactly
// the commit the fetch brought. A checkout changes only when its tracked and
// untracked files are clean, it is on the expected branch and no operation
// is under way; anything else is reported and left as it is. Never a stash,
// a switch, a reset, a merge, a hook or a preparation. The one clone is of a
// declared module or data mount that is not here yet and that this identity
// can now read, by installation's own `provideRepository` (`cloneAbsent`,
// decision F9's addendum of 2026-11-01). Worktrees,
// Production Space repositories, `infra` and the Personalspace are never
// touched. The Launchpad runs it at its start and then every hour
// (`contentSyncEveryMs`) within its build sweep
// (`keepBuilt`), the CLI as `lazurio organization sync`, and since decision
// F9's second amendment of 2026-10-24 (root decision 0212 points 3, 4 and 7)
// `lazurio update` and Nová karta's Aktualizovat (`updateEverything`, with
// progress per repository, `onProgress`) and the Open of one module
// (`createOpenSync`, one repository, `SyncRequest.repository`): one core, one
// content lock, one record.

export type SyncRun =
  | Readonly<{
      kind: "content-sync";
      at: string;
      /** The Organizations this run looked at, by GitHub login. */
      organizations: readonly string[];
      entries: readonly SyncEntry[];
    }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{
      kind: "not-allowed";
      reason: "not-for-this-environment" | "folder-unreadable";
    }>;

export type SyncHost = Pick<
  ContentHost,
  "github" | "git" | "lockDirectory" | "readCatalog"
>;

/** One repository's progress, as it happens: `checking` (its local state
 * and its remote's branch), `fetching` (the remote has a commit this
 * checkout does not), `fast-forwarding`, then `done` with its answer. For a
 * surface that shows progress per repository; the run answers the same
 * entries. */
export type SyncProgress = Readonly<{
  organization: string;
  root: string;
  path: string;
  kind: SyncEntry["kind"];
  branch: string;
  step: "checking" | "fetching" | "fast-forwarding" | "cloning" | "done";
  /** `fetching` and `fast-forwarding`: the commit the remote's branch
   * names, the one the checkout is to move to. */
  to?: string;
  /** `done`: the answer. */
  entry?: SyncEntry;
}>;

export type SyncRequest = Readonly<{
  /** Only this Organization, by GitHub login; absent: every one this
   * Environment holds. */
  organization?: string | undefined;
  /** With `organization`, only this declared repository, by its path
   * relative to the Organization root (`workspace/<module>`,
   * `mission-control`; `.` the root alone): the root is still synchronized
   * first, then the module and its data mounts. */
  repository?: string | undefined;
  /** Each repository's progress; a listener that throws is ignored. */
  onProgress?: ((progress: SyncProgress) => void) | undefined;
  /** Test seams: the clock, the bound of one repository and how many
   * repositories run at once. */
  now?: () => Date;
  timeoutMs?: number;
  concurrency?: number;
}>;

/** About a minute per repository, four at a time: a slow network never
 * holds the sweep's other work for long. */
export const syncTimeoutMs = 60_000;
export const syncConcurrency = 4;

type Scope = Readonly<{
  organizations: "folder" | "none" | Readonly<{ only: string }>;
  /** How a remote is read: the Environment's own sign-in, git's configured
   * helper (a Team Environment's broker) or anonymously (public). */
  remote: "account" | "configured" | "anonymous";
}>;

/** Which Organizations an Environment keeps on their published branch, and
 * through which identity: those its content holds (`contentScope`), and on
 * a Team Environment, whose content the hosting prepared, its handover's
 * Organization through git's configured credential helper. */
export function syncScope(
  preset: PresetName,
  machine: MachineBinding | null,
): Scope {
  const scope = contentScope(preset, machine);
  if (!scope.allowed)
    return machine?.owner.kind === "organization"
      ? {
          organizations: { only: machine.owner.organization },
          remote: "configured",
        }
      : { organizations: "none", remote: "configured" };
  return {
    organizations: scope.organizations,
    remote: scope.github === "anonymous" ? "anonymous" : "account",
  };
}

const admits = (scope: Scope, login: string) =>
  scope.organizations === "folder" ||
  (scope.organizations !== "none" &&
    scope.organizations.only.toLowerCase() === login.toLowerCase());

/** The whole operation: the Folder's kind, its content lock, the
 * Organizations it holds, then the record. */
export async function syncContent(
  folder: string,
  host: SyncHost,
  request: SyncRequest = {},
): Promise<SyncRun> {
  let scope: Scope;
  try {
    const kind = await readFolderKind(folder);
    scope = syncScope(kind.preset, kind.machine);
  } catch {
    return { kind: "not-allowed", reason: "folder-unreadable" };
  }
  if (request.repository !== undefined && request.organization === undefined)
    throw new Error("A repository is named within its Organization");
  if (
    scope.organizations === "none" ||
    (request.organization !== undefined && !admits(scope, request.organization))
  )
    return { kind: "not-allowed", reason: "not-for-this-environment" };
  const lock = await tryContentLock(host.lockDirectory, folder);
  if (lock === null) return { kind: "busy" };
  try {
    const now = request.now ?? (() => new Date());
    const at = now().toISOString();
    const catalog = await (host.readCatalog ?? readFolderCatalog)(folder);
    const held = catalog.organizations.filter(
      (entry) =>
        entry.forgeLogin !== undefined &&
        entry.reason !== "template-not-runtime" &&
        admits(scope, entry.forgeLogin) &&
        (request.organization === undefined ||
          entry.forgeLogin.toLowerCase() ===
            request.organization.toLowerCase()),
    );
    let helper: Promise<string | undefined> | undefined;
    const context: RunContext = {
      git: host.git,
      // Who clones a declared module that is not here yet (decision F9's
      // addendum of 2026-11-01): this Environment's own GitHub, or anonymous
      // Git on a public Environment; a Team Environment, whose content the
      // hosting prepares, clones nothing here.
      clone: cloneIdentity(scope.remote, host.github),
      timeoutMs: request.timeoutMs ?? syncTimeoutMs,
      remote: (repository) => {
        if (scope.remote === "anonymous")
          return Promise.resolve({ kind: "anonymous", repository });
        if (scope.remote === "configured")
          return Promise.resolve({ kind: "configured" });
        // gh as github.com's HTTPS helper, as a clone has it: asked once.
        helper ??= host.github
          .remote(repository)
          .then((remote) => remote.credentialHelper)
          .catch(() => undefined);
        return helper.then((credentialHelper) => ({
          kind: "account",
          credentialHelper,
        }));
      },
    };
    const entries: SyncEntry[] = [];
    // A repository filter: that module and the data mounts below it.
    const wanted = (path: string) =>
      request.repository === undefined ||
      path === request.repository ||
      path.startsWith(`${request.repository}/`);
    for (const organization of held) {
      const login = organization.forgeLogin as string;
      const root = join("organizations", organization.directory);
      // One repository: its progress as it goes, then its answer.
      const one = async (
        path: string,
        kind: SyncEntry["kind"],
        branch: string,
        run: (
          progress: (step: CheckoutStep, to: string) => void,
        ) => Promise<Outcome>,
      ): Promise<SyncEntry> => {
        const where = { organization: login, root, path, kind, branch };
        const report = (
          step: SyncProgress["step"],
          extra: Readonly<{ to?: string; entry?: SyncEntry }> = {},
        ) => {
          try {
            request.onProgress?.(Object.freeze({ ...where, step, ...extra }));
          } catch {}
        };
        report("checking");
        const outcome = await run((step, to) => report(step, { to }));
        const entry: SyncEntry = Object.freeze({
          ...where,
          ...outcome,
          at: now().toISOString(),
        });
        report("done", { entry });
        return entry;
      };
      const directory = join(folder, root);
      const rootEntry = await one(".", "root", "main", (progress) =>
        syncCheckout(
          context,
          directory,
          (repository) =>
            repository.split("/")[0]?.toLowerCase() === login.toLowerCase(),
          "main",
          progress,
        ),
      );
      entries.push(rootEntry);
      // A root that did not end on its published commit stops this
      // Organization: its children are never taken from a stale
      // declaration.
      if (
        rootEntry.result !== "current" &&
        rootEntry.result !== "fast-forwarded"
      )
        continue;
      const children = (await childrenOf(directory)).filter((child) =>
        wanted(child.path),
      );
      // Modules first, then the data mounts: a data mount is cloned only
      // below a module that is a checkout by then.
      for (const pass of ["module", "data"] as const)
        entries.push(
          ...(await pool(
            children.filter((child) => child.kind === pass),
            request.concurrency ?? syncConcurrency,
            (child) =>
              one(child.path, child.kind, child.branch, async (progress) => {
                const outcome = await syncCheckout(
                  context,
                  join(directory, child.path),
                  (repository) => sameRepository(repository, child.repository),
                  child.branch,
                  progress,
                );
                return outcome.result === "absent"
                  ? cloneAbsent(context, directory, child, () =>
                      progress("cloning", ""),
                    )
                  : outcome;
              }),
          )),
        );
    }
    const organizations = held.map((entry) => entry.forgeLogin as string);
    const recorded = await recordSync(
      host.lockDirectory,
      folder,
      entries,
      request.organization === undefined
        ? { replace: "all" }
        : request.repository === undefined
          ? { replace: "organizations", organizations }
          : { replace: "answered" },
      at,
    ).catch(() => entries);
    return Object.freeze({
      kind: "content-sync",
      at,
      organizations: Object.freeze(organizations),
      entries: Object.freeze(recorded),
    });
  } finally {
    await lock.release();
  }
}

type RunContext = Readonly<{
  git: ContentGit;
  /** Who clones an absent declared module: null, nobody. */
  clone: Parameters<typeof provideRepository>[0]["github"] | null;
  timeoutMs: number;
  remote: (repository: string) => Promise<SyncRemote>;
}>;

type CheckoutStep = "fetching" | "fast-forwarding" | "cloning";

type Outcome = Readonly<{
  result: SyncResult;
  reason?: string;
  from?: string;
  to?: string;
}>;

type SyncChild = Readonly<{
  path: string;
  repository: string;
  kind: "module" | "data";
  branch: string;
  /** Restricted (Admin-only), itself or below such a slot: kept current
   * when present, never cloned by a synchronization. */
  restricted: boolean;
  /** A data mount's module. */
  parent?: string;
}>;

/** The modules and data mounts the root declares now: workspace modules
 * (guest Modules of another Organization among them, DEV-6694), the
 * root-level applications and the data mounts below them, each with a
 * GitHub remote. Production Space, `infra` and every other slot are left
 * out; restricted slots are in (a present checkout was readable once, and
 * GitHub decides now). An unreadable declaration gives none. */
async function childrenOf(root: string): Promise<SyncChild[]> {
  try {
    const documents = await readOrganizationDocuments(root);
    if (
      documents.kind !== "documents-observed" ||
      documents.canonical.kind !== "present" ||
      documents.modules.kind !== "present"
    )
      return [];
    const inventory = inspectCanonicalInventory(
      documents.canonical.value,
      documents.modules.value,
    );
    const restricted = new Set(
      declaredChildren(inventory, "exclude")
        .filter((child) => child.excluded === "excluded_by_role_scope")
        .map((child) => child.path),
    );
    return declaredChildren(inventory, "include").flatMap((child) =>
      child.kind === "module" &&
      child.excluded === undefined &&
      child.repository !== null
        ? [
            Object.freeze({
              path: child.path,
              repository: child.repository,
              kind: child.data === undefined ? "module" : "data",
              branch: child.data?.branch ?? "main",
              restricted: restricted.has(child.path),
              ...(child.data === undefined
                ? {}
                : { parent: child.data.parent }),
            } as const),
          ]
        : [],
    );
  } catch {
    return [];
  }
}

const blocked = (reason: SyncBlockedReason): Outcome => ({
  result: "blocked",
  reason,
});

/** Nothing at the place, or an empty directory (a data mount's left
 * empty), as installation counts one. */
async function absentAt(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    return stat.isDirectory() && (await readdir(directory)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

const remoteFailure = (
  answer: Exclude<RemoteAnswer, { kind: "commit" }>,
): Outcome =>
  answer.kind === "missing"
    ? { result: "failed", reason: "remote-branch-missing" }
    : answer.kind === "denied"
      ? { result: "denied", reason: "repository-denied" }
      : answer.kind === "unavailable"
        ? { result: "unavailable", reason: "remote-unavailable" }
        : { result: "failed", reason: "remote-failed" };

/** The checkout at `directory` as the rule allows it to change: blocked
 * before any network read when its local state forbids it. */
async function localBlock(
  git: ContentGit,
  directory: string,
  gitDir: string,
  branch: string | null,
  expected: string,
): Promise<Outcome | null> {
  // An operation under way first: a rebase also detaches HEAD.
  const changes = await git.changes(directory, gitDir);
  if (changes === null)
    return { result: "failed", reason: "status-unreadable" };
  if (changes.operation) return blocked("operation-in-progress");
  if (branch === null) return blocked("detached");
  if (branch !== expected) return blocked("wrong-branch");
  if (changes.dirty) return blocked("dirty");
  return null;
}

/** One present primary checkout kept on `branch`; see the module comment. */
async function syncCheckout(
  context: RunContext,
  directory: string,
  expected: (repository: string) => boolean,
  branch: string,
  progress: (step: CheckoutStep, to: string) => void = () => {},
): Promise<Outcome> {
  const { git } = context;
  const deadline = Date.now() + context.timeoutMs;
  const remaining = () => Math.max(1_000, deadline - Date.now());
  try {
    const observed = await git.inspect(directory);
    if (observed.kind !== "checkout")
      return (await absentAt(directory))
        ? { result: "absent" }
        : blocked("unexpected-checkout");
    if (!expected(observed.repository)) return blocked("unexpected-checkout");
    const tree = await git.worktree(directory);
    // A linked worktree is never a primary checkout.
    if (tree === null || tree.gitDir !== tree.commonDir)
      return blocked("unexpected-checkout");
    // Nor is a partial clone, whose reads would fetch missing objects
    // implicitly; decided from its configuration before any other read.
    const partial = await git.partial(directory);
    if (partial === null)
      return { result: "failed", reason: "status-unreadable" };
    if (partial) return blocked("unexpected-checkout");
    const local = await localBlock(
      git,
      directory,
      tree.gitDir,
      observed.branch,
      branch,
    );
    if (local !== null) return local;
    const remote = await context.remote(observed.repository);
    const head = await git.remoteHead(directory, remote, branch, remaining());
    if (head.kind !== "commit") return remoteFailure(head);
    if (head.commit === observed.commit) return { result: "current" };
    // Known here already: ahead or diverged is decided without a fetch.
    const known = await git.relation(directory, observed.commit, head.commit);
    if (known === "ahead" || known === "diverged") return blocked(known);
    progress("fetching", head.commit);
    const fetched = await git.fetchBranch(
      directory,
      remote,
      branch,
      remaining(),
    );
    if (fetched.kind !== "commit") return remoteFailure(fetched);
    // The checkout as it is after the fetch: someone may have worked in it
    // meanwhile.
    const now = await git.inspect(directory);
    if (now.kind !== "checkout") return blocked("unexpected-checkout");
    const again = await localBlock(
      git,
      directory,
      tree.gitDir,
      now.branch,
      branch,
    );
    if (again !== null) return again;
    const relation = await git.relation(directory, now.commit, fetched.commit);
    if (relation === "equal") return { result: "current" };
    if (relation === "ahead" || relation === "diverged")
      return blocked(relation);
    if (relation === null)
      return { result: "failed", reason: "relation-unknown" };
    progress("fast-forwarding", fetched.commit);
    return (await git.fastForward(directory, fetched.commit))
      ? { result: "fast-forwarded", from: now.commit, to: fetched.commit }
      : { result: "failed", reason: "fast-forward-failed" };
  } catch {
    return { result: "failed", reason: "operation-failed" };
  }
}

/** Who clones a declared module that is not here yet (decision F9's
 * addendum of 2026-11-01): this Environment's own GitHub, or anonymous Git
 * on a public Environment; a Team Environment, whose content the hosting
 * prepares through the broker, clones nothing here (null). */
export function cloneIdentity(
  remote: Scope["remote"],
  github: SyncHost["github"],
): RunContext["clone"] {
  return remote === "account"
    ? github
    : remote === "anonymous"
      ? "anonymous"
      : null;
}

/** A synchronization's answer for an absent repository it tried to clone:
 * no access is a quiet `absent` with
 * its reason, never `denied`; a destination that is suddenly there was
 * published meanwhile (`current`) or is something else (`blocked`). On a
 * public Environment anonymous Git cannot tell a private repository from a
 * failed clone, so that stays quietly absent too. */
export function cloneAnswer(
  outcome: ProvideOutcome,
  anonymous: boolean,
): Readonly<{ result: SyncResult; reason?: string }> {
  switch (outcome.result) {
    case "materialized":
      return { result: "materialized" };
    case "present":
      return { result: "current" };
    case "denied":
      return { result: "absent", reason: "repository-denied" };
    case "unavailable":
      return { result: "unavailable", reason: "remote-unavailable" };
    case "blocked":
      return { result: "blocked", reason: "unexpected-checkout" };
    default:
      return anonymous && outcome.reason === "clone-failed"
        ? { result: "absent", reason: "clone-failed" }
        : { result: "failed", reason: outcome.reason };
  }
}

/** A declared module (a guest Module among them) or data mount that is not
 * here yet, cloned when this Environment's identity can read it (decision
 * F9's addendum of 2026-11-01, DEV-6694 M8), by installation's own
 * `provideRepository`: GitHub is asked once, the clone goes to a temporary
 * sibling and is published with a no-replace rename, nothing present is
 * touched. Without access the repository stays `absent`, quietly, with the
 * reason; a restricted slot, a Team Environment and a data mount whose
 * module is not a checkout are never cloned here. The run already holds the
 * content lock. */
async function cloneAbsent(
  context: RunContext,
  root: string,
  child: SyncChild,
  cloning: () => void,
): Promise<Outcome> {
  if (context.clone === null || child.restricted) return { result: "absent" };
  if (child.parent !== undefined) {
    const parent = await context.git
      .inspect(join(root, child.parent))
      .catch(() => null);
    if (parent?.kind !== "checkout") return { result: "absent" };
  }
  cloning();
  let outcome: ProvideOutcome;
  try {
    outcome = await provideRepository({
      root,
      path: child.path,
      repository: child.repository,
      branch: child.kind === "data" ? child.branch : undefined,
      fillEmptyDirectory: child.kind === "data",
      git: context.git,
      github: context.clone,
    });
  } catch {
    return { result: "failed", reason: "operation-failed" };
  }
  if (outcome.result !== "materialized")
    return cloneAnswer(outcome, context.clone === "anonymous");
  // The commit it was cloned at, as a fast-forward names its `to`.
  const cloned = await context.git
    .inspect(join(root, child.path))
    .catch(() => null);
  return cloned?.kind === "checkout"
    ? { result: "materialized", to: cloned.commit }
    : { result: "materialized" };
}

/** `work` over `items`, at most `limit` at once, answers in their order. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane),
  );
  return results;
}
