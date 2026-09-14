import { preflightBunPreparation } from "./bun-preparation";
import { verifyInstallAuthority } from "./install-authority";
import { inspectPreparationBinding } from "./preparation-binding";

type Input = Omit<
  Parameters<typeof preflightBunPreparation>[0],
  "checkout" | "owner" | "modulePreparationScript" | "moduleCheckScript"
> & { moduleDirectory: string; applicationPackage: string };

// Trusted composition inside the existing authorized lifecycle/owner queue.
// This selects scripts from declarations, never an HTTP-provided command.
export async function preflightDeclaredBunPreparation(input: Input) {
  const binding = await inspectPreparationBinding(
    input.moduleDirectory,
    input.applicationPackage,
    input.env,
  );
  const declaration = binding.plan.preparation;
  if (!declaration)
    throw new Error("Explicit preparation declaration required");
  if (
    binding.workspaceMember ||
    Object.hasOwn(binding.authority.manifest, "workspaces")
  )
    throw new Error("Workspace installation input snapshot is not qualified");
  const moduleDirectory = input.moduleDirectory;
  const applicationPackage = input.applicationPackage;
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
  const verifyPrepared = input.verifyPrepared;
  const preparation = await preflightBunPreparation({
    ...input,
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
  return Object.freeze({
    async run(signal: AbortSignal) {
      if (signal.aborted || !(await current()))
        return Object.freeze({ kind: "preparation-failed" as const });
      return preparation.run(signal);
    },
    close: preparation.close,
  });
}
