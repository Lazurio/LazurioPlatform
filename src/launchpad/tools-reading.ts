import {
  readToolsLive,
  type ToolsEnvironment,
  type ToolsLive,
} from "../tools/overview";

// The tools' live facts as this Launchpad last read them (root decision 0195,
// plan DEV-6656). Every page load reads Settings → Nástroje once with the
// sign-ins, and each switch between Chat, Apps and Automate loads a page:
// that ran every found tool's version command one after another and every
// installed tool's sign-in probe: more than a second, a process per tool and
// another per sign-in, and calls to the providers, on every load. So a
// reading answers the reads that follow it for a minute, and nothing older
// is ever answered.
//
// What changes the facts through this Launchpad drops the reading as it
// starts and again once it has ended (an installation, an update, a sign-in
// or sign-out, a setup: `forget`), so a reading made while it ran is never
// answered after it; a person's own "Refresh status" or "Zkontrolovat znovu"
// reads anew (`fresh`). Only a change made elsewhere, a tool installed or signed in from
// a terminal, can wait up to that minute to show.

/** How long a reading answers the reads that do not ask for a fresh one,
 * counted from when it started. */
export const toolsKeptMs = 60_000;

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
  let kept: (Reading & Readonly<{ order: number; live: ToolsLive }>) | null =
    null;
  let running:
    | (Reading & Readonly<{ generation: number; done: Promise<ToolsLive> }>)
    | null = null;
  // A forget while a reading runs makes its answer stale: it answers its own
  // read, and is not kept.
  let generation = 0;
  // The order the readings started in, strictly: two may start within one
  // tick of the clock, and only a later one may replace the one kept, so an
  // older reading that ends last never displaces a newer one already kept.
  let started = 0;
  const answers = (reading: Reading, signIn: boolean) =>
    (reading.signIn || !signIn) && now() - reading.at < keepMs;

  function start(signIn: boolean): Promise<ToolsLive> {
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
    return done;
  }

  return {
    /** The live facts, with the sign-ins when `signIn`: the kept reading
     * when it has them and is younger than a minute, else the reading
     * running now when it does, else a new one. `fresh` always reads anew. */
    live(signIn: boolean, fresh = false): Promise<ToolsLive> {
      if (!fresh) {
        if (kept !== null && answers(kept, signIn))
          return Promise.resolve(kept.live);
        if (
          running !== null &&
          running.generation === generation &&
          answers(running, signIn)
        )
          return running.done;
      }
      return start(signIn);
    },
    /** The facts changed through this Launchpad: the next read reads anew. */
    forget() {
      generation += 1;
      kept = null;
    },
  };
}

export type ToolsReading = ReturnType<typeof createToolsReading>;
