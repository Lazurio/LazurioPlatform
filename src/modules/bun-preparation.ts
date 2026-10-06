import {
  type CheckoutReason,
  checkoutRefusal,
} from "../providers/checkout-custody";
import { inspectBunToolchain, requireBunToolchain } from "./bun-toolchain";
import { cleanDerivedDependencies } from "./clean-dependencies";
import {
  modulePreparationArgs,
  runFrozenInstallProcess,
  runModulePreparationProcess,
} from "./frozen-install-process";
import {
  inspectInstallAuthority,
  verifyInstallAuthority,
} from "./install-authority";
import type { PreparationReason } from "./preparation-refusal";
import { parseProcessLaunch } from "./process-launch";

type Authority = Awaited<ReturnType<typeof inspectInstallAuthority>>;
type Install = Awaited<ReturnType<typeof runFrozenInstallProcess>>;
/** Which step's process ran to completion and exited non-zero. Absent for
 * every other failure (cancellation, timeout, unconfirmed cleanup, changed
 * inputs, a failed postcondition), which names no step. */
export type PreparationStage = "install" | "prepare-script" | "check";
type PreparationResult = Readonly<{
  kind: "prepared" | "preparation-failed";
  /** A refusal of the checkout rule (decision F23), or of the default
   * preparation's install (decision F25), and its module-relative file or
   * directory. */
  reason?: CheckoutReason | PreparationReason;
  file?: string;
  stage?: PreparationStage;
}>;

// First Bun effect composition for the existing lifecycle's preparation hook.
// The caller resolves the dependency owner under the shared operation lock and
// selects an optional declared module preparation script and supplies a bounded
// read-only postcondition (including DB/local dependencies). Platform coordinates
// the script, but does not discover or implement application-specific data setup.
//
// Operations: `prepare` installs, runs the optional preparation script, then
// the optional check; `check` runs only the check; `start` (decision F34)
// installs, runs the check and, only when it exits non-zero, the preparation
// script and the check again. On a tree that already matches the lockfile
// Bun leaves registry dependencies as they are, but copies local `file:`
// dependencies again and runs the owner package's own lifecycle scripts. Every operation is one run under one
// deadline.
export async function preflightBunPreparation(input: {
  checkout: string;
  owner: string;
  executable: string;
  platformExecutable: string;
  env: Record<string, string>;
  timeoutMs: number;
  operation?: "prepare" | "check" | "start";
  cleanInstall?: boolean;
  modulePreparationScript?: string;
  // Where local `file:` dependencies may lie (the install authority's
  // boundary, decision F25); the owner when absent.
  dependencyBoundary?: string;
  // Trusted declaration selection, not a script name supplied by an HTTP request.
  // Read-only behavior is the module contract, not an OS sandbox guarantee.
  moduleCheckScript?: string;
  verifyPrepared: (
    authority: Authority,
    signal: AbortSignal,
  ) => Promise<boolean>;
}) {
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 600_000
  )
    throw new Error("Bounded preparation timeout required");
  const authority = await inspectInstallAuthority(
    input.checkout,
    input.owner,
    input.env,
    input.dependencyBoundary,
  );
  const modulePreparationScript = input.modulePreparationScript;
  if (modulePreparationScript !== undefined)
    modulePreparationArgs(authority, modulePreparationScript);
  const moduleCheckScript = input.moduleCheckScript;
  if (moduleCheckScript !== undefined)
    modulePreparationArgs(authority, moduleCheckScript);
  const operation = input.operation ?? "prepare";
  if (!["prepare", "check", "start"].includes(operation))
    throw new Error("Unknown preparation operation");
  if (
    operation !== "prepare" &&
    (input.cleanInstall || moduleCheckScript === undefined)
  )
    throw new Error(
      "Check requires a declared script and cannot clean dependencies",
    );
  const launch = parseProcessLaunch({
    executable: input.executable,
    cwd: authority.owner,
    args: [],
    env: input.env,
  });
  const platformExecutable = input.platformExecutable;
  const timeoutMs = input.timeoutMs;
  if (
    input.cleanInstall !== undefined &&
    typeof input.cleanInstall !== "boolean"
  )
    throw new Error("Explicit clean-install mode required");
  const cleanInstall = input.cleanInstall === true;
  const verifyPrepared = input.verifyPrepared;
  requireBunToolchain(
    await inspectBunToolchain({
      ...launch,
      packageManager: authority.packageManager,
    }),
    authority.owner,
  );
  if (!(await verifyInstallAuthority(authority)))
    throw new Error("Preparation authority changed");
  const abort = new AbortController();
  let pending: Promise<PreparationResult> | null = null;
  let install: Install | undefined;
  let modulePreparation: Install | undefined;
  let firstCheck: Install | undefined;
  let moduleCheck: Install | undefined;
  let closing = false;
  let used = false;
  const failed = (stage?: PreparationStage) =>
    Object.freeze({
      kind: "preparation-failed" as const,
      ...(stage === undefined ? {} : { stage }),
    });
  return Object.freeze({
    run(signal: AbortSignal): Promise<PreparationResult> {
      if (used || closing) return Promise.resolve(failed());
      used = true;
      const combined = AbortSignal.any([
        signal,
        abort.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      // A step's own failure: its process ran to the end, its group is gone
      // and it exited non-zero. Anything else names no step.
      const outcome = (step: Install, stage: PreparationStage) =>
        combined.aborted ||
        step.kind !== "process-exited" ||
        step.cleanup !== "group-stopped"
          ? ("failed" as const)
          : step.code === 0
            ? ("passed" as const)
            : stage;
      const check = () =>
        runModulePreparationProcess({
          authority,
          executable: launch.executable,
          platformExecutable,
          env: launch.env,
          timeoutMs,
          signal: combined,
          script: moduleCheckScript as string,
        });
      pending = (async () => {
        try {
          if (combined.aborted) return failed();
          if (cleanInstall) {
            const cleanup = await cleanDerivedDependencies(authority, combined);
            if (cleanup.kind === "authority-changed" || combined.aborted)
              return failed();
          }
          // Every operation but `check` begins with the frozen install,
          // which leaves matching registry dependencies as they are (decision
          // F34: the install is the Platform's; not free of effects, point 1).
          if (operation !== "check") {
            install = await runFrozenInstallProcess({
              authority,
              executable: launch.executable,
              platformExecutable,
              env: launch.env,
              timeoutMs,
              signal: combined,
            });
            const installed = outcome(install, "install");
            if (installed === "failed") return failed();
            if (installed !== "passed") return failed(installed);
          }
          // `start`: a check that passes after the install is the whole
          // step; one that fails means "run the preparation script and check
          // again", never "start anyway".
          let script = operation === "prepare";
          if (operation === "start") {
            firstCheck = await check();
            const first = outcome(firstCheck, "check");
            if (first === "failed") return failed();
            if (first !== "passed" && modulePreparationScript === undefined)
              return failed(first);
            script = first !== "passed";
          }
          if (script && modulePreparationScript !== undefined) {
            modulePreparation = await runModulePreparationProcess({
              authority,
              executable: launch.executable,
              platformExecutable,
              env: launch.env,
              timeoutMs,
              signal: combined,
              script: modulePreparationScript,
            });
            const prepared = outcome(modulePreparation, "prepare-script");
            if (prepared === "failed") return failed();
            if (prepared !== "passed") return failed(prepared);
          }
          if (
            moduleCheckScript !== undefined &&
            (operation !== "start" || script)
          ) {
            moduleCheck = await check();
            const checked = outcome(moduleCheck, "check");
            if (checked === "failed") return failed();
            if (checked !== "passed") return failed(checked);
          }
          if (
            !(await verifyPrepared(authority, combined)) ||
            combined.aborted ||
            !(await verifyInstallAuthority(authority))
          )
            return failed();
          return Object.freeze({ kind: "prepared" as const });
        } catch (error) {
          // A refused file or directory of the checkout, such as another
          // account's entry in the dependency tree, keeps its rule and
          // module-relative name (decision F23).
          const refused = checkoutRefusal(error, authority.checkout);
          return refused === null
            ? failed()
            : Object.freeze({
                kind: "preparation-failed" as const,
                ...refused,
              });
        }
      })();
      return pending;
    },
    async close() {
      closing = true;
      abort.abort();
      await pending;
      let incomplete = false;
      for (const operation of [
        firstCheck,
        install,
        modulePreparation,
        moduleCheck,
      ])
        if (
          operation &&
          "handle" in operation &&
          (await operation.handle.stop()).kind !== "group-stopped"
        )
          incomplete = true;
      if (incomplete) return Object.freeze({ kind: "incomplete" as const });
      return Object.freeze({ kind: "closed" as const });
    },
  });
}
