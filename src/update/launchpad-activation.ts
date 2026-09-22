import {
  type UpdateError,
  UpdateFailure,
  updateError,
  updateErrorCodes,
} from "./errors";
import { tagOf } from "./identity";
import { layout } from "./layout";
import { type ProcessRunner, runProcess } from "./self-check";
import {
  observeUpdateUnit,
  readUpdateUnitFailure,
  serviceEnvironment,
  updateUnit,
} from "./service-control";

/** How the Launchpad action starts `lazurio update` (docs/update.md
 * "Activation"): the SAME command the CLI runs, by the active selector, never
 * a second updater. Supervised, it runs in the transient unit `lazurio-update`
 * so it outlives the Launchpad restart it causes; unsupervised, it is a child
 * of the Launchpad and the switch it makes is finished by a restart.
 */
export type Activation = Readonly<{
  /** An update started from here is still running. */
  inFlight: boolean;
  /** How the last one that is not running ended, when it failed. */
  failure: UpdateError | null;
}>;

export interface Activator {
  /** Resolves once the command is started; a running one refuses `busy`. */
  start(version: string): Promise<void>;
  observe(): Promise<Activation>;
}

/** Exact argv: the selector, so whatever version is active runs. */
export const updateCommand = (base: string, version: string) =>
  Object.freeze([
    layout(base).selector,
    "update",
    "--version",
    tagOf(version),
    "--json",
    "--base",
    base,
  ]);

const unitName = updateUnit.replace(/\.service$/, "");

export type ActivatorInput = Readonly<{
  base: string;
  env: Readonly<Record<string, string | undefined>>;
  run?: ProcessRunner | undefined;
}>;

/** Supervised: `systemd-run --user --unit lazurio-update …` without `--collect`
 * (systemd's `--collect` takes no argument; the default keeps a failed unit).
 * A failed run stays as a failed unit, which is how the pill learns of it; the
 * next start resets that record first, so the name is free again.
 */
export function systemdActivator(input: ActivatorInput): Activator {
  const command = { run: input.run ?? runProcess, env: input.env };
  const failures = new Map<string, UpdateError>();
  const run = (argv: readonly string[]) =>
    command.run(argv, 60_000, serviceEnvironment(input.env));
  return Object.freeze({
    async start(version: string) {
      const unit = await observeUpdateUnit(command);
      if (unit?.kind === "running") throw new UpdateFailure("busy");
      if (unit?.kind === "failed")
        await run(["systemctl", "--user", "reset-failed", updateUnit]).catch(
          () => undefined,
        );
      const started = await run([
        "systemd-run",
        "--user",
        "--unit",
        unitName,
        "--quiet",
        "--no-ask-password",
        "--",
        ...updateCommand(input.base, version),
      ]).catch(() => "timeout" as const);
      if (started === "timeout" || started.exitCode !== 0)
        throw new UpdateFailure("internal", { stage: "systemd-run" });
    },
    async observe() {
      const unit = await observeUpdateUnit(command);
      if (unit?.kind === "failed") {
        let failure = failures.get(unit.invocationId);
        if (failure === undefined) {
          // Died before its answer: nothing more precise can be said.
          failure =
            (await readUpdateUnitFailure(command, unit.invocationId)) ??
            updateError("internal", { stage: "unit" });
          failures.clear();
          failures.set(unit.invocationId, failure);
        }
        return Object.freeze({ inFlight: false, failure });
      }
      return Object.freeze({
        inFlight: unit?.kind === "running",
        failure: null,
      });
    },
  });
}

/** The whole update, bounded like its longest step (the download). */
const childTimeoutMs = 60 * 60_000;

/** Unsupervised: a child of the Launchpad. Its outcome is read from its
 * `--json` answer once; success shows on disk as a selector that no longer
 * names the running version.
 */
export function childActivator(input: ActivatorInput): Activator {
  const run = input.run ?? runProcess;
  let child: Promise<void> | null = null;
  let failure: UpdateError | null = null;
  return Object.freeze({
    async start(version: string) {
      if (child !== null) throw new UpdateFailure("busy");
      failure = null;
      child = run(
        updateCommand(input.base, version),
        childTimeoutMs,
        serviceEnvironment(input.env),
      )
        .then((result) => {
          if (result === "timeout") {
            failure = updateError("internal", { stage: "timeout" });
            return;
          }
          if (result.exitCode === 0) return;
          try {
            const value = JSON.parse(result.stdout) as Partial<
              UpdateError & { kind: string }
            >;
            if (
              value.kind === "error" &&
              (updateErrorCodes as readonly unknown[]).includes(value.code)
            ) {
              failure = updateError(
                value.code as UpdateError["code"],
                value.context,
              );
              return;
            }
          } catch {}
          failure = updateError("internal", {
            stage: "child",
            exitCode: result.exitCode,
          });
        })
        .catch(() => {
          failure = updateError("internal", { stage: "child" });
        })
        .finally(() => {
          child = null;
        });
    },
    async observe() {
      return Object.freeze({ inFlight: child !== null, failure });
    },
  });
}

/** Supervised installations have a service to outlive; the rest run a child. */
export const selectActivator = (
  input: ActivatorInput & Readonly<{ supervised: boolean }>,
): Activator =>
  input.supervised ? systemdActivator(input) : childActivator(input);
