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
  try {
    await service.restartLaunchpad();
  } catch {
    return "restart-failed";
  }
  return (await waitForLaunchpad(service, seams.version, {
    deadlineMs: seams.deadlineMs,
  }))
    ? "restarted"
    : "restart-failed";
}
