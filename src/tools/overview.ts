import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import {
  hostedEnvironment,
  sharedEnvironment,
  toolEnvironmentOf,
} from "../folder/render";
import { enabledTools, toolNotes } from "../folder/state";
import {
  activatableTools,
  mcpServerPrompt,
  type ToolSetup,
  type ToolTier,
  toolOffered,
  toolPrompt,
} from "./catalog";
import {
  runTool,
  type ToolRunner,
  type ToolSignIn,
  toolsSignIn,
  toolsStatus,
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
  enabled: boolean;
  /** Whether this Environment offers the tool (`toolOffered`, decision
   * F44): one it does not offer is not rendered for agents and cannot be
   * enabled. */
  offered: boolean;
  purpose: string;
  usage: string;
  source: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  versionError?: string;
  standardPath?: boolean;
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
  /** A hosted Machine (every preset but `local`): only there is a tool
   * outside `~/.local/bin` something to look at (decision 0161). */
  hosted: boolean;
  tools: readonly ToolOverview[];
  mcpPrompt: string;
}>;

// The tools screen of one Folder (decision F18): what is recorded (revision,
// locale, enabled selection, the operator's notes, whether sign-ins are
// shared, whether the Machine is hosted) joined with the live facts of `tools
// status` for the activatable tools, in catalog order. The recorded part is
// read under the common lock; the probe runs after it and runs each tool's
// version command, which never uses the network. Only with `signIn` does it
// also run each installed tool's sign-in probe, which may contact the tool's
// provider (F18 addendum 2026-09-27). The raw output of a tool is never part
// of the answer.
export async function toolsOverview(
  folder: string,
  environment: ToolsEnvironment,
  options: Readonly<{ signIn?: boolean }> = {},
): Promise<ToolsOverview> {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  const recorded = await withFolderReadLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    return {
      revision: preferences.revision,
      locale: preferences.profile.locale,
      sharedEnvironment: sharedEnvironment(preferences.preset.name),
      hosted: hostedEnvironment(preferences.preset.name),
      offeredIn: toolEnvironmentOf(
        preferences.preset.name,
        preferences.profile,
      ),
      enabled: enabledTools(preferences),
      notes: toolNotes(preferences),
    };
  });
  const catalog = activatableTools();
  const status = await toolsStatus({
    path: environment.path,
    home: environment.home,
    platform: environment.platform,
    run: environment.run,
    catalog,
  });
  const signIns =
    options.signIn === true
      ? await toolsSignIn(
          catalog.map((entry, index) => {
            const live = status.tools[index];
            if (live === undefined || live.name !== entry.name)
              throw new Error("Tool status does not match the catalog");
            return { probe: entry.activation.signInProbe, status: live };
          }),
          environment,
        )
      : undefined;
  const { locale } = recorded;
  return {
    kind: "tools-status",
    revision: recorded.revision,
    locale,
    sharedEnvironment: recorded.sharedEnvironment,
    hosted: recorded.hosted,
    tools: catalog.map((entry, index) => {
      const live = status.tools[index];
      if (live === undefined || live.name !== entry.name)
        throw new Error("Tool status does not match the catalog");
      const signIn = signIns?.[index];
      const note = Object.hasOwn(recorded.notes, entry.name)
        ? recorded.notes[entry.name]
        : undefined;
      return {
        name: entry.name,
        command: entry.command,
        tier: entry.activation.tier,
        setup: entry.activation.setup,
        enabled:
          entry.activation.tier === "required" ||
          recorded.enabled.includes(entry.name),
        offered: toolOffered(entry, recorded.offeredIn),
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
        ...(signIn === undefined ? {} : { signIn }),
        ...(note === undefined ? {} : { note }),
        // On a Team Environment gh's prompt signs nobody in.
        prompt:
          toolPrompt(entry.name, locale, {
            team: recorded.sharedEnvironment,
          }) ?? "",
      };
    }),
    mcpPrompt: mcpServerPrompt(locale),
  };
}
