import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { snapshotOrganizationDocument } from "../organizations/document-hash";
import { readOwnedDeclarationBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import { inspectPatchInputs } from "./patch-inputs";
import { parseProcessLaunch } from "./process-launch";
import { inspectWorkspaceInputs } from "./workspace-inputs";

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
// Package/lock ownership never falls back to an ancestor. Configuration additionally
// covers only the explicit caller-supplied HOME/XDG roots, never ambient process.env.
// The caller must establish custody of these roots; hashes are internal evidence,
// not public output or a guarantee against hostile concurrent filesystem mutation.
export async function inspectInstallAuthority(
  checkout: string,
  owner: string,
  environment?: Readonly<Record<string, string>>,
) {
  const env =
    environment === undefined
      ? null
      : parseProcessLaunch({
          executable: "/unused",
          cwd: owner,
          args: [],
          env: environment,
        }).env;
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
  const configuration: Record<string, string | null> = {};
  if (env) {
    if (!env.HOME || !isAbsolute(env.HOME))
      throw new Error("Explicit configuration home required");
    for (const name of Object.keys(env))
      if (
        ["npm_config_userconfig", "npm_config_globalconfig"].includes(
          name.toLowerCase(),
        )
      )
        throw new Error("Custom npm configuration path is not qualified");
    for (const directory of new Set([
      env.HOME,
      ...(env.XDG_CONFIG_HOME ? [env.XDG_CONFIG_HOME] : []),
    ])) {
      if (!isAbsolute(directory))
        throw new Error("Explicit configuration directory required");
      const identity = await inspectOwnedDirectory(directory);
      configuration[`directory:${directory}`] =
        `${identity.dev}:${identity.ino}`;
      for (const name of [".npmrc", ".bunfig.toml"]) {
        const path = join(directory, name);
        configuration[`global:${path}`] = (await present(path))
          ? digest(await readOwnedDeclarationBytes(path))
          : null;
      }
    }
  }
  let configDirectory = checkout;
  for (const segment of ["", ...(offset ? offset.split(sep) : [])]) {
    if (segment) configDirectory = join(configDirectory, segment);
    for (const name of [".npmrc", "bunfig.toml"]) {
      const path = join(configDirectory, name);
      configuration[relative(checkout, path)] = (await present(path))
        ? digest(await readOwnedDeclarationBytes(path))
        : null;
    }
  }
  const packageBytes = await readOwnedDeclarationBytes(
    join(owner, "package.json"),
  );
  const pkg = snapshotOrganizationDocument(
    parseUniqueJson(
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
    workspaceInputs: await inspectWorkspaceInputs(owner, manifest.workspaces),
    patchInputs: await inspectPatchInputs(owner, manifest.patchedDependencies),
    configuration: Object.freeze(configuration),
    environment: env,
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
      expected.environment ?? undefined,
    );
    return (
      current.checkoutIdentity === expected.checkoutIdentity &&
      current.ownerIdentity === expected.ownerIdentity &&
      current.packageDigest === expected.packageDigest &&
      current.lockfile === expected.lockfile &&
      current.lockDigest === expected.lockDigest &&
      JSON.stringify(current.workspaceInputs) ===
        JSON.stringify(expected.workspaceInputs) &&
      JSON.stringify(current.patchInputs) ===
        JSON.stringify(expected.patchInputs) &&
      JSON.stringify(current.configuration) ===
        JSON.stringify(expected.configuration)
    );
  } catch {
    return false;
  }
}
