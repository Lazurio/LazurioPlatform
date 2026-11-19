import { expect, test } from "bun:test";
import {
  type BuddySignal,
  type BuddySignalProcess,
  createBuddySignalFollower,
  parseBuddySignalLine,
  unavailableSignal,
} from "../src/buddy/signal";
import { manualClock } from "./fixtures/manual-clock";

const line = (value: unknown) => JSON.stringify(value);
const waiting = {
  version: 1,
  state: "waiting",
  threadId: "thread-1",
  since: "2026-11-19T16:00:00.000Z",
  request: { kind: "question" },
  startedBy: "person",
};

test("a line of T3 Code's follower is the sign; anything else is unavailable, never quiet", () => {
  expect(parseBuddySignalLine(line(waiting))).toEqual({
    state: "waiting",
    since: "2026-11-19T16:00:00.000Z",
    request: { kind: "question" },
    startedBy: "person",
  });
  expect(
    parseBuddySignalLine(
      line({
        version: 1,
        state: "answered",
        threadId: "thread-1",
        since: "2026-11-19T16:01:00.000Z",
        request: null,
        startedBy: "other",
      }),
    ),
  ).toEqual({
    state: "answered",
    since: "2026-11-19T16:01:00.000Z",
    request: null,
    startedBy: "other",
  });
  // A request is only ever part of `waiting`.
  expect(
    parseBuddySignalLine(line({ ...waiting, state: "failed" })).request,
  ).toBeNull();
  for (const unreadable of [
    "",
    "not json",
    "[]",
    line(null),
    line({ version: 2, state: "quiet" }),
    line({ version: 1, state: "sleeping" }),
    line({ version: 1 }),
    line({
      version: 1,
      state: "unavailable",
      reason: "connection_lost",
      message: "T3 Code ended the stream.",
    }),
  ])
    expect(parseBuddySignalLine(unreadable)).toBe(unavailableSignal);
});

/** A follower whose processes the test starts, feeds and ends by hand. */
function harness(options: { refuse?: number } = {}) {
  const clock = manualClock();
  const runs: {
    feed: (line: string) => void;
    end: () => void;
    stopped: boolean;
  }[] = [];
  let refusals = options.refuse ?? 0;
  const follower = createBuddySignalFollower({
    setTimer: clock.setTimer,
    retryMs: [1_000, 5_000],
    start: async (onLine): Promise<BuddySignalProcess> => {
      if (refusals > 0) {
        refusals -= 1;
        throw new Error("t3 is not on PATH");
      }
      let end = () => {};
      const exited = new Promise<void>((resolve) => {
        end = resolve;
      });
      const run = { feed: onLine, end, stopped: false };
      runs.push(run);
      return {
        exited,
        stop: () => {
          run.stopped = true;
          end();
        },
      };
    },
  });
  const seen: BuddySignal[] = [];
  follower.subscribe((signal) => seen.push(signal));
  return { clock, runs, follower, seen };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the follower is unavailable until T3 Code says otherwise, and again whenever its process ends", async () => {
  const { clock, runs, follower, seen } = harness();
  expect(follower.current()).toBe(unavailableSignal);
  follower.start();
  await settle();
  expect(runs).toHaveLength(1);
  expect(follower.current().state).toBe("unavailable");

  runs[0]?.feed(line(waiting));
  expect(follower.current().state).toBe("waiting");
  // The same state again is no change.
  runs[0]?.feed(line(waiting));
  expect(seen.map((signal) => signal.state)).toEqual(["waiting"]);

  // T3 Code's own `unavailable` line and a line it cannot read both say so.
  runs[0]?.feed(line({ version: 1, state: "unavailable", reason: "x" }));
  expect(follower.current().state).toBe("unavailable");
  runs[0]?.feed(line({ ...waiting, state: "quiet", request: null }));
  expect(follower.current().state).toBe("quiet");
  runs[0]?.feed("{ broken");
  expect(follower.current().state).toBe("unavailable");

  // The process ends: unavailable at once, a new one after the wait.
  runs[0]?.feed(line({ ...waiting, state: "quiet", request: null }));
  runs[0]?.end();
  await settle();
  expect(follower.current().state).toBe("unavailable");
  expect(runs).toHaveLength(1);
  clock.advance(999);
  await settle();
  expect(runs).toHaveLength(1);
  clock.advance(1);
  await settle();
  expect(runs).toHaveLength(2);
  follower.close();
  expect(runs[1]?.stopped).toBe(true);
});

test("a follower that cannot start stays unavailable and retries with growing waits; a reading resets them", async () => {
  const { clock, runs, follower } = harness({ refuse: 3 });
  follower.start();
  await settle();
  expect(runs).toHaveLength(0);
  expect(follower.current().state).toBe("unavailable");
  expect(clock.pending()).toEqual([clock.now() + 1_000]);
  clock.advance(1_000);
  await settle();
  // The last wait repeats.
  expect(clock.pending()).toEqual([clock.now() + 5_000]);
  clock.advance(5_000);
  await settle();
  expect(clock.pending()).toEqual([clock.now() + 5_000]);
  clock.advance(5_000);
  await settle();
  expect(runs).toHaveLength(1);

  runs[0]?.feed(line(waiting));
  runs[0]?.end();
  await settle();
  // After a reading the first wait again.
  expect(clock.pending()).toEqual([clock.now() + 1_000]);
  follower.close();
  expect(clock.pending()).toEqual([]);
  expect(follower.current().state).toBe("unavailable");
});

test("a closed follower starts nothing and reports nothing more", async () => {
  const { runs, follower, seen } = harness();
  follower.start();
  await settle();
  follower.close();
  runs[0]?.feed(line(waiting));
  follower.start();
  await settle();
  expect(runs).toHaveLength(1);
  expect(seen).toEqual([]);
});
