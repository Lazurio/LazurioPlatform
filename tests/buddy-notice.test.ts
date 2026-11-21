import { expect, test } from "bun:test";
import {
  buddyNoticeKey,
  buddyViewingHoldMs,
  createBuddyNoticeClaims,
  createBuddyNotifier,
  enableBuddyNotices,
  shouldAskBuddyNotices,
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

test("the click that opens Buddy's window asks once, after the meeting, where the choice is on and the browser has not answered (Matěj 2026-11-21)", () => {
  const facts = {
    permission: "default" as NotificationPermission,
    choice: "on" as const,
    asked: false,
    met: true,
  };
  expect(shouldAskBuddyNotices(facts)).toBe(true);
  // Not before the meeting, not twice, not where the person turned them off,
  // and not where the browser already answered or has no notices.
  expect(shouldAskBuddyNotices({ ...facts, met: false })).toBe(false);
  expect(shouldAskBuddyNotices({ ...facts, asked: true })).toBe(false);
  expect(shouldAskBuddyNotices({ ...facts, choice: "off" })).toBe(false);
  expect(shouldAskBuddyNotices({ ...facts, permission: "granted" })).toBe(
    false,
  );
  expect(shouldAskBuddyNotices({ ...facts, permission: "denied" })).toBe(false);
  expect(shouldAskBuddyNotices({ ...facts, permission: null })).toBe(false);
});

function noticesSeams(
  permission: NotificationPermission | null,
  answer: NotificationPermission = "granted",
) {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      permission: () => permission,
      request: async () => {
        calls.push("request");
        return answer;
      },
      choose: async (choice: "on" | "off") => {
        calls.push(`choose:${choice}`);
      },
      asked: () => {
        calls.push("asked");
      },
    },
  };
}

test("one function turns the notices on: the browser asks first, inside the click, then the choice is on for the Environment", async () => {
  const fresh = noticesSeams("default");
  expect(await enableBuddyNotices(fresh.seams)).toBe(true);
  expect(fresh.calls).toEqual(["request", "asked", "choose:on"]);
  // A refusal still records that this origin asked, and keeps the choice on
  // for the Environment: another origin may allow them.
  const refused = noticesSeams("default", "denied");
  expect(await enableBuddyNotices(refused.seams)).toBe(false);
  expect(refused.calls).toEqual(["request", "asked", "choose:on"]);
  // Where the browser already allows them, it is not asked again.
  const granted = noticesSeams("granted");
  expect(await enableBuddyNotices(granted.seams)).toBe(true);
  expect(granted.calls).toEqual(["asked", "choose:on"]);
  // Where the browser has no notices, nothing happens.
  const none = noticesSeams(null);
  expect(await enableBuddyNotices(none.seams)).toBe(false);
  expect(none.calls).toEqual([]);
});
