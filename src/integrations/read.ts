import { join } from "node:path";
import type { ExecutorContext } from "../executor/flow";
import { withFolderReadLock } from "../folder/lock";
import type { MachineBinding } from "../folder/machine-binding";
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
import { pinnedUpdateOffered } from "../tools/pin";
import { integrationsCatalog } from "./catalog";
import type { IntegrationsCatalog } from "./catalog-schema";
import {
  type ComposioOrganizationRule,
  composioOrganizationRule,
  convergeComposioOrganization,
  type OwnerReading,
} from "./composio-organization";
import {
  type ComposioNames,
  composioRemovesWithoutPrompt,
  createComposioNames,
  nameComposioAccounts,
  readComposioAccounts,
} from "./composio-source";
import type { ExecutorEndpoint } from "./executor-client";
import { readExecutor } from "./executor-source";
import { microsoft365Here } from "./microsoft365";
import {
  type ComposioReadingState,
  type ComposioSignIn,
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
// reads again on an explicit refresh. Composio's accounts are named in the
// reading: by the list itself where it is Lazurio's build's, which prints
// every account's id, alias and provider identity (decision F42, addendum
// (3)); else a toolkit's only account by `link <toolkit> --list`, a name the
// Launchpad keeps for half an hour. The organization of its link to
// Composio's dashboard is the one Composio's sign-in probe already read: no
// second `composio whoami`.

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
  /** The names of Composio's accounts the Launchpad keeps between readings
   * (`createIntegrationsReader`); without them, as for `lazurio
   * integrations list`, every reading reads them. */
  composioNames?: ComposioNames;
  /** The Composio sign-ins the Launchpad started (its connect sessions,
   * `signIns`); without them, as for `lazurio integrations list`, no
   * pending account is listed. */
  composioSignIns?: () => ReadonlyMap<string, readonly ComposioSignIn[]>;
  catalog?: IntegrationsCatalog;
  now?: () => Date;
  /** The journal of a change the reading makes (the Composio organization
   * it makes current): the operation and the outcome, never a value. */
  journal?: (entry: Readonly<Record<string, string>>) => void;
  /** Test and preview seam: the rule of this Environment's Composio
   * organization, instead of the one its Machine binding gives. */
  composioOrganization?: ComposioOrganizationRule;
  /** Test seam: how that rule reads the Folder's Organizations and waits
   * before it reads them again (`composioOrganizationRule`). */
  organizationReading?: OwnerReading;
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

/** The tools for one app that agents use (required or enabled), that are
 * installed and whose sign-in probe says `state`. */
function appToolsSignedIn(
  tools: readonly ToolOverview[],
  state: "signed-in" | "unknown",
): AppTool[] {
  return tools.flatMap((tool) => {
    const name = appTools.find((item) => item === tool.name);
    return name !== undefined &&
      tool.enabled &&
      tool.installed &&
      tool.signIn?.state === state
      ? [name]
      : [];
  });
}

/** A tool for one app counts as connected when agents use it (required or
 * enabled), it is installed and its sign-in probe says signed in. */
export function connectedTools(tools: readonly ToolOverview[]): AppTool[] {
  return appToolsSignedIn(tools, "signed-in");
}

/** A tool for one app that agents use and that is installed, but whose
 * sign-in its probe could not tell (it timed out, or its answer was not
 * understood): what it connects is unknown, never "not connected"
 * (decision F42, addendum of 2026-10-27). */
export function unknownTools(tools: readonly ToolOverview[]): AppTool[] {
  return appToolsSignedIn(tools, "unknown");
}

/** Composio as this Environment reads it: its accounts, whether its CLI
 * removes one without a prompt, the organization it works in, and the
 * organization of this Environment's Organization's name where it has one
 * (decision F42, addendum of 2026-10-13), or the account's default one on a
 * person's own Environment (addendum of 2026-10-26), made current first. */
async function readComposioSource(
  host: IntegrationsHost,
  tool: ToolOverview | undefined,
  allowed: boolean,
  machine: MachineBinding | null,
): Promise<
  Readonly<{
    composio: ComposioReadingState;
    disconnect: boolean;
    organization: string | null;
    target: IntegrationsOverview["composio"]["organization"];
  }>
> {
  const signedIn = tool?.signIn?.organization ?? null;
  const only = (composio: ComposioReadingState) =>
    ({
      composio,
      disconnect: false,
      organization: signedIn,
      target: null,
    }) as const;
  if (tool === undefined || !tool.installed)
    return only({ state: "unavailable" });
  const signIn = tool.signIn?.state;
  if (signIn !== "signed-in" && signIn !== "unknown")
    return only({ state: "signed-out" });
  if (!allowed || tool.path === undefined)
    return only({ state: "unavailable" });
  // Signed in, but off for agents here: said as such, so that a card says
  // which switch it waits for instead of asking for a sign-in that is there
  // (decision F42, note of 2026-10-19).
  if (!tool.enabled) return only({ state: "off" });
  // A sign-in its probe could not tell (`composio whoami` timed out, or its
  // answer was not understood) is no sign-out: Composio was not read, so
  // what it connects here is unknown, never "not connected" (decision F42,
  // addendum of 2026-10-27).
  if (signIn === "unknown") return only({ state: "unreadable" });
  const command = tool.path;
  let organization = signedIn;
  let target: IntegrationsOverview["composio"]["organization"] = null;
  const rule =
    host.composioOrganization ??
    (await composioOrganizationRule(
      host.folder,
      machine,
      host.organizationReading,
    ));
  // Nothing of Composio counts where its organization cannot be told: an
  // Organization's name that cannot be read (Pablo's review of #372), or an
  // organization of that name, or the account's default one, that could not
  // be made current.
  const closed = (
    state: "unverified" | "elsewhere",
    name: string | null,
    own = false,
  ) => ({
    composio: { state: "organization" } as const,
    disconnect: false,
    organization,
    target: Object.freeze({ name, state, ...(own ? { default: true } : {}) }),
  });
  if (rule.kind === "unverified") return closed("unverified", null);
  // A person's own Environment: the account's default organization, made
  // current where another one is (the sign-in lands in the one open in
  // Composio's dashboard, often an Organization's). Where the CLI does not
  // date the organizations, the person's current one, as before.
  if (rule.kind === "default") {
    const converged = await convergeComposioOrganization(
      host.tools,
      command,
      rule,
      host.journal,
    );
    if (converged === null) return only({ state: "unreadable" });
    const { verdict } = converged;
    if (verdict.kind === "elsewhere")
      return closed("elsewhere", verdict.organization.name, true);
    if (verdict.kind === "matches") {
      target = Object.freeze({
        name: verdict.organization.name,
        state: "matches",
        default: true,
      });
      organization = verdict.organization.name;
    }
  }
  if (rule.kind === "named") {
    const converged = await convergeComposioOrganization(
      host.tools,
      command,
      rule,
      host.journal,
    );
    if (converged === null) return only({ state: "unreadable" });
    const { verdict } = converged;
    if (verdict.kind === "elsewhere") return closed("elsewhere", rule.name);
    target = Object.freeze({ name: rule.name, state: verdict.kind });
    // Missing or there more than once: the person's current organization,
    // with a notice (the Operator's decision of 2026-10-13: nothing breaks
    // for people who already connect through Composio).
    if (verdict.kind === "matches") organization = verdict.organization.name;
  }
  const [reading, disconnect] = await Promise.all([
    readComposioAccounts(host.tools, command),
    composioRemovesWithoutPrompt(host.tools, command),
  ]);
  return {
    composio:
      reading.state === "ok"
        ? {
            state: "ok",
            accounts: await nameComposioAccounts(
              host.tools,
              command,
              reading.accounts,
              host.composioNames === undefined
                ? {}
                : { names: host.composioNames },
            ),
          }
        : reading,
    disconnect,
    organization,
    target,
  };
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
  const settings = folderOrganizationSettings(preferences);
  const recorded = composioPolicyOf(preferences.preset.name, settings);
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
      : {
          state: "ok",
          connected: connectedTools(overview.tools),
          unknown: unknownTools(overview.tools),
        };
  const composioTool = overview?.tools.find((tool) => tool.name === "composio");
  // On for agents here: switched on, and allowed (decision F45).
  const composioReady =
    policy.allowed &&
    composioTool?.enabled === true &&
    composioTool.installed &&
    composioTool.signIn?.state === "signed-in";
  const source =
    overview === null
      ? ({
          composio: { state: "unreadable" },
          disconnect: false,
          organization: null,
          target: null,
        } as const)
      : await readComposioSource(
          host,
          composioTool,
          policy.allowed,
          preferences.machine,
        );
  return mergeIntegrations({
    catalog,
    locale,
    scope,
    origin: preferences.machine?.entry?.externalOrigin ?? null,
    policy,
    composioReady,
    composioOrganization: source.organization,
    composioTarget: source.target,
    tools,
    executor,
    composio: source.composio,
    composioSignIns: host.composioSignIns?.() ?? new Map(),
    composioDisconnect: source.disconnect,
    // Not the build Lazurio pins, and its update can work: the row of
    // Settings → Tools says so too (decision F42, addendum (b) of
    // 2026-10-14).
    composioUpdate:
      composioTool !== undefined && pinnedUpdateOffered(composioTool),
    // The Organization's Microsoft 365 company app, as the Folder records
    // it (decision F42 addendum (c) of 2026-10-14).
    microsoft365: microsoft365Here(preferences.preset.name, settings),
    readAt: (host.now ?? (() => new Date()))().toISOString(),
  });
}

/** How long the Launchpad shows the last reading before it reads again. */
export const integrationsFreshMs = 60_000;

/** The Launchpad's reading: the last one while it is fresh, one read at a
 * time, and a new one on an explicit refresh or after a change. The names of
 * Composio's single accounts outlive it (`composioNamesFreshMs`): an
 * explicit refresh ("Zkontrolovat připojení") forgets every name, and a
 * connect or disconnect forgets its toolkit's (`forgetNames`). */
export function createIntegrationsReader(
  host: () => IntegrationsHost,
  now: () => number = Date.now,
) {
  const names = createComposioNames(now);
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
    const promise = readIntegrations({ ...host(), composioNames: names })
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
    /** The overview: the last one while fresh, unless `refresh`, which
     * reads every name of Composio's accounts again too, by a reading of its
     * own: never one, nor a lookup, that started before it. */
    async overview(refresh = false): Promise<IntegrationsOverview> {
      if (refresh) {
        names.forget();
        generation += 1;
      } else if (last !== null && now() - last.at < integrationsFreshMs)
        return last.overview;
      return read();
    },
    /** Something changed: the next answer reads again. */
    forget() {
      generation += 1;
      last = null;
    },
    /** An account of Composio's `toolkit` was connected, signed in again or
     * disconnected here: its names are read again. */
    forgetNames(toolkit: string) {
      names.forget(toolkit);
    },
  });
}
