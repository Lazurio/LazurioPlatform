import { describe, expect, test } from "bun:test";
import {
  buttonBit,
  clampInto,
  clickCount,
  containRect,
  heldButton,
  inputAction,
  type KeyInput,
  keyAction,
  mapPoint,
  modifiersOf,
  mouseButton,
  textMessages,
  viewSize,
  wheelDelta,
} from "../src/browser/people/input-map";
import {
  addressOf,
  type ClientMessage,
  decodeFrame,
  encodeFrame,
  type FrameHeader,
  isTargetId,
  modifierBits,
  parseClientMessage,
} from "../src/browser/people/protocol";

// The people's view of the Environment browser (decision F39): what the view
// page sends for the person's pointer, keys and clipboard (point 6), and the
// protocol it shares with the service. Every message the page builds must be
// one the service accepts (`parseClientMessage`), or the person's input is
// silently dropped.

const accepted = (message: ClientMessage | null) =>
  message !== null && parseClientMessage(JSON.stringify(message)) !== null;

// A remote viewport of 800 × 500 CSS pixels in a frame of twice the pixels.
const header: FrameHeader = {
  width: 1600,
  height: 1000,
  deviceWidth: 800,
  deviceHeight: 500,
  offsetTop: 0,
  pageScaleFactor: 1,
};

describe("the frame in the page area", () => {
  test("is drawn as large as fits, centred, with bars on the rest", () => {
    expect(
      containRect({ width: 1000, height: 500 }, { width: 1600, height: 1000 }),
    ).toEqual({ left: 100, top: 0, width: 800, height: 500 });
    expect(
      containRect({ width: 400, height: 800 }, { width: 1600, height: 1000 }),
    ).toEqual({ left: 0, top: 275, width: 400, height: 250 });
    expect(
      containRect({ width: 400, height: 800 }, { width: 0, height: 0 }),
    ).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  test("maps the pointer to the remote viewport's CSS pixels", () => {
    // The page area starts 40 pixels down, under the bar.
    const drawn = { left: 0, top: 40, width: 800, height: 500 };
    expect(mapPoint({ x: 400, y: 290 }, drawn, header)).toEqual({
      x: 400,
      y: 250,
    });
    expect(mapPoint({ x: 0, y: 40 }, drawn, header)).toEqual({ x: 0, y: 0 });
    // Drawn at half the size (an agent's viewport larger than the person's
    // area): the same remote place under the same part of the frame.
    const half = { left: 0, top: 40, width: 400, height: 250 };
    expect(mapPoint({ x: 200, y: 165 }, half, header)).toEqual({
      x: 400,
      y: 250,
    });
  });

  test("maps through the letterbox and nothing on its bars", () => {
    const area = { left: 0, top: 40, width: 1000, height: 500 };
    const inner = containRect(area, header);
    const drawn = {
      left: area.left + inner.left,
      top: area.top + inner.top,
      width: inner.width,
      height: inner.height,
    };
    expect(mapPoint({ x: 500, y: 290 }, drawn, header)).toEqual({
      x: 400,
      y: 250,
    });
    expect(mapPoint({ x: 50, y: 290 }, drawn, header)).toBeNull();
    expect(mapPoint({ x: 950, y: 290 }, drawn, header)).toBeNull();
    expect(mapPoint({ x: 500, y: 30 }, drawn, header)).toBeNull();
    expect(
      mapPoint(
        { x: 1, y: 1 },
        { left: 0, top: 0, width: 0, height: 0 },
        header,
      ),
    ).toBeNull();
  });

  test("subtracts the remote page's top offset", () => {
    const drawn = { left: 0, top: 0, width: 800, height: 500 };
    expect(
      mapPoint({ x: 10, y: 100 }, drawn, { ...header, offsetTop: 20 }),
    ).toEqual({ x: 10, y: 80 });
  });

  test("a drag that leaves the frame moves along its edge", () => {
    const drawn = { left: 100, top: 40, width: 800, height: 500 };
    const edge = clampInto({ x: 1200, y: 0 }, drawn);
    expect(edge).toEqual({ x: 900, y: 40 });
    expect(mapPoint(edge, drawn, header)).toEqual({ x: 800, y: 0 });
  });
});

const key = (
  input: Partial<KeyInput> & Pick<KeyInput, "key" | "code" | "keyCode">,
): KeyInput => ({
  type: "keydown",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  altGraph: false,
  location: 0,
  repeat: false,
  isComposing: false,
  ...input,
});

describe("keys", () => {
  test("punctuation keeps its virtual-key code and types itself", () => {
    // Lazurio/LazurioPlatform#218: an ASCII code as the virtual-key code
    // made '.' (46) arrive as Delete.
    for (const [character, code, keyCode] of [
      [".", "Period", 190],
      ["-", "Minus", 189],
      ["'", "Quote", 222],
    ] as const) {
      const action = keyAction(key({ key: character, code, keyCode }), false);
      expect(action).toEqual({
        send: {
          t: "key",
          type: "keyDown",
          key: character,
          code,
          keyCode,
          modifiers: 0,
          location: 0,
          repeat: false,
          text: character,
        },
        preventDefault: true,
      });
      expect(accepted(action.send)).toBe(true);
    }
  });

  test("Shift types the shifted character", () => {
    const action = keyAction(
      key({ key: "!", code: "Digit1", keyCode: 49, shiftKey: true }),
      false,
    );
    expect(action.send).toMatchObject({
      keyCode: 49,
      text: "!",
      modifiers: modifierBits.shift,
    });
  });

  test("a shortcut is sent without text", () => {
    const action = keyAction(
      key({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: true }),
      false,
    );
    expect(action.preventDefault).toBe(true);
    expect(action.send).toMatchObject({
      type: "keyDown",
      key: "a",
      keyCode: 65,
      modifiers: modifierBits.ctrl,
    });
    expect(action.send).not.toHaveProperty("text");
    expect(accepted(action.send)).toBe(true);
  });

  test("on a Mac ⌘ is the remote's Ctrl, the ⌘ key included", () => {
    const selectAll = keyAction(
      key({ key: "a", code: "KeyA", keyCode: 65, metaKey: true }),
      true,
    );
    expect(selectAll.send).toMatchObject({ modifiers: modifierBits.ctrl });
    expect(selectAll.send).not.toHaveProperty("text");
    const command = keyAction(
      key({ key: "Meta", code: "MetaLeft", keyCode: 91, metaKey: true }),
      true,
    );
    expect(command.send).toMatchObject({
      key: "Control",
      code: "ControlLeft",
      keyCode: 17,
      modifiers: modifierBits.ctrl,
    });
    // Elsewhere the Windows or Super key stays Meta.
    expect(
      keyAction(
        key({ key: "a", code: "KeyA", keyCode: 65, metaKey: true }),
        false,
      ).send,
    ).toMatchObject({ modifiers: modifierBits.meta });
  });

  test("the person's paste and copy are left to the person's browser", () => {
    const pass = { send: null, preventDefault: false };
    const v = { key: "v", code: "KeyV", keyCode: 86 };
    const c = { key: "c", code: "KeyC", keyCode: 67 };
    expect(keyAction(key({ ...v, metaKey: true }), true)).toEqual(pass);
    expect(keyAction(key({ ...v, ctrlKey: true }), false)).toEqual(pass);
    expect(
      keyAction(key({ ...v, ctrlKey: true, shiftKey: true }), false),
    ).toEqual(pass);
    expect(keyAction(key({ ...c, metaKey: true }), true)).toEqual(pass);
    expect(keyAction(key({ ...c, ctrlKey: true }), false)).toEqual(pass);
    // A layout without Latin letters: the virtual-key code decides.
    expect(keyAction(key({ ...v, key: "м", ctrlKey: true }), false)).toEqual(
      pass,
    );
    // Ctrl+V on a Mac is no paste of the person's: the remote page gets it.
    expect(keyAction(key({ ...v, ctrlKey: true }), true).send).toMatchObject({
      key: "v",
      modifiers: modifierBits.ctrl,
    });
  });

  test("cut goes to the remote page and to the person's browser", () => {
    const action = keyAction(
      key({ key: "x", code: "KeyX", keyCode: 88, metaKey: true }),
      true,
    );
    expect(action.preventDefault).toBe(false);
    expect(action.send).toMatchObject({
      type: "keyDown",
      key: "x",
      modifiers: modifierBits.ctrl,
    });
    expect(action.send).not.toHaveProperty("text");
  });

  test("Enter types a carriage return", () => {
    expect(
      keyAction(key({ key: "Enter", code: "Enter", keyCode: 13 }), false).send,
    ).toMatchObject({ keyCode: 13, text: "\r" });
  });

  test("a character beyond ASCII types itself", () => {
    for (const character of ["ě", "ř", "😀"])
      expect(
        keyAction(key({ key: character, code: "Digit2", keyCode: 50 }), false)
          .send,
      ).toMatchObject({ text: character });
  });

  test("AltGr types its character, without the Ctrl that would stop it", () => {
    // Windows reports AltGr as Ctrl+Alt; on a Czech layout AltGr+V is "@",
    // which is neither a paste nor a shortcut.
    const action = keyAction(
      key({
        key: "@",
        code: "KeyV",
        keyCode: 86,
        ctrlKey: true,
        altKey: true,
        altGraph: true,
      }),
      false,
    );
    expect(action.preventDefault).toBe(true);
    expect(action.send).toMatchObject({ key: "@", text: "@", modifiers: 0 });
    expect(accepted(action.send)).toBe(true);
  });

  test("a composition and a phone's keys are left to the input events", () => {
    const pass = { send: null, preventDefault: false };
    expect(
      keyAction(
        key({ key: "a", code: "KeyA", keyCode: 65, isComposing: true }),
        false,
      ),
    ).toEqual(pass);
    expect(
      keyAction(key({ key: "Process", code: "KeyA", keyCode: 229 }), false),
    ).toEqual(pass);
    expect(
      keyAction(key({ key: "Dead", code: "Equal", keyCode: 187 }), false),
    ).toEqual(pass);
    expect(
      keyAction(key({ key: "Unidentified", code: "", keyCode: 0 }), false),
    ).toEqual(pass);
  });

  test("a key up never types", () => {
    for (const input of [
      { key: "a", code: "KeyA", keyCode: 65 },
      { key: "Enter", code: "Enter", keyCode: 13 },
    ]) {
      const action = keyAction(key({ ...input, type: "keyup" }), false);
      expect(action.send).toMatchObject({ type: "keyUp", key: input.key });
      expect(action.send).not.toHaveProperty("text");
      expect(accepted(action.send)).toBe(true);
    }
  });

  test("keys that type nothing carry no text", () => {
    for (const input of [
      { key: "Tab", code: "Tab", keyCode: 9 },
      { key: "Backspace", code: "Backspace", keyCode: 8 },
      { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ])
      expect(keyAction(key(input), false).send).not.toHaveProperty("text");
  });

  test("modifier bits", () => {
    const none = { ctrlKey: false, metaKey: false, altKey: false };
    expect(modifiersOf({ ...none, shiftKey: true }, false)).toBe(
      modifierBits.shift,
    );
    expect(modifiersOf({ ...none, altKey: true, shiftKey: false }, true)).toBe(
      modifierBits.alt,
    );
    expect(
      modifiersOf(
        { ctrlKey: true, metaKey: true, altKey: false, shiftKey: false },
        true,
      ),
    ).toBe(modifierBits.ctrl);
  });
});

describe("text", () => {
  test("a paste keeps its text, with line breaks as \\n", () => {
    expect(textMessages("a\r\nb\rc\nd")).toEqual([
      { t: "text", text: "a\nb\nc\nd" },
    ]);
    expect(textMessages("")).toEqual([]);
  });

  test("a long text comes in parts the service accepts", () => {
    const messages = textMessages("x".repeat(250_001));
    expect(
      messages.map((message) => (message.t === "text" ? message.text : "")),
    ).toEqual(["x".repeat(100_000), "x".repeat(100_000), "x".repeat(50_001)]);
    expect(messages.every(accepted)).toBe(true);
  });

  test("a part never splits a character", () => {
    expect(textMessages("a😀b", 2)).toEqual([
      { t: "text", text: "a" },
      { t: "text", text: "😀" },
      { t: "text", text: "b" },
    ]);
  });

  test("a phone keyboard's edits", () => {
    expect(inputAction("insertText", "ahoj")).toEqual([
      { t: "text", text: "ahoj" },
    ]);
    expect(inputAction("insertReplacementText", "word")).toEqual([
      { t: "text", text: "word" },
    ]);
    expect(inputAction("insertText", null)).toEqual([]);
    const backspace = inputAction("deleteContentBackward", null);
    expect(backspace).toEqual([
      {
        t: "key",
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        modifiers: 0,
        location: 0,
        repeat: false,
      },
      {
        t: "key",
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        keyCode: 8,
        modifiers: 0,
        location: 0,
        repeat: false,
      },
    ]);
    for (const inputType of ["insertParagraph", "insertLineBreak"]) {
      const enter = inputAction(inputType, null);
      expect(enter?.[0]).toMatchObject({
        type: "keyDown",
        key: "Enter",
        keyCode: 13,
        text: "\r",
      });
      expect(enter?.[1]).toMatchObject({ type: "keyUp", key: "Enter" });
      expect(enter?.[1]).not.toHaveProperty("text");
      expect(enter?.every(accepted)).toBe(true);
    }
    expect(backspace?.every(accepted)).toBe(true);
    // A composition's text is sent whole when it ends.
    expect(inputAction("insertCompositionText", "ahoj")).toBeNull();
  });
});

describe("the pointer", () => {
  test("wheel lines and pages become pixels", () => {
    expect(wheelDelta({ deltaX: 3, deltaY: -40, deltaMode: 0 }, 500)).toEqual({
      deltaX: 3,
      deltaY: -40,
    });
    expect(wheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 500)).toEqual({
      deltaX: 0,
      deltaY: 48,
    });
    expect(wheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 500)).toEqual({
      deltaX: 0,
      deltaY: -500,
    });
    expect(
      wheelDelta({ deltaX: 1e9, deltaY: -1e9, deltaMode: 0 }, 500),
    ).toEqual({ deltaX: 100_000, deltaY: -100_000 });
  });

  test("buttons", () => {
    expect([0, 1, 2, 3, 4, 5, -1].map(mouseButton)).toEqual([
      "left",
      "middle",
      "right",
      "back",
      "forward",
      "none",
      "none",
    ]);
    // A move drags with the button held (DOM `buttons`).
    expect([0, 1, 2, 4, 3, 8, 16].map(heldButton)).toEqual([
      "none",
      "left",
      "right",
      "middle",
      "left",
      "back",
      "forward",
    ]);
    expect([0, 1, 2, 3, 4, 7].map(buttonBit)).toEqual([1, 4, 2, 8, 16, 0]);
  });

  test("double and triple clicks are counted by time, place and button", () => {
    const first = { time: 1000, x: 10, y: 10, button: "left" as const };
    expect(clickCount(null, first)).toBe(1);
    const once = { ...first, count: 1 };
    expect(clickCount(once, { ...first, time: 1300, x: 12 })).toBe(2);
    expect(clickCount({ ...once, count: 2 }, { ...first, time: 1300 })).toBe(3);
    expect(clickCount(once, { ...first, time: 1600 })).toBe(1);
    expect(clickCount(once, { ...first, time: 1100, x: 20 })).toBe(1);
    expect(clickCount(once, { ...first, time: 1100, button: "right" })).toBe(1);
  });

  test("every pointer message the page builds is accepted", () => {
    const at = mapPoint(
      { x: 400, y: 290 },
      { left: 0, top: 40, width: 800, height: 500 },
      header,
    );
    expect(at).not.toBeNull();
    const point = at ?? { x: 0, y: 0 };
    const messages: ClientMessage[] = [
      {
        t: "mouse",
        type: "mousePressed",
        ...point,
        button: mouseButton(0),
        buttons: 1,
        clickCount: clickCount(null, { time: 0, x: 0, y: 0, button: "left" }),
        modifiers: modifiersOf(
          { ctrlKey: false, metaKey: true, altKey: false, shiftKey: true },
          true,
        ),
      },
      {
        t: "mouse",
        type: "mouseWheel",
        ...point,
        button: "none",
        buttons: 0,
        clickCount: 0,
        modifiers: 0,
        ...wheelDelta({ deltaX: 0, deltaY: 1e9, deltaMode: 0 }, 500),
      },
      {
        t: "touch",
        type: "touchStart",
        points: [{ id: 0, ...point }],
        modifiers: 0,
      },
      { t: "touch", type: "touchEnd", points: [], modifiers: 0 },
    ];
    expect(messages.every(accepted)).toBe(true);
  });
});

describe("the size of the page area", () => {
  test("is whole pixels within the protocol's limits", () => {
    expect(viewSize(1280.6, 720.4, 2)).toEqual({
      width: 1281,
      height: 720,
      dpr: 2,
    });
    expect(viewSize(100, 100, 0.5)).toEqual({
      width: 200,
      height: 150,
      dpr: 1,
    });
    expect(viewSize(5000, 3000, 4)).toEqual({
      width: 3840,
      height: 2400,
      dpr: 3,
    });
    expect(viewSize(Number.NaN, Number.NaN, Number.NaN)).toEqual({
      width: 200,
      height: 150,
      dpr: 1,
    });
    expect(
      accepted({ t: "hello", ...viewSize(390, 640, 3), resize: true }),
    ).toBe(true);
  });
});

describe("the protocol", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

  test("a frame survives the socket", () => {
    const frame = encodeFrame(header, jpeg);
    expect(decodeFrame(frame)).toEqual({ header, jpeg });
    // The page receives an ArrayBuffer.
    const received = decodeFrame(new Uint8Array(frame).buffer);
    expect(received?.header).toEqual(header);
    expect(received?.jpeg).toEqual(jpeg);
  });

  test("a truncated or malformed frame is refused", () => {
    const frame = encodeFrame(header, jpeg);
    const headLength = frame.length - jpeg.length - 4;
    expect(decodeFrame(frame.subarray(0, 4 + headLength - 1))).toBeNull();
    expect(decodeFrame(frame.subarray(0, 3))).toBeNull();
    expect(decodeFrame(new Uint8Array(0))).toBeNull();
    const huge = new Uint8Array(frame);
    new DataView(huge.buffer).setUint32(0, 5000, false);
    expect(decodeFrame(huge)).toBeNull();
    const notJson = new Uint8Array([0, 0, 0, 2, 0x7b, 0x7b]);
    expect(decodeFrame(notJson)).toBeNull();
    const head = new TextEncoder().encode(
      JSON.stringify({ ...header, deviceWidth: "800" }),
    );
    const wrong = new Uint8Array(4 + head.length);
    new DataView(wrong.buffer).setUint32(0, head.length, false);
    wrong.set(head, 4);
    expect(decodeFrame(wrong)).toBeNull();
  });

  test("every kind of message of the page is accepted", () => {
    const messages: ClientMessage[] = [
      { t: "hello", width: 1280, height: 720, dpr: 2, resize: true },
      { t: "size", width: 390, height: 640, dpr: 3 },
      {
        t: "mouse",
        type: "mouseMoved",
        x: 1,
        y: 2,
        button: "none",
        buttons: 0,
        clickCount: 0,
        modifiers: 0,
      },
      {
        t: "mouse",
        type: "mouseWheel",
        x: 1,
        y: 2,
        button: "none",
        buttons: 0,
        clickCount: 0,
        modifiers: 0,
        deltaX: 0,
        deltaY: 120,
      },
      {
        t: "key",
        type: "keyDown",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        text: "a",
        modifiers: 0,
        location: 0,
        repeat: false,
      },
      {
        t: "key",
        type: "keyUp",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        modifiers: 0,
        location: 0,
        repeat: false,
      },
      { t: "text", text: "ahoj" },
      {
        t: "touch",
        type: "touchMove",
        points: [
          { id: 0, x: 1, y: 2 },
          { id: 1, x: 3, y: 4 },
        ],
        modifiers: 0,
      },
      { t: "touch", type: "touchCancel", points: [], modifiers: 0 },
      { t: "nav", action: "back" },
      { t: "nav", action: "stop" },
      { t: "goto", url: "https://example.com/" },
      { t: "dialog", accept: true, text: "jméno" },
      { t: "dialog", accept: false },
      { t: "files-cancel", token: "0123456789abcdef01234567" },
      { t: "close" },
    ];
    for (const message of messages)
      expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  test("anything else is refused", () => {
    const mouse = {
      t: "mouse",
      type: "mousePressed",
      x: 1,
      y: 2,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    };
    const touch = { t: "touch", type: "touchStart", modifiers: 0 };
    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ t: "launch" }),
      JSON.stringify({ t: "text", text: "x".repeat(1_000_001) }),
      JSON.stringify({ t: "text", text: "" }),
      JSON.stringify({ t: "hello", width: 1280, height: 720, dpr: 2 }),
      JSON.stringify({ ...mouse, x: null }),
      JSON.stringify(mouse).replace('"x":1', '"x":NaN'),
      JSON.stringify({ ...mouse, x: 1e9 }),
      JSON.stringify({ ...mouse, button: "thumb" }),
      JSON.stringify({ ...touch, points: [{ x: 1, y: 2 }] }),
      JSON.stringify({ ...touch, points: [{ id: 0, x: "1", y: 2 }] }),
      JSON.stringify({ ...touch, points: "0,1,2" }),
      JSON.stringify({
        ...touch,
        points: Array.from({ length: 11 }, (_, id) => ({ id, x: 1, y: 2 })),
      }),
      JSON.stringify({
        t: "key",
        type: "keyDown",
        key: "a",
        code: "KeyA",
        keyCode: 65,
        text: "",
        modifiers: 0,
        location: 0,
        repeat: false,
      }),
      JSON.stringify({ t: "nav", action: "home" }),
    ])
      expect(parseClientMessage(raw)).toBeNull();
  });

  test("a tab is named by its DevTools target id only", () => {
    expect(isTargetId("0123456789ABCDEF0123456789abcdef")).toBe(true);
    for (const value of ["0123", "../../etc/passwd", "g".repeat(32), 42])
      expect(isTargetId(value)).toBe(false);
  });

  test("the address bar's text becomes an address or a search", () => {
    expect(addressOf("example.com")).toBe("https://example.com/");
    expect(addressOf(" localhost:3000 ")).toBe("http://localhost:3000/");
    expect(addressOf("http://x.y/z")).toBe("http://x.y/z");
    expect(addressOf("about:blank")).toBe("about:blank");
    expect(addressOf("hello world")).toBe(
      "https://www.google.com/search?q=hello%20world",
    );
    // Never a script or a file of the Environment: a search for the text.
    expect(addressOf("javascript:alert(1)")).toBe(
      `https://www.google.com/search?q=${encodeURIComponent("javascript:alert(1)")}`,
    );
    expect(addressOf("file:///etc/passwd")).toBe(
      `https://www.google.com/search?q=${encodeURIComponent("file:///etc/passwd")}`,
    );
  });
});
