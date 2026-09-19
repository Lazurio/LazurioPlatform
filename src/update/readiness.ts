import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DurableWriter } from "./durable-file";
import { layout, parseVersionName } from "./layout";
import { sha256File } from "./stage";

/** Launchpad readiness contract (docs/update.md "Activate": readiness is
 * required "from a fresh instance ... that reports the expected artifact
 * digest"; "an old process answering, or a bare HTTP 200, proves nothing").
 *
 * A Launchpad that runs from `versions/<name>/lazurio` of an install base
 * writes `update/launchpad-readiness.json` once it is serving, and removes it
 * at a clean exit:
 *
 *   artifactSha256  SHA-256 of the bytes of its own executable, computed by
 *                   the Launchpad at start — a fact about what runs, not a
 *                   claim copied from a file next to it
 *   pid, startedAt  which process, and since when
 *
 * The activation worker accepts it only when the digest is the candidate's,
 * `startedAt` is later than the switch of the selector, the process is alive,
 * and all of that stays true for the stability period.
 */
export type LaunchpadReadiness = Readonly<{
  artifactSha256: string;
  startedAt: string;
  pid: number;
}>;

const readinessName = "launchpad-readiness.json";
export const readinessPath = (base: string) =>
  join(layout(base).update, readinessName);

function parseReadiness(value: unknown): LaunchpadReadiness | null {
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== 1 ||
    typeof record.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.artifactSha256) ||
    typeof record.startedAt !== "string" ||
    Number.isNaN(Date.parse(record.startedAt)) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 2
  )
    return null;
  return Object.freeze({
    artifactSha256: record.artifactSha256,
    startedAt: record.startedAt,
    pid: record.pid,
  });
}

/** Never throws: no file, a damaged file and a foreign file are all "nothing
 * is known to be ready".
 */
export async function readLaunchpadReadiness(
  base: string,
): Promise<LaunchpadReadiness | null> {
  try {
    return parseReadiness(
      JSON.parse(await readFile(readinessPath(base), "utf8")),
    );
  } catch {
    return null;
  }
}

/** Called by the Launchpad once it serves. Writes nothing — and returns null —
 * unless `executable` is a staged version of THIS base: a source run or a
 * development binary is not what an activation waits for.
 */
export async function announceLaunchpadReady(input: {
  base: string;
  executable: string;
  pid: number;
  startedAt: Date;
  write: DurableWriter;
}): Promise<(() => Promise<void>) | null> {
  // `process.execPath` is a real path; the base may be reached through a
  // symbolic link (a linked home directory), so compare real paths.
  const directory = dirname(input.executable);
  const versions = await realpath(layout(input.base).versions).catch(
    () => undefined,
  );
  if (
    versions === undefined ||
    (await realpath(dirname(directory)).catch(() => undefined)) !== versions ||
    !parseVersionName(directory.slice(dirname(directory).length + 1))
  )
    return null;
  const readiness: LaunchpadReadiness = {
    artifactSha256: await sha256File(input.executable),
    startedAt: input.startedAt.toISOString(),
    pid: input.pid,
  };
  // An installation that never updated has no `update/` yet.
  await mkdir(layout(input.base).update, { recursive: true, mode: 0o700 });
  await input.write(
    layout(input.base).update,
    readinessName,
    Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...readiness })}\n`),
  );
  return async () => {
    // Only this instance's announcement: a successor may already have
    // replaced it.
    const current = await readLaunchpadReadiness(input.base);
    if (current?.pid === input.pid && current.startedAt === readiness.startedAt)
      await rm(readinessPath(input.base), { force: true });
  };
}

export type ReadinessVerdict =
  | "ready"
  | "absent"
  | "wrong-artifact"
  | "stale-instance"
  | "not-running";

export function evaluateReadiness(input: {
  readiness: LaunchpadReadiness | null;
  expectedSha256: string;
  /** The selector was switched at this time; an instance that started before
   * it cannot be running the candidate because of this activation. */
  switchedAt: Date;
  pidAlive: (pid: number) => boolean;
}): ReadinessVerdict {
  const { readiness } = input;
  if (!readiness) return "absent";
  if (readiness.artifactSha256 !== input.expectedSha256)
    return "wrong-artifact";
  if (Date.parse(readiness.startedAt) < input.switchedAt.getTime())
    return "stale-instance";
  return input.pidAlive(readiness.pid) ? "ready" : "not-running";
}

/** "Stays healthy for a bounded stability period": the SAME instance must be
 * ready at every observation across the period. A crash loop — a new pid or
 * start time at each look — starts the period again and so never confirms.
 */
export function createStabilityTracker(stabilityMs: number) {
  let instance: string | undefined;
  let since = 0;
  return (
    now: number,
    verdict: ReadinessVerdict,
    readiness: LaunchpadReadiness | null,
  ): boolean => {
    if (verdict !== "ready" || !readiness) {
      instance = undefined;
      return false;
    }
    const observed = `${readiness.pid}@${readiness.startedAt}`;
    if (observed !== instance) {
      instance = observed;
      since = now;
    }
    return now - since >= stabilityMs;
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
