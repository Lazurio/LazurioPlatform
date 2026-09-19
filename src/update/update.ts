import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActivationEffects,
  type ActivationOutcome,
  type ActivationPolicy,
  defaultActivationPolicy,
  resumeActivation,
  writtenSchemas,
} from "./activate";
import { readPrevious, type ServiceSpec } from "./activation-record";
import { type AvailableStep, type CheckInput, checkForUpdate } from "./check";
import {
  artifactUrl,
  type DownloadEffects,
  type DownloadPolicy,
  downloadArtifact,
  downloadSignedIdentity,
  type RangeOpener,
} from "./download";
import {
  type ErrorContext,
  type UpdateError,
  type UpdateErrorCode,
  UpdateFailure,
  updateError,
} from "./errors";
import {
  parseVersionName,
  readSelector,
  versionDirectory,
  versionExecutable,
  versionName,
} from "./layout";
import { type ProcessRunner, requireSelfCheck } from "./self-check";
import { serviceEnvironment, workerCommand } from "./service-control";
import type { StateSchemas } from "./signed-identity";
import { removeVersion, stageCandidate, stagedMatches } from "./stage";

/** The update use case behind `lazurio update` and, later, the Launchpad
 * action: check → download → stage → activate (docs/update.md "The three
 * steps"). Expected failures are returned, never thrown, and each of them
 * leaves the selected version working and the same call repeatable.
 */
export type UpdateEvent =
  | Readonly<{ kind: "downloading"; version: string; percent: number }>
  | Readonly<{ kind: "staging"; version: string }>
  | Readonly<{ kind: "activating"; version: string }>;

export type WorkerLauncher = (
  command: readonly string[],
) => Promise<Readonly<{ exitCode: number; stdout: string }>>;

export type UpdateInput = CheckInput &
  Readonly<{
    service: ServiceSpec;
    openRange: RangeOpener;
    downloadOnly?: boolean;
    /** Folder whose state a candidate must prove it can read. */
    folder?: string;
    /** Schema versions a candidate must read; default: what this writes. */
    requiredSchemas?: StateSchemas;
    downloadEffects?: DownloadEffects;
    downloadPolicy?: Partial<DownloadPolicy>;
    activationPolicy?: Partial<ActivationPolicy>;
    activationEffects?: Partial<ActivationEffects>;
    run?: ProcessRunner;
    launchWorker?: WorkerLauncher;
    onEvent?: (event: UpdateEvent) => void;
  }>;

export type UpdateResult =
  | Readonly<{ kind: "up-to-date"; version: string }>
  /** Staged and verified; not activated (`--download-only`). */
  | Readonly<{ kind: "ready"; version: string; staged: string }>
  | Readonly<{ kind: "updated"; version: string; previous: string }>
  | (Readonly<{ kind: "error" }> & UpdateError);

const failed = (code: UpdateErrorCode, context: ErrorContext = {}) =>
  Object.freeze({ kind: "error" as const, ...updateError(code, context) });

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Detached: its own session, so a signal to the caller's process group — a
 * closed terminal, Ctrl-C — does not reach the worker mid-switch.
 */
export const launchDetachedWorker: WorkerLauncher = async (command) => {
  const child = Bun.spawn([...command], {
    detached: true,
    env: { ...serviceEnvironment(process.env) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
};

export function workerArguments(input: {
  base: string;
  candidate: string;
  operation: string;
  kind: "update" | "rollback";
  service: ServiceSpec;
  folder?: string | undefined;
  policy: ActivationPolicy;
}): string[] {
  return [
    "update",
    "apply-worker",
    "--base",
    input.base,
    "--candidate",
    input.candidate,
    "--operation",
    input.operation,
    "--kind",
    input.kind,
    "--service",
    input.service.kind,
    ...(input.service.kind === "systemd-user"
      ? ["--unit", input.service.unit]
      : []),
    ...(input.folder === undefined ? [] : ["--folder", input.folder]),
    "--deadline-ms",
    String(input.policy.deadlineMs),
    "--stability-ms",
    String(input.policy.stabilityMs),
  ];
}

function parseOutcome(stdout: string): ActivationOutcome | undefined {
  try {
    const value = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as
      | ActivationOutcome
      | undefined;
    return value &&
      ["confirmed", "already-active", "error"].includes(value.kind)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Ask for an activation of a staged version. The worker is started from the
 * CURRENTLY SELECTED immutable executable — the known-good one — never from
 * the candidate and never from whatever binary happens to run this call.
 */
export async function requestActivation(input: {
  base: string;
  candidate: string;
  kind: "update" | "rollback";
  service: ServiceSpec;
  operation?: string | undefined;
  folder?: string | undefined;
  policy?: Partial<ActivationPolicy> | undefined;
  effects?: Partial<ActivationEffects> | undefined;
  launchWorker?: WorkerLauncher | undefined;
}): Promise<ActivationOutcome> {
  const { base, candidate } = input;
  const version = parseVersionName(candidate)?.version;
  if (version === undefined) return failed("invalid-request");
  const resume = () =>
    resumeActivation({
      base,
      ...(input.effects ? { effects: input.effects } : {}),
      ...(input.policy ? { policy: input.policy } : {}),
    });
  // While a record exists the selector may name an UNCONFIRMED candidate, and
  // a worker must never be started from one.
  if ((await resume()).kind === "in-progress")
    return failed("busy", { reason: "activation" });
  const selected = await readSelector(base);
  if (selected === null) return failed("not-installed");
  if (selected === candidate)
    return { kind: "already-active", version, candidate };
  const operation = input.operation ?? randomUUID();
  const command = workerCommand(
    input.service,
    [
      versionExecutable(base, selected),
      ...workerArguments({
        base,
        candidate,
        operation,
        kind: input.kind,
        service: input.service,
        folder: input.folder,
        policy: { ...defaultActivationPolicy, ...input.policy },
      }),
    ],
    operation,
  );
  let outcome: ActivationOutcome | undefined;
  try {
    outcome = parseOutcome(
      (await (input.launchWorker ?? launchDetachedWorker)(command)).stdout,
    );
  } catch {
    return failed("activation-failed", { reason: "worker-start" });
  }
  if (outcome) return outcome;
  // The worker died without an answer. Converge exactly as any later start
  // would, then report what is true now.
  const resumed = await resume();
  if (resumed.kind === "confirmed" && resumed.candidate === candidate)
    return { kind: "confirmed", version, candidate, previous: selected };
  return failed("activation-interrupted", { resumed: resumed.kind });
}

export async function performUpdate(input: UpdateInput): Promise<UpdateResult> {
  const { base } = input;
  // An unfinished activation is settled first; a live one owns the base.
  if (
    (
      await resumeActivation({
        base,
        ...(input.activationEffects
          ? { effects: input.activationEffects }
          : {}),
        ...(input.activationPolicy ? { policy: input.activationPolicy } : {}),
      })
    ).kind === "in-progress"
  )
    return failed("busy", { reason: "activation" });
  const selected = await readSelector(base);
  if (selected === null) return failed("not-installed");

  const step: AvailableStep = async (session) => {
    const { bytes, identity } = await downloadSignedIdentity(session, {
      target: input.identity.target,
      requiredSchemas: input.requiredSchemas ?? writtenSchemas(),
    });
    const name = versionName(identity.version, identity.artifactSha256);
    if (await exists(versionDirectory(base, name))) {
      if (
        await stagedMatches(base, name, {
          artifactSha256: identity.artifactSha256,
          identityBytes: bytes,
        })
      ) {
        // An explicit retry re-runs the whole gate, not only the download.
        if (name !== selected)
          await requireSelfCheck({
            executable: versionExecutable(base, name),
            expected: identity,
            folder: input.folder,
            run: input.run,
          });
        return name;
      }
      if (name === selected)
        throw new UpdateFailure("artifact-invalid", { reason: "selected" });
      await removeVersion(base, name);
    }
    const artifactFile = join(session.scratch, "artifact");
    let reported = -1;
    let reportedAt = 0;
    let recording: Promise<void> = Promise.resolve();
    await downloadArtifact({
      url: artifactUrl(input.targetBaseUrl, session.artifact),
      artifact: session.artifact,
      destination: artifactFile,
      directory: session.scratch,
      openRange: input.openRange,
      ...(input.downloadEffects ? { effects: input.downloadEffects } : {}),
      ...(input.downloadPolicy ? { policy: input.downloadPolicy } : {}),
      onProgress(received, total) {
        const percent = Math.floor((received * 100) / total);
        const now = performance.now();
        if (percent === reported || (percent < 100 && now - reportedAt < 250))
          return;
        reported = percent;
        reportedAt = now;
        input.onEvent?.({
          kind: "downloading",
          version: identity.version,
          percent,
        });
        recording = recording.then(() => session.progress(percent));
      },
    });
    await recording;
    input.onEvent?.({ kind: "staging", version: identity.version });
    return stageCandidate({
      base,
      scratch: session.scratch,
      artifactFile,
      identityBytes: bytes,
      identity,
      folder: input.folder,
      run: input.run,
    });
  };

  const checked = await checkForUpdate(input, step);
  if (checked.kind === "error") return checked;
  if (checked.kind === "up-to-date")
    return { kind: "up-to-date", version: checked.version };
  if (checked.staged === undefined)
    return failed("internal", { stage: "step" });
  if (input.downloadOnly)
    return { kind: "ready", version: checked.version, staged: checked.staged };
  input.onEvent?.({ kind: "activating", version: checked.version });
  const outcome = await requestActivation({
    base,
    candidate: checked.staged,
    kind: "update",
    service: input.service,
    folder: input.folder,
    policy: input.activationPolicy,
    effects: input.activationEffects,
    launchWorker: input.launchWorker,
  });
  if (outcome.kind === "error") return outcome;
  return outcome.kind === "confirmed"
    ? {
        kind: "updated",
        version: outcome.version,
        previous: parseVersionName(outcome.previous)?.version ?? "",
      }
    : { kind: "up-to-date", version: outcome.version };
}

export type RollbackResult =
  | Readonly<{ kind: "rolled-back"; version: string; from: string }>
  | (Readonly<{ kind: "error" }> & UpdateError);

/** `lazurio update rollback`: an activation of the version the last confirmed
 * activation replaced — same record, same worker, same confirmation. The
 * worker refuses a target that cannot read what the current version writes.
 */
export async function performRollback(input: {
  base: string;
  service: ServiceSpec;
  folder?: string | undefined;
  policy?: Partial<ActivationPolicy> | undefined;
  effects?: Partial<ActivationEffects> | undefined;
  launchWorker?: WorkerLauncher | undefined;
}): Promise<RollbackResult> {
  const { base } = input;
  if (
    (
      await resumeActivation({
        base,
        ...(input.effects ? { effects: input.effects } : {}),
        ...(input.policy ? { policy: input.policy } : {}),
      })
    ).kind === "in-progress"
  )
    return failed("busy", { reason: "activation" });
  const selected = await readSelector(base);
  if (selected === null) return failed("not-installed");
  const previous = await readPrevious(base);
  if (previous === null || previous === selected)
    return failed("rollback-unavailable", { reason: "no-previous" });
  if (!(await exists(versionExecutable(base, previous))))
    return failed("rollback-unavailable", { reason: "missing" });
  const outcome = await requestActivation({
    base,
    candidate: previous,
    kind: "rollback",
    service: input.service,
    folder: input.folder,
    policy: input.policy,
    effects: input.effects,
    launchWorker: input.launchWorker,
  });
  if (outcome.kind === "error") return outcome;
  return {
    kind: "rolled-back",
    version: outcome.version,
    from: parseVersionName(selected)?.version ?? "",
  };
}
