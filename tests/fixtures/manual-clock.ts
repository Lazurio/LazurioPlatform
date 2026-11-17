// A clock a test moves by hand, with the timers that follow it: `advance`
// moves the time and runs every timer that falls due on the way, in order,
// each at exactly its own time. Nothing runs by itself.

export type ManualClock = Readonly<{
  now: () => number;
  /** Runs `run` once the clock reaches `ms` from now; the answer cancels
   * it. */
  setTimer: (run: () => void, ms: number) => () => void;
  advance: (ms: number) => void;
  /** The times the pending timers fall due at. */
  pending: () => readonly number[];
}>;

export function manualClock(start = 1_000_000): ManualClock {
  let at = start;
  let next = 0;
  let timers: { id: number; due: number; run: () => void }[] = [];
  return Object.freeze({
    now: () => at,
    setTimer: (run: () => void, ms: number) => {
      const id = next++;
      timers.push({ id, due: at + Math.max(0, ms), run });
      return () => {
        timers = timers.filter((timer) => timer.id !== id);
      };
    },
    advance: (ms: number) => {
      const until = at + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.due <= until)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (due === undefined) break;
        timers = timers.filter((timer) => timer.id !== due.id);
        at = due.due;
        due.run();
      }
      at = until;
    },
    pending: () => timers.map((timer) => timer.due).sort((a, b) => a - b),
  });
}
