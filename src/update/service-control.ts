import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type UpdateError, updateError, updateErrorCodes } from "./errors";
import { layout } from "./layout";
import { type ProcessRunner, runProcess } from "./self-check";

/** The part of the OS service manager an activation needs, and nothing more
 * (docs/update.md "State on disk", "Activation"). A supervised installation is
 * one whose systemd user unit `lazurio-launchpad.service` exists; there is no
 * other supervisor and no recorded setting.
 */
export const launchpadUnit = "lazurio-launchpad.service";
export const rollbackUnit = "lazurio-rollback.service";
/** The transient unit the Launchpad action starts `lazurio update` in, so the
 * updater outlives the Launchpad restart it causes (docs/update.md
 * "Activation"). */
export const updateUnit = "lazurio-update.service";

/** Where user units live: `${XDG_CONFIG_HOME:-~/.config}/systemd/user`. */
export function userUnitDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const config =
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : env.HOME && isAbsolute(env.HOME)
        ? join(env.HOME, ".config")
        : undefined;
  return config === undefined ? undefined : join(config, "systemd", "user");
}

export interface ServiceControl {
  /** The Folder the unit starts the Launchpad with. */
  readonly folder: string | undefined;
  /** Clear a start-limit failure and restart the Launchpad unit. */
  restartLaunchpad(): Promise<void>;
  /** Version the running Launchpad reports, or null while it reports none. */
  launchpadVersion(): Promise<string | null>;
}

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

export const serviceCommandTimeoutMs = 60_000;

export async function systemctl(
  input: Readonly<{
    run: ProcessRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
  ...args: string[]
): Promise<boolean> {
  const result = await input
    .run(
      ["systemctl", "--user", ...args],
      serviceCommandTimeoutMs,
      serviceEnvironment(input.env),
    )
    .catch(() => "timeout" as const);
  return result !== "timeout" && result.exitCode === 0;
}

type ServiceCommand = Readonly<{
  run: ProcessRunner;
  env: Readonly<Record<string, string | undefined>>;
}>;

async function serviceOutput(
  input: ServiceCommand,
  command: readonly string[],
): Promise<string | null> {
  const result = await input
    .run(command, serviceCommandTimeoutMs, serviceEnvironment(input.env))
    .catch(() => "timeout" as const);
  return result !== "timeout" && result.exitCode === 0 ? result.stdout : null;
}

/** What the service manager holds under the update unit's name. The unit is
 * started without `--collect`, so a failed run stays visible as `failed` until
 * the next start resets it; a finished one is gone. Null: the manager cannot
 * be asked.
 */
export type UpdateUnitState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "failed"; invocationId: string }>;

export async function observeUpdateUnit(
  input: ServiceCommand,
): Promise<UpdateUnitState | null> {
  const output = await serviceOutput(input, [
    "systemctl",
    "--user",
    "show",
    "--property=LoadState,ActiveState,InvocationID",
    "--",
    updateUnit,
  ]);
  if (output === null) return null;
  const properties = new Map<string, string>();
  for (const line of output.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) properties.set(line.slice(0, split), line.slice(split + 1));
  }
  const active = properties.get("ActiveState");
  const invocationId = properties.get("InvocationID") ?? "";
  if (properties.get("LoadState") === "not-found" || active === "inactive")
    return Object.freeze({ kind: "absent" as const });
  if (active === "failed")
    return /^[0-9a-f]{32}$/.test(invocationId)
      ? Object.freeze({ kind: "failed" as const, invocationId })
      : null;
  return ["active", "activating", "deactivating", "reloading"].includes(
    active ?? "",
  )
    ? Object.freeze({ kind: "running" as const })
    : null;
}

/** The one stable error code a failed run of the update unit printed with
 * `--json`, read from that invocation's journal. Null when it printed none:
 * the run died before its answer, or the journal is not readable.
 */
export async function readUpdateUnitFailure(
  input: ServiceCommand,
  invocationId: string,
): Promise<UpdateError | null> {
  if (!/^[0-9a-f]{32}$/.test(invocationId)) return null;
  const output = await serviceOutput(input, [
    "journalctl",
    "--user",
    "--unit",
    updateUnit,
    "--output",
    "cat",
    "--no-pager",
    "--lines",
    "50",
    `_SYSTEMD_INVOCATION_ID=${invocationId}`,
  ]);
  if (output === null) return null;
  for (const line of output.split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as {
        kind?: unknown;
        code?: unknown;
        context?: unknown;
      };
      if (
        value.kind === "error" &&
        (updateErrorCodes as readonly unknown[]).includes(value.code)
      )
        return updateError(
          value.code as UpdateError["code"],
          typeof value.context === "object" && value.context !== null
            ? Object.fromEntries(
                Object.entries(value.context).filter(([, entry]) =>
                  ["string", "number", "boolean"].includes(typeof entry),
                ),
              )
            : {},
        );
    } catch {}
  }
  return null;
}

/** `GET /health` on the supervised Launchpad's socket under the base. */
export async function launchpadHealth(base: string): Promise<string | null> {
  try {
    const response = await fetch("http://launchpad/health", {
      unix: layout(base).healthSocket,
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { version?: unknown };
    return response.ok && typeof body.version === "string"
      ? body.version
      : null;
  } catch {
    return null;
  }
}

/** The Folder is written into the unit's ignored `[X-Lazurio]` section by
 * `lazurio install`, so the unit stays the one place it lives.
 */
export function unitFolder(unitText: string): string | undefined {
  const section = /^\[X-Lazurio\]\n((?:(?!\[).*\n?)*)/m.exec(unitText)?.[1];
  const folder = /^Folder=(.+)$/m.exec(section ?? "")?.[1];
  return folder !== undefined && isAbsolute(folder) ? folder : undefined;
}

/** Null when this installation is not supervised. */
export async function detectServiceControl(input: {
  base: string;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  run?: ProcessRunner | undefined;
}): Promise<ServiceControl | null> {
  const directory = userUnitDirectory(input.env);
  if (input.platform !== "linux" || directory === undefined) return null;
  const unitText = await readFile(join(directory, launchpadUnit), "utf8").catch(
    () => undefined,
  );
  if (unitText === undefined) return null;
  const command = { run: input.run ?? runProcess, env: input.env };
  return Object.freeze({
    folder: unitFolder(unitText),
    async restartLaunchpad() {
      // A version that crash-looped leaves the unit in `start-limit-hit`, and
      // systemd then refuses even a manual restart — exactly when the previous
      // version must be brought back. Its status says only whether there was
      // anything to reset.
      await systemctl(command, "reset-failed", launchpadUnit);
      if (!(await systemctl(command, "restart", launchpadUnit)))
        throw new Error("Service restart failed");
    },
    launchpadVersion: () => launchpadHealth(input.base),
  });
}

export const healthDeadlineMs = 30_000;

/** Poll until the Launchpad reports `version`, for at most the deadline. */
export async function waitForLaunchpad(
  service: ServiceControl,
  version: string,
  options: Readonly<{
    deadlineMs?: number | undefined;
    pollMs?: number | undefined;
  }> = {},
): Promise<boolean> {
  const deadline = performance.now() + (options.deadlineMs ?? healthDeadlineMs);
  for (;;) {
    if ((await service.launchpadVersion()) === version) return true;
    if (performance.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 250));
  }
}
