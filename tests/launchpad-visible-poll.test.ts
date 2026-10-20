import { expect, test } from "bun:test";
import {
  type PageVisibility,
  type PollTimers,
  pollWhileVisible,
} from "../src/launchpad/visible-poll";

// The update pill's poll (plan DEV-6656): every ten seconds only while the
// page is shown, at once when it is shown again, never two reads at a time,
// nothing after it stopped.

function world(initially: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: initially,
    addEventListener: (_: "visibilitychange", listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: "visibilitychange", listener: () => void) =>
      listeners.delete(listener),
  };
  const running = new Map<number, Readonly<{ ms: number; tick: () => void }>>();
  let next = 0;
  const timers: PollTimers = {
    every: (tick, ms) => {
      next += 1;
      running.set(next, { ms, tick });
      return next;
    },
    cancel: (timer) => running.delete(timer as number),
  };
  const reads: Array<() => void> = [];
  const read = () =>
    new Promise<void>((done) => {
      reads.push(done);
    });
  return {
    page: page as PageVisibility,
    timers,
    read,
    reads,
    running,
    listeners,
    /** The browser changes the page's visibility. */
    show(state: DocumentVisibilityState) {
      page.visibilityState = state;
      for (const listener of listeners) listener();
    },
    /** Every running interval fires once. */
    tick() {
      for (const { tick } of running.values()) tick();
    },
    /** The reads started so far answer. */
    async answer() {
      for (const done of reads.splice(0)) done();
      await Bun.sleep(0);
    },
  };
}

test("a shown page reads at once and every ten seconds while it stays shown", async () => {
  const w = world("visible");
  pollWhileVisible(w.read, 10_000, w.page, w.timers);
  expect(w.reads.length).toBe(1);
  expect([...w.running.values()].map((timer) => timer.ms)).toEqual([10_000]);
  await w.answer();
  w.tick();
  expect(w.reads.length).toBe(1);
  await w.answer();
  w.tick();
  expect(w.reads.length).toBe(1);
});

test("a hidden page asks nothing until it is shown, then reads at once", async () => {
  const w = world("hidden");
  pollWhileVisible(w.read, 10_000, w.page, w.timers);
  expect(w.reads.length).toBe(0);
  expect(w.running.size).toBe(0);
  w.show("visible");
  expect(w.reads.length).toBe(1);
  expect(w.running.size).toBe(1);
});

test("hiding the page stops the timer; showing it again reads at once and starts it over", async () => {
  const w = world("visible");
  pollWhileVisible(w.read, 10_000, w.page, w.timers);
  await w.answer();
  w.show("hidden");
  expect(w.running.size).toBe(0);
  w.tick();
  expect(w.reads.length).toBe(0);
  w.show("visible");
  expect(w.reads.length).toBe(1);
  expect(w.running.size).toBe(1);
});

test("a read still running is not started again beside it", async () => {
  const w = world("visible");
  pollWhileVisible(w.read, 10_000, w.page, w.timers);
  w.tick();
  w.show("hidden");
  w.show("visible");
  expect(w.reads.length).toBe(1);
  await w.answer();
  w.tick();
  expect(w.reads.length).toBe(1);
});

test("a failed read does not stop the poll", async () => {
  const w = world("visible");
  let calls = 0;
  pollWhileVisible(
    async () => {
      calls += 1;
      throw new Error("unreachable");
    },
    10_000,
    w.page,
    w.timers,
  );
  await Bun.sleep(0);
  w.tick();
  await Bun.sleep(0);
  expect(calls).toBe(2);
});

test("after the stop nothing reads, on the timer or when the page is shown", async () => {
  const w = world("visible");
  const stop = pollWhileVisible(w.read, 10_000, w.page, w.timers);
  await w.answer();
  stop();
  expect(w.running.size).toBe(0);
  expect(w.listeners.size).toBe(0);
  w.show("hidden");
  w.show("visible");
  w.tick();
  expect(w.reads.length).toBe(0);
});
