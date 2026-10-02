import { dirname, join } from "node:path";
import { retainedOperationLockPresent } from "../folder/retained-lock";
import { resolveOrganizationApplication } from "../organizations/read-applications";
import type { createApplicationCoordination } from "./application-coordination";
import { applicationEnvironment } from "./application-environment";
import type { ApplicationRunner } from "./application-runner";
import { inspectBunToolchain, requireBunToolchain } from "./bun-toolchain";
import {
  preflightDeclaredBunPreparation,
  preflightDeclaredBunStart,
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
  // The explicitly selected owner of running applications. Bounded preparation
  // subprocesses below always keep the guarded-process ownership instead.
  runner: ApplicationRunner;
  // Required with a runner whose applications outlive this owner: application
  // operations are then coordinated by a lock that dies with its holder.
  coordination?: ReturnType<typeof createApplicationCoordination>;
  // The admission of a selection under `organizationDirectory`: an
  // Organization root's by default, a Personalspace owner directory's with
  // `resolvePersonalspaceApplication` (launchpad-parity B11).
  resolveApplication?: (
    directory: string,
    selection: unknown,
  ) => Promise<Readonly<{ moduleDirectory: string }>>;
  // What a started application is told about where it runs (decision F26):
  // its Organization root (none for a Personalspace module) and, for the
  // module's default app, the browser origin the Machine's gateway serves it
  // at; null on a workstation. A throw refuses the launch.
  organizationRoot?: string;
  externalOrigin?: (module: string) => Promise<string | null>;
}): Adapters {
  const selected = parseProcessLaunch({
    executable: input.bunExecutable,
    cwd: input.organizationDirectory,
    args: [],
    env: input.environment,
  });
  const platformExecutable = input.platformExecutable;
  const owners = createOwnerOperations();
  const coordination = input.coordination;
  if (input.runner.survivesOwnerExit !== (coordination !== undefined))
    throw new Error(
      "Application coordination belongs exactly to owner-surviving runners",
    );
  // Admission is the root resolution state, re-derived at every boundary through
  // the one admission rule (`isExecutableOrganizationState` in root-resolution):
  // every state it does not admit (drift, conflict, legacy-only, and `current`
  // under the transition-only variant), a template or an unresolvable root throw
  // here, before the owner lock, preparation, script start or any write.
  const resolveApplication =
    input.resolveApplication ?? resolveOrganizationApplication;
  const authorize: Adapters["authorize"] = (selection) =>
    resolveApplication(selected.cwd, selection);
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
        organizationDirectory: selected.cwd,
        executable: selected.executable,
        platformExecutable,
        env: selected.env,
        timeoutMs: 600_000,
        // The declared check supplies the module-owned postcondition (the
        // default preparation has none, decision F25). This additional check
        // only verifies that the observed install inputs stayed unchanged;
        // actual start/health remain separate lifecycle operations.
        verifyPrepared: async (
          authority: Parameters<typeof verifyInstallAuthority>[0],
          signal: AbortSignal,
        ) => !signal.aborted && (await verifyInstallAuthority(authority)),
      };
      return check
        ? preflightDeclaredBunStart(options)
        : preflightDeclaredBunPreparation({ ...options, cleanInstall });
    };
  return {
    runner: input.runner,
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
        selected.cwd,
      );
      if (
        binding.plan.declarationDigest !== plan.declarationDigest ||
        binding.authority.owner !== cwd
      )
        throw new Error("Application preparation changed");
      requireBunToolchain(
        await inspectBunToolchain({
          executable: selected.executable,
          cwd,
          env: selected.env,
          packageManager: binding.authority.packageManager,
        }),
        cwd,
      );
      return {
        executable: selected.executable,
        cwd,
        args: ["--no-env-file", "run", plan.runtime.dev_script],
        env: applicationEnvironment({
          base: selected.env,
          plan,
          cwd,
          organizationRoot: input.organizationRoot,
          externalOrigin:
            plan.defaultApp && input.externalOrigin
              ? await input.externalOrigin(plan.runtime.module)
              : null,
        }),
      };
    },
    async coordinateMutation(selection, action, intent) {
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
      const owner = async () => {
        const module = await authorize(selection, "start");
        const binding = await inspectPreparationBinding(
          module.moduleDirectory,
          selection.package,
          selected.env,
          selected.cwd,
        );
        return binding.authority.owner;
      };
      // Session applications are known only to this process and die with it:
      // after an owner crash there is nothing left to operate, and the retained
      // lock is also what keeps another process from reinstalling beneath an
      // application only this owner can see. Every mutation keeps it until close.
      // Stop changes no dependency tree: it never resolves the preparation,
      // which may no longer be possible for a running app (decision F25).
      if (!coordination)
        return intent === "stop" ? action() : owners.run(await owner(), action);
      // Service-owned applications: two kinds of exclusion.
      return coordination.run(async () => {
        // Stop has no effect on the dependency tree and is idempotent in the
        // service manager: nothing but coordination, and never blocked by a
        // crashed owner or an interrupted preparation.
        if (intent === "stop") return action();
        const directory = await owner();
        if (intent === "start") {
          // The start check and the runner operation hold no on-disk
          // intermediate state. A retained record that is not ours means a
          // preparation died (or is unconfirmed) on this tree: never start an
          // application on it; recovery stays explicit.
          if (
            (await retainedOperationLockPresent(directory)) &&
            !(await owners.holds(directory))
          )
            return Object.freeze({
              kind: "preparation-recovery-required" as const,
            });
          return action();
        }
        // Preparation (and any unknown intent) is a TRANSACTION on the
        // dependency tree: retained lock inside the coordination lock, so the
        // "no active unit" refusal stays true for its whole duration. The record
        // is released once the transaction completed with confirmed cleanup; it
        // stays after a throw, unconfirmed cleanup or the death of this process.
        try {
          return await owners.run(
            directory,
            action,
            (result) =>
              !(
                result &&
                typeof result === "object" &&
                "kind" in result &&
                result.kind === "preparation-cleanup-required"
              ),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "Owner operations closing"
          )
            return Object.freeze({ kind: "closing" as const });
          if (
            (await retainedOperationLockPresent(directory)) &&
            !(await owners.holds(directory))
          )
            return Object.freeze({
              kind: "preparation-recovery-required" as const,
            });
          throw error;
        }
      });
    },
  };
}

// Status and Stop without a running Launchpad. Possible only because a
// service-owned application's truth lives in the service manager: this owner
// holds no memory, takes the same coordination lock as a live Launchpad, and can
// neither launch nor prepare anything. Admission is the same root resolution.
export function serviceApplicationAdapters(input: {
  organizationDirectory: string;
  runner: ApplicationRunner;
  coordination: ReturnType<typeof createApplicationCoordination>;
}): Adapters {
  if (!input.runner.survivesOwnerExit)
    throw new Error("Session applications are operated by their Launchpad");
  return {
    runner: input.runner,
    authorize: (selection) =>
      resolveOrganizationApplication(input.organizationDirectory, selection),
    prepareLaunch: async () => {
      throw new Error("Launch requires a configured Launchpad");
    },
    coordinateMutation: (selection, action, intent) => {
      if (selection === null) return action();
      if (intent !== "stop")
        return Promise.reject(new Error("Only Stop is operated directly"));
      return input.coordination.run(action);
    },
  };
}
