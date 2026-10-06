/** The people's view of the Environment browser (decision F39): the messages
 * between the view page in a person's tab and the view service on the
 * Environment, over `wss://browser.<…>/t/<id>/live`. One WebSocket shows one
 * remote tab. Text messages are JSON objects with a `t` member; frames are
 * binary (`encodeFrame`). Shared by the service and the page, so both sides
 * read one definition. */

/** A DevTools target id as Chrome writes it: 32 hexadecimal digits. The view
 * takes nothing else as `<id>`. */
export const isTargetId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9A-F]{32}$/i.test(value);

/** The page area of the view in CSS pixels and its device pixel ratio. */
export type ViewSize = Readonly<{ width: number; height: number; dpr: number }>;

export const viewSizeLimits = Object.freeze({
  minWidth: 200,
  minHeight: 150,
  maxWidth: 3840,
  maxHeight: 2400,
  maxDpr: 3,
});

/** Modifier bits as CDP's `Input` domain counts them. */
export const modifierBits = Object.freeze({
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
});

export type MouseButton =
  | "none"
  | "left"
  | "middle"
  | "right"
  | "back"
  | "forward";

export type TouchPoint = Readonly<{ x: number; y: number; id: number }>;

/** From the page to the service. Coordinates are CSS pixels of the remote
 * page's viewport, already mapped by the page from the frame it shows. */
export type ClientMessage =
  /** First message: the page area. `resize` false keeps the window's size
   * (a pop-up shown over the page keeps the size its opener asked for). */
  | Readonly<{
      t: "hello";
      width: number;
      height: number;
      dpr: number;
      resize: boolean;
    }>
  | Readonly<{ t: "size"; width: number; height: number; dpr: number }>
  | Readonly<{
      t: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button: MouseButton;
      buttons: number;
      clickCount: number;
      modifiers: number;
      deltaX?: number;
      deltaY?: number;
    }>
  /** A key as the person's browser reported it. `keyCode` is the DOM
   * `keyCode`, which is the Windows virtual-key code CDP wants. `text` only
   * for a key that types it (no Ctrl or Meta). */
  | Readonly<{
      t: "key";
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers: number;
      location: number;
      repeat: boolean;
    }>
  /** Text to insert at the caret: a paste or a finished composition. */
  | Readonly<{ t: "text"; text: string }>
  | Readonly<{
      t: "touch";
      type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
      points: readonly TouchPoint[];
      modifiers: number;
    }>
  | Readonly<{ t: "nav"; action: "back" | "forward" | "reload" | "stop" }>
  | Readonly<{ t: "goto"; url: string }>
  | Readonly<{ t: "dialog"; accept: boolean; text?: string }>
  /** The person dismissed the file chooser without picking a file. */
  | Readonly<{ t: "files-cancel"; token: string }>
  /** Close this remote tab (a pop-up's close button). */
  | Readonly<{ t: "close" }>;

/** From the service to the page (text messages; frames are binary). */
export type ServerMessage =
  /** Where the tab is: its address, title, icon and history. */
  | Readonly<{
      t: "info";
      url: string;
      title: string;
      favicon: string | null;
      canGoBack: boolean;
      canGoForward: boolean;
      loading: boolean;
    }>
  /** The remote selection, for the person's copy and cut. */
  | Readonly<{ t: "selection"; text: string }>
  /** The tab opened a pop-up (it can reach its opener): show it over the
   * page through its own view, `/t/<id>`. */
  | Readonly<{ t: "popup"; id: string; url: string }>
  /** The tab opened a new tab (no opener access): offer it. */
  | Readonly<{ t: "new-tab"; id: string; url: string }>
  | Readonly<{
      t: "dialog";
      kind: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      defaultPrompt: string;
    }>
  | Readonly<{ t: "dialog-closed" }>
  /** The page asked for files: upload them with `POST /t/<id>/files?token=`. */
  | Readonly<{ t: "files"; multiple: boolean; token: string }>
  | Readonly<{ t: "files-closed"; token: string }>
  /** The tab no longer exists. The socket closes after this. */
  | Readonly<{ t: "closed" }>
  /** The service lost the browser and reconnects, or found it again. */
  | Readonly<{ t: "browser"; state: "connected" | "reconnecting" }>;

/** What a frame says about itself: its size in device pixels and the page's
 * viewport in CSS pixels it shows (CDP `ScreencastFrameMetadata`). */
export type FrameHeader = Readonly<{
  /** Width and height of the image, device pixels. */
  width: number;
  height: number;
  /** The page's viewport, CSS pixels. */
  deviceWidth: number;
  deviceHeight: number;
  /** Top of the page in the image, CSS pixels (non-zero only with an
   * emulated mobile top bar). */
  offsetTop: number;
  pageScaleFactor: number;
}>;

/** One binary message per frame: a 4-byte big-endian length, the header as
 * UTF-8 JSON, then the JPEG. */
export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, head.length, false);
  out.set(head, 4);
  out.set(jpeg, 4 + head.length);
  return out;
}

export function decodeFrame(
  data: ArrayBuffer | Uint8Array,
): { header: FrameHeader; jpeg: Uint8Array } | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return null;
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, false);
  if (length > 4096 || 4 + length > bytes.length) return null;
  try {
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(4, 4 + length)),
    ) as FrameHeader;
    const numbers = [
      header.width,
      header.height,
      header.deviceWidth,
      header.deviceHeight,
      header.offsetTop,
      header.pageScaleFactor,
    ];
    if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n)))
      return null;
    return { header, jpeg: bytes.subarray(4 + length) };
  } catch {
    return null;
  }
}

const finite = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

const coordinate = (value: unknown) => finite(value, -100_000, 100_000);
const small = (value: unknown) => finite(value, 0, 0xffff);
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max;

const mouseTypes = new Set([
  "mousePressed",
  "mouseReleased",
  "mouseMoved",
  "mouseWheel",
]);
const buttons = new Set(["none", "left", "middle", "right", "back", "forward"]);
const touchTypes = new Set([
  "touchStart",
  "touchMove",
  "touchEnd",
  "touchCancel",
]);

/** Reads one text message of the page; null for anything the protocol does
 * not have. The service acts only on what this returns. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 1_100_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const m = value as Record<string, unknown>;
  const size = () =>
    finite(m.width, 1, 100_000) &&
    finite(m.height, 1, 100_000) &&
    finite(m.dpr, 0.1, 10);
  switch (m.t) {
    case "hello":
      return size() && typeof m.resize === "boolean"
        ? (m as ClientMessage)
        : null;
    case "size":
      return size() ? (m as ClientMessage) : null;
    case "mouse":
      return mouseTypes.has(m.type as string) &&
        coordinate(m.x) &&
        coordinate(m.y) &&
        buttons.has(m.button as string) &&
        small(m.buttons) &&
        finite(m.clickCount, 0, 10) &&
        small(m.modifiers) &&
        (m.deltaX === undefined || coordinate(m.deltaX)) &&
        (m.deltaY === undefined || coordinate(m.deltaY))
        ? (m as ClientMessage)
        : null;
    case "key":
      return (m.type === "keyDown" || m.type === "keyUp") &&
        text(m.key, 64) &&
        text(m.code, 64) &&
        small(m.keyCode) &&
        (m.text === undefined || (text(m.text, 16) && m.text !== "")) &&
        small(m.modifiers) &&
        finite(m.location, 0, 3) &&
        typeof m.repeat === "boolean"
        ? (m as ClientMessage)
        : null;
    case "text":
      return text(m.text, 1_000_000) && m.text !== ""
        ? (m as ClientMessage)
        : null;
    case "touch":
      return touchTypes.has(m.type as string) &&
        Array.isArray(m.points) &&
        m.points.length <= 10 &&
        m.points.every(
          (p: unknown) =>
            typeof p === "object" &&
            p !== null &&
            coordinate((p as TouchPoint).x) &&
            coordinate((p as TouchPoint).y) &&
            finite((p as TouchPoint).id, 0, 1_000_000),
        ) &&
        small(m.modifiers)
        ? (m as ClientMessage)
        : null;
    case "nav":
      return ["back", "forward", "reload", "stop"].includes(m.action as string)
        ? (m as ClientMessage)
        : null;
    case "goto":
      return text(m.url, 8192) && m.url !== "" ? (m as ClientMessage) : null;
    case "dialog":
      return typeof m.accept === "boolean" &&
        (m.text === undefined || text(m.text, 100_000))
        ? (m as ClientMessage)
        : null;
    case "files-cancel":
      return text(m.token, 64) ? (m as ClientMessage) : null;
    case "close":
      return m as ClientMessage;
    default:
      return null;
  }
}

/** What the address bar's text means: an address, or a search. A bare
 * host (`example.com`, `localhost:3000`) gets a scheme; anything with a
 * space or without a dot is a search. Never a `javascript:` or `file:`
 * address: only http, https and about:blank are navigated to. */
export function addressOf(input: string): string {
  const value = input.trim();
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  } catch {}
  if (!/\s/.test(value)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(
      value,
    );
    if (local || /^[^/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(value)) {
      try {
        return new URL(`${local ? "http" : "https"}://${value}`).href;
      } catch {}
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
