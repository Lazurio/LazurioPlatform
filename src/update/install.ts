import { copyFile, lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type BrowserEntry,
  convergeEnvironmentBrowser,
  type EnvironmentBrowser,
  environmentBrowserFailed,
} from "../browser/units";
import {
  type ExecutorConvergence,
  executorConvergenceFailed,
} from "../executor/converge";
import { activate, withUpdateLock } from "./activation";
import type { AttestationVerifier } from "./attestation";
import {
  type CodexAppServer,
  codexAppServerFailed,
  convergeEntryUnits,
} from "./codex-app-server";
import { writeDurableFile } from "./durable-file";
import { storageFailure, UpdateFailure } from "./errors";
import type { ProductIdentity } from "./identity";
import {
  layout,
  readHighWater,
  readSelector,
  swapSelector,
  versionFloor,
} from "./layout";
import {
  bundleFile,
  manifestFile,
  maxBundleBytes,
  maxManifestBytes,
} from "./manifest";
import { removeRollbackLeftovers } from "./migrations/remove-rollback";
import {
  ensurePathEntry,
  entryDirectory,
  entryLinked,
  type PathEntry,
} from "./path-entry";
import { type ProcessRunner, runProcess } from "./self-check";
import {
  detectServiceControl,
  launchpadExecStart,
  launchpadUnit,
  serviceUnits,
  systemctl,
  systemdQuote,
  unitBelongsToBase,
  unitMarker,
  unitPath,
  userUnitDirectory,
} from "./service-control";
import {
  placeVersion,
  selfCheckStaged,
  sha256File,
  stagedMatches,
} from "./stage";
import { type ErrorResult, verifyReleaseDocuments } from "./update";
import { compareVersions } from "./version";

/** `lazurio install [--service systemd-user]`: the running executable stages
 * ITSELF as the first version (docs/update.md "First installation"). There are
 * two ways in, and they are kept apart:
 * - **Downloaded** (`install.sh`, `--verify-release <directory>`): before
 *   anything is written, the executable holds itself against the release it
 *   says it is — the manifest and the Sigstore bundle downloaded beside it —
 *   through the same verification `lazurio update` runs on a release. Any
 *   refusal leaves nothing behind. What that proves, and what it cannot, is
 *   docs/update.md "First installation".
 * - **Staged** (the Machines role, `--base` from a digest-pinned file): no
 *   release files and no network; the custody that pinned and staged the
 *   bytes is the authority, and the executable verifies nothing about itself.
 * Convergent: repeated
 * with the active version, it completes what is missing and changes nothing.
 * Run from a NEWER executable over an existing installation it is the offline
 * update (docs/update.md "Offline update"): the same staging, self-check,
 * activation and floor as `lazurio update`, with the bytes coming from the
 * staged file instead of the network. It never goes below the floor.
 * Either way it ends by creating the standard entry `~/.local/bin/lazurio`
 * when it is missing or Lazurio's own (`path-entry.ts`). On a supervised base
 * of a hosted Machine — with or without `--service` — it also converges the
 * unit that starts the operator's Codex app-server daemon at boot
 * (`codex-app-server.ts`, decision F29), which never fails the installation.
 */

/** The PATH of the Launchpad and of everything it starts (`unitPath`). */
export { launchpadExecStart, systemdQuote, unitMarker, unitPath };

/** `ExecStart` is the SELECTOR, so a restart runs whatever version is active.
 * The Launchpad must always run (docs/update.md "Recovery mode"), so the unit
 * restarts it after EVERY exit, clean or not (`Restart=always`,
 * systemd.service(5), "Restart="), five seconds apart, and never ends in the
 * `failed` state. That needs the start rate limit switched off: systemd.unit(5)
 * says of `StartLimitIntervalSec=`/`StartLimitBurst=` that they "apply to all
 * kinds of starts (including manual), not just those triggered by the
 * Restart= logic", that a unit which reaches the limit is "not attempted to be
 * restarted anymore", and that the interval may be set "to 0 to disable any
 * kind of rate limiting". Any finite limit could be reached by manual or
 * updater restarts in a row; 0, pinned in `[Unit]`, also overrides a
 * manager-wide `DefaultStartLimitIntervalSec=`. There is no `OnFailure=`:
 * nothing ever runs an earlier version. `[X-Lazurio]` is ignored by systemd:
 * it is where the updater reads the Folder from, so the Folder lives in this
 * unit and nowhere else.
 */
export function renderLaunchpadUnit(base: string, folder: string): string {
  // Read back verbatim, so it must be one line; quoting is ExecStart's.
  systemdQuote(folder);
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Launchpad",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    `Environment=PATH=${unitPath}`,
    launchpadExecStart(base, folder),
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
    "[X-Lazurio]",
    `Folder=${folder}`,
    "",
  ].join("\n");
}

/** The downloaded way in: the release files beside the executable and the
 * compiled-in verifier. Absent, the staged way in. */
export type ReleaseCheck = Readonly<{
  /** Holds `manifest.json` and `lazurio.sigstore.json` of the release. */
  directory: string;
  verify: AttestationVerifier;
}>;

export type InstallInput = Readonly<{
  base: string;
  /** `process.execPath`: the file that is running. */
  executable: string;
  identity: ProductIdentity;
  release?: ReleaseCheck | undefined;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Present: install the systemd user service for this Folder. */
  service?: Readonly<{ folder: string }> | undefined;
  /** Whether this process is the declared operator of a Machine handover
   * (`discoverHostedOperator` answers `hosted`); asked only when the base is
   * supervised. Absent: not hosted. On a hosted supervised base the Codex
   * app-server unit is converged (decision F29). */
  hosted?: (() => Promise<boolean>) | undefined;
  /** The handover's `entry.browser`, asked only on a supervised hosted base
   * (decision F38); absent: none, so nothing is converged. */
  browserEntry?: (() => Promise<BrowserEntry | undefined>) | undefined;
  /** Executor's convergence on a supervised hosted base (decision F44,
   * `convergeExecutor`), given the same hosted answer; absent: nothing is
   * converged. */
  executor?:
    | ((
        hosted: () => Promise<boolean>,
      ) => Promise<ExecutorConvergence | undefined>)
    | undefined;
  run?: ProcessRunner | undefined;
  healthDeadlineMs?: number | undefined;
}>;

export type InstallResult =
  | Readonly<{
      kind: "installed";
      /** The active version: this executable's, unless one was active. */
      active: string;
      /** Directory to put on PATH: `~/.local/bin` when the entry links the
       * selector, otherwise the install base's `bin`. Shell profiles are never
       * edited. */
      path: string;
      serviceInstalled: boolean;
      /** `~/.local/bin/lazurio`; null without a home or on another OS. */
      entry: PathEntry | null;
      /** Only on a supervised base (its Launchpad unit is this base's): what
       * became of the Codex app-server unit. */
      codexAppServer?: CodexAppServer;
      /** Only on a supervised base: what became of the Environment
       * browser's units (decision F38). */
      environmentBrowser?: EnvironmentBrowser;
      /** Only on a supervised base: what became of Executor (F44). */
      executor?: ExecutorConvergence;
    }>
  /** The offline update: a newer executable over an existing installation. */
  | Readonly<{
      kind: "updated";
      from: string;
      to: string;
      /** Unsupervised: a running Launchpad finishes the update by restarting. */
      restartRequired: boolean;
      path: string;
      serviceInstalled: boolean;
      entry: PathEntry | null;
      codexAppServer?: CodexAppServer;
      environmentBrowser?: EnvironmentBrowser;
      executor?: ExecutorConvergence;
    }>
  | ErrorResult;

const canonical = (path: string) => isAbsolute(path) && resolve(path) === path;

/** The Launchpad unit already in `directory`, refused unless it is this
 * base's own (`unitBelongsToBase`): an unmarked unit is someone else's
 * decision, a marked unit of another base is that installation's. Its text,
 * or undefined when there is none. */
async function ownUnitOrNone(
  directory: string,
  base: string,
): Promise<string | undefined> {
  const existing = await readFile(join(directory, launchpadUnit), "utf8").catch(
    () => undefined,
  );
  if (existing !== undefined && !unitBelongsToBase(existing, base))
    throw new UpdateFailure("storage-unavailable", {
      stage: "unit",
      reason: "foreign-unit",
    });
  return existing;
}

async function writeLaunchpadUnit(
  directory: string,
  base: string,
  text: string,
) {
  // Asked again at the write: the unit may have changed since the refusal.
  if ((await ownUnitOrNone(directory, base)) === text) return;
  await writeDurableFile(directory, launchpadUnit, Buffer.from(text));
}

export async function performInstall(
  input: InstallInput,
): Promise<InstallResult> {
  try {
    return await install(input);
  } catch (error) {
    const failure =
      error instanceof UpdateFailure
        ? error.failure
        : new UpdateFailure("internal").failure;
    return Object.freeze({ kind: "error" as const, ...failure });
  }
}

/** One release file, read only if it is a regular file within its limit. */
async function releaseFile(
  directory: string,
  name: string,
  limit: number,
): Promise<Uint8Array> {
  const resource = name === manifestFile ? "manifest" : "bundle";
  let bytes: Uint8Array;
  try {
    const path = join(directory, name);
    const info = await lstat(path);
    if (!info.isFile() || info.size > limit) throw new Error(resource);
    bytes = await readFile(path);
  } catch {
    throw new UpdateFailure("release-invalid", { resource, reason: "file" });
  }
  if (bytes.byteLength > limit)
    throw new UpdateFailure("release-invalid", { resource, reason: "size" });
  return bytes;
}

/** The downloaded way in: this executable is the artifact of its own target
 * in a release of its own version and commit, and the release workflow at
 * that tag attested the manifest and those bytes. Returns the digest the
 * staged copy is held against, so the file that was verified is the file
 * that is installed. Reads and verifies; writes nothing.
 */
async function verifyOwnRelease(
  input: InstallInput,
  release: ReleaseCheck,
): Promise<string> {
  const { identity } = input;
  let sha256: string;
  let size: number;
  try {
    sha256 = await sha256File(input.executable);
    size = (await stat(input.executable)).size;
  } catch (error) {
    throw storageFailure(error, "executable");
  }
  const { manifest, artifact } = await verifyReleaseDocuments({
    manifestBytes: await releaseFile(
      release.directory,
      manifestFile,
      maxManifestBytes,
    ),
    bundle: () => releaseFile(release.directory, bundleFile, maxBundleBytes),
    version: identity.version,
    target: identity.target,
    verify: release.verify,
  });
  if (manifest.sourceCommit !== identity.commit)
    throw new UpdateFailure("release-invalid", {
      resource: "manifest",
      reason: "commit-mismatch",
    });
  if (artifact.size !== size || artifact.sha256 !== sha256)
    throw new UpdateFailure("release-invalid", {
      resource: "artifact",
      reason: artifact.size !== size ? "size" : "digest",
    });
  return sha256;
}

async function install(input: InstallInput): Promise<InstallResult> {
  const { base, identity, service } = input;
  if (!canonical(base))
    throw new UpdateFailure("storage-unavailable", { stage: "base" });
  // Everything about the service that can be refused is refused first.
  const unitDirectory = userUnitDirectory(input.env);
  if (service && (input.platform !== "linux" || unitDirectory === undefined))
    throw new UpdateFailure("target-unsupported", { service: "systemd-user" });
  if (service && !canonical(service.folder))
    throw new UpdateFailure("storage-unavailable", { stage: "folder" });
  const unit = service ? renderLaunchpadUnit(base, service.folder) : undefined;
  // A Launchpad unit that is not this base's is refused before the selector
  // or anything else changes.
  if (service && unitDirectory !== undefined)
    await ownUnitOrNone(unitDirectory, base);
  // The downloaded way in proves its release before the first write.
  const verified = input.release
    ? await verifyOwnRelease(input, input.release)
    : undefined;

  // Stage this executable under `versions/<its version>` unless those exact
  // bytes are already there. Scratch belongs to the lock holder.
  const stage = async () => {
    const paths = layout(base);
    const sha256 = verified ?? (await sha256File(input.executable));
    if (await stagedMatches(base, identity.version, sha256)) return false;
    await rm(paths.scratch, { recursive: true, force: true });
    await mkdir(paths.scratch, { mode: 0o700 });
    const copy = join(paths.scratch, "artifact");
    await copyFile(input.executable, copy);
    // Hold the copy against the digest (the verified one on the downloaded
    // way in): the file could have changed.
    if ((await sha256File(copy)) !== sha256)
      throw new UpdateFailure("storage-unavailable", { stage: "copy" });
    await placeVersion({
      base,
      scratch: paths.scratch,
      artifactFile: copy,
      version: identity.version,
    });
    return true;
  };

  const outcome = await withUpdateLock(base, 0, async () => {
    const paths = layout(base);
    try {
      // The supervisor is the installer-written unit of THIS base if there is
      // one; a foreign unit, or one of another base, is not ours.
      const control = await detectServiceControl({
        base,
        platform: input.platform,
        env: input.env,
        run: input.run,
      });
      // Like every mutating update command, first converge what an
      // installation from before the first release without rollback left
      // (the migration validates the whole update state before it touches
      // anything; a marker without a selector stays untouched as
      // `state-invalid`).
      await removeRollbackLeftovers({
        base,
        service: control,
        units: serviceUnits(input),
      });
      const selected = await readSelector(base);
      if (selected === null) {
        // First installation — or a tree whose selector is missing or
        // damaged while its durable state survived. The surviving high-water
        // mark is the floor: a lower executable never becomes active through
        // this branch. A missing mark means the floor is this version, and
        // only an activation ever writes one.
        const floor = await readHighWater(base);
        if (floor !== null && compareVersions(identity.version, floor) < 0)
          throw new UpdateFailure("release-invalid", {
            resource: "version",
            reason: "below-floor",
          });
        const placed = await stage();
        // A mark means an existing installation: the executable that repairs
        // its selector proves itself first, like any offline update; a failure
        // removes only what this invocation placed and switches nothing. The
        // true first installation is trusted through whoever staged the file.
        if (floor !== null)
          await selfCheckStaged({
            base,
            expected: {
              version: identity.version,
              commit: identity.commit,
              target: identity.target,
            },
            folder: service?.folder,
            removeOnFailure: placed,
            run: input.run,
          });
        await swapSelector(base, identity.version);
        return { active: identity.version, updated: null };
      }
      // An installation exists.
      const from = selected;
      // The same version again changes nothing.
      if (from === identity.version) return { active: from, updated: null };
      // Another version: the offline update, by the contract's own steps.
      const floor = await versionFloor(base);
      if (
        compareVersions(identity.version, from) < 0 ||
        (floor !== null && compareVersions(identity.version, floor) < 0)
      )
        throw new UpdateFailure("release-invalid", {
          resource: "version",
          reason: "below-floor",
        });
      const placed = await stage();
      await selfCheckStaged({
        base,
        expected: {
          version: identity.version,
          commit: identity.commit,
          target: identity.target,
        },
        folder: control?.folder ?? service?.folder,
        removeOnFailure: placed,
        run: input.run,
      });
      await activate({
        base,
        to: identity.version,
        service: control,
        healthDeadlineMs: input.healthDeadlineMs,
      });
      return {
        active: identity.version,
        updated: {
          from,
          to: identity.version,
          restartRequired: control === null,
        },
      };
    } catch (error) {
      throw storageFailure(error, "install");
    } finally {
      await rm(paths.scratch, { recursive: true, force: true });
    }
  });
  const active = outcome.active;

  if (unit !== undefined && unitDirectory !== undefined) {
    const command = { run: input.run ?? runProcess, env: input.env };
    try {
      // The user's own directories are created, never re-moded.
      await mkdir(unitDirectory, { recursive: true });
      await writeLaunchpadUnit(unitDirectory, base, unit);
    } catch (error) {
      throw storageFailure(error, "unit");
    }
    if (
      !(await systemctl(command, "daemon-reload")) ||
      !(await systemctl(command, "enable", "--now", launchpadUnit))
    )
      throw new UpdateFailure("activation-failed", { stage: "service" });
  }
  // Only after the Launchpad's unit is in place, with or without `--service`,
  // and whatever it answers, the installation stands. The hosted context is
  // asked once for both convergences.
  let hostedAnswer: Promise<boolean> | undefined;
  const hosted = () => {
    hostedAnswer ??= (input.hosted ?? (async () => false))();
    return hostedAnswer;
  };
  const codexAppServer: CodexAppServer | undefined = await convergeEntryUnits({
    base,
    platform: input.platform,
    env: input.env,
    run: input.run ?? runProcess,
    hosted,
  }).catch(() => codexAppServerFailed("unit"));
  // The Environment browser's units the same way (decision F38): only for
  // the hosted operator of a handover that routes the browser's view.
  const environmentBrowser: EnvironmentBrowser | undefined =
    await convergeEnvironmentBrowser({
      base,
      platform: input.platform,
      env: input.env,
      run: input.run ?? runProcess,
      hosted,
      entry: input.browserEntry ?? (async () => undefined),
    }).catch(() => environmentBrowserFailed("unit"));
  // Executor the same way (decision F44): set up for the hosted operator of
  // a supervised base, never a reason for the installation to fail.
  const executor: ExecutorConvergence | undefined =
    input.executor === undefined
      ? undefined
      : await input.executor(hosted).catch(() => executorConvergenceFailed);
  // Last, and never a reason to fail: the product is installed whatever
  // happens to its PATH entry, and the result says what it found.
  const entry = await ensurePathEntry({
    base,
    home: input.env.HOME,
    pathVariable: input.env.PATH,
    platform: input.platform,
  });
  const path =
    entryLinked(entry) && input.env.HOME
      ? entryDirectory(input.env.HOME)
      : layout(base).bin;
  if (outcome.updated)
    return Object.freeze({
      kind: "updated" as const,
      ...outcome.updated,
      path,
      serviceInstalled: service !== undefined,
      entry,
      ...(codexAppServer === undefined ? {} : { codexAppServer }),
      ...(environmentBrowser === undefined ? {} : { environmentBrowser }),
      ...(executor === undefined ? {} : { executor }),
    });
  return Object.freeze({
    kind: "installed" as const,
    active,
    path,
    serviceInstalled: service !== undefined,
    entry,
    ...(codexAppServer === undefined ? {} : { codexAppServer }),
    ...(environmentBrowser === undefined ? {} : { environmentBrowser }),
    ...(executor === undefined ? {} : { executor }),
  });
}
