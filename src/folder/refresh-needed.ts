import { join } from "node:path";
import { readStateJson } from "./read-state";
import { isOlderTemplateRevision } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

/** "Folder refresh needed" (F17's addenda of 2026-09-28 and 2026-10-30): the
 * Folder's generated files stay at the template revision that rendered them
 * until the one change path re-renders them, and `lazurio update` runs that
 * refresh itself (`src/update/folder-refresh.ts`). This says whether one is
 * needed and which command performs it. Reading only: two plain reads of the
 * state documents, no lock, no write; anything that cannot be read is
 * "nothing needed", never a failure of the command that asked.
 */
export type FolderRefresh = Readonly<{
  folder: string;
  /** Template revision the Folder records. */
  recorded: string;
  /** Template revision the product renders. */
  product: string;
}>;

export type NeededRefresh = Readonly<{
  refresh: FolderRefresh;
  /** The arguments after the executable of the command that re-renders the
   * Folder with its recorded choices. */
  command: readonly string[];
}>;

// A path survives a POSIX shell unchanged: bare when it is plain, otherwise
// in single quotes.
export const shellWord = (word: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;

/** The Folder whose generated files an older template revision than
 * `productRevision` rendered, and the refresh that re-renders it, or null.
 * The declared operator's Folder of a hosted Machine is refreshed from its
 * handover (`machine folder-refresh`, which also records what the handover
 * changed); every other Folder by applying its recorded profile unchanged at
 * its current revision, which the one planner turns into the same template
 * upgrade (F14). `operatorFolder` is that Folder's path when this is a
 * hosted Machine. */
export async function neededRefresh(
  folder: string,
  productRevision: string,
  operatorFolder: string | undefined,
): Promise<NeededRefresh | null> {
  try {
    const state = join(folder, ".lazurio");
    const manifest = parseInstructionManifest(
      await readStateJson(state, "instructions.json"),
    );
    if (!isOlderTemplateRevision(manifest.templateRevision, productRevision))
      return null;
    const preferences = parseFolderPreferences(
      await readStateJson(state, "preferences.json"),
    );
    const { profile } = preferences;
    return Object.freeze({
      refresh: Object.freeze({
        folder,
        recorded: manifest.templateRevision,
        product: productRevision,
      }),
      command: Object.freeze(
        preferences.machine !== null && operatorFolder === folder
          ? ["machine", "folder-refresh"]
          : [
              "profile-update",
              "--folder",
              folder,
              "--expected-revision",
              String(preferences.revision),
              "--access",
              profile.access,
              "--purpose",
              profile.purpose,
              "--locale",
              profile.locale,
              "--detail",
              profile.detail,
              "--coordination",
              profile.coordination,
            ],
      ),
    });
  } catch {
    return null;
  }
}

/** Whether a refresh is needed, as `lazurio update status` and `lazurio
 * doctor` report it. */
export async function folderRefreshNeeded(
  folder: string,
  productRevision: string,
): Promise<FolderRefresh | null> {
  return (
    (await neededRefresh(folder, productRevision, undefined))?.refresh ?? null
  );
}

/** The line an agent reads under `lazurio update status`. */
export const folderRefreshText = (refresh: FolderRefresh) =>
  `Folder refresh needed: ${refresh.folder} was rendered by ${refresh.recorded}, Lazurio renders ${refresh.product}. lazurio update --folder ${shellWord(refresh.folder)} refreshes it and names anything that blocks it.`;
