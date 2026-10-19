import { describe, expect, test } from "bun:test";
import {
  type AddressTarget,
  addressBarTarget,
  browserLanguage,
  isTargetId,
} from "../src/browser/contract/pure";
import {
  aloneAddress,
  handOffNotice,
  menuStep,
  ownTabView,
  pictureKey,
  pictureOf,
} from "../src/browser/people/bar";
import { FramePump } from "../src/browser/people/frames";
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
  type ClientMessage,
  decodeFrame,
  encodeFrame,
  type FrameHeader,
  modifierBits,
  parseClientMessage,
} from "../src/browser/people/protocol";
import { viewStatus } from "../src/browser/people/status";
import { cs, en, words } from "../src/browser/people/words";

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

  // F39's addendum of 2026-10-13: Data saver's frames are two thirds of the
  // page's CSS size. The page maps through the header's CSS sizes and the
  // place the frame is drawn, so a smaller frame of the same page sends
  // every click where a full frame sends it.
  test("a Data saver frame, smaller than the page, maps the pointer as a full frame does", () => {
    const at = (
      area: { left: number; top: number; width: number; height: number },
      frame: FrameHeader,
      point: { x: number; y: number },
    ) => {
      const inner = containRect(area, frame);
      return mapPoint(
        point,
        {
          left: area.left + inner.left,
          top: area.top + inner.top,
          width: inner.width,
          height: inner.height,
        },
        frame,
      );
    };
    // A page area of 1200 × 750 CSS pixels under the bar: two thirds is
    // exactly 800 × 500.
    const area = { left: 0, top: 41, width: 1200, height: 750 };
    const css = { deviceWidth: 1200, deviceHeight: 750 } as const;
    const full = { ...header, ...css, width: 1200, height: 750 };
    const saver = { ...header, ...css, width: 800, height: 500 };
    for (const point of [
      { x: 0, y: 41 },
      { x: 600, y: 416 },
      { x: 37.5, y: 703.25 },
      { x: 1200, y: 791 },
    ])
      expect(at(area, saver, point)).toEqual(at(area, full, point));
    expect(at(area, saver, { x: 600, y: 416 })).toEqual({ x: 600, y: 375 });
    // Two thirds rounded to whole pixels (1281 × 721 → 854 × 481): the same
    // place within a fraction of a CSS pixel, also on the edges and in the
    // corners.
    const odd = { left: 0, top: 41, width: 1281, height: 721 };
    const oddCss = { deviceWidth: 1281, deviceHeight: 721 } as const;
    for (const point of [
      { x: 0.5, y: 41.5 },
      { x: 640.5, y: 401.5 },
      { x: 1280.5, y: 761.5 },
      { x: 13, y: 755 },
    ]) {
      const exact = at(
        odd,
        { ...header, ...oddCss, width: 1281, height: 721 },
        point,
      );
      const small = at(
        odd,
        { ...header, ...oddCss, width: 854, height: 481 },
        point,
      );
      expect(exact).not.toBeNull();
      expect(small).not.toBeNull();
      expect(Math.abs((small?.x ?? 0) - (exact?.x ?? 0))).toBeLessThan(0.5);
      expect(Math.abs((small?.y ?? 0) - (exact?.y ?? 0))).toBeLessThan(0.5);
    }
  });
});

describe("the bar (F39's addendum of 2026-10-13)", () => {
  test("the picture quality is Data saver only when that is stored", () => {
    expect(pictureKey).toBe("lazurio.view.picture");
    expect(pictureOf("saver")).toBe("saver");
    for (const value of [null, undefined, "", "standard", "Saver", "1", "hd"])
      expect(pictureOf(value)).toBe("standard");
  });

  test("the menu's keys move the focus and wrap; other keys are left alone", () => {
    expect(menuStep("ArrowDown", 0, 2)).toBe(1);
    expect(menuStep("ArrowDown", 1, 2)).toBe(0);
    expect(menuStep("ArrowUp", 1, 2)).toBe(0);
    expect(menuStep("ArrowUp", 0, 2)).toBe(1);
    expect(menuStep("Home", 1, 2)).toBe(0);
    expect(menuStep("End", 0, 2)).toBe(1);
    // Nothing focused yet: down to the first, up to the last.
    expect(menuStep("ArrowDown", -1, 2)).toBe(0);
    expect(menuStep("ArrowUp", -1, 2)).toBe(1);
    for (const key of ["Enter", " ", "Escape", "Tab", "a"])
      expect(menuStep(key, 0, 2)).toBeNull();
    expect(menuStep("ArrowDown", -1, 0)).toBeNull();
  });

  test("Otevřít samostatně opens the view's own address only inside an app's frame", () => {
    const origin = "https://browser.pilot.example.lazurio.io";
    const tab = "0123456789ABCDEF0123456789ABCDEF";
    expect(aloneAddress(true, origin, tab)).toBe(`${origin}/t/${tab}`);
    // A view that is a tab of its own (a bare tab, a phone) has no button.
    expect(aloneAddress(false, origin, tab)).toBeNull();
    // Before the view has its tab there is nothing to open.
    expect(aloneAddress(true, origin, null)).toBeNull();
  });

  // F50 point 2 (C8): the app takes a message only about a tab its view
  // names in the contract's strict form. The view sent its own address,
  // with whatever query, slash or lower-case id its page was opened by.
  test("the view names its own tab to the app by the contract's view address, whatever its page's address says", () => {
    const origin = "https://browser.vm-01.example.lazurio.io";
    const tab = "0123456789ABCDEF0123456789ABCDEF";
    expect(ownTabView(origin, tab, `/t/${tab.toLowerCase()}`)).toBe(
      `${origin}/t/${tab}`,
    );
    expect(ownTabView(origin, null, `/t/${tab.toLowerCase()}`)).toBe(
      `${origin}/t/${tab}`,
    );
    expect(ownTabView(origin, null, "/")).toBeNull();
    expect(ownTabView(origin, null, "/t/not-a-tab")).toBeNull();
  });

  test("the bar's words are there in both languages", () => {
    expect(browserLanguage("cs-CZ")).toBe("cs");
    expect(browserLanguage("CS")).toBe("cs");
    expect(browserLanguage("en-US")).toBe("en");
    expect(browserLanguage("de-DE")).toBe("en");
    expect(words).toEqual({ cs, en });
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
    for (const said of [cs, en])
      for (const word of Object.values(said))
        expect(word.trim().length).toBeGreaterThan(0);
    const bar = (said: typeof cs) => ({
      picture: said.picture,
      pictureStandard: said.pictureStandard,
      pictureSaver: said.pictureSaver,
      pictureSaverHint: said.pictureSaverHint,
      openAlone: said.openAlone,
    });
    expect(bar(cs)).toEqual({
      picture: "Kvalita obrazu",
      pictureStandard: "Standardní",
      pictureSaver: "Úsporná",
      pictureSaverHint: "nižší rozlišení pro pomalé připojení",
      openAlone: "Otevřít samostatně",
    });
    expect(bar(en)).toEqual({
      picture: "Picture quality",
      pictureStandard: "Standard",
      pictureSaver: "Data saver",
      pictureSaverHint: "lower resolution for a slow connection",
      openAlone: "Open in a new tab",
    });
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

  test("a frame carries its number in its tab, which the page acknowledges", () => {
    const numbered = { ...header, seq: 7 };
    expect(decodeFrame(encodeFrame(numbered, jpeg))?.header).toEqual(numbered);
    // A service from before acknowledgements sends no number.
    expect(decodeFrame(encodeFrame(header, jpeg))?.header.seq).toBeUndefined();
    for (const seq of [0, -3, 1.5, "7", null])
      expect(
        decodeFrame(encodeFrame({ ...header, seq } as FrameHeader, jpeg)),
      ).toBeNull();
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
      {
        t: "hello",
        width: 1280,
        height: 720,
        dpr: 2,
        resize: false,
        picture: "saver",
      },
      {
        t: "hello",
        width: 390,
        height: 640,
        dpr: 3,
        resize: true,
        picture: "standard",
      },
      { t: "picture", picture: "saver" },
      { t: "picture", picture: "standard" },
      // F39's addendum of 2026-10-13: the page acknowledges its frames.
      {
        t: "hello",
        width: 1280,
        height: 720,
        dpr: 1,
        resize: true,
        acks: true,
      },
      {
        t: "hello",
        width: 1280,
        height: 720,
        dpr: 1,
        resize: true,
        acks: false,
      },
      { t: "ack", frame: 1 },
      { t: "ack", frame: 4242 },
      { t: "ack", frame: Number.MAX_SAFE_INTEGER },
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
    const hello = {
      t: "hello",
      width: 1280,
      height: 720,
      dpr: 2,
      resize: true,
    };
    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ t: "launch" }),
      JSON.stringify({ t: "text", text: "x".repeat(1_000_001) }),
      JSON.stringify({ t: "text", text: "" }),
      JSON.stringify({ t: "hello", width: 1280, height: 720, dpr: 2 }),
      // The picture quality is one of the two choices, or absent in `hello`.
      ...[
        "hd",
        "Saver",
        "",
        null,
        1,
        true,
        ["saver"],
        { picture: "saver" },
      ].flatMap((picture) => [
        JSON.stringify({ ...hello, picture }),
        JSON.stringify({ t: "picture", picture }),
      ]),
      JSON.stringify({ t: "picture" }),
      // `acks` is a boolean; an ack names a frame by its number, from 1.
      ...["true", 1, null, {}].map((acks) =>
        JSON.stringify({ ...hello, acks }),
      ),
      ...[0, -1, 1.5, "1", null, true, [1], 2 ** 53, Number.NaN].map((frame) =>
        JSON.stringify({ t: "ack", frame }),
      ),
      JSON.stringify({ t: "ack" }),
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

  // The view's bar reads text as Nová karta's does, as Chrome's address bar
  // (F50 point 2; the cases are the contract's vectors, address-bar.json).
  test("the address bar's text becomes an address or a search", () => {
    const view = "https://browser.vm-01.example.lazurio.io";
    const page = (url: string): AddressTarget => ({ kind: "page", url });
    expect(addressBarTarget("example.com", view)).toEqual(
      page("https://example.com/"),
    );
    expect(addressBarTarget(" localhost:3000 ", view)).toEqual(
      page("http://localhost:3000/"),
    );
    expect(addressBarTarget("http://x.y/z", view)).toEqual(
      page("http://x.y/z"),
    );
    expect(addressBarTarget("about:blank", view)).toEqual(page("about:blank"));
    expect(addressBarTarget("hello world", view)).toEqual(
      page("https://www.google.com/search?q=hello%20world"),
    );
    // Never a script or a file of the Environment: another scheme is
    // refused.
    for (const typed of ["javascript:alert(1)", "file:///etc/passwd"])
      expect(addressBarTarget(typed, view)).toEqual({
        kind: "refused",
        reason: "scheme",
      });
    // Nothing on a view host loads inside the Environment browser.
    expect(addressBarTarget(`${view}/settings`, view)).toEqual({
      kind: "refused",
      reason: "view",
    });
    expect(addressBarTarget(view, view)).toEqual({ kind: "new-tab" });
  });
});

// F39's addendum of 2026-10-13 (#370): the page acknowledges each frame it is
// done with, so the service sends it no more than a few on the way. One
// acknowledgement covers every frame before it.
describe("the frames the page draws and acknowledges", () => {
  /** A pump whose decoding the test resolves frame by frame. */
  function pump() {
    const shown: number[] = [];
    const acked: number[] = [];
    const log: string[] = [];
    const decoding: {
      seq: number | undefined;
      resolve: (picture: string | null) => void;
      reject: (error: Error) => void;
    }[] = [];
    const frames = new FramePump<number | undefined, string>({
      decode: (seq) =>
        new Promise((resolve, reject) =>
          decoding.push({ seq, resolve, reject }),
        ),
      show: (picture, header) => {
        if (picture === "throws") throw new Error("drawing failed");
        shown.push(header.seq ?? 0);
        log.push(`show ${header.seq}`);
      },
      ack: (frame) => {
        acked.push(frame);
        log.push(`ack ${frame}`);
      },
    });
    const push = (seq: number | undefined) =>
      frames.push({
        header: seq === undefined ? header : { ...header, seq },
        jpeg: seq,
      });
    // Lets the pump's awaits run.
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { push, decoding, shown, acked, log, turn };
  }

  test("a frame is acknowledged once it is drawn, not before", async () => {
    const p = pump();
    p.push(1);
    await p.turn();
    expect(p.acked).toEqual([]);
    p.decoding[0]?.resolve("picture");
    await p.turn();
    expect(p.log).toEqual(["show 1", "ack 1"]);
  });

  test("while one decodes only the newest waits; the frames it replaced are acknowledged with it", async () => {
    const p = pump();
    p.push(1);
    await p.turn();
    p.push(2);
    p.push(3);
    p.push(4);
    p.decoding[0]?.resolve("picture");
    await p.turn();
    // Frame 1 drawn; 2 and 3 never decoded; 4 decodes next.
    expect(p.decoding.map((d) => d.seq)).toEqual([1, 4]);
    expect(p.acked).toEqual([1]);
    p.decoding[1]?.resolve("picture");
    await p.turn();
    expect(p.shown).toEqual([1, 4]);
    expect(p.acked).toEqual([1, 4]);
  });

  test("a frame that cannot be decoded or drawn is acknowledged all the same, and the next one goes on", async () => {
    const p = pump();
    p.push(1);
    await p.turn();
    p.push(2);
    p.decoding[0]?.resolve(null);
    await p.turn();
    p.push(3);
    p.decoding[1]?.reject(new Error("not a JPEG"));
    await p.turn();
    p.decoding[2]?.resolve("throws");
    await p.turn();
    p.push(4);
    await p.turn();
    p.decoding[3]?.resolve("picture");
    await p.turn();
    expect(p.shown).toEqual([4]);
    expect(p.acked).toEqual([1, 2, 3, 4]);
  });

  test("a frame without a number (a service from before acknowledgements) is drawn and not acknowledged", async () => {
    const p = pump();
    p.push(undefined);
    await p.turn();
    p.decoding[0]?.resolve("picture");
    await p.turn();
    expect(p.shown).toEqual([0]);
    expect(p.acked).toEqual([]);
  });

  test("what the page sends for its acknowledgements is what the service accepts", () => {
    for (const frame of [1, 2, 1_000_000])
      expect(accepted({ t: "ack", frame })).toBe(true);
    expect(
      accepted({
        t: "hello",
        ...viewSize(1280, 760, 2),
        resize: true,
        picture: "saver",
        acks: true,
      }),
    ).toBe(true);
  });
});

describe("what the view says while no frame is drawn (#392)", () => {
  const at = (
    open: boolean,
    drawn: boolean,
    browserReconnecting = false,
    ended = false,
  ) => viewStatus({ ended, open, drawn, browserReconnecting });

  test("connecting until the socket opens, loading until the tab paints, nothing once it has", () => {
    expect(at(false, false)).toBe("connecting");
    expect(at(true, false)).toBe("loading");
    expect(at(true, true)).toBe("hidden");
  });

  test("the browser reconnecting is not a page that loads, across the outage and the recovery", () => {
    // Connected to a known tab before its first frame, then the hub loses
    // Chrome: the socket stays open and the hub says "reconnecting".
    expect(at(true, false, true)).toBe("connecting");
    // Chrome is back ("connected"), and the tab has still painted nothing.
    expect(at(true, false, false)).toBe("loading");
    // A frame drawn before the outage keeps the page; the banner says the rest.
    expect(at(true, true, true)).toBe("hidden");
  });

  test("a closed socket says connecting, also over the last frame, and an ended view says nothing", () => {
    expect(at(false, true)).toBe("connecting");
    expect(at(false, true, true)).toBe("connecting");
    expect(at(true, false, false, true)).toBe("hidden");
    expect(at(false, false, true, true)).toBe("hidden");
  });
});

// F39's addendum of 2026-10-18 (#504): the page of a person's Lazurio account
// that the Environment browser's policy blocked is offered in their own
// browser with one button, never opened inside. The service's address is
// checked again here, so the button opens only an http or https address.
describe("the hand-off to the person's own browser", () => {
  test("offers the blocked page in the person's own browser, in their language", () => {
    const url = "https://dashboard.lazurio.ai/environments";
    expect(handOffNotice(url, cs)).toEqual({
      text: "Tato stránka se otevře jen ve vašem prohlížeči.",
      open: url,
      button: "Otevřít ve vašem prohlížeči",
      title: url,
    });
    expect(handOffNotice(url, en)).toEqual({
      text: "This page opens only in your own browser.",
      open: url,
      button: "Open in your browser",
      title: url,
    });
  });

  test("shows nothing for an address the button must never open", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome-error://chromewebdata/",
      "https://user:secret@auth.lazurio.ai/",
      "not an address",
      "",
      null,
      42,
    ])
      expect(handOffNotice(url, cs), String(url)).toBeNull();
  });
});
