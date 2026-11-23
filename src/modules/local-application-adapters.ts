import { dirname, join } from "node:path";
import { retainedOperationLockPresent } from "../folder/retained-lock";
import { resolveOrganizationApplication } from "../organizations/read-applications";
import type { createApplicationCoordination } from "./application-coordination";
import {
  applicationEnvironment,
  moduleProcessEnvironment,
} from "./application-environment";
import type { ApplicationRunner } from "./application-runner";
import {
  createModuleBunResolver,
  type ModuleBunResolver,
  withModuleBun,
} from "./bun-runtime";
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
import {
  admitRuntimeSecrets,
  type RuntimeSecretSource,
  readRuntimeSecrets,
} from "./runtime-secrets";
import { requiredSlotOrigins } from "./sibling-origins";

type Adapters = Parameters<typeof createApplicationLifecycle>[0];

// Explicit local-owner composition. No provider grants, executable discovery,
// remote operations or module-specific database implementation live here.
// Module scripts are trusted code under the selected local account, not sandboxed.
export function localApplicationAdapters(input: {
  organizationDirectory: string;
  /** The user's Bun (B2): what runs an App that pins none or pins it, and
   * the Platform's static server. */
  bunExecutable: string;
  /** The Bun an App pins, as its runtime (decision F62); by default the
   * resolver of the account `environment.HOME` names, with `bunExecutable`
   * as the user's Bun. */
  resolveBun?: ModuleBunResolver;
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
  // its Organization root (none for a Personalspace module), the loopback
  // origins of the sibling modules of that Organization it declares (F26
  // addendum of 2026-10-10) and, for the module's default app, the browser
  // origin the Machine's gateway serves it at; null on a workstation. A
  // throw refuses the launch.
  organizationRoot?: string;
  externalOrigin?: (module: string) => Promise<string | null>;
  // Where the app's declared runtime secrets are read before every start
  // (decision F46): the Environment vault. A Personalspace module gets none
  // (`personalspace`), and without a source an app that requires one does
  // not start (`no-vault-identity`).
  secretSource?: RuntimeSecretSource | undefined;
  personalspace?: boolean;
  // The module's own data mounts (launchpad-parity B7), provided before its
  // preparation and start: given the module's directory, it clones an absent
  // declared data repository, verifies a present one, and throws
  // `RequiredSlotRefused` otherwise. None: nothing is provided (a
  // Personalspace module, a composition without GitHub).
  provideData?: (moduleDirectory: string) => Promise<void>;
  // The Platform's static server of built apps (decision F58): its script
  // and an empty Bun configuration, written beside the build cache. None:
  // no app starts built here.
  staticServer?: () => Promise<Readonly<{ script: string; config: string }>>;
}): Adapters {
  // The one environment of every process started for a module here: the
  // preparation's install and scripts, the toolchain probe and the
  // application, in both runners; Bun's runtime auto-install is off in it.
  const selected = parseProcessLaunch({
    executable: input.bunExecutable,
    cwd: input.organizationDirectory,
    args: [],
    env: moduleProcessEnvironment(input.environment),
  });
  const platformExecutable = input.platformExecutable;
  // Every path that runs an App's code (its start-time step, its
  // preparation, its development script, its own server) resolves the Bun
  // the App pins (decision F62); the static server below is the Platform's
  // own process and stays on the user's Bun.
  let resolver = input.resolveBun;
  const resolveBun: ModuleBunResolver = (pinned) => {
    if (resolver === undefined) {
      const home = selected.env.HOME;
      if (home === undefined || !home.startsWith("/"))
        throw new Error("Explicit account home required");
      resolver = createModuleBunResolver({
        home,
        userBun: selected.executable,
        path: selected.env.PATH,
        tmpdir: selected.env.TMPDIR,
      });
    }
    return resolver(pinned);
  };
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
  // The slots the app requires, refused before any effect when one is not
  // there (root decision 0176 point 4), and the origins of the sibling
  // modules among them, read at this start (F26 addendum of 2026-10-10).
  // Personalspace modules belong to no Organization: nothing to check.
  const requiredSlots = (plan: Parameters<Adapters["prepareLaunch"]>[0]) => {
    const slots = plan.runtime.optional.required_module_slots;
    return input.organizationRoot === undefined || !Array.isArray(slots)
      ? Promise.resolve({})
      : requiredSlotOrigins({
          organizationDirectory: selected.cwd,
          company: plan.runtime.company,
          module: plan.runtime.module,
          slots,
        });
  };
  const secretInput = (plan: Parameters<Adapters["prepareLaunch"]>[0]) => ({
    runtime: plan.runtime,
    personalspace: input.personalspace === true,
    source: input.secretSource,
  });
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
      // The module's data before anything else of its preparation: a start
      // or a preparation without it installs nothing.
      if (input.organizationRoot !== undefined)
        await input.provideData?.(module.moduleDirectory);
      // A start whose required slot is not there installs nothing, nor one
      // whose required secret the vault cannot give it, as far as is known
      // without reading it (decision F46).
      if (check) {
        await requiredSlots(plan);
        await admitRuntimeSecrets(secretInput(plan));
      }
      const options = {
        moduleDirectory: module.moduleDirectory,
        applicationPackage: plan.package,
        organizationDirectory: selected.cwd,
        executable: selected.executable,
        resolveBun,
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
    // The app's development script, or with `production` its own server
    // from `main` (decision F58, addendum of 2026-10-21): the same checks,
    // siblings, origin and secrets, its `start_script` in production mode.
    async prepareLaunch(plan, cwd, production) {
      const server = plan.runtime.server;
      if (production !== undefined && server === null)
        throw new Error("Application without its own server");
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
      // The App's own Bun (decision F62), checked once more as F25 checks
      // the selected one, with its directory first on the App's PATH.
      const bun = await resolveBun({
        packageManager: binding.authority.packageManager,
        owner: binding.authority.owner,
      });
      const base = withModuleBun(selected.env, bun);
      requireBunToolchain(
        await inspectBunToolchain({
          executable: bun.executable,
          cwd,
          env: base,
          packageManager: binding.authority.packageManager,
        }),
        cwd,
      );
      // Checked again at the launch itself, with the sibling origins.
      const siblings = await requiredSlots(plan);
      const externalOrigin =
        plan.defaultApp && input.externalOrigin
          ? await input.externalOrigin(plan.runtime.module)
          : null;
      // Read last, at every start: a value changed in the vault reaches the
      // app at its next start. Only the app's own process gets them.
      const secrets = await readRuntimeSecrets(secretInput(plan));
      return {
        executable: bun.executable,
        cwd,
        args: [
          "--no-env-file",
          "run",
          production === undefined || server === null
            ? plan.runtime.dev_script
            : server.start_script,
        ],
        env: applicationEnvironment({
          base,
          plan,
          cwd,
          organizationRoot: input.organizationRoot,
          externalOrigin,
          siblings,
          secrets: secrets.variables,
          production,
        }),
        ...(secrets.notProvided.length > 0
          ? { secretsNotProvided: secrets.notProvided }
          : {}),
      };
    },
    // The static server as the app's one process (decision F58): the
    // operator's Bun runs the Platform's script, never a script or a Bun
    // configuration of the app, on the app's declared listener, with the
    // started application's environment in production mode and none of the
    // app's secrets or siblings (a static app declares none).
    ...(input.staticServer === undefined
      ? {}
      : {
          async prepareStaticLaunch(
            plan: Parameters<NonNullable<Adapters["prepareStaticLaunch"]>>[0],
            cwd: string,
            serve: Parameters<NonNullable<Adapters["prepareStaticLaunch"]>>[2],
          ) {
            const module = await authorize(
              {
                company: plan.runtime.company,
                module: plan.runtime.module,
                package: plan.package,
              },
              "start",
            );
            if (dirname(join(module.moduleDirectory, plan.package)) !== cwd)
              throw new Error("Application scope changed");
            const built = plan.runtime.static;
            if (built === null || input.staticServer === undefined)
              throw new Error("Static application required");
            const files = await input.staticServer();
            return {
              executable: selected.executable,
              cwd,
              args: [
                "--no-env-file",
                `--config=${files.config}`,
                files.script,
                "--served",
                serve.served,
                "--fallback",
                built.fallback,
              ],
              env: {
                ...applicationEnvironment({
                  base: selected.env,
                  plan,
                  cwd,
                  organizationRoot: input.organizationRoot,
                }),
                NODE_ENV: "production",
              },
            };
          },
        }),
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
