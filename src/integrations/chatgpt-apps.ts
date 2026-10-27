import { join } from "node:path";
import { withFolderReadLock } from "../folder/lock";
import type { PresetName } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import {
  folderOrganizationSettings,
  personalChatgptApps,
} from "../folder/state";
import { updateChatgptApps } from "../folder/update-profile";
import { chatgptAppsPolicyOf } from "../organization-settings/governance";
import {
  type CodexAppsConverged,
  type CodexAppsFacts,
  type CodexAppsInput,
  convergeCodexApps,
  observeCodexApps,
} from "../tools/codex-apps";
import type { ChatgptAppsPolicy } from "./policy";

// "Aplikace z ChatGPT" on one Environment (decision F42's addendum of
// 2026-10-27): what the Folder records decides (the Organization's settings,
// or the person's own choice), and the operator's Codex follows it. One use
// case for the Launchpad (at its start, after the Organization's settings
// changed the Folder and after the person's choice), `lazurio integrations
// chatgpt-apps` and doctor.

/** Where Lazurio keeps the operator's Codex in line with the policy: a Remote
 * Environment, whose operator account Lazurio sets up (as Executor's MCP
 * entry, decision F44). The person's own computer is theirs: its Codex is
 * never changed, and only the Folder's text says what the person chose. */
export const codexKeptHere = (preset: PresetName): boolean =>
  preset !== "local";

export type ChatgptAppsStatus = Readonly<{
  kind: "chatgpt-apps";
  policy: ChatgptAppsPolicy;
  /** How the operator's Codex has them; null where Lazurio does not keep it
   * (`codexKeptHere`). */
  codex: CodexAppsFacts | null;
}>;

/** What the Folder records: the preset and who allows ChatGPT's apps. */
export async function folderChatgptApps(folder: string): Promise<
  Readonly<{
    preset: PresetName;
    revision: number;
    policy: ChatgptAppsPolicy;
  }>
> {
  const state = join(folder, ".lazurio");
  const { preferences } = await withFolderReadLock(state, () =>
    readFolderState(state),
  );
  return Object.freeze({
    preset: preferences.preset.name,
    revision: preferences.revision,
    policy: chatgptAppsPolicyOf(
      preferences.preset.name,
      folderOrganizationSettings(preferences),
      personalChatgptApps(preferences),
    ),
  });
}

// `codex` is the operator's Codex where this process keeps it (a Remote
// Environment's supervised Launchpad, the operator's CLI), null where it does
// not (a development run): then nothing of Codex is read or written.

/** The policy and how Codex has it. Reads only. */
export async function chatgptAppsStatus(
  folder: string,
  codex: CodexAppsInput | null,
): Promise<ChatgptAppsStatus> {
  const { preset, policy } = await folderChatgptApps(folder);
  return Object.freeze({
    kind: "chatgpt-apps" as const,
    policy,
    codex:
      codex !== null && codexKeptHere(preset)
        ? await observeCodexApps(codex)
        : null,
  });
}

/** Brings Codex to the policy where Lazurio keeps it; elsewhere nothing. */
export async function convergeChatgptApps(
  folder: string,
  codex: CodexAppsInput | null,
): Promise<
  Readonly<{
    policy: ChatgptAppsPolicy;
    converged: CodexAppsConverged | null;
  }>
> {
  const { preset, policy } = await folderChatgptApps(folder);
  return Object.freeze({
    policy,
    converged:
      codex !== null && codexKeptHere(preset)
        ? await convergeCodexApps(codex, policy.allowed)
        : null,
  });
}

/** A converge as the item of a settings report (C2): `applied`, or `failed`
 * with Codex's reason (`codex-config-shape`, …). */
export async function chatgptAppsItem(
  folder: string,
  codex: CodexAppsInput | null,
): Promise<Readonly<{ outcome: "applied" | "failed"; detail: string | null }>> {
  const { converged } = await convergeChatgptApps(folder, codex);
  return converged?.kind === "refused"
    ? { outcome: "failed", detail: `codex-${converged.reason}` }
    : { outcome: "applied", detail: null };
}

/** The person's own choice where no Organization governs: recorded in the
 * Folder at its current revision (one more try where another change came
 * between), then Codex follows it where Lazurio keeps it. */
export async function setChatgptApps(
  folder: string,
  allowed: boolean,
  codex: CodexAppsInput | null,
): Promise<
  Readonly<
    | { kind: "updated" | "unchanged"; status: ChatgptAppsStatus }
    | { kind: "blocked"; reason: string }
  >
> {
  for (let attempt = 0; ; attempt += 1) {
    const { revision } = await folderChatgptApps(folder);
    const result = await updateChatgptApps(folder, revision, allowed);
    if (
      result.kind === "blocked" &&
      result.reason === "stale-revision" &&
      attempt === 0
    )
      continue;
    if (result.kind === "blocked")
      return Object.freeze({ kind: "blocked", reason: result.reason });
    await convergeChatgptApps(folder, codex);
    return Object.freeze({
      kind: result.kind,
      status: await chatgptAppsStatus(folder, codex),
    });
  }
}
