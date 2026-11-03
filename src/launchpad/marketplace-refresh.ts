import type { MarketplaceCatalog } from "./marketplace";

// How the open Marketplace page keeps its offers current (plan DEV-6593,
// docs/marketplace.md): it reads the Launchpad's answer (`POST
// /api/marketplace`) each time the page is entered, again every
// `pageInterval` while it stays open, a failed read after `pageRetry`, and,
// when the answer says the Launchpad is asking the registry right now,
// once more after `pageSettle`, past that question's 10 s. The Launchpad
// itself asks the registry at most hourly; these reads are what bring the
// outcome of that question to a page that is already open, or was opened
// on the kept index while the question ran. No DOM here, so the tests drive
// it with their own timers.

/** While the page stays open, how often it reads the offers again. */
export const pageInterval = 5 * 60 * 1000;
/** How soon a failed read is tried again while the page is open. */
export const pageRetry = 30 * 1000;
/** How soon the page reads again after an answer given while the registry
 * was being asked. */
export const pageSettle = 12 * 1000;

/** The Launchpad's answer: the catalog and whether the registry is being
 * asked right now. */
export type MarketplaceAnswer = MarketplaceCatalog &
  Readonly<{ checking?: boolean }>;

export type RefreshTimers = Readonly<{
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}>;

const browserTimers: RefreshTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Two answers show the same offers when they come from the same source at
 * the same commit: an index at a commit never changes. */
export const sameCatalog = (
  left: MarketplaceCatalog,
  right: MarketplaceCatalog,
): boolean => left.source === right.source && left.commit === right.commit;

export function createMarketplaceRefresh(
  options: Readonly<{
    load: () => Promise<MarketplaceAnswer | null>;
    /** A read ended: the offers now shown and whether they changed, or null
     * when it failed (what was shown stays). */
    answered: (catalog: MarketplaceCatalog | null, changed: boolean) => void;
    timers?: RefreshTimers;
  }>,
) {
  const timers = options.timers ?? browserTimers;
  let shown: MarketplaceCatalog | null = null;
  let open = false;
  let timer: unknown = null;
  let reading: Promise<MarketplaceCatalog | null> | null = null;

  function stop() {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  function schedule(ms: number) {
    stop();
    if (!open) return;
    timer = timers.set(() => {
      timer = null;
      void read();
    }, ms);
  }

  /** Reads the offers now (one read at a time); null when it failed. */
  function read(): Promise<MarketplaceCatalog | null> {
    if (reading !== null) return reading;
    stop();
    reading = options
      .load()
      .catch(() => null)
      .then((answer) => {
        reading = null;
        if (answer === null) {
          options.answered(null, false);
          schedule(pageRetry);
          return null;
        }
        const { checking, ...catalog } = answer;
        const changed = shown === null || !sameCatalog(shown, catalog);
        if (changed) shown = catalog;
        options.answered(shown, changed);
        schedule(checking === true ? pageSettle : pageInterval);
        return shown;
      });
    return reading;
  }

  return {
    /** The page is shown: entered or entered again, it reads at once. */
    enter() {
      if (open) return;
      open = true;
      void read();
    },
    /** The page is left: nothing more is read until it is entered again. */
    leave() {
      open = false;
      stop();
    },
    /** The page is visible again after it was hidden: read at once. */
    wake() {
      if (open) void read();
    },
    read,
  };
}
