import { readFile, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { isUpdateChannel, type UpdateChannel } from "./channel";
import type { DurableWriter } from "./durable-file";
import {
  type ErrorContext,
  isUpdateErrorCode,
  type UpdateError,
  updateError,
} from "./errors";
import { isProductVersion, type ProductIdentity } from "./identity";

/** `update/observed.json`: an OBSERVATION for the UI, the CLI and outside
 * observers — never an authority (docs/update.md "State on disk"). Nothing
 * decides trust, selection or recovery from it, so a missing, stale or corrupt
 * file can only cost a rebuilt, emptier observation; it can never wedge.
 *
 * Four facts stay apart because a successful check does not imply a converged
 * Machine: what is SELECTED (the symlink), what is RUNNING (the Launchpad),
 * what is verified AVAILABLE, and the LAST HEALTHY ACTIVATION — each with the
 * time it was established.
 */
export const observedStatuses = [
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "ready",
  "activating",
  "restart-pending",
  "error",
] as const;
export type ObservedStatus = (typeof observedStatuses)[number];

export type ObservedAvailable = Readonly<{
  version: string;
  artifactSha256: string;
  length: number;
  sequence: number;
  minimumVersion: string;
  verifiedAt: string;
}>;

export type Observed = Readonly<{
  schemaVersion: 1;
  observedAt: string;
  /** The operation that wrote this file; null for a rebuilt observation. */
  operationId: string | null;
  status: ObservedStatus;
  channel: UpdateChannel | null;
  /** Last time signed metadata AND the channel document were verified. */
  lastAuthenticatedCheckAt: string | null;
  /** Identity of the executable that performed the last check. */
  checkedBy: ProductIdentity | null;
  selected: Readonly<{
    version: string;
    artifactSha16: string;
    observedAt: string;
  }> | null;
  /** The running Launchpad artifact. Unknown to a CLI check: only the
   * Launchpad (a later slice) can state what it runs. */
  running: Readonly<{ version: string; observedAt: string }> | null;
  available: ObservedAvailable | null;
  /** Written by activation (a later slice). */
  lastHealthyActivation: Readonly<{
    version: string;
    confirmedAt: string;
  }> | null;
  /** True when the executable that checked is below the signed minimum. */
  belowMinimumVersion: boolean;
  releaseNotes: string | null;
  downloadPercent: number | null;
  error: UpdateError | null;
  canRetry: boolean;
}>;

export const observedPath = (base: string) =>
  join(base, "update", "observed.json");

/** The selector is the only record of the active version; read it, never
 * resolve or trust more than its name.
 */
export async function readSelected(
  base: string,
  now: Date,
): Promise<Observed["selected"]> {
  try {
    const link = await readlink(join(base, "bin", "lazurio"));
    const match =
      /^\.\.\/versions\/([0-9A-Za-z.-]+)\+([0-9a-f]{16})\/lazurio$/.exec(link);
    if (!match || !isProductVersion(match[1])) return null;
    return Object.freeze({
      version: match[1],
      artifactSha16: match[2] as string,
      observedAt: now.toISOString(),
    });
  } catch {
    return null;
  }
}

export async function rebuiltObservation(
  base: string,
  now: Date,
): Promise<Observed> {
  return Object.freeze({
    schemaVersion: 1,
    observedAt: now.toISOString(),
    operationId: null,
    status: "idle",
    channel: null,
    lastAuthenticatedCheckAt: null,
    checkedBy: null,
    selected: await readSelected(base, now),
    running: null,
    available: null,
    lastHealthyActivation: null,
    belowMinimumVersion: false,
    releaseNotes: null,
    downloadPercent: null,
    error: null,
    canRetry: false,
  });
}

const isTime = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 40 &&
  !Number.isNaN(Date.parse(value));
const isNullOr = <T>(value: unknown, check: (value: unknown) => value is T) =>
  value === null || check(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function isAvailable(value: unknown): value is ObservedAvailable {
  return (
    isRecord(value) &&
    isProductVersion(value.version) &&
    isProductVersion(value.minimumVersion) &&
    typeof value.artifactSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.artifactSha256) &&
    Number.isSafeInteger(value.length) &&
    Number.isSafeInteger(value.sequence) &&
    isTime(value.verifiedAt)
  );
}

function isContext(value: unknown): value is ErrorContext {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) =>
      ["string", "number", "boolean"].includes(typeof entry),
    )
  );
}

/** Shape check of a file this product wrote. Unknown extra members are
 * ignored and dropped: observers of a newer writer stay readable.
 */
export function parseObserved(value: unknown): Observed {
  if (!isRecord(value) || value.schemaVersion !== 1)
    throw new Error("Unrecognized observation");
  const error = value.error;
  const identity = value.checkedBy;
  const selected = value.selected;
  const running = value.running;
  const healthy = value.lastHealthyActivation;
  if (
    !isTime(value.observedAt) ||
    !isNullOr(value.operationId, (v): v is string => typeof v === "string") ||
    !(observedStatuses as readonly unknown[]).includes(value.status) ||
    !isNullOr(value.channel, isUpdateChannel) ||
    !isNullOr(value.lastAuthenticatedCheckAt, isTime) ||
    !isNullOr(value.available, isAvailable) ||
    typeof value.belowMinimumVersion !== "boolean" ||
    typeof value.canRetry !== "boolean" ||
    !isNullOr(value.releaseNotes, (v): v is string => typeof v === "string") ||
    !isNullOr(
      value.downloadPercent,
      (v): v is number => typeof v === "number",
    ) ||
    !(
      error === null ||
      (isRecord(error) &&
        isUpdateErrorCode(error.code) &&
        isContext(error.context))
    ) ||
    !(
      identity === null ||
      (isRecord(identity) &&
        isProductVersion(identity.version) &&
        typeof identity.commit === "string" &&
        typeof identity.target === "string")
    ) ||
    !(
      selected === null ||
      (isRecord(selected) &&
        isProductVersion(selected.version) &&
        typeof selected.artifactSha16 === "string" &&
        isTime(selected.observedAt))
    ) ||
    !(
      running === null ||
      (isRecord(running) &&
        isProductVersion(running.version) &&
        isTime(running.observedAt))
    ) ||
    !(
      healthy === null ||
      (isRecord(healthy) &&
        isProductVersion(healthy.version) &&
        isTime(healthy.confirmedAt))
    )
  )
    throw new Error("Unrecognized observation");
  const pick = <T extends Record<string, unknown>>(
    source: unknown,
    keys: readonly (keyof T & string)[],
  ): T | null =>
    source === null
      ? null
      : (Object.freeze(
          Object.fromEntries(
            keys.map((key) => [key, (source as Record<string, unknown>)[key]]),
          ),
        ) as T);
  return Object.freeze({
    schemaVersion: 1,
    observedAt: value.observedAt as string,
    operationId: value.operationId as string | null,
    status: value.status as ObservedStatus,
    channel: value.channel as UpdateChannel | null,
    lastAuthenticatedCheckAt: value.lastAuthenticatedCheckAt as string | null,
    checkedBy: pick<ProductIdentity>(identity, ["version", "commit", "target"]),
    selected: pick<NonNullable<Observed["selected"]>>(selected, [
      "version",
      "artifactSha16",
      "observedAt",
    ]),
    running: pick<NonNullable<Observed["running"]>>(running, [
      "version",
      "observedAt",
    ]),
    available: pick<ObservedAvailable>(value.available, [
      "version",
      "artifactSha256",
      "length",
      "sequence",
      "minimumVersion",
      "verifiedAt",
    ]),
    lastHealthyActivation: pick<NonNullable<Observed["lastHealthyActivation"]>>(
      healthy,
      ["version", "confirmedAt"],
    ),
    belowMinimumVersion: value.belowMinimumVersion,
    releaseNotes: value.releaseNotes as string | null,
    downloadPercent: value.downloadPercent as number | null,
    error:
      error === null
        ? null
        : updateError(
            (error as UpdateError).code,
            (error as UpdateError).context,
          ),
    canRetry: value.canRetry,
  });
}

/** Never throws and never blocks: anything other than a well-formed file of a
 * known schema yields a rebuilt minimal observation.
 */
export async function readObserved(base: string, now: Date): Promise<Observed> {
  try {
    const path = observedPath(base);
    if ((await stat(path)).size > 64 * 1024) throw new Error("Too large");
    return parseObserved(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // `rebuiltObservation` cannot fail: reading the selector swallows errors.
    return rebuiltObservation(base, now);
  }
}

export async function writeObserved(
  base: string,
  observed: Observed,
  write: DurableWriter,
): Promise<void> {
  await write(
    join(base, "update"),
    "observed.json",
    Buffer.from(`${JSON.stringify(observed, null, 2)}\n`),
  );
}
