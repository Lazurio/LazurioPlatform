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

/** The person's choice of notices, one for the Environment and held by the
 * Launchpad (`/.lazurio/buddy/notice`): on unless they turned it off. */
export type BuddyNoticesChoice = "on" | "off";

/** Where a tab remembers that it asked the browser for notices once: the
 * browser's permission is per origin, so is the asking. */
export const buddyNoticesAskedKey = "lazurio.buddy.notices.asked";

/** Whether to ask the browser for notices on the person's click that opens
 * Buddy's window: once per origin, only after the meeting, where the choice
 * is on and the browser has not answered yet. */
export const shouldAskBuddyNotices = (
  facts: Readonly<{
    permission: NotificationPermission | null;
    choice: BuddyNoticesChoice;
    asked: boolean;
    met: boolean;
  }>,
): boolean =>
  facts.met &&
  !facts.asked &&
  facts.choice === "on" &&
  facts.permission === "default";

export type BuddyNoticesSeams = Readonly<{
  /** The browser's permission now; null where it has no notices. */
  permission: () => NotificationPermission | null;
  /** The browser's question; called first, still inside the person's click. */
  request: () => Promise<NotificationPermission>;
  /** Sets the choice for the Environment. */
  choose: (choice: BuddyNoticesChoice) => Promise<void>;
  /** Remembers that this origin asked. */
  asked: () => void;
}>;

/** Turns Buddy's notices on, on the person's click: the guide's button, the
 * launcher's menu and the one question when his window first opens call
 * this one function. True when the browser allows them now. */
export async function enableBuddyNotices(
  seams: BuddyNoticesSeams,
): Promise<boolean> {
  const permission = seams.permission();
  if (permission === null) return false;
  // The browser asks only inside the click: nothing awaits before it.
  const answer =
    permission === "default" ? seams.request() : Promise.resolve(permission);
  seams.asked();
  const granted = (await answer.catch(() => "denied")) === "granted";
  await seams.choose("on").catch(() => undefined);
  return granted;
}

/** The seams of this page's browser and Launchpad. */
export const browserNoticesSeams = (
  store: Pick<Storage, "setItem"> | null,
): BuddyNoticesSeams => ({
  permission: () =>
    typeof Notification === "undefined" ? null : Notification.permission,
  request: () => Notification.requestPermission(),
  choose: async (choice) => {
    await fetch(buddyNoticePath, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choice }),
    });
  },
  asked: () => {
    try {
      store?.setItem(buddyNoticesAskedKey, new Date().toISOString());
    } catch {}
  },
});

/** What the person sees of Buddy's notices on this origin: `on` (they come),
 * `off` (not yet: the choice is off, or the browser has not been asked here),
 * `blocked` (the browser refuses them here) or `unsupported` (no notices). */
export type BuddyNoticesState = "on" | "off" | "blocked" | "unsupported";

/** The state from the browser's permission and the Environment's choice. */
export const buddyNoticesState = (
  permission: NotificationPermission | null,
  choice: BuddyNoticesChoice,
): BuddyNoticesState =>
  permission === null
    ? "unsupported"
    : permission === "denied"
      ? "blocked"
      : permission === "granted" && choice === "on"
        ? "on"
        : "off";

/** The state now, without asking: the choice read from the Launchpad (on
 * where it does not answer). For the guide and anything outside the
 * launcher's menu. */
export async function readBuddyNoticesState(
  permission: () => NotificationPermission | null = browserNoticesSeams(
    null,
  ).permission,
  read: () => Promise<BuddyNoticesChoice> = async () => {
    const answer = await fetch(buddyNoticePath, { credentials: "same-origin" });
    const value: unknown = answer.ok ? await answer.json() : null;
    return (value as { choice?: unknown } | null)?.choice === "off"
      ? "off"
      : "on";
  },
): Promise<BuddyNoticesState> {
  const choice = await read().catch((): BuddyNoticesChoice => "on");
  return buddyNoticesState(permission(), choice);
}
