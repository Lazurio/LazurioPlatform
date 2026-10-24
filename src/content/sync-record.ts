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
  | "fast-forwarded"
  | "current"
  | "blocked"
  | "absent"
  | "denied"
  | "unavailable"
  | "failed";

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
  /** Since when the repository gives this same answer without interruption,
   * for every answer but `current`, `fast-forwarded` and `absent`. */
  since?: string;
}>;

// ---- The record -------------------------------------------------------------

// The last answer per repository, beside the content lock in the install
// base (`<base>/content/sync-<digest of the Folder>.json`), so the CLI, the
// doctor and the Launchpad read the same: written whole by a rename, under
// the content lock, by the run that answered. A run for one Organization
// replaces that Organization's entries only, a run for one repository that
// repository's, a run for all of them the record. Coordination and
// visibility only: nothing decides on it.

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
  "fast-forwarded",
  "current",
  "blocked",
  "absent",
  "denied",
  "unavailable",
  "failed",
];
const text = (value: unknown) => typeof value === "string";

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
    (entry.since === undefined || text(entry.since))
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

const keyOf = (entry: SyncEntry) =>
  `${entry.organization.toLowerCase()}\0${entry.root}\0${entry.path}`;
const lasting = (result: SyncResult) =>
  result !== "current" && result !== "fast-forwarded" && result !== "absent";

/** Which recorded entries a run's answers replace: all of them, those of
 * the Organizations it ran for, or only the repositories it answered (a run
 * for one repository). */
export type RecordScope =
  | Readonly<{ replace: "all" }>
  | Readonly<{ replace: "organizations"; organizations: readonly string[] }>
  | Readonly<{ replace: "answered" }>;

export async function recordSync(
  lockDirectory: string,
  folder: string,
  entries: readonly SyncEntry[],
  scope: RecordScope,
  at: string,
): Promise<readonly SyncEntry[]> {
  const previous = (await readSyncRecord(lockDirectory, folder)) ?? [];
  const before = new Map(previous.map((entry) => [keyOf(entry), entry]));
  const answered = entries.map((entry) => {
    const last = before.get(keyOf(entry));
    if (!lasting(entry.result)) return entry;
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
  const kept = previous.filter((entry) =>
    scope.replace === "all"
      ? false
      : organizations !== null
        ? !organizations.has(entry.organization.toLowerCase())
        : !answeredKeys.has(keyOf(entry)),
  );
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
