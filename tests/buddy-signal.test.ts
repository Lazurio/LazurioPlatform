import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuddySignal,
  type BuddySignalProcess,
  buddySignalLineLimit,
  buddySignalProcess,
  createBuddySignalFollower,
  parseBuddySignalLine,
  unavailableSignal,
} from "../src/buddy/signal";
import { manualClock } from "./fixtures/manual-clock";

const line = (value: unknown) => JSON.stringify(value);
// T3 Code's own lines (Lazurio/t3code#232, version 1), as it prints them:
// the request's kind is its runtime request's, and quiet names nothing.
const waiting = {
  version: 1,
  state: "waiting",
  threadId: "thread-1",
  since: "2026-11-19T16:00:00.000Z",
  request: { kind: "user_input" },
  startedBy: "person",
};
const quietLine = line({
  version: 1,
  state: "quiet",
  threadId: "thread-1",
  since: null,
  request: null,
  startedBy: null,
});

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
  // A quiet Buddy is quiet; an approval of any other kind asks for one.
  expect(parseBuddySignalLine(quietLine)).toEqual({
    state: "quiet",
    since: null,
    request: null,
    startedBy: null,
  });
  expect(
    parseBuddySignalLine(line({ ...waiting, request: { kind: "command" } }))
      .request,
  ).toEqual({ kind: "approval" });
  expect(
    parseBuddySignalLine(
      line({ ...waiting, state: "failed", request: null, startedBy: null }),
    ).state,
  ).toBe("failed");
  for (const unreadable of [
    "",
    "not json",
    "[]",
    line(null),
    line({ version: 2, state: "quiet" }),
    line({ version: 1, state: "sleeping" }),
    line({ version: 1 }),
    // T3 Code versions its lines: an unversioned one is no sign, quiet or not.
    line({
      state: "quiet",
      threadId: "t",
      since: null,
      request: null,
      startedBy: "person",
    }),
    line({ ...waiting, threadId: undefined }),
    line({ ...waiting, startedBy: "nobody" }),
    // Each state in exactly its own shape.
    line({ ...waiting, request: null }),
    line({ ...waiting, since: null }),
    line({ ...waiting, state: "failed" }),
    line({ ...waiting, state: "answered", request: null, startedBy: null }),
    line({ ...JSON.parse(quietLine), request: { kind: "user_input" } }),
    line({ ...JSON.parse(quietLine), startedBy: "person" }),
    line({ ...JSON.parse(quietLine), since: "2026-11-19T16:00:00.000Z" }),
    `${line(waiting).slice(0, -1)},"pad":"${"x".repeat(70 * 1024)}"}`,
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
  runs[0]?.feed(quietLine);
  expect(follower.current().state).toBe("quiet");
  runs[0]?.feed("{ broken");
  expect(follower.current().state).toBe("unavailable");

  // The process ends: unavailable at once, a new one after the wait.
  runs[0]?.feed(quietLine);
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

test("from a quiet sign, a line it cannot read turns it unavailable at once", async () => {
  const quiet = quietLine;
  for (const unreadable of [
    line({
      state: "quiet",
      threadId: "t",
      since: null,
      request: null,
      startedBy: "person",
    }),
    "{ broken",
    line({ version: 2, state: "quiet" }),
  ]) {
    const { runs, follower } = harness();
    follower.start();
    await settle();
    runs[0]?.feed(quiet);
    expect(follower.current().state).toBe("quiet");
    runs[0]?.feed(unreadable);
    expect(follower.current().state).toBe("unavailable");
    follower.close();
  }
});

const posix = test.skipIf(process.platform === "win32");

posix(
  "the follower's process says unavailable as soon as a line grows too long, and reads the next line again",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "buddy-signal-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const quiet = quietLine;
      // A stand-in for T3 Code's CLI: a quiet sign, a line longer than any
      // sign without its end for a while, then its end and a sign again.
      await writeFile(join(root, "first"), `${quiet}\n`);
      await writeFile(join(root, "long"), "x".repeat(buddySignalLineLimit * 3));
      await writeFile(join(root, "rest"), `\n${line(waiting)}\n`);
      await writeFile(
        join(bin, "t3"),
        `#!/bin/sh\ncat "${root}/first" "${root}/long"\nsleep 1\ncat "${root}/rest"\nsleep 30\n`,
        { mode: 0o755 },
      );
      const seen: string[] = [];
      const started = await buddySignalProcess({
        // Ours first; the shell's own tools after it.
        path: `${bin}:/usr/bin:/bin`,
        home: root,
        platform: process.platform,
      })((text) => seen.push(parseBuddySignalLine(text).state));
      try {
        const deadline = Date.now() + 5_000;
        while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(20);
        // Before the long line ends.
        expect(seen).toEqual(["quiet", "unavailable"]);
        while (seen.length < 3 && Date.now() < deadline) await Bun.sleep(20);
        expect(seen).toEqual(["quiet", "unavailable", "waiting"]);
      } finally {
        started.stop();
        await started.exited;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
