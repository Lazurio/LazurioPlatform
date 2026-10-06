import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import type { MachineBinding } from "../folder/machine-binding";
import type { PresetName } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import type { ModuleAnswer, ModuleBlocked } from "../modules/module-operations";
import { type Catalog, readFolderCatalog } from "../organizations/catalog";
import { type ToolsEnvironment, toolsEnvironmentOf } from "../tools/overview";
import { runTool } from "../tools/status";
import { resolveInstallBase } from "../update/base";
import { type ContentGit, gitEnvironmentOf, processContentGit } from "./git";
import { type ContentGitHub, ghContentGitHub } from "./github";

// Where content installation runs: this Environment's GitHub sign-in, the
// operator's git, the per-Folder lock and the module preparation of the
// shared module core. Trusted composition, never request input; tests
// supply a stub GitHub and local bare repositories.

export type PreparationAnswer =
  | Readonly<{ ok: true; outcome: string }>
  | Readonly<{ ok: false; reason: string }>;

export type ContentHost = Readonly<{
  github: ContentGitHub;
  git: ContentGit;
  /** The directory of the per-Folder content locks. */
  lockDirectory: string;
  /** The declared preparation of one module, by `<Organization>/<module>`
   * (`lazurio module prepare`, decision F34). */
  prepare: (name: string) => Promise<PreparationAnswer>;
  /** Test seam: the catalog core. */
  readCatalog?: (folder: string) => Promise<Catalog>;
}>;

/** A module operation's answer as a preparation outcome. */
export const preparationAnswer = (
  result: ModuleAnswer | ModuleBlocked,
): PreparationAnswer =>
  result.kind === "blocked"
    ? { ok: false, reason: result.reason }
    : { ok: true, outcome: result.outcome };

/** The content locks of an install base. */
export const contentLockDirectory = (base: string) => join(base, "content");

/** The host of this process: gh and git from the operator's PATH and home,
 * the lock in the per-user install base of that home. */
export function processContentHost(
  input: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    prepare: ContentHost["prepare"];
    tools?: ToolsEnvironment | undefined;
    /** The install base, when known (the installed Launchpad's `--base`). */
    base?: string | undefined;
  }>,
): ContentHost {
  const tools =
    input.tools ?? toolsEnvironmentOf(input.env, input.platform, runTool);
  const base =
    input.base ??
    resolveInstallBase({
      platform: input.platform,
      env: { XDG_DATA_HOME: tools.xdg?.XDG_DATA_HOME },
      homedir: tools.home,
    });
  if (base === undefined) throw new Error("No per-user install base");
  return Object.freeze({
    github: ghContentGitHub(tools),
    git: processContentGit({
      path: tools.path,
      home: tools.home,
      platform: tools.platform,
      run: tools.run,
      env: gitEnvironmentOf(input.env),
    }),
    lockDirectory: contentLockDirectory(base),
    prepare: input.prepare,
  });
}

/** The Folder's recorded preset and Machine binding, under the common read
 * lock. */
export async function readFolderKind(
  folder: string,
): Promise<Readonly<{ preset: PresetName; machine: MachineBinding | null }>> {
  const state = join(folder, ".lazurio");
  const { preferences } = await withFolderReadLock(state, () =>
    readFolderState(state),
  );
  return { preset: preferences.preset.name, machine: preferences.machine };
}

export const catalogOf = (host: ContentHost, folder: string) =>
  (host.readCatalog ?? readFolderCatalog)(folder);
