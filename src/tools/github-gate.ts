import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import {
  githubIdentity,
  type PresetName,
  workspacePreset,
} from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import type { EntryAudience } from "../launchpad/public-environment";
import type { LoginSessions } from "./login";
import {
  type GithubAction,
  githubActionRefused,
  githubRuleText,
  publicGithubLogoutText,
  teamGithubLogoutText,
} from "./team-github";

/** The recorded preset of one Folder and, where its recorded entry says so,
 * that it is a public Environment (decision F55), read under the common
 * lock. */
async function folderEnvironment(
  folder: string,
): Promise<Readonly<{ preset: PresetName; audience?: EntryAudience }>> {
  await inspectOwnedDirectory(folder);
  const stateDirectory = join(folder, ".lazurio");
  return withFolderReadLock(stateDirectory, async () => {
    const { preferences } = await readFolderState(stateDirectory);
    const preset = preferences.preset.name;
    return githubIdentity(preset, preferences.machine) === "none"
      ? { preset, audience: "public" }
      : { preset };
  });
}

/** The recorded preset of one Folder, read under the common lock: what the
 * Launchpad serving that Folder decides the kind of Environment by. */
export async function folderPreset(folder: string): Promise<PresetName> {
  return (await folderEnvironment(folder)).preset;
}

/** A hosted context that is there but cannot be read: the handover or the
 * operator's account (`handover`), or the declared Folder, its state or its
 * preferences (`folder`), or a hosted Folder found earlier in the same
 * command that is no longer found (`lost`). Never a workstation (#83). */
export class HostedEnvironmentUnreadable extends Error {
  constructor(public readonly source: "handover" | "folder" | "lost") {
    super(`hosted-environment-unreadable:${source}`);
  }
}

/** The kind of Environment a command without `--folder` runs in: on a hosted
 * Machine, the recorded preset of the declared operator's Folder, found from
 * the root-issued handover exactly as `lazurio update` finds it
 * (`hostedOperatorFolder`). The handover alone does not decide it (an
 * ambiguous handover derives no preset, and the operator may change it with
 * `profile-update --preset`), the Folder records it. Undefined only where
 * there positively is none: no seam, a workstation, another account. A
 * hosted context that is there but cannot be read — the seam rejects, the
 * declared Folder is missing, its state or preferences are missing or
 * malformed, its lock stays busy — rejects with `HostedEnvironmentUnreadable`
 * (#83): the caller decides, and a gate refuses. */
export async function hostedEnvironmentPreset(
  hostedFolder: (() => Promise<string | undefined>) | undefined,
): Promise<PresetName | undefined> {
  return (await hostedFolderEnvironment(hostedFolder))?.preset;
}

/** `hostedEnvironmentPreset` with the audience of the recorded entry. */
async function hostedFolderEnvironment(
  hostedFolder: (() => Promise<string | undefined>) | undefined,
): Promise<Awaited<ReturnType<typeof folderEnvironment>> | undefined> {
  let folder: string | undefined;
  try {
    folder = await hostedFolder?.();
  } catch {
    throw new HostedEnvironmentUnreadable("handover");
  }
  if (folder === undefined) return undefined;
  try {
    return await folderEnvironment(folder);
  } catch {
    throw new HostedEnvironmentUnreadable("folder");
  }
}

/** The kind of Environment as one command sees it, read again on request;
 * `audience` only on a public Environment, which says so in its wording. */
export type HostedEnvironment =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "hosted"; preset: PresetName; audience?: EntryAudience }>
  | Readonly<{
      kind: "unreadable";
      source: HostedEnvironmentUnreadable["source"];
    }>;

/** The reads of one command: the first, and each later one a running login
 * asks before a step that changes the account or the Machine. Once a hosted
 * Folder was found, a later read that finds none is `unreadable` (`lost`),
 * never a workstation: a context cannot turn into none while a command runs. */
export function hostedEnvironmentReader(
  hostedFolder: (() => Promise<string | undefined>) | undefined,
): () => Promise<HostedEnvironment> {
  let hosted = false;
  return async () => {
    try {
      const found = await hostedFolderEnvironment(hostedFolder);
      if (found !== undefined) {
        hosted = true;
        return Object.freeze({ kind: "hosted" as const, ...found });
      }
      return hosted
        ? Object.freeze({
            kind: "unreadable" as const,
            source: "lost" as const,
          })
        : Object.freeze({ kind: "none" as const });
    } catch (error) {
      if (!(error instanceof HostedEnvironmentUnreadable)) throw error;
      if (error.source === "folder") hosted = true;
      return Object.freeze({
        kind: "unreadable" as const,
        source: error.source,
      });
    }
  };
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

/** What a person reads about a refusal; on a public Environment it says
 * that there is no GitHub identity rather than Lazurio for GitHub. */
export function githubRefusalText(
  refusal: GithubRefusal,
  locale: "cs" | "en",
  audience?: EntryAudience,
): string {
  const isPublic = audience === "public";
  const rule = githubRuleText(isPublic)[locale];
  return refusal.action === "logout"
    ? `${rule} ${(isPublic ? publicGithubLogoutText : teamGithubLogoutText)[locale]}`
    : rule;
}
