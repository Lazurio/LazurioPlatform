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
  type OrganizationSettingsValues,
  organizationSettings,
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
// `failed` with the Folder's reason when it did not (`folder-drift`: someone
// edited the generated files; `folder-busy`: another operation held the
// Folder all along; …): what the Environment cannot apply it reports, and an
// agent can fix it. A key this release does not know is `unsupported`.

export type DeliveredValues = Readonly<{
  values: OrganizationSettingsValues;
  unsupported: readonly string[];
}>;

export type ApplyOutcome = Readonly<{
  items: readonly SettingsItem[];
  /** The Folder was changed (re-rendered). */
  changed: boolean;
}>;

export type ApplyOptions = Readonly<{
  /** Attempts while another operation holds the Folder (default 4). */
  busyAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}>;

/** The keys a section governs. */
function governedKeys(values: OrganizationSettingsValues): string[] {
  const verdict = organizationSettings({ settings: values });
  return verdict.status === "invalid"
    ? []
    : verdict.effective.filter((entry) => entry.governed).map((e) => e.key);
}

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
  let detail: string | null = null;
  let changed = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      previous = await recordedSettings(folder);
      const result = await recordOrganizationSettings(folder, desired);
      if (result.kind === "updated") changed = true;
      else if (result.kind === "blocked") detail = `folder-${result.reason}`;
      break;
    } catch (error) {
      if (error instanceof FolderOperationBusyError && attempt < attempts) {
        await sleep(250 * attempt);
        continue;
      }
      detail =
        error instanceof FolderOperationBusyError
          ? "folder-busy"
          : error instanceof FolderAdoptionError
            ? `folder-${error.code}`
            : "folder-unavailable";
      break;
    }
  }
  const governed = new Set([
    ...governedKeys(desired),
    ...governedKeys(previous),
  ]);
  const items: SettingsItem[] = organizationSettingsKeys
    .filter((key) => governed.has(key))
    .map((key) =>
      Object.freeze({
        key,
        outcome: detail === null ? ("applied" as const) : ("failed" as const),
        detail,
      }),
    );
  for (const key of delivered.unsupported)
    if (isSettingKey(key))
      items.push(Object.freeze({ key, outcome: "unsupported", detail: null }));
  return Object.freeze({ items: Object.freeze(items), changed });
}
