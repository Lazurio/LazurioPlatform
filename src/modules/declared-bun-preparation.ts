import { join, relative, sep } from "node:path";
import { preflightBunPreparation } from "./bun-preparation";
import { verifyInstallAuthority } from "./install-authority";
import {
  inspectPreparationBinding,
  requireQualifiedInstall,
} from "./preparation-binding";
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
  // the installed tree already matches the lockfile.
  const byDefault = declaration.kind === "default";
  const operation = byDefault && requested === "check" ? "prepare" : requested;
  // Where a failed default install is named: the lockfile it installs from.
  const lockfile = relative(
    moduleDirectory,
    join(binding.authority.owner, binding.authority.lockfile),
  )
    .split(sep)
    .join("/");
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
      const result = await preparation.run(signal);
      // A failed default preparation is its install: it has nothing else.
      return byDefault &&
        result.kind === "preparation-failed" &&
        result.reason === undefined &&
        !signal.aborted
        ? Object.freeze({
            kind: "preparation-failed" as const,
            reason: "preparation-install-failed" as const,
            file: lockfile,
          })
        : result;
    },
    close: preparation.close,
  });
}

// Start-time prerequisite check: for a declared preparation never installs or
// runs prepare_script. For the default preparation (decision F25), which has
// no check, it is the frozen install. The lifecycle must retain run/close
// ownership just as it does for preparation.
export function preflightDeclaredBunCheck(
  input: Omit<Input, "operation" | "cleanInstall">,
) {
  return preflightDeclaredBunPreparation({ ...input, operation: "check" });
}
