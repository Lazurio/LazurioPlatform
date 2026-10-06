import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type { CdpConnection, CdpEvent } from "./cdp";
import {
  type ClientMessage,
  encodeFrame,
  type FrameHeader,
  type ServerMessage,
  type ViewSize,
  viewSizeLimits,
} from "./protocol";

/** The view service's hold on the Environment browser (decision F39): every
 * page target with one DevTools session each, the people who view which tab,
 * and what the view does for them (frames, input, pop-ups, dialogs, file
 * choosers, closing an unused tab). One hub per service; it reconnects
 * whenever the browser goes away. */

/** One person's socket on one tab. */
export type Viewer = {
  send: (message: ServerMessage) => void;
  sendFrame: (frame: Uint8Array) => void;
  /** Bytes the socket has not sent yet. */
  buffered: () => number;
  close: () => void;
  size: ViewSize | null;
  resize: boolean;
};

export type HubSeams = Readonly<{
  /** Opens a DevTools connection to the browser target on loopback. */
  connect: () => Promise<CdpConnection>;
  /** The target ids agent-browser sessions are bound to right now. */
  boundTargets: () => Promise<ReadonlySet<string>>;
  /** Where uploaded files wait until the page reads them. */
  uploadDirectory: string;
  /** The virtual screen; no window grows past it. */
  screen: Readonly<{ width: number; height: number }>;
  log: (line: string) => void;
  /** Overridable for tests. */
  graceMs?: number;
  unviewedGraceMs?: number;
  reconnectMs?: number;
}>;

type Info = {
  url: string;
  title: string;
  favicon: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

type Tab = {
  targetId: string;
  sessionId: string | null;
  openerId: string | null;
  canAccessOpener: boolean;
  mainFrameId: string | null;
  info: Info;
  viewers: Set<Viewer>;
  screencast: { width: number; height: number } | null;
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
  watched: boolean;
  attaching: boolean;
  /** The view's isolated world in the main frame, until it navigates. */
  world: number | null;
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

const ackThreshold = 1 << 20;
const jpegQuality = 70;

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
  /** Tabs the view opened, or a page opened from one: the only tabs the
   * view ever closes (F39 point 9). Lost on restart, on purpose. */
  private readonly ownTabs = new Set<string>();
  private readonly fileChoosers = new Map<string, FileChooser>();
  /** Page targets discovery reported on the current connection. */
  private seen = new Set<string>();
  private discovered = false;
  private readonly graceMs: number;
  private readonly unviewedGraceMs: number;
  private readonly reconnectMs: number;

  constructor(private readonly seams: HubSeams) {
    this.graceMs = seams.graceMs ?? 30_000;
    this.unviewedGraceMs = seams.unviewedGraceMs ?? 600_000;
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
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.cdp?.close();
    this.cdp = null;
    for (const tab of this.tabs.values()) this.clearTimers(tab);
  }

  /** A new window of the default context, at the person's size when given.
   * Null when the browser cannot be reached. */
  async createTab(size: ViewSize | null): Promise<string | null> {
    const cdp = this.cdp;
    if (cdp === null) return null;
    const fitted = size === null ? null : this.windowSize(clampSize(size));
    try {
      const result = await cdp.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
        ...(fitted === null
          ? {}
          : { width: fitted.width, height: fitted.height }),
      });
      const targetId = String(result.targetId);
      this.ownTabs.add(targetId);
      const deadline = Date.now() + 2_000;
      while (!this.tabs.has(targetId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const tab = this.tabs.get(targetId);
      if (tab === undefined) return null;
      if (tab.viewers.size === 0) this.scheduleGrace(tab, this.unviewedGraceMs);
      return targetId;
    } catch (error) {
      this.seams.log(`create tab failed: ${String(error)}`);
      return null;
    }
  }

  hasTab(targetId: string): boolean {
    return this.tabs.has(targetId);
  }

  /** Adds a person's socket to a tab. False when there is no such page. */
  attach(targetId: string, viewer: Viewer): boolean {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return false;
    tab.viewers.add(viewer);
    if (tab.graceTimer !== null) {
      clearTimeout(tab.graceTimer);
      tab.graceTimer = null;
    }
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
    if (tab.viewers.size > 0) {
      void this.updateScreencast(tab);
      return;
    }
    void this.unwatch(tab);
    if (this.ownTabs.has(targetId)) this.scheduleGrace(tab, this.graceMs);
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
      if (message.t === "hello") viewer.resize = message.resize;
      if (viewer.resize) tab.lastActor = viewer;
      this.scheduleResize(tab);
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
    for (const id of [...this.ownTabs])
      if (!this.seen.has(id)) this.ownTabs.delete(id);
    this.discovered = true;
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
        watched: false,
        attaching: false,
        world: null,
        pendingOpen: null,
        selectionTimer: null,
        metaTimer: null,
      };
      this.tabs.set(targetId, tab);
      if (created && openerId !== null) this.opened(tab, openerId);
      if (this.ownTabs.has(targetId) && tab.viewers.size === 0)
        this.scheduleGrace(tab, this.unviewedGraceMs);
    } else {
      // Chrome's target title is only the address (see metaScript): it is
      // taken with a new address, and the page's own title follows.
      if (url !== tab.info.url) tab.info.title = title;
      tab.info.url = url;
      this.queueInfo(tab);
      if (tab.pendingOpen !== null && url !== "" && url !== "about:blank")
        this.announce(tab, tab.pendingOpen.openerId);
    }
    this.seen.add(targetId);
    if (tab.sessionId === null) void this.attachSession(tab);
  }

  /** A page opened by another (F39 point 4): a pop-up over its opener's
   * view, or a new tab to offer. Chrome reports it before it has an
   * address, so it is announced at its first address, or after 1.5 s. */
  private opened(tab: Tab, openerId: string): void {
    if (!this.tabs.has(openerId)) return;
    if (this.ownTabs.has(openerId)) {
      this.ownTabs.add(tab.targetId);
      this.scheduleGrace(tab, this.unviewedGraceMs);
    }
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
      void this.inWorld(tab, selectionScript).then((value) => {
        if (typeof value !== "string" || value === tab.selection) return;
        tab.selection = value;
        this.broadcast(tab, { t: "selection", text: value });
      });
    }, 40);
  }

  private async meta(tab: Tab): Promise<void> {
    const value = await this.inWorld(tab, metaScript);
    if (typeof value !== "string") return;
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
   * next paint. */
  private async firstFrame(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    if (cdp === null || tab.sessionId === null) return;
    try {
      const [shot, metrics] = await Promise.all([
        cdp.send(
          "Page.captureScreenshot",
          { format: "jpeg", quality: jpegQuality },
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

  /** (Re)starts the screencast at the largest size any viewer shows. */
  private async updateScreencast(tab: Tab): Promise<void> {
    const cdp = this.cdp;
    const session = tab.sessionId;
    if (cdp === null || session === null || !tab.watched) return;
    // Only viewers that said their size (`hello` comes right after the
    // socket opens): no screencast at a guessed size to restart a moment
    // later.
    let width = 0;
    let height = 0;
    for (const viewer of tab.viewers) {
      const size = viewer.size;
      if (size === null) continue;
      width = Math.max(width, Math.round(size.width * size.dpr));
      height = Math.max(height, Math.round(size.height * size.dpr));
    }
    if (width === 0) return;
    width = Math.min(width, viewSizeLimits.maxWidth);
    height = Math.min(height, viewSizeLimits.maxHeight);
    if (
      tab.screencast !== null &&
      tab.screencast.width === width &&
      tab.screencast.height === height
    )
      return;
    if (tab.screencast !== null)
      await cdp.send("Page.stopScreencast", {}, session).catch(() => undefined);
    tab.screencast = { width, height };
    tab.pendingAck = null;
    await cdp
      .send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality: jpegQuality,
          maxWidth: width,
          maxHeight: height,
          everyNthFrame: 1,
        },
        session,
      )
      .catch((error: unknown) => {
        tab.screencast = null;
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

  private scheduleGrace(tab: Tab, ms: number): void {
    if (tab.graceTimer !== null) clearTimeout(tab.graceTimer);
    tab.graceTimer = setTimeout(() => {
      tab.graceTimer = null;
      void this.closeIfUnused(tab.targetId);
    }, ms);
  }

  /** F39 point 9: an own tab nobody views and no agent-browser session is
   * bound to. */
  private async closeIfUnused(targetId: string): Promise<void> {
    const tab = this.tabs.get(targetId);
    const cdp = this.cdp;
    if (
      tab === undefined ||
      cdp === null ||
      tab.viewers.size > 0 ||
      !this.ownTabs.has(targetId)
    )
      return;
    const bound = await this.seams
      .boundTargets()
      .catch(() => new Set<string>([targetId]));
    if (bound.has(targetId) || tab.viewers.size > 0) return;
    this.seams.log(`closing unused tab ${targetId}`);
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }

  private gone(targetId: string): void {
    const tab = this.tabs.get(targetId);
    if (tab === undefined) return;
    this.clearTimers(tab);
    this.tabs.delete(targetId);
    this.ownTabs.delete(targetId);
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

/** The targets agent-browser sessions are bound to: its binding files
 * (`<socket dir>/<session>.target`, `{"targetId": …}`), as `lazurio browser
 * window` reads them (F38 point 3). */
export async function agentBoundTargets(
  socketDirectory: string | undefined,
): Promise<ReadonlySet<string>> {
  const bound = new Set<string>();
  if (socketDirectory === undefined) return bound;
  const names = await readdir(socketDirectory).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".target")) continue;
    try {
      const binding = JSON.parse(
        await readFile(join(socketDirectory, name), "utf8"),
      ) as { targetId?: unknown };
      if (typeof binding.targetId === "string") bound.add(binding.targetId);
    } catch {}
  }
  return bound;
}
