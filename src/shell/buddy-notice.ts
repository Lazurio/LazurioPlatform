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
      if (key === null) return false;
      // What a tab finds as it starts is told by none, but where Buddy's
      // window is in view here, the person sees it now.
      if (first) {
        if (seams.inView()) seams.seen?.(key);
        return false;
      }
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
 * Launchpad holds every notice back after it last did, where the tab never
 * said the person left: 40 seconds from the last beat received, not from
 * when the person saw a change. A release ends the hold at once, so it is
 * this long only after a tab went silent.
 *
 * The tab's word that it saw a change or that the person left is retried
 * (`buddyDeliveryPausesMs`) on a best-effort basis; nothing guarantees that
 * it arrives before the hold ends. Where the beats stop, a change is seen
 * just before the hold ends and that word is then lost or delayed, another
 * tab may claim the change and tell it although the person already saw it.
 * The Owner accepted that limit (#1167, recorded in #1235): no finite hold
 * or retry schedule can rule it out without losing notices instead. */
export const buddyViewingEveryMs = 10_000;
export const buddyViewingHoldMs = 40_000;

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

/** The pauses between tries of a word the Launchpad should get (that the
 * person saw a change, that they left the window): together they fit within
 * a view's hold when the word is sent early in it. A word sent just before
 * the hold ends, or a send that fails or stalls, can still reach the
 * Launchpad after the hold, when another tab may already have claimed the
 * change (`buddyViewingHoldMs`; the accepted limit of #1235). */
export const buddyDeliveryPausesMs = [500, 1_000, 2_000, 4_000, 8_000] as const;

/** Sends a word to the Launchpad until it answers or the pauses above run
 * out (six tries at most); true once it answered, false when none did. */
export async function deliverBuddyNotice(
  send: () => Promise<boolean>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((done) => setTimeout(done, ms)),
): Promise<boolean> {
  if (await send().catch(() => false)) return true;
  for (const pause of buddyDeliveryPausesMs) {
    await wait(pause);
    if (await send().catch(() => false)) return true;
  }
  return false;
}

type BuddyNoticeClaims = ReturnType<typeof createBuddyNoticeClaims>;

/** What a tab tells the Launchpad besides a claim: its view (`viewing:
 * true`), the person leaving it (`viewing: false`), and the change it saw
 * (`seen`), which also rides on every view and release, so a release never
 * overtakes the tab's own word that it saw a change. Null for a claim. */
export function buddyNoticeTold(
  claims: BuddyNoticeClaims,
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, boolean>> | null {
  if (typeof body.seen === "string") claims.seen(body.seen);
  if (body.viewing === true) {
    claims.viewing(body.tab, body.seq);
    return { viewing: true };
  }
  if (body.viewing === false) {
    claims.release(body.tab, body.seq);
    return { viewing: false };
  }
  return typeof body.seen === "string" ? { seen: true } : null;
}

/** The Launchpad's answer to a claim of `key`: told, or not, and when to
 * claim again where only a view held it back. */
export function buddyNoticeAnswer(
  claims: BuddyNoticeClaims,
  key: unknown,
): Readonly<{ notify: boolean; retryInMs?: number }> {
  if (claims.claim(key)) return { notify: true };
  const retryInMs = claims.retryIn(key);
  return retryInMs === null ? { notify: false } : { notify: false, retryInMs };
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
    /** Null until the Launchpad has said it. */
    choice: BuddyNoticesChoice | null;
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

/** The Environment's choice as the Launchpad holds it, with its version
 * (`notices-choice.ts`). */
export type LaunchpadNoticesChoice = Readonly<{
  choice: BuddyNoticesChoice;
  version: number;
}>;

/** The answer to a change: the choice and version held after it, and
 * whether the page's change is the one held. */
export type LaunchpadNoticesWrite = LaunchpadNoticesChoice &
  Readonly<{ saved: boolean }>;

const parseLaunchpadChoice = (value: unknown): LaunchpadNoticesChoice => {
  const record =
    typeof value === "object" && value !== null
      ? (value as { choice?: unknown; version?: unknown })
      : {};
  if (typeof record.version !== "number")
    throw new Error("The Launchpad named no version");
  return {
    choice: record.choice === "off" ? "off" : "on",
    version: record.version,
  };
};

/** The Environment's choice, as the Launchpad holds it. */
export async function readLaunchpadNoticesChoice(): Promise<LaunchpadNoticesChoice> {
  const answer = await fetch(buddyNoticePath, { credentials: "same-origin" });
  if (!answer.ok) throw new Error("The choice was not read");
  return parseLaunchpadChoice(await answer.json());
}

/** Changes the choice of version `basis` with the Launchpad; throws where
 * it did not answer. Where another page changed it since, the Launchpad
 * keeps the newer choice and names it. */
export async function writeLaunchpadNoticesChoice(
  choice: BuddyNoticesChoice,
  basis: number,
): Promise<LaunchpadNoticesWrite> {
  const answer = await fetch(buddyNoticePath, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice, version: basis }),
  });
  if (!answer.ok) throw new Error("The choice was not saved");
  const value: unknown = await answer.json();
  return {
    ...parseLaunchpadChoice(value),
    saved: (value as { saved?: unknown }).saved === true,
  };
}

/** The seams of this page's browser and Launchpad. */
export const browserNoticesSeams = (
  store: Pick<Storage, "setItem"> | null,
): BuddyNoticesSeams => ({
  permission: () =>
    typeof Notification === "undefined" ? null : Notification.permission,
  request: () => Notification.requestPermission(),
  // A page that holds no copy of the choice reads it first.
  choose: async (choice) => {
    const { version } = await readLaunchpadNoticesChoice();
    return writeLaunchpadNoticesChoice(choice, version);
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
  read: () => Promise<BuddyNoticesChoice> = async () =>
    (await readLaunchpadNoticesChoice()).choice,
): Promise<BuddyNoticesState> {
  const choice = await read().catch((): BuddyNoticesChoice => "on");
  return buddyNoticesState(permission(), choice);
}

/** A page's copy of the Environment's choice: unknown until the Launchpad
 * first answers, read again when the page comes to the front, and changed
 * by the person's clicks one after another, each on the version last read.
 * A read that started before the person's newer change never overwrites
 * it; a change the Launchpad refused (another page changed the choice
 * first) or failed to save shows the choice the Launchpad holds. */
export function createNoticesChoiceCache(
  read: () => Promise<LaunchpadNoticesChoice>,
  write: (
    choice: BuddyNoticesChoice,
    basis: number,
  ) => Promise<LaunchpadNoticesWrite>,
  changed: () => void = () => {},
) {
  let choice: BuddyNoticesChoice = "on";
  let version: number | null = null;
  let edits = 0;
  let queue: Promise<unknown> = Promise.resolve();
  // An answer older than the version this page knows changes nothing: reads
  // and changes may come back in any order.
  const adopt = (record: LaunchpadNoticesChoice) => {
    if (version !== null && record.version < version) return;
    version = record.version;
    if (record.choice !== choice) {
      choice = record.choice;
      changed();
    }
  };
  const refresh = async (): Promise<void> => {
    const at = edits;
    const value = await read().catch(() => null);
    if (value !== null && at === edits) adopt(value);
  };
  return Object.freeze({
    current: (): BuddyNoticesChoice => choice,
    /** Whether the Launchpad has answered once: before, `current` is only
     * the default. */
    known: (): boolean => version !== null,
    refresh,
    /** The person's choice: shown at once, then saved on the version last
     * read. True when the Launchpad holds it. */
    set(next: BuddyNoticesChoice): Promise<boolean> {
      edits += 1;
      if (next !== choice) {
        choice = next;
        changed();
      }
      const done = queue.then(async () => {
        if (version === null) await refresh();
        try {
          const answer = await write(next, version ?? 0);
          adopt(answer);
          return answer.saved && answer.choice === next;
        } catch {
          await refresh();
          return false;
        }
      });
      queue = done.catch(() => undefined);
      return done;
    },
  });
}
