import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type CheckoutReason,
  CheckoutRefused,
} from "../providers/checkout-custody";

// Caller-controlled stable local directories only. Not a sandbox against an
// adversary able to replace ancestor directories or act as the same OS user.
export async function inspectOwnedDirectory(directory: string) {
  if (
    !isAbsolute(directory) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("Canonical owned directory required");
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    !process.getuid ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error("Caller-owned non-shared directory required");
  return stat;
}

// ONE canonical spelling of an owned directory, for every identity derived from
// its path (unit names, lock files). Lexically equivalent spellings such as
// `/a/org/../org` normalize to the same string; a symlinked spelling is refused
// by the inspection above, exactly as everywhere else.
export async function canonicalOwnedDirectory(directory: string) {
  await inspectOwnedDirectory(directory);
  return resolve(directory);
}

/** The directory rule of the operator's own checkout (decision F23), over
 * one `lstat`: a real directory owned by the operator. Group or world write
 * bits are not a reason: Git under a umask `002` creates `0775`. */
export function checkoutDirectoryRefusal(
  stat: Pick<Stats, "isDirectory" | "uid">,
  expectedUid: number,
): CheckoutReason | null {
  if (!stat.isDirectory()) return "directory-not-regular";
  if (stat.uid !== expectedUid) return "directory-owner";
  return null;
}

// A directory of the operator's own checkout: the Organization root and
// `organizations/`, `workspace/`, a module and its app, dependency and patch
// directories, a dependency tree, the Personalspace and its modules, the
// account's configuration directories. Canonical (no symlink on the way) and
// real, owned by the operator; a refusal is a typed `CheckoutRefused`. The
// Folder itself, its state, the install base, the handover and runtime
// directories keep `inspectOwnedDirectory`. Not a sandbox against the same
// account replacing ancestors.
export async function inspectCheckoutDirectory(directory: string) {
  if (!isAbsolute(directory))
    throw new Error("Canonical owned directory required");
  const stat = await lstat(directory);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Directory owner unavailable");
  // A symlink is never a directory of the checkout, also when it dangles
  // (its target is not resolved at all).
  const refused =
    stat.isSymbolicLink() || (await realpath(directory)) !== resolve(directory)
      ? "directory-not-regular"
      : checkoutDirectoryRefusal(stat, uid);
  if (refused !== null) throw new CheckoutRefused(refused, directory);
  return stat;
}

/** `canonicalOwnedDirectory` of a directory of the operator's checkout. */
export async function canonicalCheckoutDirectory(directory: string) {
  await inspectCheckoutDirectory(directory);
  return resolve(directory);
}
