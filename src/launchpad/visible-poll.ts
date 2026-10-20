// A read the page repeats on a timer, only while the page is shown (root
// decision 0195, plan DEV-6656): a tab left in the background asks the
// Launchpad nothing; shown again, it reads at once and the timer starts over.
// A read still running is never started a second time beside it.

/** What the poll needs of the page: whether it is shown, and when that
 * changes. `document` is one. */
export type PageVisibility = Readonly<{
  visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}>;

/** The repeating timer: `setInterval` and `clearInterval` in the page. */
export type PollTimers = Readonly<{
  every(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}>;

const pageTimers: PollTimers = {
  every: (callback, ms) => setInterval(callback, ms),
  cancel: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
};

/** Reads now when the page is shown, then every `everyMs` while it stays
 * shown. Answers the stop: no read and no timer after it. */
export function pollWhileVisible(
  read: () => Promise<void>,
  everyMs: number,
  page: PageVisibility = document,
  timers: PollTimers = pageTimers,
): () => void {
  let timer: unknown;
  let running = false;
  let stopped = false;
  const once = () => {
    if (running || stopped) return;
    running = true;
    void read()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  const follow = () => {
    if (timer !== undefined) timers.cancel(timer);
    timer = undefined;
    if (stopped || page.visibilityState !== "visible") return;
    once();
    timer = timers.every(once, everyMs);
  };
  page.addEventListener("visibilitychange", follow);
  follow();
  return () => {
    stopped = true;
    page.removeEventListener("visibilitychange", follow);
    if (timer !== undefined) timers.cancel(timer);
    timer = undefined;
  };
}
