import { join, relative, sep } from "node:path";
import { preflightBunPreparation } from "./bun-preparation";
import { verifyInstallAuthority } from "./install-authority";
import {
  applicationsOverlap,
  inspectPreparationBinding,
  requireQualifiedInstall,
} from "./preparation-binding";
import type { PreparationReason } from "./preparation-refusal";
import { parseProcessLaunch } from "./process-launch";

type Input = Omit<
  Parameters<typeof preflightBunPreparation>[0],
  | "checkout"
  | "owner"
  | "modulePreparationScript"
  | "moduleCheckScript"
  | "dependencyBoundary"
> & {
  moduleDirectory: string;
  applicationPackage: string;
  // The Organization (or Personalspace owner) directory holding the module:
  // where the default preparation's local dependencies may lie (F25).
  organizationDirectory?: string;
};

// Trusted composition inside the existing authorized lifecycle/owner queue.
// This selects scripts from declarations, never an HTTP-provided command.
export async function preflightDeclaredBunPreparation(input: Input) {
  // Capture caller data before the first filesystem await. Later mutation of the
  // caller's object must not redirect selection, configuration or the executable.
  const launch = parseProcessLaunch({
    executable: input.executable,
    cwd: input.moduleDirectory,
    args: [],
    env: input.env,
  });
  const moduleDirectory = launch.cwd;
  const applicationPackage = input.applicationPackage;
  const verifyPrepared = input.verifyPrepared;
  const organizationDirectory = input.organizationDirectory;
  const requested = input.operation;
  const options = {
    executable: launch.executable,
    platformExecutable: input.platformExecutable,
    env: launch.env,
    timeoutMs: input.timeoutMs,
    ...(input.cleanInstall === undefined
      ? {}
      : { cleanInstall: input.cleanInstall }),
  };
  const binding = await inspectPreparationBinding(
    moduleDirectory,
    applicationPackage,
    options.env,
    organizationDirectory,
  );
  const declaration = binding.preparation;
  requireQualifiedInstall(declaration, applicationPackage, binding.authority);
  // The default preparation (decision F25) has no check: its start-time
  // step is its preparation, the frozen install, which changes nothing when
  // the installed tree already matches the lockfile. A declared preparation's
  // start-time step runs its check and prepares only when it fails (decision
  // F30), unless the app's directory overlaps another app of its module: its
  // install could change that app's files beneath it, so its start only
  // checks, and only an explicit preparation installs (F25 point 6).
  const byDefault = declaration.kind === "default";
  const startOnlyChecks =
    !byDefault &&
    requested === "start" &&
    (await applicationsOverlap(moduleDirectory, applicationPackage));
  const operation =
    byDefault && requested !== undefined && requested !== "prepare"
      ? "prepare"
      : startOnlyChecks
        ? "check"
        : requested;
  // Module-relative names of what a failed step concerns.
  const named = (path: string) =>
    relative(moduleDirectory, path).split(sep).join("/");
  // A failed install: the lockfile it installs from.
  const lockfile = named(
    join(binding.authority.owner, binding.authority.lockfile),
  );
  // A failed preparation script: the owner's package.json that declares it.
  const ownerPackage = named(join(binding.authority.owner, "package.json"));
  const environment = binding.authority.environment ?? undefined;
  const current = async () => {
    try {
      const observed = await inspectPreparationBinding(
        moduleDirectory,
        applicationPackage,
        environment,
        organizationDirectory,
      );
      return (
        observed.plan.declarationDigest === binding.plan.declarationDigest &&
        (await verifyInstallAuthority(binding.authority))
      );
    } catch {
      return false;
    }
  };
  const preparation = await preflightBunPreparation({
    ...options,
    ...(operation === undefined ? {} : { operation }),
    checkout: moduleDirectory,
    owner: binding.authority.owner,
    dependencyBoundary: binding.authority.dependencyBoundary,
    ...(declaration.prepare_script === undefined
      ? {}
      : { modulePreparationScript: declaration.prepare_script }),
    ...(declaration.check_script === undefined
      ? {}
      : { moduleCheckScript: declaration.check_script }),
    verifyPrepared: async (authority, signal) =>
      !signal.aborted &&
      (await current()) &&
      (await verifyPrepared(authority, signal)),
  });
  if (!(await current())) {
    await preparation.close();
    throw new Error("Preparation declaration changed before execution");
  }
  let used = false;
  return Object.freeze({
    async run(signal: AbortSignal) {
      if (used) return Object.freeze({ kind: "preparation-failed" as const });
      used = true;
      if (signal.aborted || !(await current()))
        return Object.freeze({ kind: "preparation-failed" as const });
      const { stage, ...result } = await preparation.run(signal);
      const failed = (
        reason: PreparationReason | undefined,
        file: string | undefined,
      ) =>
        Object.freeze({
          kind: "preparation-failed" as const,
          ...(reason === undefined ? {} : { reason }),
          ...(file === undefined ? {} : { file }),
        });
      if (
        result.kind !== "preparation-failed" ||
        result.reason !== undefined ||
        signal.aborted
      )
        return Object.freeze(result);
      // A failed default preparation is its install: it has nothing else.
      if (byDefault) return failed("preparation-install-failed", lockfile);
      // A declared preparation names the step that failed (decision F30). A
      // check that still fails is no refusal of the Platform's: the start
      // answers `prerequisites-not-ready`.
      if (stage === "install")
        return failed("preparation-install-failed", lockfile);
      if (stage === "prepare-script")
        return failed("preparation-script-failed", ownerPackage);
      if (stage === "check" && startOnlyChecks)
        return failed("preparation-applications-overlap", applicationPackage);
      return failed(undefined, undefined);
    },
    close: preparation.close,
  });
}

// The start-time step (decision F30). For a declared preparation: its check,
// and only when the check fails the preparation (frozen install, the declared
// prepare_script, the check again), all in one run under one deadline; a
// check that passes changes nothing. For the default preparation (decision
// F25), which has no check, it is the frozen install. The lifecycle must
// retain run/close ownership just as it does for preparation.
export function preflightDeclaredBunStart(
  input: Omit<Input, "operation" | "cleanInstall">,
) {
  return preflightDeclaredBunPreparation({ ...input, operation: "start" });
}
