import { expect, test } from "bun:test";
import {
  buddyNoticeKey,
  buddyNoticesState,
  buddyViewingHoldMs,
  createBuddyNoticeClaims,
  createBuddyNotifier,
  createNoticesChoiceCache,
  enableBuddyNotices,
  parseBuddyClaimAnswer,
  readBuddyNoticesState,
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
      return { notify: options.claims ?? true, retryInMs: null };
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

test("nothing is told where the browser does not allow it, with Buddy's window in view, or where another tab claimed it", async () => {
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

test("each tab holds its own view and lets it go when the person leaves it, without letting go of another tab's (#1151)", () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current);
  claims.viewing("chat");
  claims.viewing("lazurio");
  // The person leaves Chat's window: Lazurio's still holds the notice back.
  claims.release("chat");
  expect(claims.claim(key)).toBe(false);
  // And leaves Lazurio's too: told at once, not after the hold.
  at += 1;
  claims.release("lazurio");
  expect(claims.claim(key)).toBe(true);
});

test("a claim that comes before its tab's release is claimed again and told once the view is let go, or once its hold ends where the release never comes (#1151)", () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current);
  claims.viewing("chat", 1);
  at = 5_000;
  // The person left, but the release is still on its way.
  expect(claims.claim(key)).toBe(false);
  expect(claims.retryIn(key)).toBe(buddyViewingHoldMs - 5_000);
  claims.release("chat", 2);
  expect(claims.claim(key)).toBe(true);
  expect(claims.retryIn(key)).toBeNull();

  // A release that never arrives: the hold ends by itself.
  const later = sign("failed", 2);
  const lost = createBuddyNoticeClaims(
    () => later,
    () => at,
  );
  const failed = buddyNoticeKey(later);
  lost.viewing("chat", 1);
  expect(lost.claim(failed)).toBe(false);
  expect(lost.retryIn(failed)).toBe(buddyViewingHoldMs);
  at += buddyViewingHoldMs;
  expect(lost.claim(failed)).toBe(true);
});

test("a tab's views and releases count in its own order: a heartbeat overtaken by its release holds nothing back, and one late before the release only delays the notice (#1151)", () => {
  const at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current);
  // Lazurio still has his window in view; Chat's heartbeat (2) arrives after
  // Chat's release (3).
  claims.viewing("lazurio", 1);
  claims.viewing("chat", 1);
  claims.release("chat", 3);
  claims.viewing("chat", 2);
  claims.release("lazurio", 2);
  expect(claims.claim(key)).toBe(true);

  // Chat's heartbeat sent before the person left arrives after the change,
  // and before the release: the claim waits, and the release lets it through.
  const later = sign("failed", 2);
  const late = createBuddyNoticeClaims(
    () => later,
    () => at,
  );
  const failed = buddyNoticeKey(later);
  late.viewing("lazurio", 1);
  late.viewing("chat", 5);
  expect(late.claim(failed)).toBe(false);
  expect(late.retryIn(failed)).not.toBeNull();
  // Releasing Chat's view leaves Lazurio's.
  late.release("chat", 6);
  expect(late.claim(failed)).toBe(false);
  late.release("lazurio", 2);
  expect(late.claim(failed)).toBe(true);
});

test("only the tab that had Buddy's window in view as the change came says the person saw it: then no claim again, and none told after they leave", async () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current);
  claims.viewing("chat", 1);
  expect(claims.claim(key)).toBe(false);
  expect(claims.retryIn(key)).not.toBeNull();
  claims.seen(key);
  expect(claims.retryIn(key)).toBeNull();
  claims.release("chat", 2);
  at += 1;
  expect(claims.claim(key)).toBe(false);
  // The tab in view says so as the change comes.
  const seen: string[] = [];
  const watch = createBuddyNotifier({
    enabled: () => true,
    inView: () => true,
    claim: async () => ({ notify: true, retryInMs: null }),
    show: () => {},
    seen: (change) => seen.push(change),
  });
  await watch.observe(sign("quiet"));
  expect(await watch.observe(sign("waiting", 1))).toBe(false);
  expect(seen).toEqual([key ?? ""]);
});

test("a tab claims a held change again while it is still the sign, and stops when it changes or the Launchpad says no", async () => {
  const shown: ShellBuddySignal[] = [];
  const answers: { notify: boolean; retryInMs: number | null }[] = [];
  const waits: number[] = [];
  let onWait: () => void = () => {};
  const watch = createBuddyNotifier({
    enabled: () => true,
    inView: () => false,
    claim: async () => answers.shift() ?? { notify: false, retryInMs: null },
    show: (signal) => shown.push(signal),
    wait: async (ms) => {
      waits.push(ms);
      onWait();
    },
  });
  await watch.observe(sign("quiet"));
  // Held twice, then told.
  answers.push(
    { notify: false, retryInMs: 15_000 },
    { notify: false, retryInMs: 400 },
    { notify: true, retryInMs: null },
  );
  expect(await watch.observe(sign("waiting", 1))).toBe(true);
  expect(waits).toEqual([1_000, 400]);
  expect(shown.map((signal) => signal.state)).toEqual(["waiting"]);
  // Held, and the sign changes while it waits: the old change is dropped.
  answers.push({ notify: false, retryInMs: 5_000 });
  onWait = () => {
    onWait = () => {};
    void watch.observe(sign("quiet", 3));
  };
  expect(await watch.observe(sign("failed", 2))).toBe(false);
  expect(shown).toHaveLength(1);
  // A claim the Launchpad refuses for good is not repeated.
  waits.length = 0;
  expect(await watch.observe(sign("waiting", 4))).toBe(false);
  expect(waits).toEqual([]);
  expect(parseBuddyClaimAnswer({ notify: false, retryInMs: 999_999 })).toEqual({
    notify: false,
    retryInMs: buddyViewingHoldMs,
  });
  expect(parseBuddyClaimAnswer({ notify: true, retryInMs: 5 })).toEqual({
    notify: true,
    retryInMs: null,
  });
  expect(parseBuddyClaimAnswer("nonsense")).toEqual({
    notify: false,
    retryInMs: null,
  });
});

test("the Launchpad refuses every claim while the Environment's choice is off, whichever page claims", () => {
  let choice: "on" | "off" = "off";
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => 0,
    () => choice === "on",
  );
  const key = buddyNoticeKey(current);
  expect(claims.claim(key)).toBe(false);
  choice = "on";
  expect(claims.claim(key)).toBe(true);
});

test("a page's copy of the choice follows the other pages, and a late first read never undoes the person's newer choice", async () => {
  let held = "on" as "on" | "off";
  const reads: ((choice: "on" | "off") => void)[] = [];
  let fail = false;
  let waits = true;
  const cache = createNoticesChoiceCache(
    () =>
      waits
        ? new Promise((resolve) => reads.push(resolve))
        : Promise.resolve(held),
    async (choice) => {
      if (fail) throw new Error("not saved");
      held = choice;
      return held;
    },
  );
  // The first read is still on its way when the person turns them off.
  const first = cache.refresh();
  expect(await cache.set("off")).toBe(true);
  reads[0]?.("on");
  await first;
  expect(cache.current()).toBe("off");
  expect(held).toBe("off");
  // Another page turned them on: this page reads it when it comes forward.
  held = "on";
  const again = cache.refresh();
  reads[1]?.(held);
  await again;
  expect(cache.current()).toBe("on");
  // A save that fails goes back to what the Launchpad holds.
  fail = true;
  waits = false;
  expect(await cache.set("off")).toBe(false);
  expect(cache.current()).toBe("on");
});

test("a page whose choice was overtaken on its way shows the newer one the Launchpad holds", async () => {
  const cache = createNoticesChoiceCache(
    async () => "off",
    async () => "off",
  );
  expect(await cache.set("on")).toBe(false);
  expect(cache.current()).toBe("off");
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

test("one function turns the notices on: the choice is saved as the person clicks, then the browser asks, still inside the click", async () => {
  const fresh = noticesSeams("default");
  expect(await enableBuddyNotices(fresh.seams)).toBe(true);
  expect(fresh.calls).toEqual(["choose:on", "request", "asked"]);
  // A refusal still records that this origin asked, and keeps the choice on
  // for the Environment: another origin may allow them.
  const refused = noticesSeams("default", "denied");
  expect(await enableBuddyNotices(refused.seams)).toBe(false);
  expect(refused.calls).toEqual(["choose:on", "request", "asked"]);
  // Where the browser already allows them, it is not asked again.
  const granted = noticesSeams("granted");
  expect(await enableBuddyNotices(granted.seams)).toBe(true);
  expect(granted.calls).toEqual(["choose:on", "asked"]);
  // Where the browser has no notices, nothing happens.
  const none = noticesSeams(null);
  expect(await enableBuddyNotices(none.seams)).toBe(false);
  expect(none.calls).toEqual([]);
});

test("a choice made on another page while the browser's question is open stays: answering it does not turn the notices back on", async () => {
  let held = "off" as "on" | "off";
  let answer: (permission: NotificationPermission) => void = () => {};
  const enabling = enableBuddyNotices({
    permission: () => "default",
    request: () => new Promise((resolve) => (answer = resolve)),
    choose: async (choice) => {
      held = choice;
    },
    asked: () => {},
  });
  expect(held).toBe("on");
  // Another page turns them off while the question is open.
  held = "off";
  answer("granted");
  expect(await enabling).toBe(true);
  expect(held).toBe("off");
});

test("the state of notices on an origin, for the guide: on only where the browser allows them and the choice is on", async () => {
  expect(buddyNoticesState("granted", "on")).toBe("on");
  expect(buddyNoticesState("granted", "off")).toBe("off");
  // On by default, but not asked here yet: off until the person's click.
  expect(buddyNoticesState("default", "on")).toBe("off");
  expect(buddyNoticesState("denied", "on")).toBe("blocked");
  expect(buddyNoticesState(null, "on")).toBe("unsupported");
  expect(
    await readBuddyNoticesState(
      () => "granted",
      async () => "off",
    ),
  ).toBe("off");
  // A Launchpad that does not answer reads as the default choice, on.
  expect(
    await readBuddyNoticesState(
      () => "granted",
      async () => {
        throw new Error("unreachable");
      },
    ),
  ).toBe("on");
});
