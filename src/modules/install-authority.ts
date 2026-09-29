import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { snapshotOrganizationDocument } from "../organizations/document-hash";
import { readCheckoutFileBytes } from "../providers/owned-json";
import { parseUniqueJson } from "../providers/unique-json";
import {
  inspectDirectLocalDependencies,
  inspectLocalDependencyInputs,
} from "./local-dependency-inputs";
import { inspectPatchInputs } from "./patch-inputs";
import {
  type PreparationReason,
  PreparationRefused,
} from "./preparation-refusal";
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

// The selected checkout and every directory down to the owner, under the
// checkout rule (decision F23); the owner never lies outside the checkout.
export async function inspectOwnerDirectories(checkout: string, owner: string) {
  const checkoutStat = await inspectCheckoutDirectory(checkout);
  const offset = relative(checkout, owner);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`))
    throw new Error("Install owner outside selected checkout");
  let parent = checkout;
  if (offset)
    for (const segment of offset.split(sep)) {
      parent = join(parent, segment);
      await inspectCheckoutDirectory(parent);
    }
  const ownerStat = await inspectCheckoutDirectory(owner);
  return { checkoutStat, ownerStat, offset };
}

/** The owner's package and which lockfile beside it installs: what the
 * install authority snapshots and a read-only check of the preparation (the
 * catalog) can know without the rest of the snapshot (decision F25). The
 * caller has inspected the owner's directories. Each refusal names the
 * owner's package.json. */
export async function readInstallOwner(owner: string) {
  const packagePath = join(owner, "package.json");
  const refused = (reason: PreparationReason, message: string) =>
    new PreparationRefused(reason, packagePath, message);
  let packageBytes: Buffer;
  try {
    packageBytes = await readCheckoutFileBytes(packagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw refused("preparation-owner-invalid", "Owner package required");
    throw error;
  }
  const pkg = snapshotOrganizationDocument(
    parseUniqueJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        packageBytes,
      ),
    ),
  );
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
    throw refused("preparation-owner-invalid", "Package object required");
  const manifest = pkg as Readonly<Record<string, unknown>>;
  // A package that pins its Bun gets exactly that Bun, never the Platform
  // build runtime substituted for it. A package that names none installs
  // and runs with the operator's Bun, whichever version it is (F25).
  const declared = Object.hasOwn(manifest, "packageManager")
    ? manifest.packageManager
    : undefined;
  if (
    declared !== undefined &&
    (typeof declared !== "string" ||
      !/^bun@\d+\.\d+\.\d+$/.test(declared) ||
      /[\r\n]/.test(declared))
  )
    throw refused(
      "preparation-package-manager-unsupported",
      "Exact Bun packageManager required",
    );
  const packageManager = declared ?? null;
  const locks: string[] = [];
  for (const name of lockNames)
    if (await present(join(owner, name))) locks.push(name);
  if (locks.length > 1)
    throw refused(
      "preparation-lockfile-ambiguous",
      "One explicit Bun lockfile required",
    );
  const lockfile = locks[0];
  if (lockfile === undefined || (await lstat(join(owner, lockfile))).size === 0)
    throw refused(
      "preparation-lockfile-missing",
      "One explicit Bun lockfile required",
    );
  inspectDirectLocalDependencies(owner, manifest);
  return Object.freeze({
    owner,
    packageBytes,
    manifest,
    packageManager,
    lockfile,
  });
}

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
  const { checkoutStat, ownerStat, offset } = await inspectOwnerDirectories(
    checkout,
    owner,
  );
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
      const identity = await inspectCheckoutDirectory(directory);
      configuration[`directory:${directory}`] =
        `${identity.dev}:${identity.ino}`;
      for (const name of [".npmrc", ".bunfig.toml"]) {
        const path = join(directory, name);
        configuration[`global:${path}`] = (await present(path))
          ? digest(await readCheckoutFileBytes(path))
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
        ? digest(await readCheckoutFileBytes(path))
        : null;
    }
  }
  const { packageBytes, manifest, packageManager, lockfile } =
    await readInstallOwner(owner);
  const lockBytes = await readCheckoutFileBytes(join(owner, lockfile));
  if (!lockBytes.length)
    throw new PreparationRefused(
      "preparation-lockfile-missing",
      join(owner, "package.json"),
      "Empty Bun lockfile",
    );
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
    packageManager,
    manifest,
    workspaceInputs: await inspectWorkspaceInputs(owner, manifest.workspaces),
    patchInputs: await inspectPatchInputs(owner, manifest.patchedDependencies),
    localDependencyInputs: await inspectLocalDependencyInputs(owner, manifest),
    configuration: Object.freeze(configuration),
    environment: env,
  });
  const afterCheckout = await inspectCheckoutDirectory(checkout);
  const afterOwner = await inspectCheckoutDirectory(owner);
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
      JSON.stringify(current.localDependencyInputs) ===
        JSON.stringify(expected.localDependencyInputs) &&
      JSON.stringify(current.configuration) ===
        JSON.stringify(expected.configuration)
    );
  } catch {
    return false;
  }
}
