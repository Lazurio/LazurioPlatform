/** The ONE place that defines update error codes. They are a contract for
 * automation, the Launchpad pill and fleet observers (docs/update.md
 * "Surfaces"): a code is never renamed or reused, prose is never parsed.
 *
 * `exit` is the process status of the CLI; `retryable` feeds `canRetry` in the
 * observation: true when the same action can succeed once an OUTSIDE condition
 * (network, publisher, disk, another operation) changes, without manual repair.
 */
export const updateErrors = {
  "invalid-request": { exit: 2, retryable: false },
  "network-unavailable": { exit: 20, retryable: true },
  "metadata-expired": { exit: 21, retryable: true },
  "metadata-invalid": { exit: 22, retryable: true },
  "channel-rollback": { exit: 23, retryable: true },
  "channel-invalid": { exit: 24, retryable: true },
  "trust-missing": { exit: 25, retryable: false },
  "trust-conflict": { exit: 26, retryable: false },
  "trust-invalid": { exit: 27, retryable: false },
  "target-unsupported": { exit: 28, retryable: true },
  busy: { exit: 29, retryable: true },
  "storage-unavailable": { exit: 30, retryable: true },
  "not-implemented": { exit: 31, retryable: false },
  /** Authentic metadata that goes BELOW the floor vector: a lower version, the
   * same version with other signed content, a lowered snapshot reference or
   * `snapshot.meta` entry. Nothing but a valid root chain was kept. Retryable
   * in the sense of this table — it ends when the repository (or whoever
   * stands in front of it) serves metadata at or above the floors again, with
   * no repair on the Machine — but it is a security signal: watch the CODE. */
  "metadata-rollback": { exit: 47, retryable: true },
  internal: { exit: 70, retryable: false },
} as const satisfies Record<string, { exit: number; retryable: boolean }>;

export type UpdateErrorCode = keyof typeof updateErrors;

/** Exit statuses for the two non-error outcomes of a check. */
export const exitUpToDate = 0;
export const exitUpdateAvailable = 10;

/** Context is flat, small and free of paths, URLs with credentials, raw
 * filesystem errors and localized prose: it may be read by a fleet observer.
 */
export type ErrorContext = Readonly<Record<string, string | number | boolean>>;

export type UpdateError = Readonly<{
  code: UpdateErrorCode;
  context: ErrorContext;
}>;

export function updateError(
  code: UpdateErrorCode,
  context: ErrorContext = {},
): UpdateError {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

/** Expected failures travel as values; this carrier exists only so deep
 * helpers can abort with a typed error that the use case converts back.
 */
export class UpdateFailure extends Error {
  readonly failure: UpdateError;
  constructor(code: UpdateErrorCode, context: ErrorContext = {}) {
    super(code);
    this.failure = updateError(code, context);
  }
}

export function isUpdateErrorCode(value: unknown): value is UpdateErrorCode {
  return typeof value === "string" && Object.hasOwn(updateErrors, value);
}
