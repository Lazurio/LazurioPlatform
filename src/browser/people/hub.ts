import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Hold, type Holds, noHolds } from "../contract/node";
import type {
  AwakeReason,
  GraceKind,
  SleepReason,
  TabFacts,
  TabOpener,
} from "../contract/platform";
import {
  type BootTime,
  browserTimes,
  handOffAddress,
  navigableAddress,
  stripAppOf,
} from "../contract/pure";
import type { CdpConnection, CdpEvent } from "./cdp";
import type { CookieSweep } from "./cookies";
import {
  type PressureReading,
  pressureOrder,
  pressureTimes,
  underPressure,
} from "./pressure";
import {
  type ClientMessage,
  encodeFrame,
  type FrameHeader,
  type Picture,
  type ServerMessage,
  type ViewSize,
  viewSizeLimits,
} from "./protocol";
import {
  activityScript,
  addressKey,
  maxSleeping,
  parseSleepState,
  quietSince,
  type SleepRecord,
  sleepableAddress,
  sleepStateText,
  sleepTimes,
  unsavedInputScript,
} from "./sleep";

/** The view service's hold on the Environment browser (decision F39): every
 * page target with one DevTools session each, the people who view which tab,
 * and what the view does for them (frames, input, pop-ups, dialogs, file
 * choosers). It alone decides when a remote tab ends (F47 point 5): a tab
 * that a strip holds or an agent works in stays; one that nothing holds or
 * views ends after a grace. And when a tab sleeps (decision F57), held and
 * unused for the idle time, or under memory pressure: its remote tab closes
 * and the hub keeps its tombstone under the same id until someone views it
 * again. One hub per service; it reconnects whenever the browser goes
 * away. */

/** One person's socket on one tab. */
export type Viewer = {
  send: (message: ServerMessage) => void;
  sendFrame: (frame: Uint8Array) => void;
  /** Bytes the socket has not sent yet. */
  buffered: () => number;
  close: () => void;
  size: ViewSize | null;
  resize: boolean;
  /** The person's picture quality (F39's addendum of 2026-10-13): Standard
   * until the viewer's `hello` says otherwise. */
  picture: Picture;
  /** The page acknowledges the frames it is done with (its `hello` says
   * so); a page from before acknowledgements never does. */
  acks: boolean;
  /** False while the person's browser hides the page (decision F57): such a
   * viewer keeps its socket, but not its tab awake. Absent or true: shown,
   * as every page from before says nothing. */
  visible?: boolean;
};

export type HubSeams = Readonly<{
  /** Opens a DevTools connection to the browser target on loopback. */
  connect: () => Promise<CdpConnection>;
  /** Who holds which tab right now: the holder files and the agents that
   * work in a tab (F47 points 4 and 5). */
  holds: () => Promise<Holds>;
  /** Calls `changed` when the holds may have changed. `retry` is called on
   * every periodic read, for a directory that did not exist before. */
  watchHolds?: (
    changed: () => void,
  ) => Readonly<{ retry: () => void; stop: () => void }>;
  /** Writes the list of the browser's live page targets that the apps
   * reconcile their holds with (F47 point 4): one snapshot, `takenAt` being
   * the boot-clock time the hub began it. */
  writeTabs?: (ids: readonly string[], takenAt: BootTime) => Promise<void>;
  /** The Environment's boot clock, read before each snapshot; null where
   * there is none, and then no list is written. */
  bootClock?: () => Promise<BootTime | null>;
  /** Removes the cookies a Lazurio session leaves in the browser (#504,
   * `sweepCookies`), each time the hub reaches the browser: the view's
   * start, an upgrade, a restarted browser. */
  sweepCookies?: (cdp: CdpConnection) => Promise<CookieSweep>;
  /** Where uploaded files wait until the page reads them. */
  uploadDirectory: string;
  /** The virtual screen; no window grows past it. */
  screen: Readonly<{ width: number; height: number }>;
  log: (line: string) => void;
  /** Overridable for tests: after the last viewer of a tab nothing holds,
   * for a tab nobody has viewed or held yet, after the last hold or a close
   * for everyone (the window of Vrátit), between reads of the holds. */
  graceMs?: number;
  unviewedGraceMs?: number;
  releaseGraceMs?: number;
  holdsEveryMs?: number;
  reconnectMs?: number;
  /** Overridable for tests and measurements: how many frames a viewer that
   * acknowledges may have unacknowledged (`frameWindow`), and how long a
   * viewer may hold Chrome without progress before it no longer holds the
   * others (`stallMs`). */
  frameWindow?: number;
  stallMs?: number;
  /** What the hub writes down about sleeping tabs and the ids of the tabs
   * that woke (decision F57, `SleepState`), so a restart of the view keeps
   * them; absent, they live as long as the service. */
  sleepState?: Readonly<{
    read: () => Promise<string | null>;
    write: (text: string) => Promise<void>;
  }>;
  /** Overridable for tests: decision F57's times (`sleepTimes`). */
  idleSleepMs?: number;
  sleepCloseMs?: number;
  wakeRetryMs?: number;
  /** Memory pressure now (decision F57 point 6, `pressureSource`), read
   * every `pressureEveryMs`; absent, as off Linux, the pressure rule is
   * off. */
  pressure?: () => Promise<PressureReading>;
  /** Overridable for tests: the pressure rule's times (`pressureTimes`). */
  pressureEveryMs?: number;
  pressureCoolDownMs?: number;
  pressureQuietMs?: number;
}>;

/** What became of a request to put a tab to sleep (decision F57). */
export type SleepOutcome =
  | Readonly<{ kind: "asleep" }>
  | Readonly<{ kind: "awake"; reason: AwakeReason }>
  | Readonly<{ kind: "not-found" }>;

/** A new tab, or one of the same strip that shows the address already
 * (decision F57, no duplicate opens). */
export type OpenedTab = Readonly<{ id: string; reused: boolean }>;

// Who opened a tab (`TabOpener`), why a tab nothing holds or views counts
// down (`GraceKind`) and one tab as the loopback list reports it
// (`TabFacts`, F47 point 6) are the shapes of the contract's C11
// (src/browser/contract/platform.ts), which the hub and its client share.

type Info = {
  url: string;
  title: string;
  favicon: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

/** A screencast's frames: their largest size in pixels and JPEG quality. */
export type Screencast = Readonly<{
  width: number;
  height: number;
  quality: number;
}>;

/** One viewer's frames (F39's addendum of 2026-10-13): the newest it was
 * sent, those it has not acknowledged yet (oldest first, at most
 * `keptUnacked`), and since when it has held Chrome without progress. */
type Flow = {
  sent: number;
  unacked: number[];
  heldSince: number | null;
};

type Tab = {
  targetId: string;
  /** The tab's id as views, holder files and the lists name it: its target
   * id, or for a tab that woke from sleep the id it slept with (decision
   * F57). */
  id: string;
  sessionId: string | null;
  openerId: string | null;
  canAccessOpener: boolean;
  mainFrameId: string | null;
  info: Info;
  viewers: Set<Viewer>;
  screencast: Screencast | null;
  /** Chrome's screencast session, whose frames are acked with its number,
   * and how many of them Chrome still waits for an ack of: it sends three
   * frames without one, then one for each ack. */
  ackSession: number | null;
  owed: number;
  /** The frames' numbers in this tab (`FrameHeader.seq`), and the newest
   * frame, for a viewer that joins or has room for it again. */
  seq: number;
  lastFrame: Readonly<{ seq: number; bytes: Uint8Array }> | null;
  flows: Map<Viewer, Flow>;
  /** Opens the gate when a viewer that holds it stalls (`stallMs`). */
  ackTimer: ReturnType<typeof setTimeout> | null;
  /** A screencast frame came since the tab was last watched: the first
   * screenshot, if it is slower, is older and is not shown. */
  live: boolean;
  selection: string;
  dialog: Extract<ServerMessage, { t: "dialog" }> | null;
  lastActor: Viewer | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  infoTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  grace: Readonly<{ kind: GraceKind; endsAt: number }> | null;
  /** What kept the tab at the last review: a hold, a viewer, or nothing. */
  state: "held" | "viewed" | "idle";
  opener: TabOpener;
  openedAt: number;
  /** Last viewed, acted in or navigated. */
  usedAt: number;
  watched: boolean;
  attaching: boolean;
  /** The view's isolated world in the main frame, until it navigates. */
  world: number | null;
  /** Counts the main frame's documents: a read that a navigation overtook
   * belongs to the old document and is dropped. */
  document: number;
  /** A page opened by another, announced once its address is known. */
  pendingOpen: {
    openerId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  selectionTimer: ReturnType<typeof setTimeout> | null;
  /** Reads the title and icon while the tab is watched. */
  metaTimer: ReturnType<typeof setInterval> | null;
  /** The newest failed document requests of a watched tab, by their loader
   * id, with DevTools' error text: an error page that commits names the
   * same loader (#504). */
  failed: Map<string, string>;
  /** Decision F57's quiet clock, the hub's milliseconds: when a shown viewer
   * last viewed it, when an agent-browser daemon was last seen working in
   * it, when its page last navigated or had input, and when the hub last
   * found unsaved input in it (null: not at the last look). */
  viewedAt: number;
  agentAt: number;
  activeAt: number;
  unsavedAt: number | null;
  /** When the hub last asked its page to close (`Page.close`); the tab is
   * still awake, so its `beforeunload` objected or it did not answer. Its
   * quiet clock starts again, and the pressure rule leaves it alone for an
   * idle time (decision F57). 0 for never. */
  askedAt: number;
  /** The main frame's coming navigation is the page's own doing. */
  selfNavigation: boolean;
  /** The hub is looking whether the tab may sleep (decision F57). */
  checking: boolean;
  /** It is falling asleep: its page was asked to close. */
  fall: Readonly<{
    reason: SleepReason;
    done: (outcome: SleepOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
  }> | null;
};

/** A tab that sleeps (decision F57): its tombstone. While `falling` names a
 * live target, its page was asked to close and has not yet; once asleep it
 * has no target. `viewers` wait for it to wake: a viewer that came while it
 * fell asleep, or one whose page is hidden. */
type Sleeper = {
  record: SleepRecord;
  falling: string | null;
  /** The target it fell asleep from, the holds' change count when its page
   * was asked to close, and until when an agent that shows up in it wakes
   * it at once (decision F57: an agent that binds while it falls asleep
   * wins). */
  fellFrom: string | null;
  closeEpoch: number;
  agentWakesUntil: number;
  viewers: Set<Viewer>;
  waking: boolean;
  wakeTimer: ReturnType<typeof setTimeout> | null;
  /** What kept it at the last review, as a tab's `state`, and its grace
   * when nothing holds it (F47 point 5 applies to a tombstone too). */
  state: "held" | "viewed" | "idle";
  graceTimer: ReturnType<typeof setTimeout> | null;
  grace: Readonly<{ kind: GraceKind; endsAt: number }> | null;
  /** The grace a tab nothing held was counting down when it fell asleep:
   * its tombstone ends when the tab would have ended (F47 point 5), unless
   * a hold or a viewer comes first. */
  kept: Readonly<{ kind: GraceKind; endsAt: number }> | null;
};

/** Failed document requests remembered per tab: the navigation's own and a
 * few the error page retried. */
const keptFailures = 8;

/** Input or a navigation this soon after the last viewer left may still be
 * the person's (a page that loads slowly after their click): only later
 * does it count as an agent's (decision F57, `agentRecent`). */
const viewerSlackMs = 30_000;

/** The reasons Chrome gives (`Page.frameRequestedNavigation`) for a
 * navigation a page makes by itself: a refresh its meta tag or header asks
 * for, or its script. Such a navigation is no use of the tab (decision F57);
 * a form sent, a link followed or a navigation by DevTools is. */
const selfNavigations: ReadonlySet<string> = new Set([
  "metaTagRefresh",
  "httpHeaderRefresh",
  "scriptInitiated",
  "reload",
]);

type FileChooser = {
  targetId: string;
  backendNodeId: number;
  multiple: boolean;
};

const viewWorld = "lazurio-view";
// The page side of copy and cut (F39 point 6): the remote selection, read in
// an isolated world the page's own scripts cannot reach, whenever it may have
// changed (a released mouse button, a released key) and when the person
// presses Ctrl or ⌘, just before a copy. Read on demand rather than reported
// through a binding: a binding needs the Runtime domain enabled, which pages
// can detect as automation, and a person's sign-in must not look like one. A
// password field's selection is never sent.
const selectionScript = `(() => {
  const el = document.activeElement;
  let text = "";
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT") && typeof el.selectionStart === "number") {
    text = el.type === "password" ? "" : String(el.value).slice(el.selectionStart, el.selectionEnd);
  } else {
    text = String(document.getSelection() ?? "");
  }
  return text.length > 1000000 ? text.slice(0, 1000000) : text;
})()`;
// The page's title and icon. Chrome reports a target's title only as its
// address until the next navigation (no Target.targetInfoChanged for a
// `<title>` or a later change), so the view reads both from the page.
const metaScript = `(() => {
  const link = document.querySelector('link[rel~="icon"]');
  let icon = "";
  try { icon = link ? link.href : new URL("/favicon.ico", location.href).href; } catch {}
  return JSON.stringify({ title: String(document.title ?? ""), icon });
})()`;
const metaEveryMs = 2_000;
/** How long the list waits for one tab's heap (F47 point 7). */
const heapReadMs = 500;

const ackThreshold = 1 << 20;
/** Flow control (F39's addendum of 2026-10-13, #370). A viewer that
 * acknowledges its frames has at most `frameWindow` of them on the way, so
 * what the person sees lags the page by about that many frames, not by what
 * the buffers on the way hold; the newest frame waits in the hub for room.
 * Two, measured at 1 Mbit/s: one frame left the link idle for each round
 * trip (half the frames at a 200 ms round trip), three only added a frame's
 * lag. A viewer that holds Chrome for `stallMs` without progress (no ack, no
 * drain) no longer holds the others until it makes progress: long enough
 * for a Data saver frame (20–45 KiB) over 200 kbit/s or a Standard one
 * (50–130 KiB) over 1 Mbit/s, short enough that a hung or sleeping page
 * stops the others' picture only briefly. */
const frameWindow = 2;
const stallMs = 2_000;
/** Unacknowledged frames remembered per viewer: enough for any window, and
 * a bound for a viewer that never acknowledges. */
const keptUnacked = 32;

/** The frames of each picture quality (F39's addendum of 2026-10-13).
 * Standard: as they always were, the viewer's page area in device pixels
 * at JPEG quality 70. Data saver: two thirds of the area's CSS size at
 * quality 40, measured to send 2.9–3.8 times fewer bytes per frame while
 * text from 12 px stays readable drawn at full size. A scale, not a smaller
 * device pixel ratio: the Environment's Chrome draws at device scale 1 and a
 * screencast never sends a frame larger than the page's CSS size, so the
 * ratio alone makes no frame smaller. */
export const pictureFrames = Object.freeze({
  standard: Object.freeze({ quality: 70 }),
  saver: Object.freeze({ scale: 2 / 3, quality: 40 }),
});

/** The one screencast that serves every viewer of a tab: the most demanding
 * viewer wins. Each viewer that said its size asks for its frame (Standard:
 * its CSS size × its device pixel ratio; Data saver: two thirds of its CSS
 * size) at its quality, and the screencast takes the largest width, height
 * and quality asked, within the protocol's limits. Null while no viewer has
 * said its size. */
export function screencastFor(
  viewers: Iterable<Readonly<Pick<Viewer, "size" | "picture">>>,
): Screencast | null {
  let width = 0;
  let height = 0;
  let quality = 0;
  for (const { size, picture } of viewers) {
    if (size === null) continue;
    const scale = picture === "saver" ? pictureFrames.saver.scale : size.dpr;
    width = Math.max(width, Math.round(size.width * scale));
    height = Math.max(height, Math.round(size.height * scale));
    quality = Math.max(quality, pictureFrames[picture].quality);
  }
  if (width === 0) return null;
  return {
    width: Math.min(width, viewSizeLimits.maxWidth),
    height: Math.min(height, viewSizeLimits.maxHeight),
    quality,
  };
}

/** The size of a JPEG from its first start-of-frame marker; null when the
 * bytes are not a JPEG the parser understands. */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return {
        height: ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number),
        width: ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number),
      };
    i += 2 + length;
  }
  return null;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function clampSize(size: ViewSize): ViewSize {
  return {
    width: Math.round(
      clamp(size.width, viewSizeLimits.minWidth, viewSizeLimits.maxWidth),
    ),
    height: Math.round(
      clamp(size.height, viewSizeLimits.minHeight, viewSizeLimits.maxHeight),
    ),
    dpr: clamp(size.dpr, 1, viewSizeLimits.maxDpr),
  };
}

export class BrowserHub {
  private cdp: CdpConnection | null = null;
  /** The GitHub login of the browser's kept github.com sign-in at the last
   * sweep (#504); null without one, in a public Environment, or before. */
  private github: string | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tabs = new Map<string, Tab>();
  private readonly bySession = new Map<string, string>();
  private readonly fileChoosers = new Map<string, FileChooser>();
  /** Page targets discovery reported on the current connection. */
  private seen = new Set<string>();
  private discovered = false;
  /** The last read of the holder files and the agents' bindings. A read
   * that fails keeps the previous one, so a failure never lets a tab go. */
  private holds: Holds = noHolds;
  private holdsTimer: ReturnType<typeof setInterval> | null = null;
  private holdsSoon: ReturnType<typeof setTimeout> | null = null;
  private tabsSoon: ReturnType<typeof setTimeout> | null = null;
  /** A snapshot of the targets is being taken; another is wanted after it. */
  private snapshotting = false;
  private snapshotAgain = false;
  private watcher: Readonly<{ retry: () => void; stop: () => void }> | null =
    null;
  /** Closes for everyone that wait for their grace (F47 point 6), kept apart
   * from the tabs so a reconnect to the browser does not lose them. */
  private readonly closing = new Map<
    string,
    { endsAt: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  /** Who opened each tab and when, kept across a reconnect to the same
   * browser. Lost when the service restarts: the tabs from before are then
   * the opener's "unknown", or an agent's by its binding. */
  private readonly origins = new Map<
    string,
    Readonly<{ opener: TabOpener; openedAt: number }>
  >();
  /** The hub's own blank window: Chrome ends with its last window and the
   * unit starts it again, so one window always stays (F47 point 5). */
  private keeperId: string | null = null;
  private keeperCreating = false;
  /** Decision F57. Each live tab's target by its id, the tabs that sleep by
   * their id, and the id each woken tab's target keeps (kept across a
   * reconnect to the same browser, like `origins`, and written down with the
   * tombstones). */
  private readonly byId = new Map<string, string>();
  private readonly sleeping = new Map<string, Sleeper>();
  private readonly aliases = new Map<string, string>();
  /** The viewers that wait for a tab to wake, and the tab. */
  private readonly waiting = new Map<Viewer, Sleeper>();
  /** The browser's own id at the last connection, when it names one. */
  private browserId: string | null = null;
  /** Counts the changes the watch reports in the holder files and the
   * agents' bindings, at once, before they are read (decision F57): a sleep
   * whose checks saw the count change does not happen. */
  private holdsEpoch = 0;
  /** Opens of one strip and address under way (decision F57): a second
   * caller waits for the first one's tab. */
  private readonly opening = new Map<string, Promise<string | null>>();
  private stateRead = false;
  private sleepBusy = false;
  private persistSoon: ReturnType<typeof setTimeout> | null = null;
  private persisting = false;
  private persistAgain = false;
  /** The pressure rule (decision F57 point 6): its beat, whether the last
   * reading was under pressure, whether a beat is under way, and when the
   * rule last put a tab to sleep (its cool-down). */
  private pressureTimer: ReturnType<typeof setInterval> | null = null;
  private pressed = false;
  private pressureBusy = false;
  private pressureSleptAt = 0;
  private readonly graceMs: number;
  private readonly unviewedGraceMs: number;
  private readonly releaseGraceMs: number;
  private readonly holdsEveryMs: number;
  private readonly reconnectMs: number;
  private readonly frameWindow: number;
  private readonly stallMs: number;
  private readonly idleSleepMs: number;
  private readonly sleepCloseMs: number;
  private readonly wakeRetryMs: number;
  private readonly pressureEveryMs: number;
  private readonly pressureCoolDownMs: number;
  private readonly pressureQuietMs: number;

  constructor(private readonly seams: HubSeams) {
    this.graceMs = seams.graceMs ?? browserTimes.viewerGraceMs;
    this.unviewedGraceMs =
      seams.unviewedGraceMs ?? browserTimes.unviewedGraceMs;
    this.releaseGraceMs = seams.releaseGraceMs ?? browserTimes.releaseGraceMs;
    this.holdsEveryMs = seams.holdsEveryMs ?? browserTimes.holdsEveryMs;
    this.reconnectMs = seams.reconnectMs ?? browserTimes.reconnectMs;
    this.frameWindow = seams.frameWindow ?? frameWindow;
    this.stallMs = seams.stallMs ?? stallMs;
    this.idleSleepMs = seams.idleSleepMs ?? sleepTimes.idleMs;
    this.sleepCloseMs = seams.sleepCloseMs ?? sleepTimes.closeWaitMs;
    this.wakeRetryMs = seams.wakeRetryMs ?? sleepTimes.wakeRetryMs;
    this.pressureEveryMs = seams.pressureEveryMs ?? pressureTimes.readEveryMs;
    this.pressureCoolDownMs =
      seams.pressureCoolDownMs ?? pressureTimes.coolDownMs;
    this.pressureQuietMs = seams.pressureQuietMs ?? pressureTimes.quietMs;
  }

  get connected(): boolean {
    return this.cdp !== null;
  }

  /** Whom the browser's kept github.com sign-in names (#504): the login at
   * the last cookie sweep, or null. */
  get githubLogin(): string | null {
    return this.github;
  }

  /** Connected and discovery has reported every existing page: a target
   * the hub does not know now does not exist. */
  get ready(): boolean {
    return this.cdp !== null && this.discovered;
  }

  start(): void {
    this.stopped = false;
    this.watcher =
      this.seams.watchHolds?.(() => this.holdsChanged()) ?? this.watcher;
    // The holds are read and the list of live tabs written again on this
    // beat too: a record an app made after its tab ended meets a newer list
    // (F47 point 4).
    // On the same beat the idle rule looks for tabs to put to sleep
    // (decision F57), after the holds are read.
    this.holdsTimer = setInterval(() => {
      this.watcher?.retry();
      void this.refreshHolds().then(() => this.sleepIdle());
      this.publishTabs();
    }, this.holdsEveryMs);
    // The pressure rule reads its signals on a beat of its own (decision F57
    // point 6), only where there is a source of them.
    if (this.seams.pressure !== undefined)
      this.pressureTimer = setInterval(
        () => void this.pressureBeat(),
        this.pressureEveryMs,
      );
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.holdsTimer !== null) clearInterval(this.holdsTimer);
    if (this.pressureTimer !== null) clearInterval(this.pressureTimer);
    this.pressureTimer = null;
    if (this.holdsSoon !== null) clearTimeout(this.holdsSoon);
    if (this.tabsSoon !== null) clearTimeout(this.tabsSoon);
    this.tabsSoon = null;
    this.holdsTimer = null;
    this.holdsSoon = null;
    this.watcher?.stop();
    this.watcher = null;
    this.cdp?.close();
    this.cdp = null;
    for (const tab of this.tabs.values()) {
      this.clearTimers(tab);
      if (tab.fall !== null) clearTimeout(tab.fall.timer);
    }
    for (const sleeper of this.sleeping.values()) this.clearSleeper(sleeper);
    if (this.persistSoon !== null) clearTimeout(this.persistSoon);
    this.persistSoon = null;
    for (const entry of this.closing.values())
      if (entry.timer !== null) clearTimeout(entry.timer);
    this.closing.clear();
  }

  /** A new window of the default context, at the person's size when given:
   * the people's view's new tab (F39 point 1). Null when the browser cannot
   * be reached. */
  async createTab(size: ViewSize | null): Promise<string | null> {
    const fitted = size === null ? null : this.windowSize(clampSize(size));
    return this.newWindow(
      "about:blank",
      fitted === null ? {} : { width: fitted.width, height: fitted.height },
      { kind: "view" },
    );
  }

  /** A new window at an address, for Nová karta (F47 points 3 and 6): the
   * remote tab exists only from now. A tab of the same strip that shows the
   * same address already (all but its fragment) is that tab instead
   * (decision F57, `reusable`). Null when the address is not one the address
   * bar may open or the browser cannot be reached. */
  async openTab(url: string, strip: string | null): Promise<OpenedTab | null> {
    const address = navigableAddress(url);
    if (address === null) return null;
    const reused = this.reusable(address, strip);
    if (reused !== null) {
      this.seams.log(`reusing tab ${reused} for ${strip ?? "no strip"}`);
      return { id: reused, reused: true };
    }
    // The same address for the same strip while its tab is being opened:
    // the tab that open gives.
    const key = `${strip ?? ""} ${addressKey(address) ?? address}`;
    const under = this.opening.get(key);
    if (under !== undefined) {
      const id = await under;
      return id === null ? null : { id, reused: true };
    }
    const creating = this.newWindow(address, {}, { kind: "new-tab", strip });
    this.opening.set(key, creating);
    try {
      const id = await creating;
      return id === null ? null : { id, reused: false };
    } finally {
      if (this.opening.get(key) === creating) this.opening.delete(key);
    }
  }

  /** No duplicate opens (decision F57): the tab of `strip` that shows
   * `address` already, awake or asleep, compared by its origin, path and
   * query (`addressKey`); only the fragment does not count. A strip's tab is
   * one its holder file lists or one the hub opened for it and its app has
   * not recorded yet; for no strip, a page for the person that nothing
   * holds. The most recently used is taken, as it is: a reuse never
   * navigates a tab, so a different query, an agent's next search, opens a
   * tab of its own. */
  private reusable(address: string, strip: string | null): string | null {
    const key = addressKey(address);
    if (key === null) return null;
    const ofStrip = (ids: readonly string[], opener: TabOpener) => {
      const holds = this.holdsOf(...ids);
      if (strip === null)
        return (
          holds.length === 0 &&
          opener.kind === "new-tab" &&
          opener.strip === null
        );
      return (
        holds.some((hold) => hold.strip === strip) ||
        (opener.kind === "new-tab" && opener.strip === strip)
      );
    };
    const found: Readonly<{ id: string; usedAt: number }>[] = [];
    const consider = (id: string, usedAt: number) => found.push({ id, usedAt });
    for (const tab of this.tabs.values())
      if (
        tab.targetId !== this.keeperId &&
        !this.closing.has(tab.id) &&
        tab.fall === null &&
        addressKey(tab.info.url) === key &&
        ofStrip([tab.id, tab.targetId], tab.opener)
      )
        consider(tab.id, tab.usedAt);
    for (const sleeper of this.sleeping.values())
      if (
        sleeper.falling === null &&
        !this.closing.has(sleeper.record.id) &&
        addressKey(sleeper.record.url) === key &&
        ofStrip([sleeper.record.id], sleeper.record.opener)
      )
        consider(sleeper.record.id, sleeper.record.usedAt);
    const chosen = found.sort((a, b) => b.usedAt - a.usedAt)[0];
    if (chosen === undefined) return null;
    const tab = this.resolve(chosen.id);
    if (tab !== undefined) tab.usedAt = Date.now();
    return chosen.id;
  }

  private async newWindow(
    url: string,
    size: Readonly<{ width?: number; height?: number }>,
    opener: TabOpener,
  ): Promise<string | null> {
    const cdp = this.cdp;
    if (cdp === null) return null;
    try {
      const result = await cdp.send("Target.createTarget", {
        url,
        newWindow: true,
        ...size,
      });
      const targetId = String(result.targetId);
      const deadline = Date.now() + browserTimes.newTabWaitMs;
      while (!this.tabs.has(targetId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const tab = this.tabs.get(targetId);
      if (tab === undefined) return null;
      tab.opener = opener;
      this.origins.set(targetId, { opener, openedAt: tab.openedAt });
      this.review(tab);
      return targetId;
    } catch (error) {
      this.seams.log(`create tab failed: ${String(error)}`);
      return null;
    }
  }

  /** Every remote tab but the hub's own blank window, as the loopback list
   * reports it (F47 point 6). */
  list(): TabFacts[] {
    const iso = (ms: number) => new Date(ms).toISOString();
    const facts: TabFacts[] = [];
    // A page's opener by the id the lists know it by (decision F57).
    const opener = (of: TabOpener): TabOpener =>
      of.kind === "page"
        ? { kind: "page", openerId: this.idOfTarget(of.openerId) }
        : of;
    for (const tab of this.tabs.values()) {
      if (tab.targetId === this.keeperId) continue;
      const closing = this.closing.get(tab.id);
      const session = (this.holds.bound.get(tab.targetId) ??
        this.holds.bound.get(tab.id))?.[0];
      facts.push({
        id: tab.id,
        url: tab.info.url,
        title: tab.info.title,
        favicon: tab.info.favicon,
        openedAt: iso(tab.openedAt),
        usedAt: iso(tab.usedAt),
        opener:
          tab.opener.kind === "unknown" && session !== undefined
            ? { kind: "agent", session }
            : opener(tab.opener),
        agents: this.agentsOf(tab),
        holders: this.holdsOf(tab.id, tab.targetId),
        viewers: tab.viewers.size,
        closing: closing === undefined ? null : iso(closing.endsAt),
        grace:
          tab.grace === null
            ? null
            : { kind: tab.grace.kind, endsAt: iso(tab.grace.endsAt) },
        ...(tab.unsavedAt === null ? {} : { unsaved: iso(tab.unsavedAt) }),
      });
    }
    // Tabs that sleep (decision F57), listed as tabs by the id they keep.
    for (const sleeper of this.sleeping.values()) {
      if (sleeper.falling !== null) continue;
      const { record } = sleeper;
      const closing = this.closing.get(record.id);
      facts.push({
        id: record.id,
        url: record.url,
        title: record.title,
        favicon: record.favicon,
        openedAt: iso(record.openedAt),
        usedAt: iso(record.usedAt),
        opener: opener(record.opener),
        agents: [],
        holders: this.holdsOf(record.id),
        viewers: sleeper.viewers.size,
        closing: closing === undefined ? null : iso(closing.endsAt),
        grace:
          sleeper.grace === null
            ? null
            : { kind: sleeper.grace.kind, endsAt: iso(sleeper.grace.endsAt) },
        sleeping: { since: iso(record.sleptAt), reason: record.reason },
      });
    }
    return facts;
  }

  /** The list with each tab's JavaScript heap, which the overview shows as
   * the tab's memory marked "≈" (F47 point 7): `Runtime.getHeapUsage` on the
   * hub's own session of the tab. Like the reads in the isolated world
   * (`inWorld`) it needs no `Runtime.enable`, so a page sees nothing new.
   * The heap is its renderer's, so tabs that share a renderer show the same
   * one. Every tab at once, 500 ms each; a tab without a session, or whose
   * read fails or is late, has null. */
  async listWithHeap(): Promise<TabFacts[]> {
    const facts = this.list();
    const heaps = await Promise.all(facts.map((fact) => this.heap(fact.id)));
    return facts.map((fact, index) => ({
      ...fact,
      heap: heaps[index] ?? null,
    }));
  }

  private async heap(
    id: string,
  ): Promise<Readonly<{ used: number; total: number }> | null> {
    const cdp = this.cdp;
    // A tab that sleeps has no renderer and no heap.
    const session = this.resolve(id)?.sessionId ?? null;
    if (cdp === null || session === null) return null;
    let late: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        cdp.send("Runtime.getHeapUsage", {}, session),
        new Promise<null>((resolve) => {
          late = setTimeout(() => resolve(null), heapReadMs);
        }),
      ]);
      const used = answer?.usedSize;
      const total = answer?.totalSize;
      return typeof used === "number" &&
        typeof total === "number" &&
        Number.isFinite(used) &&
        Number.isFinite(total) &&
        used >= 0 &&
        total >= 0
        ? { used, total }
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(late);
    }
  }

  /** Closes a tab for everyone after the grace of Vrátit, held or not (F47
   * point 6). The time it ends; null for a tab the hub does not list. */
  closeForEveryone(id: string): number | null {
    // A tab that sleeps closes the same way (decision F57): its tombstone
    // goes at the end of the grace.
    const sleeper = this.sleeping.get(id);
    const tab = sleeper === undefined ? this.resolve(id) : undefined;
    if (sleeper === undefined && (tab === undefined || this.keeper(tab)))
      return null;
    const key = sleeper?.record.id ?? (tab as Tab).id;
    const pending = this.closing.get(key);
    if (pending !== undefined) return pending.endsAt;
    if (tab !== undefined) this.clearGrace(tab);
    if (sleeper !== undefined) this.clearSleeperGrace(sleeper);
    const endsAt = Date.now() + this.releaseGraceMs;
    this.closing.set(key, {
      endsAt,
      timer: setTimeout(() => void this.finishClose(key), this.releaseGraceMs),
    });
    this.seams.log(`closing tab ${key} for everyone`);
    return endsAt;
  }

  /** Vrátit: cancels a close for everyone or a grace. A tab that nothing
   * holds or views then has as long as a new one to be viewed or held. False
   * when the tab is gone or nothing was counting down. */
  restore(id: string): boolean {
    const sleeper = this.sleeping.get(id);
    const tab = sleeper === undefined ? this.resolve(id) : undefined;
    if (sleeper === undefined && tab === undefined) return false;
    const key = sleeper?.record.id ?? (tab as Tab).id;
    const pending = this.closing.get(key);
    if (pending !== undefined) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.closing.delete(key);
    } else if ((sleeper?.grace ?? tab?.grace ?? null) === null) return false;
    if (sleeper !== undefined) {
      this.clearSleeperGrace(sleeper);
      sleeper.state = "idle";
      this.reviewSleeper(sleeper, "unviewed");
    }
    if (tab !== undefined) {
      this.clearGrace(tab);
      tab.state = "idle";
      this.review(tab, "unviewed");
    }
    this.seams.log(`restored tab ${key}`);
    return true;
  }

  /** A tab of this id exists, awake or asleep. */
  hasTab(id: string): boolean {
    return this.resolve(id) !== undefined || this.sleeping.has(id);
  }

  /** Adds a person's socket to a tab. False when there is no such page. A
   * tab that sleeps wakes for a shown viewer (decision F57); the socket
   * waits for it. */
  attach(id: string, viewer: Viewer): boolean {
    const sleeper = this.sleeping.get(id);
    if (sleeper !== undefined && sleeper.falling === null) {
      this.waitFor(sleeper, viewer);
      const { record } = sleeper;
      viewer.send({
        t: "info",
        url: record.url,
        title: record.title,
        favicon: record.favicon,
        canGoBack: false,
        canGoForward: false,
        loading: true,
      });
      this.reviewSleeper(sleeper);
      if (this.shown(viewer)) void this.wake(sleeper);
      return true;
    }
    const tab = this.resolve(id);
    if (tab === undefined) return false;
    tab.viewers.add(viewer);
    tab.flows.set(viewer, { sent: 0, unacked: [], heldSince: null });
    tab.usedAt = Date.now();
    if (this.shown(viewer)) tab.viewedAt = tab.usedAt;
    this.review(tab);
    viewer.send({
      t: "browser",
      state:
        this.cdp !== null && tab.sessionId !== null
          ? "connected"
          : "reconnecting",
    });
    this.sendInfo(tab, viewer);
    if (tab.selection !== "")
      viewer.send({ t: "selection", text: tab.selection });
    if (tab.dialog !== null) viewer.send(tab.dialog);
    // Joining mid-stream: the newest frame now, numbered as any other.
    this.offer(tab, viewer);
    void this.watch(tab);
    return true;
  }

  detach(id: string, viewer: Viewer): void {
    const waiting = this.waiting.get(viewer);
    if (waiting !== undefined) {
      this.waiting.delete(viewer);
      waiting.viewers.delete(viewer);
      this.reviewSleeper(waiting);
      return;
    }
    const tab = this.resolve(id);
    if (tab === undefined) return;
    if (!tab.viewers.has(viewer)) return;
    if (this.shown(viewer)) tab.viewedAt = Date.now();
    tab.viewers.delete(viewer);
    tab.flows.delete(viewer);
    if (tab.lastActor === viewer) tab.lastActor = null;
    tab.usedAt = Date.now();
    if (tab.viewers.size > 0) {
      // A viewer that held Chrome no longer does.
      this.maybeAck(tab);
      void this.updateScreencast(tab);
      return;
    }
    void this.unwatch(tab);
    this.review(tab);
  }

  /** What a viewer says of itself: its page area, its choices and whether
   * its page is shown (decision F57). */
  private viewerSays(viewer: Viewer, message: ClientMessage): void {
    if (message.t === "hello" || message.t === "size") {
      viewer.size = clampSize(message);
      if (message.t === "hello") {
        viewer.resize = message.resize;
        viewer.picture = message.picture ?? "standard";
        viewer.acks = message.acks === true;
        viewer.visible = message.visible !== false;
      }
    } else if (message.t === "picture") viewer.picture = message.picture;
    else if (message.t === "visible") viewer.visible = message.visible;
  }

  /** Called when a viewer's socket drained: a viewer that was too far
   * behind for a frame gets the newest, and Chrome may go on. */
  drained(id: string): void {
    const tab = this.resolve(id);
    if (tab === undefined) return;
    for (const viewer of tab.viewers) this.offer(tab, viewer);
    this.maybeAck(tab);
  }

  async handle(
    id: string,
    viewer: Viewer,
    message: ClientMessage,
  ): Promise<void> {
    // A viewer that waits for a tab to wake (decision F57) says its size,
    // its choices and whether its page is shown; nothing else reaches a tab
    // that is not there.
    const waiting = this.waiting.get(viewer);
    if (waiting !== undefined) {
      this.viewerSays(viewer, message);
      if (this.shown(viewer) && waiting.falling === null)
        void this.wake(waiting);
      return;
    }
    const tab = this.resolve(id);
    if (tab === undefined) return;
    if (message.t === "visible") {
      // Viewed until now, or from now: the quiet clock starts when the last
      // shown viewer is hidden.
      if (this.shown(viewer) || message.visible) tab.viewedAt = Date.now();
      viewer.visible = message.visible;
      return;
    }
    if (message.t === "hello" || message.t === "size") {
      this.viewerSays(viewer, message);
      if (this.shown(viewer)) tab.viewedAt = Date.now();
      if (viewer.resize) tab.lastActor = viewer;
      this.scheduleResize(tab);
      await this.updateScreencast(tab);
      return;
    }
    if (message.t === "picture") {
      viewer.picture = message.picture;
      await this.updateScreencast(tab);
      return;
    }
    if (message.t === "ack") {
      this.acked(tab, viewer, message.frame);
      return;
    }
    // A person may act before the tab's session is attached (a new tab, a
    // reconnect): wait for it briefly rather than drop the input.
    const deadline = Date.now() + 3_000;
    while (
      (this.cdp === null || tab.sessionId === null) &&
      Date.now() < deadline &&
      this.tabs.get(tab.targetId) === tab
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId === null) return;
    const session = tab.sessionId;
    const targetId = tab.targetId;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, session).catch((error: unknown) => {
        this.seams.log(`${method} failed: ${String(error)}`);
        return null;
      });
    switch (message.t) {
      case "mouse": {
        this.acted(tab, viewer);
        if (message.type === "mouseReleased") this.selectionSoon(tab);
        await call("Input.dispatchMouseEvent", {
          type: message.type,
          x: message.x,
          y: message.y,
          button: message.button,
          buttons: message.buttons,
          clickCount: message.clickCount,
          modifiers: message.modifiers,
          ...(message.type === "mouseWheel"
            ? { deltaX: message.deltaX ?? 0, deltaY: message.deltaY ?? 0 }
            : {}),
        });
        return;
      }
      case "key": {
        this.acted(tab, viewer);
        if (
          message.type === "keyUp" ||
          message.key === "Control" ||
          message.key === "Meta"
        )
          this.selectionSoon(tab);
        const typing = message.type === "keyDown" && message.text !== undefined;
        await call("Input.dispatchKeyEvent", {
          type: typing
            ? "keyDown"
            : message.type === "keyDown"
              ? "rawKeyDown"
              : "keyUp",
          key: message.key,
          code: message.code,
          windowsVirtualKeyCode: message.keyCode,
          nativeVirtualKeyCode: message.keyCode,
          modifiers: message.modifiers,
          location: message.location,
          autoRepeat: message.repeat,
          isKeypad: message.location === 3,
          ...(typing
            ? { text: message.text, unmodifiedText: message.text }
            : {}),
        });
        return;
      }
      case "text":
        this.acted(tab, viewer);
        await call("Input.insertText", { text: message.text });
        return;
      case "touch":
        this.acted(tab, viewer);
        await call("Input.dispatchTouchEvent", {
          type: message.type,
          touchPoints: message.points.map((point) => ({
            x: point.x,
            y: point.y,
            id: point.id,
          })),
          modifiers: message.modifiers,
        });
        return;
      case "nav": {
        if (message.action === "reload") await call("Page.reload");
        else if (message.action === "stop") await call("Page.stopLoading");
        else {
          const history = await call("Page.getNavigationHistory");
          const index = Number(history?.currentIndex);
          const entries = (history?.entries ?? []) as { id: number }[];
          const entry =
            entries[message.action === "back" ? index - 1 : index + 1];
          if (entry !== undefined)
            await call("Page.navigateToHistoryEntry", { entryId: entry.id });
        }
        return;
      }
      case "goto": {
        const url = navigableAddress(message.url);
        if (url !== null) await call("Page.navigate", { url });
        return;
      }
      case "dialog":
        await call("Page.handleJavaScriptDialog", {
          accept: message.accept,
          ...(message.text === undefined ? {} : { promptText: message.text }),
        });
        return;
      case "files-cancel": {
        const chooser = this.fileChoosers.get(message.token);
        if (chooser === undefined || chooser.targetId !== targetId) return;
        this.fileChoosers.delete(message.token);
        this.broadcast(tab, { t: "files-closed", token: message.token });
        return;
      }
      case "close":
        await cdp
          .send("Target.closeTarget", { targetId })
          .catch(() => undefined);
        return;
    }
  }

  /** Puts uploaded files on the input that asked for them. False when the
   * token is unknown or the browser refused. */
  async upload(
    id: string,
    token: string,
    files: readonly File[],
  ): Promise<boolean> {
    const chooser = this.fileChoosers.get(token);
    const tab = this.resolve(id);
    const cdp = this.cdp;
    if (
      chooser === undefined ||
      tab === undefined ||
      chooser.targetId !== tab.targetId ||
      tab === undefined ||
      tab.sessionId === null ||
      cdp === null ||
      files.length === 0 ||
      (!chooser.multiple && files.length > 1)
    )
      return false;
    this.fileChoosers.delete(token);
    await this.sweepUploads();
    const directory = join(this.seams.uploadDirectory, token);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths: string[] = [];
    for (const [index, file] of files.entries()) {
      const name = basename(file.name).replace(/[^\w.@+-]/g, "_") || "file";
      const folder = join(directory, String(index));
      await mkdir(folder, { mode: 0o700 });
      const path = join(folder, name.slice(0, 200));
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), {
        mode: 0o600,
      });
      paths.push(path);
    }
    try {
      await cdp.send(
        "DOM.setFileInputFiles",
        { files: paths, backendNodeId: chooser.backendNodeId },
        tab.sessionId,
      );
    } catch (error) {
      this.seams.log(`setFileInputFiles failed: ${String(error)}`);
      return false;
    }
    this.broadcast(tab, { t: "files-closed", token });
    return true;
  }

  // ---- The connection ------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let cdp: CdpConnection;
    try {
      cdp = await this.seams.connect();
    } catch (error) {
      this.seams.log(`browser unreachable: ${String(error)}`);
      this.retry();
      return;
    }
    if (this.stopped) {
      cdp.close();
      return;
    }
    this.cdp = cdp;
    cdp.onEvent((event) => this.event(event));
    cdp.onClose(() => {
      if (this.cdp !== cdp) return;
      this.cdp = null;
      this.lost();
      this.retry();
    });
    this.seen = new Set();
    this.discovered = false;
    // Before discovery, so a woken tab is known by its own id at once
    // (decision F57).
    await this.sameBrowser(cdp.browser ?? null);
    if (this.cdp !== cdp) return;
    try {
      // Chrome reports every existing target before it answers.
      await cdp.send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      this.seams.log(`discover failed: ${String(error)}`);
      cdp.close();
      return;
    }
    this.seams.log("browser connected");
    if (this.seams.sweepCookies !== undefined) {
      try {
        const swept = await this.seams.sweepCookies(cdp);
        this.github = swept.github;
        if (swept.removed > 0)
          this.seams.log(
            `removed ${swept.removed} Lazurio session cookie(s) from the browser`,
          );
        if (swept.remaining > 0)
          this.seams.log(
            `${swept.remaining} Lazurio session cookie(s) could not be removed`,
          );
      } catch (error) {
        this.seams.log(`cookie sweep failed: ${String(error)}`);
      }
      if (this.cdp !== cdp) return;
    }
    // A tab kept across a reconnect whose page did not come back is gone,
    // or asleep when it was falling asleep (decision F57).
    for (const id of [...this.tabs.keys()])
      if (!this.seen.has(id)) this.gone(id);
    for (const sleeper of [...this.sleeping.values()]) {
      const target = sleeper.falling;
      // A tombstone written down while its page was still open (the view
      // stopped before the page closed): the page is the tab.
      if (target === null) {
        if (this.resolve(sleeper.record.id) !== undefined)
          this.dropSleeper(sleeper);
        continue;
      }
      // Still there: it stays awake.
      if (this.seen.has(target)) this.dropSleeper(sleeper);
      else this.asleep(sleeper);
    }
    for (const [id, entry] of [...this.closing])
      if (this.resolve(id) === undefined && !this.sleeping.has(id)) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        this.closing.delete(id);
      }
    // Ready once the holds are read too, so a tab is never judged by an
    // empty read.
    await this.refreshHolds();
    if (this.cdp !== cdp) return;
    this.discovered = true;
    this.publishTabs();
    // Someone waited for a tab to wake while the browser was away.
    for (const sleeper of this.sleeping.values())
      if ([...sleeper.viewers].some((viewer) => this.shown(viewer)))
        void this.wake(sleeper);
    if (this.keeperId !== null && !this.tabs.has(this.keeperId))
      this.keeperId = null;
    // A close for everyone whose grace ran out while the browser was away.
    for (const [id, entry] of this.closing)
      if (entry.timer === null) void this.finishClose(id);
    if (this.keeperId === null) {
      // The window Chrome started with, if nothing uses it.
      for (const tab of this.tabs.values())
        if (this.blank(tab) && tab.viewers.size === 0) {
          this.keeperId = tab.targetId;
          this.clearGrace(tab);
          break;
        }
    }
    void this.ensureKeeper();
  }

  private retry(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectMs);
  }

  /** The browser went away: every view waits, sessions are void. */
  private lost(): void {
    this.seams.log("browser connection lost");
    this.bySession.clear();
    for (const tab of this.tabs.values()) {
      // A page asked to close meanwhile: the reconnect tells whether it
      // fell asleep (decision F57); the request's answer cannot wait.
      if (tab.fall !== null) {
        clearTimeout(tab.fall.timer);
        tab.fall.done({ kind: "awake", reason: "busy" });
        tab.fall = null;
      }
      tab.sessionId = null;
      tab.screencast = null;
      this.forgetAcks(tab);
      tab.watched = false;
      tab.attaching = false;
      tab.world = null;
      if (tab.metaTimer !== null) clearInterval(tab.metaTimer);
      tab.metaTimer = null;
      for (const viewer of tab.viewers)
        viewer.send({ t: "browser", state: "reconnecting" });
    }
    // A target id does not survive a browser restart; ids that come back
    // are attached again by discovery. A tab falling asleep keeps its
    // tombstone, which the reconnect settles (decision F57).
    for (const [targetId, tab] of [...this.tabs])
      if (tab.viewers.size === 0) {
        this.clearTimers(tab);
        this.tabs.delete(targetId);
        if (this.byId.get(tab.id) === targetId) this.byId.delete(tab.id);
      }
  }

  private event(event: CdpEvent): void {
    const p = event.params;
    switch (event.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const info = p.targetInfo as Record<string, unknown> | undefined;
        if (info?.type !== "page") return;
        this.page(info, event.method === "Target.targetCreated");
        return;
      }
      case "Target.targetDestroyed":
        this.gone(String(p.targetId));
        return;
      case "Target.detachedFromTarget": {
        const targetId = this.bySession.get(String(p.sessionId));
        this.bySession.delete(String(p.sessionId));
        const tab =
          targetId === undefined ? undefined : this.tabs.get(targetId);
        if (tab !== undefined) {
          tab.sessionId = null;
          tab.screencast = null;
          this.forgetAcks(tab);
        }
        return;
      }
    }
    if (event.sessionId === undefined) return;
    const targetId = this.bySession.get(event.sessionId);
    const tab = targetId === undefined ? undefined : this.tabs.get(targetId);
    if (tab === undefined) return;
    this.pageEvent(tab, event);
  }

  private page(info: Record<string, unknown>, created: boolean): void {
    const targetId = String(info.targetId);
    let tab = this.tabs.get(targetId);
    const url = String(info.url ?? "");
    const title = String(info.title ?? "");
    if (tab === undefined) {
      const openerId = typeof info.openerId === "string" ? info.openerId : null;
      // Kept across a reconnect to the same browser; a new target is new.
      // An agent's window is named by its binding when the list is read.
      const now = Date.now();
      const origin = this.origins.get(targetId) ?? {
        opener:
          openerId !== null
            ? ({ kind: "page", openerId } as const)
            : ({ kind: "unknown" } as const),
        openedAt: now,
      };
      this.origins.set(targetId, origin);
      // A woken tab keeps the id it slept with (decision F57).
      const tabId = this.aliases.get(targetId) ?? targetId;
      tab = {
        targetId,
        id: tabId,
        sessionId: null,
        openerId,
        canAccessOpener: info.canAccessOpener === true,
        mainFrameId: null,
        info: {
          url,
          title,
          favicon: null,
          canGoBack: false,
          canGoForward: false,
          loading: false,
        },
        viewers: new Set(),
        screencast: null,
        ackSession: null,
        owed: 0,
        seq: 0,
        lastFrame: null,
        flows: new Map(),
        ackTimer: null,
        live: false,
        selection: "",
        dialog: null,
        lastActor: null,
        resizeTimer: null,
        infoTimer: null,
        graceTimer: null,
        grace: null,
        state: "idle",
        opener: origin.opener,
        openedAt: origin.openedAt,
        usedAt: now,
        watched: false,
        attaching: false,
        world: null,
        document: 0,
        pendingOpen: null,
        failed: new Map(),
        selectionTimer: null,
        metaTimer: null,
        viewedAt: 0,
        agentAt: 0,
        activeAt: 0,
        unsavedAt: null,
        askedAt: 0,
        selfNavigation: false,
        checking: false,
        fall: null,
      };
      this.tabs.set(targetId, tab);
      this.byId.set(tabId, targetId);
      this.publishTabs();
      if (created && openerId !== null) this.opened(tab, openerId);
      // The tab a sleeping one woke into: its viewers move to it.
      const waking = this.sleeping.get(tabId);
      if (tabId !== targetId && waking !== undefined) this.adopt(waking, tab);
      else this.review(tab);
    } else {
      // Chrome's target title is only the address (see metaScript): it is
      // taken with a new address, and the page's own title follows.
      if (url !== tab.info.url) {
        tab.info.title = title;
        tab.usedAt = Date.now();
      }
      tab.info.url = url;
      this.queueInfo(tab);
      if (tab.pendingOpen !== null && url !== "" && url !== "about:blank")
        this.announce(tab, tab.pendingOpen.openerId);
      if (targetId === this.keeperId && !this.blank(tab)) {
        // Someone used the hub's blank window: it is a tab like any other
        // now, and the hub opens another.
        this.keeperId = null;
        this.review(tab);
        this.publishTabs();
        void this.ensureKeeper();
      }
    }
    this.seen.add(targetId);
    if (tab.sessionId === null) void this.attachSession(tab);
  }

  /** A page opened by another (F39 point 4): a pop-up over its opener's
   * view, or a new tab to offer. Chrome reports it before it has an
   * address, so it is announced at its first address, or after 1.5 s. */
  private opened(tab: Tab, openerId: string): void {
    if (!this.tabs.has(openerId)) return;
    if (tab.info.url !== "" && tab.info.url !== "about:blank") {
      this.announce(tab, openerId);
      return;
    }
    tab.pendingOpen = {
      openerId,
      timer: setTimeout(() => this.announce(tab, openerId), 1_500),
    };
  }

  private announce(tab: Tab, openerId: string): void {
    if (tab.pendingOpen !== null) clearTimeout(tab.pendingOpen.timer);
    tab.pendingOpen = null;
    const opener = this.tabs.get(openerId);
    if (opener === undefined || !this.tabs.has(tab.targetId)) return;
    this.broadcast(
      opener,
      tab.canAccessOpener
        ? { t: "popup", id: tab.targetId, url: tab.info.url }
        : { t: "new-tab", id: tab.targetId, url: tab.info.url },
    );
  }

  private async attachSession(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId !== null || tab.attaching) return;
    tab.attaching = true;
    let sessionId: string;
    try {
      const result = await cdp.send("Target.attachToTarget", {
        targetId: tab.targetId,
        flatten: true,
      });
      sessionId = String(result.sessionId);
    } catch {
      tab.attaching = false;
      return;
    }
    tab.attaching = false;
    if (this.cdp !== cdp || !this.tabs.has(tab.targetId)) return;
    tab.sessionId = sessionId;
    this.bySession.set(sessionId, tab.targetId);
    const call = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, sessionId);
    try {
      // Every page, watched or not: dialogs and file choosers are never
      // left to Chrome's own windows (F39 point 7).
      await call("Page.enable");
      await call("Page.setInterceptFileChooserDialog", { enabled: true });
      const tree = await call("Page.getFrameTree");
      const frame = (tree.frameTree as { frame?: { id?: unknown } })?.frame;
      tab.mainFrameId = typeof frame?.id === "string" ? frame.id : null;
      await this.history(tab);
      // The page's input counts from now (decision F57).
      this.listenForInput(tab, tab.info.url);
    } catch (error) {
      this.seams.log(`attach ${tab.targetId} incomplete: ${String(error)}`);
    }
    if (tab.viewers.size > 0) {
      this.broadcast(tab, { t: "browser", state: "connected" });
      await this.watch(tab);
    }
  }

  // ---- A watched tab -------------------------------------------------------

  /** First viewer: focus without stealing the window, the selection
   * reporter, frames. */
  private async watch(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    const session = tab.sessionId;
    if (cdp === null || session === null || tab.watched) return;
    tab.watched = true;
    tab.live = false;
    const call = (method: string, params: Record<string, unknown> = {}) =>
      cdp.send(method, params, session).catch((error: unknown) => {
        this.seams.log(`${method} failed: ${String(error)}`);
        return null;
      });
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    // A navigation the browser's policy blocks is handed off to the viewer's
    // own browser (#504); only the Network domain says why a navigation
    // failed. Nothing of the pages' bodies is kept for it.
    await call("Network.enable", {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    });
    await this.meta(tab);
    if (tab.metaTimer === null && tab.watched)
      tab.metaTimer = setInterval(() => void this.meta(tab), metaEveryMs);
    await this.firstFrame(tab);
    await this.updateScreencast(tab);
  }

  private async unwatch(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    const session = tab.sessionId;
    tab.watched = false;
    if (tab.metaTimer !== null) clearInterval(tab.metaTimer);
    tab.metaTimer = null;
    // A frame of a tab nobody views is not kept: the next viewer gets a
    // fresh screenshot (`firstFrame`).
    tab.lastFrame = null;
    if (tab.resizeTimer !== null) clearTimeout(tab.resizeTimer);
    tab.resizeTimer = null;
    tab.failed.clear();
    if (cdp !== null && session !== null)
      void cdp.send("Network.disable", {}, session).catch(() => undefined);
    if (cdp === null || session === null || tab.screencast === null) return;
    tab.screencast = null;
    this.forgetAcks(tab);
    await cdp.send("Page.stopScreencast", {}, session).catch(() => undefined);
  }

  /** Runs a script in the view's isolated world of the main frame: one
   * world per document, made again after a navigation or when Chrome no
   * longer knows it. */
  private async inWorld(tab: Tab, expression: string): Promise<unknown> {
    const cdp = this.cdp;
    const session = tab.sessionId;
    if (cdp === null || session === null || tab.mainFrameId === null)
      return undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (tab.world === null) {
          const world = await cdp.send(
            "Page.createIsolatedWorld",
            { frameId: tab.mainFrameId, worldName: viewWorld },
            session,
          );
          tab.world = Number(world.executionContextId);
        }
        const result = await cdp.send(
          "Runtime.evaluate",
          { expression, contextId: tab.world, returnByValue: true },
          session,
        );
        return (result.result as { value?: unknown } | undefined)?.value;
      } catch {
        tab.world = null;
      }
    }
    return undefined;
  }

  /** Reads the remote selection soon, once for a burst of input. */
  private selectionSoon(tab: Tab): void {
    if (tab.selectionTimer !== null) return;
    tab.selectionTimer = setTimeout(() => {
      tab.selectionTimer = null;
      const document = tab.document;
      void this.inWorld(tab, selectionScript).then((value) => {
        // A navigation overtook the read: it is the old document's text.
        if (tab.document !== document) return;
        if (typeof value !== "string" || value === tab.selection) return;
        tab.selection = value;
        this.broadcast(tab, { t: "selection", text: value });
      });
    }, 40);
  }

  private async meta(tab: Tab): Promise<void> {
    const document = tab.document;
    const value = await this.inWorld(tab, metaScript);
    if (tab.document !== document || typeof value !== "string") return;
    let read: { title?: unknown; icon?: unknown };
    try {
      read = JSON.parse(value) as { title?: unknown; icon?: unknown };
    } catch {
      return;
    }
    const title =
      typeof read.title === "string" ? read.title.slice(0, 500) : "";
    const icon =
      typeof read.icon === "string" && read.icon.startsWith("https://")
        ? read.icon
        : null;
    if (title !== "" && title !== tab.info.title) {
      tab.info.title = title;
      this.queueInfo(tab);
    }
    if (icon !== tab.info.favicon) {
      tab.info.favicon = icon;
      this.queueInfo(tab);
    }
  }

  private async history(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId === null) return;
    try {
      const history = await cdp.send(
        "Page.getNavigationHistory",
        {},
        tab.sessionId,
      );
      const index = Number(history.currentIndex);
      const count = Array.isArray(history.entries) ? history.entries.length : 0;
      tab.info.canGoBack = index > 0;
      tab.info.canGoForward = index < count - 1;
      this.queueInfo(tab);
    } catch {}
  }

  /** A screenshot right away, so a new viewer does not wait for the page's
   * next paint: at the quality of the viewers that said their choice,
   * Standard's before any has. */
  private async firstFrame(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId === null) return;
    const quality =
      screencastFor(tab.viewers)?.quality ?? pictureFrames.standard.quality;
    try {
      const [shot, metrics] = await Promise.all([
        cdp.send(
          "Page.captureScreenshot",
          { format: "jpeg", quality },
          tab.sessionId,
        ),
        cdp.send("Page.getLayoutMetrics", {}, tab.sessionId),
      ]);
      const viewport = metrics.cssVisualViewport as
        | { clientWidth?: number; clientHeight?: number }
        | undefined;
      const jpeg = Buffer.from(String(shot.data), "base64");
      const size = jpegSize(jpeg);
      if (size === null || viewport === undefined || tab.live) return;
      this.deliver(
        tab,
        {
          width: size.width,
          height: size.height,
          deviceWidth: Number(viewport.clientWidth),
          deviceHeight: Number(viewport.clientHeight),
          offsetTop: 0,
          pageScaleFactor: 1,
        },
        jpeg,
      );
    } catch {}
  }

  /** (Re)starts the screencast that serves every viewer (`screencastFor`)
   * whenever its size or its quality changes, once per change. */
  private async updateScreencast(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    const session = tab.sessionId;
    if (cdp === null || session === null || !tab.watched) return;
    // Only viewers that said their size (`hello` comes right after the
    // socket opens): no screencast at a guessed size to restart a moment
    // later.
    const wanted = screencastFor(tab.viewers);
    if (wanted === null) return;
    const before = tab.screencast;
    if (
      before !== null &&
      before.width === wanted.width &&
      before.height === wanted.height &&
      before.quality === wanted.quality
    )
      return;
    // Recorded before the awaits, so a second change meanwhile (a `hello`
    // and a `picture` at once) restarts it once more, never twice for one.
    tab.screencast = wanted;
    this.forgetAcks(tab);
    if (before !== null)
      await cdp.send("Page.stopScreencast", {}, session).catch(() => undefined);
    // A later change took over while Chrome stopped: it starts its own.
    if (tab.screencast !== wanted) return;
    await cdp
      .send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: wanted.quality,
          maxWidth: wanted.width,
          maxHeight: wanted.height,
          everyNthFrame: 1,
        },
        session,
      )
      .catch((error: unknown) => {
        if (tab.screencast === wanted) tab.screencast = null;
        this.seams.log(`startScreencast failed: ${String(error)}`);
      });
  }

  /** A new frame of the tab, numbered, for every viewer with room for it. */
  private deliver(tab: Tab, header: FrameHeader, jpeg: Uint8Array): void {
    tab.seq += 1;
    tab.lastFrame = {
      seq: tab.seq,
      bytes: encodeFrame({ ...header, seq: tab.seq }, jpeg),
    };
    for (const viewer of tab.viewers) this.offer(tab, viewer);
  }

  /** Sends a viewer the tab's newest frame when it does not have it yet and
   * has room for it (F39's addendum of 2026-10-13). A viewer that
   * acknowledges its frames has room for `frameWindow` unacknowledged ones:
   * past them the newest frame waits here for its next ack, and older ones
   * it never needs are not sent. Any viewer far behind (4 MiB waiting in its
   * socket) gets nothing until it drains: the bound of the service's memory.
   * A page from before acknowledgements gets every frame, as before. */
  private offer(tab: Tab, viewer: Viewer): void {
    const frame = tab.lastFrame;
    const flow = tab.flows.get(viewer);
    if (frame === null || flow === undefined || flow.sent >= frame.seq) return;
    if (viewer.buffered() >= 4 * ackThreshold) return;
    if (viewer.acks && flow.unacked.length >= this.frameWindow) return;
    viewer.sendFrame(frame.bytes);
    flow.sent = frame.seq;
    flow.unacked.push(frame.seq);
    if (flow.unacked.length > keptUnacked) flow.unacked.shift();
  }

  /** The viewer is done with every frame up to `seq`: it has room again for
   * the newest frame, and Chrome may go on. A number it was never sent is
   * ignored. */
  private acked(tab: Tab, viewer: Viewer, seq: number): void {
    const flow = tab.flows.get(viewer);
    if (flow === undefined || seq > flow.sent) return;
    while (flow.unacked.length > 0 && (flow.unacked[0] as number) <= seq)
      flow.unacked.shift();
    // Progress: its stall clock starts again should it hold Chrome anew.
    flow.heldSince = null;
    this.offer(tab, viewer);
    this.maybeAck(tab);
  }

  /** Chrome sends three frames without an ack and then one for each ack: it
   * makes the next frame only when it is acked. Acked here only as far as
   * every viewer has room for what comes (F39's addendum of 2026-10-13): a
   * viewer that acknowledges has fewer than `frameWindow` frames
   * unacknowledged, and every viewer has less than 1 MiB waiting in its
   * socket. A page from before acknowledgements holds Chrome only by those
   * 1 MiB, as before. A viewer that holds Chrome for `stallMs` without
   * progress (a hung or sleeping page, a link that carries nothing) holds the
   * others no longer, until it acks or drains again; it gets no more frames
   * than its room meanwhile. With every viewer stalled, Chrome waits: nobody
   * would see what it draws. */
  private maybeAck(tab: Tab): void {
    if (tab.ackTimer !== null) clearTimeout(tab.ackTimer);
    tab.ackTimer = null;
    const cdp = this.cdp;
    const session = tab.sessionId;
    const ackSession = tab.ackSession;
    // Whether Chrome waits for an ack: only then does a viewer without room
    // hold it, and only then does its stall clock run.
    const waiting =
      cdp !== null && session !== null && ackSession !== null && tab.owed > 0;
    const now = Date.now();
    let room = Number.POSITIVE_INFINITY;
    let someone = false;
    let stallsAt = Number.POSITIVE_INFINITY;
    for (const viewer of tab.viewers) {
      const flow = tab.flows.get(viewer);
      if (flow === undefined) continue;
      const free =
        viewer.buffered() >= ackThreshold
          ? 0
          : viewer.acks
            ? Math.max(0, this.frameWindow - flow.unacked.length)
            : Number.POSITIVE_INFINITY;
      if (free > 0) {
        flow.heldSince = null;
        someone = true;
        room = Math.min(room, free);
        continue;
      }
      if (!waiting) continue;
      flow.heldSince ??= now;
      const stalls = flow.heldSince + this.stallMs;
      if (now >= stalls) continue;
      someone = true;
      room = 0;
      stallsAt = Math.min(stallsAt, stalls);
    }
    if (!waiting) return;
    if (stallsAt !== Number.POSITIVE_INFINITY)
      tab.ackTimer = setTimeout(
        () => {
          tab.ackTimer = null;
          this.maybeAck(tab);
        },
        stallsAt - now + 1,
      );
    if (!someone || room === 0) return;
    const acks = Math.min(tab.owed, room);
    tab.owed -= acks;
    for (let i = 0; i < acks; i++)
      void cdp
        .send("Page.screencastFrameAck", { sessionId: ackSession }, session)
        .catch(() => undefined);
  }

  /** A new screencast, or none: Chrome forgets the acks it waited for. */
  private forgetAcks(tab: Tab): void {
    tab.ackSession = null;
    tab.owed = 0;
    if (tab.ackTimer !== null) clearTimeout(tab.ackTimer);
    tab.ackTimer = null;
  }

  private pageEvent(tab: Tab, event: CdpEvent): void {
    const p = event.params;
    switch (event.method) {
      case "Page.screencastFrame": {
        const metadata = (p.metadata ?? {}) as Record<string, number>;
        const jpeg = Buffer.from(String(p.data), "base64");
        const size = jpegSize(jpeg);
        // Every frame of one screencast carries its session's number.
        tab.ackSession = Number(p.sessionId);
        tab.owed += 1;
        tab.live = true;
        if (size !== null && tab.watched)
          this.deliver(
            tab,
            {
              width: size.width,
              height: size.height,
              deviceWidth: Number(metadata.deviceWidth),
              deviceHeight: Number(metadata.deviceHeight),
              offsetTop: Number(metadata.offsetTop ?? 0),
              pageScaleFactor: Number(metadata.pageScaleFactor ?? 1),
            },
            jpeg,
          );
        this.maybeAck(tab);
        return;
      }
      case "Network.loadingFailed": {
        if (p.type !== "Document" || typeof p.requestId !== "string") return;
        tab.failed.delete(p.requestId);
        tab.failed.set(p.requestId, String(p.errorText ?? ""));
        while (tab.failed.size > keptFailures) {
          const oldest = tab.failed.keys().next().value;
          if (oldest === undefined) break;
          tab.failed.delete(oldest);
        }
        return;
      }
      case "Page.frameNavigated": {
        const frame = p.frame as
          | {
              id?: string;
              parentId?: string;
              loaderId?: string;
              unreachableUrl?: string;
            }
          | undefined;
        if (frame?.parentId !== undefined) return;
        if (typeof frame?.id === "string") tab.mainFrameId = frame.id;
        // An error page for a navigation the browser's policy blocked: the
        // page of a person's Lazurio account, which opens only in their own
        // browser (#504). The view offers it there and never opens it here.
        if (
          typeof frame?.loaderId === "string" &&
          frame.unreachableUrl !== undefined
        ) {
          const url = handOffAddress(
            tab.failed.get(frame.loaderId),
            frame.unreachableUrl,
          );
          if (url !== null) this.broadcast(tab, { t: "hand-off", url });
        }
        tab.world = null;
        tab.document += 1;
        // A navigation is use (decision F57), unless the page made it itself
        // (a refresh by its meta tag or header, or its script), and the new
        // document's input counts from now.
        if (!tab.selfNavigation) tab.activeAt = Date.now();
        tab.selfNavigation = false;
        this.listenForInput(
          tab,
          typeof (frame as { url?: unknown } | undefined)?.url === "string"
            ? String((frame as { url: string }).url)
            : tab.info.url,
        );
        // A new document has no selection: a copy must not take the old one.
        if (tab.selection !== "") {
          tab.selection = "";
          this.broadcast(tab, { t: "selection", text: "" });
        }
        void this.history(tab);
        return;
      }
      case "Page.navigatedWithinDocument":
        void this.history(tab);
        if (tab.watched) void this.meta(tab);
        return;
      case "Page.frameRequestedNavigation":
        // Chrome reports a navigation the page itself asks for; one an
        // agent or the view makes with `Page.navigate` it does not.
        if (p.frameId === tab.mainFrameId)
          tab.selfNavigation = selfNavigations.has(String(p.reason));
        return;
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading": {
        if (p.frameId !== tab.mainFrameId) return;
        tab.info.loading = event.method === "Page.frameStartedLoading";
        this.queueInfo(tab);
        return;
      }
      case "Page.loadEventFired":
      case "Page.domContentEventFired":
        if (tab.watched) void this.meta(tab);
        return;
      case "Page.javascriptDialogOpening": {
        const type = String(p.type);
        // The page objects to closing while it falls asleep: it has unsaved
        // work, and it stays awake (decision F57). Nobody views it, so the
        // hub answers "stay" itself.
        if (type === "beforeunload" && tab.fall !== null) {
          const cdp = this.cdp;
          const session = tab.sessionId;
          if (cdp !== null && session !== null)
            void cdp
              .send("Page.handleJavaScriptDialog", { accept: false }, session)
              .catch(() => undefined);
          tab.unsavedAt = Date.now();
          this.fell(tab, { kind: "awake", reason: "unsaved" });
          return;
        }
        tab.dialog = {
          t: "dialog",
          kind:
            type === "confirm" || type === "prompt" || type === "beforeunload"
              ? type
              : "alert",
          message: String(p.message ?? ""),
          defaultPrompt: String(p.defaultPrompt ?? ""),
        };
        this.broadcast(tab, tab.dialog);
        return;
      }
      case "Page.javascriptDialogClosed":
        tab.dialog = null;
        this.broadcast(tab, { t: "dialog-closed" });
        return;
      case "Page.fileChooserOpened": {
        if (tab.viewers.size === 0) {
          // Nobody to pick a file: dropped, never Chrome's own window.
          this.seams.log(`file chooser on ${tab.targetId} with no viewer`);
          return;
        }
        const token = randomBytes(12).toString("hex");
        this.fileChoosers.set(token, {
          targetId: tab.targetId,
          backendNodeId: Number(p.backendNodeId),
          multiple: p.mode === "selectMultiple",
        });
        this.broadcast(tab, {
          t: "files",
          multiple: p.mode === "selectMultiple",
          token,
        });
        return;
      }
    }
  }

  // ---- Window size ---------------------------------------------------------

  private acted(tab: Tab, viewer: Viewer): void {
    tab.usedAt = Date.now();
    if (!viewer.resize || tab.lastActor === viewer) return;
    tab.lastActor = viewer;
    this.scheduleResize(tab);
  }

  private scheduleResize(tab: Tab): void {
    if (tab.resizeTimer !== null) clearTimeout(tab.resizeTimer);
    tab.resizeTimer = setTimeout(() => {
      tab.resizeTimer = null;
      void this.resize(tab);
    }, 150);
  }

  /** The window around a page area of this size, within the screen. The
   * browser's own bars are added by `resize`, which measures them. */
  private windowSize(size: ViewSize): { width: number; height: number } {
    return {
      width: Math.min(size.width, this.seams.screen.width),
      height: Math.min(size.height, this.seams.screen.height),
    };
  }

  /** F39 point 3: the window takes the last acting person's page area. */
  private async resize(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    const actor = tab.lastActor;
    if (
      cdp === null ||
      tab.sessionId === null ||
      actor === null ||
      actor.size === null ||
      !actor.resize
    )
      return;
    try {
      const [win, metrics] = await Promise.all([
        cdp.send("Browser.getWindowForTarget", { targetId: tab.targetId }),
        cdp.send("Page.getLayoutMetrics", {}, tab.sessionId),
      ]);
      const bounds = win.bounds as { width: number; height: number };
      const viewport = metrics.cssLayoutViewport as {
        clientWidth: number;
        clientHeight: number;
      };
      const barsWidth = Math.max(0, bounds.width - viewport.clientWidth);
      const barsHeight = Math.max(0, bounds.height - viewport.clientHeight);
      const width = Math.min(
        actor.size.width + barsWidth,
        this.seams.screen.width,
      );
      const height = Math.min(
        actor.size.height + barsHeight,
        this.seams.screen.height,
      );
      if (
        Math.abs(width - bounds.width) <= 2 &&
        Math.abs(height - bounds.height) <= 2
      )
        return;
      await cdp.send("Browser.setWindowBounds", {
        windowId: win.windowId,
        bounds: { width, height },
      });
    } catch (error) {
      this.seams.log(`resize ${tab.targetId} failed: ${String(error)}`);
    }
  }

  // ---- Ids, holds and use (decision F57) -------------------------------------

  /** The live tab of an id: by the id views and holder files know it by,
   * or by its target id (a binding or a page's opener names that). */
  private resolve(id: string): Tab | undefined {
    return this.tabs.get(this.byId.get(id) ?? id);
  }

  /** The id the lists know a target by: a woken tab's own, else its own. */
  private idOfTarget(targetId: string): string {
    return (
      this.tabs.get(targetId)?.id ?? this.aliases.get(targetId) ?? targetId
    );
  }

  private keeper(tab: Tab): boolean {
    return tab.targetId === this.keeperId;
  }

  /** The strips that hold a tab, by any of its ids, each strip once. */
  private holdsOf(...ids: readonly string[]): Hold[] {
    const found: Hold[] = [];
    for (const id of new Set(ids))
      for (const hold of this.holds.holders.get(id) ?? [])
        if (!found.some((other) => other.strip === hold.strip))
          found.push(hold);
    return found;
  }

  /** The sessions whose agent works in a tab now: bound, daemon running. */
  private agentsOf(tab: Tab): string[] {
    const found = new Set([
      ...(this.holds.working.get(tab.targetId) ?? []),
      ...(this.holds.working.get(tab.id) ?? []),
    ]);
    return [...found];
  }

  private held(tab: Tab): boolean {
    return (
      this.holdsOf(tab.id, tab.targetId).length > 0 ||
      this.agentsOf(tab).length > 0
    );
  }

  /** A viewer that keeps its tab awake: its page is shown. */
  private shown(viewer: Viewer): boolean {
    return viewer.visible !== false;
  }

  /** Someone views the tab now, on a shown page. */
  private viewing(tab: Tab): boolean {
    for (const viewer of tab.viewers) if (this.shown(viewer)) return true;
    return false;
  }

  /** The quiet clock of a tab now: a shown viewer or a working agent is now,
   * and a page that was asked to close and stayed awake counts from then. */
  private quietSince(tab: Tab, now: number): number {
    if (this.viewing(tab)) tab.viewedAt = now;
    if (this.agentsOf(tab).length > 0) tab.agentAt = now;
    return quietSince({
      openedAt: tab.openedAt,
      viewedAt: tab.viewedAt,
      agentAt: tab.agentAt,
      activeAt: tab.activeAt,
      unsavedAt: tab.unsavedAt ?? 0,
      askedAt: tab.askedAt,
    });
  }

  /** Asks the page when it last had input (`activityScript`) and keeps the
   * later of that and its last navigation. A read that fails changes
   * nothing: the hub's own record of navigations stands. */
  private async readActivity(tab: Tab): Promise<void> {
    const ago = await this.inWorld(tab, activityScript);
    if (typeof ago === "number" && Number.isFinite(ago) && ago >= 0)
      tab.activeAt = Math.max(tab.activeAt, Date.now() - ago);
  }

  /** An agent works in the tab or did recently (decision F57): its
   * agent-browser daemon runs now, or ran within the idle time; or the
   * page had input or navigated within the idle time while nobody viewed
   * it, which is an agent driving it over its own DevTools connection (T3
   * Code's browser tools, Playwright), whose commands Chrome reports to no
   * other client. Input a person gives comes through a viewer. */
  private agentRecent(tab: Tab, now: number): boolean {
    if (this.agentsOf(tab).length > 0) return true;
    if (now - tab.agentAt < this.idleSleepMs) return true;
    return (
      now - tab.activeAt < this.idleSleepMs &&
      tab.activeAt > tab.viewedAt + viewerSlackMs
    );
  }

  /** Whether the page has unsaved input (`unsavedInputScript`); a read that
   * fails is no answer, and the page's `beforeunload` still speaks. */
  private async unsaved(tab: Tab): Promise<boolean> {
    const found = (await this.inWorld(tab, unsavedInputScript)) === true;
    tab.unsavedAt = found ? Date.now() : null;
    return found;
  }

  /** The page's input counts from now: the listener in the view's isolated
   * world (`activityScript`), once per document of a page that can sleep. */
  private listenForInput(tab: Tab, url: string): void {
    if (!sleepableAddress(url)) return;
    void this.inWorld(tab, activityScript);
  }

  // ---- Lifecycle -----------------------------------------------------------

  /** An empty window nobody opened: the one Chrome starts with, or the hub's
   * own. */
  private blank(tab: Tab): boolean {
    return (
      (tab.info.url === "" || tab.info.url === "about:blank") &&
      tab.openerId === null &&
      tab.opener.kind !== "view" &&
      tab.opener.kind !== "new-tab" &&
      !this.holds.bound.has(tab.targetId) &&
      !this.held(tab)
    );
  }

  /** F47 point 5. A tab a strip holds or an agent works in stays. One that
   * nothing holds or views counts down: 8 s when its last hold went (the
   * window of Vrátit), 30 s when its last viewer left (F39 point 9), and 10
   * minutes when nobody has viewed or held it yet. `idle` names the count
   * for a tab with nothing before (Vrátit gives a new tab's time). A tab
   * falling asleep counts nothing down (decision F57). */
  private review(tab: Tab, idle: GraceKind = "unviewed"): void {
    if (this.keeper(tab) || this.closing.has(tab.id) || tab.fall !== null) {
      this.clearGrace(tab);
      return;
    }
    const before = tab.state;
    tab.state = this.held(tab)
      ? "held"
      : tab.viewers.size > 0
        ? "viewed"
        : "idle";
    if (tab.state !== "idle") {
      this.clearGrace(tab);
      return;
    }
    if (tab.grace !== null) return;
    this.scheduleGrace(
      tab,
      before === "held" ? "release" : before === "viewed" ? "viewer" : idle,
    );
  }

  /** A grace of its full time, or until `endsAt` for one that goes on. */
  private scheduleGrace(tab: Tab, kind: GraceKind, endsAt?: number): void {
    this.clearGrace(tab);
    const ms =
      endsAt === undefined
        ? this.graceOf(kind)
        : Math.max(0, endsAt - Date.now());
    tab.grace = { kind, endsAt: Date.now() + ms };
    tab.graceTimer = setTimeout(() => {
      tab.graceTimer = null;
      void this.closeIfUnused(tab.targetId);
    }, ms);
  }

  private graceOf(kind: GraceKind): number {
    return kind === "release"
      ? this.releaseGraceMs
      : kind === "viewer"
        ? this.graceMs
        : this.unviewedGraceMs;
  }

  private clearGrace(tab: Tab): void {
    if (tab.graceTimer !== null) clearTimeout(tab.graceTimer);
    tab.graceTimer = null;
    tab.grace = null;
  }

  /** The end of a grace: the holds are read again first, and a tab that is
   * held or viewed by now stays. A failed read keeps the tab. */
  private async closeIfUnused(targetId: string): Promise<void> {
    let fresh: Holds;
    try {
      fresh = await this.seams.holds();
    } catch (error) {
      this.seams.log(`reading the holds failed: ${String(error)}`);
      const tab = this.tabs.get(targetId);
      if (tab !== undefined) {
        tab.grace = null;
        this.review(tab);
      }
      return;
    }
    this.holds = fresh;
    const tab = this.tabs.get(targetId);
    const cdp = this.cdp;
    if (tab === undefined || cdp === null) return;
    tab.grace = null;
    if (
      this.keeper(tab) ||
      this.closing.has(tab.id) ||
      tab.fall !== null ||
      this.held(tab) ||
      tab.viewers.size > 0
    ) {
      this.review(tab);
      return;
    }
    this.seams.log(`closing unused tab ${tab.id}`);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }

  /** The end of a close for everyone. While the browser is away it waits
   * for the reconnect, which finishes it. A tab that sleeps loses its
   * tombstone (decision F57), and one falling asleep its page too. */
  private async finishClose(id: string): Promise<void> {
    const entry = this.closing.get(id);
    if (entry === undefined) return;
    entry.timer = null;
    const sleeper = this.sleeping.get(id);
    if (sleeper !== undefined && sleeper.falling === null) {
      this.closing.delete(id);
      this.seams.log(`closing tab ${id} for everyone`);
      this.endSleeper(sleeper);
      return;
    }
    const cdp = this.cdp;
    if (cdp === null || !this.discovered) return;
    const tab = this.resolve(id);
    if (tab === undefined) {
      this.closing.delete(id);
      if (sleeper !== undefined) this.endSleeper(sleeper);
      return;
    }
    if (sleeper !== undefined) this.dropSleeper(sleeper);
    this.seams.log(`closing tab ${id} for everyone`);
    await cdp
      .send("Target.closeTarget", { targetId: tab.targetId })
      .catch(() => undefined);
  }

  /** Keeps one blank window of the hub's own (F47 point 5). */
  private async ensureKeeper(): Promise<void> {
    const cdp = this.cdp;
    if (
      this.stopped ||
      cdp === null ||
      !this.discovered ||
      this.keeperCreating ||
      (this.keeperId !== null && this.tabs.has(this.keeperId))
    )
      return;
    this.keeperCreating = true;
    try {
      const result = await cdp.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
      });
      const keeperId = String(result.targetId);
      this.keeperId = keeperId;
      this.origins.set(keeperId, {
        opener: { kind: "unknown" },
        openedAt: Date.now(),
      });
      const tab = this.tabs.get(keeperId);
      if (tab !== undefined) {
        tab.opener = { kind: "unknown" };
        this.clearGrace(tab);
      }
    } catch (error) {
      this.seams.log(`opening the blank window failed: ${String(error)}`);
    } finally {
      this.keeperCreating = false;
    }
  }

  /** Soon after a holder file or a binding changed: several changes at once
   * are one read. */
  private holdsChanged(): void {
    this.holdsEpoch += 1;
    if (this.holdsSoon !== null || this.stopped) return;
    this.holdsSoon = setTimeout(() => {
      this.holdsSoon = null;
      void this.refreshHolds();
    }, browserTimes.changesJoinMs);
  }

  private async refreshHolds(): Promise<void> {
    try {
      this.holds = await this.seams.holds();
    } catch (error) {
      this.seams.log(`reading the holds failed: ${String(error)}`);
      return;
    }
    const now = Date.now();
    for (const tab of [...this.tabs.values()]) {
      if (this.agentsOf(tab).length > 0) tab.agentAt = now;
      this.review(tab);
    }
    for (const sleeper of [...this.sleeping.values()]) {
      this.reviewSleeper(sleeper);
      this.wakeForAgent(sleeper, now);
    }
  }

  // ---- Sleep (decision F57) --------------------------------------------------

  /** A tab a T3 Code thread's strip holds. Its thread's browser tools drive
   * it over their own DevTools connection, and one that only reads leaves no
   * trace the hub can see, so such a tab never sleeps by the idle rule, by
   * pressure or by Uspat until T3 Code reports that activity
   * (Lazurio/t3code#90). */
  private threadHeld(tab: Tab): boolean {
    return this.holdsOf(tab.id, tab.targetId).some(
      (hold) => stripAppOf(hold.strip) === "t3code",
    );
  }

  /** An agent that shows up in a tab while it falls asleep, or within
   * `sleepCloseMs` after, wakes it at once under its id (decision F57). */
  private wakeForAgent(sleeper: Sleeper, now: number): void {
    if (sleeper.falling !== null || now > sleeper.agentWakesUntil) return;
    const ids = [sleeper.record.id, sleeper.fellFrom ?? sleeper.record.id];
    if (!ids.some((id) => (this.holds.working.get(id)?.length ?? 0) > 0))
      return;
    sleeper.agentWakesUntil = 0;
    this.seams.log(`an agent came to tab ${sleeper.record.id}; waking it`);
    void this.wake(sleeper);
  }

  /** The idle rule, on the holds' beat: every held tab that has not been in
   * use for the idle time (`quietSince`, then `putToSleep` asks the page)
   * sleeps, one after the other. A tab nothing holds is left to F47's
   * graces, which end it sooner. */
  private async sleepIdle(): Promise<void> {
    if (!this.ready || this.sleepBusy || this.stopped) return;
    this.sleepBusy = true;
    try {
      const now = Date.now();
      const quiet = [...this.tabs.values()]
        .filter(
          (tab) =>
            this.sleepable(tab) &&
            this.holdsOf(tab.id, tab.targetId).length > 0 &&
            !this.threadHeld(tab) &&
            now - this.quietSince(tab, now) >= this.idleSleepMs,
        )
        .sort((a, b) => this.quietSince(a, now) - this.quietSince(b, now));
      for (const tab of quiet) {
        if (this.stopped || this.resolve(tab.id) !== tab) continue;
        await this.putToSleep(tab, "idle");
      }
    } finally {
      this.sleepBusy = false;
    }
  }

  /** The pressure rule's beat (decision F57 point 6): it reads the signals,
   * keeps or ends the pressure by `underPressure`'s hysteresis, and under
   * pressure, once the cool-down since its last sleep is over, puts one tab
   * to sleep. Beats do not overlap. */
  private async pressureBeat(): Promise<void> {
    const source = this.seams.pressure;
    if (source === undefined || this.pressureBusy || this.stopped) return;
    this.pressureBusy = true;
    try {
      const reading = await source().catch(() => null);
      const was = this.pressed;
      this.pressed = reading !== null && underPressure(was, reading);
      if (this.pressed !== was) {
        const some = reading?.some;
        const available = reading?.available;
        const said = [
          some == null ? null : `PSI some avg10 ${some.toFixed(1)} %`,
          available == null
            ? null
            : `MemAvailable ${Math.round(available * 100)} %`,
        ]
          .filter((part) => part !== null)
          .join(", ");
        this.seams.log(
          this.pressed
            ? `memory pressure (${said}): tabs fall asleep, one every ${this.pressureCoolDownMs / 1000} s at most`
            : `memory pressure over (${said || "nothing to read"})`,
        );
      }
      if (
        !this.pressed ||
        !this.ready ||
        Date.now() - this.pressureSleptAt < this.pressureCoolDownMs
      )
        return;
      await this.sleepForPressure();
    } finally {
      this.pressureBusy = false;
    }
  }

  /** One tab to sleep for pressure, in `pressureOrder`: the hub tries them
   * one after the other through the idle rule's sleep (`putToSleep`) until
   * one falls asleep. Never a tab someone views, an agent works in or
   * worked in recently, or a T3 Code thread holds; a tab with unsaved input
   * comes last, and only its page's `beforeunload` keeps it awake. */
  private async sleepForPressure(): Promise<void> {
    const now = Date.now();
    const order = pressureOrder(
      [...this.tabs.values()]
        .filter((tab) => this.sleepable(tab))
        .map((tab) => ({
          tab,
          viewed: this.viewing(tab),
          agent: this.agentRecent(tab, now),
          thread: this.threadHeld(tab),
          held: this.holdsOf(tab.id, tab.targetId).length > 0,
          unsaved: tab.unsavedAt !== null,
          quietSince: this.quietSince(tab, now),
          askedAt: tab.askedAt,
        })),
      now,
      { quietMs: this.pressureQuietMs, askAgainMs: this.idleSleepMs },
    );
    for (const { tab, unsaved } of order) {
      if (this.stopped || this.resolve(tab.id) !== tab) continue;
      const outcome = await this.putToSleep(tab, "pressure", unsaved);
      if (outcome.kind === "asleep") {
        this.pressureSleptAt = Date.now();
        return;
      }
    }
  }

  /** Uspat in Přehled (decision F57): the tab sleeps unless someone views
   * it, an agent works in it or did recently, a T3 Code thread holds it, or
   * its page has unsaved input. */
  async sleepTab(id: string): Promise<SleepOutcome> {
    if (this.sleeping.get(id)?.falling === null) return { kind: "asleep" };
    const tab = this.resolve(id);
    if (tab === undefined || this.keeper(tab)) return { kind: "not-found" };
    return this.putToSleep(tab, "asked");
  }

  /** Probudit (decision F57): a tab that sleeps opens its address again in
   * a window of its own, under its id; the answer waits until the browser
   * reports it. An awake tab is awake. False for an id of no tab, or when
   * the browser did not open it. */
  async wakeTab(id: string): Promise<boolean> {
    if (this.resolve(id) !== undefined) return true;
    const sleeper = this.sleeping.get(id);
    if (sleeper === undefined) return false;
    await this.wake(sleeper);
    // Another wake may be on its way already: wait for it as long.
    const deadline = Date.now() + browserTimes.newTabWaitMs;
    while (
      this.resolve(id) === undefined &&
      this.sleeping.get(id) === sleeper &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    return this.resolve(id) !== undefined;
  }

  /** A tab the hub may put to sleep at all: an awake page with an address
   * it can open again, not the hub's own window, not closing or falling
   * asleep already, its session attached. */
  private sleepable(tab: Tab): boolean {
    return (
      !this.keeper(tab) &&
      !this.closing.has(tab.id) &&
      tab.fall === null &&
      !tab.checking &&
      !this.sleeping.has(tab.id) &&
      tab.sessionId !== null &&
      sleepableAddress(tab.info.url)
    );
  }

  /** Puts one tab to sleep. Never one in use, and never one an agent works
   * in (Matěj's rule of 2026-10-20): the page is asked for its last input
   * and for unsaved input, then the holds are read once more, and the last
   * check and `Page.close` are one step, with nothing awaited between them.
   * A change of a holder file or a binding that the watch reports while the
   * hub looks cancels the sleep, which the next beat may try again. A page
   * with unsaved input, or whose `beforeunload` objects, stays awake. The
   * tombstone exists before the page is asked to close, so every list of
   * tabs names the tab throughout. The pressure rule's last resort,
   * `pageDecides`, does not look for unsaved input: only the page's own
   * `beforeunload` keeps such a tab awake (F57 point 6). */
  private async putToSleep(
    tab: Tab,
    reason: SleepReason,
    pageDecides = false,
  ): Promise<SleepOutcome> {
    if (!this.sleepable(tab))
      return {
        kind: "awake",
        reason: sleepableAddress(tab.info.url) ? "busy" : "not-sleepable",
      };
    if (this.viewing(tab)) return { kind: "awake", reason: "viewed" };
    if (this.agentsOf(tab).length > 0 || this.threadHeld(tab))
      return { kind: "awake", reason: "agent" };
    const epoch = this.holdsEpoch;
    tab.checking = true;
    try {
      await this.readActivity(tab);
      const now = Date.now();
      if (this.agentRecent(tab, now)) return { kind: "awake", reason: "agent" };
      if (this.inUse(tab, reason, now))
        return { kind: "awake", reason: "in-use" };
      if (!pageDecides && (await this.unsaved(tab)))
        return { kind: "awake", reason: "unsaved" };
      let fresh: Holds;
      try {
        fresh = await this.seams.holds();
      } catch (error) {
        this.seams.log(`reading the holds failed: ${String(error)}`);
        return { kind: "awake", reason: "busy" };
      }
      // From here to `Page.close` nothing is awaited: what the hub knows now
      // is what it acts on.
      this.holds = fresh;
      return this.closeToSleep(tab, reason, epoch);
    } finally {
      tab.checking = false;
    }
  }

  /** In use too recently for the rule that asks: the idle rule wants an
   * idle time without use, the pressure rule `pressureQuietMs`; Uspat
   * wants none. */
  private inUse(tab: Tab, reason: SleepReason, now: number): boolean {
    const quiet =
      reason === "idle"
        ? this.idleSleepMs
        : reason === "pressure"
          ? this.pressureQuietMs
          : 0;
    return now - this.quietSince(tab, now) < quiet;
  }

  /** The last check and the close, in one synchronous step. */
  private closeToSleep(
    tab: Tab,
    reason: SleepReason,
    epoch: number,
  ): Promise<SleepOutcome> {
    const now = Date.now();
    const awake = (why: AwakeReason) =>
      Promise.resolve<SleepOutcome>({ kind: "awake", reason: why });
    const cdp = this.cdp;
    const session = tab.sessionId;
    if (this.viewing(tab)) return awake("viewed");
    if (
      this.agentsOf(tab).length > 0 ||
      this.threadHeld(tab) ||
      this.agentRecent(tab, now)
    )
      return awake("agent");
    // A binding or a holder file changed while the hub looked: whatever it
    // was, this is no moment to close the page.
    if (this.holdsEpoch !== epoch) return awake("busy");
    if (
      cdp === null ||
      session === null ||
      this.resolve(tab.id) !== tab ||
      this.keeper(tab) ||
      this.closing.has(tab.id) ||
      tab.fall !== null ||
      this.sleeping.has(tab.id) ||
      (reason === "idle" && this.holdsOf(tab.id, tab.targetId).length === 0)
    )
      return awake("busy");
    if (this.inUse(tab, reason, now)) return awake("in-use");
    const sleeper: Sleeper = {
      record: {
        id: tab.id,
        url: tab.info.url,
        title: tab.info.title,
        favicon: tab.info.favicon,
        opener: tab.opener,
        openedAt: tab.openedAt,
        usedAt: tab.usedAt,
        sleptAt: now,
        reason,
      },
      falling: tab.targetId,
      fellFrom: tab.targetId,
      closeEpoch: this.holdsEpoch,
      agentWakesUntil: 0,
      viewers: new Set(),
      waking: false,
      wakeTimer: null,
      state: "held",
      graceTimer: null,
      grace: null,
      kept: tab.grace,
    };
    this.sleeping.set(tab.id, sleeper);
    this.clearGrace(tab);
    tab.askedAt = now;
    const outcome = new Promise<SleepOutcome>((resolve) => {
      tab.fall = {
        reason,
        done: resolve,
        timer: setTimeout(() => {
          // The page neither closed nor objected: it stays awake.
          if (tab.fall === null || this.cdp === null) return;
          this.seams.log(`tab ${tab.id} did not close to sleep; kept awake`);
          this.fell(tab, { kind: "awake", reason: "busy" });
        }, this.sleepCloseMs),
      };
    });
    this.seams.log(`putting tab ${tab.id} to sleep (${reason})`);
    // `Page.close` runs the page's `beforeunload`, which may keep it awake.
    void cdp.send("Page.close", {}, session).catch((error: unknown) => {
      this.seams.log(`Page.close failed: ${String(error)}`);
      if (tab.fall !== null) this.fell(tab, { kind: "awake", reason: "busy" });
    });
    return outcome;
  }

  /** A fall that ends awake: the tombstone goes, the tab counts as before,
   * the grace it counted down included. */
  private fell(tab: Tab, outcome: SleepOutcome): void {
    const fall = tab.fall;
    if (fall === null) return;
    clearTimeout(fall.timer);
    tab.fall = null;
    const sleeper = this.sleeping.get(tab.id);
    if (sleeper !== undefined && sleeper.falling === tab.targetId) {
      if (sleeper.kept !== null)
        this.scheduleGrace(tab, sleeper.kept.kind, sleeper.kept.endsAt);
      this.dropSleeper(sleeper);
    }
    this.review(tab);
    fall.done(outcome);
  }

  /** A tab that fell asleep: its target is gone, its tombstone stays. An
   * agent that came while its page closed wakes it at once: a change of the
   * bindings reported meanwhile is read now, and one reported in the next
   * `sleepCloseMs` is read as it comes (`wakeForAgent`). */
  private asleep(sleeper: Sleeper): void {
    sleeper.falling = null;
    sleeper.agentWakesUntil = Date.now() + this.sleepCloseMs;
    this.seams.log(`tab ${sleeper.record.id} sleeps`);
    this.trimSleeping();
    this.publishTabs();
    this.persist();
    this.reviewSleeper(sleeper);
    if ([...sleeper.viewers].some((viewer) => this.shown(viewer)))
      void this.wake(sleeper);
    else if (this.holdsEpoch !== sleeper.closeEpoch) void this.refreshHolds();
  }

  /** The most tombstones the hub keeps (`maxSleeping`): the least recently
   * used beyond it end. */
  private trimSleeping(): void {
    const asleep = [...this.sleeping.values()].filter(
      (sleeper) => sleeper.falling === null && sleeper.viewers.size === 0,
    );
    const over = this.sleeping.size - maxSleeping;
    if (over <= 0) return;
    asleep.sort((a, b) => a.record.usedAt - b.record.usedAt);
    for (const sleeper of asleep.slice(0, over)) this.endSleeper(sleeper);
  }

  /** Opens a sleeping tab's address again in a window of its own, at the
   * size of a viewer that waits for it, and gives the new target the tab's
   * id. Once the browser reports it, `adopt` moves the waiting viewers to
   * it. A browser that cannot be reached tries again after `wakeRetryMs`
   * while someone waits; the reconnect wakes it too. */
  private async wake(sleeper: Sleeper): Promise<void> {
    if (sleeper.waking || sleeper.falling !== null) return;
    if (this.sleeping.get(sleeper.record.id) !== sleeper) return;
    const cdp = this.cdp;
    if (cdp === null || !this.discovered) return;
    sleeper.waking = true;
    if (sleeper.wakeTimer !== null) clearTimeout(sleeper.wakeTimer);
    sleeper.wakeTimer = null;
    this.clearSleeperGrace(sleeper);
    const sized = [...sleeper.viewers].find(
      (viewer) => viewer.resize && viewer.size !== null,
    )?.size;
    const fitted =
      sized === undefined || sized === null
        ? null
        : this.windowSize(clampSize(sized));
    const id = sleeper.record.id;
    this.seams.log(`waking tab ${id}`);
    let targetId: string;
    try {
      const result = await cdp.send("Target.createTarget", {
        url: sleeper.record.url,
        newWindow: true,
        ...(fitted === null ? {} : fitted),
      });
      targetId = String(result.targetId);
    } catch (error) {
      this.seams.log(`waking tab ${id} failed: ${String(error)}`);
      sleeper.waking = false;
      for (const viewer of sleeper.viewers)
        viewer.send({ t: "browser", state: "reconnecting" });
      if (sleeper.viewers.size > 0 && !this.stopped)
        sleeper.wakeTimer = setTimeout(() => {
          sleeper.wakeTimer = null;
          void this.wake(sleeper);
        }, this.wakeRetryMs);
      this.reviewSleeper(sleeper);
      return;
    }
    // From now the browser's report of the target names it by the tab's id.
    this.aliases.set(targetId, id);
    this.persist();
    const early = this.tabs.get(targetId);
    if (early !== undefined && this.sleeping.get(id) === sleeper)
      this.adopt(sleeper, early);
    const deadline = Date.now() + browserTimes.newTabWaitMs;
    while (this.sleeping.get(id) === sleeper && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.sleeping.get(id) === sleeper) {
      // Not reported yet: its report adopts it whenever it comes.
      this.seams.log(`woken tab ${id} not reported yet`);
      sleeper.waking = false;
    }
  }

  /** The tab a sleeping one woke into takes its id, its opener and its
   * waiting viewers (decision F57). */
  private adopt(sleeper: Sleeper, tab: Tab): void {
    const { record } = sleeper;
    this.clearSleeper(sleeper);
    this.sleeping.delete(record.id);
    if (this.byId.get(tab.id) === tab.targetId) this.byId.delete(tab.id);
    tab.id = record.id;
    this.byId.set(record.id, tab.targetId);
    this.aliases.set(tab.targetId, record.id);
    tab.opener = record.opener;
    tab.openedAt = record.openedAt;
    this.origins.set(tab.targetId, {
      opener: record.opener,
      openedAt: record.openedAt,
    });
    if (tab.info.title === "" || tab.info.title === tab.info.url)
      tab.info.title = record.title;
    tab.info.favicon ??= record.favicon;
    // Woken by a person (a view, Probudit): its quiet clock starts now, as
    // when someone last viewed it, and its load within the viewer slack is
    // no agent's doing.
    const now = Date.now();
    tab.usedAt = now;
    tab.viewedAt = now;
    for (const viewer of sleeper.viewers) {
      this.waiting.delete(viewer);
      tab.viewers.add(viewer);
      tab.flows.set(viewer, { sent: 0, unacked: [], heldSince: null });
      if (viewer.resize && viewer.size !== null) tab.lastActor = viewer;
    }
    sleeper.viewers.clear();
    this.seams.log(`tab ${record.id} woke as ${tab.targetId}`);
    this.publishTabs();
    this.persist();
    this.review(tab);
    if (tab.viewers.size > 0) {
      for (const viewer of tab.viewers) this.sendInfo(tab, viewer);
      if (tab.lastActor !== null) this.scheduleResize(tab);
      if (tab.sessionId !== null) {
        this.broadcast(tab, { t: "browser", state: "connected" });
        void this.watch(tab);
      }
    }
  }

  private waitFor(sleeper: Sleeper, viewer: Viewer): void {
    sleeper.viewers.add(viewer);
    this.waiting.set(viewer, sleeper);
  }

  /** F47 point 5 for a tombstone: it stays while a holder file lists it or
   * someone waits for it; else it ends after the grace, which Vrátit and a
   * new hold cancel. Agents do not hold a tab that sleeps: a binding names
   * a target that is gone. */
  private reviewSleeper(sleeper: Sleeper, idle: GraceKind = "unviewed"): void {
    const id = sleeper.record.id;
    if (
      this.sleeping.get(id) !== sleeper ||
      sleeper.falling !== null ||
      this.closing.has(id)
    ) {
      this.clearSleeperGrace(sleeper);
      return;
    }
    const before = sleeper.state;
    sleeper.state =
      this.holdsOf(id).length > 0
        ? "held"
        : sleeper.viewers.size > 0 || sleeper.waking
          ? "viewed"
          : "idle";
    if (sleeper.state !== "idle") {
      this.clearSleeperGrace(sleeper);
      sleeper.kept = null;
      return;
    }
    if (sleeper.grace !== null) return;
    // A tab nothing held fell asleep while it counted down: the count goes
    // on, so its tombstone ends when the tab would have ended.
    const kept = sleeper.kept;
    sleeper.kept = null;
    const kind: GraceKind =
      kept?.kind ??
      (before === "held" ? "release" : before === "viewed" ? "viewer" : idle);
    const ms =
      kept === null
        ? this.graceOf(kind)
        : Math.max(0, kept.endsAt - Date.now());
    sleeper.grace = { kind, endsAt: Date.now() + ms };
    sleeper.graceTimer = setTimeout(() => {
      sleeper.graceTimer = null;
      void this.endSleeperIfUnused(sleeper);
    }, ms);
  }

  private clearSleeperGrace(sleeper: Sleeper): void {
    if (sleeper.graceTimer !== null) clearTimeout(sleeper.graceTimer);
    sleeper.graceTimer = null;
    sleeper.grace = null;
  }

  private clearSleeper(sleeper: Sleeper): void {
    this.clearSleeperGrace(sleeper);
    if (sleeper.wakeTimer !== null) clearTimeout(sleeper.wakeTimer);
    sleeper.wakeTimer = null;
  }

  /** The end of a tombstone's grace: the holds are read again first, and a
   * failed read keeps it. */
  private async endSleeperIfUnused(sleeper: Sleeper): Promise<void> {
    try {
      this.holds = await this.seams.holds();
    } catch (error) {
      this.seams.log(`reading the holds failed: ${String(error)}`);
      sleeper.grace = null;
      this.reviewSleeper(sleeper);
      return;
    }
    sleeper.grace = null;
    const id = sleeper.record.id;
    if (
      this.sleeping.get(id) !== sleeper ||
      this.holdsOf(id).length > 0 ||
      sleeper.viewers.size > 0 ||
      sleeper.waking
    ) {
      this.reviewSleeper(sleeper);
      return;
    }
    this.seams.log(`closing unused tab ${id}`);
    this.endSleeper(sleeper);
  }

  /** A tab that sleeps ends: its tombstone goes, and whoever waited for it
   * is told, as for a tab that ended. */
  private endSleeper(sleeper: Sleeper): void {
    const id = sleeper.record.id;
    if (this.sleeping.get(id) !== sleeper) return;
    this.clearSleeper(sleeper);
    this.sleeping.delete(id);
    for (const [target, alias] of [...this.aliases])
      if (alias === id && !this.tabs.has(target)) this.aliases.delete(target);
    const pending = this.closing.get(id);
    if (pending !== undefined) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.closing.delete(id);
    }
    for (const viewer of sleeper.viewers) {
      this.waiting.delete(viewer);
      viewer.send({ t: "closed" });
      viewer.close();
    }
    sleeper.viewers.clear();
    this.publishTabs();
    this.persist();
  }

  /** A tombstone that is no longer one, because its tab stays awake: it goes
   * without a word, the tab lives on. */
  private dropSleeper(sleeper: Sleeper): void {
    const id = sleeper.record.id;
    if (this.sleeping.get(id) !== sleeper) return;
    this.clearSleeper(sleeper);
    this.sleeping.delete(id);
    for (const viewer of sleeper.viewers) {
      this.waiting.delete(viewer);
      viewer.close();
    }
    sleeper.viewers.clear();
    this.persist();
  }

  /** At each connection: the same browser keeps what the hub knows of its
   * tabs that sleep and woke; a different one (a restart: Chrome names
   * itself anew at each start) has none of them (F38's addendum of
   * 2026-10-10). The first connection of the service reads what an earlier
   * service wrote down. */
  private async sameBrowser(browser: string | null): Promise<void> {
    if (!this.stateRead) {
      this.stateRead = true;
      const text = await this.seams.sleepState?.read().catch(() => null);
      const state = text ? parseSleepState(text) : null;
      if (state !== null && browser !== null && state.browser === browser) {
        for (const [target, id] of state.aliases)
          if (!this.aliases.has(target)) this.aliases.set(target, id);
        for (const record of state.sleeping)
          if (!this.sleeping.has(record.id))
            this.sleeping.set(record.id, {
              record,
              falling: null,
              fellFrom: null,
              closeEpoch: this.holdsEpoch,
              agentWakesUntil: 0,
              viewers: new Set(),
              waking: false,
              wakeTimer: null,
              // As every tab after a restart of the view (F47 point 5): one
              // that nothing holds has a new tab's time.
              state: "idle",
              graceTimer: null,
              grace: null,
              kept: null,
            });
        if (state.sleeping.length > 0)
          this.seams.log(`${state.sleeping.length} sleeping tab(s) kept`);
      }
    } else if (
      browser !== null &&
      this.browserId !== null &&
      browser !== this.browserId
    ) {
      // The browser restarted: no tab of it comes back, asleep or awake.
      for (const sleeper of [...this.sleeping.values()])
        this.endSleeper(sleeper);
      this.aliases.clear();
    }
    if (browser !== null) this.browserId = browser;
    this.persist();
  }

  /** Writes down what a restart of the view needs (`SleepState`), soon after
   * a change, one write at a time. */
  private persist(): void {
    if (this.seams.sleepState === undefined || this.stopped) return;
    if (this.persistSoon !== null) return;
    this.persistSoon = setTimeout(() => {
      this.persistSoon = null;
      void this.writeState();
    }, browserTimes.snapshotJoinMs);
  }

  private async writeState(): Promise<void> {
    const store = this.seams.sleepState;
    if (store === undefined || this.browserId === null) return;
    if (this.persisting) {
      this.persistAgain = true;
      return;
    }
    this.persisting = true;
    try {
      await store.write(
        sleepStateText({
          browser: this.browserId,
          sleeping: [...this.sleeping.values()].map(
            (sleeper) => sleeper.record,
          ),
          aliases: new Map(
            [...this.aliases].filter(([target]) => this.tabs.has(target)),
          ),
        }),
      );
    } catch (error) {
      this.seams.log(`writing the sleeping tabs failed: ${String(error)}`);
    } finally {
      this.persisting = false;
      if (this.persistAgain) {
        this.persistAgain = false;
        this.persist();
      }
    }
  }

  // ---- The list of live tabs (F47 point 4) -----------------------------------

  /** Soon writes the list of live tabs (F47 point 4) from a fresh snapshot
   * of the browser's targets, not from what the hub has heard: a target whose
   * event comes late on the hub's connection is in the snapshot all the same.
   * Only while connected; one snapshot at a time, so a slower one never
   * overwrites a newer one. The hub's blank window is in no list. A tab that
   * sleeps is in it by its id, and a woken tab by its id and its target's
   * (decision F57): every place keeps a tab that exists, awake or asleep. */
  private publishTabs(): void {
    if (
      this.seams.writeTabs === undefined ||
      this.tabsSoon !== null ||
      this.stopped
    )
      return;
    this.tabsSoon = setTimeout(() => {
      this.tabsSoon = null;
      void this.snapshotTabs();
    }, browserTimes.snapshotJoinMs);
  }

  private async snapshotTabs(): Promise<void> {
    const write = this.seams.writeTabs;
    const clock = this.seams.bootClock;
    const cdp = this.cdp;
    if (
      write === undefined ||
      clock === undefined ||
      cdp === null ||
      this.stopped
    )
      return;
    if (this.snapshotting) {
      this.snapshotAgain = true;
      return;
    }
    this.snapshotting = true;
    try {
      // The clock first: the snapshot then lists every target that exists
      // at that time or comes later, never one that ended before it.
      const takenAt = await clock();
      if (takenAt === null) return;
      // The tabs that sleep now, before the browser answers: one that wakes
      // meanwhile may be missing from the answer but is in this set.
      const asleep = [...this.sleeping.keys()];
      const answer = await cdp.send("Target.getTargets");
      const infos = Array.isArray(answer.targetInfos)
        ? (answer.targetInfos as Record<string, unknown>[])
        : [];
      const ids = new Set<string>();
      for (const info of infos) {
        if (info.type !== "page" || typeof info.targetId !== "string") continue;
        if (info.targetId === this.keeperId) continue;
        ids.add(info.targetId);
        ids.add(this.idOfTarget(info.targetId));
      }
      // ...and those that fell asleep while it answered.
      for (const id of asleep) ids.add(id);
      for (const id of this.sleeping.keys()) ids.add(id);
      await write([...ids], takenAt);
    } catch (error) {
      this.seams.log(`writing the list of tabs failed: ${String(error)}`);
    } finally {
      this.snapshotting = false;
      if (this.snapshotAgain) {
        this.snapshotAgain = false;
        this.publishTabs();
      }
    }
  }

  private gone(targetId: string): void {
    const tab = this.tabs.get(targetId);
    const id = tab?.id ?? this.aliases.get(targetId) ?? targetId;
    const sleeper = this.sleeping.get(id);
    // The page closed to sleep: its tombstone stays, with whoever came to
    // view it meanwhile, and the close for everyone it may wait for.
    const fellAsleep = sleeper !== undefined && sleeper.falling === targetId;
    if (!fellAsleep) {
      const pending = this.closing.get(id);
      if (pending !== undefined && this.resolve(id)?.targetId === targetId) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        this.closing.delete(id);
      }
    }
    this.origins.delete(targetId);
    this.aliases.delete(targetId);
    if (targetId === this.keeperId) {
      this.keeperId = null;
      void this.ensureKeeper();
    }
    if (tab === undefined) return;
    this.clearTimers(tab);
    this.tabs.delete(targetId);
    if (this.byId.get(tab.id) === targetId) this.byId.delete(tab.id);
    this.publishTabs();
    if (tab.sessionId !== null) this.bySession.delete(tab.sessionId);
    for (const [token, chooser] of this.fileChoosers)
      if (chooser.targetId === targetId) this.fileChoosers.delete(token);
    if (fellAsleep && sleeper !== undefined) {
      const fall = tab.fall;
      tab.fall = null;
      if (fall !== null) clearTimeout(fall.timer);
      for (const viewer of tab.viewers) this.waitFor(sleeper, viewer);
      tab.viewers.clear();
      this.asleep(sleeper);
      fall?.done({ kind: "asleep" });
      return;
    }
    if (tab.fall !== null) {
      clearTimeout(tab.fall.timer);
      tab.fall.done({ kind: "awake", reason: "busy" });
      tab.fall = null;
    }
    for (const viewer of tab.viewers) {
      viewer.send({ t: "closed" });
      viewer.close();
    }
  }

  private clearTimers(tab: Tab): void {
    for (const timer of [
      tab.graceTimer,
      tab.resizeTimer,
      tab.infoTimer,
      tab.selectionTimer,
      tab.pendingOpen?.timer ?? null,
      tab.ackTimer,
    ])
      if (timer !== null) clearTimeout(timer);
    tab.graceTimer = null;
    tab.grace = null;
    tab.resizeTimer = null;
    tab.infoTimer = null;
    tab.selectionTimer = null;
    tab.pendingOpen = null;
    tab.ackTimer = null;
    if (tab.metaTimer !== null) clearInterval(tab.metaTimer);
    tab.metaTimer = null;
  }

  // ---- To the viewers ------------------------------------------------------

  private broadcast(tab: Tab, message: ServerMessage): void {
    for (const viewer of tab.viewers) viewer.send(message);
  }

  private queueInfo(tab: Tab): void {
    if (tab.viewers.size === 0 || tab.infoTimer !== null) return;
    tab.infoTimer = setTimeout(() => {
      tab.infoTimer = null;
      for (const viewer of tab.viewers) this.sendInfo(tab, viewer);
    }, 50);
  }

  private sendInfo(tab: Tab, viewer: Viewer): void {
    viewer.send({ t: "info", ...tab.info });
  }

  /** Removes upload folders older than an hour. */
  private async sweepUploads(): Promise<void> {
    const root = this.seams.uploadDirectory;
    await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const names = await readdir(root).catch(() => [] as string[]);
    const old = Date.now() - 3_600_000;
    for (const name of names) {
      const path = join(root, name);
      const info = await stat(path).catch(() => null);
      if (info !== null && info.mtimeMs < old)
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
