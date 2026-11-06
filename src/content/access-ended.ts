import { randomBytes } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { assignedPerson, type MachineBinding } from "../folder/machine-binding";
import { githubIdentity, type PresetName } from "../folder/presets";
import type { ContentGit } from "./git";
import type { ContentGitHub } from "./github";
import { sameRepository } from "./model";
import {
  entryKey,
  type RemovalMark,
  type RemovedCopy,
  type SyncEntry,
} from "./sync-record";

// When access to a module has ended, its copy leaves the Environment (decision
// F72, Matěj 2026-11-06), with whatever unsaved work it holds. Deleting cannot
// be undone, so "always" means without an exception for unsaved work, never
// on a doubt. A copy goes only when all of this holds, in two synchronizations
// in a row at least `removalConfirmAfterMs` apart:
//
// - the Environment's identity is proved live: `gh`'s viewer is the person the
//   handover names, by their immutable GitHub id (`removalIdentity`);
// - the same identity still reads the Organization's root repository through
//   the same API, so a token that lost its scope, an expired single sign-on
//   or any other refusal of everything cannot look like one module's refusal;
// - GitHub answers 404 for the repository, itself an answer of its API and
//   not of `git ls-remote`, whose refusal may be a key or a helper
//   (`repository` says `missing` only for a 404 in GitHub's own error body).
//
// Everything else (no network, 5xx, a rate limit, an invalid or missing token,
// a signed-out gh, another viewer, an answer that cannot be read) proves
// nothing and clears the first proof, so the count starts again.

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

const removingName = (name: string) =>
  new RegExp(
    `^\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.removing-[0-9a-f]{12}$`,
  );

/** What is left of an interrupted removal of `directory`: its renamed copy
 * beside it, by its exact name and only as a real directory. */
async function sweepRemoved(directory: string): Promise<void> {
  const parent = dirname(directory);
  const pattern = removingName(basename(directory));
  const names = await readdir(parent).catch(() => [] as string[]);
  for (const name of names.filter((entry) => pattern.test(entry))) {
    const leftover = join(parent, name);
    const stat = await lstat(leftover).catch(() => null);
    if (stat?.isDirectory() === true)
      await rm(leftover, { recursive: true, force: true }).catch(() => {});
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

/** The copy at `directory`, proved once more as the primary checkout of
 * exactly this repository and as a real directory at its declared place, gone
 * with everything below it: a rename, so nothing half-deleted ever looks like
 * a checkout, then the deletion. Null: it was not, and nothing changed. */
async function removeCopy(
  git: ContentGit,
  root: string,
  path: string,
  repository: string,
  at: string,
): Promise<RemovedCopy | null> {
  const directory = join(root, path);
  // A link anywhere on the way resolves elsewhere: nothing it points to goes.
  if ((await realpath(directory)) !== join(await realpath(root), path))
    return null;
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
  const moved = join(
    dirname(directory),
    `.${basename(directory)}.removing-${randomBytes(6).toString("hex")}`,
  );
  await rename(directory, moved);
  await rm(moved, { recursive: true, force: true });
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
  /** One Organization of this run, by its login and root directory. */
  of(
    login: string,
    root: string,
    rootPath: string,
  ): Readonly<{
    judge(
      slot: Slot,
      outcome: Readonly<{ result: string; reason?: string }>,
    ): Promise<AccessVerdict>;
    sweep(path: string): Promise<void>;
  }>;
}>;

/** The rule of one run. Null where no copy is ever removed: no identity to
 * prove (`removalIdentity`) or no way to stop what runs. */
export function accessEnd(
  input: Readonly<{
    identity: number | null;
    github: ContentGitHub;
    git: ContentGit;
    retire: ((login: string, path: string) => Promise<boolean>) | undefined;
    /** The last record of this Folder: the first proofs. */
    record: readonly SyncEntry[] | null;
    now: () => Date;
  }>,
): AccessEnd | null {
  const { identity, github, git, retire, now } = input;
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
    of(login, root, rootPath) {
      let proved: Promise<number | null> | undefined;
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
        const observed = await git.inspect(root);
        if (observed.kind !== "checkout") return null;
        const control = await reachable(observed.repository);
        return control.kind === "observed" &&
          control.repository.readable &&
          control.repository.owner.login.toLowerCase() === login.toLowerCase()
          ? answer.viewer.databaseId
          : null;
      };
      return Object.freeze({
        sweep: (path) => sweepRemoved(join(root, path)),
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
          const removed = await removeCopy(
            git,
            root,
            slot.path,
            slot.repository,
            at.toISOString(),
          ).catch(() => null);
          return removed === null
            ? { kind: "kept", removal: previous }
            : { kind: "removed", removed };
        },
      });
    },
  });
}
