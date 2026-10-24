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
import {
  recordSync,
  type SyncBlockedReason,
  type SyncEntry,
  type SyncResult,
} from "./sync-record";

export {
  readSyncRecord,
  type SyncBlockedReason,
  type SyncEntry,
  type SyncResult,
  syncBlockedReasons,
  syncFindings,
  syncRecordFile,
} from "./sync-record";

// Synchronization of existing repositories (docs/content-sync.md, "Existing
// repositories"; decision F9's amendment of 2026-10-24, root decision 0195,
// addendum of 2026-10-24, point 26): the primary checkouts of an
// Organization's root, its modules (workspace modules and the root-level
// applications) and their declared data mounts are kept on their published
// branch. Per repository: one `ls-remote` of its branch, and only when that
// differs from the checkout, a fetch, then a strict fast-forward to exactly
// the commit the fetch brought. A checkout changes only when its tracked and
// untracked files are clean, it is on the expected branch and no operation
// is under way; anything else is reported and left as it is. Never a stash,
// a switch, a reset, a merge, a clone, a hook or a preparation. Worktrees,
// Production Space repositories, `infra` and the Personalspace are never
// touched. The Launchpad runs it at its sweep (`keepBuilt`), the CLI as
// `lazurio organization sync`: one core, one content lock, one record.

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

export type SyncRequest = Readonly<{
  /** Only this Organization, by GitHub login; absent: every one this
   * Environment holds. */
  organization?: string | undefined;
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
    for (const organization of held) {
      const login = organization.forgeLogin as string;
      const root = join("organizations", organization.directory);
      const entry = (
        path: string,
        kind: SyncEntry["kind"],
        branch: string,
        outcome: Outcome,
      ): SyncEntry =>
        Object.freeze({
          organization: login,
          root,
          path,
          kind,
          branch,
          ...outcome,
          at: now().toISOString(),
        });
      const directory = join(folder, root);
      const rootOutcome = await syncCheckout(
        context,
        directory,
        (repository) =>
          repository.split("/")[0]?.toLowerCase() === login.toLowerCase(),
        "main",
      );
      entries.push(entry(".", "root", "main", rootOutcome));
      // A root that did not end on its published commit stops this
      // Organization: its children are never taken from a stale
      // declaration.
      if (
        rootOutcome.result !== "current" &&
        rootOutcome.result !== "fast-forwarded"
      )
        continue;
      const children = await childrenOf(directory);
      const outcomes = await pool(
        children,
        request.concurrency ?? syncConcurrency,
        (child) =>
          syncCheckout(
            context,
            join(directory, child.path),
            (repository) => sameRepository(repository, child.repository),
            child.branch,
          ),
      );
      for (const [index, child] of children.entries())
        entries.push(
          entry(
            child.path,
            child.kind,
            child.branch,
            outcomes[index] as Outcome,
          ),
        );
    }
    const organizations = held.map((entry) => entry.forgeLogin as string);
    const recorded = await recordSync(
      host.lockDirectory,
      folder,
      entries,
      request.organization === undefined ? "all" : organizations,
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
  timeoutMs: number;
  remote: (repository: string) => Promise<SyncRemote>;
}>;

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
}>;

/** The modules and data mounts the root declares now: workspace modules,
 * the root-level applications and the data mounts below them, each with a
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
    return (await git.fastForward(directory, fetched.commit))
      ? { result: "fast-forwarded", from: now.commit, to: fetched.commit }
      : { result: "failed", reason: "fast-forward-failed" };
  } catch {
    return { result: "failed", reason: "operation-failed" };
  }
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
