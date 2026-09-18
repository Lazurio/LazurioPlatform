import { dirname, join } from "node:path";
import { resolveOrganizationApplication } from "../organizations/read-applications";
import { inspectBunToolchain } from "./bun-toolchain";
import {
  preflightDeclaredBunCheck,
  preflightDeclaredBunPreparation,
} from "./declared-bun-preparation";
import { verifyInstallAuthority } from "./install-authority";
import type { createApplicationLifecycle } from "./lifecycle";
import { createOwnerOperations } from "./owner-operations";
import { inspectPreparationBinding } from "./preparation-binding";
import { parseProcessLaunch } from "./process-launch";

type Adapters = Parameters<typeof createApplicationLifecycle>[0];

// Explicit local-owner composition. No provider grants, executable discovery,
// remote operations or module-specific database implementation live here.
// Module scripts are trusted code under the selected local account, not sandboxed.
export function localApplicationAdapters(input: {
  organizationDirectory: string;
  bunExecutable: string;
  platformExecutable: string;
  environment: Record<string, string>;
}): Adapters {
  const selected = parseProcessLaunch({
    executable: input.bunExecutable,
    cwd: input.organizationDirectory,
    args: [],
    env: input.environment,
  });
  const platformExecutable = input.platformExecutable;
  const owners = createOwnerOperations();
  // Admission is the root resolution state, re-derived at every boundary: only a
  // `transition` root with exact projection parity resolves; canonical-only
  // `current`, drift, conflict, legacy-only, template or an unresolvable root throw
  // here, before the owner lock, preparation, script start or any write.
  const authorize: Adapters["authorize"] = (selection) =>
    resolveOrganizationApplication(selected.cwd, selection);
  const preflight =
    (
      check: boolean,
      cleanInstall = false,
    ): NonNullable<Adapters["preflightPreparation"]> =>
    async (plan, cwd) => {
      const module = await authorize(
        {
          company: plan.runtime.company,
          module: plan.runtime.module,
          package: plan.package,
        },
        check ? "start" : cleanInstall ? "clean-prepare" : "prepare",
      );
      if (dirname(join(module.moduleDirectory, plan.package)) !== cwd)
        throw new Error("Application scope changed");
      const options = {
        moduleDirectory: module.moduleDirectory,
        applicationPackage: plan.package,
        executable: selected.executable,
        platformExecutable,
        env: selected.env,
        timeoutMs: 600_000,
        // The declared check supplies the module-owned postcondition. This
        // additional check only verifies that the observed install inputs stayed
        // unchanged; actual start/health remain separate lifecycle operations.
        verifyPrepared: async (
          authority: Parameters<typeof verifyInstallAuthority>[0],
          signal: AbortSignal,
        ) => !signal.aborted && (await verifyInstallAuthority(authority)),
      };
      return check
        ? preflightDeclaredBunCheck(options)
        : preflightDeclaredBunPreparation({ ...options, cleanInstall });
    };
  return {
    platformExecutable,
    authorize,
    preflightPreparation: preflight(false),
    preflightCleanPreparation: preflight(false, true),
    preflightStartCheck: preflight(true),
    async prepareLaunch(plan, cwd) {
      const module = await authorize(
        {
          company: plan.runtime.company,
          module: plan.runtime.module,
          package: plan.package,
        },
        "start",
      );
      const binding = await inspectPreparationBinding(
        module.moduleDirectory,
        plan.package,
        selected.env,
      );
      if (
        binding.plan.declarationDigest !== plan.declarationDigest ||
        binding.authority.owner !== cwd
      )
        throw new Error("Application preparation changed");
      const tool = await inspectBunToolchain({
        executable: selected.executable,
        cwd,
        env: selected.env,
        packageManager: binding.authority.packageManager,
      });
      if (tool.kind !== "toolchain-observed")
        throw new Error("Required toolchain unavailable");
      const environment: Record<string, string> = { ...selected.env };
      for (const listener of plan.listeners) {
        const prefix = `LAZURIO_RUNTIME_LISTENER_${listener.id.replaceAll("-", "_").toUpperCase()}`;
        environment[`${prefix}_HOST`] = listener.host;
        environment[`${prefix}_PORT`] = String(listener.port);
      }
      return {
        executable: selected.executable,
        cwd,
        args: ["--no-env-file", "run", plan.runtime.dev_script],
        env: environment,
      };
    },
    async coordinateMutation(selection, action) {
      if (selection === null) {
        await owners.drain();
        const result = await action();
        // An incomplete/throwing lifecycle cleanup must retain exclusion:
        // subprocesses may still be using these dependencies.
        if (
          result &&
          typeof result === "object" &&
          "kind" in result &&
          result.kind === "closed"
        )
          await owners.close();
        return result;
      }
      const module = await authorize(selection, "start");
      const binding = await inspectPreparationBinding(
        module.moduleDirectory,
        selection.package,
        selected.env,
      );
      return owners.run(binding.authority.owner, action);
    },
  };
}
