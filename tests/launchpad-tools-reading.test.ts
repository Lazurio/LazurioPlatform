import { expect, test } from "bun:test";
import {
  createToolsReading,
  toolsKeptMs,
} from "../src/launchpad/tools-reading";
import type { ToolsLive } from "../src/tools/overview";

// The Launchpad's reading of the tools' live facts (plan DEV-6656): a page's
// reading within a minute of the last one answers from it; nothing older is
// ever answered, `fresh` and a forget read anew.

function world() {
  let clock = 1_000_000;
  const started: Array<
    Readonly<{ signIn: boolean; answer: (live: ToolsLive) => void }>
  > = [];
  const failures: Array<(error: Error) => void> = [];
  let count = 0;
  const reading = createToolsReading(
    {
      path: undefined,
      home: undefined,
      platform: "linux",
      run: async () => "timeout",
    },
    {
      now: () => clock,
      read: (signIn) =>
        new Promise<ToolsLive>((resolve, reject) => {
          count += 1;
          started.push({ signIn, answer: resolve });
          failures.push(reject);
        }),
    },
  );
  const live = (n: number, signIn: boolean): ToolsLive => ({
    status: { kind: "tools-status", tools: [] },
    ...(signIn ? { signIns: Array(n).fill({ state: "unknown" }) } : {}),
  });
  return {
    reading,
    started,
    failures,
    reads: () => count,
    live,
    later: (ms: number) => {
      clock += ms;
    },
    /** The last reading started answers. */
    async answer(value: ToolsLive) {
      started.at(-1)?.answer(value);
      await Bun.sleep(0);
    },
  };
}

test("a reading answers the reads of the next minute, counted from its start, and none after", async () => {
  const w = world();
  const first = w.reading.live(true);
  w.later(5_000);
  const answered = w.live(1, true);
  await w.answer(answered);
  expect(await first).toBe(answered);
  w.later(toolsKeptMs - 5_001);
  expect(await w.reading.live(true)).toBe(answered);
  expect(w.reads()).toBe(1);
  w.later(1);
  const next = w.reading.live(true);
  expect(w.reads()).toBe(2);
  await w.answer(w.live(2, true));
  expect(await next).not.toBe(answered);
});

test("a reading with the sign-ins answers one without them, never the reverse", async () => {
  const w = world();
  const plain = w.reading.live(false);
  await w.answer(w.live(0, false));
  await plain;
  const signed = w.reading.live(true);
  expect(w.reads()).toBe(2);
  expect(w.started.at(-1)?.signIn).toBe(true);
  const withSignIns = w.live(1, true);
  await w.answer(withSignIns);
  expect(await signed).toBe(withSignIns);
  expect(await w.reading.live(false)).toBe(withSignIns);
  expect(w.reads()).toBe(2);
});

test("fresh always reads anew, and its reading answers the reads after it", async () => {
  const w = world();
  const first = w.reading.live(true);
  await w.answer(w.live(1, true));
  await first;
  const fresh = w.reading.live(true, true);
  expect(w.reads()).toBe(2);
  const anew = w.live(2, true);
  await w.answer(anew);
  expect(await fresh).toBe(anew);
  expect(await w.reading.live(true)).toBe(anew);
  expect(w.reads()).toBe(2);
});

test("reads while one runs share it when it has what they ask; a fresh one does not", async () => {
  const w = world();
  const first = w.reading.live(true);
  const second = w.reading.live(false);
  expect(w.reads()).toBe(1);
  const fresh = w.reading.live(true, true);
  expect(w.reads()).toBe(2);
  const shared = w.live(1, true);
  w.started[0]?.answer(shared);
  expect(await first).toBe(shared);
  expect(await second).toBe(shared);
  await w.answer(w.live(2, true));
  await fresh;
});

test("a forget drops the reading; one running across a forget answers its read and is not kept", async () => {
  const w = world();
  const first = w.reading.live(true);
  await w.answer(w.live(1, true));
  await first;
  w.reading.forget();
  const across = w.reading.live(true);
  expect(w.reads()).toBe(2);
  w.reading.forget();
  const stale = w.live(2, true);
  await w.answer(stale);
  expect(await across).toBe(stale);
  // Not kept, and not shared after the forget: the next read reads anew.
  const next = w.reading.live(true);
  expect(w.reads()).toBe(3);
  await w.answer(w.live(3, true));
  expect(await next).not.toBe(stale);
});

test("a failed reading is not kept: the next read tries again", async () => {
  const w = world();
  const first = w.reading.live(true);
  w.failures.at(-1)?.(new Error("probe failed"));
  await expect(first).rejects.toThrow("probe failed");
  const next = w.reading.live(true);
  expect(w.reads()).toBe(2);
  await w.answer(w.live(1, true));
  await next;
});

test("an older reading that ends after a newer one, both started within one tick, never replaces it", async () => {
  // The clock stands still: both readings start at the same millisecond.
  const w = world();
  const older = w.reading.live(true);
  const fresh = w.reading.live(true, true);
  expect(w.reads()).toBe(2);
  const newer = w.live(2, true);
  w.started[1]?.answer(newer);
  expect(await fresh).toBe(newer);
  const stale = w.live(1, true);
  w.started[0]?.answer(stale);
  expect(await older).toBe(stale);
  expect(await w.reading.live(true)).toBe(newer);
  expect(w.reads()).toBe(2);
});

test("an older reading that ends first is kept until the newer one ends", async () => {
  const w = world();
  const older = w.reading.live(true);
  const fresh = w.reading.live(true, true);
  const first = w.live(1, true);
  w.started[0]?.answer(first);
  expect(await older).toBe(first);
  expect(await w.reading.live(true)).toBe(first);
  const newer = w.live(2, true);
  w.started[1]?.answer(newer);
  expect(await fresh).toBe(newer);
  expect(await w.reading.live(true)).toBe(newer);
  expect(w.reads()).toBe(2);
});
