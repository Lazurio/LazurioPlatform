import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The record of the synchronization of existing repositories (decision F9's
// amendment of 2026-10-24, `sync.ts`): its answer per repository and the
// file the CLI, the doctor and the Launchpad read it from. Apart from the
// synchronization itself, so that readers need none of its machinery.

export const syncBlockedReasons = [
  "dirty",
  "wrong-branch",
  "diverged",
  "ahead",
  "detached",
  "operation-in-progress",
  /** Something else at the place: no checkout of the declared repository,
   * a linked worktree, a directory that is no checkout. */
  "unexpected-checkout",
] as const;
export type SyncBlockedReason = (typeof syncBlockedReasons)[number];

export type SyncResult =
  /** A declared repository that was not here, cloned by this run (decision
   * F9's addendum of 2026-11-01). */
  | "materialized"
  | "fast-forwarded"
  | "current"
  | "blocked"
  | "absent"
  | "denied"
  | "unavailable"
  | "failed";

/** GitHub's first proof that this identity can no longer reach a repository
 * (decision F72, `access-ended.ts`). It stands only while every later run of
 * this repository proves the same; any other answer drops it. */
export type RemovalMark = Readonly<{
  /** When the first proof was given (ISO 8601). */
  since: string;
  /** The GitHub id of the proved identity. */
  viewer: number;
  repository: string;
}>;

/** The trace of a copy that left because access ended (decision F72). */
export type RemovedCopy = Readonly<{
  /** When it was removed (ISO 8601). */
  at: string;
  repository: string;
  /** The commit its checkout stood on. */
  commit: string;
  /** Whether it held changes nothing had saved. */
  unsaved: boolean;
  /** Its linked worktrees removed with it, and those outside its slot,
   * which nothing touches. */
  worktrees: number;
  worktreesOutside: number;
}>;

/** One repository's answer, as recorded and printed. */
export type SyncEntry = Readonly<{
  /** The Organization's GitHub login. */
  organization: string;
  /** The Organization root, relative to the Folder. */
  root: string;
  /** The repository, relative to the root: `.` for the root itself. */
  path: string;
  kind: "root" | "module" | "data";
  /** The branch it is kept on: `main`, or a data mount's declared one. */
  branch: string;
  result: SyncResult;
  /** `blocked`: a `syncBlockedReasons` member; `denied`, `unavailable`,
   * `failed`: a locale-neutral code. */
  reason?: string;
  /** `fast-forwarded`: the commit before and after. */
  from?: string;
  to?: string;
  /** When this answer was given (ISO 8601). */
  at: string;
  /** GitHub refused this identity at the last read of this repository's
   * remote, and no later run read it again: this answer (blocked by the
   * checkout's own state, unavailable, failed) never asked the remote.
   * Apps keeps a guest Module hidden while it is set (decision F67's
   * addendum of 2026-11-01). */
  unreadable?: true;
  /** Since when the repository gives this same answer without interruption,
   * for every answer but `current`, `fast-forwarded`, `materialized` and
   * an `absent` without a reason. */
  since?: string;
  /** GitHub's first proof that access ended; the copy is still here. */
  removal?: RemovalMark;
  /** The copy left because access ended; stays while the slot is absent. */
  removed?: RemovedCopy;
}>;

// ---- The record -------------------------------------------------------------

// The last answer per repository, beside the content lock in the install
// base (`<base>/content/sync-<digest of the Folder>.json`), so the CLI, the
// doctor and the Launchpad read the same: written whole by a rename, under
// the content lock, by the run that answered. A run for one Organization
// replaces that Organization's entries only, a run for one repository that
// repository's, a run for all of them the record. Coordination and
// visibility, with one exception: a first proof (`removal`) that access ended
// is read back by the next run (decision F72). A lost record only makes the
// count start again.

const recordSchema = "lazurio.content-sync.v1";

/** How often the Launchpad keeps the Folder's primary checkouts on their
 * published branch: at its start, then every hour (root
 * decision 0212 points 2 and 4). Its 5-minute build sweep
 * stays and builds whatever a synchronization brought. One constant, so the
 * cadence is one line to change. */
export const contentSyncEveryMs = 60 * 60 * 1000;

/** The record of one Folder (its canonical path) in `lockDirectory`. */
export function syncRecordFile(lockDirectory: string, folder: string) {
  const digest = createHash("sha256").update(folder).digest("hex");
  return join(lockDirectory, `sync-${digest.slice(0, 32)}.json`);
}

const results: readonly SyncResult[] = [
  "materialized",
  "fast-forwarded",
  "current",
  "blocked",
  "absent",
  "denied",
  "unavailable",
  "failed",
];
const text = (value: unknown) => typeof value === "string";
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const validMark = (value: unknown) => {
  if (value === null || typeof value !== "object") return false;
  const mark = value as Record<string, unknown>;
  return text(mark.since) && count(mark.viewer) && text(mark.repository);
};

const validRemoved = (value: unknown) => {
  if (value === null || typeof value !== "object") return false;
  const copy = value as Record<string, unknown>;
  return (
    text(copy.at) &&
    text(copy.repository) &&
    text(copy.commit) &&
    typeof copy.unsaved === "boolean" &&
    count(copy.worktrees) &&
    count(copy.worktreesOutside)
  );
};

const validEntry = (value: unknown): value is SyncEntry => {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    text(entry.organization) &&
    text(entry.root) &&
    text(entry.path) &&
    ["root", "module", "data"].includes(entry.kind as string) &&
    text(entry.branch) &&
    results.includes(entry.result as SyncResult) &&
    text(entry.at) &&
    (entry.reason === undefined || text(entry.reason)) &&
    (entry.unreadable === undefined || entry.unreadable === true) &&
    (entry.since === undefined || text(entry.since)) &&
    (entry.removal === undefined || validMark(entry.removal)) &&
    (entry.removed === undefined || validRemoved(entry.removed))
  );
};

/** The last recorded answers of this Folder, or null when there is no
 * readable record. */
export async function readSyncRecord(
  lockDirectory: string,
  folder: string,
): Promise<readonly SyncEntry[] | null> {
  try {
    const value = JSON.parse(
      await readFile(syncRecordFile(lockDirectory, folder), "utf8"),
    ) as Record<string, unknown>;
    if (
      value.schema !== recordSchema ||
      value.folder !== folder ||
      !Array.isArray(value.entries) ||
      !value.entries.every(validEntry)
    )
      return null;
    return Object.freeze(value.entries as SyncEntry[]);
  } catch {
    return null;
  }
}

/** One repository of the record, whatever the case of the login. */
export const entryKey = (
  entry: Readonly<{ organization: string; root: string; path: string }>,
) => `${entry.organization.toLowerCase()}\0${entry.root}\0${entry.path}`;
const keyOf = entryKey;
// A quiet `absent` with a reason (no access yet) keeps its `since` too, so
// one can tell how long a declared repository has stayed unreadable.
const lasting = (entry: SyncEntry) =>
  entry.result !== "current" &&
  entry.result !== "fast-forwarded" &&
  entry.result !== "materialized" &&
  (entry.result !== "absent" || entry.reason !== undefined);

/** Which recorded entries a run's answers replace: all of them, those of
 * the Organizations it ran for, or only the repositories it answered (a run
 * for one repository). */
export type RecordScope =
  | Readonly<{ replace: "all" }>
  | Readonly<{ replace: "organizations"; organizations: readonly string[] }>
  | Readonly<{ replace: "answered" }>;

/** Whether an answer read the repository's remote: current, moved, cloned,
 * ahead or diverged. Anything else (blocked by the checkout's own state,
 * unavailable, failed, absent) leaves GitHub's last answer standing. */
export const readTheRemote = (entry: SyncEntry): boolean =>
  entry.result === "current" ||
  entry.result === "fast-forwarded" ||
  entry.result === "materialized" ||
  (entry.result === "blocked" &&
    (entry.reason === "ahead" || entry.reason === "diverged"));

/** Whether GitHub's last answer for a repository was a refusal: its
 * `denied`, or a later answer that never asked the remote after one. */
export const refusedLast = (entry: SyncEntry): boolean =>
  entry.result === "denied" || entry.unreadable === true;

export async function recordSync(
  lockDirectory: string,
  folder: string,
  entries: readonly SyncEntry[],
  scope: RecordScope,
  at: string,
): Promise<readonly SyncEntry[]> {
  const previous = (await readSyncRecord(lockDirectory, folder)) ?? [];
  const before = new Map(previous.map((entry) => [keyOf(entry), entry]));
  const answered = entries.map((raw) => {
    const last = before.get(keyOf(raw));
    // A refusal stands until a run reads the remote again (F67's addendum
    // of 2026-11-01): an answer that never asked it carries it on.
    const refused: SyncEntry =
      raw.result !== "denied" &&
      !readTheRemote(raw) &&
      last !== undefined &&
      refusedLast(last)
        ? Object.freeze({ ...raw, unreadable: true as const })
        : raw;
    // The trace stays while the slot stays absent; a clone ends it.
    const entry: SyncEntry =
      refused.result === "absent" &&
      refused.removed === undefined &&
      last?.removed !== undefined
        ? Object.freeze({ ...refused, removed: last.removed })
        : refused;
    if (!lasting(entry)) return entry;
    const since =
      last !== undefined &&
      last.result === entry.result &&
      last.reason === entry.reason
        ? (last.since ?? last.at)
        : entry.at;
    return Object.freeze({ ...entry, since });
  });
  const organizations =
    scope.replace === "organizations"
      ? new Set(scope.organizations.map((login) => login.toLowerCase()))
      : null;
  const answeredKeys = new Set(entries.map(keyOf));
  // A repository this run did not answer because its root stopped its
  // Organization (a root this run answered that did not end current or
  // moved) keeps a refusal: nothing read its remote since. Where the root
  // went on, a repository it did not answer is no longer declared and goes,
  // and so does one of an Organization this run did not look at.
  const stopped = new Set(
    entries
      .filter(
        (entry) =>
          entry.kind === "root" &&
          entry.result !== "current" &&
          entry.result !== "fast-forwarded",
      )
      .map((entry) => `${entry.organization.toLowerCase()}\0${entry.root}`),
  );
  const stoppedRoot = (entry: SyncEntry) =>
    stopped.has(`${entry.organization.toLowerCase()}\0${entry.root}`);
  const kept = previous
    .filter(
      (entry) =>
        (scope.replace === "all"
          ? false
          : organizations !== null
            ? !organizations.has(entry.organization.toLowerCase())
            : !answeredKeys.has(keyOf(entry))) ||
        (refusedLast(entry) &&
          !answeredKeys.has(keyOf(entry)) &&
          stoppedRoot(entry)),
    )
    // A first proof needs the next run's proof: a run that stopped at the
    // root gave none (decision F72).
    .map((entry) => {
      if (entry.removal === undefined || !stoppedRoot(entry)) return entry;
      const { removal: _, ...unmarked } = entry;
      return Object.freeze(unmarked);
    });
  const file = syncRecordFile(lockDirectory, folder);
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schema: recordSchema, folder, at, entries: [...kept, ...answered] })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await rename(temporary, file);
  return Object.freeze(answered);
}

/** The recorded answers that need someone (the doctor's `content-sync`):
 * every blocked checkout, and one that GitHub refused, did not answer or
 * failed for longer than `longMs`. A checkout that is merely behind is not
 * one: the next sweep fast-forwards it. */
export function syncFindings(
  entries: readonly SyncEntry[],
  now: Date,
  longMs = 24 * 60 * 60 * 1000,
): readonly SyncEntry[] {
  return entries.filter(
    (entry) =>
      entry.result === "blocked" ||
      ((entry.result === "denied" ||
        entry.result === "unavailable" ||
        entry.result === "failed") &&
        now.getTime() - Date.parse(entry.since ?? entry.at) >= longMs),
  );
}
