import type { MessageKey } from "./messages";
import type { PillStatus } from "./update-pill";

/** What the browser shows for one pill status: pure, so it is testable
 * without a DOM. Text comes from the messages; values are filled in here.
 */
export function fill(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] as string) : match,
  );
}

/** "<1 min", "12 min", "3 h", "2 d": coarse on purpose, an age not a clock. */
export function checkAge(checkedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(checkedAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / (24 * 60))} d`;
}

export type PillView = Readonly<{
  text: string;
  notesUrl: string | null;
  /** The one button, when there is one; the restart is said, not clicked. */
  action: Readonly<{ label: string; version: string }> | null;
  checked: string;
  stale: boolean;
  error: string | null;
  stateInvalid: string | null;
}>;

export function pillView(
  status: PillStatus,
  copy: Readonly<Record<MessageKey, string>>,
  now: number,
): PillView {
  const key: MessageKey =
    status.state === "checking"
      ? "updateChecking"
      : status.state === "downloading"
        ? "updateDownloading"
        : status.state === "activating"
          ? status.restartRequired
            ? "updateRestart"
            : "updateActivating"
          : status.state === "available"
            ? "updateAvailable"
            : status.latest === null
              ? "updateUnknown"
              : "updateIdle";
  const values = {
    running: status.running,
    latest: status.latest ?? "",
    active: status.active ?? "",
  };
  const label =
    status.action === "update"
      ? copy.updateAction
      : status.action === "retry"
        ? copy.updateRetry
        : null;
  return Object.freeze({
    text: fill(copy[key], values),
    notesUrl: status.notesUrl,
    action:
      label !== null && status.latest !== null
        ? Object.freeze({ label, version: status.latest })
        : null,
    checked:
      status.checkedAt === null
        ? copy.updateNeverChecked
        : fill(status.stale ? copy.updateStale : copy.updateChecked, {
            age: checkAge(status.checkedAt, now),
          }),
    stale: status.stale,
    error:
      status.error === null
        ? null
        : fill(copy.updateFailed, { code: status.error.code }),
    stateInvalid:
      status.stateInvalid === null
        ? null
        : fill(copy.updateStateInvalid, { path: status.stateInvalid }),
  });
}
