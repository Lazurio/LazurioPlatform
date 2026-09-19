import type { ServiceSpec } from "./activation-record";
import { type LaunchpadReadiness, readLaunchpadReadiness } from "./readiness";
import type { ProcessRunner } from "./self-check";

/** The part of the OS service manager an activation needs, and nothing more
 * (docs/update.md "One supervisor per OS"). `none`: no Launchpad service is
 * managed on this Machine, so there is nothing to restart and an activation is
 * confirmed by running the new executable through the selector. `systemd-user`
 * is the Linux supervisor. macOS launchd is deliberately not implemented.
 */
export interface ServiceControl {
  readonly kind: ServiceSpec["kind"];
  restartLaunchpad(): Promise<void>;
  launchpadReadiness(): Promise<LaunchpadReadiness | null>;
}

export const systemdRestartCommand = (unit: string): readonly string[] =>
  Object.freeze(["systemctl", "--user", "restart", unit]);

/** A candidate that crash-looped leaves the unit in `start-limit-hit`, and
 * systemd then refuses even a manual restart ("Start request repeated too
 * quickly") — exactly when the previous version must be brought back.
 */
export const systemdResetFailedCommand = (unit: string): readonly string[] =>
  Object.freeze(["systemctl", "--user", "reset-failed", unit]);

export const serviceCommandTimeoutMs = 60_000;

/** The variables a user-session service manager client needs, and no others. */
export function serviceEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of [
    "HOME",
    "PATH",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
  ]) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  return Object.freeze(result);
}

export function createServiceControl(
  spec: ServiceSpec,
  input: Readonly<{
    base: string;
    run: ProcessRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): ServiceControl {
  if (spec.kind === "none")
    return Object.freeze({
      kind: "none" as const,
      async restartLaunchpad() {},
      async launchpadReadiness() {
        return null;
      },
    });
  return Object.freeze({
    kind: "systemd-user" as const,
    async restartLaunchpad() {
      // Its exit status says only whether there was anything to reset.
      await input
        .run(
          systemdResetFailedCommand(spec.unit),
          serviceCommandTimeoutMs,
          serviceEnvironment(input.env),
        )
        .catch(() => undefined);
      const result = await input.run(
        systemdRestartCommand(spec.unit),
        serviceCommandTimeoutMs,
        serviceEnvironment(input.env),
      );
      if (result === "timeout" || result.exitCode !== 0)
        throw new Error("Service restart failed");
    },
    launchpadReadiness: () => readLaunchpadReadiness(input.base),
  });
}

/** How the activation worker is started so that it survives what it restarts.
 * Under systemd a child of the Launchpad lives in the Launchpad's control
 * group and dies with `systemctl restart`, so the worker becomes its own
 * transient unit; `--wait --pipe` returns its result line and exit status to
 * the caller, who may die without affecting it. Without a managed service a
 * detached process (own session) is enough.
 */
export function workerCommand(
  spec: ServiceSpec,
  worker: readonly string[],
  operation: string,
): readonly string[] {
  if (spec.kind === "none") return Object.freeze([...worker]);
  return Object.freeze([
    "systemd-run",
    "--user",
    "--collect",
    "--quiet",
    "--wait",
    "--pipe",
    // A worker that dies (not one that answers: it always exits 0) is started
    // again and continues its own record. Bounded, so a worker that cannot
    // live does not spin; the record then waits for any later start.
    "--property=Restart=on-failure",
    "--property=RestartSec=1",
    "--property=StartLimitIntervalSec=120",
    "--property=StartLimitBurst=3",
    `--unit=lazurio-update-${operation}`,
    "--",
    ...worker,
  ]);
}
