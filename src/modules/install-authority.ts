import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { snapshotOrganizationDocument } from "../organizations/document-hash";
import { CheckoutRefused } from "../providers/checkout-custody";
import {
  CheckoutFileUnsettled,
  checkoutFileRefusal,
  lockfileBytesMax,
  readCheckoutFileBytes,
} from "../providers/owned-json";
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

// The members of a package that give its install something to do (issue
// #253): the packages it declares (dependencies of every kind; Bun installs
// devDependencies, optionalDependencies and peerDependencies by default) and
// what applies to them: overrides and resolutions, catalogs, patches,
// bundling, trusted lifecycle scripts. Without a declared package Bun 1.4.2
// installs nothing for most of them, but it reads the patch files of
// `patchedDependencies` (a missing one fails the install), and what another
// Bun does with the rest is not known: anything but an empty object (or, for
// the lists, an empty list) keeps the lockfile rule (fail closed).
// `workspaces` has members, so it counts whatever its value, as for the
// workspace refusal.
const installObjects = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
  "catalog",
  "catalogs",
  "patchedDependencies",
] as const;
const installLists = [
  "bundleDependencies",
  "bundledDependencies",
  "trustedDependencies",
] as const;
// The scripts of the package itself that `bun install` runs, also when it
// has no package to install: skipping that install would skip them.
const installScripts = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

/** Whether a package declares nothing for Bun to install (issue #253): each
 * install member above absent or empty, no `workspaces`, and no script that
 * `bun install` runs. For such a package Bun writes no lockfile (it deletes
 * an empty one) and its install changes nothing, so it is prepared without
 * one and without an install. Anything else, including a member of another
 * shape, keeps the lockfile rule. */
function declaresNothingToInstall(manifest: Readonly<Record<string, unknown>>) {
  const object = (value: unknown): value is object =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const absentOr = (name: string, empty: (value: unknown) => boolean) =>
    !Object.hasOwn(manifest, name) || empty(manifest[name]);
  return (
    installObjects.every((name) =>
      absentOr(
        name,
        (value) => object(value) && !Reflect.ownKeys(value).length,
      ),
    ) &&
    installLists.every((name) =>
      absentOr(name, (value) => Array.isArray(value) && !value.length),
    ) &&
    !Object.hasOwn(manifest, "workspaces") &&
    absentOr(
      "scripts",
      (value) =>
        object(value) &&
        !installScripts.some((name) => Object.hasOwn(value, name)),
    )
  );
}

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
// The package manager configuration of the checkout the install reads: in
// the checkout and every directory down to the owner.
function checkoutConfigurationPaths(checkout: string, offset: string) {
  const paths: string[] = [];
  let directory = checkout;
  for (const segment of ["", ...(offset ? offset.split(sep) : [])]) {
    if (segment) directory = join(directory, segment);
    for (const name of [".npmrc", "bunfig.toml"])
      paths.push(join(directory, name));
  }
  return paths;
}

/** The checkout's package manager configuration under the file rule the
 * install's read applies (decision F23), without reading it: what a
 * read-only check of the preparation (the catalog) can know. */
export async function inspectCheckoutConfiguration(
  checkout: string,
  owner: string,
) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Declaration owner unavailable");
  for (const path of checkoutConfigurationPaths(
    checkout,
    relative(checkout, owner),
  )) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const refused = stat === null ? null : checkoutFileRefusal(stat, uid);
    if (refused !== null) throw new CheckoutRefused(refused, path);
  }
}

// A directory of the owner's path that is not there makes the owner invalid
// (decision F25), named by the owner's package.json.
export async function inspectOwnerDirectories(checkout: string, owner: string) {
  const checkoutStat = await inspectCheckoutDirectory(checkout);
  const offset = relative(checkout, owner);
  if (isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`))
    throw new Error("Install owner outside selected checkout");
  const inspect = (directory: string) =>
    inspectCheckoutDirectory(directory).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new PreparationRefused(
          "preparation-owner-invalid",
          join(owner, "package.json"),
          "Owner package required",
        );
      throw error;
    });
  let parent = checkout;
  if (offset)
    for (const segment of offset.split(sep)) {
      parent = join(parent, segment);
      await inspect(parent);
    }
  const ownerStat = await inspect(owner);
  return { checkoutStat, ownerStat, offset };
}

// The one lockfile beside an owner whose package declares something to
// install, from which it installs (decision F25).
async function soleLockfile(
  owner: string,
  locks: readonly string[],
  refused: (reason: PreparationReason, message: string) => Error,
) {
  if (locks.length > 1)
    throw refused(
      "preparation-lockfile-ambiguous",
      "One explicit Bun lockfile required",
    );
  const lockfile = locks[0];
  if (lockfile === undefined)
    throw refused(
      "preparation-lockfile-missing",
      "One explicit Bun lockfile required",
    );
  // The lockfile is a file of the operator's checkout (decision F23): the
  // same rule, reason and file as the start's read of it, without reading.
  const lockPath = join(owner, lockfile);
  const lockStat = await lstat(lockPath);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Declaration owner unavailable");
  const lockRefused = checkoutFileRefusal(lockStat, uid, lockfileBytesMax);
  if (lockRefused !== null) throw new CheckoutRefused(lockRefused, lockPath);
  if (lockStat.size === 0)
    throw refused(
      "preparation-lockfile-missing",
      "One explicit Bun lockfile required",
    );
  return lockfile;
}

// An owner whose package declares nothing to install has no lockfile and no
// install (issue #253), so no lockfile is read. One that is there all the
// same is left over (from removed dependencies, or written by hand), and
// Bun's frozen install refuses every lockfile beside such a package: it is
// refused by its own name before anything runs, never ignored, because
// whether the package lost its dependencies or the lockfile outlived them is
// not guessed.
function unusedLockfile(owner: string, locks: readonly string[]) {
  const unused = locks[0];
  if (unused !== undefined)
    throw new PreparationRefused(
      "preparation-lockfile-unused",
      join(owner, unused),
      "Lockfile beside a package with nothing to install",
    );
  return null;
}

/** The owner's package and which lockfile beside it installs, null for a
 * package that declares nothing to install (issue #253): what the install
 * authority snapshots and a read-only check of the preparation (the catalog)
 * can know without the rest of the snapshot (decision F25), so both give
 * one verdict. The caller has inspected the owner's directories. Each
 * refusal names the owner's package.json, except a lockfile left beside a
 * package with nothing to install, which is named itself. */
export async function readInstallOwner(
  owner: string,
  dependencyBoundary: string = owner,
) {
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
  const lockfile = declaresNothingToInstall(manifest)
    ? unusedLockfile(owner, locks)
    : await soleLockfile(owner, locks, refused);
  await inspectDirectLocalDependencies(owner, manifest, dependencyBoundary);
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
  // Where local `file:` dependencies may lie: the owner by default; for the
  // default preparation the Organization (or Personalspace owner) directory
  // holding it (decision F25).
  dependencyBoundary: string = owner,
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
  for (const path of checkoutConfigurationPaths(checkout, offset)) {
    configuration[relative(checkout, path)] = (await present(path))
      ? digest(await readCheckoutFileBytes(path))
      : null;
  }
  const { packageBytes, manifest, packageManager, lockfile } =
    await readInstallOwner(owner, dependencyBoundary);
  // A package that declares nothing to install has neither a lockfile nor
  // its digest (issue #253). That verdict is the package's bytes: the
  // package digest binds it, so a package that later declares a dependency
  // is changed, and inspected again it is under the lockfile rule.
  const lockBytes =
    lockfile === null
      ? null
      : await readCheckoutFileBytes(join(owner, lockfile));
  if (lockBytes !== null && !lockBytes.length)
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
    lockDigest: lockBytes === null ? null : digest(lockBytes),
    packageManager,
    manifest,
    workspaceInputs: await inspectWorkspaceInputs(owner, manifest.workspaces),
    patchInputs: await inspectPatchInputs(owner, manifest.patchedDependencies),
    dependencyBoundary,
    localDependencyInputs: await inspectLocalDependencyInputs(
      owner,
      manifest,
      dependencyBoundary,
    ),
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

/** The install authority against its snapshot: `unchanged`, `changed`, or
 * `unsettled` when one of its files changed while it was read, whose bytes
 * are then unknown. A process of the owner moves the metadata of its inputs
 * without changing them: an install replaces a hard link of a local
 * dependency's file in node_modules, which moves that file's ctime (issue
 * #140). Whoever watches the authority while such a process runs reads it
 * again; `verifyInstallAuthority` accepts nothing but `unchanged`. */
export async function observeInstallAuthority(
  expected: Awaited<ReturnType<typeof inspectInstallAuthority>>,
): Promise<"unchanged" | "changed" | "unsettled"> {
  let current: Awaited<ReturnType<typeof inspectInstallAuthority>>;
  try {
    current = await inspectInstallAuthority(
      expected.checkout,
      expected.owner,
      expected.environment ?? undefined,
      expected.dependencyBoundary,
    );
  } catch (error) {
    return error instanceof CheckoutFileUnsettled ? "unsettled" : "changed";
  }
  return current.checkoutIdentity === expected.checkoutIdentity &&
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
    ? "unchanged"
    : "changed";
}

export async function verifyInstallAuthority(
  expected: Awaited<ReturnType<typeof inspectInstallAuthority>>,
) {
  return (await observeInstallAuthority(expected)) === "unchanged";
}
