import { join } from "node:path";
import { foreignTopLevelEntries } from "./handover-layout";
import { readStateJson } from "./read-state";
import { parseFolderPreferences } from "./state";
import { shownAsItself } from "./visible-text";

/** The top-level entries of a hosted Folder that the Folder does not own,
 * for `lazurio update`, `update status` and `doctor` (decision F10's
 * addendum of 2026-11-03). Since that addendum such an entry no longer stops
 * a refresh; it is reported instead, because work products belong in
 * `~/Documents/<task>/`. A workstation Folder keeps the person's own
 * top-level files beside the generated ones, so it reports nothing. Reading
 * only: one read of the preferences and the names of the top level, no lock;
 * a Folder that cannot be read reports nothing. */
export async function hostedFolderForeignEntries(
  folder: string,
): Promise<readonly string[]> {
  try {
    const preferences = parseFolderPreferences(
      await readStateJson(join(folder, ".lazurio"), "preferences.json"),
    );
    if (preferences.machine === null) return Object.freeze([]);
    // A name that is not shown as itself, or an absurdly long one, is
    // reported without its text, so the report never prints a terminal
    // escape or a name that reads as another.
    return Object.freeze(
      (await foreignTopLevelEntries(folder)).map((entry) =>
        entry.length <= 255 && shownAsItself(entry) ? entry : unshownEntry,
      ),
    );
  } catch {
    return Object.freeze([]);
  }
}

/** Stands for a foreign entry whose name is not shown as itself. */
export const unshownEntry = "(an entry whose name cannot be shown)";

/** The line an agent reads under `lazurio update` and `update status`. */
export const foreignEntriesText = (
  folder: string,
  entries: readonly string[],
) =>
  `${folder} holds ${entries.join(", ")} at its top level, which the Folder does not own. It no longer stops updates, but work products belong in ~/Documents/<task>/: move ${entries.length === 1 ? "it" : "them"} there.`;
