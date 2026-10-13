import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Hold, type Holds, noHolds } from "../contract/node";
import type { BootTime } from "../contract/pure";
import type { CdpConnection, CdpEvent } from "./cdp";
import {
  type ClientMessage,
  encodeFrame,
  type FrameHeader,
  type Picture,
  type ServerMessage,
  type ViewSize,
  viewSizeLimits,
} from "./protocol";

/** The view service's hold on the Environment browser (decision F39): every
 * page target with one DevTools session each, the people who view which tab,
 * and what the view does for them (frames, input, pop-ups, dialogs, file
 * choosers). It alone decides when a remote tab ends (F47 point 5): a tab
 * that a strip holds or an agent works in stays; one that nothing holds or
 * views ends after a grace. One hub per service; it reconnects whenever the
 * browser goes away. */

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
}>;

/** Who opened a tab, as far as the hub knows: the people's view (`/`), Nová
 * karta (through the loopback request), a page (its new tab or pop-up), an
 * agent (a session bound to it), or nobody it knows of (a tab from before
 * the service started). */
export type TabOpener =
  | Readonly<{ kind: "view" }>
  | Readonly<{ kind: "new-tab"; strip: string | null }>
  | Readonly<{ kind: "page"; openerId: string }>
  | Readonly<{ kind: "agent"; session: string }>
  | Readonly<{ kind: "unknown" }>;

/** Why a tab nothing holds or views is counting down (F47 point 5). */
export type GraceKind = "release" | "viewer" | "unviewed";

/** One remote tab as the loopback list reports it (F47 point 6). */
export type TabFacts = Readonly<{
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  openedAt: string;
  usedAt: string;
  opener: TabOpener;
  /** The sessions whose agent works in it now. */
  agents: readonly string[];
  holders: readonly Hold[];
  viewers: number;
  /** When a close for everyone ends it, unless restored. */
  closing: string | null;
  grace: Readonly<{ kind: GraceKind; endsAt: string }> | null;
  /** Its JavaScript heap in bytes, the overview's estimate marked "≈" (F47
   * point 7): only in a list asked for with `heap=1`, null where it could
   * not be read in time. */
  heap?: Readonly<{ used: number; total: number }> | null;
}>;

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

type Tab = {
  targetId: string;
  sessionId: string | null;
  openerId: string | null;
  canAccessOpener: boolean;
  mainFrameId: string | null;
  info: Info;
  viewers: Set<Viewer>;
  screencast: Screencast | null;
  pendingAck: number | null;
  lastFrame: Uint8Array | null;
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
};

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

/** Only these addresses are navigated to from the address bar; the page
 * itself may go anywhere it likes. */
export function navigableAddress(value: string): string | null {
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export class BrowserHub {
  private cdp: CdpConnection | null = null;
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
  private readonly graceMs: number;
  private readonly unviewedGraceMs: number;
  private readonly releaseGraceMs: number;
  private readonly holdsEveryMs: number;
  private readonly reconnectMs: number;

  constructor(private readonly seams: HubSeams) {
    this.graceMs = seams.graceMs ?? 30_000;
    this.unviewedGraceMs = seams.unviewedGraceMs ?? 600_000;
    this.releaseGraceMs = seams.releaseGraceMs ?? 8_000;
    this.holdsEveryMs = seams.holdsEveryMs ?? 30_000;
    this.reconnectMs = seams.reconnectMs ?? 2_000;
  }

  get connected(): boolean {
    return this.cdp !== null;
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
    this.holdsTimer = setInterval(() => {
      this.watcher?.retry();
      void this.refreshHolds();
      this.publishTabs();
    }, this.holdsEveryMs);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.holdsTimer !== null) clearInterval(this.holdsTimer);
    if (this.holdsSoon !== null) clearTimeout(this.holdsSoon);
    if (this.tabsSoon !== null) clearTimeout(this.tabsSoon);
    this.tabsSoon = null;
    this.holdsTimer = null;
    this.holdsSoon = null;
    this.watcher?.stop();
    this.watcher = null;
    this.cdp?.close();
    this.cdp = null;
    for (const tab of this.tabs.values()) this.clearTimers(tab);
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
   * remote tab exists only from now. Null when the address is not one the
   * address bar may open or the browser cannot be reached. */
  async openTab(url: string, strip: string | null): Promise<string | null> {
    const address = navigableAddress(url);
    if (address === null) return null;
    return this.newWindow(address, {}, { kind: "new-tab", strip });
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
      const deadline = Date.now() + 2_000;
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
    for (const tab of this.tabs.values()) {
      if (tab.targetId === this.keeperId) continue;
      const closing = this.closing.get(tab.targetId);
      const session = this.holds.bound.get(tab.targetId)?.[0];
      facts.push({
        id: tab.targetId,
        url: tab.info.url,
        title: tab.info.title,
        favicon: tab.info.favicon,
        openedAt: iso(tab.openedAt),
        usedAt: iso(tab.usedAt),
        opener:
          tab.opener.kind === "unknown" && session !== undefined
            ? { kind: "agent", session }
            : tab.opener,
        agents: this.holds.working.get(tab.targetId) ?? [],
        holders: this.holds.holders.get(tab.targetId) ?? [],
        viewers: tab.viewers.size,
        closing: closing === undefined ? null : iso(closing.endsAt),
        grace:
          tab.grace === null
            ? null
            : { kind: tab.grace.kind, endsAt: iso(tab.grace.endsAt) },
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
    targetId: string,
  ): Promise<Readonly<{ used: number; total: number }> | null> {
    const cdp = this.cdp;
    const session = this.tabs.get(targetId)?.sessionId ?? null;
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
  closeForEveryone(targetId: string): number | null {
    const tab = this.tabs.get(targetId);
    if (tab === undefined || targetId === this.keeperId) return null;
    const pending = this.closing.get(targetId);
    if (pending !== undefined) return pending.endsAt;
    this.clearGrace(tab);
    const endsAt = Date.now() + this.releaseGraceMs;
    this.closing.set(targetId, {
      endsAt,
      timer: setTimeout(
        () => void this.finishClose(targetId),
        this.releaseGraceMs,
      ),
    });
    this.seams.log(`closing tab ${targetId} for everyone`);
    return endsAt;
  }

  /** Vrátit: cancels a close for everyone or a grace. A tab that nothing
   * holds or views then has as long as a new one to be viewed or held. False
   * when the tab is gone or nothing was counting down. */
  restore(targetId: string): boolean {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return false;
    const pending = this.closing.get(targetId);
    if (pending !== undefined) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.closing.delete(targetId);
    } else if (tab.grace === null) return false;
    this.clearGrace(tab);
    tab.state = "idle";
    this.review(tab, "unviewed");
    this.seams.log(`restored tab ${targetId}`);
    return true;
  }

  hasTab(targetId: string): boolean {
    return this.tabs.has(targetId);
  }

  /** Adds a person's socket to a tab. False when there is no such page. */
  attach(targetId: string, viewer: Viewer): boolean {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return false;
    tab.viewers.add(viewer);
    tab.usedAt = Date.now();
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
    if (tab.lastFrame !== null) viewer.sendFrame(tab.lastFrame);
    void this.watch(tab);
    return true;
  }

  detach(targetId: string, viewer: Viewer): void {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return;
    tab.viewers.delete(viewer);
    if (tab.lastActor === viewer) tab.lastActor = null;
    tab.usedAt = Date.now();
    if (tab.viewers.size > 0) {
      void this.updateScreencast(tab);
      return;
    }
    void this.unwatch(tab);
    this.review(tab);
  }

  /** Called when a viewer's socket drained, to release a held frame. */
  drained(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (tab !== undefined) this.maybeAck(tab);
  }

  async handle(
    targetId: string,
    viewer: Viewer,
    message: ClientMessage,
  ): Promise<void> {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return;
    if (message.t === "hello" || message.t === "size") {
      viewer.size = clampSize(message);
      if (message.t === "hello") {
        viewer.resize = message.resize;
        viewer.picture = message.picture ?? "standard";
      }
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
    // A person may act before the tab's session is attached (a new tab, a
    // reconnect): wait for it briefly rather than drop the input.
    const deadline = Date.now() + 3_000;
    while (
      (this.cdp === null || tab.sessionId === null) &&
      Date.now() < deadline &&
      this.tabs.get(targetId) === tab
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId === null) return;
    const session = tab.sessionId;
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
    targetId: string,
    token: string,
    files: readonly File[],
  ): Promise<boolean> {
    const chooser = this.fileChoosers.get(token);
    const tab = this.tabs.get(targetId);
    const cdp = this.cdp;
    if (
      chooser === undefined ||
      chooser.targetId !== targetId ||
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
    try {
      // Chrome reports every existing target before it answers.
      await cdp.send("Target.setDiscoverTargets", { discover: true });
    } catch (error) {
      this.seams.log(`discover failed: ${String(error)}`);
      cdp.close();
      return;
    }
    this.seams.log("browser connected");
    // A tab kept across a reconnect whose page did not come back is gone.
    for (const id of [...this.tabs.keys()])
      if (!this.seen.has(id)) this.gone(id);
    for (const [id, entry] of [...this.closing])
      if (!this.seen.has(id)) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        this.closing.delete(id);
      }
    // Ready once the holds are read too, so a tab is never judged by an
    // empty read.
    await this.refreshHolds();
    if (this.cdp !== cdp) return;
    this.discovered = true;
    this.publishTabs();
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
      tab.sessionId = null;
      tab.screencast = null;
      tab.pendingAck = null;
      tab.watched = false;
      tab.attaching = false;
      tab.world = null;
      if (tab.metaTimer !== null) clearInterval(tab.metaTimer);
      tab.metaTimer = null;
      for (const viewer of tab.viewers)
        viewer.send({ t: "browser", state: "reconnecting" });
    }
    // A target id does not survive a browser restart; ids that come back
    // are attached again by discovery.
    for (const [id, tab] of [...this.tabs])
      if (tab.viewers.size === 0) {
        this.clearTimers(tab);
        this.tabs.delete(id);
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
      tab = {
        targetId,
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
        pendingAck: null,
        lastFrame: null,
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
        selectionTimer: null,
        metaTimer: null,
      };
      this.tabs.set(targetId, tab);
      this.publishTabs();
      if (created && openerId !== null) this.opened(tab, openerId);
      this.review(tab);
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
    if (cdp === null || session === null || tab.screencast === null) return;
    tab.screencast = null;
    tab.pendingAck = null;
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
    tab.pendingAck = null;
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

  private deliver(tab: Tab, header: FrameHeader, jpeg: Uint8Array): void {
    const frame = encodeFrame(header, jpeg);
    tab.lastFrame = frame;
    for (const viewer of tab.viewers) {
      // A viewer that is far behind skips frames; the next one is current.
      if (viewer.buffered() < 4 * ackThreshold) viewer.sendFrame(frame);
    }
  }

  /** Chrome sends the next frame only after an ack: ack when every viewer
   * has drained, so a slow viewer slows Chrome down, not the service's
   * memory (F39 failure modes). */
  private maybeAck(tab: Tab): void {
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId === null || tab.pendingAck === null)
      return;
    for (const viewer of tab.viewers)
      if (viewer.buffered() >= ackThreshold) return;
    const ack = tab.pendingAck;
    tab.pendingAck = null;
    void cdp
      .send("Page.screencastFrameAck", { sessionId: ack }, tab.sessionId)
      .catch(() => undefined);
  }

  private pageEvent(tab: Tab, event: CdpEvent): void {
    const p = event.params;
    switch (event.method) {
      case "Page.screencastFrame": {
        const metadata = (p.metadata ?? {}) as Record<string, number>;
        const jpeg = Buffer.from(String(p.data), "base64");
        const size = jpegSize(jpeg);
        tab.pendingAck = Number(p.sessionId);
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
      case "Page.frameNavigated": {
        const frame = p.frame as { id?: string; parentId?: string } | undefined;
        if (frame?.parentId !== undefined) return;
        if (typeof frame?.id === "string") tab.mainFrameId = frame.id;
        tab.world = null;
        tab.document += 1;
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

  // ---- Lifecycle -----------------------------------------------------------

  private held(targetId: string): boolean {
    return this.holds.holders.has(targetId) || this.holds.working.has(targetId);
  }

  /** An empty window nobody opened: the one Chrome starts with, or the hub's
   * own. */
  private blank(tab: Tab): boolean {
    return (
      (tab.info.url === "" || tab.info.url === "about:blank") &&
      tab.openerId === null &&
      tab.opener.kind !== "view" &&
      tab.opener.kind !== "new-tab" &&
      !this.holds.bound.has(tab.targetId) &&
      !this.held(tab.targetId)
    );
  }

  /** F47 point 5. A tab a strip holds or an agent works in stays. One that
   * nothing holds or views counts down: 8 s when its last hold went (the
   * window of Vrátit), 30 s when its last viewer left (F39 point 9), and 10
   * minutes when nobody has viewed or held it yet. `idle` names the count
   * for a tab with nothing before (Vrátit gives a new tab's time). */
  private review(tab: Tab, idle: GraceKind = "unviewed"): void {
    if (tab.targetId === this.keeperId || this.closing.has(tab.targetId)) {
      this.clearGrace(tab);
      return;
    }
    const before = tab.state;
    tab.state = this.held(tab.targetId)
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

  private scheduleGrace(tab: Tab, kind: GraceKind): void {
    this.clearGrace(tab);
    const ms =
      kind === "release"
        ? this.releaseGraceMs
        : kind === "viewer"
          ? this.graceMs
          : this.unviewedGraceMs;
    tab.grace = { kind, endsAt: Date.now() + ms };
    tab.graceTimer = setTimeout(() => {
      tab.graceTimer = null;
      void this.closeIfUnused(tab.targetId);
    }, ms);
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
      targetId === this.keeperId ||
      this.closing.has(targetId) ||
      this.held(targetId) ||
      tab.viewers.size > 0
    ) {
      this.review(tab);
      return;
    }
    this.seams.log(`closing unused tab ${targetId}`);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }

  /** The end of a close for everyone. While the browser is away it waits
   * for the reconnect, which finishes it. */
  private async finishClose(targetId: string): Promise<void> {
    const entry = this.closing.get(targetId);
    if (entry === undefined) return;
    entry.timer = null;
    const cdp = this.cdp;
    if (cdp === null || !this.discovered) return;
    if (!this.tabs.has(targetId)) {
      this.closing.delete(targetId);
      return;
    }
    this.seams.log(`closing tab ${targetId} for everyone`);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
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
    if (this.holdsSoon !== null || this.stopped) return;
    this.holdsSoon = setTimeout(() => {
      this.holdsSoon = null;
      void this.refreshHolds();
    }, 100);
  }

  private async refreshHolds(): Promise<void> {
    try {
      this.holds = await this.seams.holds();
    } catch (error) {
      this.seams.log(`reading the holds failed: ${String(error)}`);
      return;
    }
    for (const tab of [...this.tabs.values()]) this.review(tab);
  }

  /** Soon writes the list of live tabs (F47 point 4) from a fresh snapshot
   * of the browser's targets, not from what the hub has heard: a target whose
   * event comes late on the hub's connection is in the snapshot all the same.
   * Only while connected; one snapshot at a time, so a slower one never
   * overwrites a newer one. The hub's blank window is in no list. */
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
    }, 50);
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
      const answer = await cdp.send("Target.getTargets");
      const infos = Array.isArray(answer.targetInfos)
        ? (answer.targetInfos as Record<string, unknown>[])
        : [];
      const ids = infos
        .filter(
          (info) => info.type === "page" && typeof info.targetId === "string",
        )
        .map((info) => String(info.targetId))
        .filter((id) => id !== this.keeperId);
      await write(ids, takenAt);
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
    const pending = this.closing.get(targetId);
    if (pending !== undefined) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      this.closing.delete(targetId);
    }
    this.origins.delete(targetId);
    if (targetId === this.keeperId) {
      this.keeperId = null;
      void this.ensureKeeper();
    }
    if (tab === undefined) return;
    this.clearTimers(tab);
    this.tabs.delete(targetId);
    this.publishTabs();
    if (tab.sessionId !== null) this.bySession.delete(tab.sessionId);
    for (const [token, chooser] of this.fileChoosers)
      if (chooser.targetId === targetId) this.fileChoosers.delete(token);
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
    ])
      if (timer !== null) clearTimeout(timer);
    tab.graceTimer = null;
    tab.grace = null;
    tab.resizeTimer = null;
    tab.infoTimer = null;
    tab.selectionTimer = null;
    tab.pendingOpen = null;
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
