import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { githubIdentity } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import {
  hostedEnvironment,
  sharedEnvironment,
  toolEnvironmentOf,
} from "../folder/render";
import {
  enabledTools,
  folderOrganizationSettings,
  toolNotes,
} from "../folder/state";
import { toolGovernance } from "../organization-settings/governance";
import type { OrganizationSettingsStatus } from "../organization-settings/status";
import {
  activatableTools,
  mcpServerPrompt,
  type ToolSetup,
  type ToolTier,
  toolOffered,
  toolPrompt,
} from "./catalog";
import { pinnedInstaller } from "./install";
import type { SshProofs } from "./ssh-key";
import {
  boundedAll,
  runTool,
  type ToolRunner,
  type ToolSignIn,
  type ToolStatus,
  type ToolsStatusResult,
  toolStatus,
  toolsReadAtOnce,
  toolsSignIn,
  xdgOf,
} from "./status";

/** Where the live facts are read: the PATH and home of the process that
 * serves the surface (and its XDG base directories, which only a sign-in
 * probe receives), and the runner of the version and sign-in commands. */
export type ToolsEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  xdg?: Readonly<Record<string, string>> | undefined;
  platform: string;
  run: ToolRunner;
  /** gh's SSH proofs the reading process keeps (decision F19, addendum of
   * 2026-10-19): the Launchpad's one `createSshProofs`, shared by every
   * reading of the sign-ins it makes. Absent (the CLI, doctor): every
   * reading with the sign-ins proves. */
  sshProofs?: SshProofs | undefined;
}>;

/** The tools environment of a process: its PATH, home and XDG base
 * directories, as the Launchpad, `lazurio doctor` and `lazurio chat link`
 * read them. */
export function toolsEnvironmentOf(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
  run: ToolRunner = runTool,
): ToolsEnvironment {
  return {
    path: env.PATH,
    home: env.HOME,
    xdg: xdgOf(env),
    platform,
    run,
  };
}

export type ToolOverview = Readonly<{
  name: string;
  command: string;
  tier: ToolTier;
  setup: ToolSetup;
  /** Required, or switched on by the person in this Folder: the recorded
   * choice. Agents use it where it is also `offered` and the Organization
   * does not refuse it (`organization`). */
  enabled: boolean;
  /** Whether this Environment offers the tool (`toolOffered`, decision
   * F44): one it does not offer is not rendered for agents and cannot be
   * enabled. */
  offered: boolean;
  /** What the Organization's settings say about the tool on this
   * Environment, when they say anything (root decision 0194, decision F45):
   * one it does not allow is not used by agents, whatever `enabled` says,
   * and that choice is kept for when it allows it again. */
  organization?: Readonly<{ allowed: boolean }>;
  purpose: string;
  usage: string;
  source: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  versionError?: string;
  standardPath?: boolean;
  /** The build Lazurio pins for the tool (composio, decision F42 addendum
   * (3)): its update (`lazurio tools update`, Settings → Tools → Update)
   * installs exactly that version. */
  pinned?: string;
  /** Whether the tool is signed in and as whom: present only when the
   * request asked for the sign-in probes. */
  signIn?: ToolSignIn;
  /** The operator's note for agents on this tool, when there is one. */
  note?: string;
  /** The prepared prompt for an agent who installs the tool and guides the
   * sign-in: the action of an `agent` tool, the fallback of a `launchpad` one. */
  prompt: string;
}>;

export type ToolsOverview = Readonly<{
  kind: "tools-status";
  revision: number;
  locale: "cs" | "en";
  sharedEnvironment: boolean;
  /** Only on a public Environment, which has no GitHub identity (decision
   * F55's addendum of 2026-10-17); absent everywhere else. */
  audience?: "public";
  /** A hosted Machine (every preset but `local`): only there is a tool
   * outside `~/.local/bin` something to look at (decision 0161). */
  hosted: boolean;
  tools: readonly ToolOverview[];
  mcpPrompt: string;
  /** Where this Environment's Organization settings come from and how they
   * were applied last (decision F45); only from a Launchpad that asks for
   * them, never from the CLI. */
  organizationSettings?: OrganizationSettingsStatus;
  /** The live facts are the Launchpad's last reading, older than its
   * minute, answered at once while it reads them anew (tools-reading.ts);
   * only from a Launchpad asked with `allowStale`, never from the CLI. */
  stale?: true;
}>;

/** The live facts of the activatable tools, in catalog order: what `tools
 * status` finds, and each tool's sign-in when they were asked for. */
export type ToolsLive = Readonly<{
  status: ToolsStatusResult;
  signIns?: readonly ToolSignIn[];
}>;

/** Reads the live facts now: each found tool's version command, which never
 * uses the network, and with `signIn` each installed tool's sign-in probe,
 * which may contact the tool's provider (F18 addendum 2026-09-27). At most
 * `toolsReadAtOnce` tools are read at a time, each tool's sign-in right
 * after its own version in the same place (plan DEV-6656). */
export async function readToolsLive(
  environment: ToolsEnvironment,
  signIn: boolean,
): Promise<ToolsLive> {
  const input = {
    path: environment.path,
    home: environment.home,
    platform: environment.platform,
    run: environment.run,
  };
  const read = await boundedAll(
    activatableTools(),
    toolsReadAtOnce,
    async (
      entry,
    ): Promise<Readonly<{ status: ToolStatus; signIn?: ToolSignIn }>> => {
      const status = await toolStatus(entry, input);
      if (!signIn) return { status };
      const [probed] = await toolsSignIn(
        [{ probe: entry.signInProbe, status }],
        environment,
      );
      if (probed === undefined) throw new Error("A sign-in probe is missing");
      return { status, signIn: probed };
    },
  );
  const status: ToolsStatusResult = {
    kind: "tools-status",
    tools: read.map((tool) => tool.status),
  };
  if (!signIn) return { status };
  return {
    status,
    signIns: read.map((tool) => tool.signIn ?? { state: "unknown" }),
  };
}

// The tools screen of one Folder (decision F18): what is recorded (revision,
// locale, enabled selection, the operator's notes, whether sign-ins are
// shared, whether the Machine is hosted) joined with the live facts of `tools
// status` for the activatable tools, in catalog order. The recorded part is
// read under the common lock; the live facts after it, now (`readToolsLive`)
// unless the caller hands over its own reading of them (`live`: the
// Launchpad's, kept a short while, tools-reading.ts). Sign-ins are part of
// the answer only with `signIn`. The raw output of a tool is never part of
// the answer.
export async function toolsOverview(
  folder: string,
  environment: ToolsEnvironment,
  options: Readonly<{
    signIn?: boolean;
    live?: (signIn: boolean) => Promise<ToolsLive>;
  }> = {},
): Promise<ToolsOverview> {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  const recorded = await withFolderReadLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    return {
      revision: preferences.revision,
      locale: preferences.profile.locale,
      sharedEnvironment: sharedEnvironment(preferences.preset.name),
      isPublic:
        githubIdentity(preferences.preset.name, preferences.machine) === "none",
      hosted: hostedEnvironment(preferences.preset.name),
      offeredIn: toolEnvironmentOf(
        preferences.preset.name,
        preferences.profile,
      ),
      enabled: enabledTools(preferences),
      notes: toolNotes(preferences),
      settings: folderOrganizationSettings(preferences),
    };
  });
  const catalog = activatableTools();
  const signIn = options.signIn === true;
  const { status, signIns: probed } = await (
    options.live ?? ((asked) => readToolsLive(environment, asked))
  )(signIn);
  if (signIn && probed?.length !== catalog.length)
    throw new Error("Tool sign-ins do not match the catalog");
  const signIns = signIn ? probed : undefined;
  const { locale } = recorded;
  return {
    kind: "tools-status",
    revision: recorded.revision,
    locale,
    sharedEnvironment: recorded.sharedEnvironment,
    ...(recorded.isPublic ? { audience: "public" as const } : {}),
    hosted: recorded.hosted,
    tools: catalog.map((entry, index) => {
      const live = status.tools[index];
      if (live === undefined || live.name !== entry.name)
        throw new Error("Tool status does not match the catalog");
      const signIn = signIns?.[index];
      const note = Object.hasOwn(recorded.notes, entry.name)
        ? recorded.notes[entry.name]
        : undefined;
      const chosen =
        entry.activation.tier === "required" ||
        recorded.enabled.includes(entry.name);
      const governance = toolGovernance(entry.name, recorded.settings);
      const pinned = pinnedInstaller(entry.name)?.version;
      return {
        name: entry.name,
        command: entry.command,
        tier: entry.activation.tier,
        setup: entry.activation.setup,
        enabled: chosen,
        offered: toolOffered(entry, recorded.offeredIn),
        ...(governance === null
          ? {}
          : { organization: { allowed: governance.allowed } }),
        purpose: entry.activation.purpose[locale],
        usage: entry.activation.usage[locale],
        source: entry.source,
        installed: live.installed,
        ...(live.path === undefined ? {} : { path: live.path }),
        ...(live.realPath === undefined ? {} : { realPath: live.realPath }),
        ...(live.version === undefined ? {} : { version: live.version }),
        ...(live.versionError === undefined
          ? {}
          : { versionError: live.versionError }),
        ...(live.standardPath === undefined
          ? {}
          : { standardPath: live.standardPath }),
        ...(pinned === undefined ? {} : { pinned }),
        ...(signIn === undefined ? {} : { signIn }),
        ...(note === undefined ? {} : { note }),
        // On a Team Environment gh's prompt signs nobody in, and on a public
        // one it says there is no GitHub identity.
        prompt:
          toolPrompt(entry.name, locale, {
            team: recorded.sharedEnvironment,
            ...(recorded.isPublic ? { audience: "public" as const } : {}),
          }) ?? "",
      };
    }),
    mcpPrompt: mcpServerPrompt(locale),
  };
}
