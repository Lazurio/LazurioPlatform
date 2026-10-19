import { environmentIdOf } from "../../shell/contract";
import { environmentElement } from "../../shell/identity-element";
import {
  acceptIdentityReply,
  parseEmbeddedIdentity,
  viewIdentityElementId,
} from "../../shell/identity-protocol";
import { type EnvironmentIdentity, titleWithIdentity } from "../../shell/view";
import {
  addressBarTarget,
  browserLanguage,
  browserTimes,
  browserViewUrl,
  identityRequestMessage,
  messageMajor,
  targetIdOf,
  viewClosedMessage,
  viewInfoMessage,
  viewNewTabMessage,
  viewPath,
  viewPathTab,
} from "../contract/pure";
import {
  aloneAddress,
  handOffNotice,
  menuStep,
  ownTabView,
  pictureKey,
  pictureOf,
} from "./bar";
import { FramePump } from "./frames";
import {
  buttonBit,
  clampInto,
  clickCount,
  containRect,
  heldButton,
  inputAction,
  type KeyMessage,
  keyAction,
  mapPoint,
  modifiersOf,
  mouseButton,
  type Point,
  type Press,
  textMessages,
  viewSize,
  wheelDelta,
} from "./input-map";
import {
  type ClientMessage,
  decodeFrame,
  type FrameHeader,
  type Picture,
  type ServerMessage,
  type ViewSize,
} from "./protocol";
import { viewStatus } from "./status";
import { type Words, words } from "./words";

// The script of the people's view of the Environment browser (decision
// F39), served as `/assets/view.js` to the page of `page.ts`: one tab of a
// person is a window into one remote tab. It opens a remote tab for `/`,
// draws the tab's frames, sends the person's pointer, touch and keys
// (input-map.ts), follows the tab in the bar, shows the tab's pop-ups over
// the page, offers its new tabs and answers its dialogs and file choosers.
// The gateway admits the person; the script carries no credential and talks
// only to its own origin (inside an app's frame it also tells that app where
// the tab is, and asks it how the Environment is named).

// The browser's language (root decision 0191 point 33: framed, the shell's
// once the identity answer carries it, F50's phase 3).
const language = browserLanguage(navigator.language);
const say: Words = words[language];

// The person's shortcuts use ⌘ on a Mac, an iPhone and an iPad (whose
// Safari says "Macintosh").
const mac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

// Inside an app's frame (web T3 Code's Browser panel, the Launchpad's right
// panel) the view tells the app where the tab is and which new tab to open,
// in the contract's messages (C8, C9). Only the app around it hears that;
// where the browser does not name it, any may, and the service lets only the
// Environment's own origins frame the view (F39 point 8). Each message goes
// once, in the highest major both read: v1 until the app's identity answer
// names its majors, and to an app that names none (F50 point 3).
const embedded = window.parent !== window;
const ancestor = location.ancestorOrigins?.item(0) ?? null;
const parentOrigin = ancestor !== null && ancestor !== "null" ? ancestor : "*";
let appMajors: readonly number[] | null = null;
function tell(message: Readonly<{ type: string; v: number }>): void {
  if (!embedded || messageMajor(appMajors) !== message.v) return;
  try {
    window.parent.postMessage(message, parentOrigin);
  } catch {}
}

// The view names its Environment at the start of the bar and in the title,
// so a person knows whose browser this is in any app's panel, in a bare tab
// or on a phone, and names it as the switcher of the Environment's apps does
// (F39's addendum of 2026-10-12): with the shell's own `<lazurio-environment>`
// and identity. First the identity the service put into the page (the
// Environment's own shell document); inside a frame, the answer of the app
// around it, whose shell also knows the person's account and so a name the
// Dashboard gave. An answer of none keeps the page's own. The app's own
// messages keep the page's title alone.
const ownEnvironment = environmentIdOf(location.origin);
const served = parseEmbeddedIdentity(
  document.getElementById(viewIdentityElementId)?.textContent,
);
let answered: EnvironmentIdentity | null = null;
const named = () => answered ?? served;
const renamedListeners = new Set<() => void>();
customElements.define(
  "lazurio-environment",
  environmentElement({
    identity: () => named(),
    listen: (changed) => {
      renamedListeners.add(changed);
      return () => {
        renamedListeners.delete(changed);
      };
    },
    request: () => undefined,
  }),
);
const badge = byId("environment", HTMLElement);
/** The remote page's title as last reported. */
let pageTitle = "";

function showTitle(): void {
  document.title = titleWithIdentity(pageTitle, named());
}

function renamed(): void {
  badge.hidden = named() === null;
  for (const listener of renamedListeners) listener();
  showTitle();
}

if (embedded) {
  let replied = false;
  window.addEventListener("message", (event) => {
    const reply = acceptIdentityReply(
      {
        data: event.data,
        origin: event.origin,
        fromParent: event.source === window.parent,
      },
      ancestor,
      ownEnvironment,
    );
    if (reply === null) return;
    replied = true;
    answered = reply.identity;
    appMajors = reply.majors;
    renamed();
  });
  // Asked again while the app has not answered: its shell may start to
  // listen after this page asked.
  for (const after of browserTimes.identityAskMs)
    setTimeout(() => {
      if (!replied) tell(identityRequestMessage());
    }, after);
}
renamed();

function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`The view page has no #${id}.`);
  return node;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function button(
  text: string,
  action: () => void,
  className = "button",
): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function label(node: HTMLElement, text: string): void {
  node.setAttribute("aria-label", text);
  node.title = text;
}

const isHttps = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

function serverMessage(data: string): ServerMessage | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" &&
      value !== null &&
      typeof (value as { t?: unknown }).t === "string"
      ? (value as ServerMessage)
      : null;
  } catch {
    return null;
  }
}

const back = byId("back", HTMLButtonElement);
const forward = byId("forward", HTMLButtonElement);
const reload = byId("reload", HTMLButtonElement);
const address = byId("address", HTMLInputElement);
const notice = byId("notice", HTMLDivElement);
const noticeText = byId("notice-text", HTMLSpanElement);
const noticeOpen = byId("notice-open", HTMLButtonElement);
const noticeClose = byId("notice-close", HTMLButtonElement);
const area = byId("area", HTMLElement);
const banner = byId("banner", HTMLDivElement);
const favicon = byId("icon", HTMLLinkElement);
const defaultIcon = favicon.href;

document.documentElement.lang = language;
label(back, say.back);
label(forward, say.forward);
label(reload, say.reload);
label(noticeClose, say.dismiss);
address.placeholder = say.address;
address.setAttribute("aria-label", say.address);
noticeOpen.textContent = say.open;
banner.textContent = say.reconnecting;

type Info = Extract<ServerMessage, { t: "info" }>;
type Dialog = Extract<ServerMessage, { t: "dialog" }>;
type Files = Extract<ServerMessage, { t: "files" }>;
type Touch = {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  tap: boolean;
};
type Wheel = Readonly<{
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  buttons: number;
  modifiers: number;
}>;

type ViewerOptions = Readonly<{
  /** The person's own tab, whose window takes the page area's size (F39
   * point 3); false for a pop-up over it, which keeps the size its opener
   * gave it. */
  resize: boolean;
  info: (info: Info) => void;
  /** The remote tab no longer exists. */
  closed: () => void;
  /** The remote viewport changed size (a pop-up's panel follows it). */
  viewport?: (width: number, height: number) => void;
}>;

const firstRetryMs = 500;
const lastRetryMs = 10_000;
const sizeDelayMs = 150;
// A touch that moves further is a gesture, not a tap.
const tapDistance = 10;
const modifierKeys = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
]);
const sizeKey = (size: ViewSize) => `${size.width}x${size.height}@${size.dpr}`;

/** The person's picture quality (F39's addendum of 2026-10-13), kept in the
 * browser's storage of the view's origin: one choice per Environment on this
 * device. Where the browser keeps no storage for the page it is Standard, and
 * a choice holds for the page's life. Every viewer, the page's own and its
 * pop-ups', says it in its `hello` and when the person changes it. */
function storedPicture(): Picture {
  try {
    return pictureOf(localStorage.getItem(pictureKey));
  } catch {
    return "standard";
  }
}
let picture: Picture = storedPicture();

/** One remote tab in one box of the page: its socket, its frames and the
 * person's input to it. The page's own tab and each pop-up over it are one
 * viewer each. */
class Viewer {
  readonly box = element("div", "page");
  private readonly screen = element("canvas", "screen");
  // The person's keys go to this field while they work in the page: hidden,
  // focusable, so it also receives `paste`, `copy`, `cut`, input methods and
  // a phone's keyboard.
  private readonly keys = element("textarea", "keys");
  private readonly status = element("div", "status", say.connecting);
  private readonly context: CanvasRenderingContext2D | null;
  private readonly observer: ResizeObserver;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryMs = firstRetryMs;
  private ended = false;
  /** The Environment's browser reconnects (the hub said so): the view is
   * connected, but the tab is not loading anything meanwhile. */
  private browserReconnecting = false;
  private bitmap: ImageBitmap | null = null;
  private header: FrameHeader | null = null;
  /** The frames: the newest drawn while one decodes, each acknowledged once
   * the view is done with it (F39's addendum of 2026-10-13). */
  private readonly frames = new FramePump<Uint8Array, ImageBitmap>({
    // The frame's bytes are a view of the socket's own ArrayBuffer.
    decode: (jpeg) =>
      createImageBitmap(
        new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      ),
    show: (bitmap, header) => this.show(bitmap, header),
    ack: (frame) => {
      this.send({ t: "ack", frame });
    },
  });
  private sizeTimer: ReturnType<typeof setTimeout> | null = null;
  private sentSize = "";
  private selection = "";
  /** Keys whose key down the remote page had, by the person's `code`. */
  private readonly down = new Map<string, KeyMessage>();
  private composing = false;
  /** The person's buttons as last reported, and whether the remote page
   * has a press of this view that is not released yet. */
  private buttons = 0;
  private pressed = false;
  private press: Press | null = null;
  /** The newest move (mouse or touch) and the wheel's sum, sent once per
   * animation frame. */
  private moving: ClientMessage | null = null;
  private wheel: Wheel | null = null;
  private frameRequest = 0;
  private readonly touches = new Map<number, Touch>();
  private dialog: HTMLDialogElement | null = null;
  private chooser: Readonly<{
    dialog: HTMLDialogElement;
    token: string;
    abort: AbortController;
  }> | null = null;

  constructor(
    readonly id: string,
    parent: HTMLElement,
    private readonly options: ViewerOptions,
  ) {
    this.context = this.screen.getContext("2d");
    const keys = this.keys;
    keys.value = " ";
    keys.setAttribute("aria-label", say.page);
    keys.setAttribute("autocapitalize", "off");
    keys.setAttribute("autocomplete", "off");
    keys.setAttribute("autocorrect", "off");
    keys.setAttribute("spellcheck", "false");
    keys.setAttribute("wrap", "off");
    this.status.setAttribute("role", "status");
    this.box.append(this.screen, keys, this.status);
    parent.append(this.box);
    this.listen();
    this.observer = new ResizeObserver(() => this.resized());
    this.observer.observe(this.box);
  }

  start(): void {
    this.connect();
  }

  /** For good: no reconnect, the socket and the modals closed. The last
   * frame stays drawn. */
  stop(): void {
    this.ended = true;
    if (this.retry !== null) clearTimeout(this.retry);
    if (this.sizeTimer !== null) clearTimeout(this.sizeTimer);
    if (this.frameRequest !== 0) cancelAnimationFrame(this.frameRequest);
    this.retry = null;
    this.sizeTimer = null;
    this.frameRequest = 0;
    this.observer.disconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.closeDialog();
    this.closeChooser(null);
    this.showStatus();
  }

  /** Sends when connected; input while the socket is down is dropped (the
   * remote page moves on, F39 failure modes). */
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  /** The person's keys go into this tab. */
  focus(): void {
    if (this.ended) return;
    this.keys.focus({ preventScroll: true });
    this.resetKeys();
  }

  // ---- The socket ----------------------------------------------------------

  private connect(): void {
    this.retry = null;
    if (this.ended) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}${viewPath(this.id)}/live`,
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      const size = this.size();
      this.sentSize = sizeKey(size);
      this.send({
        t: "hello",
        ...size,
        resize: this.options.resize,
        picture,
        acks: true,
      });
      this.showStatus();
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.retryMs = firstRetryMs;
      if (typeof event.data === "string") this.message(event.data);
      else if (event.data instanceof ArrayBuffer) {
        const frame = decodeFrame(event.data);
        if (frame !== null) this.frames.push(frame);
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      // What the remote page had down went with the socket.
      this.down.clear();
      this.touches.clear();
      this.pressed = false;
      this.showStatus();
      if (this.ended) return;
      this.retry = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, lastRetryMs);
    });
  }

  private message(data: string): void {
    const message = serverMessage(data);
    if (message === null) return;
    switch (message.t) {
      case "info":
        this.options.info(message);
        return;
      case "selection":
        this.selection = message.text;
        return;
      case "popup":
        openPopup(message.id, message.url);
        return;
      case "new-tab":
        offerNewTab(message.id, message.url);
        return;
      case "hand-off": {
        // A page of the person's Lazurio account (#504): their own browser
        // opens it, never this one.
        const found = handOffNotice(message.url, say);
        if (found !== null)
          showNotice(found.text, found.open, found.title, found.button);
        return;
      }
      case "dialog":
        this.showDialog(message);
        return;
      case "dialog-closed":
        this.closeDialog();
        return;
      case "files":
        this.showChooser(message);
        return;
      case "files-closed":
        this.closeChooser(message.token);
        return;
      case "browser":
        banner.hidden = message.state !== "reconnecting";
        this.browserReconnecting = message.state === "reconnecting";
        this.showStatus();
        return;
      case "closed":
        this.stop();
        this.options.closed();
        return;
    }
  }

  private showStatus(): void {
    const status = viewStatus({
      ended: this.ended,
      open: this.socket?.readyState === WebSocket.OPEN,
      drawn: this.bitmap !== null,
      browserReconnecting: this.browserReconnecting,
    });
    this.status.hidden = status === "hidden";
    if (status !== "hidden")
      this.status.textContent =
        status === "loading" ? say.loading : say.connecting;
  }

  // ---- Frames and size -----------------------------------------------------

  /** A frame drawn: the newest that waited while the one before decoded
   * (`FramePump`, which then acknowledges it). */
  private show(bitmap: ImageBitmap, header: FrameHeader): void {
    const before = this.header;
    this.bitmap?.close();
    this.bitmap = bitmap;
    this.header = header;
    this.draw();
    this.showStatus();
    if (
      before?.deviceWidth !== header.deviceWidth ||
      before?.deviceHeight !== header.deviceHeight
    )
      this.options.viewport?.(header.deviceWidth, header.deviceHeight);
  }

  private draw(): void {
    const context = this.context;
    if (context === null) return;
    context.clearRect(0, 0, this.screen.width, this.screen.height);
    if (this.bitmap === null) return;
    const drawn = containRect(this.screen, this.bitmap);
    context.imageSmoothingQuality = "high";
    context.drawImage(
      this.bitmap,
      drawn.left,
      drawn.top,
      drawn.width,
      drawn.height,
    );
  }

  private size(): ViewSize {
    return viewSize(
      this.box.clientWidth,
      this.box.clientHeight,
      window.devicePixelRatio || 1,
    );
  }

  /** The canvas follows the box at once; the remote window follows it a
   * moment later (`size`), once the box has stopped changing. */
  private resized(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.box.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.box.clientHeight * ratio));
    if (this.screen.width !== width || this.screen.height !== height) {
      this.screen.width = width;
      this.screen.height = height;
      this.draw();
    }
    if (this.sizeTimer !== null) clearTimeout(this.sizeTimer);
    this.sizeTimer = setTimeout(() => {
      this.sizeTimer = null;
      const size = this.size();
      if (sizeKey(size) === this.sentSize) return;
      if (this.send({ t: "size", ...size })) this.sentSize = sizeKey(size);
    }, sizeDelayMs);
  }

  // ---- Pointer and touch ---------------------------------------------------

  private listen(): void {
    const screen = this.screen;
    screen.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (event.pointerType === "touch") this.touchStart(event);
      else this.mouseDown(event);
    });
    screen.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") this.touchMove(event);
      else this.mouseMove(event);
    });
    screen.addEventListener("pointerup", (event) => {
      event.preventDefault();
      if (event.pointerType === "touch") this.touchEnd(event, false);
      else this.button(event, "mouseReleased", true);
    });
    screen.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") this.touchEnd(event, true);
    });
    // The compatibility mouse events would take the focus off the keys, and
    // a back or forward button would take the person's own tab back.
    for (const type of [
      "mousedown",
      "mouseup",
      "auxclick",
      "contextmenu",
      "dragstart",
    ] as const)
      screen.addEventListener(type, (event) => event.preventDefault());
    screen.addEventListener("wheel", (event) => this.wheeled(event), {
      passive: false,
    });
    this.listenToKeys();
  }

  /** The event's place on the remote page; with `clamp`, a place outside
   * the frame counts as its nearest edge (a drag that left the frame). */
  private at(event: MouseEvent, clamp: boolean): Point | null {
    if (this.bitmap === null || this.header === null) return null;
    const box = this.screen.getBoundingClientRect();
    const inner = containRect(box, this.bitmap);
    const drawn = {
      left: box.left + inner.left,
      top: box.top + inner.top,
      width: inner.width,
      height: inner.height,
    };
    const client = { x: event.clientX, y: event.clientY };
    return mapPoint(
      clamp ? clampInto(client, drawn) : client,
      drawn,
      this.header,
    );
  }

  private mouseDown(event: PointerEvent): void {
    this.focus();
    this.placeKeys(event);
    this.capture(event);
    this.button(event, "mousePressed", false);
  }

  /** Keeps a drag's moves on this view when it leaves the frame. A pointer
   * that is no longer active cannot be captured (NotFoundError); the press
   * still goes to the remote page. */
  private capture(event: PointerEvent): void {
    try {
      this.screen.setPointerCapture(event.pointerId);
    } catch {}
  }

  private mouseMove(event: PointerEvent): void {
    // A second button pressed or released while another is held comes as a
    // move (chorded buttons).
    if (event.buttons !== this.buttons && event.button >= 0) {
      const pressed = (event.buttons & buttonBit(event.button)) !== 0;
      this.button(event, pressed ? "mousePressed" : "mouseReleased", true);
      return;
    }
    const at = this.at(event, this.pressed);
    if (at === null) return;
    this.moving = {
      t: "mouse",
      type: "mouseMoved",
      x: at.x,
      y: at.y,
      button: heldButton(event.buttons),
      buttons: event.buttons,
      clickCount: 0,
      modifiers: modifiersOf(event, mac),
    };
    this.schedule();
  }

  /** A press or a release, after the move before it. A release only of a
   * press the remote page had; a press outside the frame is none. */
  private button(
    event: PointerEvent,
    type: "mousePressed" | "mouseReleased",
    clamp: boolean,
  ): void {
    this.buttons = event.buttons;
    if (type === "mouseReleased" && !this.pressed) return;
    const at = this.at(event, clamp);
    if (at === null) return;
    this.flush();
    const button = mouseButton(event.button);
    if (type === "mousePressed") {
      const press = {
        time: event.timeStamp,
        x: event.clientX,
        y: event.clientY,
        button,
      };
      this.press = { ...press, count: clickCount(this.press, press) };
    }
    const sent = this.send({
      t: "mouse",
      type,
      x: at.x,
      y: at.y,
      button,
      buttons: event.buttons,
      clickCount: this.press?.button === button ? this.press.count : 1,
      modifiers: modifiersOf(event, mac),
    });
    this.pressed = sent && (type === "mousePressed" || event.buttons !== 0);
  }

  private wheeled(event: WheelEvent): void {
    event.preventDefault();
    const at = this.at(event, false);
    if (at === null || this.header === null) return;
    const delta = wheelDelta(event, this.header.deviceHeight);
    const before = this.wheel;
    this.wheel = {
      x: at.x,
      y: at.y,
      deltaX: (before?.deltaX ?? 0) + delta.deltaX,
      deltaY: (before?.deltaY ?? 0) + delta.deltaY,
      buttons: event.buttons,
      modifiers: modifiersOf(event, mac),
    };
    this.schedule();
  }

  private schedule(): void {
    if (this.frameRequest !== 0) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.flush();
    });
  }

  /** Sends the waiting move and wheel now: before a press, a release or a
   * touch that follows them. */
  private flush(): void {
    if (this.frameRequest !== 0) cancelAnimationFrame(this.frameRequest);
    this.frameRequest = 0;
    const moving = this.moving;
    this.moving = null;
    if (moving !== null) this.send(moving);
    const wheel = this.wheel;
    this.wheel = null;
    if (wheel === null) return;
    const delta = wheelDelta({ ...wheel, deltaMode: 0 }, 0);
    this.send({
      t: "mouse",
      type: "mouseWheel",
      x: wheel.x,
      y: wheel.y,
      button: "none",
      buttons: wheel.buttons,
      clickCount: 0,
      modifiers: wheel.modifiers,
      deltaX: delta.deltaX,
      deltaY: delta.deltaY,
    });
  }

  private touchStart(event: PointerEvent): void {
    if (this.touches.size >= 10) return;
    const at = this.at(event, false);
    if (at === null) return;
    this.capture(event);
    const ids = new Set([...this.touches.values()].map((touch) => touch.id));
    let id = 0;
    while (ids.has(id)) id += 1;
    // A second finger makes a gesture of the first, not a tap.
    for (const touch of this.touches.values()) touch.tap = false;
    this.touches.set(event.pointerId, {
      id,
      x: at.x,
      y: at.y,
      startX: event.clientX,
      startY: event.clientY,
      tap: this.touches.size === 0,
    });
    this.flush();
    this.send(this.touchMessage("touchStart", event));
  }

  private touchMove(event: PointerEvent): void {
    const touch = this.touches.get(event.pointerId);
    if (touch === undefined) return;
    const at = this.at(event, true);
    if (at === null) return;
    touch.x = at.x;
    touch.y = at.y;
    if (
      Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) >
      tapDistance
    )
      touch.tap = false;
    this.moving = this.touchMessage("touchMove", event);
    this.schedule();
  }

  private touchEnd(event: PointerEvent, cancelled: boolean): void {
    const touch = this.touches.get(event.pointerId);
    if (touch === undefined) return;
    this.touches.delete(event.pointerId);
    this.flush();
    // While other fingers stay, the remote lifts the one that is gone from
    // the points it no longer gets.
    this.send(
      this.touchMessage(
        this.touches.size > 0
          ? "touchMove"
          : cancelled
            ? "touchCancel"
            : "touchEnd",
        event,
      ),
    );
    // A tap opens the phone's keyboard (F39 point 6); only a focus within
    // the tap itself does.
    if (!cancelled && touch.tap) {
      this.placeKeys(event);
      this.focus();
    }
  }

  private touchMessage(
    type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    event: PointerEvent,
  ): ClientMessage {
    return {
      t: "touch",
      type,
      // An end or a cancel carries no point (CDP's rule).
      points:
        type === "touchEnd" || type === "touchCancel"
          ? []
          : [...this.touches.values()].map(({ id, x, y }) => ({ id, x, y })),
      modifiers: modifiersOf(event, mac),
    };
  }

  // ---- Keys and the clipboard ----------------------------------------------

  private listenToKeys(): void {
    const keys = this.keys;
    keys.addEventListener("keydown", (event) => this.key(event));
    keys.addEventListener("keyup", (event) => this.key(event));
    keys.addEventListener("focus", () => this.resetKeys());
    // Key ups go elsewhere now: what the remote page has down goes up.
    keys.addEventListener("blur", () => this.releaseKeys(false, 0));
    keys.addEventListener("paste", (event) => {
      event.preventDefault();
      this.sendAll(
        textMessages(event.clipboardData?.getData("text/plain") ?? ""),
      );
    });
    keys.addEventListener("copy", (event) => this.copy(event));
    keys.addEventListener("cut", (event) => this.copy(event));
    // A phone's keyboard: its keys come as `keyCode` 229, their edits here.
    keys.addEventListener("beforeinput", (event) => {
      const messages = inputAction(
        event.inputType,
        event.data ?? event.dataTransfer?.getData("text/plain") ?? null,
      );
      if (messages === null) return;
      if (event.cancelable) event.preventDefault();
      this.sendAll(messages);
    });
    keys.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    keys.addEventListener("compositionend", (event) => {
      this.composing = false;
      this.sendAll(textMessages(event.data));
      setTimeout(() => {
        if (!this.composing) this.resetKeys();
      }, 0);
    });
    keys.addEventListener("input", (event) => {
      if (this.composing || (event instanceof InputEvent && event.isComposing))
        return;
      this.resetKeys();
    });
  }

  private sendAll(messages: readonly ClientMessage[]): void {
    for (const message of messages) this.send(message);
  }

  private key(event: KeyboardEvent): void {
    const action = keyAction(
      {
        type: event.type === "keyup" ? "keyup" : "keydown",
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        altGraph: event.getModifierState("AltGraph"),
        location: event.location,
        repeat: event.repeat,
        isComposing: event.isComposing,
      },
      mac,
    );
    if (action.preventDefault) event.preventDefault();
    const message = action.send;
    if (message === null) return;
    if (message.type === "keyDown") {
      if (this.send(message)) this.down.set(event.code, message);
      return;
    }
    // A key up only for a key the remote page saw go down.
    if (!this.down.delete(event.code)) return;
    this.send(message);
    // While ⌘ is held a Mac reports no key up for the other keys: they go up
    // with it.
    if (mac && event.key === "Meta") this.releaseKeys(true, message.modifiers);
  }

  /** Key ups for what the remote page has down: every key, or with
   * `keysOnly` all but the modifiers. */
  private releaseKeys(keysOnly: boolean, modifiers: number): void {
    for (const [code, down] of this.down) {
      if (keysOnly && modifierKeys.has(down.key)) continue;
      this.down.delete(code);
      this.send({
        t: "key",
        type: "keyUp",
        key: down.key,
        code: down.code,
        keyCode: down.keyCode,
        modifiers,
        location: down.location,
        repeat: false,
      });
    }
  }

  /** Copy and cut put the remote selection on the person's clipboard (F39
   * point 6). With nothing selected the clipboard is not given the field's
   * space. */
  private copy(event: ClipboardEvent): void {
    event.preventDefault();
    if (this.selection !== "")
      event.clipboardData?.setData("text/plain", this.selection);
  }

  /** One selected space: browsers fire `copy` and `cut` only with a
   * selection, and a phone's Backspace needs something to delete. */
  private resetKeys(): void {
    if (this.keys.value !== " ") this.keys.value = " ";
    this.keys.setSelectionRange(0, 1);
  }

  /** The keys' field under the pointer, where an input method shows its
   * candidates and a phone scrolls to. */
  private placeKeys(event: MouseEvent): void {
    const box = this.box.getBoundingClientRect();
    this.keys.style.left = `${Math.round(event.clientX - box.left)}px`;
    this.keys.style.top = `${Math.round(event.clientY - box.top)}px`;
  }

  // ---- Dialogs and file choosers -------------------------------------------

  private showModal(dialog: HTMLDialogElement): void {
    document.body.append(dialog);
    dialog.showModal();
  }

  /** A JavaScript dialog of the remote page, answered here (F39 point 7). */
  private showDialog(message: Dialog): void {
    this.closeDialog();
    const dialog = element("dialog", "modal");
    const leave = message.kind === "beforeunload";
    let field: HTMLInputElement | null = null;
    const answer = (accept: boolean) => {
      this.send(
        accept && field !== null
          ? { t: "dialog", accept, text: field.value }
          : { t: "dialog", accept },
      );
      this.closeDialog();
    };
    if (leave)
      dialog.append(
        element("h2", "", say.leaveTitle),
        element("p", "message", say.leaveText),
      );
    // The page's words as text, never as markup.
    else dialog.append(element("p", "message", message.message));
    if (message.kind === "prompt") {
      const input = element("input", "field");
      input.type = "text";
      input.value = message.defaultPrompt;
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        answer(true);
      });
      dialog.append(input);
      field = input;
    }
    const ok = button(
      leave ? say.leave : say.ok,
      () => answer(true),
      "button primary",
    );
    const actions = element("div", "actions");
    if (message.kind !== "alert")
      actions.append(
        button(leave ? say.stay : say.cancel, () => answer(false)),
      );
    actions.append(ok);
    dialog.append(actions);
    // Escape cancels; an alert has only OK.
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      answer(message.kind === "alert");
    });
    this.dialog = dialog;
    this.showModal(dialog);
    if (field === null) ok.focus();
    else {
      field.focus();
      field.select();
    }
  }

  private closeDialog(): void {
    const dialog = this.dialog;
    if (dialog === null) return;
    this.dialog = null;
    dialog.close();
    dialog.remove();
    this.focus();
  }

  /** The remote page asked for files: the person picks them here and they
   * are uploaded to the Environment for the page's input (F39 point 7). */
  private showChooser(message: Files): void {
    this.closeChooser(null);
    const { token } = message;
    const abort = new AbortController();
    const dialog = element("dialog", "modal");
    const input = element("input");
    input.type = "file";
    input.multiple = message.multiple;
    const error = element("p", "error", say.uploadFailed);
    error.hidden = true;
    const cancel = () => {
      this.send({ t: "files-cancel", token });
      this.closeChooser(token);
    };
    const upload = button(say.upload, () => void submit(), "button primary");
    upload.disabled = true;
    input.addEventListener("change", () => {
      upload.disabled = (input.files?.length ?? 0) === 0;
    });
    const submit = async () => {
      const form = new FormData();
      for (const file of input.files ?? []) form.append("file", file);
      upload.disabled = true;
      input.disabled = true;
      upload.textContent = say.uploading;
      error.hidden = true;
      const done = await fetch(
        `${viewPath(this.id)}/files?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          body: form,
          credentials: "same-origin",
          signal: abort.signal,
        },
      ).then(
        (response) => response.ok,
        () => false,
      );
      if (abort.signal.aborted) return;
      if (done) {
        this.closeChooser(token);
        return;
      }
      upload.disabled = false;
      input.disabled = false;
      upload.textContent = say.upload;
      error.hidden = false;
    };
    const actions = element("div", "actions");
    actions.append(button(say.cancel, cancel), upload);
    dialog.append(
      element("h2", "", message.multiple ? say.files : say.file),
      input,
      error,
      actions,
    );
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancel();
    });
    this.chooser = { dialog, token, abort };
    this.showModal(dialog);
    input.focus();
  }

  /** Closes the file chooser: any, or only the one of `token` (it was
   * answered, here or by another view). */
  private closeChooser(token: string | null): void {
    const chooser = this.chooser;
    if (chooser === null || (token !== null && chooser.token !== token)) return;
    this.chooser = null;
    chooser.abort.abort();
    chooser.dialog.close();
    chooser.dialog.remove();
    this.focus();
  }
}

// ---- The page's own tab --------------------------------------------------

let main: Viewer | null = null;
/** The remote tab's address as last reported, and whether it loads. */
let current = "";
let loading = false;
/** The address bar: just focused (its text selected), typed in since, just
 * submitted. Until the person types, the tab's address replaces its text,
 * as in a browser's own bar. */
let justFocused = false;
let edited = false;
let submitted = false;
/** What the notice's Otevřít opens in a new tab of the person's browser:
 * the view of a page's new tab, or another Environment's view; null for a
 * notice that only says something. */
let offered: string | null = null;

const shown = (url: string) => (url === "about:blank" ? "" : url);

function showInfo(info: Info): void {
  current = info.url;
  if (!edited) {
    address.value = shown(info.url);
    if (document.activeElement === address) address.select();
  }
  back.disabled = !info.canGoBack;
  forward.disabled = !info.canGoForward;
  loading = info.loading;
  reload.dataset.state = loading ? "stop" : "reload";
  label(reload, loading ? say.stop : say.reload);
  pageTitle = info.title || info.url;
  showTitle();
  const icon =
    info.favicon !== null && isHttps(info.favicon) ? info.favicon : defaultIcon;
  if (favicon.href !== icon) favicon.href = icon;
  // The tab by its view address in the contract's form, whatever the
  // page's own address says.
  const view = ownTabView(location.origin, main?.id ?? null, location.pathname);
  if (view !== null) tell(viewInfoMessage(view, info.url, info.title));
}

function navigate(action: "back" | "forward" | "reload" | "stop"): void {
  main?.send({ t: "nav", action });
  main?.focus();
}

back.addEventListener("click", () => navigate("back"));
forward.addEventListener("click", () => navigate("forward"));
reload.addEventListener("click", () => navigate(loading ? "stop" : "reload"));

// Focus selects the whole address; the click that focused it would place
// the caret instead, so its mouseup keeps the selection.
address.addEventListener("focus", () => {
  address.select();
  justFocused = true;
});
address.addEventListener("mouseup", (event) => {
  if (justFocused) event.preventDefault();
  justFocused = false;
});
address.addEventListener("input", () => {
  edited = true;
});
address.addEventListener("keydown", (event) => {
  justFocused = false;
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    if (main === null) return;
    // The address bar is Chrome's, as Nová karta's (F50 point 2), and loads
    // nothing on a view host in the Environment browser.
    const target = addressBarTarget(address.value, location.origin);
    switch (target.kind) {
      case "none":
        return;
      case "page":
        submitted = true;
        address.value = target.url;
        main.send({ t: "goto", url: target.url });
        main.focus();
        return;
      case "tab":
      case "new-tab":
        address.value = shown(current);
        void openOwnTab(target.kind === "tab" ? target.tab : null);
        return;
      case "foreign":
        address.value = shown(current);
        showNotice(say.foreignView, target.href, target.href);
        return;
      case "refused":
        showNotice(
          target.reason === "view"
            ? say.addressRefused
            : say.addressRefusedScheme,
          null,
        );
        return;
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    address.value = shown(current);
    main?.focus();
  }
});
address.addEventListener("blur", () => {
  justFocused = false;
  if (!submitted) address.value = shown(current);
  edited = false;
  submitted = false;
});

// ---- Kvalita obrazu and Otevřít samostatně (F39's addendum of 2026-10-13) --

const pictureBox = byId("picture-box", HTMLDivElement);
const pictureButton = byId("picture", HTMLButtonElement);
const pictureMenu = byId("picture-menu", HTMLDivElement);
const pictureItems = [
  ...pictureMenu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
];
const alone = byId("alone", HTMLButtonElement);

pictureMenu.setAttribute("aria-label", say.picture);
byId("picture-title", HTMLDivElement).textContent = say.picture;
for (const item of pictureItems) {
  const saver = pictureOf(item.dataset.picture) === "saver";
  const name = item.querySelector(".menu-label");
  if (name !== null)
    name.textContent = saver ? say.pictureSaver : say.pictureStandard;
  const hint = item.querySelector(".menu-hint");
  if (hint !== null) hint.textContent = say.pictureSaverHint;
}
// Only inside an app's frame: a view that is a tab of its own is the tab on
// its own already.
alone.hidden = !embedded;
label(alone, say.openAlone);

/** The button names the choice and is marked while Data saver is on; the
 * menu checks the chosen item. */
function showPicture(): void {
  pictureButton.dataset.picture = picture;
  label(
    pictureButton,
    `${say.picture}: ${picture === "saver" ? say.pictureSaver : say.pictureStandard}`,
  );
  for (const item of pictureItems)
    item.setAttribute(
      "aria-checked",
      String(pictureOf(item.dataset.picture) === picture),
    );
}

/** A choice for the page's own tab and every pop-up over it, at once; a
 * viewer whose socket is down says it in its next `hello`. */
function applyPicture(next: Picture): void {
  if (next === picture) return;
  picture = next;
  showPicture();
  main?.send({ t: "picture", picture });
  for (const popup of popups.values())
    popup.viewer.send({ t: "picture", picture });
}

/** The person's choice, kept for this Environment on this device. */
function choosePicture(next: Picture): void {
  try {
    if (next === "saver") localStorage.setItem(pictureKey, next);
    else localStorage.removeItem(pictureKey);
  } catch {}
  applyPicture(next);
}

function openMenu(focus: "chosen" | "first" | "last"): void {
  pictureMenu.hidden = false;
  pictureButton.setAttribute("aria-expanded", "true");
  const chosen = pictureItems.findIndex(
    (item) => pictureOf(item.dataset.picture) === picture,
  );
  const index =
    focus === "first"
      ? 0
      : focus === "last"
        ? pictureItems.length - 1
        : Math.max(0, chosen);
  pictureItems[index]?.focus();
}

function closeMenu(returnFocus: boolean): void {
  if (pictureMenu.hidden) return;
  pictureMenu.hidden = true;
  pictureButton.setAttribute("aria-expanded", "false");
  if (returnFocus) pictureButton.focus();
}

// Enter and Space on the button click it.
pictureButton.addEventListener("click", () => {
  if (pictureMenu.hidden) openMenu("chosen");
  else closeMenu(true);
});
pictureButton.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  openMenu(event.key === "ArrowDown" ? "first" : "last");
});
pictureMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  // Tab moves on, and the menu closes behind it.
  if (event.key === "Tab") {
    closeMenu(false);
    return;
  }
  const focused = document.activeElement;
  const next = menuStep(
    event.key,
    focused instanceof HTMLButtonElement ? pictureItems.indexOf(focused) : -1,
    pictureItems.length,
  );
  if (next === null) return;
  event.preventDefault();
  pictureItems[next]?.focus();
});
for (const item of pictureItems)
  item.addEventListener("click", () => {
    closeMenu(false);
    choosePicture(pictureOf(item.dataset.picture));
    // The keys go back to the page, as after the bar's other buttons.
    main?.focus();
  });
// A press anywhere else closes the menu and still does what it does; so does
// leaving the window (a click in the app around the view).
document.addEventListener(
  "pointerdown",
  (event) => {
    if (event.target instanceof Node && pictureBox.contains(event.target))
      return;
    closeMenu(false);
  },
  true,
);
window.addEventListener("blur", () => closeMenu(false));
// Another tab of this browser changed the choice for this Environment.
window.addEventListener("storage", (event) => {
  if (event.key === pictureKey || event.key === null)
    applyPicture(storedPicture());
});
showPicture();

alone.addEventListener("click", () => {
  const view = aloneAddress(embedded, location.origin, main?.id ?? null);
  if (view !== null) window.open(view, "_blank", "noopener");
});

/** The notice above the page: its text, what its button opens in a new tab
 * of the person's own browser (none without the button), its title and the
 * button's label, Otevřít unless said otherwise. */
function showNotice(
  text: string,
  open: string | null,
  title = text,
  button = say.open,
): void {
  offered = open;
  noticeText.textContent = text;
  noticeText.title = title;
  noticeOpen.textContent = button;
  noticeOpen.hidden = open === null;
  notice.hidden = false;
}

/** A page's new tab without access to its opener (F39 point 4): offered with
 * one click, and to the app around the view. */
function offerNewTab(id: string, url: string): void {
  const tab = targetIdOf(id);
  if (tab === null) return;
  showNotice(`${say.newTab}: ${url}`, viewPath(tab), url);
  tell(viewNewTabMessage(browserViewUrl(location.origin, tab), url));
}

/** A tab of this Environment's view typed into the bar, or a new one for
 * its bare origin (`tab` null), which the Environment browser never loads
 * inside a tab (F50 point 2): inside an app's frame the app opens it as a
 * tab of its own, as it does a page's new tab; on its own the view goes to
 * it. Its own tab just takes the focus. */
async function openOwnTab(tab: string | null): Promise<void> {
  if (tab !== null && tab === main?.id) {
    main.focus();
    return;
  }
  if (!embedded) {
    location.assign(viewPath(tab));
    return;
  }
  const id = tab ?? (await createTab());
  if (id === null) {
    showNotice(say.startFailed, null);
    return;
  }
  tell(
    viewNewTabMessage(
      browserViewUrl(location.origin, id),
      tab === null ? "about:blank" : "",
    ),
  );
}

function dismissNotice(): void {
  notice.hidden = true;
  offered = null;
  main?.focus();
}

noticeOpen.addEventListener("click", () => {
  if (offered !== null) window.open(offered, "_blank", "noopener");
  dismissNotice();
});
noticeClose.addEventListener("click", dismissNotice);

// ---- Pop-ups -------------------------------------------------------------

// Pop-ups lie over the page, each in a panel of its own size, the newest on
// top (F39 point 4); around them the page stays usable, as around a pop-up
// window.
const popupLayer = element("div", "popups");
const popups = new Map<
  string,
  Readonly<{ panel: HTMLElement; viewer: Viewer; fit: () => void }>
>();
new ResizeObserver(() => {
  for (const popup of popups.values()) popup.fit();
}).observe(popupLayer);

function openPopup(opened: string, url: string): void {
  const id = targetIdOf(opened);
  if (id === null || popups.has(id)) return;
  const panel = element("section", "popup");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", hostOf(url));
  const title = element("span", "popup-title", hostOf(url));
  const close = button("", () => viewer.send({ t: "close" }), "tool");
  label(close, say.closeWindow);
  const cross = noticeClose.querySelector("svg");
  if (cross !== null) close.append(cross.cloneNode(true));
  const head = element("div", "popup-head");
  head.append(title, close);
  const body = element("div", "popup-body");
  panel.append(head, body);
  popupLayer.append(panel);
  // The pop-up's own size, as its opener chose it; smaller only where the
  // page area is.
  let wanted = { width: 480, height: 600 };
  const fit = () => {
    const room = popupLayer.getBoundingClientRect();
    const scale = Math.min(
      1,
      (room.width - 32) / wanted.width,
      (room.height - 32 - head.offsetHeight) / wanted.height,
    );
    body.style.width = `${Math.max(1, Math.floor(wanted.width * scale))}px`;
    body.style.height = `${Math.max(1, Math.floor(wanted.height * scale))}px`;
  };
  const viewer = new Viewer(id, body, {
    resize: false,
    info: (info) => {
      title.textContent = hostOf(info.url);
      panel.setAttribute("aria-label", title.textContent);
    },
    closed: () => closePopup(id),
    viewport: (width, height) => {
      wanted = { width, height };
      fit();
    },
  });
  popups.set(id, { panel, viewer, fit });
  fit();
  viewer.start();
  viewer.focus();
}

function closePopup(id: string): void {
  const popup = popups.get(id);
  if (popup === undefined) return;
  popups.delete(id);
  const focused = popup.panel.contains(document.activeElement);
  popup.viewer.stop();
  popup.panel.remove();
  if (focused) ([...popups.values()].at(-1)?.viewer ?? main)?.focus();
}

// ---- Start ---------------------------------------------------------------

/** A message over the page area with one action. */
function showEnd(text: string, action: string, act: () => void): HTMLElement {
  const panel = element("div", "end");
  const go = button(action, act, "button primary");
  panel.append(element("p", "", text), go);
  area.append(panel);
  go.focus();
  return panel;
}

function tabClosed(): void {
  closeMenu(false);
  for (const control of [back, forward, reload, address, alone])
    control.disabled = true;
  showEnd(say.closed, say.openNewTab, () => location.assign("/"));
  // The app around the view drops the tab from its strip (F47 point 6),
  // named by its view address in the contract's form.
  const view = ownTabView(location.origin, main?.id ?? null, location.pathname);
  if (view !== null) tell(viewClosedMessage(view));
}

/** A new remote tab at the page area's size (F39 point 1); null when the
 * service opened none. */
async function createTab(): Promise<string | null> {
  try {
    const response = await fetch("/api/tabs", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        viewSize(
          area.clientWidth,
          area.clientHeight,
          window.devicePixelRatio || 1,
        ),
      ),
    });
    if (response.status !== 201) return null;
    const body: unknown = await response.json();
    const id =
      typeof body === "object" && body !== null
        ? (body as { id?: unknown }).id
        : undefined;
    return targetIdOf(id);
  } catch {
    return null;
  }
}

function open(id: string, fresh: boolean): void {
  main = new Viewer(id, area, {
    resize: true,
    info: showInfo,
    closed: tabClosed,
  });
  area.append(popupLayer);
  alone.disabled = false;
  main.start();
  // A new tab waits for an address, as a browser's new tab does.
  if (fresh) address.focus();
  else main.focus();
}

/** `/t/<id>` views that tab, in the contract's form of a view address
 * (`viewPathTab`); `/` opens a new one and takes its address. */
async function start(): Promise<void> {
  if (location.pathname !== "/") {
    const viewed = viewPathTab(location.pathname);
    if (viewed !== null) open(viewed, false);
    else tabClosed();
    return;
  }
  const waiting = element("div", "status", say.connecting);
  waiting.setAttribute("role", "status");
  area.append(waiting);
  const id = await createTab();
  waiting.remove();
  if (id === null) {
    const panel = showEnd(say.startFailed, say.retry, () => {
      panel.remove();
      void start();
    });
    return;
  }
  history.replaceState(null, "", viewPath(id));
  open(id, true);
}

void start();
