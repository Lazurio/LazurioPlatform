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

/** The Launchpad's answer to a claim: whether this tab tells the notice,
 * and, where it lost only to a view said before the change (one the person
 * may have left while the claim was on its way), when to claim again. */
export type BuddyClaimAnswer = Readonly<{
  notify: boolean;
  retryInMs: number | null;
}>;

/** How soon a tab claims again a change held back by an older view. */
export const buddyClaimRetryMs = 1_000;

export type BuddyNoticeSeams = Readonly<{
  /** Whether the browser allows notices on this origin. The person's
   * choice for the Environment is the Launchpad's to apply: it refuses
   * every claim while the choice is off, whichever page last heard it. */
  enabled: () => boolean;
  /** Whether Buddy's window shows in this tab while the tab is in view. */
  inView: () => boolean;
  /** Claims the notice of `key` at the Launchpad. */
  claim: (key: string) => Promise<BuddyClaimAnswer>;
  /** Shows the notice. */
  show: (signal: ShellBuddySignal) => void;
  /** Says to the Launchpad that the person saw the change `key` here, in
   * Buddy's window in view as it came. */
  seen?: (key: string) => void;
  /** Waits before a claim again; a timer by default. */
  wait?: (ms: number) => Promise<void>;
}>;

const lost: BuddyClaimAnswer = Object.freeze({
  notify: false,
  retryInMs: null,
});

/** Watches the sign a tab follows and tells each change once. The sign the
 * tab finds when it starts is no change. A change that comes while Buddy's
 * window is in view here is seen, and the Launchpad hears so. A change held
 * back by another tab's view is claimed again, while it is still the sign,
 * until the Launchpad lets it through or says no. */
export function createBuddyNotifier(seams: BuddyNoticeSeams) {
  const wait =
    seams.wait ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
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
      // A view's hold ends by itself (`buddyViewingHoldMs`), so this ends.
      for (let attempt = 0; attempt < 64; attempt += 1) {
        if (last !== key) return false;
        if (seams.inView()) {
          seams.seen?.(key);
          return false;
        }
        if (!seams.enabled()) return false;
        const answer = await seams.claim(key).catch(() => lost);
        if (answer.notify) {
          seams.show(signal);
          return true;
        }
        if (answer.retryInMs === null) return false;
        await wait(Math.min(answer.retryInMs, buddyClaimRetryMs));
      }
      return false;
    },
  });
}

/** Reads the Launchpad's answer to a claim; anything else loses. */
export function parseBuddyClaimAnswer(value: unknown): BuddyClaimAnswer {
  if (typeof value !== "object" || value === null) return lost;
  const { notify, retryInMs } = value as Record<string, unknown>;
  return Object.freeze({
    notify: notify === true,
    retryInMs:
      notify !== true &&
      typeof retryInMs === "number" &&
      Number.isFinite(retryInMs) &&
      retryInMs > 0
        ? Math.min(retryInMs, buddyViewingHoldMs)
        : null,
  });
}

/** How often a tab with Buddy's window in view says so, and how long the
 * Launchpad holds every notice back after it last did. */
export const buddyViewingEveryMs = 10_000;
export const buddyViewingHoldMs = 20_000;

/** The Launchpad's claims: the first claim of the current change wins; a
 * claim of anything but the current change, a second one, every claim while
 * the person's choice is off, and every claim while a tab on any origin has
 * Buddy's window in view (`viewing`, said every `buddyViewingEveryMs`) loses.
 * Each tab holds its own view, and lets it go when the person leaves it
 * (`release`), so a window out of focus holds nothing back (#1151); a tab's
 * views and releases count in its own order (`seq`), so one overtaken on its
 * way is dropped. A claim lost only to a view is told when to come again
 * (`retryIn`), because the person may have left while it was on its way;
 * only the tab that had his window in view as the change came says the
 * person saw it (`seen`), and then no notice follows. Keeps the last few
 * changes and tabs only. */
export function createBuddyNoticeClaims(
  current: () => ShellBuddySignal,
  now: () => number = Date.now,
  allowed: () => boolean = () => true,
) {
  const claimed: string[] = [];
  const views = new Map<string, number>();
  const order = new Map<string, number>();
  const tabOf = (tab: unknown) =>
    typeof tab === "string" && tab.length > 0 && tab.length <= 64 ? tab : "";
  // Whether this event of the tab's comes after every one already heard.
  const inOrder = (tab: string, seq: unknown): boolean => {
    if (typeof seq !== "number" || !Number.isFinite(seq)) return true;
    if (seq <= (order.get(tab) ?? Number.NEGATIVE_INFINITY)) return false;
    order.delete(tab);
    order.set(tab, seq);
    if (order.size > 64) order.delete(order.keys().next().value ?? "");
    return true;
  };
  const live = () => {
    const at = now();
    for (const [tab, until] of views) if (until <= at) views.delete(tab);
    return at;
  };
  const open = (key: unknown): key is string =>
    typeof key === "string" &&
    allowed() &&
    buddyNoticeKey(current()) === key &&
    !claimed.includes(key);
  const take = (key: string) => {
    claimed.push(key);
    if (claimed.length > 32) claimed.shift();
  };
  return Object.freeze({
    /** A tab has Buddy's window in view now. */
    viewing(tab?: unknown, seq?: unknown): void {
      const name = tabOf(tab);
      if (!inOrder(name, seq)) return;
      views.delete(name);
      views.set(name, now() + buddyViewingHoldMs);
      if (views.size > 64) views.delete(views.keys().next().value ?? "");
    },
    /** That tab no longer has it in view: its hold ends now. */
    release(tab?: unknown, seq?: unknown): void {
      const name = tabOf(tab);
      if (inOrder(name, seq)) views.delete(name);
    },
    /** The person saw the change `key` in Buddy's window: no tab tells it. */
    seen(key: unknown): void {
      if (open(key)) take(key);
    },
    claim(key: unknown): boolean {
      live();
      if (!open(key) || views.size > 0) return false;
      take(key);
      return true;
    },
    /** After a lost claim of `key`: in how many ms to claim it again (when
     * the longest view's hold ends, at the latest), or null where it will
     * not be told. */
    retryIn(key: unknown): number | null {
      const at = live();
      if (!open(key) || views.size === 0) return null;
      return Math.max(Math.max(...views.values()) - at, 1);
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
  /** Sets the choice for the Environment, as made now. */
  choose: (choice: BuddyNoticesChoice) => Promise<unknown>;
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
  // The choice is saved as the person clicks, before the browser's question
  // opens: a choice made elsewhere while it is open is newer and stays.
  // Nothing awaits before the question, which the browser asks only inside
  // the click.
  const saved = seams.choose("on").catch(() => undefined);
  const answer =
    permission === "default" ? seams.request() : Promise.resolve(permission);
  seams.asked();
  const granted = (await answer.catch(() => "denied")) === "granted";
  await saved;
  return granted;
}

/** The Environment's choice, as the Launchpad holds it. */
export async function readLaunchpadNoticesChoice(): Promise<BuddyNoticesChoice> {
  const answer = await fetch(buddyNoticePath, { credentials: "same-origin" });
  if (!answer.ok) throw new Error("The choice was not read");
  const value: unknown = await answer.json();
  return (value as { choice?: unknown } | null)?.choice === "off"
    ? "off"
    : "on";
}

/** Saves the Environment's choice with the Launchpad, saying when the
 * person made it (now, as they click: the call is the click's), and
 * answers the choice the Launchpad holds after it, a newer one where this
 * one was overtaken on its way; throws where it did not save it. */
export async function writeLaunchpadNoticesChoice(
  choice: BuddyNoticesChoice,
): Promise<BuddyNoticesChoice> {
  const at = Date.now();
  const answer = await fetch(buddyNoticePath, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice, at }),
  });
  if (!answer.ok) throw new Error("The choice was not saved");
  const value: unknown = await answer.json().catch(() => null);
  const held = (value as { choice?: unknown } | null)?.choice;
  return held === "on" || held === "off" ? held : choice;
}

/** The seams of this page's browser and Launchpad. */
export const browserNoticesSeams = (
  store: Pick<Storage, "setItem"> | null,
): BuddyNoticesSeams => ({
  permission: () =>
    typeof Notification === "undefined" ? null : Notification.permission,
  request: () => Notification.requestPermission(),
  choose: writeLaunchpadNoticesChoice,
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
  read: () => Promise<BuddyNoticesChoice> = readLaunchpadNoticesChoice,
): Promise<BuddyNoticesState> {
  const choice = await read().catch((): BuddyNoticesChoice => "on");
  return buddyNoticesState(permission(), choice);
}

/** A page's copy of the Environment's choice: read from the Launchpad, set
 * by the person, and read again when the page comes back to the front. A
 * read that started before the person's newer choice never overwrites it,
 * and a choice the Launchpad failed to save goes back to what it holds. */
export function createNoticesChoiceCache(
  read: () => Promise<BuddyNoticesChoice>,
  write: (choice: BuddyNoticesChoice) => Promise<BuddyNoticesChoice>,
  changed: () => void = () => {},
) {
  let choice: BuddyNoticesChoice = "on";
  let version = 0;
  const refresh = async (): Promise<void> => {
    const at = version;
    const value = await read().catch(() => null);
    if (value === null || at !== version) return;
    if (value !== choice) {
      choice = value;
      changed();
    }
  };
  return Object.freeze({
    current: (): BuddyNoticesChoice => choice,
    refresh,
    /** The person's choice: shown at once, saved, and undone if the save
     * fails. True when the Launchpad saved it. */
    async set(next: BuddyNoticesChoice): Promise<boolean> {
      version += 1;
      const mine = version;
      if (next !== choice) {
        choice = next;
        changed();
      }
      try {
        // A newer choice made on another page may have won on the way.
        const held = await write(next);
        if (mine === version && held !== choice) {
          choice = held;
          changed();
        }
        return held === next;
      } catch {
        // A newer choice of the person's own stays; else the held one.
        if (mine === version) await refresh();
        return false;
      }
    },
  });
}
