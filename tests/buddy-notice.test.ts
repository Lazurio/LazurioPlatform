import { expect, test } from "bun:test";
import {
  buddyNoticeKey,
  buddyViewingHoldMs,
  createBuddyNoticeClaims,
  createBuddyNotifier,
} from "../src/shell/buddy-notice";
import type { ShellBuddySignal } from "../src/shell/contract";

const at = (minute: number) =>
  `2026-11-19T16:${String(minute).padStart(2, "0")}:00.000Z`;
const sign = (
  state: ShellBuddySignal["state"],
  minute = 0,
  startedBy: ShellBuddySignal["startedBy"] = "person",
): ShellBuddySignal => ({
  state,
  since: at(minute),
  request: state === "waiting" ? { kind: "question" } : null,
  startedBy,
});

test("a notice is about waiting and failed always, and an answer only where the person started it", () => {
  expect(buddyNoticeKey(sign("waiting"))).toBe(`waiting:${at(0)}`);
  expect(buddyNoticeKey(sign("failed"))).toBe(`failed:${at(0)}`);
  expect(buddyNoticeKey(sign("answered"))).toBe(`answered:${at(0)}:person`);
  expect(buddyNoticeKey(sign("answered", 0, "other"))).toBeNull();
  expect(buddyNoticeKey(sign("quiet"))).toBeNull();
  expect(buddyNoticeKey(sign("unavailable"))).toBeNull();
});

function notifier(
  options: { enabled?: boolean; inView?: boolean; claims?: boolean } = {},
) {
  const shown: ShellBuddySignal[] = [];
  const claimed: string[] = [];
  const watch = createBuddyNotifier({
    enabled: () => options.enabled ?? true,
    inView: () => options.inView ?? false,
    claim: async (key) => {
      claimed.push(key);
      return options.claims ?? true;
    },
    show: (signal) => shown.push(signal),
  });
  return { watch, shown, claimed };
}

test("each change the tab sees is told once; what it finds at start, quiet and unavailable are not", async () => {
  const { watch, shown } = notifier();
  // Found when the tab starts: no change it saw.
  expect(await watch.observe(sign("waiting", 0))).toBe(false);
  expect(await watch.observe(sign("waiting", 0))).toBe(false);
  expect(await watch.observe(sign("quiet", 1))).toBe(false);
  expect(await watch.observe(sign("failed", 2))).toBe(true);
  // A moment the sign cannot be read neither tells nor forgets.
  expect(await watch.observe(sign("unavailable", 3))).toBe(false);
  expect(await watch.observe(sign("failed", 2))).toBe(false);
  // A task's answer is no notice; the person's answer after it is.
  expect(await watch.observe(sign("answered", 4, "other"))).toBe(false);
  expect(await watch.observe(sign("answered", 4, "person"))).toBe(true);
  // A later turn of a task's neither hides nor repeats it.
  expect(await watch.observe(sign("answered", 4, "person"))).toBe(false);
  expect(await watch.observe(sign("waiting", 5))).toBe(true);
  expect(shown.map((signal) => signal.state)).toEqual([
    "failed",
    "answered",
    "waiting",
  ]);
});

test("nothing is told without the person's choice, with Buddy's window in view, or where another tab claimed it", async () => {
  for (const options of [
    { enabled: false },
    { inView: true },
    { claims: false },
  ]) {
    const { watch, shown } = notifier(options);
    await watch.observe(sign("quiet"));
    expect(await watch.observe(sign("waiting", 1))).toBe(false);
    expect(shown).toEqual([]);
  }
});

test("the Launchpad lets one claim of the current change through, and none of another", () => {
  let current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(() => current);
  const key = buddyNoticeKey(current);
  expect(claims.claim(key)).toBe(true);
  // The second tab, on any origin.
  expect(claims.claim(key)).toBe(false);
  // A change that is no longer the current one, or garbage.
  expect(claims.claim(`failed:${at(0)}`)).toBe(false);
  expect(claims.claim(42)).toBe(false);
  current = sign("failed", 2);
  expect(claims.claim(buddyNoticeKey(current))).toBe(true);
});

test("while a tab on any origin has Buddy's window in view, no other tab tells a notice", () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current);
  // Another tab shows his window: the background tab's claim loses.
  claims.viewing();
  at += buddyViewingHoldMs - 1;
  expect(claims.claim(key)).toBe(false);
  // The window is no longer said to be in view: the change is told once.
  at += 1;
  expect(claims.claim(key)).toBe(true);
  expect(claims.claim(key)).toBe(false);
});
