import { isAbsolute, relative, sep } from "node:path";

// The checkout rule of decision F23: the operator's own checkout (the
// Organization root and its documents, the modules, their apps, install
// inputs and dependency trees, the Personalspace's modules) is read by
// ownership, type and size. The operator's Git and package manager write it
// under the operator's account and GitHub decides who may change the
// Organization, so permission bits and link counts are never a reason to
// refuse it. What the product, root or the system writes keeps its strict
// rules (`readCustodiedDeclarationBytes`, `inspectOwnedDirectory`).

/** Why a file or directory of the operator's checkout is refused. */
export const checkoutReasons = [
  /** A file that is not a regular file: a symlink, a directory, a device. */
  "declaration-not-regular",
  /** A file another account owns. */
  "declaration-owner",
  /** A file larger than its bound (1 MiB; 16 MiB for a lockfile). */
  "declaration-too-large",
  /** A directory that is not a real directory: a symlink, a file, or a path
   * through a symlink. */
  "directory-not-regular",
  /** A directory another account owns. */
  "directory-owner",
] as const;
export type CheckoutReason = (typeof checkoutReasons)[number];

/** A file or directory of the operator's checkout that the rule refuses.
 * `path` is for the caller to name it relative to what it reads
 * (`checkoutRefusal`); it is never shown as is and is not in the message. */
export class CheckoutRefused extends Error {
  readonly reason: CheckoutReason;
  readonly path: string;
  constructor(reason: CheckoutReason, path: string) {
    super(`Checkout path refused: ${reason}`);
    this.name = "CheckoutRefused";
    this.reason = reason;
    this.path = path;
  }
}

/** A refusal as a reason and a path for output: relative to the first of
 * `bases` that holds it (the module, then the Organization root; `.` for a
 * base itself), else below `home` as `~/…`, else the last name. Never an
 * absolute path; null for any other error. */
export function checkoutRefusal(
  error: unknown,
  bases: string | readonly string[],
  home?: string,
): Readonly<{ reason: CheckoutReason; file: string }> | null {
  if (!(error instanceof CheckoutRefused)) return null;
  return Object.freeze({
    reason: error.reason,
    file: refusedFileName(error.path, bases, home),
  });
}

/** A refused path as output names it: relative to the first of `bases` that
 * holds it (`.` for a base itself), else below `home` as `~/…`, else its last
 * name. Never absolute. */
export function refusedFileName(
  path: string,
  bases: string | readonly string[],
  home?: string,
): string {
  const below = (directory: string) => {
    const name = relative(directory, path);
    if (name === "") return ".";
    return isAbsolute(name) || name === ".." || name.startsWith(`..${sep}`)
      ? null
      : name.split(sep).join("/");
  };
  for (const base of typeof bases === "string" ? [bases] : bases) {
    const name = below(base);
    if (name !== null) return name;
  }
  const inHome = home === undefined ? null : below(home);
  return inHome !== null && inHome !== "."
    ? `~/${inHome}`
    : (path.split(sep).filter(Boolean).at(-1) ?? ".");
}
