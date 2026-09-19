import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActivationStep,
  activate,
  automaticRollback,
  type Reconciled,
  reconcilePending,
  rollbackTarget,
  withUpdateLock,
} from "./activation";
import type { AttestationVerifier } from "./attestation";
import { type DownloadPolicy, downloadArtifact } from "./download";
import {
  type ErrorContext,
  storageFailure,
  type UpdateError,
  type UpdateErrorCode,
  UpdateFailure,
  updateError,
} from "./errors";
import {
  type ProductIdentity,
  type ReleaseOrigin,
  tagOf,
  updateTargets,
  versionOfTag,
} from "./identity";
import { type LastCheck, readLastCheck, writeLastCheck } from "./last-check";
import {
  layout,
  markerState,
  raiseHighWater,
  readHighWater,
  readPrevious,
  readSelector,
  versionFloor,
} from "./layout";
import {
  bundleFile,
  manifestFile,
  maxBundleBytes,
  maxManifestBytes,
  parseManifest,
  type ReleaseManifest,
  sha256Hex,
} from "./manifest";
import type { ProcessRunner } from "./self-check";
import type { ServiceControl } from "./service-control";
import { placeVersion, selfCheckStaged, stagedMatches } from "./stage";
import {
  type Fetcher,
  fetchAsset,
  resolveLatestTag,
  tagUrl,
} from "./transport";
import { compareVersions } from "./version";

/** The ONE update core (docs/update.md "Invariants"): CLI and Launchpad run
 * these use cases and nothing else. Expected failures are returned as typed
 * values; whatever fails, the installed product keeps working and the same
 * call works again once the outside condition is restored.
 */
export type UpdateEnvironment = Readonly<{
  base: string;
  /** The identity of the executable that is running. */
  identity: ProductIdentity;
  origin: ReleaseOrigin;
  fetcher: Fetcher;
  verify: AttestationVerifier;
  /** Null: this installation is not supervised. */
  service: ServiceControl | null;
  run?: ProcessRunner | undefined;
  now?: (() => Date) | undefined;
  download?: Partial<DownloadPolicy> | undefined;
  healthDeadlineMs?: number | undefined;
  lockTimeoutMs?: number | undefined;
  afterStep?: ((step: ActivationStep) => void | Promise<void>) | undefined;
  onProgress?:
    | ((receivedBytes: number, totalBytes: number) => void)
    | undefined;
}>;

export type ErrorResult = Readonly<{ kind: "error" }> & UpdateError;

const failed = (
  code: UpdateErrorCode,
  context: ErrorContext = {},
): ErrorResult =>
  Object.freeze({ kind: "error" as const, ...updateError(code, context) });

/** The only place a thrown value becomes a result. */
async function settle<T>(
  operation: () => Promise<T>,
): Promise<T | ErrorResult> {
  try {
    return await operation();
  } catch (error) {
    return error instanceof UpdateFailure
      ? failed(error.failure.code, error.failure.context)
      : failed("internal");
  }
}

export type VerifiedRelease = Readonly<{
  tag: string;
  manifest: ReleaseManifest;
  /** Whether this installation may move to it. */
  available: boolean;
}>;

/** Check (docs/update.md "Check" and "Verify"): learn the tag, read its
 * manifest by exact tag, and verify the attestation over the manifest AND the
 * artifact digest it names — before a single artifact byte is requested.
 */
async function verifiedRelease(
  environment: UpdateEnvironment,
  exactVersion: string | undefined,
): Promise<VerifiedRelease> {
  const { origin, fetcher, identity, base } = environment;
  if (!(updateTargets as readonly string[]).includes(identity.target))
    throw new UpdateFailure("target-unsupported", { target: identity.target });
  // The floor holds on every network path. A version asked for by name is
  // refused by name, before anything is requested.
  const active = await readSelector(base);
  const floor = await versionFloor(base);
  const belowFloor = (version: string) =>
    floor !== null && compareVersions(version, floor) < 0;
  if (exactVersion !== undefined && belowFloor(exactVersion))
    throw new UpdateFailure("release-invalid", {
      resource: "version",
      reason: "below-floor",
    });
  const tag =
    exactVersion === undefined
      ? await resolveLatestTag(origin, fetcher, manifestFile)
      : tagOf(exactVersion);
  const manifestBytes = await fetchAsset(
    origin,
    fetcher,
    tagUrl(origin, tag, manifestFile),
    "manifest",
    maxManifestBytes,
  );
  const manifest = parseManifest(manifestBytes);
  if (manifest.version !== versionOfTag(tag))
    throw new UpdateFailure("release-invalid", {
      resource: "manifest",
      reason: "tag-mismatch",
    });
  const artifact = manifest.targets[identity.target];
  if (!artifact)
    throw new UpdateFailure("target-unsupported", { target: identity.target });
  await environment.verify({
    bundle: await fetchAsset(
      origin,
      fetcher,
      tagUrl(origin, tag, bundleFile),
      "bundle",
      maxBundleBytes,
    ),
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    subjectSha256: [sha256Hex(manifestBytes), artifact.sha256],
  });
  // Only a `latest` answer feeds the pill: an exact version is one Machine's
  // choice, not what is current.
  if (exactVersion === undefined)
    await writeLastCheck(base, {
      checkedAt: (environment.now?.() ?? new Date()).toISOString(),
      latest: manifest.version,
      notesUrl: manifest.notesUrl,
    });
  // Equal to the high-water mark but not active is the retry after a rollback.
  const available =
    !belowFloor(manifest.version) &&
    (active === null || compareVersions(manifest.version, active) > 0);
  if (
    available &&
    compareVersions(identity.version, manifest.minimumUpdaterVersion) < 0
  )
    throw new UpdateFailure("reinstall-required", {
      version: manifest.version,
      minimumUpdaterVersion: manifest.minimumUpdaterVersion,
    });
  return Object.freeze({ tag, manifest, available });
}

const requireInstalled = async (base: string) => {
  const active = await readSelector(base);
  if (active === null) throw new UpdateFailure("not-installed");
  return active;
};

export type CheckResult =
  | Readonly<{
      kind: "up-to-date" | "available";
      running: string;
      latest: string;
      notesUrl: string;
    }>
  | ErrorResult;

/** `lazurio update --check`: reads the network, writes only `last-check.json`. */
export const checkForUpdate = (
  environment: UpdateEnvironment,
  exactVersion?: string,
): Promise<CheckResult> =>
  settle(async () => {
    await requireInstalled(environment.base);
    const release = await verifiedRelease(environment, exactVersion);
    return Object.freeze({
      kind: release.available
        ? ("available" as const)
        : ("up-to-date" as const),
      running: environment.identity.version,
      latest: release.manifest.version,
      notesUrl: release.manifest.notesUrl,
    });
  });

export type UpdateResult =
  | Readonly<{ kind: "up-to-date"; running: string; latest: string }>
  | Readonly<{
      kind: "updated";
      from: string;
      to: string;
      /** Unsupervised: a running Launchpad finishes the update by restarting. */
      restartRequired: boolean;
    }>
  | ErrorResult;

/** `lazurio update [--version <tag>]`, under the lock from the first read of
 * the base to the committed activation.
 */
export const performUpdate = (
  environment: UpdateEnvironment,
  exactVersion?: string,
): Promise<UpdateResult> =>
  settle(async () => {
    const { base, identity, origin, fetcher } = environment;
    await requireInstalled(base);
    return withUpdateLock(base, environment.lockTimeoutMs ?? 0, async () => {
      await reconcilePending(environment);
      const from = await requireInstalled(base);
      const { tag, manifest, available } = await verifiedRelease(
        environment,
        exactVersion,
      );
      if (!available)
        return Object.freeze({
          kind: "up-to-date" as const,
          running: identity.version,
          latest: manifest.version,
        });
      const artifact = manifest.targets[identity.target];
      if (!artifact) throw new UpdateFailure("internal");
      // Scratch is a directory nobody else may use while the lock is held:
      // whatever is in it belongs to an attempt that is over.
      const { scratch } = layout(base);
      await rm(scratch, { recursive: true, force: true });
      try {
        let placed = false;
        if (!(await stagedMatches(base, manifest.version, artifact.sha256))) {
          await mkdir(scratch, { mode: 0o700 });
          const artifactFile = join(scratch, "artifact");
          await downloadArtifact({
            origin,
            fetcher,
            url: tagUrl(origin, tag, artifact.file),
            artifact,
            directory: scratch,
            destination: artifactFile,
            policy: environment.download,
            onProgress: environment.onProgress,
          });
          await placeVersion({
            base,
            scratch,
            artifactFile,
            version: manifest.version,
          });
          placed = true;
        }
        await selfCheckStaged({
          base,
          expected: {
            version: manifest.version,
            commit: manifest.sourceCommit,
            target: identity.target,
          },
          folder: environment.service?.folder,
          removeOnFailure: placed,
          run: environment.run,
        });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
      await activate({
        base,
        to: manifest.version,
        service: environment.service,
        healthDeadlineMs: environment.healthDeadlineMs,
        afterStep: environment.afterStep,
      });
      return Object.freeze({
        kind: "updated" as const,
        from,
        to: manifest.version,
        restartRequired: environment.service === null,
      });
    });
  });

export type RollbackResult =
  | Readonly<{ kind: "rolled-back"; from: string; to: string }>
  /** `--auto` only: what it did about the marker, which may be nothing. */
  | Readonly<{ kind: "reconciled"; outcome: Reconciled }>
  | ErrorResult;

type LocalEnvironment = Pick<
  UpdateEnvironment,
  | "base"
  | "identity"
  | "service"
  | "run"
  | "healthDeadlineMs"
  | "lockTimeoutMs"
  | "afterStep"
>;

/** `lazurio update rollback`: to `previous`, after that executable's own
 * self-check, by the same activation. It never lowers the high-water mark, so
 * the network can only offer what was already accepted, or newer.
 */
export const performRollback = (
  environment: LocalEnvironment,
): Promise<RollbackResult> =>
  settle(async () => {
    const { base } = environment;
    await requireInstalled(base);
    return withUpdateLock(base, environment.lockTimeoutMs ?? 0, async () => {
      await reconcilePending(environment);
      const from = await requireInstalled(base);
      const to = await rollbackTarget(base);
      await selfCheckStaged({
        base,
        // Only the version is known of an installed executable, and the
        // target is this Machine's; its commit was verified when it was staged.
        expected: { version: to, target: environment.identity.target },
        folder: environment.service?.folder,
        removeOnFailure: false,
        run: environment.run,
      }).catch((error) => {
        throw error instanceof UpdateFailure &&
          error.failure.code === "self-check-failed"
          ? new UpdateFailure("rollback-unavailable", {
              reason: "self-check",
            })
          : error;
      });
      // Before the switch: what is being left stays the floor of the network.
      await raiseHighWater(base, from).catch((error) => {
        throw storageFailure(error, "high-water");
      });
      await activate({
        base,
        to,
        service: environment.service,
        healthDeadlineMs: environment.healthDeadlineMs,
        afterStep: environment.afterStep,
      });
      return Object.freeze({ kind: "rolled-back" as const, from, to });
    });
  });

/** `lazurio update rollback --auto` (see `automaticRollback`). */
export const performAutomaticRollback = (
  environment: Pick<UpdateEnvironment, "base" | "service">,
): Promise<RollbackResult> =>
  settle(async () =>
    Object.freeze({
      kind: "reconciled" as const,
      outcome: await automaticRollback(environment),
    }),
  );

export type UpdateStatus = Readonly<{
  kind: "status";
  /** Version of the executable answering. */
  running: string;
  /** Version the selector names; null when nothing is installed. */
  active: string | null;
  previous: string | null;
  highWater: string | null;
  supervised: boolean;
  /** An activation that was switched and is not committed. */
  pending: Readonly<{ from: string; to: string }> | null;
  /** Path of update state no crash can produce; mutating commands refuse. */
  stateInvalid: string | null;
  /** Newest release a check verified and WHEN: an ageing time is how a
   * withheld release becomes visible. */
  lastCheck: LastCheck | null;
  updateAvailable: boolean;
}>;

/** `lazurio update status`: computed from the paths when asked; no network,
 * no lock, no write. This is what an outside observer reads.
 */
export async function readStatus(
  environment: Pick<UpdateEnvironment, "base" | "identity" | "service">,
): Promise<UpdateStatus> {
  const { base, identity } = environment;
  let stateInvalid: string | null = null;
  const guarded = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (
        !(error instanceof UpdateFailure) ||
        error.failure.code !== "state-invalid"
      )
        throw error;
      stateInvalid ??= String(error.failure.context.path);
      return null;
    }
  };
  const highWater = await guarded(() => readHighWater(base));
  const marker = await guarded(() => markerState(base));
  const floor = await guarded(() => versionFloor(base));
  const lastCheck = await readLastCheck(base);
  const active = await readSelector(base);
  return Object.freeze({
    kind: "status" as const,
    running: identity.version,
    active,
    previous: await readPrevious(base),
    highWater,
    supervised: environment.service !== null,
    pending: marker?.kind === "switched" ? marker.pending : null,
    stateInvalid,
    lastCheck,
    updateAvailable:
      stateInvalid === null &&
      lastCheck !== null &&
      active !== null &&
      floor !== null &&
      compareVersions(lastCheck.latest, floor) >= 0 &&
      compareVersions(lastCheck.latest, active) > 0,
  });
}
