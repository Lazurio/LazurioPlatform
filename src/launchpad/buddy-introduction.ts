import {
  type BuddyReading,
  buddyIntroductionDue,
  type IntroducedStorage,
  introducedIn,
  keepIntroduced,
} from "./buddy-view";

// Buddy GEN4's introduction, offered by itself (the guide to Buddy,
// 2026-11-21): a person who met him before it existed, moved over from the
// older Buddy, sees it once, as a tour of his beats that ends in his window.
// The page asks again whenever something it waits for may have changed: a
// redraw (firstRun), the tour of Lazurio moved on (its last step), a dialog
// opened or closed. It opens only once its mark is kept in this browser for
// the Environment (as the tour of Lazurio keeps its progress): a storage that
// refuses or drops the write gets no introduction by itself rather than one
// at every redraw, and within this page it never comes twice. Nastavení →
// Buddy plays it on request regardless. The DOM stays in ui.ts.

export type BuddyIntroductionSeams = Readonly<{
  /** Whether this page shows Buddy at all (framed, with Buddy). */
  here: () => boolean;
  reading: () => BuddyReading | null;
  /** The tour of Lazurio seen to its end; null while not known. */
  toured: () => boolean | null;
  dialogOpen: () => boolean;
  /** The Environment's id, the mark's key; null until known. */
  environment: () => string | null;
  /** This browser's storage; null where the page has none. */
  storage: () => IntroducedStorage | null;
  /** Opens the introduction as a tour. */
  open: () => void;
}>;

export function createBuddyIntroduction(seams: BuddyIntroductionSeams) {
  let here = false;

  function introduced(): boolean | null {
    if (here) return true;
    const environment = seams.environment();
    const storage = seams.storage();
    if (environment === null || storage === null) return null;
    return introducedIn(storage, environment);
  }

  /** Keeps that it was seen (also for a tour the person asked for); true
   * once the mark reads back. */
  function keep(): boolean {
    here = true;
    const environment = seams.environment();
    const storage = seams.storage();
    if (environment === null || storage === null) return false;
    return keepIntroduced(storage, environment);
  }

  /** Opens it now if it is due and its mark can be kept. */
  function offer(): boolean {
    if (!seams.here()) return false;
    if (
      !buddyIntroductionDue({
        reading: seams.reading(),
        toured: seams.toured(),
        dialogOpen: seams.dialogOpen(),
        introduced: introduced(),
      })
    )
      return false;
    // Its mark first: where it cannot be kept, it does not open by itself.
    if (!keep()) return false;
    seams.open();
    return true;
  }

  return Object.freeze({ offer, keep });
}
