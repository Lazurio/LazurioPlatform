import {
  browserUnits,
  environmentBrowserReasons,
  observeEnvironmentBrowser,
} from "../browser/units";
import { agentRegistrations } from "../executor/agents";
import {
  type ExecutorHost,
  type ExecutorService,
  executorStatus,
} from "../executor/flow";
import { processExecutorHost } from "../executor/host";
import { machineIdentity } from "../folder/machine-binding";
import { presetNames } from "../folder/presets";
import {
  hostedEnvironment,
  isOlderTemplateRevision,
  isTemplateRevision,
  toolEnvironmentOf,
} from "../folder/render";
import { enabledTools } from "../folder/state";
import { machineBinding } from "../machine/binding";
import { preparationReasons } from "../modules/preparation-refusal";
import {
  type RuntimeSecretFinding,
  runtimeSecretReasons,
} from "../modules/runtime-secrets";
import {
  type Catalog,
  type ModuleReason,
  type OrganizationReason,
  readFolderCatalog,
} from "../organizations/catalog";
import { organizationRootStates } from "../organizations/root-resolution";
import { checkoutReasons } from "../providers/checkout-custody";
import {
  type RecoveryCheck,
  type RecoveryCheckId,
  recoveryCodes,
  skipReasons,
} from "../recover/checks";
import { contextRules, isReleaseVersion } from "../recover/evidence";
import {
  askHealth,
  type HealthAnswer,
  observeFolder,
} from "../recover/observe";
import { collectRecovery, type RecoveryEnvironment } from "../recover/recover";
import {
  type ActivatableTool,
  activatableTools,
  executorToolName,
  type ToolTier,
  toolCatalog,
  toolOffered,
} from "../tools/catalog";
import { type ToolsEnvironment, toolsOverview } from "../tools/overview";
import { type ToolSignIn, toolsSignIn, toolsStatus } from "../tools/status";
import {
  codexAppServerReasons,
  isCodexVersion,
  observeCodexAppServer,
} from "../update/codex-app-server";
import type { ErrorContext } from "../update/errors";
import { detectServiceControl } from "../update/service-control";
import { readStatus, type UpdateStatus } from "../update/update";

/** `collectDoctor`: the one use case behind `lazurio doctor` (launchpad-parity
 * B9, P8), the healthy-product readback of an Environment and the pre-switch
 * preflight of C.2 step 4. It adds no check of its own: every answer is one
 * the product already computes (`collectRecovery`, `readStatus`,
 * `observeFolder`, `toolsOverview`/`toolsStatus`, `readFolderCatalog`, the
 * handover binding), mapped to one shape. It reads and never writes: the
 * Folder's tool selection is read under the read lock, nothing is fetched
 * (the sign-in probes only on request), nothing restarts. `lazurio recover`
 * stays the broken-product path with its evidence and issue. The one answer
 * recover does not compute, the operator's Codex app-server daemon of a
 * hosted Machine (`observeCodexAppServer`, decision F29), is never `fail`
 * and never reaches recover or Recovery mode; neither is Executor
 * (`executorStatus`, decision F44), a required tool whose absence or
 * stopped service degrades the direct Integrations and needs attention, but
 * leaves the Environment working. */

// ---- The shape --------------------------------------------------------------

/** Stable ids: a contract for automation, never renamed or reused. A check
 * about one tool, Organization or module names it in its context. */
export const doctorCheckIds = [
  // product
  "update-state",
  "product-version",
  "self-check",
  "update-available",
  "folder-refresh",
  "template-revision",
  // Folder
  "folder-state",
  "machine-binding",
  // tools
  "tool",
  "executor",
  // Organizations and modules
  "catalog",
  "organization",
  "module",
  // Launchpad
  "launchpad-unit",
  "launchpad-health",
  // Machine
  "machine-entry",
  "codex-app-server",
  "environment-browser",
] as const;
export type DoctorCheckId = (typeof doctorCheckIds)[number];

export const doctorGroups = [
  "product",
  "folder",
  "tools",
  "organizations",
  "launchpad",
  "machine",
] as const;
export type DoctorGroup = (typeof doctorGroups)[number];

export const doctorGroupOf: Readonly<Record<DoctorCheckId, DoctorGroup>> =
  Object.freeze({
    "update-state": "product",
    "product-version": "product",
    "self-check": "product",
    "update-available": "product",
    "folder-refresh": "product",
    "template-revision": "product",
    "folder-state": "folder",
    "machine-binding": "folder",
    tool: "tools",
    executor: "tools",
    catalog: "organizations",
    organization: "organizations",
    module: "organizations",
    "launchpad-unit": "launchpad",
    "launchpad-health": "launchpad",
    "machine-entry": "machine",
    "codex-app-server": "machine",
    "environment-browser": "machine",
  });

export type DoctorOutcome = "ok" | "warn" | "fail" | "skipped";

/** The reasons doctor itself names; a mapped check keeps the code or skip
 * reason of the reader it comes from. */
const ownReasons = [
  // product
  "not-installed",
  "running-not-active",
  "update-available",
  "never-checked",
  "update-state-invalid",
  "folder-refresh-needed",
  "not-active",
  "folder-newer",
  "revision-unknown",
  // Folder and Machine
  "not-hosted",
  "binding-absent",
  "handover-unreadable",
  "handover-changed",
  "machine-identity-changed",
  "entry-not-recorded",
  // tools
  "required-missing",
  "recommended-missing",
  "enabled-missing",
  "not-enabled",
  "not-offered",
  "version-unreadable",
  // Organizations
  "catalog-unreadable",
  "template-not-runtime",
  // Executor (decision F44): its state as `lazurio executor status` says it.
  "executor-not-installed",
  "executor-outdated",
  "executor-conflict",
  "executor-not-running",
  "executor-incomplete",
  // Modules: optional runtime secrets a module's app would start without
  // (decision F46); a note on an `ok` module, never a refusal.
  "runtime-secret-not-provided",
] as const;
const catalogReasons: readonly (OrganizationReason | ModuleReason)[] = [
  "canonical-documents-required",
  "organization-conflict",
  "organization-not-executable",
  "template-not-runtime",
  "organization-changed",
  "organization-unavailable",
  "organization-duplicate",
  "declaration-conflict",
  "module-unavailable",
  "explicit-apps-required",
  "no-app",
  "default-app-invalid",
  ...checkoutReasons,
  ...preparationReasons,
  "runtime-secret-unavailable",
];
export const doctorReasons: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...recoveryCodes,
    ...skipReasons,
    ...ownReasons,
    ...catalogReasons,
    ...codexAppServerReasons,
    ...environmentBrowserReasons,
  ]),
]);

export type DoctorCheck = Readonly<{
  id: DoctorCheckId;
  outcome: DoctorOutcome;
  reason?: string;
  context?: ErrorContext;
}>;

export type DoctorVerdict = "ok" | "attention" | "broken";

export type DoctorResult = Readonly<{
  kind: "doctor";
  verdict: DoctorVerdict;
  /** The Folder's language, for the human surface. */
  locale: "cs" | "en";
  checks: readonly DoctorCheck[];
}>;

// ---- Tier 1 -----------------------------------------------------------------

/** A name of the Folder's catalog (an Organization slug or directory, a module
 * id) in the one form doctor prints: an identifier, else `invalid`; `lazurio
 * organization list` shows the name itself. */
const namePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const safeName = (value: string | null | undefined) =>
  value != null && namePattern.test(value) ? value : "invalid";

const oneOf =
  (...lists: readonly (readonly unknown[])[]) =>
  (value: unknown) =>
    lists.some((list) => list.includes(value));
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Doctor's context allowlist: recover's tier 1 (`contextRules`) and the few
 * keys doctor adds, each an enumerated value, a release, a count or a checked
 * identifier. Every other key and every value outside its rule is dropped: no
 * path, no message, no digest. */
export const doctorContextRules: Readonly<
  Record<string, (value: unknown) => boolean>
> = Object.freeze({
  ...contextRules,
  running: isReleaseVersion,
  tool: oneOf(toolCatalog.map((entry) => entry.name)),
  tier: oneOf(["required", "recommended", "optional"]),
  // Numeric segments only: a tool prints its version line itself, and a
  // suffix (`-beta`, `+build`, or any word) is free text; it is omitted.
  toolVersion: (value: unknown) =>
    typeof value === "string" && /^[0-9]{1,6}(\.[0-9]{1,6}){0,3}$/.test(value),
  // The running Codex app-server's version and the CLI's, as Codex reports
  // them (`codex-app-server` `app-server-outdated`, issue #173).
  appServerVersion: isCodexVersion,
  cliVersion: isCodexVersion,
  // Which of the Environment browser's units a finding is about (F38).
  unit: oneOf(browserUnits),
  // Executor's service and the agents' MCP server `executor` (F44).
  executorService: oneOf([
    "running",
    "stopped",
    "failed",
    "missing",
    "other",
    "unknown",
  ] satisfies ExecutorService[]),
  codexMcp: oneOf(agentRegistrations),
  claudeMcp: oneOf(agentRegistrations),
  signIn: oneOf(["signed-in", "signed-out", "unknown"]),
  ssh: oneOf(["linked", "not-linked", "unknown"]),
  organization: (value: unknown) =>
    typeof value === "string" && namePattern.test(value),
  module: (value: unknown) =>
    typeof value === "string" && namePattern.test(value),
  state: oneOf(organizationRootStates),
  preset: oneOf(presetNames),
  machineKind: oneOf(["workstation", "personal-vm", "workspace-vm"]),
  answer: oneOf(["normal", "recovery", "none", "unexpected"]),
  organizations: count,
  modules: count,
  // Declared runtime secrets (decision F46): their names, never a value,
  // and the one reason the catalog knows without the vault.
  secrets: (value: unknown) =>
    typeof value === "string" &&
    value.length <= 512 &&
    /^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$/.test(value),
  secretReason: oneOf(runtimeSecretReasons),
  // A refused file or directory of the operator's checkout (decision F23):
  // relative to its module or Organization (`.` for the directory itself), or
  // `~/…`; never absolute, never `..`.
  file: (value: unknown) =>
    value === "." ||
    (typeof value === "string" &&
      value.length <= 512 &&
      /^(~\/)?[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/.test(value) &&
      !value.split("/").some((segment) => segment === ".." || segment === ".")),
});

const doctorContext = (context: ErrorContext): ErrorContext =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(context).filter(
        ([key, value]) =>
          Object.hasOwn(doctorContextRules, key) &&
          (doctorContextRules[key] as (value: unknown) => boolean)(value),
      ),
    ),
  );

function check(
  id: DoctorCheckId,
  outcome: DoctorOutcome,
  reason?: string,
  context: ErrorContext = {},
): DoctorCheck {
  const kept = doctorContext(context);
  return Object.freeze({
    id,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    ...(Object.keys(kept).length === 0 ? {} : { context: kept }),
  });
}

// ---- Mapping the readers ----------------------------------------------------

/** A check of `collectRecovery` under doctor's id: failed is `fail`. */
function fromRecovery(
  id: DoctorCheckId,
  checks: readonly RecoveryCheck[],
  from: RecoveryCheckId,
  extra: ErrorContext = {},
): DoctorCheck {
  const found = checks.find((entry) => entry.id === from);
  if (found === undefined) return check(id, "skipped", "internal");
  switch (found.outcome) {
    case "ok":
      return check(id, "ok", undefined, { ...found.context, ...extra });
    case "failed":
      return check(id, "fail", found.code, { ...found.context, ...extra });
    case "skipped":
      return check(id, "skipped", found.reason, extra);
  }
}

const answerOf = (answer: HealthAnswer | null) =>
  answer === null
    ? {}
    : {
        answer: {
          version: "normal",
          recovery: "recovery",
          none: "none",
          unexpected: "unexpected",
        }[answer.kind],
      };

function productChecks(
  identity: RecoveryEnvironment["identity"],
  status: UpdateStatus | null,
  folder: Awaited<ReturnType<typeof observeFolder>>,
  hasFolder: boolean,
): readonly [DoctorCheck, DoctorCheck, DoctorCheck, DoctorCheck] {
  const running = identity.version;
  const active = status?.active ?? null;
  const version =
    status === null
      ? check("product-version", "skipped", "internal")
      : active === null
        ? check("product-version", "warn", "not-installed", { running })
        : active === running
          ? check("product-version", "ok", undefined, { version: running })
          : check("product-version", "warn", "running-not-active", {
              running,
              active,
            });
  const available =
    status === null
      ? check("update-available", "skipped", "internal")
      : status.stateInvalid !== null
        ? check("update-available", "skipped", "update-state-invalid")
        : active === null
          ? check("update-available", "skipped", "not-installed")
          : status.lastCheck === null
            ? check("update-available", "skipped", "never-checked")
            : status.updateAvailable
              ? check("update-available", "warn", "update-available", {
                  active,
                  latest: status.lastCheck.latest,
                })
              : check("update-available", "ok", undefined, {
                  latest: status.lastCheck.latest,
                });
  // Only the active executable knows the template revision the refresh
  // would render (readStatus).
  const refresh = !hasFolder
    ? check("folder-refresh", "skipped", "no-folder")
    : status === null
      ? check("folder-refresh", "skipped", "internal")
      : active !== running
        ? check("folder-refresh", "skipped", "not-active")
        : status.folderRefresh !== null
          ? check("folder-refresh", "warn", "folder-refresh-needed", {
              recorded: status.folderRefresh.recorded,
              product: status.folderRefresh.product,
            })
          : check("folder-refresh", "ok");
  // An older Folder is the refresh above; a newer or unknown one is this.
  const facts = folder.facts;
  const revisions =
    facts === null
      ? {}
      : {
          recorded: facts.recordedTemplateRevision,
          product: facts.productTemplateRevision,
        };
  const template =
    facts === null
      ? check(
          "template-revision",
          "skipped",
          hasFolder ? "folder-state-unreadable" : "no-folder",
        )
      : !isTemplateRevision(facts.recordedTemplateRevision)
        ? check("template-revision", "warn", "revision-unknown", revisions)
        : isOlderTemplateRevision(
              facts.productTemplateRevision,
              facts.recordedTemplateRevision,
            )
          ? check("template-revision", "warn", "folder-newer", revisions)
          : check("template-revision", "ok", undefined, revisions);
  return [version, available, refresh, template];
}

type Handover = Awaited<ReturnType<RecoveryEnvironment["machineContext"]>>;

/** The binding the Folder recorded against the one the live handover
 * projects: the identity first (another Machine), then the document digest
 * (a rewritten handover `machine folder-refresh` records). Only the
 * enumerated reason is reported, never a digest. */
function bindingChecks(
  folder: Awaited<ReturnType<typeof observeFolder>>,
  handover: Handover,
  hostedUnreadable: boolean,
): DoctorCheck[] {
  const preferences = folder.preferences;
  if (preferences === null)
    return [
      // No Folder because the hosted context could not be read (#83): said,
      // not skipped as if this were a workstation.
      hostedUnreadable
        ? check("machine-binding", "warn", "handover-unreadable")
        : check("machine-binding", "skipped", "no-folder"),
      check("machine-entry", "skipped", "no-folder"),
    ];
  const recorded = preferences.machine;
  let live: ReturnType<typeof machineBinding> | null = null;
  let unreadable = false;
  if (handover !== null)
    try {
      live = machineBinding(handover.context, handover.digest);
    } catch {
      unreadable = true;
    }
  const binding =
    recorded === null
      ? live === null && !unreadable
        ? check("machine-binding", "skipped", "not-hosted")
        : check("machine-binding", "warn", "binding-absent")
      : live === null
        ? check("machine-binding", "warn", "handover-unreadable")
        : JSON.stringify(machineIdentity(recorded)) !==
            JSON.stringify(machineIdentity(live))
          ? check("machine-binding", "warn", "machine-identity-changed")
          : recorded.contextDigest !== live.contextDigest
            ? check("machine-binding", "warn", "handover-changed")
            : check("machine-binding", "ok", undefined, {
                machineKind: recorded.kind,
              });
  const hosted = hostedEnvironment(preferences.preset.name);
  const entry =
    !hosted || recorded === null
      ? check("machine-entry", "skipped", "not-hosted")
      : recorded.entry === undefined
        ? check("machine-entry", "warn", "entry-not-recorded")
        : check("machine-entry", "ok");
  return [binding, entry];
}

type ToolRow = Readonly<{
  name: string;
  tier: ToolTier;
  enabled: boolean;
  installed: boolean;
  version?: string | undefined;
  versionError?: string | undefined;
  signIn?: ToolSignIn | undefined;
  /** Whether Lazurio sets the tool up in this Environment (the catalog's
   * `offered`): the Environment vault only in a Remote Environment on
   * Linux (decision F43). */
  offered: boolean;
}>;

function toolCheck(tool: ToolRow): DoctorCheck {
  const context: ErrorContext = {
    tool: tool.name,
    tier: tool.tier,
    ...(tool.version === undefined ? {} : { toolVersion: tool.version }),
    ...(tool.signIn === undefined ? {} : { signIn: tool.signIn.state }),
    ...(tool.signIn?.ssh === undefined ? {} : { ssh: tool.signIn.ssh.state }),
  };
  if (!tool.installed) {
    // A tool this Environment is not offered is not missing.
    if (!tool.offered) return check("tool", "skipped", "not-offered", context);
    if (tool.tier === "required")
      return check("tool", "fail", "required-missing", context);
    if (tool.tier === "recommended")
      return check("tool", "warn", "recommended-missing", context);
    return tool.enabled
      ? check("tool", "warn", "enabled-missing", context)
      : check("tool", "skipped", "not-enabled", context);
  }
  return tool.versionError !== undefined
    ? check("tool", "warn", "version-unreadable", context)
    : check("tool", "ok", undefined, context);
}

/** The Folder's tool selection under its read lock (`toolsOverview`), only
 * where the Folder's state is recognized: taking the lock of a state without
 * one would create it. Otherwise `toolsStatus` over the catalog's tiers, with
 * the selection the Folder recorded when it can be read at all. */
async function toolRows(
  folder: Awaited<ReturnType<typeof observeFolder>>,
  directory: string | undefined,
  tools: ToolsEnvironment,
  signIn: boolean,
): Promise<readonly ToolRow[]> {
  if (directory !== undefined && folder.check.outcome === "ok")
    try {
      return (await toolsOverview(directory, tools, { signIn })).tools;
    } catch {}
  const enabled =
    folder.preferences === null ? [] : enabledTools(folder.preferences);
  // Without a readable selection: offered as the recorded preset and profile
  // say, and only what is offered everywhere without one.
  const preferences = folder.preferences;
  const offered = (entry: ActivatableTool) =>
    preferences === null
      ? entry.activation.offered === undefined
      : toolOffered(
          entry,
          toolEnvironmentOf(preferences.preset.name, preferences.profile),
        );
  const catalog = activatableTools();
  const status = await toolsStatus({ ...tools, catalog });
  const signIns = signIn
    ? await toolsSignIn(
        catalog.map((entry, index) => ({
          probe: entry.activation.signInProbe,
          status: status.tools[index] as (typeof status.tools)[number],
        })),
        tools,
      )
    : undefined;
  return catalog.map((entry, index) => {
    const live = status.tools[index];
    return {
      name: entry.name,
      tier: entry.activation.tier,
      enabled:
        entry.activation.tier === "required" || enabled.includes(entry.name),
      installed: live?.installed ?? false,
      version: live?.version,
      versionError: live?.versionError,
      signIn: signIns?.[index],
      offered: offered(entry),
    };
  });
}

// Declared runtime secrets in a check's context: their names and the one
// reason the catalog gives them all (decision F46).
const secretContext = (
  secrets: readonly RuntimeSecretFinding[],
): ErrorContext =>
  secrets.length === 0
    ? {}
    : {
        secrets: secrets.map((entry) => entry.name).join(","),
        secretReason: (secrets[0] as RuntimeSecretFinding).reason,
      };

/** The Organizations and modules of a catalog as doctor checks; content
 * installation ends an Organization's install with the same checks. */
export function catalogChecks(
  catalog: Catalog | "unreadable" | null,
): DoctorCheck[] {
  if (catalog === null) return [check("catalog", "skipped", "no-folder")];
  if (catalog === "unreadable")
    return [check("catalog", "warn", "catalog-unreadable")];
  const checks: DoctorCheck[] = [
    check("catalog", "ok", undefined, {
      organizations: catalog.organizations.length,
      modules: catalog.organizations.reduce(
        (sum, entry) => sum + entry.modules.length,
        0,
      ),
    }),
  ];
  for (const entry of catalog.organizations) {
    const organization = safeName(entry.organization ?? entry.directory);
    const context = {
      organization,
      ...(entry.state === null ? {} : { state: entry.state }),
    };
    checks.push(
      entry.executable
        ? check("organization", "ok", undefined, context)
        : entry.reason === "template-not-runtime"
          ? check("organization", "skipped", entry.reason, context)
          : check(
              "organization",
              "warn",
              entry.reason ?? "organization-not-executable",
              entry.file === undefined
                ? context
                : { ...context, file: entry.file },
            ),
    );
    for (const module of entry.modules) {
      const named = { organization, module: safeName(module.module) };
      checks.push(
        module.executable
          ? module.secretsNotProvided?.length
            ? check("module", "ok", "runtime-secret-not-provided", {
                ...named,
                ...secretContext(module.secretsNotProvided),
              })
            : check("module", "ok", undefined, named)
          : check(
              "module",
              "warn",
              module.reason ?? "organization-not-executable",
              {
                ...named,
                ...(module.file === undefined ? {} : { file: module.file }),
                ...secretContext(module.secrets ?? []),
              },
            ),
      );
    }
  }
  return checks;
}

// ---- The use case -----------------------------------------------------------

export type DoctorEnvironment = RecoveryEnvironment &
  Readonly<{
    /** The PATH, home and runner the tools are looked up with. */
    tools: ToolsEnvironment;
    /** Run each installed tool's sign-in probe: it may contact the tool's
     * provider, so only on an explicit request. */
    signIn?: boolean | undefined;
    /** Tests only: the loopback probes of the Environment browser (F38). */
    fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
    /** Tests only: where Executor is read (F44); this process's otherwise. */
    executor?: ExecutorHost | undefined;
  }>;

/** Executor as `lazurio executor status` reads it (decision F44): `ok`
 * running, `warn` with its state otherwise, `skipped` where it is not
 * offered. Never `fail`: without Executor an Environment loses its direct
 * Integrations, not its work, and a release that adds Executor must not turn
 * every Environment broken before its Launchpad set it up. */
async function executorCheck(host: ExecutorHost): Promise<DoctorCheck> {
  const status = await executorStatus(host).catch(() => null);
  if (status === null) return check("executor", "skipped", "internal");
  if (status.state === "unsupported")
    return check(
      "executor",
      "skipped",
      status.reason === "handover-unreadable"
        ? "handover-unreadable"
        : "not-offered",
    );
  const context: ErrorContext = {
    tool: executorToolName,
    ...(status.installed === null ? {} : { toolVersion: status.installed }),
    executorService: status.service,
    codexMcp: status.agents.codex,
    claudeMcp: status.agents.claude,
  };
  return status.state === "running"
    ? check("executor", "ok", undefined, context)
    : check("executor", "warn", `executor-${status.state}`, context);
}

export const doctorVerdict = (checks: readonly DoctorCheck[]): DoctorVerdict =>
  checks.some((entry) => entry.outcome === "fail")
    ? "broken"
    : checks.some((entry) => entry.outcome === "warn")
      ? "attention"
      : "ok";

export async function collectDoctor(
  environment: DoctorEnvironment,
): Promise<DoctorResult> {
  const { base, identity, platform, env, run } = environment;
  // The one Folder every reader below is asked about: the named one, the
  // supervised unit's, or on a hosted Machine the declared operator's.
  const service = await detectServiceControl({ base, platform, env, run });
  // A hosted context that is there but unreadable gives no Folder; doctor
  // reads on without one and names it (#83).
  let hostedUnreadable = false;
  const folder =
    environment.folder ??
    service?.folder ??
    (await environment.hostedFolder?.().catch(() => {
      hostedUnreadable = true;
      return undefined;
    }));

  // The broken-product checks exactly as `lazurio recover` computes them;
  // the health answer is kept to say which one the socket gave.
  let answer: HealthAnswer | null = null;
  const ask = environment.health ?? askHealth;
  const recovery = await collectRecovery({
    ...environment,
    folder,
    hostedFolder: undefined,
    health: async (at) => {
      answer = await ask(at);
      return answer;
    },
  });
  const status = await readStatus({ base, identity, service, folder }).catch(
    () => null,
  );
  const observed = await observeFolder(folder);
  const handover = await environment.machineContext().catch(() => null);
  const tools = await toolRows(
    observed,
    folder,
    environment.tools,
    environment.signIn === true,
  );
  const catalog =
    folder === undefined
      ? null
      : await readFolderCatalog(folder).catch(() => "unreadable" as const);
  const codex = await observeCodexAppServer({
    platform,
    env,
    supervised: service !== null,
    // The same signal `lazurio install` writes the unit on.
    hosted: async () =>
      environment.hostedFolder !== undefined &&
      (await environment.hostedFolder()) !== undefined,
    run,
    tools: environment.tools,
  });

  const executor = await executorCheck(
    environment.executor ??
      processExecutorHost({
        hostedFolder: async () => environment.hostedFolder?.(),
        env,
        platform,
        run: environment.tools.run,
      }),
  );

  const browser = await observeEnvironmentBrowser({
    platform,
    env,
    supervised: service !== null,
    hosted: async () =>
      environment.hostedFolder !== undefined &&
      (await environment.hostedFolder()) !== undefined,
    entry:
      handover?.context.entry?.browser === undefined
        ? undefined
        : {
            origin: handover.context.entry.browser.external_origin,
            listenPort: handover.context.entry.browser.listen_port,
          },
    run,
    fetch: environment.fetch ?? ((url, init) => fetch(url, init)),
  });

  const recovered = recovery.checks;
  const facts = observed.facts;
  const [version, available, refresh, template] = productChecks(
    identity,
    status,
    observed,
    folder !== undefined,
  );
  const checks: DoctorCheck[] = [
    fromRecovery("update-state", recovered, "update-state-invalid"),
    version,
    fromRecovery("self-check", recovered, "self-check-failed"),
    available,
    refresh,
    template,
    fromRecovery(
      "folder-state",
      recovered,
      "folder-state",
      facts === null
        ? {}
        : { preset: facts.preset, machineKind: facts.machineKind },
    ),
    ...bindingChecks(observed, handover, hostedUnreadable),
    // Executor has its own check (decision F44), not a tool row.
    ...tools.filter((tool) => tool.name !== executorToolName).map(toolCheck),
    executor,
    ...catalogChecks(catalog),
    fromRecovery("launchpad-unit", recovered, "launchpad-unit"),
    fromRecovery(
      "launchpad-health",
      recovered,
      "launchpad-health",
      answerOf(answer),
    ),
    check("codex-app-server", codex.outcome, codex.reason, codex.context),
    check(
      "environment-browser",
      browser.outcome,
      browser.reason,
      browser.context,
    ),
  ];
  // Group order, stable within a group.
  const ordered = doctorGroups.flatMap((group) =>
    checks.filter((entry) => doctorGroupOf[entry.id] === group),
  );
  return Object.freeze({
    kind: "doctor",
    verdict: doctorVerdict(ordered),
    locale: environment.locale ?? observed.preferences?.profile.locale ?? "en",
    checks: Object.freeze(ordered),
  });
}
