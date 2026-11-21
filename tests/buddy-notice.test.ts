import { expect, test } from "bun:test";
import {
  buddyDeliveryPausesMs,
  buddyNoticeAnswer,
  buddyNoticeKey,
  buddyNoticesState,
  buddyNoticeTold,
  buddyViewingEveryMs,
  buddyViewingHoldMs,
  createBuddyNoticeClaims,
  createBuddyNotifier,
  createNoticesChoiceCache,
  deliverBuddyNotice,
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

test("a tab that starts or reconnects with Buddy's window in view says the sign it finds was seen, so another tab's held claim is not told after the person leaves", async () => {
  const at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current);
  // Chat, in the background, saw the change and claims it while Lazurio's
  // view holds it back.
  claims.viewing("lazurio", 1);
  expect(claims.claim(key)).toBe(false);
  expect(claims.retryIn(key)).not.toBeNull();
  // Lazurio's page reconnects with his window in view: its first sign.
  const foreground = createBuddyNotifier({
    enabled: () => true,
    inView: () => true,
    claim: async () => ({ notify: true, retryInMs: null }),
    show: () => {},
    seen: (change) => claims.seen(change),
  });
  expect(await foreground.observe(current)).toBe(false);
  expect(claims.retryIn(key)).toBeNull();
  // The person leaves: Chat's next claim tells nothing.
  claims.release("lazurio", 2);
  expect(claims.claim(key)).toBe(false);
  // A tab that starts out of view tells nothing and says nothing seen.
  const seen: string[] = [];
  const background = createBuddyNotifier({
    enabled: () => true,
    inView: () => false,
    claim: async () => ({ notify: true, retryInMs: null }),
    show: () => {},
    seen: (change) => seen.push(change),
  });
  expect(await background.observe(sign("failed", 2))).toBe(false);
  expect(seen).toEqual([]);
});

test('a tab\'s word that it saw a change rides on its release: a release that overtakes the lone "seen" still tells no other tab, and a heartbeat repeats it where the lone one is lost', () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current) ?? "";
  // Lazurio views Buddy's window; Chat, in the background, is held.
  buddyNoticeTold(claims, { viewing: true, tab: "lazurio", seq: 1 });
  expect(buddyNoticeAnswer(claims, key)).toMatchObject({ notify: false });
  // Lazurio saw the change, then the person left; the release, carrying
  // what Lazurio saw, arrives before the lone "seen".
  buddyNoticeTold(claims, {
    viewing: false,
    tab: "lazurio",
    seq: 2,
    seen: key,
  });
  expect(buddyNoticeAnswer(claims, key)).toEqual({ notify: false });
  expect(buddyNoticeTold(claims, { seen: key })).toEqual({ seen: true });
  expect(buddyNoticeAnswer(claims, key)).toEqual({ notify: false });

  // The lone "seen" and the release are both lost: the next heartbeat
  // carries it before the hold ends.
  const later = sign("failed", 2);
  const lost = createBuddyNoticeClaims(
    () => later,
    () => at,
  );
  const failed = buddyNoticeKey(later) ?? "";
  buddyNoticeTold(lost, { viewing: true, tab: "lazurio", seq: 1 });
  at += 10_000;
  buddyNoticeTold(lost, {
    viewing: true,
    tab: "lazurio",
    seq: 3,
    seen: failed,
  });
  at += buddyViewingHoldMs;
  expect(buddyNoticeAnswer(lost, failed)).toEqual({ notify: false });
  // A plain claim with no view is told.
  const fresh = createBuddyNoticeClaims(
    () => later,
    () => at,
  );
  expect(buddyNoticeTold(fresh, { key: failed })).toBeNull();
  expect(buddyNoticeAnswer(fresh, failed)).toEqual({ notify: true });
});

test("the person leaves right after seeing a change and the word that they saw it and left is lost twice: it is tried again and arrives before the view's hold ends, so no other tab tells the change", async () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current) ?? "";
  // Lazurio views Buddy's window, then sees the change; no beat follows,
  // because the person leaves before the next one.
  buddyNoticeTold(claims, { viewing: true, tab: "lazurio", seq: 1 });
  let lost = 2;
  const send = (body: Record<string, unknown>) => async () => {
    if (lost > 0) {
      lost -= 1;
      return false;
    }
    buddyNoticeTold(claims, body);
    return true;
  };
  const wait = async (ms: number) => {
    at += ms;
  };
  // The lone "seen" is lost and tried again; the release, carrying it, too.
  const seenDelivered = deliverBuddyNotice(send({ seen: key }), wait);
  const leftDelivered = deliverBuddyNotice(
    send({ viewing: false, tab: "lazurio", seq: 2, seen: key }),
    wait,
  );
  expect(await seenDelivered).toBe(true);
  expect(await leftDelivered).toBe(true);
  expect(at).toBeLessThan(buddyViewingHoldMs);
  // Chat's claim, now and after the hold would have ended: not told.
  expect(buddyNoticeAnswer(claims, key)).toEqual({ notify: false });
  at = buddyViewingHoldMs + 1;
  expect(buddyNoticeAnswer(claims, key)).toEqual({ notify: false });
  // Every try ends before a view's hold does.
  expect(
    buddyDeliveryPausesMs.reduce((sum, pause) => sum + pause, 0),
  ).toBeLessThan(buddyViewingHoldMs);
  // A Launchpad that never answers: the tries end.
  expect(
    await deliverBuddyNotice(
      async () => false,
      async () => {},
    ),
  ).toBe(false);
});

test("a change seen just before the hold of a tab whose last beat was lost would end, and the words that it was seen and left lost once: no other tab tells it before they arrive", async () => {
  let at = 0;
  const current = sign("waiting", 1);
  const claims = createBuddyNoticeClaims(
    () => current,
    () => at,
  );
  const key = buddyNoticeKey(current) ?? "";
  // Lazurio's beat at 0 s arrives; the one at 10 s is lost. The person sees
  // the change at 19.9 s and leaves at once.
  buddyNoticeTold(claims, { viewing: true, tab: "lazurio", seq: 1 });
  at = 19_900;
  // Chat claims at once and on every retry while the words are on their way.
  let lost = 2;
  const send = (body: Record<string, unknown>) => async () => {
    // Each failed send takes a second to fail, as a stalled one may.
    at += 1_000;
    if (lost > 0) {
      lost -= 1;
      return false;
    }
    buddyNoticeTold(claims, body);
    return true;
  };
  const wait = async (ms: number) => {
    at += ms;
    expect(buddyNoticeAnswer(claims, key)).toMatchObject({ notify: false });
  };
  expect(
    await deliverBuddyNotice(
      send({ viewing: false, tab: "lazurio", seq: 3, seen: key }),
      wait,
    ),
  ).toBe(true);
  // Every try, each failing slowly, still ends inside the hold.
  expect(
    buddyViewingEveryMs +
      buddyDeliveryPausesMs.reduce((sum, pause) => sum + pause, 0) +
      (buddyDeliveryPausesMs.length + 1) * 1_000,
  ).toBeLessThan(buddyViewingHoldMs);
  at = buddyViewingHoldMs + 1;
  expect(buddyNoticeAnswer(claims, key)).toEqual({ notify: false });
});

test("a page's copy ignores an answer older than the version it knows: refreshes on focus and on the tab shown may come back in any order", async () => {
  const answers: ((record: {
    choice: "on" | "off";
    version: number;
  }) => void)[] = [];
  const cache = createNoticesChoiceCache(
    () => new Promise((resolve) => answers.push(resolve)),
    async () => ({ choice: "off", version: 1, saved: true }),
  );
  const focus = cache.refresh();
  const shown = cache.refresh();
  // The newer read (version 1, "off") answers first, the older one after.
  answers[1]?.({ choice: "off", version: 1 });
  await shown;
  answers[0]?.({ choice: "on", version: 0 });
  await focus;
  expect(cache.current()).toBe("off");
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

/** A Launchpad that holds one versioned choice, for pages' caches. */
function launchpadChoice() {
  const state = { choice: "on" as "on" | "off", version: 0, fail: false };
  return {
    state,
    read: async () => ({ choice: state.choice, version: state.version }),
    write: async (choice: "on" | "off", basis: number) => {
      if (state.fail) throw new Error("not saved");
      if (choice !== state.choice) {
        if (basis !== state.version)
          return { choice: state.choice, version: state.version, saved: false };
        state.choice = choice;
        state.version += 1;
      }
      return { choice: state.choice, version: state.version, saved: true };
    },
  };
}

test("a page's copy of the choice follows the other pages, a late first read never undoes the person's newer choice, and a failed save shows what the Launchpad holds", async () => {
  const launchpad = launchpadChoice();
  const reads: (() => void)[] = [];
  const cache = createNoticesChoiceCache(
    () =>
      new Promise((resolve) =>
        reads.push(() => resolve({ ...launchpad.state })),
      ),
    launchpad.write,
  );
  expect(cache.known()).toBe(false);
  // The first read is on its way when the person turns them off; the
  // change waits for it and is made on the version it names.
  const first = cache.refresh();
  const off = cache.set("off");
  reads[0]?.();
  await first;
  reads[1]?.();
  expect(await off).toBe(true);
  expect(cache.current()).toBe("off");
  expect(launchpad.state).toMatchObject({ choice: "off", version: 1 });
  // Another page turned them on: this page reads it when it comes forward.
  launchpad.state.choice = "on";
  launchpad.state.version = 2;
  const again = cache.refresh();
  reads[2]?.();
  await again;
  expect(cache.current()).toBe("on");
  // A save that fails shows what the Launchpad holds.
  launchpad.state.fail = true;
  const failed = cache.set("off");
  await Promise.resolve();
  await Promise.resolve();
  reads[3]?.();
  expect(await failed).toBe(false);
  expect(cache.current()).toBe("on");
});

test("whatever the clocks and however late a request: a change made on an older view never undoes a newer choice from another page", async () => {
  const launchpad = launchpadChoice();
  const lazurio = createNoticesChoiceCache(launchpad.read, launchpad.write);
  const chat = createNoticesChoiceCache(launchpad.read, launchpad.write);
  await lazurio.refresh();
  await chat.refresh();
  // The choice is off, and both pages read it. Chat turns them on and off
  // again; Lazurio's "on", made on the older view, arrives after both.
  launchpad.state.choice = "off";
  launchpad.state.version = 0;
  await lazurio.refresh();
  await chat.refresh();
  expect(await chat.set("on")).toBe(true);
  expect(await chat.set("off")).toBe(true);
  // Lazurio still holds version 0: its "on" arrives last and is refused.
  expect(await lazurio.set("on")).toBe(false);
  expect(launchpad.state.choice).toBe("off");
  expect(lazurio.current()).toBe("off");
  // Two clicks on one page go one after another, each on the newest version.
  const on = chat.set("on");
  const offAgain = chat.set("off");
  expect(await on).toBe(true);
  expect(await offAgain).toBe(true);
  expect(launchpad.state.choice).toBe("off");
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
  // Nor before the Launchpad has said the choice: a saved "off" may be on
  // its way.
  expect(shouldAskBuddyNotices({ ...facts, choice: null })).toBe(false);
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
