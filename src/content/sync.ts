import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import { inspectCanonicalInventory } from "../organizations/canonical-inventory";
import { parseCanonicalOrganization } from "../organizations/canonical-manifest";
import type { CatalogOrganization as FolderCatalogOrganization } from "../organizations/catalog";
import { readFolderCatalog } from "../organizations/catalog";
import { readOrganizationDocuments } from "../organizations/read-documents";
import { resolveOrganizationRoot } from "../organizations/root-resolution";
import { accessEnd, removalIdentity } from "./access-ended";
import type { ContentGit, RemoteAnswer, SyncRemote } from "./git";
import { type ContentHost, readFolderKind } from "./host";
import { declaredChildren } from "./install";
import { tryContentLock } from "./lock";
import { contentScope, sameRepository } from "./model";
import { type ProvideOutcome, provideRepository } from "./provide";
import {
  type RemovalMark,
  type RemovedCopy,
  readSyncRecord,
  recordSync,
  type SyncBlockedReason,
  type SyncEntry,
  type SyncResult,
} from "./sync-record";

export {
  contentSyncEveryMs,
  type RemovalMark,
  type RemovedCopy,
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
// decision F9's addendum of 2026-11-01). The one removal is of a module or
// data mount whose access proved to have ended (`access-ended.ts`, decision
// F72). Worktrees,
// Production Space repositories, `infra` and the Personalspace are never
// touched. The Launchpad runs it at its start and then every hour
// (`contentSyncEveryMs`) within its build sweep
// (`keepBuilt`), the CLI as `lazurio organization sync`, and since decision
// F9's second amendment of 2026-10-24 (root decision 0212 points 3, 4 and 7)
// `lazurio update` and Nová karta's Aktualizovat (`updateEverything`, with
// progress per repository, `onProgress`), the Open of one module
// (`createOpenSync`, one repository, `SyncRequest.repository`) and Apps'
// Zkontrolovat přístupy (one Organization, decision F36's addendum of
// 2026-11-05): one core, one content lock, one record.

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
> &
  Readonly<{
    /** Stops every app of a module and removes its builds, before its copy
     * goes because access ended (decision F72): the Organization's login and
     * the module's path; false when something could not be stopped. Without
     * it no copy is ever removed. */
    retire?: (login: string, path: string) => Promise<boolean>;
  }>;

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
}> &
  /** Which repository it is and where it belongs, as its answer names
   * them. */
  Pick<SyncEntry, "repository" | "parent" | "home" | "module">;

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
  /** `only`: the handover's Organization by its login, and by its GitHub
   * id where the handover names one (`organizationId`, #1281). */
  organizations:
    | "folder"
    | "none"
    | Readonly<{ only: string; organizationId?: number }>;
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
  const organizationId =
    machine?.owner.kind === "organization" &&
    machine.owner.organizationId !== undefined
      ? { organizationId: machine.owner.organizationId }
      : {};
  if (!scope.allowed)
    return machine?.owner.kind === "organization"
      ? {
          organizations: {
            only: machine.owner.organization,
            ...organizationId,
          },
          remote: "configured",
        }
      : { organizations: "none", remote: "configured" };
  return {
    organizations:
      typeof scope.organizations === "object"
        ? { ...scope.organizations, ...organizationId }
        : scope.organizations,
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
  let preset: PresetName;
  let machine: MachineBinding | null;
  try {
    const kind = await readFolderKind(folder);
    scope = syncScope(kind.preset, kind.machine);
    preset = kind.preset;
    machine = kind.machine;
  } catch {
    return { kind: "not-allowed", reason: "folder-unreadable" };
  }
  if (request.repository !== undefined && request.organization === undefined)
    throw new Error("A repository is named within its Organization");
  // A named Organization by another login than the handover's may still be
  // the handover's, renamed on GitHub: decided below by its id (#1281).
  const byId =
    typeof scope.organizations === "object" &&
    scope.organizations.organizationId !== undefined;
  if (
    scope.organizations === "none" ||
    (request.organization !== undefined &&
      !byId &&
      !admits(scope, request.organization))
  )
    return { kind: "not-allowed", reason: "not-for-this-environment" };
  const lock = await tryContentLock(host.lockDirectory, folder);
  if (lock === null) return { kind: "busy" };
  try {
    const now = request.now ?? (() => new Date());
    const at = now().toISOString();
    const catalog = await (host.readCatalog ?? readFolderCatalog)(folder);
    // The Organizations this run keeps, each by the login it is kept
    // under now; after a GitHub rename that may differ from what the root
    // or the handover still says (#1281). A root this Environment cannot
    // yet prove to be its handover's answers `organization-renamed`.
    const github = scope.remote === "account" ? host.github : null;
    const held: {
      entry: FolderCatalogOrganization;
      login: string;
      verified?:
        | Readonly<{ origin: string; repositoryId?: number }>
        | undefined;
    }[] = [];
    const renamed: SyncEntry[] = [];
    for (const entry of catalog.organizations) {
      if (
        entry.forgeLogin === undefined ||
        entry.reason === "template-not-runtime"
      )
        continue;
      const admitted = await admission(
        scope,
        entry,
        join(folder, "organizations", entry.directory),
        host.git,
        github,
      );
      if (admitted === null) continue;
      const { login } = admitted;
      if (
        request.organization !== undefined &&
        login.toLowerCase() !== request.organization.toLowerCase() &&
        entry.forgeLogin.toLowerCase() !== request.organization.toLowerCase()
      )
        continue;
      if (admitted.kind === "held")
        held.push({ entry, login, verified: admitted.verified });
      else
        renamed.push(
          Object.freeze({
            organization: login,
            root: join("organizations", entry.directory),
            path: ".",
            kind: "root",
            branch: "main",
            ...(admitted.kind === "unverified"
              ? { result: "unavailable", reason: "owner-unverified" }
              : {
                  result: "blocked",
                  reason:
                    admitted.kind === "renamed"
                      ? "organization-renamed"
                      : "unexpected-checkout",
                }),
            at,
          }),
        );
    }
    let helper: Promise<string | undefined> | undefined;
    const context: RunContext = {
      git: host.git,
      github,
      // Who clones a declared module that is not here yet (decision F9's
      // addendum of 2026-11-01): this Environment's own GitHub, or anonymous
      // Git on a public Environment; a Team Environment, whose content the
      // hosting prepares, clones nothing here.
      clone: cloneIdentity(scope.remote, preset, host.github),
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
    // The copies whose access ended (decision F72); read under the lock, so
    // the first proofs are the last run's.
    const ended = accessEnd({
      identity: removalIdentity(preset, machine),
      folder,
      lockDirectory: host.lockDirectory,
      github: host.github,
      git: host.git,
      retire: host.retire,
      record: await readSyncRecord(host.lockDirectory, folder),
      now,
    });
    await ended?.resume().catch(() => {});
    if (
      request.organization !== undefined &&
      !admits(scope, request.organization) &&
      held.length === 0 &&
      renamed.length === 0
    )
      return { kind: "not-allowed", reason: "not-for-this-environment" };
    const entries: SyncEntry[] = [...renamed];
    // A repository filter: that module and the data mounts below it.
    const wanted = (path: string) =>
      request.repository === undefined ||
      path === request.repository ||
      path.startsWith(`${request.repository}/`);
    for (const {
      entry: organization,
      login,
      verified: verifiedOrigin,
    } of held) {
      const root = join("organizations", organization.directory);
      // One repository: its progress as it goes, then its answer.
      const one = async (
        place: Pick<
          SyncEntry,
          | "path"
          | "kind"
          | "branch"
          | "repository"
          | "parent"
          | "home"
          | "module"
        >,
        run: (
          progress: (step: CheckoutStep, to: string) => void,
        ) => Promise<Outcome>,
      ): Promise<SyncEntry> => {
        const { path, kind, branch, repository, parent, home, module } = place;
        const where = {
          organization: login,
          root,
          path,
          kind,
          branch,
          ...(repository === undefined ? {} : { repository }),
          ...(parent === undefined ? {} : { parent }),
          ...(home === undefined ? {} : { home }),
          ...(module === undefined ? {} : { module }),
        };
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
      // The root as it declares itself (`root_repository.locator`), read
      // from its checkout before it is synchronized.
      const declaredRoot = await rootRepositoryOf(directory, login);
      const rootEntry = await one(
        {
          path: ".",
          kind: "root",
          branch: "main",
          ...(declaredRoot === null ? {} : { repository: declaredRoot }),
        },
        (progress) =>
          syncCheckout(
            context,
            directory,
            // Under the login it is kept under, and where GitHub named the
            // owner of its origin, still that very origin: a checkout
            // changed meanwhile is never read without that check.
            (repository) =>
              repository.split("/")[0]?.toLowerCase() === login.toLowerCase() &&
              (verifiedOrigin === undefined ||
                sameRepository(repository, verifiedOrigin.origin)),
            "main",
            progress,
            // The root keeps its repository's name through a rename of its
            // owner: the same name under the login it is kept under now.
            (repository) => `${login}/${repository.split("/")[1]}`,
            // Any other origin only with the very repository id the owner
            // check verified; without that id, none.
            verifiedOrigin === undefined
              ? undefined
              : (verifiedOrigin.repositoryId ?? null),
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
      // A root that still does not run after its synchronization (conflict,
      // projection_drift or any state the admission does not execute) is
      // brought here only so that its repair arrives (#1094): its children
      // are never taken from a declaration Lazurio does not run.
      const resolved = await resolveOrganizationRoot(directory).catch(
        () => null,
      );
      if (resolved?.kind === "root-resolved" && !resolved.executable) continue;
      const declared = await childrenOf(directory);
      const children = declared.filter((child) => wanted(child.path));
      const access = ended?.of(
        login,
        directory,
        root,
        declared.map((child) => child.repository),
      );
      // Modules first, then the data mounts: a data mount is cloned only
      // below its declared module whose primary checkout this run verified
      // (an answer that got past the identity and worktree checks).
      const verified = new Set<string>();
      for (const pass of ["module", "data"] as const) {
        const answered = await pool(
          children.filter((child) => child.kind === pass),
          request.concurrency ?? syncConcurrency,
          (child) =>
            one(child, async (progress) => {
              const outcome = await syncCheckout(
                context,
                join(directory, child.path),
                (repository) => sameRepository(repository, child.repository),
                child.branch,
                progress,
                () => child.repository,
              );
              if (outcome.result !== "absent") {
                const verdict = await access?.judge(child, outcome);
                return verdict?.kind === "removed"
                  ? {
                      result: "absent",
                      reason: "access-ended",
                      removed: verdict.removed,
                    }
                  : verdict?.removal === undefined
                    ? outcome
                    : { ...outcome, removal: verdict.removal };
              }
              if (child.parent !== undefined && !verified.has(child.parent))
                return { result: "absent" };
              const cloned = await cloneAbsent(context, directory, child, () =>
                progress("cloning", ""),
              );
              // A checkout that appeared meanwhile (another run, a person)
              // is answered by the full check of a present one: its
              // identity, primary checkout, own state and remote; never
              // taken as verified on its origin alone (review of #793).
              return cloned === "appeared"
                ? syncCheckout(
                    context,
                    join(directory, child.path),
                    (repository) =>
                      sameRepository(repository, child.repository),
                    child.branch,
                    progress,
                    () => child.repository,
                  )
                : cloned;
            }),
        );
        for (const entry of answered)
          if (verifiedCheckout(entry)) verified.add(entry.path);
        entries.push(...answered);
      }
    }
    const organizations = [
      ...held.map(({ login }) => login),
      ...renamed.map((entry) => entry.organization),
    ];
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

/** Whether this run keeps a root of the Folder, and under which login:
 * - `held`: its declared login is the handover's (or the Folder's scope
 *   admits every Organization), or it declares the handover's Organization
 *   id (`forge_binding.organization_id`) and the handover names that id: a
 *   GitHub rename (#1281). Kept under the login GitHub answers for the
 *   root's repository by that Organization id, else the declared one.
 * - `renamed`: it declares another login, the handover names no
 *   Organization id, and GitHub answers this root's repository with the
 *   declared Organization id, either under the declared login (the root
 *   changed first) or under the handover's (the handover changed first).
 *   The Organization was renamed on GitHub, and until the handover names it
 *   by its id nothing here can prove it is the same one, because GitHub
 *   frees the old login for anyone.
 * - `foreign`: under the handover's login, yet the root declares another
 *   Organization id than the handover, or GitHub answers the root's origin
 *   under another id than the root declares (someone took the login after a
 *   rename): never read.
 * - `unverified`: the root declares an Organization id and GitHub gives no
 *   answer that names the owner of its origin; git may still reach a
 *   namesake, so the root is not read and answers `unavailable`
 *   (`owner-unverified`) until GitHub answers.
 * - null: another Organization's root, left alone as before. */
async function admission(
  scope: Scope,
  entry: FolderCatalogOrganization,
  directory: string,
  git: ContentGit,
  github: RunContext["github"],
): Promise<
  /** `verified`: the root's origin whose owner GitHub named by the root's
   * Organization id, with that repository's id; the root is synchronized
   * only from exactly that origin, or from another one GitHub answers with
   * the same repository id. */
  | Readonly<{
      kind: "held";
      login: string;
      verified?: Readonly<{ origin: string; repositoryId?: number }>;
    }>
  | Readonly<{ kind: "renamed" | "foreign" | "unverified"; login: string }>
  | null> {
  const declared = entry.forgeLogin as string;
  const id = entry.forgeOrganizationId;
  // The root's origin as GitHub answers it now, by the Organization id the
  // root declares: `same` (with the owner's login now), `other` (another
  // Organization's), `unknown` when it cannot be told (the checkout could
  // not be read, or GitHub gives no answer that names the owner): git may
  // still reach a namesake, so the root is not read then. `absent` where
  // nothing is at the place yet; undefined where there is nothing to check
  // (no id, no GitHub of this Environment).
  const probe = async () => {
    if (github === null || id === undefined) return undefined;
    const observed = await git.inspect(directory).catch(() => null);
    if (observed?.kind !== "checkout")
      return observed !== null && (await absentAt(directory))
        ? { kind: "absent" as const }
        : { kind: "unknown" as const };
    const [owner, name] = observed.repository.split("/") as [string, string];
    const answer = await github.repository(owner, name).catch(() => null);
    if (answer?.kind !== "observed") return { kind: "unknown" as const };
    return answer.repository.owner.databaseId === id
      ? {
          kind: "same" as const,
          origin: observed.repository,
          repositoryId: answer.repository.databaseId,
          owner: answer.repository.owner.login,
        }
      : { kind: "other" as const };
  };
  if (typeof scope.organizations !== "object")
    return admits(scope, declared) ? { kind: "held", login: declared } : null;
  const { only, organizationId } = scope.organizations;
  // Two ids that differ are two Organizations, whatever their logins say.
  if (id !== undefined && organizationId !== undefined && id !== organizationId)
    return admits(scope, declared)
      ? { kind: "foreign", login: declared }
      : null;
  const held = (now: Awaited<ReturnType<typeof probe>>, login: string) =>
    now?.kind === "same"
      ? {
          kind: "held" as const,
          login,
          verified: {
            origin: now.origin,
            ...(now.repositoryId === undefined
              ? {}
              : { repositoryId: now.repositoryId }),
          },
        }
      : { kind: "held" as const, login };
  if (admits(scope, declared)) {
    const now = await probe();
    return now?.kind === "other"
      ? { kind: "foreign", login: declared }
      : now?.kind === "unknown"
        ? { kind: "unverified", login: declared }
        : held(now, declared);
  }
  if (id === undefined) return null;
  if (organizationId !== undefined) {
    if (id !== organizationId) return null;
    const now = await probe();
    return now?.kind === "other"
      ? { kind: "foreign", login: declared }
      : now?.kind === "unknown"
        ? { kind: "unverified", login: declared }
        : held(now, now?.kind === "same" ? now.owner : declared);
  }
  // Without the id in the handover: renamed when GitHub answers the root's
  // origin with the root's declared Organization id and either the root was
  // updated first (its origin still under the handover's login, the answer
  // under the declared one) or the handover was (the answer under the
  // handover's login, the root still declaring the earlier one).
  const now = await probe();
  // GitHub gives no answer: whether this root is the handover's renamed
  // Organization stays open, and says so rather than skipping it silently.
  if (now?.kind === "unknown") return { kind: "unverified", login: only };
  if (now?.kind !== "same") return null;
  const lower = (value: string | undefined) => value?.toLowerCase();
  const rootFirst =
    lower(now.origin.split("/")[0]) === lower(only) &&
    lower(now.owner) === lower(declared);
  const handoverFirst = lower(now.owner) === lower(only);
  return rootFirst || handoverFirst ? { kind: "renamed", login: only } : null;
}

type RunContext = Readonly<{
  git: ContentGit;
  /** This Environment's own GitHub, which proves a rename by repository id
   * (#1281); null where the run reads through git's configured helper or
   * anonymously, which then never rewrites an origin. */
  github: SyncHost["github"] | null;
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
  removal?: RemovalMark;
  removed?: RemovedCopy;
  origin?: Readonly<{ from: string; to: string }>;
}>;

type SyncChild = Readonly<{
  path: string;
  repository: string;
  kind: "module" | "data";
  branch: string;
  /** Restricted (Organization Admin only), itself or below such a slot: kept current
   * when present, never cloned by a synchronization. */
  restricted: boolean;
  /** A data mount's module. */
  parent?: string;
  /** A shared Module's slot and its data mount's: the home Organization
   * (`home_organization`) and the shared Module's slot slug, as the entry
   * carries them. */
  home?: string;
  module?: string;
}>;

/** The root's own repository as its declaration names it
 * (`root_repository.locator`, `<owner>/<name>`), when it is the root of
 * `login`; null when the declaration cannot be read or names another
 * owner. Files only, nothing of Git or GitHub. */
async function rootRepositoryOf(
  root: string,
  login: string,
): Promise<string | null> {
  try {
    const documents = await readOrganizationDocuments(root);
    if (
      documents.kind !== "documents-observed" ||
      documents.canonical.kind !== "present"
    )
      return null;
    const canonical = parseCanonicalOrganization(
      documents.canonical.value,
    ) as Readonly<Record<string, unknown>>;
    const locator = (
      canonical.root_repository as Readonly<Record<string, unknown>> | null
    )?.locator;
    return typeof locator === "string" &&
      locator.split("/")[0]?.toLowerCase() === login.toLowerCase()
      ? locator
      : null;
  } catch {
    return null;
  }
}

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
    // The declared slots by path: a shared Module's home and slug, as the
    // slot declares them, for it and for its data mount (decision F67's
    // addendum of 2026-11-21). The synchronization reads no manifest for it;
    // its name comes from the catalog (F67's addendum of 2026-11-22).
    const slots = new Map(
      inventory.inventory.slots.flatMap((slot) =>
        slot === null ? [] : [[slot.path, slot] as const],
      ),
    );
    const shared = (path: string, module: string) => {
      const home = slots.get(path)?.home;
      if (home === undefined) return {};
      const slug = slots.get(module)?.id ?? undefined;
      return slug === undefined ? { home } : { home, module: slug };
    };
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
              ...shared(child.path, child.data?.parent ?? child.path),
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
  declared?: (origin: string) => string,
  /** The repository id a redirect must also answer with (the root's owner
   * check verified it); null: no redirect is taken at all. */
  pinned?: number | null,
): Promise<Outcome> {
  const { git } = context;
  const deadline = Date.now() + context.timeoutMs;
  const remaining = () => Math.max(1_000, deadline - Date.now());
  try {
    let observed = await git.inspect(directory);
    if (observed.kind !== "checkout")
      return (await absentAt(directory))
        ? { result: "absent" }
        : blocked("unexpected-checkout");
    const misnamed = !expected(observed.repository);
    if (
      misnamed &&
      (declared === undefined || context.github === null || pinned === null)
    )
      return blocked("unexpected-checkout");
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
    // An origin that names the repository's earlier `<owner>/<name>` (a
    // GitHub rename, #1281) is pointed to the declared one only when GitHub
    // answers both with the same repository id; anything else stays
    // `unexpected-checkout`. Only the origin's URL changes, before the
    // checkout's own state is looked at, so that a later push of a blocked
    // checkout goes to the repository and never to a namesake who took the
    // earlier name.
    let origin: Outcome["origin"];
    if (misnamed && declared !== undefined && context.github !== null) {
      const moved = await redirect(
        context.github,
        git,
        directory,
        observed.repository,
        declared(observed.repository),
        pinned ?? undefined,
      );
      if (moved.kind !== "moved") return moved.outcome;
      origin = Object.freeze({ from: observed.repository, to: moved.to });
      observed = await git.inspect(directory);
      // Exactly the repository `redirect` proved by its id.
      if (
        observed.kind !== "checkout" ||
        !sameRepository(observed.repository, moved.to)
      )
        return { ...blocked("unexpected-checkout"), origin };
    }
    const withOrigin = (outcome: Outcome): Outcome =>
      origin === undefined ? outcome : { ...outcome, origin };
    return withOrigin(
      await keepCurrent(
        context,
        directory,
        tree,
        observed,
        branch,
        progress,
        remaining,
      ),
    );
  } catch {
    return { result: "failed", reason: "operation-failed" };
  }
}

/** Whether `from` is the earlier name of the declared repository `to`:
 * GitHub answers both with the same repository id, the declared one under
 * its own name. Then the checkout's origin is pointed to it. */
async function redirect(
  github: NonNullable<RunContext["github"]>,
  git: ContentGit,
  directory: string,
  from: string,
  to: string,
  pinned?: number,
): Promise<
  | Readonly<{ kind: "moved"; to: string }>
  | Readonly<{ kind: "refused"; outcome: Outcome }>
> {
  const refused = (outcome: Outcome) => ({ kind: "refused" as const, outcome });
  const ask = (repository: string) => {
    const [owner, name] = repository.split("/") as [string, string];
    return github.repository(owner, name);
  };
  const [earlier, now] = [await ask(from), await ask(to)];
  if (earlier.kind === "unavailable" || now.kind === "unavailable")
    return refused({ result: "unavailable", reason: "remote-unavailable" });
  const id =
    earlier.kind === "observed" ? earlier.repository.databaseId : undefined;
  if (
    earlier.kind !== "observed" ||
    now.kind !== "observed" ||
    id === undefined ||
    now.repository.databaseId !== id ||
    (pinned !== undefined && id !== pinned) ||
    !sameRepository(now.repository.fullName, to) ||
    git.setOrigin === undefined
  )
    return refused(blocked("unexpected-checkout"));
  return (await git.setOrigin(directory, from, now.repository.fullName))
    ? { kind: "moved", to: now.repository.fullName }
    : refused({ result: "failed", reason: "origin-update-failed" });
}

/** A checkout whose identity is verified, kept on `branch`. */
async function keepCurrent(
  context: RunContext,
  directory: string,
  tree: Readonly<{ gitDir: string }>,
  observed: Extract<
    Awaited<ReturnType<ContentGit["inspect"]>>,
    { kind: "checkout" }
  >,
  branch: string,
  progress: (step: CheckoutStep, to: string) => void,
  remaining: () => number,
): Promise<Outcome> {
  const { git } = context;
  try {
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
    if (head.commit === observed.commit)
      return { result: "current", to: head.commit };
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
    if (relation === "equal") return { result: "current", to: fetched.commit };
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
 * on a public Environment. A Team Environment, public or not, whose content
 * the hosting prepares, clones nothing here (null), and neither does an
 * Environment that reads through git's configured helper. */
export function cloneIdentity(
  remote: Scope["remote"],
  preset: PresetName,
  github: SyncHost["github"],
): RunContext["clone"] {
  if (preset === "hosted-organization-team") return null;
  return remote === "account"
    ? github
    : remote === "anonymous"
      ? "anonymous"
      : null;
}

/** Whether an answer verified a primary checkout of the declared repository
 * AND that this identity read its remote in this run: current, moved or
 * cloned, or `ahead` / `diverged`, which are known only after the remote's
 * answer. A checkout blocked by its own state (changes, another branch, a
 * detached HEAD, an operation) was never asked of the remote, so its access
 * is unknown and no data mount is cloned below it (review of #793). */
const verifiedCheckout = (entry: SyncEntry) =>
  entry.result === "current" ||
  entry.result === "fast-forwarded" ||
  entry.result === "materialized" ||
  (entry.result === "blocked" &&
    (entry.reason === "ahead" || entry.reason === "diverged"));

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
): Promise<Outcome | "appeared"> {
  if (context.clone === null || child.restricted) return { result: "absent" };
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
  if (outcome.result === "present") return "appeared";
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
