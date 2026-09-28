import type { ErrorContext } from "../update/errors";

/** The checks of `lazurio recover` (proposed decision F21,
 * docs/recovery-mode.md C.1; what exists: docs/recovery.md). Every check
 * answers with the same shape: a stable id, the rule of C.1 it implements when
 * it is one, and an outcome. Ids and codes are a contract for automation and
 * the issue fingerprint: never renamed or reused, prose is never parsed.
 *
 * This slice evaluates what needs no change of the updater or the Launchpad:
 * R2 and R5, and three observations that are evidence for the rules the later
 * slices add (R1 `start-refused`, R3 `activation-unhealthy`, R4
 * `launchpad-not-running`). Those add an id and their codes here and a
 * priority below; the shape of a check does not change.
 */
export const recoveryCheckIds = [
  /** R2: update state no crash can produce. */
  "update-state-invalid",
  /** The Folder's state cannot be read by this version (R1's cause). */
  "folder-state",
  /** R5: the ACTIVE executable fails its own self-check. */
  "self-check-failed",
  /** The supervised Launchpad unit, as the user service manager sees it. */
  "launchpad-unit",
  /** The supervised Launchpad's answer on its health socket. */
  "launchpad-health",
] as const;
export type RecoveryCheckId = (typeof recoveryCheckIds)[number];

export type RecoveryRule = "R1" | "R2" | "R3" | "R4" | "R5";

/** Stable codes of a failed check. */
export const recoveryCodes = [
  "state-invalid",
  "folder-state-absent",
  "folder-state-pending",
  "folder-state-unrecognized",
  "folder-state-unreadable",
  "self-check-failed",
  "unit-not-loaded",
  "unit-failed",
  "unit-restarting",
  "unit-inactive",
  "launchpad-not-answering",
  "launchpad-version-mismatch",
  "launchpad-recovery-mode",
  /** A check could not be evaluated for a reason the product did not expect. */
  "internal",
] as const;
export type RecoveryCode = (typeof recoveryCodes)[number];

/** Why a check was not evaluated here. Skipped is never "broken". */
export const skipReasons = [
  "not-installed",
  "no-folder",
  "not-supervised",
  "no-user-manager",
  "user-manager-unreachable",
  "unit-state-unknown",
] as const;
export type SkipReason = (typeof skipReasons)[number];

export type RecoveryCheck = Readonly<
  {
    id: RecoveryCheckId;
    rule: RecoveryRule | null;
  } & (
    | { outcome: "ok"; context: ErrorContext }
    | { outcome: "failed"; code: RecoveryCode; context: ErrorContext }
    | { outcome: "skipped"; reason: SkipReason }
  )
>;

const rules: Readonly<Record<RecoveryCheckId, RecoveryRule | null>> = {
  "update-state-invalid": "R2",
  "folder-state": null,
  "self-check-failed": "R5",
  "launchpad-unit": null,
  "launchpad-health": null,
};

export const ok = (
  id: RecoveryCheckId,
  context: ErrorContext = {},
): RecoveryCheck =>
  Object.freeze({
    id,
    rule: rules[id],
    outcome: "ok" as const,
    context: Object.freeze({ ...context }),
  });

export const failed = (
  id: RecoveryCheckId,
  code: RecoveryCode,
  context: ErrorContext = {},
): RecoveryCheck =>
  Object.freeze({
    id,
    rule: rules[id],
    outcome: "failed" as const,
    code,
    context: Object.freeze({ ...context }),
  });

export const skipped = (
  id: RecoveryCheckId,
  reason: SkipReason,
): RecoveryCheck =>
  Object.freeze({ id, rule: rules[id], outcome: "skipped" as const, reason });

/** The check an issue is about when several fail: the one closest to the
 * cause. Unreadable update state also fails the self-check; an unreadable
 * Folder also fails the self-check and stops the Launchpad; a failing
 * self-check explains a unit that does not stay up. */
export const checkPriority: readonly RecoveryCheckId[] = recoveryCheckIds;

export type FailedCheck = Extract<RecoveryCheck, { outcome: "failed" }>;

export function primaryFailure(
  checks: readonly RecoveryCheck[],
): FailedCheck | null {
  for (const id of checkPriority) {
    const check = checks.find((entry) => entry.id === id);
    if (check?.outcome === "failed") return check;
  }
  return null;
}

/** The one value of a failed check's context that tells two faults of the
 * same check apart, for the fingerprint. */
export function checkDetail(check: FailedCheck): string {
  const { context } = check;
  const detail = context.reason ?? context.path ?? context.stage;
  return detail === undefined ? "" : String(detail);
}
