import {
  type ClientMessage,
  type FrameHeader,
  type MouseButton,
  modifierBits,
  type ViewSize,
  viewSizeLimits,
} from "./protocol";

/** The person's input as the remote tab takes it (decision F39 point 6):
 * pure functions over plain objects. The view page (`client.ts`) applies
 * them to its DOM events; the tests run them without a DOM. The remote
 * browser runs on Linux, whatever the person's computer is. */

export type Point = Readonly<{ x: number; y: number }>;
export type Size = Readonly<{ width: number; height: number }>;
export type Rect = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type KeyMessage = Extract<ClientMessage, { t: "key" }>;

/** Where an image is drawn inside an area with "contain": as large as fits,
 * centred, the rest of the area left as bars. Empty for an empty area or
 * image. */
export function containRect(area: Size, image: Size): Rect {
  if (
    !(area.width > 0 && area.height > 0 && image.width > 0 && image.height > 0)
  )
    return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(area.width / image.width, area.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: (area.width - width) / 2,
    top: (area.height - height) / 2,
    width,
    height,
  };
}

/** A pointer position in the person's page as CSS pixels of the remote
 * page's viewport, through `drawn`, the rectangle the frame occupies (client
 * coordinates). Null outside the frame. The frame shows the remote screen of
 * `deviceWidth` × `deviceHeight`, its page starting `offsetTop` down. */
export function mapPoint(
  client: Point,
  drawn: Rect,
  header: FrameHeader,
): Point | null {
  if (!(drawn.width > 0 && drawn.height > 0)) return null;
  const x = client.x - drawn.left;
  const y = client.y - drawn.top;
  if (x < 0 || y < 0 || x > drawn.width || y > drawn.height) return null;
  return {
    x: (x / drawn.width) * header.deviceWidth,
    y: (y / drawn.height) * header.deviceHeight - header.offsetTop,
  };
}

/** The point moved onto the nearest edge of `drawn`: a drag that leaves the
 * frame keeps moving along its edge and is released there. */
export function clampInto(client: Point, drawn: Rect): Point {
  return {
    x: Math.min(drawn.left + drawn.width, Math.max(drawn.left, client.x)),
    y: Math.min(drawn.top + drawn.height, Math.max(drawn.top, client.y)),
  };
}

type Modifiers = Readonly<{
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}>;

/** The modifier bits for the remote browser. On a Mac the person's ⌘ is the
 * remote's Ctrl, so ⌘A selects all and ⌘Z undoes there; Ctrl stays Ctrl. */
export function modifiersOf(event: Modifiers, mac: boolean): number {
  return (
    (event.altKey ? modifierBits.alt : 0) |
    (event.ctrlKey || (mac && event.metaKey) ? modifierBits.ctrl : 0) |
    (!mac && event.metaKey ? modifierBits.meta : 0) |
    (event.shiftKey ? modifierBits.shift : 0)
  );
}

/** A keyboard event of the person's page as `keyAction` reads it.
 * `altGraph` is `getModifierState("AltGraph")`. */
export type KeyInput = Readonly<{
  type: "keydown" | "keyup";
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  altGraph: boolean;
  location: number;
  repeat: boolean;
  isComposing: boolean;
}>;

/** What to do with one key event: the message for the remote tab (null:
 * none) and whether the person's browser keeps its own default action. */
export type KeyAction = Readonly<{
  send: KeyMessage | null;
  preventDefault: boolean;
}>;

const pass: KeyAction = Object.freeze({ send: null, preventDefault: false });

/** One key of the person's keyboard for the remote tab.
 *
 * - A composition (an input method, a phone's keyboard: `keyCode` 229), a
 *   dead key and an unidentified key are left to the person's browser; their
 *   text arrives through `compositionend` and `beforeinput`.
 * - Paste and copy shortcuts are left to the person's browser too: it fires
 *   `paste` and `copy`, which carry the person's clipboard and the remote
 *   selection. Cut is sent (the remote page removes the selection) and also
 *   left to the browser, which fires `cut` to fill the person's clipboard.
 * - `keyCode` is the person's browser's, which is the Windows virtual-key
 *   code the remote browser wants: `.` stays `.` (190), never Delete (46).
 * - Text only on a key down that types: one character without Ctrl or ⌘,
 *   or with AltGr; Enter types `\r`. */
export function keyAction(event: KeyInput, mac: boolean): KeyAction {
  if (event.isComposing || event.keyCode === 229) return pass;
  if (event.key === "Dead" || event.key === "Unidentified") return pass;
  // Longer than the protocol takes: no key of a keyboard.
  if (event.key.length > 64 || event.code.length > 64) return pass;
  const command =
    !event.altGraph &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
  // The letter, or on a layout without Latin letters its virtual-key code,
  // as the person's browser recognises its own shortcuts.
  const letter = (char: string, keyCode: number) =>
    event.key.toLowerCase() === char || event.keyCode === keyCode;
  if (command && letter("v", 86)) return pass;
  const plain = !event.shiftKey && !event.altKey;
  if (command && plain && letter("c", 67)) return pass;
  const cut = command && plain && letter("x", 88);

  // The ⌘ key itself is the remote's Control, as its modifier bit is.
  const metaAsControl = mac && event.key === "Meta";
  let modifiers = modifiersOf(event, mac);
  // AltGr types a character. Windows reports it as Ctrl+Alt, and the Linux
  // browser types nothing while Ctrl is held: the remote gets the character
  // without them, as AltGr on Linux reports it.
  if (event.altGraph) modifiers &= ~(modifierBits.ctrl | modifierBits.alt);
  // One character, a single code point: "ě", "@" and an emoji type, a named
  // key ("Tab", "ArrowLeft") does not.
  const types =
    (event.altGraph || (!event.ctrlKey && !event.metaKey)) &&
    [...event.key].length === 1;
  const text =
    event.type !== "keydown"
      ? undefined
      : event.key === "Enter"
        ? "\r"
        : types
          ? event.key
          : undefined;
  return {
    send: {
      t: "key",
      type: event.type === "keydown" ? "keyDown" : "keyUp",
      key: metaAsControl ? "Control" : event.key,
      code: metaAsControl
        ? event.code.endsWith("Right")
          ? "ControlRight"
          : "ControlLeft"
        : event.code,
      keyCode: metaAsControl ? 17 : event.keyCode,
      modifiers,
      location: event.location,
      repeat: event.repeat,
      ...(text === undefined ? {} : { text }),
    },
    preventDefault: !cut,
  };
}

/** A key pressed and released with no modifier, for an edit a phone's
 * keyboard reports only as `beforeinput`. */
function press(
  key: string,
  keyCode: number,
  text?: string,
): readonly KeyMessage[] {
  const base = { t: "key", key, code: key, keyCode, modifiers: 0 } as const;
  return [
    {
      ...base,
      type: "keyDown",
      location: 0,
      repeat: false,
      ...(text === undefined ? {} : { text }),
    },
    { ...base, type: "keyUp", location: 0, repeat: false },
  ];
}

/** What a `beforeinput` that no key down carried means for the remote tab
 * (a phone's keyboard sends its keys as `keyCode` 229): the typed text, a
 * Backspace or an Enter. Null for anything left to the keys' field, such as
 * the text of a composition, which `compositionend` sends whole. */
export function inputAction(
  inputType: string,
  data: string | null,
): readonly ClientMessage[] | null {
  switch (inputType) {
    case "insertText":
    case "insertReplacementText":
      return textMessages(data ?? "");
    case "deleteContentBackward":
      return press("Backspace", 8);
    case "insertLineBreak":
    case "insertParagraph":
      return press("Enter", 13, "\r");
    default:
      return null;
  }
}

/** Text for the remote caret (a paste, a composition, a phone's word) as
 * `text` messages: line breaks as a paste in the page makes them (`\n`), a
 * long text in parts that each fit a message, never splitting a
 * character. */
export function textMessages(
  text: string,
  partLength = 100_000,
): readonly ClientMessage[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  const messages: ClientMessage[] = [];
  for (let start = 0; start < normalized.length; ) {
    let end = Math.min(normalized.length, start + partLength);
    const last = normalized.charCodeAt(end - 1);
    // The first half of a surrogate pair stays with its second half.
    if (
      end < normalized.length &&
      end - 1 > start &&
      last >= 0xd800 &&
      last <= 0xdbff
    )
      end -= 1;
    messages.push({ t: "text", text: normalized.slice(start, end) });
    start = end;
  }
  return messages;
}

/** A wheel's movement in CSS pixels, as the remote page scrolls it: lines of
 * 16 pixels, pages of the remote viewport's height. Within the protocol's
 * range. */
export function wheelDelta(
  event: Readonly<{ deltaX: number; deltaY: number; deltaMode: number }>,
  viewportHeight: number,
): Readonly<{ deltaX: number; deltaY: number }> {
  const scale =
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
  const clamp = (value: number) =>
    Math.max(-100_000, Math.min(100_000, value * scale));
  return { deltaX: clamp(event.deltaX), deltaY: clamp(event.deltaY) };
}

/** The button of a press or release (DOM `button`). */
export function mouseButton(button: number): MouseButton {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

// DOM `buttons` bits, which CDP counts the same way.
const buttonBits: readonly (readonly [number, MouseButton])[] = [
  [1, "left"],
  [4, "middle"],
  [2, "right"],
  [8, "back"],
  [16, "forward"],
];

/** The button a move drags with (DOM `buttons`): a remote drag, a text
 * selection, needs it on every move, as a native move has it. */
export function heldButton(buttons: number): MouseButton {
  for (const [bit, button] of buttonBits) if (buttons & bit) return button;
  return "none";
}

/** The `buttons` bit of a DOM `button`; 0 for none. */
export function buttonBit(button: number): number {
  const name = mouseButton(button);
  return buttonBits.find(([, held]) => held === name)?.[0] ?? 0;
}

/** A press of the person's pointer, for counting double and triple clicks:
 * a pointer event's `detail` is always 0, so the page counts them itself. */
export type Press = Readonly<{
  time: number;
  x: number;
  y: number;
  button: MouseButton;
  count: number;
}>;

const multiClickMs = 500;
const multiClickDistance = 4;

/** The click count of a press: one more than the press before when it was
 * the same button, within half a second and four pixels; else 1. */
export function clickCount(
  previous: Press | null,
  next: Omit<Press, "count">,
): number {
  if (
    previous === null ||
    previous.button !== next.button ||
    next.time - previous.time > multiClickMs ||
    Math.abs(next.x - previous.x) > multiClickDistance ||
    Math.abs(next.y - previous.y) > multiClickDistance
  )
    return 1;
  return Math.min(previous.count + 1, 10);
}

/** The page area's size as `hello` and `size` carry it: whole CSS pixels
 * within the protocol's limits, the device pixel ratio from 1 to the
 * largest the service renders. */
export function viewSize(width: number, height: number, dpr: number): ViewSize {
  const within = (value: number, min: number, max: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  return {
    width: Math.round(
      within(width, viewSizeLimits.minWidth, viewSizeLimits.maxWidth),
    ),
    height: Math.round(
      within(height, viewSizeLimits.minHeight, viewSizeLimits.maxHeight),
    ),
    dpr: Math.round(within(dpr, 1, viewSizeLimits.maxDpr) * 100) / 100,
  };
}
