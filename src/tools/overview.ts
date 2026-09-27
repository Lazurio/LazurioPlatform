import { join } from "node:path";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import { sharedEnvironment } from "../folder/render";
import { enabledTools } from "../folder/state";
import {
  activatableTools,
  mcpServerPrompt,
  type ToolSetup,
  type ToolTier,
  toolPrompt,
} from "./catalog";
import { type ToolRunner, toolsStatus } from "./status";

/** Where the live facts are read: the PATH and home of the process that
 * serves the surface, and the runner of the version commands. */
export type ToolsEnvironment = Readonly<{
  path: string | undefined;
  home: string | undefined;
  platform: string;
  run: ToolRunner;
}>;

export type ToolOverview = Readonly<{
  name: string;
  command: string;
  tier: ToolTier;
  setup: ToolSetup;
  enabled: boolean;
  purpose: string;
  usage: string;
  source: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  versionError?: string;
  standardPath?: boolean;
  /** The prepared prompt for an agent who installs the tool and guides the
   * sign-in: the action of an `agent` tool, the fallback of a `launchpad` one. */
  prompt: string;
}>;

export type ToolsOverview = Readonly<{
  kind: "tools-status";
  revision: number;
  locale: "cs" | "en";
  sharedEnvironment: boolean;
  tools: readonly ToolOverview[];
  mcpPrompt: string;
}>;

// The tools screen of one Folder (decision F18): what is recorded (revision,
// locale, enabled selection, whether sign-ins are shared) joined with the live
// facts of `tools status` for the activatable tools, in catalog order. The
// recorded part is read under the common lock; the probe runs after it and
// runs each tool's version command only: no sign-in check and no network. The
// raw output of a tool is not part of the answer.
export async function toolsOverview(
  folder: string,
  environment: ToolsEnvironment,
): Promise<ToolsOverview> {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  const recorded = await withFolderOperationLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    return {
      revision: preferences.revision,
      locale: preferences.profile.locale,
      sharedEnvironment: sharedEnvironment(preferences.preset.name),
      enabled: enabledTools(preferences),
    };
  });
  const catalog = activatableTools();
  const status = await toolsStatus({ ...environment, catalog });
  const { locale } = recorded;
  return {
    kind: "tools-status",
    revision: recorded.revision,
    locale,
    sharedEnvironment: recorded.sharedEnvironment,
    tools: catalog.map((entry, index) => {
      const live = status.tools[index];
      if (live === undefined || live.name !== entry.name)
        throw new Error("Tool status does not match the catalog");
      return {
        name: entry.name,
        command: entry.command,
        tier: entry.activation.tier,
        setup: entry.activation.setup,
        enabled:
          entry.activation.tier === "required" ||
          recorded.enabled.includes(entry.name),
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
        prompt: toolPrompt(entry.name, locale) ?? "",
      };
    }),
    mcpPrompt: mcpServerPrompt(locale),
  };
}
