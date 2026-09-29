import { refusedFileName } from "../providers/checkout-custody";

// Why a module's preparation cannot run (decision F25): a closed set of
// reasons, each with the package or lockfile it concerns, instead of the
// `operation-failed` a throw without a reason becomes. The first seven are
// known without running anything, so the catalog reports them as well; the
// last two only the start can know.

export const preparationReasons = [
  /** The preparation owner's package.json is missing, is not a package
   * object, or the application is not a declared member of its workspace. */
  "preparation-owner-invalid",
  /** The declared check or prepare script is not a script of the owner. */
  "preparation-script-missing",
  /** No Bun lockfile (`bun.lock`, `bun.lockb`) beside the owner's
   * package.json, or an empty one. */
  "preparation-lockfile-missing",
  /** Both `bun.lock` and `bun.lockb`: which one installs is not guessed. */
  "preparation-lockfile-ambiguous",
  /** `packageManager` names something other than an exact Bun version. */
  "preparation-package-manager-unsupported",
  /** A workspace owner or member: its install inputs are not qualified. */
  "preparation-workspace-unqualified",
  /** A local `file:` dependency outside the owner's directory. */
  "preparation-dependency-outside-owner",
  /** The owner pins an exact Bun (`packageManager`) the operator's Bun is
   * not. */
  "preparation-toolchain-mismatch",
  /** The frozen install from the lockfile failed (for example, the lockfile
   * no longer matches the package, or a dependency cannot be fetched). */
  "preparation-install-failed",
] as const;
export type PreparationReason = (typeof preparationReasons)[number];

/** A preparation that cannot run for a known reason. `path` is the absolute
 * package or lockfile it concerns, for the caller to name relative to the
 * module (`preparationRefusal`); the message is never shown. */
export class PreparationRefused extends Error {
  readonly reason: PreparationReason;
  readonly path: string;
  constructor(reason: PreparationReason, path: string, message: string) {
    super(message);
    this.name = "PreparationRefused";
    this.reason = reason;
    this.path = path;
  }
}

/** A refusal as a reason and a file for output, relative to the first of
 * `bases` that holds it; null for any other error. */
export function preparationRefusal(
  error: unknown,
  bases: string | readonly string[],
): Readonly<{ reason: PreparationReason; file: string }> | null {
  if (!(error instanceof PreparationRefused)) return null;
  return Object.freeze({
    reason: error.reason,
    file: refusedFileName(error.path, bases),
  });
}
