import { join } from "node:path";
import { FolderAdoptionError } from "../folder/handover-layout";
import {
  FolderOperationBusyError,
  withFolderOperationLock,
} from "../folder/lock";
import { readFolderState } from "../folder/read-state";
import { folderOrganizationSettings } from "../folder/state";
import { recordOrganizationSettings } from "../folder/update-profile";
import {
  governedSettingKeys,
  microsoft365SettingKeys,
  type OrganizationSettingsValues,
  organizationSettingsKeys,
} from "../organizations/organization-settings";
import { isSettingKey, type SettingsItem } from "./contract";
import { canonicalSettings } from "./governance";

// Root decision 0194 point 4, decision F45: the Environment applies its
// Organization's settings itself, safely again and again, and says how each
// turned out. Applying is recording them in the Folder (one transaction,
// recovery `profile-resume`), which renders what they allow; Settings,
// Integrace and `lazurio tools` act on what the Folder records.
//
// Each known setting the Organization governs now, or governed before
// (so that lifting it is said too), is `applied` when the Folder took it and
// `failed` with the Folder's reason when it did not: what the Environment
// cannot apply it reports, and an agent can fix it. A key this release does
// not know is `unsupported`.
//
// How the Folder answered decides what the poller records. The Folder took
// the settings (`applied`), or refused them with its reason (`refused`; for
// instance `folder-drift`: someone edited the generated files): the version
// is processed and its items say how. Or the Folder gave no answer
// (`unanswered`; `folder-busy`: another operation held it all along;
// `folder-unavailable`: its state or transaction could not be read or
// written): nothing new applied, so the version applied before stays.

export type DeliveredValues = Readonly<{
  values: OrganizationSettingsValues;
  unsupported: readonly string[];
}>;

export type FolderAnswer = "applied" | "refused" | "unanswered";

export type ApplyOutcome = Readonly<{
  folder: FolderAnswer;
  /** Why the Folder did not take the settings, a detail code; null when it
   * did. */
  reason: string | null;
  items: readonly SettingsItem[];
  /** The Folder was changed (re-rendered). */
  changed: boolean;
}>;

export type ApplyOptions = Readonly<{
  /** Attempts while another operation holds the Folder (default 4). */
  busyAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Applies the Microsoft 365 company app to the Environment's Executor
   * once the Folder took the settings (decision F42 addendum (c) of
   * 2026-10-14): its outcome is the item `integrations.microsoft365`. Without
   * it, the Folder's answer alone says how that item turned out. */
  microsoft365?: (
    setting: NonNullable<
      NonNullable<OrganizationSettingsValues["integrations"]>["microsoft365"]
    >,
  ) => Promise<
    Readonly<{ outcome: "applied" | "failed"; detail: string | null }>
  >;
  /** Brings the operator's Codex to what the Folder now records of the
   * ChatGPT account's apps (decision F42's addendum of 2026-10-27), once the
   * Folder took the settings, governed or not (absent is off): its outcome
   * is the item `integrations.chatgpt_apps.allowed` where the Organization
   * governs it. Without it, the Folder's answer alone says how that item
   * turned out. */
  chatgptApps?: () => Promise<
    Readonly<{ outcome: "applied" | "failed"; detail: string | null }>
  >;
}>;

/** The keys a section governs. */
const governedKeys = (values: OrganizationSettingsValues): readonly string[] =>
  governedSettingKeys(values);

async function recordedSettings(
  folder: string,
): Promise<OrganizationSettingsValues> {
  const state = join(folder, ".lazurio");
  return withFolderOperationLock(state, async () =>
    folderOrganizationSettings((await readFolderState(state)).preferences),
  );
}

export async function applyOrganizationSettings(
  folder: string,
  delivered: DeliveredValues,
  options: ApplyOptions = {},
): Promise<ApplyOutcome> {
  const attempts = Math.max(1, options.busyAttempts ?? 4);
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const desired = canonicalSettings(delivered.values);
  let previous: OrganizationSettingsValues = {};
  let folderAnswer: FolderAnswer = "applied";
  let detail: string | null = null;
  let changed = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      previous = await recordedSettings(folder);
      const result = await recordOrganizationSettings(folder, desired);
      if (result.kind === "updated") changed = true;
      else if (result.kind === "blocked") {
        folderAnswer = "refused";
        detail = `folder-${result.reason}`;
      }
      break;
    } catch (error) {
      if (error instanceof FolderOperationBusyError && attempt < attempts) {
        await sleep(250 * attempt);
        continue;
      }
      // A Folder that cannot be adopted says why; any other failure (busy
      // all along, state or transaction unreadable, I/O) is no answer.
      if (error instanceof FolderAdoptionError) {
        folderAnswer = "refused";
        detail = `folder-${error.code}`;
      } else {
        folderAnswer = "unanswered";
        detail =
          error instanceof FolderOperationBusyError
            ? "folder-busy"
            : "folder-unavailable";
      }
      break;
    }
  }
  const governed = new Set([
    ...governedKeys(desired),
    ...governedKeys(previous),
  ]);
  // The company app lives in Executor too: once the Folder took the
  // settings, it is applied there, and that says how its item turned out.
  const microsoft365 = desired.integrations?.microsoft365;
  const executor =
    detail === null && microsoft365 !== undefined && options.microsoft365
      ? await options.microsoft365(microsoft365).catch(() => ({
          outcome: "failed" as const,
          detail: "executor-failed",
        }))
      : null;
  // So do ChatGPT's apps, in the operator's Codex.
  const codex =
    detail === null && options.chatgptApps
      ? await options.chatgptApps().catch(() => ({
          outcome: "failed" as const,
          detail: "codex-failed",
        }))
      : null;
  const items: SettingsItem[] = organizationSettingsKeys
    .filter((key) => governed.has(key))
    .map((key) =>
      Object.freeze(
        executor !== null &&
          (microsoft365SettingKeys as readonly string[]).includes(key)
          ? { key, outcome: executor.outcome, detail: executor.detail }
          : codex !== null && key === "integrations.chatgpt_apps.allowed"
            ? { key, outcome: codex.outcome, detail: codex.detail }
            : {
                key,
                outcome:
                  detail === null ? ("applied" as const) : ("failed" as const),
                detail,
              },
      ),
    );
  for (const key of delivered.unsupported)
    if (isSettingKey(key))
      items.push(Object.freeze({ key, outcome: "unsupported", detail: null }));
  return Object.freeze({
    folder: folderAnswer,
    reason: detail,
    items: Object.freeze(items),
    changed,
  });
}
