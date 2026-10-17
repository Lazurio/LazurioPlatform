import { lstat, readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { classifyRepositorySlotPath } from "../organizations/repository-slots";
import type { FileLock } from "../platform/flock";
import { githubRemoteCoordinate } from "../providers/git-checkout";
import { type ContentGit, isBranchName } from "./git";
import { anonymousGitHub, type ContentGitHub } from "./github";
import {
  ensureCheckoutDirectories,
  materializeRepository,
} from "./materialize";
import { sameRepository } from "./model";

// One declared child repository of an Organization made present, the one
// implementation behind content installation (`materializeChild`) and a
// module's own data mount at its preparation (`provideDataMounts`). A present
// checkout is only looked at: never fetched, switched, reset or rewritten. An
// absent one is asked of GitHub as this Environment's identity reads it, then
// cloned on its branch and published by `materializeRepository`, which never
// replaces anything; for a data mount an empty directory counts as absent and
// is removed (`rmdir`, which refuses anything not empty) just before the
// publish. A remote that is empty or lacks the branch fails the clone;
// nothing here creates, initializes or pushes a repository.

export type ProvideRequest = Readonly<{
  /** The Organization root. */
  root: string;
  /** The slot, relative to `root` (`workspace/<module>/db`). */
  path: string;
  /** The expected `<owner>/<name>`. */
  repository: string;
  /** The branch an absent repository is cloned on: a repository database's
   * declared one. Absent: `main`. A present checkout's branch is never asked
   * (a person may be on any). */
  branch?: string | undefined;
  /** An empty directory at the place counts as absent (a data mount whose
   * directory was left empty); otherwise it is occupied. */
  fillEmptyDirectory?: boolean | undefined;
  git: ContentGit;
  /** This Environment's GitHub, or `anonymous` on a public Environment,
   * which asks GitHub nothing first and clones over anonymous HTTPS. */
  github: ContentGitHub | "anonymous";
  /** Taken just before a clone, and released after it: the content lock of
   * a caller that does not hold it already. Null: another content operation
   * holds it (`unavailable`, `content-busy`). */
  lock?: (() => Promise<FileLock | null>) | undefined;
}>;

export type ProvideOutcome =
  | Readonly<{ result: "materialized" | "present" }>
  | Readonly<{ result: "denied"; reason: "repository-denied" }>
  | Readonly<{
      result: "unavailable";
      reason: "github-unavailable" | "content-busy";
    }>
  | Readonly<{
      result: "blocked";
      reason: "destination-occupied" | "destination-invalid";
    }>
  | Readonly<{ result: "failed"; reason: string }>;

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    },
  );

/** Whether `path` is an empty real directory of the operator: no entries at
 * all, not a link, not another account's. */
async function emptyDirectory(path: string): Promise<boolean> {
  try {
    await inspectCheckoutDirectory(path);
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

/** Makes the declared repository present at `path`; see the module comment. */
export async function provideRepository(
  request: ProvideRequest,
): Promise<ProvideOutcome> {
  const segments = request.path.split("/");
  const name = segments.at(-1) as string;
  const destination = join(request.root, ...segments);
  if (request.branch !== undefined && !isBranchName(request.branch))
    return { result: "failed", reason: "branch-invalid" };
  // A present destination is reported, never entered or changed.
  const observed = await request.git.inspect(destination);
  if (observed.kind === "checkout")
    return sameRepository(observed.repository, request.repository)
      ? { result: "present" }
      : { result: "blocked", reason: "destination-occupied" };
  // Anything else there (a directory that is no checkout, a file, a link)
  // stays as it is, and GitHub is not asked; for a data mount an empty
  // directory is filled.
  let empty = false;
  try {
    if (await exists(destination)) {
      empty =
        request.fillEmptyDirectory === true &&
        (await emptyDirectory(destination));
      if (!empty) return { result: "blocked", reason: "destination-occupied" };
    }
  } catch {
    return { result: "blocked", reason: "destination-invalid" };
  }
  // GitHub's spelling of it, as this identity reads it. A public Environment
  // asks GitHub nothing first: anonymous Git reads a public repository, and
  // the clone of one it cannot read fails and is reported (`clone-failed`).
  let fullName = request.repository;
  if (request.github !== "anonymous") {
    const [owner, repositoryName] = request.repository.split("/") as [
      string,
      string,
    ];
    const access = await request.github.repository(owner, repositoryName);
    if (
      access.kind === "missing" ||
      (access.kind === "observed" && !access.repository.readable)
    )
      return { result: "denied", reason: "repository-denied" };
    if (access.kind !== "observed")
      return { result: "unavailable", reason: "github-unavailable" };
    fullName = access.repository.fullName;
  }
  const lock = request.lock === undefined ? undefined : await request.lock();
  if (lock === null) return { result: "unavailable", reason: "content-busy" };
  try {
    let parent: string;
    try {
      parent = await ensureCheckoutDirectories(
        request.root,
        segments.slice(0, -1),
      );
    } catch {
      return { result: "blocked", reason: "destination-invalid" };
    }
    if (empty)
      try {
        // Fails on anything that is not an empty directory by now.
        await rmdir(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
          return { result: "blocked", reason: "destination-occupied" };
      }
    const remote =
      request.github === "anonymous"
        ? anonymousGitHub.remote(fullName)
        : await request.github.remote(fullName);
    const result = await materializeRepository({
      parent,
      name,
      repository: request.repository,
      url: remote.url,
      credentialHelper: remote.credentialHelper,
      branch: request.branch,
      git: request.git,
    });
    if (result.kind === "materialized") return { result: "materialized" };
    if (result.kind === "occupied")
      return { result: "blocked", reason: "destination-occupied" };
    return { result: "failed", reason: result.code };
  } finally {
    await lock?.release();
  }
}

/** A declared repository database mount (`materialization:
 * "repository_db_mount"`) and the module it belongs to: the slot directly
 * above it (`workspace/<module>` for `workspace/<module>/db`,
 * `mission-control` for `mission-control/db`). Null for any other
 * declaration, and for a planned one. */
export type DataMount = Readonly<{
  path: string;
  /** The module's slot, relative to the Organization root. */
  parent: string;
  /** `<owner>/<name>` on GitHub, or null when its remote is none. */
  repository: string | null;
  /** The declared branch (`git.branch`), often `v3`; `main` when none is
   * declared. */
  branch: string;
}>;

export function dataMountOf(declaration: unknown): DataMount | null {
  if (
    declaration === null ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  )
    return null;
  const slot = declaration as Readonly<Record<string, unknown>>;
  if (
    slot.materialization !== "repository_db_mount" ||
    slot.status === "planned_slot" ||
    typeof slot.path !== "string" ||
    classifyRepositorySlotPath(slot.path) === null ||
    !slot.path.endsWith("/db")
  )
    return null;
  const git =
    slot.git !== null &&
    typeof slot.git === "object" &&
    !Array.isArray(slot.git)
      ? (slot.git as Readonly<Record<string, unknown>>)
      : {};
  const remote = git.url ?? slot.repo ?? slot.repository;
  return Object.freeze({
    path: slot.path,
    parent: slot.path.slice(0, -"/db".length),
    repository:
      typeof remote === "string" ? githubRemoteCoordinate(remote.trim()) : null,
    branch: typeof git.branch === "string" ? git.branch : "main",
  });
}
