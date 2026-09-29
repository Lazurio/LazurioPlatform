import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { canonicalCheckoutDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import {
  isModuleId,
  ModuleOriginError,
  moduleOrigin,
} from "../launchpad/hosted-entry";
import {
  type Catalog,
  type CatalogOrganization,
  readFolderCatalog,
} from "../organizations/catalog";
import {
  catalogGroups,
  selectCatalogOrganization,
} from "../organizations/catalog-selection";
import {
  locatePersonalspace,
  observePersonalspaceModule,
  resolvePersonalspaceApplication,
} from "../organizations/personalspace";
import { checkoutRefusal } from "../providers/checkout-custody";
import { createApplicationCoordination } from "./application-coordination";
import {
  type ApplicationRunner,
  type RunnerKind,
  selectApplicationRunnerKind,
} from "./application-runner";
import { createApplicationLifecycle } from "./lifecycle";
import { localApplicationAdapters } from "./local-application-adapters";
import { preparationRefusal } from "./preparation-refusal";
import {
  createServiceManagerProcess,
  userManagerState,
} from "./service-manager-process";
import { createSessionRunner } from "./session-runner";
import {
  applicationCoordinationLockFile,
  applicationUnitName,
  createSystemdUserRunner,
  journalLinesMax,
  readApplicationJournal,
} from "./systemd-user-runner";

// The module lifecycle of a Folder (launchpad-parity B3, root decision 0167):
// `lazurio module start|stop|status|logs <Org>/<module>` and the Launchpad's
// `/api/modules/<org>/<module>/…` answer from this one core, and so does the
// gateway's `ensure` on a hosted Machine (B5), by module id. A module of the
// Personalspace (B11) is `personalspace/<module>`, and its lifecycle is keyed
// by its owner directory as an Organization's is by its root. A module is named
// through the catalog's selection rule and runs its declared app through the
// existing lifecycle, runners and adapters. There is no state of its own: what
// runs is what the OS service manager (Linux) or the Launchpad's session
// (macOS) reports, and every call reads the catalog again.

export type ModuleVerb = "start" | "stop" | "status" | "logs";
export const moduleVerbs: readonly ModuleVerb[] = [
  "start",
  "stop",
  "status",
  "logs",
];

/** Every operation of this core: the CLI's verbs and the gateway's `ensure`
 * (launchpad-parity B5), which only the hosted Launchpad serves. */
export type ModuleOperation = ModuleVerb | "ensure";

/** Where the module operations run: the environment of the operator's account.
 * Trusted composition, never request input. */
export type ModuleHost = Readonly<{
  platform: string;
  /** The operator's home; Bun is `<home>/.local/bin/bun` (B2, decision 0161). */
  home: string | undefined;
  /** PATH of a started application. */
  path: string;
  tmpdir?: string | undefined;
  /** The user manager's runtime directory (`XDG_RUNTIME_DIR`), on Linux. */
  runtimeDirectory: string | undefined;
  /** This executable: the session runner's process guard. */
  platformExecutable: string;
  /** A development or test override of the standard Bun path. */
  bunExecutable?: string | undefined;
  /** Who owns started applications on this Machine. */
  runnerKind: () => Promise<RunnerKind>;
  createRunner: (
    kind: RunnerKind,
    organizationDirectory: string,
  ) => ApplicationRunner;
  readJournal: (
    unit: string,
    lines: number,
  ) => ReturnType<typeof readApplicationJournal>;
}>;

/** The standard Bun of the operator's account (B2): one rule for the CLI, the
 * Launchpad and every Machine, following the operator's own Bun updates. */
export const standardBun = "~/.local/bin/bun";

/** The host of this process: its account, the standard toolchain path and
 * the runner the platform selects (`systemd-user` on Linux with a reachable
 * user manager, otherwise `session`). */
export function processModuleHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
  platformExecutable: string = process.execPath,
): ModuleHost {
  const home = env.HOME?.startsWith("/") ? env.HOME : undefined;
  const runtimeDirectory = env.XDG_RUNTIME_DIR;
  const local = home === undefined ? [] : [`${home}/.local/bin`];
  // Linux: the installed unit's PATH line (B2), so the CLI and the Launchpad
  // start identical units. macOS: the session keeps its own PATH after it.
  const path = [
    ...local,
    ...(platform === "linux"
      ? ["/usr/local/bin", "/usr/bin", "/bin"]
      : (env.PATH ?? "/usr/bin:/bin").split(":").filter((entry) => entry)),
  ]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(":");
  let kind: Promise<RunnerKind> | undefined;
  return Object.freeze({
    platform,
    home,
    path,
    tmpdir: env.TMPDIR,
    runtimeDirectory,
    platformExecutable,
    runnerKind: () => {
      kind ??= selectApplicationRunnerKind({
        platform,
        environment: { XDG_RUNTIME_DIR: runtimeDirectory },
        userManagerState: () =>
          userManagerState(createServiceManagerProcess(runtimeDirectory ?? "")),
      });
      return kind;
    },
    createRunner: (selected: RunnerKind, organizationDirectory: string) =>
      selected === "systemd-user"
        ? createSystemdUserRunner({
            organizationDirectory,
            runtimeDirectory: runtimeDirectory as string,
            run: createServiceManagerProcess(runtimeDirectory as string),
          })
        : createSessionRunner(platformExecutable),
    readJournal: (unit: string, lines: number) =>
      readApplicationJournal(
        createServiceManagerProcess(runtimeDirectory ?? ""),
        unit,
        lines,
      ),
  });
}

/** The typed refusal of a module operation. Reasons of the catalog
 * (`organization-not-executable`, `no-app`, …) and of the lifecycle
 * (`port-occupied`, `prerequisites-not-ready`, `coordination-busy`, …) are
 * kept verbatim. A file of the module's checkout that the checkout rule
 * refuses (decision F23) is `declaration-not-regular`, `declaration-owner`
 * or `declaration-too-large` with its module-relative `file`, whether the
 * catalog or the start read it. A preparation that cannot run for a known
 * reason (decision F25) is one of `preparationReasons` with the package or
 * lockfile it concerns. */
export type ModuleBlocked = Readonly<{
  kind: "blocked";
  operation: ModuleOperation;
  reason: string;
  organization?: string;
  module?: string;
  app?: string;
  /** `organization-ambiguous`, `module-ambiguous`: the directories of every
   * candidate. */
  candidates?: readonly string[];
  /** `toolchain-missing`: which tool and where it is expected. */
  tool?: string;
  expected?: string;
  /** `declaration-*`: the refused file, relative to the module, to the
   * Organization root for an Organization document, or `~/…` for the
   * account's own package manager configuration; `preparation-*`: the
   * package or lockfile, relative to the module. Never absolute. */
  file?: string;
}>;

export type ModuleState =
  | "running"
  | "starting"
  | "stopping"
  | "ended"
  | "stopped";

export type ModuleAnswer = Readonly<{
  kind: "module";
  operation: Exclude<ModuleOperation, "logs">;
  organization: string;
  module: string;
  app: string;
  runner: RunnerKind;
  /** True under the service manager: the app outlives a Launchpad restart. */
  survivesLaunchpadRestart: boolean;
  /** The lifecycle's own result: `started`, `already-managed`,
   * `group-stopped`, `status`, `not-managed`; for `ensure` also
   * `start-pending`, a start still running when the answer was due. */
  outcome: string;
  state: ModuleState;
  /** The declared health passed on a listener this app's owner holds. */
  healthy: boolean;
  /** The service manager's identity of this run; null for a session app. */
  service: Readonly<{ unit: string; invocationId: string }> | null;
  /** The browser link, only while the app reports healthy (root AGENTS.md
   * names it `result.runtime.url`). On a hosted Machine it is composed only
   * from the recorded entry's module origin template, locally it is the
   * loopback URL the app's owner observed. */
  runtime: Readonly<{ url: string }> | null;
  /** Why a healthy app has no link. */
  runtimeReason?: string;
}>;

export type ModuleLogs = Readonly<{
  kind: "module-logs";
  organization: string;
  module: string;
  app: string;
  unit: string;
  lines: readonly string[];
}>;

export type ModuleResult = ModuleAnswer | ModuleLogs | ModuleBlocked;

/** The result of an operation that completed as asked. */
export const moduleSucceeded = (result: ModuleResult) =>
  result.kind !== "blocked";

export type ModuleOptions = Readonly<{
  /** A declared app other than the module's default (`--app`). */
  app?: string | undefined;
  /** `logs`: how many of the newest lines. */
  lines?: number | undefined;
}>;

export const moduleLogLinesDefault = 100;

/** How long `ensure` waits for a started app to report healthy before it
 * answers "starting": the resident's `openHealthyWaitMs`
 * (`R:lazurio/runtime/runtime-lib.mjs:44`). The gateway sets no response
 * timeout of its own (`M:workloads/workspace-vm/ingress.ts:124-159`). */
export const ensureWaitMsDefault = 20_000;
/** How often `ensure` reads the status while it waits (the resident's
 * `openHealthyPollMs`, `R:lazurio/runtime/runtime-lib.mjs:45`). */
export const ensurePollMsDefault = 250;

export type EnsureOptions = Readonly<{
  /** Whether this request may start a stopped app: a top-level navigation
   * (an Open) may; a background fetch or a WebSocket reconnect only reports.
   * A lifecycle hint, never an access decision. */
  mayStart: boolean;
  waitMs?: number | undefined;
  pollMs?: number | undefined;
}>;

type Target = Readonly<{
  /** The name shown: the Organization slug, or `personalspace`. */
  organization: string;
  /** The declared company the lifecycle selects by: the Organization slug,
   * or what the Personalspace module declares. Never shown by this core. */
  company: string;
  module: string;
  app: string;
  isDefaultApp: boolean;
  /** The Organization root, or the Personalspace's owner directory. */
  organizationDirectory: string;
  /** The module's checkout: the names of refused files are relative to it. */
  moduleDirectory: string;
  personalspace: boolean;
}>;

type Lifecycle = ReturnType<typeof createApplicationLifecycle>;

// The recorded place of this Folder, for the link: a workstation (no
// Machine binding), a hosted Machine with or without its recorded entry, or
// unknown when the state cannot be read (then no link at all, never a guess).
async function folderPlace(folder: string) {
  try {
    const state = join(folder, ".lazurio");
    const { preferences } = await withFolderReadLock(state, () =>
      readFolderState(state),
    );
    const machine = preferences.machine;
    if (machine === null) return { kind: "local" as const };
    return {
      kind: "hosted" as const,
      template: machine.entry?.moduleOriginTemplate ?? null,
    };
  } catch {
    return { kind: "unknown" as const };
  }
}

/** The module operations of one Folder. `owner` is who holds a lifecycle:
 * the Launchpad keeps one per Organization for its whole life (a session
 * app is its child); the CLI builds one per call and closes it, and so can
 * operate only apps the service manager owns. */
export function createModuleOperations(input: {
  folder: string;
  owner: "launchpad" | "cli";
  host: ModuleHost;
  /** Test seam: the catalog core; the product reads the Folder. */
  readCatalog?: (folder: string) => Promise<Catalog>;
}) {
  const { folder, owner, host } = input;
  const readCatalog = input.readCatalog ?? readFolderCatalog;
  const held = new Map<string, Lifecycle>();
  // Starts `ensure` has begun and not yet seen end, per app: a burst of
  // gateway subrequests (a page and its assets, the reloads of the
  // "starting" page) joins the one start instead of queueing more. Memory of
  // this process only, gone when the start ends; not state.
  const ensuring = new Map<string, Promise<ModuleAnswer | ModuleBlocked>>();
  let closing = false;

  const blocked = (
    operation: ModuleOperation,
    reason: string,
    extra: Partial<Omit<ModuleBlocked, "kind" | "operation" | "reason">> = {},
  ): ModuleBlocked =>
    Object.freeze({ kind: "blocked" as const, operation, reason, ...extra });

  // The refusal of a throw inside an operation: a preparation refused for a
  // known reason (decision F25) or a refused file of the module's checkout
  // (decision F23), by its reason and module-relative file; anything else
  // `operation-failed`. Never the error's message or an absolute path.
  const moduleFailure = (
    operation: ModuleOperation,
    target: Target,
    error: unknown,
  ): ModuleBlocked => {
    const where = {
      organization: target.organization,
      module: target.module,
      app: target.app,
    };
    const refused =
      preparationRefusal(error, [
        target.moduleDirectory,
        target.organizationDirectory,
      ]) ??
      checkoutRefusal(
        error,
        [target.moduleDirectory, target.organizationDirectory],
        host.home,
      );
    return refused === null
      ? blocked(operation, "operation-failed", where)
      : blocked(operation, refused.reason, { ...where, file: refused.file });
  };

  // `<Org>/<module>` through the catalog's one selection rule, then the app:
  // `--app` when named, otherwise the module's declared default.
  async function resolve(
    operation: ModuleVerb,
    name: string,
    options: ModuleOptions,
  ): Promise<Target | ModuleBlocked> {
    const parts = name.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1])
      return blocked(operation, "module-name-invalid");
    const [organizationName, moduleName] = parts as [string, string];
    let catalog: Catalog;
    try {
      catalog = await readCatalog(folder);
    } catch {
      return blocked(operation, "folder-unreadable");
    }
    const selection = selectCatalogOrganization(catalog, organizationName);
    if (selection.kind === "missing")
      return blocked(operation, "organization-unknown", {
        organization: organizationName,
      });
    if (selection.kind === "ambiguous")
      return blocked(operation, "organization-ambiguous", {
        organization: organizationName,
        candidates: Object.freeze(
          selection.candidates.map((entry) => entry.directory),
        ),
      });
    return targetOf(
      operation,
      selection.organization,
      selection.organization === catalog.personalspace,
      moduleName,
      options,
    );
  }

  // The gateway names a module only by its exact lazurio.module.v1 id and
  // serves it at one hostname per Machine (launchpad-parity B4, B5): the id
  // must name a module of exactly one Organization of the catalog, the
  // Personalspace group counting as one (B11). Every group that lists the id
  // counts, runnable or not, because the gateway routes the hostname to one
  // of their declared ports; which one is its choice, so none is guessed here
  // (`module-ambiguous`).
  async function resolveId(id: string): Promise<Target | ModuleBlocked> {
    if (!isModuleId(id)) return blocked("ensure", "module-unknown");
    let catalog: Catalog;
    try {
      catalog = await readCatalog(folder);
    } catch {
      return blocked("ensure", "folder-unreadable");
    }
    const owners = catalogGroups(catalog).filter((organization) =>
      organization.modules.some((entry) => entry.module === id),
    );
    const only = owners[0];
    if (only === undefined)
      return blocked("ensure", "module-unknown", { module: id });
    if (owners.length > 1)
      return blocked("ensure", "module-ambiguous", {
        module: id,
        candidates: Object.freeze(owners.map((entry) => entry.directory)),
      });
    // The module's default app only: ensure takes no `--app`.
    return targetOf("ensure", only, only === catalog.personalspace, id, {});
  }

  async function targetOf(
    operation: ModuleOperation,
    organization: CatalogOrganization,
    personalspace: boolean,
    moduleName: string,
    options: ModuleOptions,
  ): Promise<Target | ModuleBlocked> {
    const shownOrganization =
      organization.organization ?? organization.directory;
    const matches = organization.modules.filter(
      (entry) => entry.module === moduleName,
    );
    const module = matches[0];
    if (module === undefined)
      return organization.modules.length === 0 &&
        organization.reason !== undefined
        ? blocked(operation, organization.reason, {
            organization: shownOrganization,
            module: moduleName,
            ...(organization.file === undefined
              ? {}
              : { file: organization.file }),
          })
        : blocked(operation, "module-unknown", {
            organization: shownOrganization,
            module: moduleName,
          });
    const where = { organization: shownOrganization, module: moduleName };
    if (matches.length > 1)
      return blocked(operation, "declaration-conflict", where);
    // A module whose only fault is its default app still runs a named app:
    // no default, an invalid one, or one whose package.json was refused (the
    // module was read, so it lists its apps).
    const namedApp = options.app !== undefined;
    const defaultAppFault =
      module.reason === "no-app" ||
      module.reason === "default-app-invalid" ||
      (module.file !== undefined && module.apps.length > 0);
    if (!module.executable && !(namedApp && defaultAppFault))
      return blocked(operation, module.reason ?? "not-executable", {
        ...where,
        ...(module.file === undefined ? {} : { file: module.file }),
      });
    const app = options.app ?? module.defaultApp;
    if (app === null) return blocked(operation, "no-app", where);
    const declared = module.apps.find((entry) => entry.package === app);
    if (declared === undefined)
      return blocked(operation, "app-unknown", { ...where, app });
    if (declared.kind !== "runtime-declared")
      return declared.reason !== undefined && declared.file !== undefined
        ? blocked(operation, declared.reason, {
            ...where,
            app,
            file: declared.file,
          })
        : blocked(operation, "app-not-runnable", { ...where, app });
    if (organization.organization === null)
      return blocked(operation, "organization-unavailable", where);
    const common = {
      organization: organization.organization,
      module: module.module,
      app,
      isDefaultApp: app === module.defaultApp,
    };
    if (personalspace) {
      // The owner directory again, by the same rule as the catalog, and the
      // company its module declares: selected by, never shown.
      const unavailable = () =>
        blocked(operation, "personalspace-unavailable", where);
      const located = await locatePersonalspace(folder);
      if (located.kind !== "owner") return unavailable();
      try {
        const directory = await canonicalCheckoutDirectory(located.directory);
        const { path, observed } = await observePersonalspaceModule(
          directory,
          module.module,
        );
        if (observed.kind !== "module-observed")
          return blocked(operation, observed.kind, {
            ...where,
            ...("file" in observed ? { file: observed.file } : {}),
          });
        return Object.freeze({
          ...common,
          company: observed.company,
          organizationDirectory: directory,
          moduleDirectory: path,
          personalspace: true,
        });
      } catch {
        return unavailable();
      }
    }
    let organizationDirectory: string;
    try {
      // ONE canonical spelling before any unit name or lock is derived.
      organizationDirectory = await canonicalCheckoutDirectory(
        join(folder, "organizations", organization.directory),
      );
    } catch {
      return blocked(operation, "organization-unavailable", where);
    }
    return Object.freeze({
      ...common,
      company: organization.organization,
      organizationDirectory,
      moduleDirectory: join(organizationDirectory, module.path),
      personalspace: false,
    });
  }

  function lifecycleFor(kind: RunnerKind, target: Target) {
    const { organizationDirectory } = target;
    const runner = host.createRunner(kind, organizationDirectory);
    const environment: Record<string, string> = {
      HOME: host.home as string,
      PATH: host.path,
    };
    if (host.tmpdir) environment.TMPDIR = host.tmpdir;
    return createApplicationLifecycle(
      localApplicationAdapters({
        organizationDirectory,
        bunExecutable:
          host.bunExecutable ?? join(host.home as string, ".local/bin/bun"),
        platformExecutable: host.platformExecutable,
        environment,
        runner,
        ...(target.personalspace
          ? { resolveApplication: resolvePersonalspaceApplication }
          : {}),
        ...(kind === "systemd-user"
          ? {
              coordination: createApplicationCoordination({
                lockFile: applicationCoordinationLockFile(
                  host.runtimeDirectory as string,
                  organizationDirectory,
                ),
              }),
            }
          : {}),
      }),
    );
  }

  // The lifecycle of the target's Organization: held by the Launchpad, one
  // per call for the CLI.
  async function operate<T>(
    operation: ModuleOperation,
    kind: RunnerKind,
    target: Target,
    action: (lifecycle: Lifecycle) => Promise<T>,
  ): Promise<T | ModuleBlocked> {
    // A throw inside the lifecycle changed nothing it could not confirm. A
    // preparation refused for a known reason (decision F25) and a file of the
    // module's checkout that the checkout rule refused (decision F23) are
    // named by their reason and file; any other throw is `operation-failed`.
    const failed = (error: unknown) => moduleFailure(operation, target, error);
    if (owner === "launchpad") {
      try {
        let lifecycle = held.get(target.organizationDirectory);
        if (lifecycle === undefined) {
          // A shutdown that already drained the held lifecycles never gets
          // a new one behind its back.
          if (closing) return blocked(operation, "closing");
          lifecycle = lifecycleFor(kind, target);
          held.set(target.organizationDirectory, lifecycle);
        }
        return await action(lifecycle);
      } catch (error) {
        return failed(error);
      }
    }
    let lifecycle: Lifecycle;
    try {
      lifecycle = lifecycleFor(kind, target);
    } catch (error) {
      return failed(error);
    }
    try {
      return await action(lifecycle);
    } catch (error) {
      return failed(error);
    } finally {
      await lifecycle.close();
    }
  }

  // Resolution and the owner's rules shared by every verb.
  async function prepare(
    operation: ModuleVerb,
    name: string,
    options: ModuleOptions,
  ): Promise<Prepared | ModuleBlocked> {
    if (closing) return blocked(operation, "closing");
    if (host.home === undefined) return blocked(operation, "home-unknown");
    const target = await resolve(operation, name, options);
    if ("kind" in target) return target;
    return owned(operation, target);
  }

  // The owner's rules of a resolved target.
  async function owned(
    operation: ModuleOperation,
    target: Target,
  ): Promise<Prepared | ModuleBlocked> {
    const kind = await host.runnerKind();
    const where = {
      organization: target.organization,
      module: target.module,
      app: target.app,
    };
    // Session apps are children of the Launchpad that started them: nothing
    // else can see them, and their output is not kept (macOS line, P14).
    if (kind === "session" && operation === "logs")
      return blocked(operation, "logs-unavailable", where);
    if (kind === "session" && owner === "cli")
      return blocked(operation, "launchpad-required", where);
    return Object.freeze({
      target,
      runner: kind,
      selection: Object.freeze({
        company: target.company,
        module: target.module,
        package: target.app,
      }),
    });
  }

  async function link(
    lifecycle: Lifecycle,
    target: Target,
    selection: Selection,
  ): Promise<Pick<ModuleAnswer, "runtime" | "runtimeReason">> {
    const observed = await lifecycle.entrypoint(selection);
    if (observed.kind !== "local-entrypoint")
      return { runtime: null, runtimeReason: observed.kind };
    const place = await folderPlace(folder);
    if (place.kind === "local") return { runtime: { url: observed.url } };
    if (place.kind === "unknown")
      return { runtime: null, runtimeReason: "folder-state-unreadable" };
    // Hosted: never the loopback address. The link is the recorded entry's
    // module origin, which the gateway serves for the module's default app
    // only (B4, B5); nothing is composed from a convention.
    if (place.template === null)
      return { runtime: null, runtimeReason: "hosted-entry-missing" };
    if (!target.isDefaultApp)
      return { runtime: null, runtimeReason: "hosted-app-not-default" };
    try {
      return {
        runtime: { url: `${moduleOrigin(place.template, target.module)}/` },
      };
    } catch (error) {
      return {
        runtime: null,
        runtimeReason:
          error instanceof ModuleOriginError ? error.code : "module-origin",
      };
    }
  }

  // The owner's view of one app now, as an answer.
  async function observe(
    operation: ModuleAnswer["operation"],
    outcome: string | null,
    kind: RunnerKind,
    target: Target,
    selection: Selection,
    lifecycle: Lifecycle,
    // The operation a refusal of the status read names; `ensure` answers
    // with its own operation but its status read is refused as `status`.
    refusedAs: ModuleOperation = operation,
  ): Promise<ModuleAnswer | ModuleBlocked> {
    const where = {
      organization: target.organization,
      module: target.module,
      app: target.app,
    };
    const status = await lifecycle.status(selection);
    const base = {
      kind: "module" as const,
      operation,
      ...where,
      runner: kind,
      survivesLaunchpadRestart: kind === "systemd-user",
    };
    if (status.kind === "not-managed")
      return Object.freeze({
        ...base,
        outcome: outcome ?? status.kind,
        state: "stopped" as const,
        healthy: false,
        service: null,
        runtime: null,
      });
    if (status.kind !== "status") return blocked(refusedAs, status.kind, where);
    const service =
      "service" in status && status.service
        ? Object.freeze({
            unit: status.service.unit,
            invocationId: status.service.invocationId,
          })
        : null;
    const healthy = status.observedHealthy;
    return Object.freeze({
      ...base,
      outcome: outcome ?? status.kind,
      state: status.state,
      healthy,
      service,
      ...(healthy
        ? await link(lifecycle, target, selection)
        : { runtime: null }),
    });
  }

  // Start the prepared app unless it runs: the toolchain from the standard
  // path, checked before any effect, then the lifecycle's start.
  async function startOwned({
    target,
    runner: kind,
    selection,
  }: Prepared): Promise<ModuleAnswer | ModuleBlocked> {
    const bun =
      host.bunExecutable ?? join(host.home as string, ".local/bin/bun");
    const present = await stat(bun)
      .then(async (entry) => {
        if (!entry.isFile()) return false;
        await access(bun, constants.X_OK);
        return true;
      })
      .catch(() => false);
    if (!present)
      return blocked("start", "toolchain-missing", {
        organization: target.organization,
        module: target.module,
        app: target.app,
        tool: "bun",
        expected: host.bunExecutable === undefined ? standardBun : bun,
      });
    return operate("start", kind, target, async (lifecycle) => {
      const started = await lifecycle.start(selection);
      if (started.kind !== "started" && started.kind !== "already-managed")
        return blocked("start", started.kind, {
          organization: target.organization,
          module: target.module,
          app: target.app,
          // The file a failed preparation concerns (decision F25).
          ...("file" in started && typeof started.file === "string"
            ? { file: started.file }
            : {}),
        });
      return observe("start", started.kind, kind, target, selection, lifecycle);
    });
  }

  // Seams of later slices, deliberately not built here:
  // - B3 `prepare` and `open` (prepare when needed, start, wait for health,
  //   the link) compose `lifecycle.prepare` and the same `observe`; until
  //   then `ensure` starts, which for a module without a declared
  //   preparation includes its default frozen install (decision F25).
  // - P9 `--source worktree:<name>` selects another checkout; until then every
  //   verb runs the module's own checkout.
  return Object.freeze({
    /** Start the module's app (its default, or `app`) unless it runs. */
    async start(
      name: string,
      options: ModuleOptions = {},
    ): Promise<ModuleAnswer | ModuleBlocked> {
      const prepared = await prepare("start", name, options);
      if ("kind" in prepared) return prepared;
      return startOwned(prepared);
    },
    /** The gateway's `ensure` (launchpad-parity B5): make the default app of
     * the module with this exact lazurio.module.v1 id run. Healthy now: the
     * status, at once. Otherwise, when `mayStart`, start it (joining a start
     * already under way) and wait at most `waitMs` for it to report healthy;
     * the start goes on after the answer. Refusals keep the operation that
     * refused: `ensure` when the id names no single runnable default app,
     * `status` or `start` when the lifecycle refused. */
    async ensure(
      id: string,
      options: EnsureOptions,
    ): Promise<ModuleAnswer | ModuleBlocked> {
      const waitMs = options.waitMs ?? ensureWaitMsDefault;
      const pollMs = options.pollMs ?? ensurePollMsDefault;
      const deadline = Date.now() + waitMs;
      if (closing) return blocked("ensure", "closing");
      if (host.home === undefined) return blocked("ensure", "home-unknown");
      const target = await resolveId(id);
      if ("kind" in target) return target;
      const prepared = await owned("ensure", target);
      if ("kind" in prepared) return prepared;
      const { runner: kind, selection } = prepared;
      const read = (outcome: string | null) =>
        operate("status", kind, target, (lifecycle) =>
          observe(
            "ensure",
            outcome,
            kind,
            target,
            selection,
            lifecycle,
            "status",
          ),
        );
      const current = await read(null);
      if (current.kind === "blocked" || current.healthy || !options.mayStart)
        return current;
      const key = `${target.organizationDirectory}\0${target.module}\0${target.app}`;
      let starting = ensuring.get(key);
      if (starting === undefined) {
        const run = startOwned(prepared)
          .catch((error: unknown) => moduleFailure("start", target, error))
          .finally(() => {
            if (ensuring.get(key) === run) ensuring.delete(key);
          });
        starting = run;
        ensuring.set(key, run);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const started = await Promise.race([
        starting,
        new Promise<"pending">((resolve) => {
          timer = setTimeout(
            () => resolve("pending"),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (started === "pending") return read("start-pending");
      if (started.kind === "blocked") return started;
      let latest: ModuleAnswer | ModuleBlocked = Object.freeze({
        ...started,
        operation: "ensure" as const,
      });
      while (
        latest.kind === "module" &&
        !latest.healthy &&
        !closing &&
        Date.now() + pollMs <= deadline
      ) {
        await Bun.sleep(pollMs);
        latest = await read(started.outcome);
      }
      return latest;
    },
    /** Stop the app; stopping one that does not run is `not-managed`. */
    async stop(
      name: string,
      options: ModuleOptions = {},
    ): Promise<ModuleAnswer | ModuleBlocked> {
      const prepared = await prepare("stop", name, options);
      if ("kind" in prepared) return prepared;
      const { target, runner: kind, selection } = prepared;
      return operate("stop", kind, target, async (lifecycle) => {
        const stopped = await lifecycle.stop(selection);
        if (stopped.kind !== "group-stopped" && stopped.kind !== "not-managed")
          return blocked("stop", stopped.kind, {
            organization: target.organization,
            module: target.module,
            app: target.app,
          });
        return Object.freeze({
          kind: "module" as const,
          operation: "stop" as const,
          organization: target.organization,
          module: target.module,
          app: target.app,
          runner: kind,
          survivesLaunchpadRestart: kind === "systemd-user",
          outcome: stopped.kind,
          state: "stopped" as const,
          healthy: false,
          service: null,
          runtime: null,
        });
      });
    },
    /** The owner's view: state, health, the service identity and the link. */
    async status(
      name: string,
      options: ModuleOptions = {},
    ): Promise<ModuleAnswer | ModuleBlocked> {
      const prepared = await prepare("status", name, options);
      if ("kind" in prepared) return prepared;
      const { target, runner: kind, selection } = prepared;
      return operate("status", kind, target, (lifecycle) =>
        observe("status", null, kind, target, selection, lifecycle),
      );
    },
    /** The newest lines the app's unit wrote to the journal (Linux). */
    async logs(
      name: string,
      options: ModuleOptions = {},
    ): Promise<ModuleLogs | ModuleBlocked> {
      const lines = options.lines ?? moduleLogLinesDefault;
      if (!Number.isInteger(lines) || lines < 1 || lines > journalLinesMax)
        return blocked("logs", "lines-invalid");
      const prepared = await prepare("logs", name, options);
      if ("kind" in prepared) return prepared;
      const { target } = prepared;
      const unit = applicationUnitName(target.organizationDirectory, {
        company: target.company,
        module: target.module,
        package: target.app,
      });
      const journal = await host.readJournal(unit, lines);
      if (journal.kind !== "journal")
        return blocked("logs", "journal-unavailable", {
          organization: target.organization,
          module: target.module,
          app: target.app,
        });
      return Object.freeze({
        kind: "module-logs" as const,
        organization: target.organization,
        module: target.module,
        app: target.app,
        unit,
        lines: journal.lines,
      });
    },
    /** Owner shutdown: a session app ends with its Launchpad, a service app
     * keeps running. */
    async close() {
      closing = true;
      let complete = true;
      for (const [directory, lifecycle] of held) {
        try {
          if ((await lifecycle.close()).kind === "closed")
            held.delete(directory);
          else complete = false;
        } catch {
          complete = false;
        }
      }
      return Object.freeze({
        kind: complete ? ("closed" as const) : ("incomplete" as const),
      });
    },
  });
}

type Selection = Readonly<{ company: string; module: string; package: string }>;
type Prepared = Readonly<{
  target: Target;
  runner: RunnerKind;
  selection: Selection;
}>;

export type ModuleOperations = ReturnType<typeof createModuleOperations>;
