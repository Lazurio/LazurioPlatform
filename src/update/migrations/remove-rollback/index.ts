import { lstat, readFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory, writeDurableFile } from "../../durable-file";
import { storageFailure, UpdateFailure } from "../../errors";
import { isProductVersion } from "../../identity";
import { renderLaunchpadUnit } from "../../install";
import {
  layout,
  pruneVersions,
  raiseHighWater,
  readHighWater,
  readSelector,
} from "../../layout";
import {
  launchpadUnit,
  type ServiceControl,
  type ServiceUnits,
  systemdQuote,
  unitBelongsToBase,
  unitFolder,
  unitMarker,
} from "../../service-control";

/** Migration "remove rollback" (README.md beside this file): what an
 * installation of v0.1.x left for program rollback, converged forward. Nothing
 * here ever selects an earlier version; it deletes what only rollback used.
 * Delete this directory in the first release whose `minimum_updater_version`
 * is at least the first release without rollback.
 */

/** The legacy names inside the install base and the user unit directory. */
const legacy = (base: string) =>
  Object.freeze({
    previous: join(base, "previous"),
    pending: join(layout(base).update, "pending.json"),
  });
const rollbackUnit = "lazurio-rollback.service";

const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
const markerInvalid = () =>
  new UpdateFailure("state-invalid", { path: "update/pending.json" });

async function readPrevious(base: string): Promise<string | null> {
  const target = await readlink(legacy(base).previous).catch(() => null);
  const match = target === null ? null : /^versions\/([^/]+)$/.exec(target);
  return match && isProductVersion(match[1]) ? (match[1] as string) : null;
}

type Pending = Readonly<{ from: string; to: string }>;

async function readPending(base: string): Promise<Pending | null> {
  let text: string;
  try {
    text = await readFile(legacy(base).pending, "utf8");
  } catch (error) {
    if (absent(error)) return null;
    throw markerInvalid();
  }
  try {
    const value = JSON.parse(text) as Partial<Pending> | null;
    if (isProductVersion(value?.from) && isProductVersion(value?.to))
      return Object.freeze({ from: value.from, to: value.to });
  } catch {}
  throw markerInvalid();
}

/** What a v0.1.x activation marker means, from what is on disk alone. Every
 * combination a crash cannot produce is `state-invalid`, left as found. */
type Marker =
  | Readonly<{ kind: "absent" }>
  /** Crashed before the switch, or after the old updater undid it. */
  | Readonly<{ kind: "not-switched" }>
  | Readonly<{ kind: "switched"; to: string }>;

async function readMarker(base: string): Promise<Marker> {
  const pending = await readPending(base);
  if (pending === null) return { kind: "absent" };
  const active = await readSelector(base);
  if (active === pending.from) return { kind: "not-switched" };
  if (active === pending.to && (await readPrevious(base)) === pending.from)
    return { kind: "switched", to: pending.to };
  throw markerInvalid();
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

const unitText = (units: ServiceUnits, name: string) =>
  readFile(join(units.directory, name), "utf8").catch(() => undefined);

/** The installer's Launchpad unit of THIS base that still starts the rollback
 * unit on failure, with the Folder it serves; undefined for any other unit. */
async function legacyLaunchpadUnit(base: string, units: ServiceUnits) {
  const text = await unitText(units, launchpadUnit);
  // A unit of another install base is that installation's to converge.
  if (text === undefined || !unitBelongsToBase(text, base)) return undefined;
  if (!/^OnFailure=/m.test(text)) return undefined;
  return unitFolder(text);
}

/** The `ExecStart=` line v0.1.x wrote into the rollback unit of `base`. */
const rollbackExecStart = (base: string) =>
  `ExecStart=${[
    join(legacy(base).previous, "lazurio"),
    "update",
    "rollback",
    "--auto",
    "--base",
    base,
  ]
    .map(systemdQuote)
    .join(" ")}`;

/** The installer's rollback unit of THIS base; a unit of another install base
 * is that installation's to converge. */
async function legacyRollbackUnit(
  base: string,
  units: ServiceUnits,
): Promise<boolean> {
  const text = await unitText(units, rollbackUnit);
  if (text === undefined || !text.startsWith(unitMarker)) return false;
  return text.split("\n").includes(rollbackExecStart(base));
}

/** Read-only, for `update status`: whether anything of the former rollback is
 * left. Throws `state-invalid` for a marker no crash can produce, exactly as
 * the migration would refuse it. */
export async function legacyRollbackState(
  base: string,
  units: ServiceUnits | null,
): Promise<boolean> {
  const marker = await readMarker(base);
  return (
    marker.kind !== "absent" ||
    (await exists(legacy(base).previous)) ||
    (units !== null &&
      ((await legacyRollbackUnit(base, units)) ||
        (await legacyLaunchpadUnit(base, units)) !== undefined))
  );
}

export type MarkerOutcome =
  | "none"
  | "discarded"
  /** Switched and its Launchpad healthy at `to`: finished forward. */
  | "committed"
  /** Switched and its Launchpad not healthy at `to`: `to` stays active, the
   * Launchpad is in Recovery mode or not running; nothing is undone. */
  | "unhealthy";

export type Migrated = Readonly<{
  marker: MarkerOutcome;
  /** `to` of a switched marker, when there was one. */
  to: string | null;
  rollbackUnitRemoved: boolean;
  launchpadUnitRewritten: boolean;
  previousRemoved: boolean;
}>;

/** Under the update lock, first thing in `lazurio update` and `lazurio
 * install`. The WHOLE update state is read and validated before anything is
 * touched: an unreadable mark or marker is `state-invalid` and stays as it is.
 */
export async function removeRollbackLeftovers(
  input: Readonly<{
    base: string;
    service: ServiceControl | null;
    units: ServiceUnits | null;
  }>,
): Promise<Migrated> {
  const { base } = input;
  await readHighWater(base);
  const marker = await readMarker(base);
  try {
    return await migrate(input, marker);
  } catch (error) {
    throw storageFailure(error, "migration");
  }
}

async function migrate(
  input: Parameters<typeof removeRollbackLeftovers>[0],
  marker: Marker,
): Promise<Migrated> {
  const { base, service, units } = input;

  // 1. The marker. A switched activation is finished forward whatever its
  // health: the selector already names `to`, and `to` becomes the floor.
  let outcome: MarkerOutcome = "none";
  if (marker.kind === "switched") {
    const healthy = (await service?.launchpadVersion()) === marker.to;
    await raiseHighWater(base, marker.to);
    outcome = healthy ? "committed" : "unhealthy";
  } else if (marker.kind === "not-switched") outcome = "discarded";
  if (marker.kind !== "absent") {
    await rm(legacy(base).pending, { force: true });
    await syncDirectory(layout(base).update);
  }

  // 2. The installer's units: the rollback unit goes, the Launchpad unit is
  // rewritten to the current text. The manager rereads them; nothing is
  // restarted — the new `Restart=` applies from the Launchpad's next exit.
  let rollbackUnitRemoved = false;
  let launchpadUnitRewritten = false;
  if (units !== null) {
    if (await legacyRollbackUnit(base, units)) {
      await rm(join(units.directory, rollbackUnit), { force: true });
      rollbackUnitRemoved = true;
    }
    const folder = await legacyLaunchpadUnit(base, units);
    if (folder !== undefined) {
      await writeDurableFile(
        units.directory,
        launchpadUnit,
        Buffer.from(renderLaunchpadUnit(base, folder)),
      );
      launchpadUnitRewritten = true;
    }
    if (rollbackUnitRemoved || launchpadUnitRewritten)
      await units.reload().catch(() => false);
  }

  // 3. The retained previous version: the link, and every version but the
  // active one.
  const previousRemoved = await exists(legacy(base).previous);
  if (previousRemoved) {
    await rm(legacy(base).previous, { force: true });
    await syncDirectory(base);
    await pruneVersions(base);
  }
  return Object.freeze({
    marker: outcome,
    to: marker.kind === "switched" ? marker.to : null,
    rollbackUnitRemoved,
    launchpadUnitRewritten,
    previousRemoved,
  });
}
