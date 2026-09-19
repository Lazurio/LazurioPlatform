import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { folderStateSchemas } from "../folder/state";
import {
  type ActivationRecord,
  activationRecordPath,
  clearPrevious,
  readActivationRecord,
  removeActivationRecord,
  type ServiceSpec,
  writeActivationRecord,
  writePrevious,
} from "./activation-record";
import { type DurableWriter, writeDurableFile } from "./durable-file";
import {
  type ErrorContext,
  type UpdateError,
  type UpdateErrorCode,
  UpdateFailure,
  updateError,
  updateErrors,
} from "./errors";
import {
  layout,
  parseVersionName,
  readSelector,
  swapSelector,
  versionDirectory,
  versionExecutable,
  versionName,
} from "./layout";
import { acquireUpdateLock, type UpdateLock } from "./lock";
import { type Observed, readObserved, writeObserved } from "./observed";
import {
  createStabilityTracker,
  evaluateReadiness,
  pidAlive,
} from "./readiness";
import { type ProcessRunner, requireSelfCheck, runProcess } from "./self-check";
import { createServiceControl, type ServiceControl } from "./service-control";
import {
  canRead,
  parseSignedIdentity,
  type SignedIdentity,
  type StateSchemas,
} from "./signed-identity";
import { removeVersion, sha256File } from "./stage";

/** Activate (docs/update.md "Activate"). The selector `bin/lazurio` is the
 * only thing an activation changes about the product; `update/activation.json`
 * exists exactly while that change is unconfirmed.
 *
 * Two locks, two meanings:
 *  - the STEP lock (`update/lock`) serializes every mutation of the base. The
 *    worker holds it while it switches and again while it settles, and
 *    RELEASES it while it waits for the restarted Launchpad, which needs it;
 *  - the ACTIVATION lock (`update/activation.lock`) is held by a worker for
 *    its whole life and released by the kernel when it dies — `kill -9`
 *    included. "Held" therefore means "a worker is alive and owns the
 *    record"; "free with a record present" means "the worker died", and
 *    whoever holds it next finishes or undoes the record.
 */
export type ActivationEffects = Readonly<{
  write: DurableWriter;
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
  swapSelector: typeof swapSelector;
  /** Runs self-checks and service manager commands. */
  run: ProcessRunner;
  pidAlive: (pid: number) => boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** Replace the service adapter derived from the record's `service`. */
  service?: (spec: ServiceSpec) => ServiceControl;
}>;

export const systemActivationEffects: ActivationEffects = Object.freeze({
  write: writeDurableFile,
  clock: () => new Date(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  swapSelector,
  run: runProcess,
  pidAlive,
  env: process.env,
});

export type ActivationPolicy = Readonly<{
  /** From the switch to a confirmed candidate, or the switch is undone. */
  deadlineMs: number;
  /** How long a fresh Launchpad must stay ready (`systemd-user`). */
  stabilityMs: number;
  pollMs: number;
  lockTimeoutMs: number;
  /** Waiting to settle an activation that is already switched. */
  settleLockTimeoutMs: number;
  selfCheckTimeoutMs: number;
}>;

export const defaultActivationPolicy: ActivationPolicy = Object.freeze({
  deadlineMs: 120_000,
  stabilityMs: 10_000,
  pollMs: 500,
  lockTimeoutMs: 30_000,
  settleLockTimeoutMs: 300_000,
  selfCheckTimeoutMs: 30_000,
});

export type ActivationOutcome =
  | Readonly<{
      kind: "confirmed";
      version: string;
      candidate: string;
      previous: string;
    }>
  | Readonly<{ kind: "already-active"; version: string; candidate: string }>
  | (Readonly<{ kind: "error" }> & UpdateError);

const failed = (code: UpdateErrorCode, context: ErrorContext = {}) =>
  Object.freeze({ kind: "error" as const, ...updateError(code, context) });

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** The schema versions the running (active) product WRITES: the newest of
 * each document it knows. A rollback target must be able to read them.
 */
export const writtenSchemas = (): StateSchemas =>
  Object.freeze({
    preferences: [Math.max(...folderStateSchemas.preferences)],
    manifest: [Math.max(...folderStateSchemas.manifest)],
  });

async function readStagedIdentity(
  base: string,
  name: string,
): Promise<SignedIdentity> {
  const identity = parseSignedIdentity(
    await readFile(join(versionDirectory(base, name), "identity.json")),
  );
  if (versionName(identity.version, identity.artifactSha256) !== name)
    throw new UpdateFailure("artifact-invalid", { reason: "staged-name" });
  return identity;
}

async function observe(
  base: string,
  effects: ActivationEffects,
  change: (previous: Observed, at: string) => Partial<Observed>,
): Promise<void> {
  try {
    const now = effects.clock();
    const previous = await readObserved(base, now);
    const next = { ...previous, ...change(previous, now.toISOString()) };
    await writeObserved(
      base,
      Object.freeze({
        ...next,
        observedAt: now.toISOString(),
        canRetry: next.error ? updateErrors[next.error.code].retryable : false,
      }),
      effects.write,
    );
  } catch {
    // An observation never decides an activation.
  }
}

/** Keep the active version, the one it replaced and whatever a live Launchpad
 * still runs; remove every other staged version and all scratch. Under the
 * step lock only. Entries that are not version names are not ours.
 */
export async function applyRetention(
  base: string,
  keep: ReadonlySet<string>,
  running: string | null,
): Promise<void> {
  const paths = layout(base);
  for (const entry of await readdir(paths.versions).catch(() => [])) {
    const parsed = parseVersionName(entry);
    if (!parsed || keep.has(entry)) continue;
    if (running?.startsWith(parsed.sha16)) continue;
    await removeVersion(base, entry);
  }
  for (const entry of await readdir(paths.update).catch(() => []))
    if (entry.startsWith("scratch-"))
      await rm(join(paths.update, entry), { recursive: true, force: true });
}

type Settled = Readonly<{ kind: "confirmed" | "rolled-back" }>;

async function confirm(
  base: string,
  record: ActivationRecord,
  effects: ActivationEffects,
  service: ServiceControl,
): Promise<Settled> {
  // `previous.json` first: a crash after it and before the record is removed
  // is a record that a later start confirms again, idempotently.
  // It is tolerant state: if it cannot be written even after clearing whatever
  // occupies its place, a rollback is simply not offered — a confirmed
  // activation never fails, and never stays unconfirmed, because of it.
  try {
    await writePrevious(base, record.previous, effects.write);
  } catch {
    await clearPrevious(base);
    await writePrevious(base, record.previous, effects.write).catch(
      () => undefined,
    );
  }
  await removeActivationRecord(base);
  const version = parseVersionName(record.candidate)?.version as string;
  await observe(base, effects, (_, at) => ({
    // After a rollback a newer version exists again; the next check says so.
    status: record.kind === "rollback" ? "idle" : "up-to-date",
    operationId: record.operation,
    available: null,
    downloadPercent: null,
    error: null,
    lastHealthyActivation: { version, confirmedAt: at },
  }));
  try {
    const live = await service.launchpadReadiness();
    await applyRetention(
      base,
      new Set([record.candidate, record.previous]),
      live && effects.pidAlive(live.pid) ? live.artifactSha256 : null,
    );
  } catch {
    // Retention is housekeeping; the next confirmed activation repeats it.
  }
  return { kind: "confirmed" };
}

async function rollBack(
  base: string,
  record: ActivationRecord,
  effects: ActivationEffects,
  error: UpdateError,
): Promise<Settled> {
  // Selector first, record second: a crash in between leaves a record whose
  // undo is simply repeated.
  await effects.swapSelector(base, record.previous);
  await removeActivationRecord(base);
  await observe(base, effects, () => ({
    status: "error",
    operationId: record.operation,
    downloadPercent: null,
    error,
  }));
  return { kind: "rolled-back" };
}

/** One look at a `confirming` record: is the candidate confirmed NOW? */
async function candidateConfirmedNow(
  base: string,
  record: ActivationRecord,
  effects: ActivationEffects,
  service: ServiceControl,
  policy: ActivationPolicy,
): Promise<"confirmed" | "failed" | "unknown"> {
  let identity: SignedIdentity;
  try {
    identity = await readStagedIdentity(base, record.candidate);
  } catch {
    return "failed";
  }
  if (service.kind === "none") {
    // Through the selector: exactly what the next launch will execute.
    try {
      await requireSelfCheck({
        executable: layout(base).selector,
        expected: identity,
        folder: record.folder ?? undefined,
        timeoutMs: policy.selfCheckTimeoutMs,
        run: effects.run,
      });
      return "confirmed";
    } catch {
      return "failed";
    }
  }
  const readiness = await service.launchpadReadiness();
  const verdict = evaluateReadiness({
    readiness,
    expectedSha256: identity.artifactSha256,
    switchedAt: new Date(record.switchedAt as string),
    pidAlive: effects.pidAlive,
  });
  // Without the worker nobody watched the stability period, so the instance
  // itself must already be older than it.
  return verdict === "ready" &&
    readiness &&
    effects.clock().getTime() - Date.parse(readiness.startedAt) >=
      policy.stabilityMs
    ? "confirmed"
    : "unknown";
}

export type ResumeResult =
  | Readonly<{ kind: "none" }>
  /** A live worker owns the record, or its deadline has not passed yet. */
  | Readonly<{ kind: "in-progress" }>
  | Readonly<{ kind: "confirmed"; candidate: string }>
  | Readonly<{ kind: "rolled-back"; previous: string }>
  /** The record was unreadable and was removed; the selector was not touched. */
  | Readonly<{ kind: "discarded" }>;

/** Finish or undo an activation whose worker is gone. Any `lazurio` start may
 * call this: without a record it costs one failed `readFile` and writes
 * nothing. It never blocks on, and never undoes, a live worker.
 *
 * The decision is a function of the record and of facts on disk only, so
 * repeating it — after another crash, from another process — gives the same
 * end state:
 *   - unreadable record                    → removed, selector untouched
 *   - `switching`                          → previous restored (the switch
 *                                            was never acknowledged)
 *   - candidate missing, or deadline past  → previous restored
 *   - `confirming`, candidate confirmed    → confirmed
 *   - `confirming`, `none`, not confirmed  → previous restored
 *   - `confirming`, service, not yet ready → left for a later start
 */
export async function resumeActivation(input: {
  base: string;
  effects?: Partial<ActivationEffects>;
  policy?: Partial<ActivationPolicy>;
}): Promise<ResumeResult> {
  const { base } = input;
  // The whole cost of a start without an activation: one `lstat`.
  if (!(await exists(activationRecordPath(base)))) return { kind: "none" };
  const effects = { ...systemActivationEffects, ...input.effects };
  const policy = { ...defaultActivationPolicy, ...input.policy };
  const paths = layout(base);
  let liveness: UpdateLock;
  try {
    liveness = await acquireUpdateLock(paths.activationLock, { timeoutMs: 0 });
  } catch {
    return { kind: "in-progress" };
  }
  try {
    let step: UpdateLock;
    try {
      step = await acquireUpdateLock(paths.stepLock, {
        timeoutMs: policy.lockTimeoutMs,
      });
    } catch {
      return { kind: "in-progress" };
    }
    try {
      return await settleAbandoned(base, effects, policy);
    } finally {
      await step.release();
    }
  } finally {
    await liveness.release();
  }
}

/** Under both locks. */
async function settleAbandoned(
  base: string,
  effects: ActivationEffects,
  policy: ActivationPolicy,
): Promise<ResumeResult> {
  const state = await readActivationRecord(base);
  if (state.kind === "absent") return { kind: "none" };
  if (state.kind === "invalid") {
    await removeActivationRecord(base);
    await observe(base, effects, () => ({
      status: "error",
      downloadPercent: null,
      error: updateError("activation-interrupted", { reason: "record" }),
    }));
    return { kind: "discarded" };
  }
  const { record } = state;
  const service = (effects.service ?? defaultService(base, effects))(
    record.service,
  );
  const candidatePresent = await exists(
    versionExecutable(base, record.candidate),
  );
  const previousPresent = await exists(
    versionExecutable(base, record.previous),
  );
  const interrupted = (reason: string) =>
    updateError("activation-interrupted", {
      reason,
      phase: record.phase,
      rolledBackTo: parseVersionName(record.previous)?.version ?? "",
    });
  const undo = async (reason: string): Promise<ResumeResult> => {
    await rollBack(base, record, effects, interrupted(reason));
    // A Launchpad may be running the candidate; put it on what is selected.
    if (service.kind !== "none")
      await service.restartLaunchpad().catch(() => undefined);
    return { kind: "rolled-back", previous: record.previous };
  };
  // Nothing to go back to: the candidate is the only executable left.
  if (!previousPresent && candidatePresent) {
    await effects.swapSelector(base, record.candidate);
    await confirm(base, record, effects, service);
    return { kind: "confirmed", candidate: record.candidate };
  }
  if (record.phase === "switching") return undo("switching");
  if (!candidatePresent) return undo("candidate-missing");
  if (effects.clock().getTime() > Date.parse(record.deadline))
    return undo("deadline");
  const verdict = await candidateConfirmedNow(
    base,
    record,
    effects,
    service,
    policy,
  );
  if (verdict === "confirmed") {
    await confirm(base, record, effects, service);
    return { kind: "confirmed", candidate: record.candidate };
  }
  return verdict === "failed" ? undo("not-confirmed") : { kind: "in-progress" };
}

const defaultService =
  (base: string, effects: ActivationEffects) => (spec: ServiceSpec) =>
    createServiceControl(spec, { base, run: effects.run, env: effects.env });

export type WorkerInput = Readonly<{
  base: string;
  candidate: string;
  operation: string;
  kind: "update" | "rollback";
  service: ServiceSpec;
  folder?: string | undefined;
  policy?: Partial<ActivationPolicy> | undefined;
  effects?: Partial<ActivationEffects> | undefined;
  /** What a rollback target must be able to read; default: what this
   * executable writes. */
  requiredSchemas?: StateSchemas | undefined;
}>;

/** The activation worker. It is executed FROM THE PREVIOUS, known-good
 * immutable executable (`versions/<previous>/lazurio update apply-worker`),
 * because a candidate that cannot start cannot supervise its own rollback.
 * Expected failures are returned; after any of them the selector names a
 * version that works.
 */
export async function runActivationWorker(
  input: WorkerInput,
): Promise<ActivationOutcome> {
  const { base } = input;
  const effects = { ...systemActivationEffects, ...input.effects };
  const policy = { ...defaultActivationPolicy, ...input.policy };
  const paths = layout(base);
  const candidate = parseVersionName(input.candidate);
  if (!candidate || !/^[A-Za-z0-9-]{1,64}$/.test(input.operation))
    return failed("invalid-request");
  let liveness: UpdateLock;
  try {
    liveness = await acquireUpdateLock(paths.activationLock, { timeoutMs: 0 });
  } catch (error) {
    return error instanceof UpdateFailure
      ? failed(error.failure.code, { reason: "activation" })
      : failed("storage-unavailable", { stage: "activation-lock" });
  }
  try {
    return await work(input, effects, policy);
  } catch (error) {
    if (error instanceof UpdateFailure)
      return failed(error.failure.code, error.failure.context);
    return failed("internal", { stage: "activation" });
  } finally {
    await liveness.release();
  }
}

type Begun = Readonly<{ record: ActivationRecord; identity: SignedIdentity }>;

/** Continue this worker's own record after a restart. Refuses (throws or
 * returns undefined) when the record can no longer be carried forward; the
 * caller then settles it like any abandoned record.
 */
async function adopt(
  base: string,
  own: ActivationRecord,
  effects: ActivationEffects,
): Promise<Begun | undefined> {
  if (effects.clock().getTime() > Date.parse(own.deadline)) return undefined;
  if (!(await exists(versionExecutable(base, own.previous)))) return undefined;
  const identity = await readStagedIdentity(base, own.candidate);
  if (own.phase === "confirming") return { record: own, identity };
  await effects.swapSelector(base, own.candidate);
  const record: ActivationRecord = Object.freeze({
    ...own,
    phase: "confirming",
    switchedAt: effects.clock().toISOString(),
  });
  await writeActivationRecord(base, record, effects.write);
  return { record, identity };
}

/** Decide, record, switch. Under the step lock. */
async function begin(
  input: WorkerInput,
  effects: ActivationEffects,
  policy: ActivationPolicy,
  version: string,
): Promise<Begun | ActivationOutcome> {
  const { base } = input;
  let record: ActivationRecord;
  let identity: SignedIdentity;
  const previous = await readSelector(base);
  if (previous === null) return failed("not-installed");
  if (previous === input.candidate)
    return { kind: "already-active", version, candidate: input.candidate };
  try {
    identity = await readStagedIdentity(base, input.candidate);
  } catch (error) {
    if (input.kind === "rollback")
      return failed("rollback-unavailable", { reason: "missing" });
    throw error instanceof UpdateFailure
      ? error
      : new UpdateFailure("artifact-invalid", { reason: "staged" });
  }
  if (
    (await sha256File(versionExecutable(base, input.candidate)).catch(
      () => "",
    )) !== identity.artifactSha256
  )
    return input.kind === "rollback"
      ? failed("rollback-unavailable", { reason: "damaged" })
      : failed("artifact-invalid", { reason: "staged" });
  // Program rollback is not data rollback: only to a version that reads
  // what the current one wrote.
  if (
    input.kind === "rollback" &&
    !canRead(identity.schemas, input.requiredSchemas ?? writtenSchemas())
  )
    return failed("rollback-unavailable", { reason: "schema", version });
  const at = effects.clock();
  record = Object.freeze({
    schemaVersion: 1,
    operation: input.operation,
    kind: input.kind,
    previous,
    candidate: input.candidate,
    phase: "switching",
    deadline: new Date(at.getTime() + policy.deadlineMs).toISOString(),
    switchedAt: null,
    service: input.service,
    folder: input.folder ?? null,
  });
  try {
    await writeActivationRecord(base, record, effects.write);
    await effects.swapSelector(base, input.candidate);
    record = Object.freeze({
      ...record,
      phase: "confirming",
      switchedAt: effects.clock().toISOString(),
    });
    await writeActivationRecord(base, record, effects.write);
  } catch {
    // Still under the lock: undo what was done, in the recovery order.
    await rollBack(
      base,
      record,
      effects,
      updateError("activation-failed", { reason: "switch" }),
    ).catch(() => undefined);
    return failed("activation-failed", { reason: "switch" });
  }
  return { record, identity };
}

async function work(
  input: WorkerInput,
  effects: ActivationEffects,
  policy: ActivationPolicy,
): Promise<ActivationOutcome> {
  const { base } = input;
  const paths = layout(base);
  const version = parseVersionName(input.candidate)?.version as string;
  const service = (effects.service ?? defaultService(base, effects))(
    input.service,
  );
  const lockStep = (timeoutMs: number) =>
    acquireUpdateLock(paths.stepLock, { timeoutMs });

  // Phase 1, under the step lock: decide, record, switch.
  let record: ActivationRecord;
  let identity: SignedIdentity;
  let step = await lockStep(policy.lockTimeoutMs);
  try {
    // A record here belongs to a dead worker (the activation lock is ours).
    const found = await readActivationRecord(base);
    const own =
      found.kind === "record" &&
      found.record.operation === input.operation &&
      found.record.candidate === input.candidate
        ? found.record
        : undefined;
    const adopted = own
      ? await adopt(base, own, effects).catch(() => undefined)
      : undefined;
    if (adopted) {
      // This worker was restarted by its supervisor after it died: the same
      // operation continues under its original deadline.
      ({ record, identity } = adopted);
    } else {
      const abandoned = await settleAbandoned(base, effects, policy);
      if (abandoned.kind === "in-progress")
        return failed("busy", { reason: "activation" });
      // An operation is not begun a second time once it was settled.
      if (own)
        return abandoned.kind === "confirmed"
          ? {
              kind: "confirmed",
              version,
              candidate: own.candidate,
              previous: own.previous,
            }
          : failed("activation-interrupted", { resumed: abandoned.kind });
      const begun = await begin(input, effects, policy, version);
      if ("kind" in begun) return begun;
      ({ record, identity } = begun);
    }
    await observe(base, effects, () => ({
      status: "activating",
      operationId: input.operation,
      downloadPercent: null,
      error: null,
    }));
  } finally {
    // Released before the restart: the Launchpad needs it to start.
    await step.release();
  }

  // Phase 2, without the step lock: restart and wait for a fresh instance.
  let reason = "not-confirmed";
  let confirmed = false;
  if (service.kind === "none") {
    confirmed =
      (await candidateConfirmedNow(base, record, effects, service, policy)) ===
      "confirmed";
    if (!confirmed) reason = "self-check";
  } else {
    try {
      await service.restartLaunchpad();
      const stable = createStabilityTracker(policy.stabilityMs);
      const deadline = Date.parse(record.deadline);
      while (effects.clock().getTime() <= deadline) {
        const readiness = await service.launchpadReadiness();
        const verdict = evaluateReadiness({
          readiness,
          expectedSha256: identity.artifactSha256,
          switchedAt: new Date(record.switchedAt as string),
          pidAlive: effects.pidAlive,
        });
        reason = verdict;
        if (stable(effects.clock().getTime(), verdict, readiness)) {
          confirmed = true;
          break;
        }
        await effects.sleep(policy.pollMs);
      }
      if (!confirmed && reason === "ready") reason = "unstable";
    } catch {
      reason = "restart";
    }
  }

  // Phase 3, under the step lock again: confirm or undo.
  // If even this wait fails, the record stays and the next start settles it.
  step = await lockStep(policy.settleLockTimeoutMs);
  try {
    if (confirmed) {
      await confirm(base, record, effects, service);
      return {
        kind: "confirmed",
        version,
        candidate: record.candidate,
        previous: record.previous,
      };
    }
    const error = updateError("activation-failed", {
      reason,
      rolledBackTo: parseVersionName(record.previous)?.version ?? "",
    });
    await rollBack(base, record, effects, error);
    return { kind: "error", ...error };
  } finally {
    await step.release();
    if (!confirmed && service.kind !== "none")
      await service.restartLaunchpad().catch(() => undefined);
  }
}
