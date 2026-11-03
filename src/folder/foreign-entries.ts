import { join } from "node:path";
import { foreignTopLevelEntries } from "./handover-layout";
import { readStateJson } from "./read-state";
import { parseFolderPreferences } from "./state";
import { shownAsItself } from "./visible-text";

/** What a hosted Folder's top level holds beside what the Folder owns, for
 * `lazurio update`, `update status` and `doctor` (decision F10's addendum of
 * 2026-11-03). Since that addendum such an entry no longer stops a refresh;
 * it is reported instead, because work products belong in
 * `~/Documents/<task>/`.
 * - `entries`: a hosted Folder whose top level was listed; the names may be
 *   none.
 * - `not-hosted`: a workstation Folder keeps the person's own top-level files
 *   beside the generated ones, so nothing of it is reported.
 * - `state-unreadable`: the Folder's preferences cannot be read, so whether
 *   it is hosted is unknown; `folder-state` reports that.
 * - `unreadable`: a hosted Folder whose top level cannot be listed: unknown,
 *   never the same answer as a clean Folder (Pablo's review of #817). */
export type ForeignEntriesReading =
  | Readonly<{ kind: "entries"; entries: readonly string[] }>
  | Readonly<{ kind: "not-hosted" }>
  | Readonly<{ kind: "state-unreadable" }>
  | Readonly<{ kind: "unreadable" }>;

/** Stands for a foreign entry whose name is not shown as itself. */
export const unshownEntry = "(an entry whose name cannot be shown)";

/** Reading only: one read of the preferences and the names of the top level,
 * no lock. A name that is not shown as itself, or an absurdly long one, is
 * reported without its text, so the report never prints a terminal escape or
 * a name that reads as another. */
export async function readHostedFolderForeignEntries(
  folder: string,
): Promise<ForeignEntriesReading> {
  let hosted: boolean;
  try {
    const preferences = parseFolderPreferences(
      await readStateJson(join(folder, ".lazurio"), "preferences.json"),
    );
    hosted = preferences.machine !== null;
  } catch {
    return Object.freeze({ kind: "state-unreadable" as const });
  }
  if (!hosted) return Object.freeze({ kind: "not-hosted" as const });
  let names: readonly string[];
  try {
    names = await foreignTopLevelEntries(folder);
  } catch {
    return Object.freeze({ kind: "unreadable" as const });
  }
  return Object.freeze({
    kind: "entries" as const,
    entries: Object.freeze(
      names.map((entry) =>
        entry.length <= 255 && shownAsItself(entry) ? entry : unshownEntry,
      ),
    ),
  });
}

/** The line an agent reads under `lazurio update` and `update status`. The
 * product cannot tell whose an entry is, so the reader decides: their own
 * work moves to `~/Documents/<task>/`, anyone else's stays where it is and
 * the user hears about it; one list may hold both. */
export const foreignEntriesText = (
  folder: string,
  entries: readonly string[],
) =>
  `${folder} holds ${entries.join(", ")} at its top level, which the Folder does not own. It no longer stops updates. Work products belong in ~/Documents/<task>/: move there only what is your own, and leave anyone else's where it is and tell the user about it.`;

/** The line when a hosted Folder's top level could not be listed. */
export const foreignEntriesUnreadableText = (folder: string) =>
  `${folder}: its top level could not be listed, so whether it holds entries the Folder does not own is unknown.`;
