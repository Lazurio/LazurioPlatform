import {
  readToolsLive,
  type ToolsEnvironment,
  type ToolsLive,
} from "../tools/overview";

// The tools' live facts as this Launchpad last read them (root decision 0195,
// plan DEV-6656). Every page load reads Settings → Nástroje once with the
// sign-ins, and each switch between Chat, Apps and Automate loads a page:
// that ran every found tool's version command and every installed tool's
// sign-in probe: more than a second, a process per tool and another per
// sign-in, and calls to the providers, on every load. So a reading answers
// the reads that follow it for a minute as current.
//
// After that minute a read that accepts it (`allowStale`, the page's first
// reading) is answered at once from the last reading, marked stale, while a
// new reading runs behind it; the page shows it as being checked and asks
// again, and that read shares the new reading. The Launchpad also reads the
// tools on its own when it starts and when its page is opened (`warm`), so
// the first open seldom waits for a reading at all.
//
// What changes the facts through this Launchpad drops the reading as it
// starts and again once it has ended (an installation, an update, a sign-in
// or sign-out, a setup: `forget`), so a reading made while it ran is never
// answered after it, not even as stale, and an answer given before it says
// it is no longer `current`, for its route to read again; a person's own
// "Refresh status" or "Zkontrolovat znovu" reads anew (`fresh`). Only a change made elsewhere, a
// tool installed or signed in from a terminal, can wait up to that minute to
// show as current, or show as stale until the reading behind it ends.

/** How long a reading answers the reads that do not ask for a fresh one as
 * current, counted from when it started. */
export const toolsKeptMs = 60_000;

/** A read's answer: whether it is the last reading answered at once while a
 * new one runs (`stale`), the live facts it answers with, and whether they
 * are still the latest facts (`current`): false once something changed them
 * through this Launchpad (`forget`) after the read was answered, even while
 * its reading still ran, so a reading under way through a sign-in, link or
 * sign-out is never taken for the facts after it (Pablo's review of #524). */
export type ToolsAnswer = Readonly<{
  stale: boolean;
  done: Promise<ToolsLive>;
  current: () => boolean;
}>;

export function createToolsReading(
  environment: ToolsEnvironment,
  options: Readonly<{
    keepMs?: number;
    now?: () => number;
    read?: (signIn: boolean) => Promise<ToolsLive>;
  }> = {},
) {
  const keepMs = options.keepMs ?? toolsKeptMs;
  const now = options.now ?? Date.now;
  const read =
    options.read ?? ((signIn: boolean) => readToolsLive(environment, signIn));
  type Reading = Readonly<{ signIn: boolean; at: number }>;
  type Running = Reading &
    Readonly<{ generation: number; done: Promise<ToolsLive> }>;
  let kept: (Reading & Readonly<{ order: number; live: ToolsLive }>) | null =
    null;
  let running: Running | null = null;
  // A forget while a reading runs makes its answer stale: it answers its own
  // read, and is not kept.
  let generation = 0;
  // The order the readings started in, strictly: two may start within one
  // tick of the clock, and only a later one may replace the one kept, so an
  // older reading that ends last never displaces a newer one already kept.
  let started = 0;
  const has = (reading: Reading, signIn: boolean) => reading.signIn || !signIn;
  const current = (reading: Reading, signIn: boolean) =>
    has(reading, signIn) && now() - reading.at < keepMs;
  // The reading running now, when it may answer a read of `signIn`.
  const shared = (signIn: boolean) =>
    running !== null &&
    running.generation === generation &&
    has(running, signIn)
      ? running
      : null;

  function start(signIn: boolean): Running {
    const at = now();
    const asked = generation;
    started += 1;
    const order = started;
    const done = read(signIn)
      .then((live) => {
        if (asked === generation && (kept === null || kept.order < order))
          kept = { signIn, at, order, live };
        return live;
      })
      .finally(() => {
        if (running?.done === done) running = null;
      });
    running = { signIn, at, generation: asked, done };
    return running;
  }

  /** The live facts, with the sign-ins when `signIn`: the kept reading when
   * it has them and is younger than a minute; else, when `allowStale` and a
   * reading is kept that has them, that one at once, `stale`, with a new
   * reading started behind it unless one runs; else the reading running now
   * when it has them; else a new one. `fresh` always reads anew. A
   * forgotten reading is never answered, not even as stale. */
  function answer(
    signIn: boolean,
    request: Readonly<{ fresh?: boolean; allowStale?: boolean }> = {},
  ): ToolsAnswer {
    // Every reading an answer takes is of this generation: a forget drops
    // the kept one and stops sharing the one under way.
    const asked = generation;
    const latest = () => asked === generation;
    if (request.fresh !== true) {
      if (kept !== null && current(kept, signIn))
        return {
          stale: false,
          done: Promise.resolve(kept.live),
          current: latest,
        };
      const running = shared(signIn);
      if (request.allowStale === true && kept !== null && has(kept, signIn)) {
        // Read anew behind it; its failure is the next read's to meet.
        if (running === null) void start(signIn).done.catch(() => undefined);
        return {
          stale: true,
          done: Promise.resolve(kept.live),
          current: latest,
        };
      }
      if (running !== null)
        return { stale: false, done: running.done, current: latest };
    }
    return { stale: false, done: start(signIn).done, current: latest };
  }

  return {
    answer,
    /** The live facts as `answer` gives them, never stale. */
    live(signIn: boolean, fresh = false): Promise<ToolsLive> {
      return answer(signIn, { fresh }).done;
    },
    /** Reads the tools with their sign-ins in the background, unless a
     * current reading is kept or one that has them runs: the Launchpad's
     * start, and its page opened (the page asks for them on its load). */
    warm() {
      if ((kept !== null && current(kept, true)) || shared(true) !== null)
        return;
      void start(true).done.catch(() => undefined);
    },
    /** The facts changed through this Launchpad: the next read reads anew. */
    forget() {
      generation += 1;
      kept = null;
    },
  };
}

export type ToolsReading = ReturnType<typeof createToolsReading>;
