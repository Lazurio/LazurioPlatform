import { readFolderTools } from "./inspect-tools-change";
import { FolderOperationBusyError } from "./lock";
import { updateTools } from "./update-profile";

/** What became of one tool's "Používají agenti": switched on now (at the
 * revision it produced), on already, or refused as the switch would be,
 * with the Folder's reason. */
export type AgentsSwitch =
  | Readonly<{ kind: "enabled"; revision: number }>
  | Readonly<{ kind: "on" }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** "Používají agenti" on for one catalog tool in one Folder, at its current
 * revision: the change the switch itself makes, refused as the switch is
 * where this Environment does not offer the tool (decision F44) or its
 * Organization does not allow it (F45). A Folder that another change holds
 * or changed meanwhile is read again, as the Organization's settings are
 * applied (src/organization-settings/apply.ts); anything else throws. */
export async function enableToolForAgents(
  folder: string,
  name: string,
): Promise<AgentsSwitch> {
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const recorded = await readFolderTools(folder);
      if (recorded.enabled.includes(name)) return { kind: "on" };
      const result = await updateTools(
        folder,
        recorded.revision,
        [...recorded.enabled, name].sort(),
      );
      if (result.kind === "updated")
        return { kind: "enabled", revision: result.revision };
      if (result.kind === "unchanged") return { kind: "on" };
      if (result.reason !== "stale-revision" || attempt >= attempts)
        return { kind: "refused", reason: result.reason };
    } catch (error) {
      if (!(error instanceof FolderOperationBusyError) || attempt >= attempts)
        throw error;
    }
    await Bun.sleep(250 * attempt);
  }
}
