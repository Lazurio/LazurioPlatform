import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { withFolderOperationLock } from "../folder/lock";
import { parseMachineEntry } from "../folder/machine-binding";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState, readStateJson } from "../folder/read-state";
import type { HostedEntry } from "./hosted-trust";

/** The conditions under which the Launchpad cannot start normally and can say
 * why (docs/update.md "Recovery mode", check `start-refused`). The ids are a
 * contract for the health socket, the page and automation: never renamed or
 * reused, and never carrying Folder content or a path.
 */
export const startRefusals = [
  /** The Folder or its state cannot be read by this version: not owned,
   * unknown entries, an unknown key or schema. */
  "folder-state-unreadable",
  /** A profile or tools change was interrupted and is not finished. */
  "folder-transaction-pending",
  /** The Folder's operation lock cannot be taken. */
  "folder-lock-unavailable",
  /** The recorded hosted entry is not one this version accepts. */
  "hosted-entry-invalid",
  /** The page this executable carries does not serve completely. */
  "asset-missing",
] as const;
export type StartRefusal = (typeof startRefusals)[number];

export const isStartRefusal = (value: unknown): value is StartRefusal =>
  (startRefusals as readonly unknown[]).includes(value);

/** A start that stopped on a named condition. `entry` is the recorded hosted
 * entry when it was read and valid, so Recovery mode can answer on the same
 * port behind the same admission; null when it is unknown. */
export class LaunchpadStartRefused extends Error {
  constructor(
    readonly reason: StartRefusal,
    readonly entry: HostedEntry | null = null,
  ) {
    super(`Launchpad start refused: ${reason}`);
  }
}

/** Why the state could not be read, from what is on disk alone, and the
 * recorded hosted entry when it still reads and is valid: a pending
 * transaction, a held lock or a key this version does not know leave the
 * entry readable, and Recovery mode then answers on the gateway's port behind
 * the same admission. Nothing here throws: whatever cannot be told apart is
 * `folder-state-unreadable`. */
async function unreadable(state: string): Promise<LaunchpadStartRefused> {
  let pending = false;
  try {
    pending = (await readdir(state)).includes("transaction");
  } catch {}
  let recorded: unknown;
  try {
    const raw = (await readStateJson(state, "preferences.json")) as {
      machine?: { entry?: unknown } | null;
    } | null;
    recorded = raw?.machine?.entry ?? null;
  } catch {
    recorded = null;
  }
  let entry: HostedEntry | null = null;
  if (recorded !== null)
    try {
      // The recorded entry is the handover's projection (six members, the
      // four hosted admission values among them).
      entry = parseMachineEntry(recorded);
    } catch {
      if (!pending) return new LaunchpadStartRefused("hosted-entry-invalid");
    }
  return new LaunchpadStartRefused(
    pending ? "folder-transaction-pending" : "folder-state-unreadable",
    entry,
  );
}

/** The Folder part of the Launchpad start sequence: the owned Folder, its
 * state and the recorded hosted entry. `locked` takes the Folder's operation
 * lock for the read, as the running Launchpad does; the probe of a candidate
 * reads without it, because taking the lock writes (docs/update.md
 * "Activation"). Throws `LaunchpadStartRefused` and nothing else.
 */
export async function readStartState(
  folder: string,
  options: Readonly<{ locked: boolean }>,
) {
  const state = join(folder, ".lazurio");
  try {
    await inspectOwnedDirectory(folder);
  } catch {
    throw new LaunchpadStartRefused("folder-state-unreadable");
  }
  let readFailed = false;
  const read = () =>
    readFolderState(state).catch((error: unknown) => {
      readFailed = true;
      throw error;
    });
  try {
    const current = options.locked
      ? await withFolderOperationLock(state, read)
      : await read();
    return Object.freeze({
      ...current,
      entry: current.preferences.machine?.entry ?? null,
    });
  } catch {
    const refused = await unreadable(state);
    if (options.locked && !readFailed)
      throw new LaunchpadStartRefused("folder-lock-unavailable", refused.entry);
    throw refused;
  }
}

/** The page and every script and stylesheet it names answer from this
 * executable's bundle. `get` asks the listener that serves the page. */
export async function checkBundledPage(
  get: (path: string) => Promise<Response>,
): Promise<boolean> {
  try {
    const page = await get("/");
    const html = await page.text();
    if (!page.ok || !page.headers.get("content-type")?.includes("text/html"))
      return false;
    const assets = [
      ...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="(\/[^"]*)"/g),
    ].map((match) => match[1] as string);
    for (const path of assets) {
      const asset = await get(path);
      await asset.body?.cancel().catch(() => undefined);
      if (!asset.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}
