import type { ShellBuddySignal } from "./contract";

// The browser's notice of Buddy GEN4's sign (plan LZD-0033, the sign): the
// person's choice on each origin of the shell, never by itself. A notice
// says a change the page saw happen: `waiting` and `failed` always,
// `answered` only for a turn the person started, and only while Buddy's
// window is not in view. The bubble runs on several origins (the Launchpad,
// Chat, MausBot), each with its own permission and its own tabs, so the
// Launchpad decides which one tab tells it (`/.lazurio/buddy/notice`, the
// first claim of a change wins). Pure.

/** Where a tab claims the notice of a change. */
export const buddyNoticePath = "/.lazurio/buddy/notice";

/** The change a notice is about, or null where the sign is no notice: the
 * state, since when, and who started an answer, so an answer the person
 * started after one of a task's is told, and later turns of a task's are
 * neither told nor told twice. */
export function buddyNoticeKey(signal: ShellBuddySignal): string | null {
  if (signal.state === "waiting" || signal.state === "failed")
    return `${signal.state}:${signal.since ?? ""}`;
  if (signal.state === "answered" && signal.startedBy === "person")
    return `answered:${signal.since ?? ""}:person`;
  return null;
}

export type BuddyNoticeSeams = Readonly<{
  /** Whether the person chose notices on this origin and the browser
   * allows them. */
  enabled: () => boolean;
  /** Whether Buddy's window shows in this tab while the tab is in view. */
  inView: () => boolean;
  /** Claims the notice of `key` at the Launchpad: true for the one tab
   * that tells it. */
  claim: (key: string) => Promise<boolean>;
  /** Shows the notice. */
  show: (signal: ShellBuddySignal) => void;
}>;

/** Watches the sign a tab follows and tells each change once. The sign the
 * tab finds when it starts is no change. */
export function createBuddyNotifier(seams: BuddyNoticeSeams) {
  let seen = false;
  let last: string | null = null;
  return Object.freeze({
    async observe(signal: ShellBuddySignal): Promise<boolean> {
      // An unreadable moment neither tells nor forgets what was told.
      if (signal.state === "unavailable") return false;
      const key = buddyNoticeKey(signal);
      const first = !seen;
      seen = true;
      if (key === last) return false;
      last = key;
      if (first || key === null) return false;
      if (!seams.enabled() || seams.inView()) return false;
      if (!(await seams.claim(key).catch(() => false))) return false;
      seams.show(signal);
      return true;
    },
  });
}

/** How often a tab with Buddy's window in view says so, and how long the
 * Launchpad holds every notice back after it last did. */
export const buddyViewingEveryMs = 10_000;
export const buddyViewingHoldMs = 20_000;

/** The Launchpad's claims: the first claim of the current change wins; a
 * claim of anything but the current change, a second one, and every claim
 * while a tab on any origin has Buddy's window in view (`viewing`, said
 * every `buddyViewingEveryMs`) loses. Keeps the last few changes only. */
export function createBuddyNoticeClaims(
  current: () => ShellBuddySignal,
  now: () => number = Date.now,
) {
  const claimed: string[] = [];
  let viewedUntil = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    /** A tab has Buddy's window in view now. */
    viewing(): void {
      viewedUntil = now() + buddyViewingHoldMs;
    },
    claim(key: unknown): boolean {
      if (typeof key !== "string") return false;
      if (now() < viewedUntil) return false;
      if (buddyNoticeKey(current()) !== key) return false;
      if (claimed.includes(key)) return false;
      claimed.push(key);
      if (claimed.length > 32) claimed.shift();
      return true;
    },
  });
}
