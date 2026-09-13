import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { snapshotOrganizationDocument } from "../organizations/document-hash";
import { readOwnedDeclarationBytes } from "../providers/owned-json";

const lockNames = ["bun.lock", "bun.lockb"] as const;
async function present(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

// Snapshot only, called with an explicitly resolved owner under the shared lock.
// Does NOT establish workspace membership, provider rights or install readiness.
// It never searches outside the selected checkout or chooses an ancestor fallback.
export async function inspectInstallAuthority(checkout: string, owner: string) {
  const checkoutStat = await inspectOwnedDirectory(checkout);
  const offset = relative(checkout, owner);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`))
    throw new Error("Install owner outside selected checkout");
  let parent = checkout;
  if (offset)
    for (const segment of offset.split(sep)) {
      parent = join(parent, segment);
      await inspectOwnedDirectory(parent);
    }
  const ownerStat = await inspectOwnedDirectory(owner);
  const packageBytes = await readOwnedDeclarationBytes(
    join(owner, "package.json"),
  );
  const pkg = snapshotOrganizationDocument(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        packageBytes,
      ),
    ),
  );
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
    throw new Error("Package object required");
  const manifest = pkg as Readonly<Record<string, unknown>>;
  // First reference contract pins the tested Bun version exactly, without silently
  // substituting the Platform build runtime for an app's declared toolchain.
  if (
    typeof manifest.packageManager !== "string" ||
    !/^bun@\d+\.\d+\.\d+$/.test(manifest.packageManager) ||
    /[\r\n]/.test(manifest.packageManager)
  )
    throw new Error("Exact Bun packageManager required");
  const locks: string[] = [];
  for (const name of lockNames)
    if (await present(join(owner, name))) locks.push(name);
  if (locks.length !== 1) throw new Error("One explicit Bun lockfile required");
  const lockfile = locks[0] as string;
  const lockBytes = await readOwnedDeclarationBytes(join(owner, lockfile));
  if (!lockBytes.length) throw new Error("Empty Bun lockfile");
  // The lock remains opaque here: only Bun may validate its actual syntax; no
  // regeneration or parsing as ordinary JSON (text locks can be JSONC).
  const snapshot = Object.freeze({
    checkout,
    owner,
    checkoutIdentity: `${checkoutStat.dev}:${checkoutStat.ino}`,
    ownerIdentity: `${ownerStat.dev}:${ownerStat.ino}`,
    packageDigest: digest(packageBytes),
    lockfile,
    lockDigest: digest(lockBytes),
    packageManager: manifest.packageManager,
    manifest,
  });
  const afterCheckout = await inspectOwnedDirectory(checkout);
  const afterOwner = await inspectOwnedDirectory(owner);
  if (
    `${afterCheckout.dev}:${afterCheckout.ino}` !== snapshot.checkoutIdentity ||
    `${afterOwner.dev}:${afterOwner.ino}` !== snapshot.ownerIdentity
  )
    throw new Error("Install owner changed");
  return snapshot;
}

export async function verifyInstallAuthority(
  expected: Awaited<ReturnType<typeof inspectInstallAuthority>>,
) {
  try {
    const current = await inspectInstallAuthority(
      expected.checkout,
      expected.owner,
    );
    return (
      current.checkoutIdentity === expected.checkoutIdentity &&
      current.ownerIdentity === expected.ownerIdentity &&
      current.packageDigest === expected.packageDigest &&
      current.lockfile === expected.lockfile &&
      current.lockDigest === expected.lockDigest
    );
  } catch {
    return false;
  }
}
