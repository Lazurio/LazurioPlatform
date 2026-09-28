import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type FolderRefresh,
  folderRefreshNeeded,
} from "../folder/refresh-needed";
import { instructionTemplateRevision } from "../folder/render";
import { type ActivationStep, activate, withUpdateLock } from "./activation";
import type { AttestationVerifier } from "./attestation";
import { type DownloadPolicy, downloadArtifact } from "./download";
import {
  type ErrorContext,
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
import { layout, readHighWater, readSelector, versionFloor } from "./layout";
import {
  bundleFile,
  type ManifestTarget,
  manifestFile,
  maxBundleBytes,
  maxManifestBytes,
  parseManifest,
  type ReleaseManifest,
  sha256Hex,
} from "./manifest";
import {
  legacyRollbackState,
  removeRollbackLeftovers,
} from "./migrations/remove-rollback";
import type { ProcessRunner } from "./self-check";
import type { ServiceControl, ServiceUnits } from "./service-control";
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
  /** The installer's user units, for the migration that removes what the
   * former rollback left (`migrations/remove-rollback`). */
  units?: ServiceUnits | null | undefined;
  /** The Folder whose template revision results report against the
   * product's ("Folder refresh needed"). Reporting only: never written,
   * never a reason to refuse. */
  folder?: string | undefined;
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

/** Verify (docs/update.md "Verify"): the manifest must describe `version`
 * and name an artifact for `target`, and the attestation must cover the
 * manifest AND that artifact's digest. The ONE decision whether bytes are a
 * release: the update runs it on what it fetched, the first installation
 * from a download (`install --verify-release`) on the files beside it. The
 * bundle is read only once the manifest is accepted.
 */
export async function verifyReleaseDocuments(
  input: Readonly<{
    manifestBytes: Uint8Array;
    bundle: () => Promise<Uint8Array>;
    version: string | undefined;
    target: string;
    verify: AttestationVerifier;
  }>,
): Promise<Readonly<{ manifest: ReleaseManifest; artifact: ManifestTarget }>> {
  const manifest = parseManifest(input.manifestBytes);
  if (manifest.version !== input.version)
    throw new UpdateFailure("release-invalid", {
      resource: "manifest",
      reason: "tag-mismatch",
    });
  const artifact = manifest.targets[input.target];
  if (!artifact)
    throw new UpdateFailure("target-unsupported", { target: input.target });
  await input.verify({
    bundle: await input.bundle(),
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    subjectSha256: [sha256Hex(input.manifestBytes), artifact.sha256],
  });
  return Object.freeze({ manifest, artifact });
}

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
  const { manifest } = await verifyReleaseDocuments({
    manifestBytes,
    bundle: () =>
      fetchAsset(
        origin,
        fetcher,
        tagUrl(origin, tag, bundleFile),
        "bundle",
        maxBundleBytes,
      ),
    version: versionOfTag(tag),
    target: identity.target,
    verify: environment.verify,
  });
  // Only a `latest` answer feeds the pill: an exact version is one Machine's
  // choice, not what is current.
  if (exactVersion === undefined)
    await writeLastCheck(base, {
      checkedAt: (environment.now?.() ?? new Date()).toISOString(),
      latest: manifest.version,
      notesUrl: manifest.notesUrl,
    });
  // Equal to the high-water mark but not active: an installation that an
  // older release rolled back sits below its mark and may return to it.
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
  | Readonly<{
      kind: "up-to-date";
      running: string;
      latest: string;
      folderRefresh: FolderRefresh | null;
    }>
  | Readonly<{
      kind: "updated";
      from: string;
      to: string;
      /** Unsupervised: a running Launchpad finishes the update by restarting. */
      restartRequired: boolean;
      /** The Folder renders an older template revision than `to`. */
      folderRefresh: FolderRefresh | null;
    }>
  | ErrorResult;

/** The Folder's refresh against a product's template revision; nothing when
 * no Folder is known or the product does not say which revision it renders. */
const folderRefresh = (
  environment: Pick<UpdateEnvironment, "folder">,
  productRevision: string | null,
) =>
  environment.folder === undefined || productRevision === null
    ? Promise.resolve(null)
    : folderRefreshNeeded(environment.folder, productRevision);

/** What this executable renders counts only when it is the active one. */
const runningRevision = async (
  environment: Pick<UpdateEnvironment, "base" | "identity">,
) =>
  (await readSelector(environment.base)) === environment.identity.version
    ? instructionTemplateRevision
    : null;

/** `lazurio update [--version <tag>]`, under the lock from the first read of
 * the base to the activation. The candidate proves itself — self-check and,
 * supervised, its Launchpad probe — before the switch; a failure removes it
 * and changes nothing. After the switch nothing is undone.
 */
export const performUpdate = (
  environment: UpdateEnvironment,
  exactVersion?: string,
): Promise<UpdateResult> =>
  settle(async () => {
    const { base, identity, origin, fetcher } = environment;
    await requireInstalled(base);
    return withUpdateLock(base, environment.lockTimeoutMs ?? 0, async () => {
      const migrated = await removeRollbackLeftovers({
        base,
        service: environment.service,
        units: environment.units ?? null,
      });
      const from = await requireInstalled(base);
      const { tag, manifest, available } = await verifiedRelease(
        environment,
        exactVersion,
      );
      // An activation an older updater switched and never finished, whose
      // Launchpad is not healthy: it stays, and nothing newer repairs it here.
      if (
        !available &&
        migrated.marker === "unhealthy" &&
        environment.service !== null
      )
        throw new UpdateFailure("activation-unhealthy", {
          to: migrated.to ?? from,
          stage: "legacy-marker",
        });
      if (!available)
        return Object.freeze({
          kind: "up-to-date" as const,
          running: identity.version,
          latest: manifest.version,
          folderRefresh: await folderRefresh(
            environment,
            await runningRevision(environment),
          ),
        });
      const artifact = manifest.targets[identity.target];
      if (!artifact) throw new UpdateFailure("internal");
      // Scratch is a directory nobody else may use while the lock is held:
      // whatever is in it belongs to an attempt that is over.
      const { scratch } = layout(base);
      await rm(scratch, { recursive: true, force: true });
      let productRevision: string | null;
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
        productRevision = await selfCheckStaged({
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
        // After the switch: a report, never a reason to undo it.
        folderRefresh: await folderRefresh(environment, productRevision),
      });
    });
  });

export type UpdateStatus = Readonly<{
  kind: "status";
  /** Version of the executable answering. */
  running: string;
  /** Version the selector names; null when nothing is installed. */
  active: string | null;
  highWater: string | null;
  supervised: boolean;
  /** Something of the former rollback (a retained previous version, an
   * activation marker, the rollback unit) is left; the next `lazurio update`
   * or `lazurio install` removes it. */
  legacyRollbackState: boolean;
  /** Path of update state no crash can produce; mutating commands refuse. */
  stateInvalid: string | null;
  /** Newest release a check verified and WHEN: an ageing time is how a
   * withheld release becomes visible. */
  lastCheck: LastCheck | null;
  updateAvailable: boolean;
  /** The Folder renders an older template revision than the active product
   * (known only when the one answering is the active one). */
  folderRefresh: FolderRefresh | null;
}>;

/** `lazurio update status`: computed from the paths when asked; no network,
 * no lock, no write. This is what an outside observer reads.
 */
export async function readStatus(
  environment: Pick<
    UpdateEnvironment,
    "base" | "identity" | "service" | "folder" | "units"
  >,
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
  const legacy = await guarded(() =>
    legacyRollbackState(base, environment.units ?? null),
  );
  const floor = await guarded(() => versionFloor(base));
  const lastCheck = await readLastCheck(base);
  const active = await readSelector(base);
  return Object.freeze({
    kind: "status" as const,
    running: identity.version,
    active,
    highWater,
    supervised: environment.service !== null,
    legacyRollbackState: legacy ?? true,
    stateInvalid,
    lastCheck,
    updateAvailable:
      stateInvalid === null &&
      lastCheck !== null &&
      active !== null &&
      floor !== null &&
      compareVersions(lastCheck.latest, floor) >= 0 &&
      compareVersions(lastCheck.latest, active) > 0,
    folderRefresh: await folderRefresh(
      environment,
      active === identity.version ? instructionTemplateRevision : null,
    ),
  });
}
