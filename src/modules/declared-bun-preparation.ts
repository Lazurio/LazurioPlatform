import { preflightBunPreparation } from "./bun-preparation";
import { verifyInstallAuthority } from "./install-authority";
import { inspectPreparationBinding } from "./preparation-binding";
import { parseProcessLaunch } from "./process-launch";

type Input = Omit<
  Parameters<typeof preflightBunPreparation>[0],
  "checkout" | "owner" | "modulePreparationScript" | "moduleCheckScript"
> & { moduleDirectory: string; applicationPackage: string };

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
  const options = {
    executable: launch.executable,
    platformExecutable: input.platformExecutable,
    env: launch.env,
    timeoutMs: input.timeoutMs,
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.cleanInstall === undefined
      ? {}
      : { cleanInstall: input.cleanInstall }),
  };
  const binding = await inspectPreparationBinding(
    moduleDirectory,
    applicationPackage,
    options.env,
  );
  const declaration = binding.plan.preparation;
  if (!declaration)
    throw new Error("Explicit preparation declaration required");
  if (
    binding.workspaceMember ||
    Object.hasOwn(binding.authority.manifest, "workspaces")
  )
    throw new Error("Workspace installation input snapshot is not qualified");
  const environment = binding.authority.environment ?? undefined;
  const current = async () => {
    try {
      const observed = await inspectPreparationBinding(
        moduleDirectory,
        applicationPackage,
        environment,
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
    checkout: moduleDirectory,
    owner: binding.authority.owner,
    ...(declaration.prepare_script === undefined
      ? {}
      : { modulePreparationScript: declaration.prepare_script }),
    moduleCheckScript: declaration.check_script,
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
      return preparation.run(signal);
    },
    close: preparation.close,
  });
}

// Start-time prerequisite check only: never installs or runs prepare_script.
// The lifecycle must retain run/close ownership just as it does for preparation.
export function preflightDeclaredBunCheck(
  input: Omit<Input, "operation" | "cleanInstall">,
) {
  return preflightDeclaredBunPreparation({ ...input, operation: "check" });
}
