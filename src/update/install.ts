import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { activate, reconcilePending, withUpdateLock } from "./activation";
import { writeDurableFile } from "./durable-file";
import { storageFailure, UpdateFailure } from "./errors";
import type { ProductIdentity } from "./identity";
import {
  layout,
  readSelector,
  readUpdateState,
  swapSelector,
  versionFloor,
} from "./layout";
import { type ProcessRunner, runProcess } from "./self-check";
import {
  detectServiceControl,
  launchpadUnit,
  rollbackUnit,
  systemctl,
  unitMarker,
  userUnitDirectory,
} from "./service-control";
import {
  placeVersion,
  selfCheckStaged,
  sha256File,
  stagedMatches,
} from "./stage";
import type { ErrorResult } from "./update";
import { compareVersions } from "./version";

/** `lazurio install [--service systemd-user]`: the running executable stages
 * ITSELF as the first version (docs/update.md "First installation"). It
 * verifies nothing about itself — a check performed by downloaded bytes is not
 * authentication; first installation is trusted through HTTPS by whoever ran
 * `install.sh`, or by the custody that staged the binary. Convergent: repeated
 * with the active version, it completes what is missing and changes nothing.
 * Run from a NEWER executable over an existing installation it is the offline
 * update (docs/update.md "Offline update"): the same staging, self-check,
 * activation and floor as `lazurio update`, with the bytes coming from the
 * staged file instead of the network. It never goes below the floor.
 */

/** One argument of an `ExecStart=` line. systemd splits on whitespace, expands
 * `%` specifiers and `$` variables and understands C-style escapes inside
 * double quotes; a path must survive all of that unchanged.
 */
export function systemdQuote(argument: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  if (argument === "" || /[\u0000-\u001f\u007f]/.test(argument))
    throw new UpdateFailure("storage-unavailable", { stage: "unit-argument" });
  if (/^[A-Za-z0-9_@/.:=+-]+$/.test(argument)) return argument;
  return `"${argument
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")}"`;
}

export { unitMarker };

const execStart = (command: readonly string[]) =>
  `ExecStart=${command.map(systemdQuote).join(" ")}`;

/** `ExecStart` is the SELECTOR, so a restart runs whatever version is active.
 * A version that cannot stay up hits the start limit, the unit fails, and
 * `OnFailure=` starts the rollback unit (docs/update.md "Interrupted
 * activation"). `[X-Lazurio]` is ignored by systemd: it is where the updater
 * reads the Folder from, so the Folder lives in this unit and nowhere else.
 */
export function renderLaunchpadUnit(base: string, folder: string): string {
  // Read back verbatim, so it must be one line; quoting is ExecStart's.
  systemdQuote(folder);
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Launchpad",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    `OnFailure=${rollbackUnit}`,
    "",
    "[Service]",
    execStart([
      layout(base).selector,
      "launchpad",
      "--base",
      base,
      "--folder",
      folder,
    ]),
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
    "[X-Lazurio]",
    `Folder=${folder}`,
    "",
  ].join("\n");
}

/** Static: runs the PREVIOUS version, which is the one known to work. */
export function renderRollbackUnit(base: string): string {
  return [
    unitMarker,
    "[Unit]",
    "Description=Lazurio rollback of an interrupted activation",
    "",
    "[Service]",
    "Type=oneshot",
    execStart([
      join(layout(base).previous, "lazurio"),
      "update",
      "rollback",
      "--auto",
      "--base",
      base,
    ]),
    "",
  ].join("\n");
}

export type InstallInput = Readonly<{
  base: string;
  /** `process.execPath`: the file that is running. */
  executable: string;
  identity: ProductIdentity;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Present: install the systemd user service for this Folder. */
  service?: Readonly<{ folder: string }> | undefined;
  run?: ProcessRunner | undefined;
  healthDeadlineMs?: number | undefined;
}>;

export type InstallResult =
  | Readonly<{
      kind: "installed";
      /** The active version: this executable's, unless one was active. */
      active: string;
      /** Directory to put on PATH. Shell profiles are never edited. */
      path: string;
      serviceInstalled: boolean;
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
    }>
  | ErrorResult;

const canonical = (path: string) => isAbsolute(path) && resolve(path) === path;

async function writeUnit(directory: string, name: string, text: string) {
  const file = join(directory, name);
  const existing = await readFile(file, "utf8").catch(() => undefined);
  if (existing === text) return;
  // A unit of this name that we did not write is someone else's decision.
  if (existing !== undefined && !existing.startsWith(unitMarker))
    throw new UpdateFailure("storage-unavailable", {
      stage: "unit",
      reason: "foreign-unit",
    });
  await writeDurableFile(directory, name, Buffer.from(text));
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
  const units = service
    ? ([
        [launchpadUnit, renderLaunchpadUnit(base, service.folder)],
        [rollbackUnit, renderRollbackUnit(base)],
      ] as const)
    : [];

  // Stage this executable under `versions/<its version>` unless those exact
  // bytes are already there. Scratch belongs to the lock holder.
  const stage = async () => {
    const paths = layout(base);
    const sha256 = await sha256File(input.executable);
    if (await stagedMatches(base, identity.version, sha256)) return false;
    await rm(paths.scratch, { recursive: true, force: true });
    await mkdir(paths.scratch, { mode: 0o700 });
    const copy = join(paths.scratch, "artifact");
    await copyFile(input.executable, copy);
    // Hold the copy against the digest: the file could have changed.
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
      const selected = await readSelector(base);
      if (selected === null) {
        // First installation — or a tree whose selector is missing or
        // damaged while its durable state survived. The whole update state is
        // read and validated first, as every reconciler does: a marker without
        // a selector is a state no crash produces and stays untouched
        // (`state-invalid`). The surviving high-water mark is the floor: a
        // lower executable never becomes active through this branch. A
        // missing mark means the floor is this version, and only a committed
        // activation ever writes one.
        const { highWater: floor } = await readUpdateState(base);
        if (floor !== null && compareVersions(identity.version, floor) < 0)
          throw new UpdateFailure("release-invalid", {
            resource: "version",
            reason: "below-floor",
          });
        await stage();
        await swapSelector(base, identity.version);
        return { active: identity.version, updated: null };
      }
      if (selected === identity.version)
        return { active: selected, updated: null };
      // An installation of another version exists: this is the offline
      // update, by the update contract's own steps. The supervisor is the
      // installer-written unit if there is one; a foreign unit is nobody's.
      const control = await detectServiceControl({
        base,
        platform: input.platform,
        env: input.env,
        run: input.run,
      });
      await reconcilePending({ base, service: control });
      const from = await readSelector(base);
      if (from === null) throw new UpdateFailure("not-installed");
      if (from === identity.version) return { active: from, updated: null };
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

  if (service && unitDirectory !== undefined) {
    const command = { run: input.run ?? runProcess, env: input.env };
    try {
      // The user's own directories are created, never re-moded.
      await mkdir(unitDirectory, { recursive: true });
      for (const [name, text] of units)
        await writeUnit(unitDirectory, name, text);
    } catch (error) {
      throw storageFailure(error, "unit");
    }
    if (
      !(await systemctl(command, "daemon-reload")) ||
      !(await systemctl(command, "enable", "--now", launchpadUnit))
    )
      throw new UpdateFailure("activation-failed", { stage: "service" });
  }
  if (outcome.updated)
    return Object.freeze({
      kind: "updated" as const,
      ...outcome.updated,
      path: layout(base).bin,
      serviceInstalled: service !== undefined,
    });
  return Object.freeze({
    kind: "installed" as const,
    active,
    path: layout(base).bin,
    serviceInstalled: service !== undefined,
  });
}
