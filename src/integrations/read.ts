import { join } from "node:path";
import type { ExecutorContext } from "../executor/flow";
import { withFolderReadLock } from "../folder/lock";
import type { PresetName } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { folderOrganizationSettings } from "../folder/state";
import {
  composioPolicyOf,
  organizationGoverns,
} from "../organization-settings/governance";
import { executorToolName } from "../tools/catalog";
import {
  type ToolOverview,
  type ToolsEnvironment,
  type ToolsOverview,
  toolsOverview,
} from "../tools/overview";
import { integrationsCatalog } from "./catalog";
import type { IntegrationsCatalog } from "./catalog-schema";
import { readComposioAccounts } from "./composio-source";
import type { ExecutorEndpoint } from "./executor-client";
import { readExecutor } from "./executor-source";
import {
  type ComposioReadingState,
  type IntegrationsOverview,
  mergeIntegrations,
  type ToolsReading,
} from "./model";
import { type AppTool, appTools, type Rules } from "./path";
import type { ComposioPolicySource } from "./policy";

// One reading of the Integrace of an Environment (decision F42), the same
// for `GET /api/integrations` and `lazurio integrations list`: the Folder's
// preset and language, the tools with their sign-ins, the Environment's
// Executor and the person's Composio account, each read on its own so that
// one source down never hides the others. The sign-in probes and Composio
// reach the network, so the Launchpad keeps the last reading for a while and
// reads again on an explicit refresh.

export type IntegrationsHost = Readonly<{
  folder: string;
  tools: ToolsEnvironment;
  executor: ExecutorEndpoint | null;
  /** Whether Lazurio sets Executor up for this Environment (decision F44's
   * context: a Remote Environment's operator, never a workstation yet).
   * Without it the row's `offered` decides. */
  executorContext?: () => Promise<ExecutorContext>;
  /** Test and preview seam: whether Executor is part of this Environment,
   * instead of F44's context and its row in Settings → Tools
   * (`executorHere`). */
  executorPresent?: boolean;
  /** Test seam; by default the Organization settings the Folder records
   * decide (`composioPolicyOf`, decision F45). */
  policy?: ComposioPolicySource;
  catalog?: IntegrationsCatalog;
  now?: () => Date;
}>;

/** The scope of the rule: a personal Environment and the person's own
 * computer decide alone; every Organization's Environment follows its
 * Organization (root decision 0194 point 5). */
export function scopeOf(preset: PresetName): Rules["scope"] {
  return organizationGoverns(preset) ? "organization" : "personal";
}

/** Whether Executor is part of this Environment (decision F44): Lazurio
 * sets it up here (F44's context; without one, its row in Settings → Tools
 * offers it: a Remote Environment, a workstation being the second wave) and
 * that row says it is installed. Where the tools could not be read, Executor
 * counts as there and its own reading tells why it does not answer. */
export function executorHere(
  overview: ToolsOverview | null,
  context: ExecutorContext | null = null,
): boolean {
  if (overview === null) return true;
  const executor = overview.tools.find(
    (tool) => tool.name === executorToolName,
  );
  if (executor === undefined || !executor.installed) return false;
  return context === null ? executor.offered : context.kind === "supported";
}

/** A tool for one app counts as connected when agents use it (required or
 * enabled), it is installed and its sign-in probe says signed in. */
export function connectedTools(tools: readonly ToolOverview[]): AppTool[] {
  return tools.flatMap((tool) => {
    const name = appTools.find((item) => item === tool.name);
    return name !== undefined &&
      tool.enabled &&
      tool.installed &&
      tool.signIn?.state === "signed-in"
      ? [name]
      : [];
  });
}

export async function readIntegrations(
  host: IntegrationsHost,
): Promise<IntegrationsOverview> {
  const catalog = host.catalog ?? integrationsCatalog;
  const state = join(host.folder, ".lazurio");
  const { preferences } = await withFolderReadLock(state, () =>
    readFolderState(state),
  );
  const locale = preferences.profile.locale === "cs" ? "cs" : "en";
  const scope = scopeOf(preferences.preset.name);
  // Whether Composio is allowed here: what the Organization's settings the
  // Folder records say (root decision 0194, decision F45), or the
  // Environment where they say nothing.
  const recorded = composioPolicyOf(
    preferences.preset.name,
    folderOrganizationSettings(preferences),
  );
  const [overview, reading, policy, context] = await Promise.all([
    toolsOverview(host.folder, host.tools, { signIn: true }).catch(() => null),
    readExecutor(host.executor, catalog),
    host.policy === undefined ? recorded : host.policy(),
    host.executorPresent !== undefined || host.executorContext === undefined
      ? null
      : host.executorContext().catch(() => null),
  ]);
  // Executor's reading counts only where Executor is part of the
  // Environment; elsewhere nothing connects directly (decision F44).
  const executor =
    (host.executorPresent ?? executorHere(overview, context))
      ? reading
      : ({ state: "absent" } as const);
  const tools: ToolsReading =
    overview === null
      ? { state: "unreadable" }
      : { state: "ok", connected: connectedTools(overview.tools) };
  const composioTool = overview?.tools.find((tool) => tool.name === "composio");
  // On for agents here: switched on, and allowed (decision F45).
  const composioReady =
    policy.allowed &&
    composioTool?.enabled === true &&
    composioTool.installed &&
    composioTool.signIn?.state === "signed-in";
  let composio: ComposioReadingState;
  if (overview === null) composio = { state: "unreadable" };
  else if (composioTool === undefined || !composioTool.installed)
    composio = { state: "unavailable" };
  else if (composioTool.signIn?.state !== "signed-in")
    composio = { state: "signed-out" };
  else if (
    !policy.allowed ||
    !composioTool.enabled ||
    composioTool.path === undefined
  )
    composio = { state: "unavailable" };
  else composio = await readComposioAccounts(host.tools, composioTool.path);
  return mergeIntegrations({
    catalog,
    locale,
    scope,
    origin: preferences.machine?.entry?.externalOrigin ?? null,
    policy,
    composioReady,
    tools,
    executor,
    composio,
    readAt: (host.now ?? (() => new Date()))().toISOString(),
  });
}

/** How long the Launchpad shows the last reading before it reads again. */
export const integrationsFreshMs = 60_000;

/** The Launchpad's reading: the last one while it is fresh, one read at a
 * time, and a new one on an explicit refresh or after a change. */
export function createIntegrationsReader(
  host: () => IntegrationsHost,
  now: () => number = Date.now,
) {
  let last: Readonly<{ at: number; overview: IntegrationsOverview }> | null =
    null;
  let reading: Readonly<{
    generation: number;
    promise: Promise<IntegrationsOverview>;
  }> | null = null;
  let generation = 0;
  function read(): Promise<IntegrationsOverview> {
    // A reading that started before the last change does not answer after it.
    if (reading !== null && reading.generation === generation)
      return reading.promise;
    const mine = generation;
    const started = now();
    const promise = readIntegrations(host())
      .then((overview) => {
        if (mine === generation) last = { at: started, overview };
        return overview;
      })
      .finally(() => {
        if (reading?.promise === promise) reading = null;
      });
    reading = { generation: mine, promise };
    return promise;
  }
  return Object.freeze({
    /** The overview: the last one while fresh, unless `refresh`. */
    async overview(refresh = false): Promise<IntegrationsOverview> {
      if (!refresh && last !== null && now() - last.at < integrationsFreshMs)
        return last.overview;
      return read();
    },
    /** Something changed: the next answer reads again. */
    forget() {
      generation += 1;
      last = null;
    },
  });
}
