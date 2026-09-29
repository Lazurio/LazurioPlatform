import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { parseUniqueJson } from "./unique-json";

const declarationBytesMax = 1024 * 1024;

// Explicit custody boundary for root-issued Machine declarations. This checks
// bytes, not authority. The caller must establish the canonical parent custody.
export async function readCustodiedDeclarationBytes(
  path: string,
  expectedUid: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0)
    throw new Error("Invalid declaration owner");
  const safe = (stat: Stats) =>
    stat.isFile() &&
    stat.nlink === 1 &&
    stat.uid === expectedUid &&
    (stat.mode & 0o022) === 0 &&
    stat.size <= declarationBytesMax;
  return readStableFile(path, (stat) =>
    safe(stat) ? null : new Error("Unsafe declaration file"),
  );
}

/** Why a file of the operator's own checkout is refused (decision F23). The
 * checkout is the operator's: their Git and package manager write it under
 * their account, and GitHub decides who may change the Organization, so its
 * permission bits and link count are never a reason. What is refused is what
 * is not the operator's checkout file: not a regular file (a symlink, a
 * directory, a device), another account's file, or more than a declaration may
 * be. */
export const checkoutFileReasons = [
  "declaration-not-regular",
  "declaration-owner",
  "declaration-too-large",
] as const;
export type CheckoutFileReason = (typeof checkoutFileReasons)[number];

/** The rule itself, over one `lstat` of the file. */
export function checkoutFileRefusal(
  stat: Pick<Stats, "isFile" | "uid" | "size">,
  expectedUid: number,
): CheckoutFileReason | null {
  if (!stat.isFile()) return "declaration-not-regular";
  if (stat.uid !== expectedUid) return "declaration-owner";
  if (stat.size > declarationBytesMax) return "declaration-too-large";
  return null;
}

/** A file of the operator's checkout that the rule refuses. `path` is for the
 * caller to name the file relative to what it reads (`checkoutRefusal`); it
 * is never shown as is and is not part of the message. */
export class CheckoutFileRefused extends Error {
  readonly reason: CheckoutFileReason;
  readonly path: string;
  constructor(reason: CheckoutFileReason, path: string) {
    super(`Checkout file refused: ${reason}`);
    this.name = "CheckoutFileRefused";
    this.reason = reason;
    this.path = path;
  }
}

/** A refusal as a reason and a file name for output: relative to `base` (the
 * module or Organization directory), else below `home` as `~/…`, else the
 * file's own name. Never an absolute path; null for any other error. */
export function checkoutRefusal(
  error: unknown,
  base: string,
  home?: string,
): Readonly<{ reason: CheckoutFileReason; file: string }> | null {
  if (!(error instanceof CheckoutFileRefused)) return null;
  const below = (directory: string) => {
    const name = relative(directory, error.path);
    return name === "" ||
      isAbsolute(name) ||
      name === ".." ||
      name.startsWith(`..${sep}`)
      ? null
      : name.split(sep).join("/");
  };
  const inBase = below(base);
  const inHome = home === undefined ? null : below(home);
  const file =
    inBase ??
    (inHome === null ? null : `~/${inHome}`) ??
    error.path.split(sep).at(-1) ??
    "";
  return Object.freeze({ reason: error.reason, file });
}

// Caller must first establish a stable canonical owned parent directory.
// Bounded POSIX read of a file of the operator's own checkout (a module's or
// an Organization's declaration, or an install input of a module) under the
// checkout rule above; not an atomic multi-document snapshot.
export async function readCheckoutFileBytes(
  path: string,
  expectedUid: number | undefined = process.getuid?.(),
): Promise<Buffer> {
  if (expectedUid === undefined)
    throw new Error("Declaration owner unavailable");
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0)
    throw new Error("Invalid declaration owner");
  return readStableFile(path, (stat) => {
    const reason = checkoutFileRefusal(stat, expectedUid);
    return reason === null ? null : new CheckoutFileRefused(reason, path);
  });
}

export async function readCheckoutJson(path: string): Promise<unknown> {
  return parseUniqueJson(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readCheckoutFileBytes(path),
    ),
  ) as unknown;
}

// One bounded read of a file that `refuse` accepts, unchanged from the first
// `lstat` to the last: never through a symlink, never a file that grew,
// shrank, was replaced or changed during the read.
async function readStableFile(
  path: string,
  refuse: (stat: Stats) => Error | null,
): Promise<Buffer> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unqualified declaration reader platform");
  const before = await lstat(path);
  const refused = refuse(before);
  if (refused) throw refused;
  const safe = (stat: Stats) => refuse(stat) === null;
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Declaration changed before read");
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    if (
      !safe(after) ||
      !safe(named) ||
      count !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error("Declaration changed during read");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
