/** The ONE place that defines update error codes (docs/update.md "Surfaces").
 * They are a contract for automation, the Launchpad pill and outside
 * observers: a code is never renamed or reused, prose is never parsed.
 */
export const updateErrorCodes = [
  "network-unavailable",
  /** The release is malformed or contradicts itself: manifest, tag, size,
   * digest, or an exact version below the floor. */
  "release-invalid",
  "attestation-invalid",
  /** Sigstore's trust root is neither cached nor reachable. */
  "trust-unavailable",
  "target-unsupported",
  /** The release needs a newer updater than the installed one. */
  "reinstall-required",
  "busy",
  "storage-unavailable",
  "disk-full",
  "not-installed",
  "self-check-failed",
  "activation-failed",
  "rollback-unavailable",
  /** Update state that no crash can produce. Never cleared, rewritten or
   * guessed: mutating commands refuse, naming the path, until a person acts. */
  "state-invalid",
  "internal",
] as const;
export type UpdateErrorCode = (typeof updateErrorCodes)[number];

/** The four exit statuses. Every failure, and `busy`, is 1: automation reads
 * the code from `--json`, never from the status.
 */
export const exitOk = 0;
export const exitFailure = 1;
export const exitUsage = 2;
export const exitUpdateAvailable = 10;

/** Context is flat, small and free of paths, URLs, raw filesystem errors and
 * prose: it may be read by an outside observer.
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

/** A filesystem error as a typed failure; the errno name is safe to show. */
export function storageFailure(error: unknown, stage: string): UpdateFailure {
  if (error instanceof UpdateFailure) return error;
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (errno === "ENOSPC" || errno === "EDQUOT")
    return new UpdateFailure("disk-full", { stage });
  return new UpdateFailure("storage-unavailable", {
    stage,
    ...(typeof errno === "string" && /^E[A-Z]+$/.test(errno) ? { errno } : {}),
  });
}
