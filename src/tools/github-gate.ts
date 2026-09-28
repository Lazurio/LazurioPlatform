import { join } from "node:path";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { type PresetName, workspacePreset } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import type { LoginSessions } from "./login";
import {
  type GithubAction,
  githubActionRefused,
  teamGithubLogoutText,
  teamGithubText,
} from "./team-github";

/** The recorded preset of one Folder, read under the common lock: what the
 * Launchpad serving that Folder decides the kind of Environment by. */
export async function folderPreset(folder: string): Promise<PresetName> {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  return withFolderOperationLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    return preferences.preset.name;
  });
}

/** The kind of Environment a command without `--folder` runs in: on a hosted
 * Machine, the recorded preset of the declared operator's Folder, found from
 * the root-issued handover exactly as `lazurio update` finds it
 * (`hostedOperatorFolder`). The handover alone does not decide it (an
 * ambiguous handover derives no preset, and the operator may change it with
 * `profile-update --preset`), the Folder records it. Undefined wherever there
 * is none: a workstation, another account, a missing or invalid handover, a
 * Folder not initialized or not readable; the command then behaves as it
 * always did. */
export async function hostedEnvironmentPreset(
  hostedFolder: (() => Promise<string | undefined>) | undefined,
): Promise<PresetName | undefined> {
  try {
    const folder = await hostedFolder?.();
    return folder === undefined ? undefined : await folderPreset(folder);
  } catch {
    return undefined;
  }
}

export type GithubRefusal = Readonly<{
  kind: "blocked";
  reason: "team-environment";
  tool: "gh";
  action: GithubAction;
}>;

/** The Team rule of `team-github.ts` applied to one curated action on an
 * Environment of that preset. Only a sign-out of gh on a Team Environment
 * reads gh's sign-in first (one probe), to tell a person's account from the
 * Organization's identity. */
export async function githubRefusal(
  preset: PresetName | undefined,
  tool: string,
  action: GithubAction,
  sessions: Pick<LoginSessions, "ghSignIn">,
): Promise<GithubRefusal | undefined> {
  if (preset === undefined || tool !== "gh") return undefined;
  const brokered =
    workspacePreset(preset).providerIdentity === "brokered-organization";
  const signIn =
    brokered && action === "logout" ? await sessions.ghSignIn() : undefined;
  return githubActionRefused({ brokered, tool, action, signIn })
    ? { kind: "blocked", reason: "team-environment", tool, action }
    : undefined;
}

/** Whether the rule refuses a gh sign-in or key linking on an Environment of
 * that preset now: what a running session asks again before each step that
 * changes the account or the Machine (`LoginEnvironment.refused`). */
export function githubLoginRefused(
  preset: PresetName | undefined,
  tool: string,
  action: "login" | "ssh-key",
): boolean {
  return (
    preset !== undefined &&
    githubActionRefused({
      brokered:
        workspacePreset(preset).providerIdentity === "brokered-organization",
      tool,
      action,
    })
  );
}

/** What a person reads about a refusal. */
export function githubRefusalText(
  refusal: GithubRefusal,
  locale: "cs" | "en",
): string {
  return refusal.action === "logout"
    ? `${teamGithubText[locale]} ${teamGithubLogoutText[locale]}`
    : teamGithubText[locale];
}
