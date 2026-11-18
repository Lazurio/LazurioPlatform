import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readStartState } from "../launchpad/start-check";
import {
  type ServiceControl,
  waitForLaunchpad,
} from "../update/service-control";

/** The running Launchpad reads its entry (decision F16) once, when it starts
 * (`readStartState`), so a handover entry that `machine folder-refresh`
 * records reaches it only through a restart. Without one, a gateway route the
 * handover gained (the Environment browser of F38, MausBot, a module origin)
 * stays unknown to the Launchpad until something else restarts it. After a
 * refresh that records a different entry, the supervised Launchpad of this
 * Folder restarts the way an update activation restarts it: modules, T3 Code
 * and Codex keep running (docs/machine-handover.md "Refresh after a handover
 * rewrite"). */
export type LaunchpadEntryRestart =
  | "restarted"
  | "restart-failed"
  | "not-supervised";

/** Where the refresh asks for the Launchpad of this install base. */
export type LaunchpadSeams = Readonly<{
  /** The installer's unit of this base, null where none supervises it. */
  service: () => Promise<ServiceControl | null>;
  /** Where a restart still owed is kept (layout launchpadRestartOwed);
   * absent, none is kept. */
  owed?: string | undefined;
  /** The version the restarted Launchpad must report: the active one. */
  version: string;
  deadlineMs?: number | undefined;
}>;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              canonical((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;

/** The digest of an entry in its canonical form, as the running Launchpad
 * reports the one it started with (its health answer's `entry`): "none"
 * without one. */
export function entryDigest(entry: unknown): string {
  return entry === null || entry === undefined
    ? "none"
    : createHash("sha256")
        .update(JSON.stringify(canonical(entry)))
        .digest("hex");
}

/** The entry the Folder records, as the Launchpad would read it at start, in
 * one canonical form; null where there is none or the state is unreadable. */
export async function recordedEntry(folder: string): Promise<string | null> {
  try {
    const { entry } = await readStartState(folder, { locked: false });
    return entry === null ? null : JSON.stringify(canonical(entry));
  } catch {
    return null;
  }
}

/** Whether a restart of `folder`'s Launchpad is still owed: a refresh
 * recorded an entry and the restart on it failed. Unreadable is not owed. */
export async function restartOwedFor(
  path: string | undefined,
  folder: string,
): Promise<boolean> {
  if (path === undefined) return false;
  try {
    const owed = JSON.parse(await readFile(path, "utf8")) as {
      folder?: unknown;
    };
    return owed.folder === folder;
  } catch {
    return false;
  }
}

/** Keep, or clear, the restart owed for `folder`: written atomically,
 * owner-only, in the install base's own update directory. */
export async function recordRestartOwed(
  path: string | undefined,
  folder: string,
  owed: boolean,
): Promise<void> {
  if (path === undefined) return;
  if (!owed) {
    if (await restartOwedFor(path, folder)) await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ folder })}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

/** The digest of the entry the Folder records (`entryDigest`), "none"
 * without one; null where the state is unreadable. */
export async function recordedEntryDigest(
  folder: string,
): Promise<string | null> {
  try {
    const { entry } = await readStartState(folder, { locked: false });
    return entryDigest(entry);
  } catch {
    return null;
  }
}

/** Restart the supervised Launchpad of `folder` and wait until it answers
 * with the active version. Only the installer's unit of this base that starts
 * THIS Folder is restarted; any other unit, or none, is `not-supervised` and
 * the Launchpad picks the entry up at its next start. */
export async function restartLaunchpadForEntry(
  folder: string,
  seams: LaunchpadSeams,
): Promise<LaunchpadEntryRestart> {
  const service = await seams.service().catch(() => null);
  if (service === null || service.folder !== folder) return "not-supervised";
  // The Folder already holds the new entry: no failure past this point may
  // turn the refresh into an operation failure, a rejected health probe
  // included (as in the update activation).
  const healthy = await service
    .restartLaunchpad()
    .then(() =>
      waitForLaunchpad(service, seams.version, {
        deadlineMs: seams.deadlineMs,
      }),
    )
    .catch(() => false);
  return healthy ? "restarted" : "restart-failed";
}
