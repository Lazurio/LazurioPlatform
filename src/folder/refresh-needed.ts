import { join } from "node:path";
import type { FolderProfile } from "./profile";
import { readStateJson } from "./read-state";
import { isOlderTemplateRevision } from "./render";
import { parseFolderPreferences, parseInstructionManifest } from "./state";

/** "Folder refresh needed" (F17 addendum 2026-09-28): the operator updates
 * Lazurio, and a product update never writes the Folder (F14), so the
 * Folder's generated files stay at the template revision that rendered them
 * until an explicit refresh. This names that refresh with its exact command.
 * Reporting only: two plain reads of the state documents, no lock, no write;
 * anything that cannot be read is "nothing to report", never a failure of
 * the command that asked.
 */
export type FolderRefresh = Readonly<{
  folder: string;
  /** Template revision the Folder records. */
  recorded: string;
  /** Template revision the product renders. */
  product: string;
  /** The one command that re-renders the generated files. */
  command: string;
}>;

// A path survives a POSIX shell unchanged: bare when it is plain, otherwise
// in single quotes.
export const shellWord = (word: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;

/** A hosted Folder is refreshed from its handover; a workstation Folder by
 * applying its recorded profile unchanged at its current revision, which the
 * one planner turns into the same template upgrade (F14). */
function refreshCommand(
  folder: string,
  revision: number,
  hosted: boolean,
  profile: FolderProfile,
): string {
  if (hosted) return "lazurio machine folder-refresh";
  return [
    "lazurio profile-update",
    `--folder ${shellWord(folder)}`,
    `--expected-revision ${revision}`,
    `--access ${profile.access}`,
    `--purpose ${profile.purpose}`,
    `--locale ${profile.locale}`,
    `--detail ${profile.detail}`,
    `--coordination ${profile.coordination}`,
  ].join(" ");
}

export async function folderRefreshNeeded(
  folder: string,
  productRevision: string,
): Promise<FolderRefresh | null> {
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
    return Object.freeze({
      folder,
      recorded: manifest.templateRevision,
      product: productRevision,
      command: refreshCommand(
        folder,
        preferences.revision,
        preferences.machine !== null,
        preferences.profile,
      ),
    });
  } catch {
    return null;
  }
}

/** The line a person reads under an update result or status. */
export const folderRefreshText = (refresh: FolderRefresh) =>
  `Folder refresh needed: ${refresh.folder} was rendered by ${refresh.recorded}, Lazurio renders ${refresh.product}. Run: ${refresh.command}`;
