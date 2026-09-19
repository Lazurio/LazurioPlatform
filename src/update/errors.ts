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
  // 23 was `channel-rollback`: rollback of the channel document is refused by
  // TUF itself (`metadata-invalid`). 31 was `not-implemented`. Never reused.
  "channel-invalid": { exit: 24, retryable: true },
  "trust-missing": { exit: 25, retryable: false },
  "trust-conflict": { exit: 26, retryable: false },
  "trust-invalid": { exit: 27, retryable: false },
  "target-unsupported": { exit: 28, retryable: true },
  /** Another update step or a live activation worker owns the base. */
  busy: { exit: 29, retryable: true },
  "storage-unavailable": { exit: 30, retryable: true },
  /** A response exceeded the signed or configured length limit. */
  "response-too-large": { exit: 32, retryable: true },
  /** The filesystem of the base does not provide `flock`. */
  "lock-unsupported": { exit: 33, retryable: false },
  /** No `bin/lazurio` selector: there is no installation to update. */
  "not-installed": { exit: 34, retryable: false },
  "disk-full": { exit: 35, retryable: true },
  /** Received bytes differ from the signed length or digest. */
  "artifact-invalid": { exit: 36, retryable: true },
  /** The signed identity is malformed or names another target or version. */
  "identity-invalid": { exit: 37, retryable: true },
  /** The candidate cannot read the Folder state schemas in use. */
  "schema-incompatible": { exit: 38, retryable: true },
  /** The staged executable did not pass its self-check; nothing was staged. */
  "self-check-failed": { exit: 39, retryable: true },
  /** Not confirmed within the deadline; the previous version is selected. */
  "activation-failed": { exit: 40, retryable: true },
  /** The worker died; a later start rolled the activation back. */
  "activation-interrupted": { exit: 41, retryable: true },
  "rollback-unavailable": { exit: 42, retryable: false },
  internal: { exit: 70, retryable: false },
} as const satisfies Record<string, { exit: number; retryable: boolean }>;

export type UpdateErrorCode = keyof typeof updateErrors;

/** Exit statuses of the non-error outcomes. `update --check` exits 0 when up
 * to date and 10 when an update is available. `update`, `update
 * --download-only` and `update rollback` exit 0 when they did what was asked
 * (updated, staged, rolled back, or nothing to do) and otherwise the `exit` of
 * their error code above. `self-check` exits 0 or the `self-check-failed` code.
 */
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
