import { type UpdateError, UpdateFailure, updateError } from "../update/errors";
import { isProductVersion } from "../update/identity";
import type { Activation, Activator } from "../update/launchpad-activation";
import {
  type CheckResult,
  checkForUpdate,
  readStatus,
  type UpdateEnvironment,
  type UpdateStatus,
} from "../update/update";
import { compareVersions } from "../update/version";

/** The Launchpad update pill (docs/update.md "Surfaces"): a poller that runs
 * the one check use case, and a state derived when asked from what is on disk,
 * what the poller last learned and the activation in flight. Nothing here
 * downloads or activates: the action starts `lazurio update` and follows it.
 */
export const pillStates = [
  "idle",
  "checking",
  "available",
  "downloading",
  "activating",
] as const;
export type PillState = (typeof pillStates)[number];
export type PillAction = "update" | "retry" | "restart";

export type PillStatus = Readonly<{
  kind: "update-pill";
  state: PillState;
  running: string;
  active: string | null;
  latest: string | null;
  notesUrl: string | null;
  /** Time of the last verified check; null when none is known. */
  checkedAt: string | null;
  /** The last verified check is older than `staleAfterMs`: shown prominently,
   * changes no state. */
  stale: boolean;
  supervised: boolean;
  /** Unsupervised only: the switch is done and this Launchpad's restart
   * finishes the update. */
  restartRequired: boolean;
  action: PillAction | null;
  error: UpdateError | null;
  stateInvalid: string | null;
}>;

export const staleAfterMs = 24 * 60 * 60_000;

export type PillInput = Readonly<{
  status: UpdateStatus;
  checking: boolean;
  checkError: UpdateError | null;
  activation: Activation;
  now: Date;
  staleAfterMs?: number | undefined;
}>;

/** Pure: the state and the single action for it, from the inputs alone. */
export function derivePillStatus(input: PillInput): PillStatus {
  const { status, activation } = input;
  const { running, active, lastCheck, supervised, pending } = status;
  const floor =
    active !== null && status.highWater !== null
      ? compareVersions(active, status.highWater) >= 0
        ? active
        : status.highWater
      : (active ?? status.highWater);
  const available =
    status.stateInvalid === null &&
    lastCheck !== null &&
    compareVersions(lastCheck.latest, running) > 0 &&
    (floor === null || compareVersions(lastCheck.latest, floor) >= 0);
  // The selector or the marker names a version this Launchpad is not.
  const switched = pending !== null || (active !== null && active !== running);
  // Supervised, switched, nobody finishing it: the updater died between the
  // switch and the restart. The same click reconciles and starts over.
  const interrupted =
    supervised &&
    pending !== null &&
    pending.to !== running &&
    !activation.inFlight;
  const state: PillState = activation.inFlight
    ? switched
      ? "activating"
      : "downloading"
    : interrupted
      ? "available"
      : switched
        ? "activating"
        : input.checking
          ? "checking"
          : available
            ? "available"
            : "idle";
  const error =
    activation.failure ??
    (interrupted
      ? updateError("activation-failed", { reason: "interrupted" })
      : null) ??
    input.checkError;
  const restartRequired = state === "activating" && !supervised;
  const action: PillAction | null =
    state === "available" && lastCheck !== null
      ? error === null
        ? "update"
        : error.code === "reinstall-required"
          ? null
          : "retry"
      : restartRequired
        ? "restart"
        : null;
  const age =
    lastCheck === null
      ? null
      : input.now.getTime() - Date.parse(lastCheck.checkedAt);
  return Object.freeze({
    kind: "update-pill" as const,
    state,
    running,
    active,
    latest: lastCheck?.latest ?? null,
    notesUrl: lastCheck?.notesUrl ?? null,
    checkedAt: lastCheck?.checkedAt ?? null,
    stale: age !== null && age > (input.staleAfterMs ?? staleAfterMs),
    supervised,
    restartRequired,
    action,
    error,
    stateInvalid: status.stateInvalid,
  });
}

/** Injected by tests only; there is no user-facing interval. */
export type PollerOptions = Readonly<{
  startupDelayMs?: number | undefined;
  intervalMs?: number | undefined;
  jitterMs?: number | undefined;
  random?: (() => number) | undefined;
  setTimeout?: ((callback: () => void, ms: number) => unknown) | undefined;
  clearTimeout?: ((timer: unknown) => void) | undefined;
}>;

export const pollerDefaults = Object.freeze({
  startupDelayMs: 30_000,
  intervalMs: 10 * 60_000,
  jitterMs: 60_000,
});

export type UpdatePoller = Readonly<{
  start(): void;
  stop(): void;
  /** The check in flight, or a new one; never two at once. */
  checkNow(): Promise<CheckResult>;
  readonly checking: boolean;
  /** How the last check failed; cleared by the next one that verifies. */
  readonly error: UpdateError | null;
}>;

/** First check shortly after start, then periodically with jitter. A failed
 * check leaves `last-check.json` as it was (the core writes it only after
 * verification), keeps the error for the pill and retries at the next tick.
 */
export function createUpdatePoller(
  check: () => Promise<CheckResult>,
  options: PollerOptions = {},
): UpdatePoller {
  const startupDelayMs =
    options.startupDelayMs ?? pollerDefaults.startupDelayMs;
  const intervalMs = options.intervalMs ?? pollerDefaults.intervalMs;
  const jitterMs = options.jitterMs ?? pollerDefaults.jitterMs;
  const random = options.random ?? Math.random;
  const schedule =
    options.setTimeout ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel =
    options.clearTimeout ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let timer: unknown;
  let started = false;
  let inFlight: Promise<CheckResult> | null = null;
  let error: UpdateError | null = null;
  const checkNow = () => {
    inFlight ??= check()
      .catch(
        (): CheckResult =>
          Object.freeze({ kind: "error" as const, ...updateError("internal") }),
      )
      .then((result) => {
        error =
          result.kind === "error"
            ? updateError(result.code, result.context)
            : null;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const plan = (ms: number) => {
    timer = schedule(() => {
      void checkNow().finally(() => {
        if (started)
          plan(intervalMs + Math.round((random() * 2 - 1) * jitterMs));
      });
    }, ms);
  };
  return Object.freeze({
    start() {
      if (started) return;
      started = true;
      plan(startupDelayMs);
    },
    stop() {
      started = false;
      cancel(timer);
      timer = undefined;
    },
    checkNow,
    get checking() {
      return inFlight !== null;
    },
    get error() {
      return error;
    },
  });
}

export type ApplyResult =
  | Readonly<{ kind: "started"; version: string }>
  /** What the pill showed is no longer what the last check knows. */
  | Readonly<{ kind: "stale"; version: string; latest: string | null }>
  | (Readonly<{ kind: "error" }> & UpdateError);

export type UpdatePill = Readonly<{
  start(): void;
  stop(): void;
  status(): Promise<PillStatus>;
  apply(version: string): Promise<ApplyResult>;
}>;

export function createUpdatePill(input: {
  environment: UpdateEnvironment;
  activator: Activator;
  poller?: PollerOptions | undefined;
  now?: (() => Date) | undefined;
}): UpdatePill {
  const { environment, activator } = input;
  const now = input.now ?? (() => new Date());
  const poller = createUpdatePoller(
    () => checkForUpdate(environment),
    input.poller,
  );
  return Object.freeze({
    start: poller.start,
    stop: poller.stop,
    async status() {
      return derivePillStatus({
        status: await readStatus(environment),
        checking: poller.checking,
        checkError: poller.error,
        activation: await activator.observe(),
        now: now(),
      });
    },
    async apply(version) {
      const failed = (failure: UpdateError): ApplyResult =>
        Object.freeze({ kind: "error" as const, ...failure });
      if (!isProductVersion(version))
        return failed(updateError("internal", { reason: "version" }));
      const status = await readStatus(environment);
      if (status.stateInvalid !== null)
        return failed(
          updateError("state-invalid", { path: status.stateInvalid }),
        );
      const latest = status.lastCheck?.latest ?? null;
      if (latest !== version) {
        // The click meant what it saw; a fresh check shows what is true now.
        void poller.checkNow();
        return Object.freeze({ kind: "stale" as const, version, latest });
      }
      if ((await activator.observe()).inFlight)
        return failed(updateError("busy"));
      try {
        await activator.start(version);
      } catch (error) {
        return failed(
          error instanceof UpdateFailure
            ? error.failure
            : updateError("internal", { stage: "start" }),
        );
      }
      return Object.freeze({ kind: "started" as const, version });
    },
  });
}
