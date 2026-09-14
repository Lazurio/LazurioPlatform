import { inspectBunToolchain } from "./bun-toolchain";
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
import { parseProcessLaunch } from "./process-launch";

type Authority = Awaited<ReturnType<typeof inspectInstallAuthority>>;
type Install = Awaited<ReturnType<typeof runFrozenInstallProcess>>;
type PreparationResult = Readonly<{ kind: "prepared" | "preparation-failed" }>;

// First Bun effect composition for the existing lifecycle's preparation hook.
// The caller resolves the dependency owner under the shared operation lock and
// selects an optional declared module preparation script and supplies a bounded
// read-only postcondition (including DB/local dependencies). Platform coordinates
// the script, but does not discover or implement application-specific data setup.
export async function preflightBunPreparation(input: {
  checkout: string;
  owner: string;
  executable: string;
  platformExecutable: string;
  env: Record<string, string>;
  timeoutMs: number;
  cleanInstall?: boolean;
  modulePreparationScript?: string;
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
  );
  const modulePreparationScript = input.modulePreparationScript;
  if (modulePreparationScript !== undefined)
    modulePreparationArgs(authority, modulePreparationScript);
  const moduleCheckScript = input.moduleCheckScript;
  if (moduleCheckScript !== undefined)
    modulePreparationArgs(authority, moduleCheckScript);
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
  const toolchain = await inspectBunToolchain({
    ...launch,
    packageManager: authority.packageManager,
  });
  if (toolchain.kind !== "toolchain-observed")
    throw new Error("Required Bun toolchain unavailable");
  if (!(await verifyInstallAuthority(authority)))
    throw new Error("Preparation authority changed");
  const abort = new AbortController();
  let pending: Promise<PreparationResult> | null = null;
  let install: Install | undefined;
  let modulePreparation: Install | undefined;
  let moduleCheck: Install | undefined;
  let closing = false;
  let used = false;
  const failed = () => Object.freeze({ kind: "preparation-failed" as const });
  return Object.freeze({
    run(signal: AbortSignal): Promise<PreparationResult> {
      if (used || closing) return Promise.resolve(failed());
      used = true;
      const combined = AbortSignal.any([
        signal,
        abort.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      pending = (async () => {
        try {
          if (combined.aborted) return failed();
          if (cleanInstall) {
            const cleanup = await cleanDerivedDependencies(authority, combined);
            if (cleanup.kind === "authority-changed" || combined.aborted)
              return failed();
          }
          install = await runFrozenInstallProcess({
            authority,
            executable: launch.executable,
            platformExecutable,
            env: launch.env,
            timeoutMs,
            signal: combined,
          });
          if (
            combined.aborted ||
            install.kind !== "process-exited" ||
            install.code !== 0 ||
            install.cleanup !== "group-stopped"
          )
            return failed();
          if (modulePreparationScript !== undefined) {
            modulePreparation = await runModulePreparationProcess({
              authority,
              executable: launch.executable,
              platformExecutable,
              env: launch.env,
              timeoutMs,
              signal: combined,
              script: modulePreparationScript,
            });
            if (
              combined.aborted ||
              modulePreparation.kind !== "process-exited" ||
              modulePreparation.code !== 0 ||
              modulePreparation.cleanup !== "group-stopped"
            )
              return failed();
          }
          if (moduleCheckScript !== undefined) {
            moduleCheck = await runModulePreparationProcess({
              authority,
              executable: launch.executable,
              platformExecutable,
              env: launch.env,
              timeoutMs,
              signal: combined,
              script: moduleCheckScript,
            });
            if (
              combined.aborted ||
              moduleCheck.kind !== "process-exited" ||
              moduleCheck.code !== 0 ||
              moduleCheck.cleanup !== "group-stopped"
            )
              return failed();
          }
          if (
            !(await verifyPrepared(authority, combined)) ||
            combined.aborted ||
            !(await verifyInstallAuthority(authority))
          )
            return failed();
          return Object.freeze({ kind: "prepared" as const });
        } catch {
          return failed();
        }
      })();
      return pending;
    },
    async close() {
      closing = true;
      abort.abort();
      await pending;
      let incomplete = false;
      for (const operation of [install, modulePreparation, moduleCheck])
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
