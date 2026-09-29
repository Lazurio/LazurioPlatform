import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import { type CheckoutReason, CheckoutRefused } from "./checkout-custody";
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

/** The bound of a file of the operator's checkout (decision F23): 1 MiB for a
 * declaration or a small input, 16 MiB for a lockfile, which grows with every
 * dependency. */
export const checkoutFileBytesMax = declarationBytesMax;
export const lockfileBytesMax = 16 * 1024 * 1024;
/** Lockfiles by name, wherever the install reads them. */
export const lockfileNames: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

/** The file rule over one `lstat`: type first, then owner, then size;
 * permission bits and link count never. */
export function checkoutFileRefusal(
  stat: Pick<Stats, "isFile" | "uid" | "size">,
  expectedUid: number,
  bytesMax: number = checkoutFileBytesMax,
): CheckoutReason | null {
  if (!stat.isFile()) return "declaration-not-regular";
  if (stat.uid !== expectedUid) return "declaration-owner";
  if (stat.size > bytesMax) return "declaration-too-large";
  return null;
}

// Caller must first establish a stable canonical owned parent directory.
// Bounded POSIX read of a file of the operator's own checkout (a module's or
// an Organization's declaration, or an install input of a module) under the
// checkout rule above; not an atomic multi-document snapshot.
export async function readCheckoutFileBytes(
  path: string,
  options: Readonly<{ expectedUid?: number; bytesMax?: number }> = {},
): Promise<Buffer> {
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined)
    throw new Error("Declaration owner unavailable");
  if (!Number.isSafeInteger(expectedUid) || expectedUid < 0)
    throw new Error("Invalid declaration owner");
  const bytesMax =
    options.bytesMax ??
    (lockfileNames.has(basename(path))
      ? lockfileBytesMax
      : checkoutFileBytesMax);
  return readStableFile(path, (stat) => {
    const reason = checkoutFileRefusal(stat, expectedUid, bytesMax);
    return reason === null ? null : new CheckoutRefused(reason, path);
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
