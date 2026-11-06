import { randomBytes } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { assignedPerson, type MachineBinding } from "../folder/machine-binding";
import { githubIdentity, type PresetName } from "../folder/presets";
import type { ContentGit } from "./git";
import type { ContentGitHub, RepositoryAnswer } from "./github";
import { sameRepository } from "./model";
import {
  entryKey,
  type RemovalMark,
  type RemovedCopy,
  type SyncEntry,
  syncRecordFile,
} from "./sync-record";

// When access to a module has ended, its copy leaves the Environment (root
// decision 0232, decision F72), with whatever unsaved work it holds. Deleting cannot
// be undone, so "always" means without an exception for unsaved work, never
// on a doubt. A copy goes only when all of this holds, in two synchronizations
// in a row at least `removalConfirmAfterMs` apart:
//
// - the Environment's identity is proved live: `gh`'s viewer is the person the
//   handover names, by their immutable GitHub id (`removalIdentity`);
// - GitHub names the scope `repo` for its token, which reaches every
//   repository the person may read. A fine-grained token or an App's user
//   token may be limited to chosen repositories, can read the root and name
//   the person, and answers 404 for a module the person may read: no such
//   token proves anything;
// - the same token reads a private repository of this Organization through
//   the same API, in this run: its root when that is private, else another
//   repository the root declares. A public root proves nothing: a token whose
//   single sign-on for the Organization is missing or expired reads it and
//   answers 404 for every private repository;
// - GitHub answers 404 for the repository, itself an answer of its API and
//   not of `git ls-remote`, whose refusal may be a key or a helper
//   (`repository` says `missing` only for a 404 in GitHub's own error body).
//
// Everything else (no network, 5xx, a rate limit, an invalid or missing token,
// a signed-out gh, another viewer, a token without `repo`, an answer that
// cannot be read) proves nothing and clears the first proof, so the count
// starts again.

/** The least time between the two proofs. A person's press of Zkontrolovat
 * přístupy right after the hourly run must not make a second proof: an Admin
 * who switched the wrong Team off gets the time to switch it back, and one
 * passing GitHub answer is never enough. Below the hour of the round, so the
 * round after the first proof is the one that decides. */
export const removalConfirmAfterMs = 30 * 60 * 1000;

/** The GitHub id the identity must be proved against, or null where no copy
 * is ever removed: only a Work Environment that names its person. A computer
 * (`local`) is the person's own and a personal Environment holds no
 * Organization. A Team Environment's content is the hosting's and its answers
 * come from a broker, not from GitHub; a public Environment has no identity;
 * neither a Henry Environment, whose gh is its persona's account, nor Server
 * services record the identity they act with, so nothing could be proved. */
export function removalIdentity(
  preset: PresetName,
  machine: MachineBinding | null,
): number | null {
  if (
    preset !== "hosted-organization-personal" ||
    machine === null ||
    githubIdentity(preset, machine) === "none" ||
    machine.owner.kind !== "organization" ||
    machine.owner.assignment?.kind !== "operator"
  )
    return null;
  return assignedPerson(machine.owner.assignment)?.githubId ?? null;
}

/** What one more proof does: the first one is recorded, one that came too
 * soon keeps the first one's time and only one far enough from a first proof
 * of the same identity and repository removes the copy. */
export function removalStep(
  previous: RemovalMark | undefined,
  proof: Readonly<{ viewer: number; repository: string }>,
  now: Date,
): "mark" | "wait" | "remove" {
  if (
    previous === undefined ||
    previous.viewer !== proof.viewer ||
    !sameRepository(previous.repository, proof.repository)
  )
    return "mark";
  const since = Date.parse(previous.since);
  if (Number.isNaN(since) || since > now.getTime()) return "mark";
  return now.getTime() - since >= removalConfirmAfterMs ? "remove" : "wait";
}

/** The local reasons a checkout is blocked before anything asks the remote:
 * unsaved work is no reason to keep a copy, so these are asked too. Any other
 * block is no proven checkout of the slot (`unexpected-checkout`) or the
 * remote's own answer (`ahead`, `diverged`: this identity read it). */
const asksGitHub = (outcome: Readonly<{ result: string; reason?: string }>) =>
  outcome.result === "denied" ||
  (outcome.result === "blocked" &&
    ["dirty", "wrong-branch", "detached", "operation-in-progress"].includes(
      outcome.reason ?? "",
    ));

/** Every step from the Folder down to `path` is a real directory: a link
 * anywhere leads outside what this may touch. Asked before anything is
 * deleted, of the path as it is on disk. */
async function linkFree(folder: string, path: string): Promise<boolean> {
  if ((await realpath(folder).catch(() => null)) !== folder) return false;
  let at = folder;
  for (const segment of path.split("/")) {
    at = join(at, segment);
    const stat = await lstat(at).catch(() => null);
    if (stat === null || !stat.isDirectory()) return false;
  }
  return true;
}

// A removal in progress, written before the rename and deleted after the
// deletion: one file per removal beside the Folder's record, so a later run
// finishes exactly that removal and no directory that only looks like one.
const journalSchema = "lazurio.access-ended.removal.v1";
const journalId = /^[0-9a-f]{12}$/;

type JournalEntry = Readonly<{
  schema: typeof journalSchema;
  folder: string;
  /** The slot, relative to the Folder. */
  path: string;
  /** Its renamed copy's name, beside the slot. */
  moved: string;
}>;

const movedName = (path: string, id: string) =>
  `.${basename(path)}.removing-${id}`;

/** The journal files of one Folder start with this. */
export const removalJournalPrefix = (lockDirectory: string, folder: string) =>
  `${basename(syncRecordFile(lockDirectory, folder))}.removing-`;

/** A journal file's entry, when it is exactly what a removal of this Folder
 * wrote under that name; anything else is left alone. */
async function readJournal(
  file: string,
  id: string,
  folder: string,
): Promise<JournalEntry | null> {
  if (!journalId.test(id)) return null;
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as JournalEntry;
    return value.schema === journalSchema &&
      value.folder === folder &&
      typeof value.path === "string" &&
      value.path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      value.moved === movedName(value.path, id)
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Finishes the removals an earlier run left, each exactly as its journal
 * names it and only below a boundary without links. A journal that does not
 * hold, or a path that does not, stays as it is: nothing is deleted on it. */
async function resumeRemovals(
  lockDirectory: string,
  folder: string,
): Promise<void> {
  const prefix = removalJournalPrefix(lockDirectory, folder);
  const names = await readdir(lockDirectory).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.startsWith(prefix))) {
    const file = join(lockDirectory, name);
    const entry = await readJournal(file, name.slice(prefix.length), folder);
    if (entry === null) continue;
    const parent = dirname(entry.path);
    if (!(await linkFree(folder, parent))) continue;
    const moved = join(folder, parent, entry.moved);
    const stat = await lstat(moved).catch(() => null);
    if (stat !== null && !stat.isDirectory()) continue;
    try {
      if (stat !== null) await rm(moved, { recursive: true, force: true });
      await rm(file, { force: true });
    } catch {}
  }
}

/** The linked worktrees of a repository, by the paths its own metadata
 * records: those below its directory go with it, the others are counted. */
async function linkedWorktrees(commonDir: string): Promise<readonly string[]> {
  const metadata = join(commonDir, "worktrees");
  const names = await readdir(metadata).catch(() => [] as string[]);
  const paths = await Promise.all(
    names.map((name) =>
      readFile(join(metadata, name, "gitdir"), "utf8").then(
        (text) => dirname(text.trim()),
        () => null,
      ),
    ),
  );
  return paths.filter((path) => path !== null);
}

/** The copy at its slot, proved once more as the primary checkout of exactly
 * this repository below a boundary without links, gone with everything below
 * it: a journal entry, a rename, so nothing half-deleted ever looks like a
 * checkout, then the deletion. A deletion cut short leaves the journal entry
 * for the next run. Null: it was not that copy, and nothing changed. */
async function removeCopy(
  input: Readonly<{
    git: ContentGit;
    folder: string;
    lockDirectory: string;
    /** The slot, relative to the Folder. */
    path: string;
    repository: string;
    at: string;
  }>,
): Promise<RemovedCopy | null> {
  const { git, folder, lockDirectory, path, repository, at } = input;
  if (!(await linkFree(folder, path))) return null;
  const directory = join(folder, path);
  const observed = await git.inspect(directory);
  if (
    observed.kind !== "checkout" ||
    !sameRepository(observed.repository, repository)
  )
    return null;
  const tree = await git.worktree(directory);
  if (tree === null || tree.gitDir !== tree.commonDir) return null;
  const changes = await git.changes(directory, tree.gitDir);
  const linked = await linkedWorktrees(tree.commonDir);
  const inside = linked.filter((entry) =>
    entry.startsWith(`${directory}${sep}`),
  );
  const id = randomBytes(6).toString("hex");
  const name = movedName(path, id);
  const journal = join(
    lockDirectory,
    `${removalJournalPrefix(lockDirectory, folder)}${id}`,
  );
  const entry: JournalEntry = {
    schema: journalSchema,
    folder,
    path,
    moved: name,
  };
  await writeFile(journal, `${JSON.stringify(entry)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const moved = join(dirname(directory), name);
  try {
    await rename(directory, moved);
  } catch {
    await rm(journal, { force: true });
    return null;
  }
  await rm(moved, { recursive: true, force: true })
    .then(() => rm(journal, { force: true }))
    .catch(() => {});
  return Object.freeze({
    at,
    repository,
    commit: observed.commit,
    // Unknown counts as unsaved: the record must never understate a loss.
    unsaved: changes === null || changes.dirty || changes.operation,
    worktrees: inside.length,
    worktreesOutside: linked.length - inside.length,
  });
}

/** What a judged repository's answer gains: the first proof to record, or
 * the trace of the copy that left. */
export type AccessVerdict =
  | Readonly<{ kind: "kept"; removal?: RemovalMark }>
  | Readonly<{ kind: "removed"; removed: RemovedCopy }>;

type Slot = Readonly<{
  path: string;
  repository: string;
  /** A data mount's module: the apps to stop are that module's. */
  parent?: string;
}>;

export type AccessEnd = Readonly<{
  /** Finishes what an earlier run's removals left; under the content lock. */
  resume(): Promise<void>;
  /** One Organization of this run, by its login, its root directory, that
   * directory relative to the Folder and every repository its root declares
   * now, the candidates for the proof that this token reads private ones. */
  of(
    login: string,
    root: string,
    rootPath: string,
    declared: readonly string[],
  ): Readonly<{
    judge(
      slot: Slot,
      outcome: Readonly<{ result: string; reason?: string }>,
    ): Promise<AccessVerdict>;
  }>;
}>;

/** The rule of one run. Null where no copy is ever removed: no identity to
 * prove (`removalIdentity`) or no way to stop what runs. */
export function accessEnd(
  input: Readonly<{
    identity: number | null;
    folder: string;
    lockDirectory: string;
    github: ContentGitHub;
    git: ContentGit;
    retire: ((login: string, path: string) => Promise<boolean>) | undefined;
    /** The last record of this Folder: the first proofs. */
    record: readonly SyncEntry[] | null;
    now: () => Date;
  }>,
): AccessEnd | null {
  const { identity, folder, lockDirectory, github, git, retire, now } = input;
  if (identity === null || retire === undefined) return null;
  const marks = new Map(
    (input.record ?? []).flatMap((entry) =>
      entry.removal === undefined
        ? []
        : [[entryKey(entry), entry.removal] as const],
    ),
  );
  const reachable = async (repository: string) => {
    const [owner, name] = repository.split("/") as [string, string];
    return github
      .repository(owner, name)
      .catch(() => ({ kind: "unavailable" }) as const);
  };
  return Object.freeze({
    resume: () => resumeRemovals(lockDirectory, folder),
    of(login, root, rootPath, declared) {
      let proved: Promise<number | null> | undefined;
      const isOurs = (
        answer: RepositoryAnswer | Readonly<{ kind: "unavailable" }>,
      ): answer is Extract<RepositoryAnswer, { kind: "observed" }> =>
        answer.kind === "observed" &&
        answer.repository.readable &&
        answer.repository.owner.login.toLowerCase() === login.toLowerCase();
      // Asked once per Organization, only when a repository needs it.
      const provedViewer = async () => {
        const answer = await github
          .viewer()
          .catch(() => ({ kind: "unavailable" }) as const);
        if (
          answer.kind !== "signed-in" ||
          answer.viewer.databaseId !== identity
        )
          return null;
        // Only a token that reaches everything the person may read proves
        // anything by a 404.
        const scopes = await github.tokenScopes().catch(() => null);
        if (scopes === null || !scopes.includes("repo")) return null;
        const observed = await git.inspect(root);
        if (observed.kind !== "checkout") return null;
        const control = await reachable(observed.repository);
        if (!isOurs(control)) return null;
        if (control.repository.private) return answer.viewer.databaseId;
        // A public root: another repository must show that this token reads
        // the Organization's private ones.
        for (const repository of declared) {
          const candidate = await reachable(repository);
          if (isOurs(candidate) && candidate.repository.private)
            return answer.viewer.databaseId;
        }
        return null;
      };
      return Object.freeze({
        async judge(slot, outcome) {
          // Only a repository of this Organization: the root's answer proves
          // nothing about another owner, so a guest Module stays (F67).
          if (
            !asksGitHub(outcome) ||
            slot.repository.split("/")[0]?.toLowerCase() !== login.toLowerCase()
          )
            return { kind: "kept" };
          proved ??= provedViewer().catch(() => null);
          const viewer = await proved;
          if (viewer === null) return { kind: "kept" };
          const answer = await reachable(slot.repository);
          if (answer.kind !== "missing") return { kind: "kept" };
          const at = now();
          const proof = { viewer, repository: slot.repository };
          const previous = marks.get(
            entryKey({ organization: login, root: rootPath, path: slot.path }),
          );
          const step = removalStep(previous, proof, at);
          if (step === "mark")
            return {
              kind: "kept",
              removal: Object.freeze({ since: at.toISOString(), ...proof }),
            };
          if (step === "wait" || previous === undefined)
            return { kind: "kept", ...(previous ? { removal: previous } : {}) };
          // What runs stops first; what cannot be stopped keeps its copy
          // until a later run can.
          const stopped = await retire(login, slot.parent ?? slot.path).catch(
            () => false,
          );
          if (!stopped) return { kind: "kept", removal: previous };
          const removed = await removeCopy({
            git,
            folder,
            lockDirectory,
            path: join(rootPath, slot.path),
            repository: slot.repository,
            at: at.toISOString(),
          }).catch(() => null);
          return removed === null
            ? { kind: "kept", removal: previous }
            : { kind: "removed", removed };
        },
      });
    },
  });
}
