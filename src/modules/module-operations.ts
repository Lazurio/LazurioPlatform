import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  contentLockDirectory,
  processGitHubHost,
  readFolderKind,
} from "../content/host";
import { contentScope } from "../content/model";
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
import { selectCatalogOrganization } from "../organizations/catalog-selection";
import {
  observePersonalspaceModule,
  type PersonalspaceHolderRead,
  personalspaceMayOwn,
  personalspaceName,
  resolvePersonalspaceApplication,
  unverifiedPersonalspace,
} from "../organizations/personalspace";
import { checkoutRefusal } from "../providers/checkout-custody";
import { toolsEnvironmentOf } from "../tools/overview";
import { resolveOnPath, runTool } from "../tools/status";
import { resolveInstallBase } from "../update/base";
import { processVaultHost } from "../vault/host";
import { createApplicationCoordination } from "./application-coordination";
import { buildEnvironment } from "./application-environment";
import {
  type ApplicationRunner,
  type RunnerKind,
  selectApplicationRunnerKind,
} from "./application-runner";
import {
  type BuildJob,
  type BuildOutcome,
  type BuildRunner,
  buildUnderWay,
  createBuilds,
  processAlive,
} from "./built/builds";
import { gitCheckoutReader, type ReadCheckout } from "./built/checkout";
import {
  appBuildDirectory,
  type BuildInput,
  type BuildRecord,
  buildCacheRoot,
  buildKeyOf,
  buildLockFile,
  listBuildStates,
  openBuildStore,
  staticServerFiles,
  staticServerServes,
} from "./built/store";
import {
  type BuildWatcher,
  createBuildWatcher,
  type DirectoryWatch,
  type WatchedApp,
} from "./built/watcher";
import {
  type DataMountHost,
  moduleDataMounts,
  provideDataMounts,
} from "./data-mounts";
import { createApplicationLifecycle } from "./lifecycle";
import { localApplicationAdapters } from "./local-application-adapters";
import { preparationRefusal } from "./preparation-refusal";
import { readModuleApplication } from "./read-application";
import {
  type RuntimeSecretFinding,
  type RuntimeSecretSource,
  RuntimeSecretUnavailable,
  vaultRuntimeSecretSource,
} from "./runtime-secrets";
import {
  createServiceManagerProcess,
  userManagerState,
} from "./service-manager-process";
import { createSessionRunner } from "./session-runner";
import { RequiredSlotRefused } from "./sibling-origins";
import {
  applicationCoordinationLockFile,
  applicationUnitName,
  createSystemdUserRunner,
  journalLinesMax,
  readApplicationJournal,
} from "./systemd-user-runner";

// The module lifecycle of a Folder (launchpad-parity B3, root decision 0167):
// `lazurio module start|prepare|stop|status|logs <Org>/<module>` and the Launchpad's
// `/api/modules/<org>/<module>/…` answer from this one core, and so does the
// gateway's `ensure` on a hosted Machine (B5), by module id. A module of the
// Personalspace (B11) is `personalspace/<module>`, and its lifecycle is keyed
// by its owner directory as an Organization's is by its root. A module is named
// through the catalog's selection rule and runs its declared app through the
// existing lifecycle, runners and adapters. There is no state of its own: what
// runs is what the OS service manager (Linux) or the Launchpad's session
// (macOS) reports, and every call reads the catalog again. A Personalspace
// module runs only from the Personalspace this Environment's GitHub account
// holds (#186): the holder decision is asked with the catalog, at the
// selection and again by the lifecycle's own authorization.

export type ModuleVerb =
  | "start"
  | "prepare"
  | "build"
  | "stop"
  | "status"
  | "logs";
export const moduleVerbs: readonly ModuleVerb[] = [
  "start",
  "prepare",
  "build",
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
  /** Where the declared runtime secrets of the Folder's apps are read
   * (decision F46): the Environment vault of this process. None: an app
   * that requires a secret does not start (`no-vault-identity`). */
  runtimeSecrets?: ((folder: string) => RuntimeSecretSource) | undefined;
  /** Where a module's own data mounts are provided from at its preparation
   * (launchpad-parity B7): this Environment's gh and git and the install
   * base's content locks. None: no module provides its data here. */
  dataMounts?: DataMountHost | undefined;
  /** Where static apps are built and kept (decision F58): the account's
   * build cache and build lock, and its git, which reads the checkouts a
   * build is keyed by. None: every app runs its development script. */
  builds?:
    | Readonly<{
        cacheRoot: string;
        lockFile: string;
        readCheckout: ReadCheckout;
        /** Test seam: the build process. */
        runBuild?: BuildRunner | undefined;
      }>
    | undefined;
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
  // The same gh, git and per-user install base as content installation
  // (`processContentHost`), so a data mount a start clones and one an install
  // clones share one content lock.
  const tools = toolsEnvironmentOf(env, platform, runTool);
  const base = resolveInstallBase({
    platform,
    env: { XDG_DATA_HOME: tools.xdg?.XDG_DATA_HOME },
    homedir: tools.home,
  });
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
    ...(base === undefined
      ? {}
      : {
          dataMounts: Object.freeze({
            ...processGitHubHost({ env, platform, tools }),
            lockDirectory: contentLockDirectory(base),
          }),
        }),
    // The account's build cache and its git (decision F58).
    ...(home === undefined
      ? {}
      : {
          builds: Object.freeze({
            cacheRoot: buildCacheRoot(home, env),
            lockFile: buildLockFile(home, env),
            readCheckout: gitCheckoutReader(() =>
              resolveOnPath("git", tools.path, platform),
            ),
          }),
        }),
    // The vault of the Environment this process serves, read anew at each
    // start from its handover and Folder (decision F43).
    runtimeSecrets: (folder: string) =>
      vaultRuntimeSecretSource(
        processVaultHost({
          folder: async () => folder,
          env,
          platform,
          run: runTool,
        }),
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
   * package or lockfile, relative to the module; `required-slot-*`: the
   * slot the app requires, relative to the Organization root. Never
   * absolute. */
  file?: string;
  /** `runtime-secret-unavailable` (decision F46): each declared secret the
   * app cannot start without, by its name, and why it has no value. Never
   * a value. */
  secrets?: readonly RuntimeSecretFinding[];
  /** `build-failed` and the other refusals of a static app's build
   * (decision F58): its builds, with the failure and its log. */
  build?: ModuleBuild;
}>;

/** A static app's builds (decision F58), in every answer about one. */
export type ModuleBuild = Readonly<{
  /** What the running app was started as: its built output or its
   * development script (also one started before builds existed); null
   * while it does not run. */
  mode: "built" | "dev" | null;
  /** The build the running app serves. */
  served: Readonly<{ key: string; commit: string }> | null;
  /** The newest build there is. */
  current: Readonly<{
    key: string;
    commit: string;
    at: string;
    dirty: boolean;
  }> | null;
  /** A build under way, of this commit; or one waiting for its turn
   * behind another app's build (`queued`, its commit not read yet). */
  building: Readonly<{
    commit: string | null;
    at: string;
    queued: boolean;
  }> | null;
  /** The last build that failed, newer than the current one; its log in
   * the account's build cache (`~/…`). */
  failure: Readonly<{
    commit: string;
    at: string;
    reason: string;
    log: string;
  }> | null;
  /** The module's checkout now (the build verb only). */
  head?: Readonly<{
    commit: string;
    branch: string | null;
    dirty: boolean;
  }>;
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
  /** The lifecycle's own result: `started`, `already-managed`, `prepared`,
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
  /** A start: the optional runtime secrets the app started without, and
   * why (decision F46, root decision 0196); a note, not a refusal. */
  secretsNotProvided?: readonly RuntimeSecretFinding[];
  /** A static app (decision F58): what it serves and its builds. */
  build?: ModuleBuild;
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
  /** `start` of a static app: its development script instead of its build
   * (decision F58), explicitly; it runs so until it is stopped. */
  dev?: boolean | undefined;
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

/** How long the Launchpad's module routes wait for a start or a preparation
 * before they answer that it is still running: below the routes' 660-second
 * idle timeout, so the answer always arrives (decision F34). The bound covers
 * everything after the module is named: the module's resolution (the catalog
 * and the runner), the toolchain check, the queue behind other operations of
 * the Organization, the coordination lock, the preflight, the preparation's
 * own 600-second run and the status read of a pending answer. */
export const moduleAnswerWithinMsDefault = 630_000;

/** The end of the answer deadline kept for the status read of a pending
 * answer: half the deadline, at most this (decision F34 point 2). */
const pendingObservationMs = 5_000;

/** A caller that must answer within a deadline (the Launchpad's routes). The
 * operation goes on after a `start-pending` or `prepare-pending` answer. */
export type AnswerOptions = Readonly<{ answerWithinMs?: number | undefined }>;

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
  /** The default app's preparation cannot run (decision F25): its running
   * app is still read, logged and stopped, and `ensure` refuses only where
   * it would start. */
  preparationFault?: Readonly<{
    reason: string;
    file?: string;
    secrets?: readonly RuntimeSecretFinding[];
  }>;
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

// The browser origin of a module's app on this Folder's Machine: the one
// source of both `runtime.url` and the origin a started app is told (decision
// F26). Hosted: the recorded entry's module origin, which the gateway serves
// for the module's default app only (B4, B5); nothing is composed from a
// convention. `local` on a workstation; otherwise why there is none.
async function applicationOrigin(
  folder: string,
  module: string,
  isDefaultApp: boolean,
): Promise<
  Readonly<
    | { kind: "local" }
    | { kind: "origin"; origin: string }
    | { kind: "none"; reason: string }
  >
> {
  const place = await folderPlace(folder);
  if (place.kind === "local") return { kind: "local" };
  if (place.kind === "unknown")
    return { kind: "none", reason: "folder-state-unreadable" };
  if (place.template === null)
    return { kind: "none", reason: "hosted-entry-missing" };
  if (!isDefaultApp) return { kind: "none", reason: "hosted-app-not-default" };
  try {
    return { kind: "origin", origin: moduleOrigin(place.template, module) };
  } catch (error) {
    return {
      kind: "none",
      reason: error instanceof ModuleOriginError ? error.code : "module-origin",
    };
  }
}

/** A started app is told its origin; a Folder whose state cannot be read is
 * not taken for a workstation (#83), so nothing starts. */
async function launchOrigin(folder: string, module: string) {
  const origin = await applicationOrigin(folder, module, true);
  if (origin.kind === "none" && origin.reason === "folder-state-unreadable")
    throw new Error("Folder state unreadable");
  return origin.kind === "origin" ? origin.origin : null;
}

// The value of `work` if it settles within `ms`, otherwise undefined; `work`
// goes on either way.
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
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
  /** Whose Personalspace this Environment holds (#186): the content core's
   * decision through this Environment's gh. Without one, no Personalspace
   * module runs (`personalspace-unverified`). */
  personalspace?: PersonalspaceHolderRead;
}) {
  const { folder, owner, host } = input;
  const holder = input.personalspace ?? unverifiedPersonalspace;
  // The catalog with its Personalspace group decided where the group can be
  // selected (its name, or for `ensure` an id the Personalspace alone may
  // have), and left unread otherwise: an Organization's module never waits
  // for GitHub's answer whose Personalspace this is.
  const readCatalog = (folder: string, personalspace: boolean) =>
    input.readCatalog !== undefined
      ? input.readCatalog(folder)
      : readFolderCatalog(
          folder,
          personalspace ? holder : unverifiedPersonalspace,
        );
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
    // A required slot that is not there (root decision 0176 point 4), by
    // its Organization-relative slot.
    if (error instanceof RequiredSlotRefused)
      return blocked(operation, error.reason, { ...where, file: error.slot });
    // A declared runtime secret without a value (decision F46), by its
    // names and reasons only.
    if (error instanceof RuntimeSecretUnavailable)
      return blocked(operation, "runtime-secret-unavailable", {
        ...where,
        secrets: error.secrets,
      });
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
      catalog = await readCatalog(
        folder,
        organizationName.toLowerCase() === personalspaceName,
      );
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
  // (`module-ambiguous`). The Personalspace counts as the gateway sees it,
  // whoever holds it: when its one owner directory has a module of that id
  // (`personalspaceMayOwn`, #186). So the Organizations are resolved without
  // GitHub, and whose the Personalspace is is asked only when it alone may
  // own the id, until the request's `deadline`.
  async function resolveId(
    id: string,
    deadline: number,
  ): Promise<Target | ModuleBlocked> {
    if (!isModuleId(id)) return blocked("ensure", "module-unknown");
    const lists = (group: CatalogOrganization | undefined) =>
      group?.modules.some((entry) => entry.module === id) === true;
    let catalog: Catalog;
    let personal: boolean;
    try {
      catalog = await readCatalog(folder, false);
      personal =
        lists(catalog.personalspace) || (await personalspaceMayOwn(folder, id));
    } catch {
      return blocked("ensure", "folder-unreadable");
    }
    const owners = catalog.organizations.filter(lists);
    if (owners.length + (personal ? 1 : 0) > 1)
      return blocked("ensure", "module-ambiguous", {
        module: id,
        candidates: Object.freeze([
          ...owners.map((entry) => entry.directory),
          ...(personal ? [personalspaceName] : []),
        ]),
      });
    // The module's default app only: ensure takes no `--app`.
    const [only] = owners;
    if (only !== undefined) return targetOf("ensure", only, false, id, {});
    if (!personal) return blocked("ensure", "module-unknown", { module: id });
    let decided: Catalog | undefined;
    try {
      decided = await within(readCatalog(folder, true), deadline - Date.now());
    } catch {
      return blocked("ensure", "folder-unreadable");
    }
    // Not decided within the request: the gateway's starting page asks
    // again, and the decision goes on (`ensureStatus`: 503).
    if (decided === undefined)
      return blocked("ensure", "personalspace-unverified", { module: id });
    const group = decided.personalspace;
    if (group === undefined || !lists(group))
      return blocked("ensure", "module-unknown", { module: id });
    return targetOf("ensure", group, true, id, {});
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
    // Refused by its default app's preparation only (decision F25): reading,
    // logging and stopping never depend on the preparation; a start does.
    const preparationFault =
      !module.executable &&
      module.preparationRefused === true &&
      !namedApp &&
      module.reason !== undefined
        ? Object.freeze({
            reason: module.reason,
            ...(module.file === undefined ? {} : { file: module.file }),
            ...(module.secrets === undefined
              ? {}
              : { secrets: module.secrets }),
          })
        : undefined;
    const needsPreparation = operation === "start" || operation === "prepare";
    if (
      !module.executable &&
      !(namedApp && defaultAppFault) &&
      !(preparationFault !== undefined && !needsPreparation)
    )
      return blocked(operation, module.reason ?? "not-executable", {
        ...where,
        ...(module.file === undefined ? {} : { file: module.file }),
        ...(module.secrets === undefined ? {} : { secrets: module.secrets }),
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
      ...(preparationFault === undefined ? {} : { preparationFault }),
    };
    if (personalspace) {
      // The holder again, by the same decision as the catalog (#186), and
      // the company its module declares: selected by, never shown.
      const unavailable = () =>
        blocked(operation, "personalspace-unavailable", where);
      const decided = await holder(folder).catch(() => null);
      if (decided?.kind === "blocked")
        return blocked(operation, decided.reason, where);
      if (decided?.kind !== "held") return unavailable();
      try {
        const directory = await canonicalCheckoutDirectory(decided.directory);
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

  // A module's own data mounts, as this Folder's Environment reads GitHub:
  // anonymously on a public Environment (decision F55's addendum of
  // 2026-10-17), otherwise through its gh.
  function provideModuleData(
    dataMounts: DataMountHost,
    organizationDirectory: string,
    moduleDirectory: string,
  ) {
    return provideDataMounts({
      folder,
      organizationDirectory,
      moduleDirectory,
      host: dataMounts,
      anonymous: async () => {
        const recorded = await readFolderKind(folder);
        const scope = contentScope(recorded.preset, recorded.machine);
        return scope.allowed && scope.github === "anonymous";
      },
    });
  }

  // The closed environment every process of a module starts from: the
  // operator's HOME, the started apps' PATH and TMPDIR (decision F26).
  function operatorEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {
      HOME: host.home as string,
      PATH: host.path,
    };
    if (host.tmpdir) environment.TMPDIR = host.tmpdir;
    return environment;
  }

  function lifecycleFor(kind: RunnerKind, target: Target) {
    const { organizationDirectory } = target;
    const runner = host.createRunner(kind, organizationDirectory);
    const environment = operatorEnvironment();
    const cacheRoot = host.builds?.cacheRoot;
    return createApplicationLifecycle(
      localApplicationAdapters({
        organizationDirectory,
        bunExecutable:
          host.bunExecutable ?? join(host.home as string, ".local/bin/bun"),
        platformExecutable: host.platformExecutable,
        environment,
        runner,
        ...(target.personalspace
          ? {
              resolveApplication: (space: string, selection: unknown) =>
                resolvePersonalspaceApplication(space, selection, holder),
              personalspace: true,
            }
          : { organizationRoot: organizationDirectory }),
        externalOrigin: (module) => launchOrigin(folder, module),
        secretSource: host.runtimeSecrets?.(folder),
        ...(cacheRoot === undefined
          ? {}
          : { staticServer: () => staticServerFiles(cacheRoot) }),
        ...(target.personalspace || host.dataMounts === undefined
          ? {}
          : {
              provideData: (moduleDirectory: string) =>
                provideModuleData(
                  host.dataMounts as DataMountHost,
                  organizationDirectory,
                  moduleDirectory,
                ),
            }),
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

  // Static apps (decision F58, root decision 0195 point 19): an app that
  // declares `build_output` starts from `main` as its build of the
  // checkout's commit, kept outside the checkout and served by the
  // Platform's static server. Nothing is built where this host keeps no
  // builds: such an app runs its development script, as before.
  const builder =
    host.builds === undefined || host.home === undefined
      ? undefined
      : createBuilds({
          lockFile: host.builds.lockFile,
          runner: () => host.runnerKind(),
          runtimeDirectory: host.runtimeDirectory,
          executable: host.bunExecutable ?? join(host.home, ".local/bin/bun"),
          servable: async (root, path, fallback) =>
            staticServerServes({
              executable:
                host.bunExecutable ??
                join(host.home as string, ".local/bin/bun"),
              files: await staticServerFiles(
                (host.builds as NonNullable<ModuleHost["builds"]>).cacheRoot,
              ),
              root,
              path,
              fallback,
            }),
          runBuild: host.builds.runBuild,
        });

  /** The target's app when it is a static app this host builds. */
  async function staticPlan(target: Target): Promise<Plan | null> {
    return readStaticPlan(target).catch(() => null);
  }
  // The same, but a declaration that cannot be read now throws, where null
  // means "not a static app" (the sweep's move tells them apart).
  async function readStaticPlan(target: Target): Promise<Plan | null> {
    if (builder === undefined) return null;
    const plan = await readModuleApplication(
      target.moduleDirectory,
      target.app,
    );
    return plan.kind === "declared-runtime-plan" && plan.runtime.static !== null
      ? plan
      : null;
  }

  const storeOf = (target: Target, plan: Plan) =>
    openBuildStore(
      appBuildDirectory(
        (host.builds as NonNullable<ModuleHost["builds"]>).cacheRoot,
        {
          organization: target.organization,
          module: target.module,
          runtimeId: plan.runtime.id,
          app: target.app,
          applicationDirectory: dirname(
            join(target.moduleDirectory, target.app),
          ),
        },
      ),
    );

  // The other checkouts a build reads, by their Organization-relative path:
  // the module's own data mounts and the slots its app requires. Null when
  // the Organization manifest cannot be read.
  async function buildInputs(
    target: Target,
    plan: Plan,
  ): Promise<BuildInput[] | null> {
    if (target.personalspace) return [];
    const read = (host.builds as NonNullable<ModuleHost["builds"]>)
      .readCheckout;
    const paths = new Set<string>();
    try {
      for (const mount of await moduleDataMounts(
        target.organizationDirectory,
        target.moduleDirectory,
      ))
        if (mount !== null) paths.add(mount.path);
    } catch {
      return null;
    }
    const slots = plan.runtime.optional.required_module_slots;
    if (Array.isArray(slots)) for (const slot of slots) paths.add(slot);
    const inputs: BuildInput[] = [];
    for (const path of [...paths].sort()) {
      const head = await read(join(target.organizationDirectory, path), {
        status: false,
      });
      inputs.push(Object.freeze({ path, commit: head?.commit ?? null }));
    }
    return inputs;
  }

  // What one build of the target's app reads, now.
  async function buildContext(target: Target) {
    const plan = await staticPlan(target);
    if (plan === null || plan.runtime.static === null)
      return Object.freeze({ refused: "not-static" });
    const head = await (
      host.builds as NonNullable<ModuleHost["builds"]>
    ).readCheckout(target.moduleDirectory);
    if (head === null) return Object.freeze({ refused: "checkout-unreadable" });
    const inputs = await buildInputs(target, plan);
    if (inputs === null)
      return Object.freeze({ refused: "organization-manifest-unreadable" });
    const cwd = dirname(join(target.moduleDirectory, target.app));
    const entrypoint = plan.listeners.find(
      (listener) => listener.role === "entrypoint",
    );
    return Object.freeze({
      head,
      inputs: Object.freeze(inputs),
      key: buildKeyOf(head.commit, inputs),
      cwd,
      script: plan.runtime.static.build_script,
      output: plan.runtime.static.output,
      fallback: plan.runtime.static.fallback,
      health: entrypoint?.health.kind === "http" ? entrypoint.health.path : "/",
      env: buildEnvironment({
        base: operatorEnvironment(),
        plan,
        cwd,
        organizationRoot: target.personalspace
          ? undefined
          : target.organizationDirectory,
      }),
    });
  }

  function jobOf(prepared: Prepared, plan: Plan, explicit = false): BuildJob {
    const { target, runner: kind, selection } = prepared;
    return Object.freeze({
      directory: storeOf(target, plan).directory,
      names: Object.freeze({
        organization: target.organization,
        module: target.module,
        app: target.app,
      }),
      read: () => buildContext(target),
      // The app's start-time step, as its start would run it.
      prepare: async () => {
        const prepared = await operate("start", kind, target, (lifecycle) =>
          lifecycle.prepareBuild(selection),
        );
        if (prepared.kind === "build-prepared") return null;
        return "reason" in prepared && typeof prepared.reason === "string"
          ? prepared.reason
          : prepared.kind;
      },
      explicit,
    });
  }

  // `~/…` for a path in the account's home: answers never carry the
  // account's absolute paths.
  const shownPath = (path: string) =>
    host.home !== undefined && path.startsWith(`${host.home}/`)
      ? `~${path.slice(host.home.length)}`
      : path;

  // The app's builds as an answer shows them.
  async function buildInfo(
    target: Target,
    plan: Plan,
    running: boolean,
  ): Promise<ModuleBuild> {
    const store = storeOf(target, plan);
    const [state, served, queued] = await Promise.all([
      store.state(),
      store.served(),
      store.queued(),
    ]);
    const failure = state?.failure ?? null;
    return Object.freeze({
      mode: running ? (served?.mode ?? "dev") : null,
      served:
        running &&
        served?.mode === "built" &&
        served.key !== null &&
        served.commit !== null
          ? Object.freeze({ key: served.key, commit: served.commit })
          : null,
      current:
        state?.current == null
          ? null
          : Object.freeze({
              key: state.current.key,
              commit: state.current.commit,
              at: state.current.at,
              dirty: state.current.dirty,
            }),
      building:
        state?.building != null && buildUnderWay(state)
          ? Object.freeze({
              commit: state.building.commit,
              at: state.building.at,
              queued: false,
            })
          : queued !== null && processAlive(queued.pid)
            ? Object.freeze({ commit: null, at: queued.at, queued: true })
            : null,
      failure:
        failure === null
          ? null
          : Object.freeze({
              commit: failure.commit,
              at: failure.at,
              reason: failure.reason,
              log: shownPath(store.logFile(failure.key)),
            }),
    });
  }

  // A build that did not give an output to serve, as a refusal with the
  // app's builds: the build's own reason (`build-script-failed`, …, or the
  // reason of its start-time step).
  async function buildRefusal(
    operation: ModuleOperation,
    target: Target,
    plan: Plan,
    outcome: Exclude<BuildOutcome, { kind: "built" }>,
  ): Promise<ModuleBlocked> {
    return blocked(
      operation,
      outcome.kind === "failed"
        ? outcome.reason
        : outcome.kind === "busy"
          ? "build-busy"
          : "closing",
      {
        organization: target.organization,
        module: target.module,
        app: target.app,
        build: await buildInfo(target, plan, false),
      },
    );
  }

  // What a built start or a swap serves (decision F58): the newest build,
  // and the build served before it, whose assets the pages opened before
  // still ask for.
  async function servedRecord(
    store: ReturnType<typeof storeOf>,
    record: BuildRecord,
  ) {
    const [state, served] = await Promise.all([store.state(), store.served()]);
    const earlier =
      served?.mode === "built" &&
      served.key !== null &&
      served.key !== record.key
        ? served.key
        : state?.previous?.key !== record.key
          ? (state?.previous?.key ?? null)
          : null;
    const previous =
      earlier !== null && (await store.output(earlier)) !== null
        ? earlier
        : null;
    return Object.freeze({
      mode: "built" as const,
      key: record.key,
      commit: record.commit,
      previous,
    });
  }

  // Swap a running built app onto a newer build (decision F58): the record
  // of what it serves is replaced, and its static server serves the new
  // build from its next request, with no restart and no refused connection.
  // A restart only where the process itself must change: an app that runs
  // its development script from before builds existed (moved onto its
  // build), a static server whose serving declaration changed (its
  // address, health path or fallback), or one whose record has no
  // `previous` (written by a release whose server does not read it). Never
  // an app started explicitly as its development version.
  async function swap(
    prepared: Prepared,
    plan: Plan,
    built: Extract<BuildOutcome, { kind: "built" }>,
  ) {
    const { target, runner: kind, selection } = prepared;
    const store = storeOf(target, plan);
    await operate("start", kind, target, async (lifecycle) => {
      const status = await lifecycle.status(selection);
      if (status.kind !== "status" || status.state !== "running") return;
      const served = await store.served();
      if (served?.mode === "dev") return;
      if (
        served?.mode === "built" &&
        served.previous !== undefined &&
        !("declarationChanged" in status)
      ) {
        if (served.key !== built.record.key)
          await store.writeServed(await servedRecord(store, built.record));
        return;
      }
      const record = await servedRecord(store, built.record);
      if ((await lifecycle.stop(selection)).kind !== "group-stopped") return;
      await store.writeServed(record);
      await lifecycle.start(selection, { served: store.servedFile });
    });
  }

  // Build the checkout in the background and swap the running app onto it
  // when it is built: after a start that served an older build, or found
  // the app running otherwise. Only an owner that outlives the answer (the
  // Launchpad) builds in the background. `explicit`: a person's start, which
  // builds again also a commit whose build failed.
  async function refreshNow(prepared: Prepared, plan: Plan, explicit = false) {
    if (builder === undefined) return;
    const outcome = await builder.enqueue(
      jobOf(prepared, plan, explicit),
      "background",
    );
    if (outcome.kind === "built") await swap(prepared, plan, outcome);
  }
  function refresh(prepared: Prepared, plan: Plan, explicit: boolean) {
    if (owner !== "launchpad") return;
    void refreshNow(prepared, plan, explicit).catch(() => undefined);
  }

  // The apps the Launchpad keeps built after a pull (decision F58 point
  // 7): every app with a build state (someone opened it), and, until one
  // sweep has read them all, also every static app that runs without one (a
  // development run from before builds existed, moved onto its build), with
  // the Git directories their builds read: the module's and those of the
  // data mounts and required slots its build key includes.
  const watched = new Map<
    string,
    Readonly<{ prepared: Prepared; plan: Plan }>
  >();
  // Done only by a sweep that read the catalog and then named, read and
  // inspected every app it lists: anything that fails now (the catalog, an
  // app's resolution, its declaration, its status) is tried again at the
  // next sweep.
  let migrating = true;
  async function gitDirectoriesOf(target: Target, plan: Plan) {
    const read = (host.builds as NonNullable<ModuleHost["builds"]>)
      .readCheckout;
    const directories = new Set<string>();
    const own = await read(target.moduleDirectory, { status: false });
    if (own !== null) directories.add(own.gitDirectory);
    for (const input of (await buildInputs(target, plan)) ?? []) {
      const head = await read(join(target.organizationDirectory, input.path), {
        status: false,
      });
      if (head !== null) directories.add(head.gitDirectory);
    }
    return [...directories].sort();
  }
  async function watchedApps(): Promise<readonly WatchedApp[]> {
    if (host.builds === undefined) return [];
    const names = new Map<string, string | undefined>();
    for (const { state } of await listBuildStates(host.builds.cacheRoot))
      names.set(
        `${state.organization}/${state.module}\0${state.app}`,
        state.app,
      );
    let migrated = migrating;
    if (migrating) {
      try {
        const catalog = await readCatalog(folder, false);
        for (const organization of catalog.organizations)
          for (const module of organization.modules)
            for (const app of module.apps)
              if (
                organization.organization !== null &&
                app.kind === "runtime-declared"
              )
                names.set(
                  `${organization.organization}/${module.module}\0${app.package}`,
                  undefined,
                );
      } catch {
        migrated = false;
      }
    }
    const apps: WatchedApp[] = [];
    watched.clear();
    for (const [key, recorded] of names) {
      const [name, app] = key.split("\0") as [string, string];
      // An app of the move that cannot be named or read now keeps the move
      // pending, so that the next sweep tries it again.
      const prepared = await prepare("build", name, { app });
      if ("kind" in prepared) {
        if (recorded === undefined) migrated = false;
        continue;
      }
      let plan: Plan | null;
      try {
        plan = await readStaticPlan(prepared.target);
      } catch {
        if (recorded === undefined) migrated = false;
        continue;
      }
      if (plan === null) continue;
      const store = storeOf(prepared.target, plan);
      // Without a build state: only an app that runs now.
      if (recorded === undefined && (await store.state()) === null) {
        const running = await operate(
          "status",
          prepared.runner,
          prepared.target,
          (lifecycle) => lifecycle.status(prepared.selection),
        );
        if (running.kind !== "status" && running.kind !== "not-managed")
          migrated = false;
        if (running.kind !== "status" || running.state !== "running") continue;
      }
      watched.set(store.directory, { prepared, plan });
      apps.push({
        id: store.directory,
        gitDirectories: await gitDirectoriesOf(prepared.target, plan),
      });
    }
    if (migrated) migrating = false;
    return apps;
  }
  let keeper: BuildWatcher | undefined;
  // An app that runs built is watched at once, not from the next sweep
  // (#559): the Launchpad's watch of the Git directories its build reads.
  async function keepWatching(prepared: Prepared, plan: Plan) {
    if (keeper === undefined) return;
    const directory = storeOf(prepared.target, plan).directory;
    watched.set(directory, { prepared, plan });
    keeper.add({
      id: directory,
      gitDirectories: await gitDirectoriesOf(prepared.target, plan),
    });
  }

  // A built start: the newest build there is now, built first when there
  // is none (the person waits for it; a long one is answered
  // `build-pending`), and a build of the checkout in the background when it
  // moved past that one. A person's start (`explicit`: the Launchpad's Start
  // and Open, `lazurio module start`) builds again a commit whose build
  // failed; the gateway's `ensure`, which a starting page asks again and
  // again, never does.
  async function startBuilt(
    prepared: Prepared,
    plan: Plan,
    explicit: boolean,
  ): Promise<ModuleAnswer | ModuleBlocked> {
    const { target, runner: kind, selection } = prepared;
    const store = storeOf(target, plan);
    const state = await store.state();
    let record = state?.current ?? null;
    let output = record === null ? null : await store.output(record.key);
    if (record === null || output === null) {
      const outcome = await (builder as NonNullable<typeof builder>).enqueue(
        jobOf(prepared, plan, explicit),
        "foreground",
      );
      if (outcome.kind !== "built")
        return buildRefusal("start", target, plan, outcome);
      record = outcome.record;
      output = outcome.output;
    }
    const newest = record;
    return operate("start", kind, target, async (lifecycle) => {
      // The record its static server reads at its start, written only when
      // nothing runs: a running app is answered as it runs (a swap moves a
      // running one).
      const status = await lifecycle.status(selection);
      if (
        status.kind === "not-managed" ||
        (status.kind === "status" && status.state === "ended")
      )
        await store.writeServed(await servedRecord(store, newest));
      const started = await lifecycle.start(selection, {
        served: store.servedFile,
      });
      if (started.kind !== "started" && started.kind !== "already-managed")
        return blocked("start", started.kind, {
          organization: target.organization,
          module: target.module,
          app: target.app,
        });
      // Watched from now on, not from the next sweep (#559).
      await keepWatching(prepared, plan);
      const answer = await observe(
        "start",
        started.kind,
        kind,
        target,
        selection,
        lifecycle,
      );
      refresh(prepared, plan, explicit);
      return answer;
    });
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
    // A build needs no runner: the CLI builds also beside a session's apps
    // (the Launchpad swaps them at its next sweep, decision F58).
    if (kind === "session" && owner === "cli" && operation !== "build")
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
    // Hosted: never the loopback address.
    const origin = await applicationOrigin(
      folder,
      target.module,
      target.isDefaultApp,
    );
    if (origin.kind === "local") return { runtime: { url: observed.url } };
    if (origin.kind === "none")
      return { runtime: null, runtimeReason: origin.reason };
    return { runtime: { url: `${origin.origin}/` } };
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
    // A static app's builds (decision F58); a start still building when the
    // answer was due is `build-pending`.
    const plan = await staticPlan(target);
    const build =
      plan === null
        ? undefined
        : await buildInfo(
            target,
            plan,
            status.kind === "status" && status.state !== "ended",
          );
    const pending =
      outcome === "start-pending" && build?.building != null
        ? "build-pending"
        : outcome;
    const base = {
      kind: "module" as const,
      operation,
      ...where,
      runner: kind,
      survivesLaunchpadRestart: kind === "systemd-user",
      ...(build === undefined ? {} : { build }),
    };
    if (status.kind === "not-managed")
      return Object.freeze({
        ...base,
        outcome: pending ?? status.kind,
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
      outcome: pending ?? status.kind,
      state: status.state,
      healthy,
      service,
      ...(healthy
        ? await link(lifecycle, target, selection)
        : { runtime: null }),
    });
  }

  // The toolchain from the standard path, checked before any effect.
  async function toolchainMissing(
    operation: "start" | "prepare" | "build",
    target: Target,
  ): Promise<ModuleBlocked | null> {
    const bun =
      host.bunExecutable ?? join(host.home as string, ".local/bin/bun");
    const present = await stat(bun)
      .then(async (entry) => {
        if (!entry.isFile()) return false;
        await access(bun, constants.X_OK);
        return true;
      })
      .catch(() => false);
    return present
      ? null
      : blocked(operation, "toolchain-missing", {
          organization: target.organization,
          module: target.module,
          app: target.app,
          tool: "bun",
          expected: host.bunExecutable === undefined ? standardBun : bun,
        });
  }

  // Start the prepared app unless it runs: the toolchain, then the
  // lifecycle's start, whose start-time step installs from the lockfile, runs
  // the declared check and prepares when it fails (decision F34).
  async function startOwned(
    prepared: Prepared,
    options: Readonly<{
      dev?: boolean | undefined;
      /** A person's start (not the gateway's `ensure`, decision F58). */
      explicit?: boolean | undefined;
    }> = {},
  ): Promise<ModuleAnswer | ModuleBlocked> {
    const { target, runner: kind, selection } = prepared;
    const missing = await toolchainMissing("start", target);
    if (missing !== null) return missing;
    // Whether the app is told a hosted origin must be known before any
    // effect: an unreadable Folder state is not a workstation (decision F26).
    if ((await folderPlace(folder)).kind === "unknown")
      return blocked("start", "folder-state-unreadable", {
        organization: target.organization,
        module: target.module,
        app: target.app,
      });
    // A static app starts as its build, unless its development version is
    // asked for explicitly (decision F58).
    const plan = await staticPlan(target);
    if (plan !== null && options.dev !== true)
      return startBuilt(prepared, plan, options.explicit === true);
    return operate("start", kind, target, async (lifecycle) => {
      // The development version replaces a built run explicitly.
      if (plan !== null) {
        const store = storeOf(target, plan);
        const status = await lifecycle.status(selection);
        if (
          status.kind === "status" &&
          (await store.served())?.mode === "built"
        ) {
          const stopped = await lifecycle.stop(selection);
          if (stopped.kind !== "group-stopped")
            return blocked("start", stopped.kind, {
              organization: target.organization,
              module: target.module,
              app: target.app,
            });
        }
      }
      const started = await lifecycle.start(selection);
      if (plan !== null && started.kind === "started")
        await storeOf(target, plan).writeServed({
          mode: "dev",
          key: null,
          commit: null,
          previous: null,
        });
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
      const answer = await observe(
        "start",
        started.kind,
        kind,
        target,
        selection,
        lifecycle,
      );
      // The optional secrets it started without (decision F46).
      return answer.kind === "module" &&
        "secretsNotProvided" in started &&
        Array.isArray(started.secretsNotProvided)
        ? Object.freeze({
            ...answer,
            secretsNotProvided: started.secretsNotProvided,
          })
        : answer;
    });
  }

  // Prepare the app explicitly (decision F34): the lifecycle's preparation,
  // whatever the declared check says now. A frozen install from the lockfile
  // beside the package, the declared prepare_script and the check again; for
  // an app without a declaration the frozen install (F25). It never starts
  // anything, and never prepares beneath a running app: a service-owned one
  // is `application-running`, another app of the Organization
  // `other-app-managed`, and a session app is stopped for it, as before.
  async function prepareOwned({
    target,
    runner: kind,
    selection,
  }: Prepared): Promise<ModuleAnswer | ModuleBlocked> {
    const missing = await toolchainMissing("prepare", target);
    if (missing !== null) return missing;
    return operate("prepare", kind, target, async (lifecycle) => {
      const prepared = await lifecycle.prepare(selection);
      if (prepared.kind !== "prepared")
        return blocked(
          "prepare",
          // A known reason is kept (a step that failed, a refused preflight);
          // a failure without one is the declared check that still fails, as
          // at the start.
          "reason" in prepared && typeof prepared.reason === "string"
            ? prepared.reason
            : prepared.kind === "preparation-failed"
              ? "prerequisites-not-ready"
              : prepared.kind,
          {
            organization: target.organization,
            module: target.module,
            app: target.app,
            ...("file" in prepared && typeof prepared.file === "string"
              ? { file: prepared.file }
              : {}),
          },
        );
      return observe(
        "prepare",
        prepared.kind,
        kind,
        target,
        selection,
        lifecycle,
      );
    });
  }

  // A start or preparation answered within a deadline (decision F34): the
  // deadline counts from the moment the module is named and bounds its
  // resolution, the operation and the status read of the answer. When the
  // operation has not finished by the deadline less the status read's share,
  // the answer is the owner's view of the app read within the rest, with the
  // outcome `start-pending` or `prepare-pending`; the operation goes on in
  // this owner, and its result is the app's later status. A status read that
  // does not finish in time leaves the pending answer without an observation:
  // not healthy, no service, no link, and the state the operation under way
  // gives (`starting` for a start; a preparation never starts the app). A
  // module not resolved by then is never operated on: `operation-failed`,
  // nothing changed. Without a deadline (the CLI) the operation's own result.
  async function answerWithin(
    operation: "start" | "prepare" | "build",
    name: string,
    options: ModuleOptions,
    run: (prepared: Prepared) => Promise<ModuleAnswer | ModuleBlocked>,
    { answerWithinMs }: AnswerOptions,
  ): Promise<ModuleAnswer | ModuleBlocked> {
    if (answerWithinMs === undefined) {
      const prepared = await prepare(operation, name, options);
      return "kind" in prepared ? prepared : run(prepared);
    }
    const deadline = performance.now() + answerWithinMs;
    let resolved: Prepared | undefined;
    let late = false;
    const running = prepare(operation, name, options).then((prepared) => {
      if ("kind" in prepared) return prepared;
      if (late) return blocked(operation, "operation-failed");
      resolved = prepared;
      return run(prepared).catch((error: unknown) =>
        moduleFailure(operation, prepared.target, error),
      );
    });
    const result = await within(
      running,
      deadline -
        Math.min(answerWithinMs / 2, pendingObservationMs) -
        performance.now(),
    );
    if (result !== undefined) return result;
    if (resolved === undefined) {
      late = true;
      return blocked(operation, "operation-failed");
    }
    const { target, runner: kind, selection } = resolved;
    const outcome = `${operation}-pending`;
    const observed = await within(
      operate("status", kind, target, (lifecycle) =>
        observe(
          operation,
          outcome,
          kind,
          target,
          selection,
          lifecycle,
          "status",
        ),
      ),
      deadline - performance.now(),
    );
    return (
      observed ??
      Object.freeze({
        kind: "module" as const,
        operation,
        organization: target.organization,
        module: target.module,
        app: target.app,
        runner: kind,
        survivesLaunchpadRestart: kind === "systemd-user",
        outcome,
        state: operation === "start" ? "starting" : "stopped",
        healthy: false,
        service: null,
        runtime: null,
      })
    );
  }

  // Build a static app's checkout now (decision F58), also a commit whose
  // last build failed or, when the checkout has uncommitted changes, one
  // built already; then swap a running built app onto it.
  async function buildOwned(
    prepared: Prepared,
  ): Promise<ModuleAnswer | ModuleBlocked> {
    const { target, runner: kind, selection } = prepared;
    const where = {
      organization: target.organization,
      module: target.module,
      app: target.app,
    };
    if (builder === undefined)
      return blocked("build", "builds-unavailable", where);
    const plan = await staticPlan(target);
    if (plan === null) return blocked("build", "not-static", where);
    const missing = await toolchainMissing("build", target);
    if (missing !== null) return missing;
    const outcome = await builder.enqueue(
      jobOf(prepared, plan, true),
      "foreground",
    );
    if (outcome.kind !== "built")
      return buildRefusal("build", target, plan, outcome);
    // The CLI operates only apps the service manager owns; a session's
    // apps are the Launchpad's, which swaps them at its next sweep.
    if (owner === "launchpad" || kind === "systemd-user")
      await swap(prepared, plan, outcome);
    const head = await (
      host.builds as NonNullable<ModuleHost["builds"]>
    ).readCheckout(target.moduleDirectory);
    const answer = await operate("status", kind, target, (lifecycle) =>
      observe(
        "build",
        outcome.already ? "current" : "built",
        kind,
        target,
        selection,
        lifecycle,
        "status",
      ),
    );
    return answer.kind === "module" &&
      answer.build !== undefined &&
      head !== null
      ? Object.freeze({
          ...answer,
          build: Object.freeze({
            ...answer.build,
            head: Object.freeze({
              commit: head.commit,
              branch: head.branch,
              dirty: head.dirty,
            }),
          }),
        })
      : answer;
  }

  // Seams of later slices, deliberately not built here:
  // - B3 `open` (start, wait for health, the link) composes the start and
  //   the same `observe`; until then `ensure` starts, and a start installs
  //   and prepares when the check fails (decisions F25, F34).
  // - P9 `--source worktree:<name>` selects another checkout; until then every
  //   verb runs the module's own checkout.
  return Object.freeze({
    /** Start the module's app (its default, or `app`) unless it runs. */
    async start(
      name: string,
      options: ModuleOptions = {},
      answer: AnswerOptions = {},
    ): Promise<ModuleAnswer | ModuleBlocked> {
      return answerWithin(
        "start",
        name,
        options,
        (prepared) =>
          startOwned(prepared, { dev: options.dev, explicit: true }),
        answer,
      );
    },
    /** Prepare the module's app (its default, or `app`) explicitly, without
     * starting it (decision F34). */
    async prepare(
      name: string,
      options: ModuleOptions = {},
      answer: AnswerOptions = {},
    ): Promise<ModuleAnswer | ModuleBlocked> {
      return answerWithin("prepare", name, options, prepareOwned, answer);
    },
    /** Build a static app's checkout now and swap a running built app onto
     * it (decision F58); `not-static` for an app without `build_output`. */
    async build(
      name: string,
      options: ModuleOptions = {},
      answer: AnswerOptions = {},
    ): Promise<ModuleAnswer | ModuleBlocked> {
      return answerWithin("build", name, options, buildOwned, answer);
    },
    /** What a running app of the catalog was started as (decision F58):
     * a static app's build and its commit, or its development script; for
     * the overview of running Modules. Null when it cannot be named. */
    async served(
      name: string,
      app: string,
    ): Promise<Readonly<{
      mode: "built" | "dev";
      commit: string | null;
    }> | null> {
      const prepared = await prepare("status", name, { app });
      if ("kind" in prepared) return null;
      const plan = await staticPlan(prepared.target);
      if (plan === null) return Object.freeze({ mode: "dev", commit: null });
      const served = await storeOf(prepared.target, plan).served();
      return served?.mode === "built"
        ? Object.freeze({ mode: "built", commit: served.commit })
        : Object.freeze({ mode: "dev", commit: null });
    },
    /** Keep the static apps people opened built after a pull (decision F58
     * point 7): the Launchpad watches the Git directories their builds read
     * and sweeps at its start and every few minutes, building a moved
     * checkout in the background and swapping what runs. The Launchpad's
     * own process, no daemon (F8); nothing where this host keeps no builds. */
    keepBuilt(
      options: Readonly<{
        watch?: DirectoryWatch;
        quietMs?: number;
        sweepMs?: number;
      }> = {},
    ) {
      if (
        builder === undefined ||
        owner !== "launchpad" ||
        keeper !== undefined ||
        closing
      )
        return keeper;
      keeper = createBuildWatcher({
        apps: watchedApps,
        refresh: async (app) => {
          const entry = watched.get(app.id);
          if (entry !== undefined) await refreshNow(entry.prepared, entry.plan);
        },
        ...options,
      });
      keeper.start();
      return keeper;
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
      const target = await resolveId(id, deadline);
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
      // A default app whose preparation cannot run is not started; one that
      // already runs is reported as it is (decision F25).
      const fault = target.preparationFault;
      if (fault !== undefined)
        return current.state === "stopped" || current.state === "ended"
          ? blocked("ensure", fault.reason, {
              organization: target.organization,
              module: target.module,
              ...(fault.file === undefined ? {} : { file: fault.file }),
              ...(fault.secrets === undefined
                ? {}
                : { secrets: fault.secrets }),
            })
          : current;
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
      // A build under way ends with its owner; its output is not installed.
      const watching = keeper?.close();
      await builder?.close();
      await watching;
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
type Plan = Extract<
  Awaited<ReturnType<typeof readModuleApplication>>,
  { kind: "declared-runtime-plan" }
>;
type Prepared = Readonly<{
  target: Target;
  runner: RunnerKind;
  selection: Selection;
}>;

export type ModuleOperations = ReturnType<typeof createModuleOperations>;
