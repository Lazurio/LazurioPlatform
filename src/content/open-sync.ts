import type { Catalog } from "../organizations/catalog";
import type { SyncEntry, SyncRequest, SyncRun } from "./sync";

// The Open of one module (root decision 0212 point 4, decision F9's second
// amendment of 2026-10-24): after the Launchpad answered a person's Start or
// Open, or the gateway's `ensure` of a navigation, the module's own checkout
// is kept on its published branch in the background, so that a publication
// reaches it without waiting for the hourly round. The answer never waits
// for it: the current build opens at once, and a newer commit the
// synchronization brings is built and swapped in by the Launchpad's build
// watcher (decision F58 point 7). At most once per module within
// `openSyncEveryMs`, and never for a module whose checkout, or whose
// Organization root, the last synchronization left blocked: the hourly round
// tries those again. The same core (`syncContent` with `repository`), the same
// content lock and record; nothing where this Environment keeps no content
// (the core answers `not-allowed` before it reads anything).

/** One Open per module and 5 minutes at most. */
export const openSyncEveryMs = 5 * 60_000;

/** A module of an Organization, as the synchronization names it. */
export type OpenedModule = Readonly<{
  /** The Organization's GitHub login. */
  organization: string;
  /** Its root, relative to the Folder (`organizations/<directory>`). */
  root: string;
  /** The module, relative to the root (`workspace/<module>`). */
  path: string;
}>;

/** The module an answer of the module routes names (its Organization's slug
 * and its id), as the synchronization names it: through the catalog, by the
 * Organization's GitHub login. Null for the Personalspace, an Organization
 * without a GitHub binding, or a slug more than one root claims. */
export function openedModule(
  catalog: Catalog,
  answer: Readonly<{ organization: string; module: string }>,
): OpenedModule | null {
  const groups = catalog.organizations.filter(
    (group) => group.organization === answer.organization,
  );
  const [group] = groups;
  if (groups.length !== 1 || group?.forgeLogin === undefined) return null;
  const module = group.modules.find((entry) => entry.module === answer.module);
  return module === undefined
    ? null
    : Object.freeze({
        organization: group.forgeLogin,
        root: `organizations/${group.directory}`,
        path: module.path,
      });
}

export function createOpenSync(
  input: Readonly<{
    sync: (request: SyncRequest) => Promise<SyncRun>;
    /** The last recorded answers (`readSyncRecord`); null when none. */
    record: () => Promise<readonly SyncEntry[] | null>;
    /** Test seams. */
    now?: () => number;
    everyMs?: number;
  }>,
) {
  const now = input.now ?? Date.now;
  const everyMs = input.everyMs ?? openSyncEveryMs;
  const last = new Map<string, number>();
  const running = new Set<Promise<void>>();

  const blocked = (
    entries: readonly SyncEntry[] | null,
    module: OpenedModule,
  ) =>
    entries?.some(
      (entry) =>
        entry.result === "blocked" &&
        entry.organization.toLowerCase() ===
          module.organization.toLowerCase() &&
        entry.root === module.root &&
        (entry.path === "." || entry.path === module.path),
    ) === true;

  return Object.freeze({
    /** The module was opened: its synchronization in the background, when
     * due. Returns at once. */
    opened(module: OpenedModule): void {
      const key = `${module.organization.toLowerCase()}\0${module.root}\0${module.path}`;
      const at = now();
      const before = last.get(key);
      if (before !== undefined && at - before < everyMs) return;
      last.set(key, at);
      const work = (async () => {
        if (blocked(await input.record().catch(() => null), module)) return;
        await input.sync({
          organization: module.organization,
          repository: module.path,
        });
      })()
        .catch(() => undefined)
        .finally(() => running.delete(work));
      running.add(work);
    },
    /** Resolves when no synchronization of an Open runs (tests, shutdown). */
    async settled(): Promise<void> {
      while (running.size > 0) await Promise.all([...running]);
    },
  });
}

export type OpenSync = ReturnType<typeof createOpenSync>;
