import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { noHolds } from "../src/browser/contract/node";
import type { CdpConnection, CdpEvent } from "../src/browser/people/cdp";
import { BrowserHub, type Viewer } from "../src/browser/people/hub";
import {
  controlRect,
  folded,
  placePanel,
  stepChoice,
  suggestionsFor,
  typeAhead,
  useSheet,
} from "../src/browser/people/picker-view";
import {
  pickerKeyKinds,
  pickerLimits,
  readPicker,
} from "../src/browser/people/pickers";
import {
  type ClientMessage,
  type FrameHeader,
  modifierBits,
  type PickerItem,
  parseClientMessage,
  type ServerMessage,
} from "../src/browser/people/protocol";
import { cs, en } from "../src/browser/people/words";

// The view's own pickers for the pop-ups Chrome draws outside the page
// (F39's addendum of 2026-11-14, #970): the protocol, the pure helpers of
// the view, and the hub against a scripted DevTools peer.

// ---- Protocol ----------------------------------------------------------------

describe("picker messages", () => {
  const parse = (message: unknown) =>
    parseClientMessage(JSON.stringify(message));
  test("a choice names its picker and an option or a value", () => {
    expect(parse({ t: "pick", token: "a1", index: 3 })).not.toBeNull();
    expect(
      parse({ t: "pick", token: "a1", index: 3, value: "3", text: "Březen" }),
    ).not.toBeNull();
    expect(
      parse({ t: "pick", token: "a1", value: "2026-11-14" }),
    ).not.toBeNull();
    expect(parse({ t: "pick-cancel", token: "a1" })).not.toBeNull();
  });
  test("anything else is refused", () => {
    expect(parse({ t: "pick", token: "a1" })).toBeNull();
    expect(parse({ t: "pick", token: "a1", index: -1 })).toBeNull();
    expect(parse({ t: "pick", token: "a1", index: 1.5 })).toBeNull();
    expect(parse({ t: "pick", token: "x".repeat(65), index: 1 })).toBeNull();
    expect(parse({ t: "pick", token: "a1", value: 7 })).toBeNull();
    expect(
      parse({ t: "pick", token: "a1", value: "x".repeat(10_001) }),
    ).toBeNull();
    expect(parse({ t: "pick-cancel" })).toBeNull();
  });
});

describe("keys that open a pop-up (Chrome on Linux)", () => {
  const { alt, ctrl, shift } = modifierBits;
  test("Space and Enter open a select and a colour", () => {
    expect(pickerKeyKinds(" ", 0)).toEqual(["select", "color"]);
    expect(pickerKeyKinds("Enter", shift)).toEqual(["select", "color"]);
  });
  test("F4 and Alt with an arrow open a select and the calendars", () => {
    expect(pickerKeyKinds("F4", 0)).toContain("date");
    expect(pickerKeyKinds("F4", 0)).toContain("select");
    expect(pickerKeyKinds("ArrowDown", alt)).toContain("week");
    expect(pickerKeyKinds("ArrowUp", alt)).toContain("datalist");
  });
  test("an arrow alone opens only a datalist; a select changes in place", () => {
    expect(pickerKeyKinds("ArrowDown", 0)).toEqual(["datalist"]);
  });
  test("shortcuts and other keys open nothing", () => {
    expect(pickerKeyKinds(" ", ctrl)).toEqual([]);
    expect(pickerKeyKinds("Enter", alt)).toEqual([]);
    expect(pickerKeyKinds("a", 0)).toEqual([]);
    expect(pickerKeyKinds("Tab", 0)).toEqual([]);
  });
});

describe("the page's description of a control", () => {
  test("a select keeps its options, groups and choice within the limits", () => {
    const read = readPicker({
      kind: "select",
      name: "Měsíc",
      items: [
        { i: 0, text: "Měsíc", value: "", disabled: false, group: -1 },
        { i: 1, text: "Leden", value: "1", disabled: false, group: 0 },
        { i: 2, text: "Duben", value: "4", disabled: true, group: 7 },
      ],
      groups: [{ label: "Zima", disabled: false }],
      selected: 1,
    });
    expect(read?.items?.[1]).toEqual({
      i: 1,
      text: "Leden",
      value: "1",
      disabled: false,
      group: 0,
    });
    // A group the page does not have is none.
    expect(read?.items?.[2]?.group).toBe(-1);
    expect(read?.selected).toBe(1);
  });
  test("long text is cut and too many options are dropped", () => {
    const read = readPicker({
      kind: "datalist",
      name: "x".repeat(500),
      value: "Pr",
      items: Array.from({ length: pickerLimits.items + 10 }, (_, i) => ({
        i,
        text: "y".repeat(1_000),
        value: String(i),
        label: "",
      })),
    });
    expect(read?.name.length).toBe(pickerLimits.name);
    expect(read?.items?.length).toBe(pickerLimits.items);
    expect(read?.items?.[0]?.text.length).toBe(pickerLimits.text);
  });
  test("a field keeps its value, min, max and step", () => {
    expect(
      readPicker({
        kind: "date",
        name: "",
        value: "2026-11-14",
        min: "2026-01-01",
        max: "2026-12-31",
        step: "7",
      }),
    ).toEqual({
      t: "picker",
      kind: "date",
      name: "",
      value: "2026-11-14",
      min: "2026-01-01",
      max: "2026-12-31",
      step: "7",
    });
  });
  test("an unknown kind or a broken list is nothing", () => {
    expect(readPicker({ kind: "password", value: "secret" })).toBeNull();
    expect(readPicker({ kind: "select", items: "x" })).toBeNull();
    expect(readPicker({ kind: "select", items: [{ i: -1 }] })).toBeNull();
    expect(readPicker(null)).toBeNull();
  });
});

// ---- The view's helpers ------------------------------------------------------

const items = (texts: string[], disabled: number[] = []): PickerItem[] =>
  texts.map((text, i) => ({
    i,
    text,
    value: String(i),
    disabled: disabled.includes(i),
  }));

describe("the view's picker", () => {
  // A remote viewport of 800 × 500 drawn at half size, 20 px down.
  const header: FrameHeader = {
    width: 800,
    height: 500,
    deviceWidth: 800,
    deviceHeight: 500,
    offsetTop: 0,
    pageScaleFactor: 1,
  };
  const drawn = { left: 0, top: 20, width: 400, height: 250 };

  test("the control is placed where the frame draws it", () => {
    expect(
      controlRect({ x: 100, y: 40, width: 200, height: 20 }, drawn, header),
    ).toEqual({ left: 50, top: 40, width: 100, height: 10 });
    expect(
      controlRect(
        { x: 0, y: 0, width: 1, height: 1 },
        { ...drawn, width: 0 },
        header,
      ),
    ).toBeNull();
  });

  test("a list goes under its control, or over it when the room is above", () => {
    const area = { width: 800, height: 600 };
    const below = placePanel(
      { left: 100, top: 100, width: 120, height: 24 },
      area,
      { width: 220, height: 360 },
    );
    expect(below).toEqual({
      left: 100,
      top: 128,
      width: 220,
      maxHeight: 360,
      above: false,
    });
    const above = placePanel(
      { left: 700, top: 560, width: 80, height: 24 },
      area,
      { width: 220, height: 360 },
    );
    expect(above.above).toBe(true);
    expect(above.top + above.maxHeight).toBe(556);
    // Never past the box's edge.
    expect(above.left + above.width).toBeLessThanOrEqual(792);
  });

  test("a touch screen or a small box gets a sheet", () => {
    expect(useSheet(true, { width: 1280, height: 800 })).toBe(true);
    expect(useSheet(false, { width: 390, height: 700 })).toBe(true);
    expect(useSheet(false, { width: 1280, height: 800 })).toBe(false);
  });

  test("arrows skip options that cannot be chosen and stop at the ends", () => {
    const list = items(["A", "B", "C", "D"], [1, 3]);
    expect(stepChoice(list, 0, 1)).toBe(2);
    expect(stepChoice(list, 2, 1)).toBe(2);
    expect(stepChoice(list, 2, -1)).toBe(0);
    expect(stepChoice(list, -1, 1)).toBe(0);
    expect(stepChoice(list, -1, -1)).toBe(2);
    expect(stepChoice(list, 0, 10)).toBe(2);
    expect(stepChoice([], -1, 1)).toBe(-1);
  });

  test("typing jumps to a choice, without case or accents", () => {
    const months = items([
      "Leden",
      "Únor",
      "Březen",
      "Duben",
      "Červen",
      "Červenec",
    ]);
    expect(typeAhead(months, -1, "u")).toBe(1);
    expect(typeAhead(months, -1, "bre")).toBe(2);
    // One key again cycles through the choices that begin with it.
    expect(typeAhead(months, 4, "c")).toBe(5);
    expect(typeAhead(months, 5, "c")).toBe(4);
    // A longer name stays on the choice that still matches.
    expect(typeAhead(months, 4, "cerven")).toBe(4);
    expect(typeAhead(months, -1, "x")).toBe(-1);
    expect(typeAhead(items(["A", "B"], [0]), -1, "a")).toBe(-1);
    expect(folded("  ŽluŤoučký ")).toBe("zlutoucky");
  });

  test("a datalist's suggestions follow the field, or all show", () => {
    const cities: PickerItem[] = [
      { i: 0, text: "Praha", value: "Praha", label: "" },
      { i: 1, text: "Brno", value: "Brno", label: "" },
      { i: 2, text: "Ostrava", value: "Ostrava", label: "Moravskoslezský" },
    ];
    expect(suggestionsFor(cities, "pr").map((c) => c.value)).toEqual(["Praha"]);
    expect(suggestionsFor(cities, "morav").map((c) => c.value)).toEqual([
      "Ostrava",
    ]);
    expect(suggestionsFor(cities, "Plzeň")).toHaveLength(3);
    expect(suggestionsFor(cities, "")).toHaveLength(3);
  });

  test("both languages name every picker", () => {
    for (const say of [cs, en])
      for (const key of [
        "pickerApply",
        "pickerEmpty",
        "pickerSelect",
        "pickerDatalist",
        "pickerDate",
        "pickerTime",
        "pickerDatetime",
        "pickerMonth",
        "pickerWeek",
        "pickerColor",
      ] as const)
        expect(say[key].length).toBeGreaterThan(0);
  });
});

// ---- The hub ---------------------------------------------------------------

const page = "A".repeat(32);
const session = `S-${page}`;
const frame = `F-${page}`;

type Call = {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
};

/** One page in a scripted browser. The page has a select under (100, 50),
 * nothing elsewhere; `focused` names what has the focus. */
class Peer {
  readonly calls: Call[] = [];
  private listeners: ((event: CdpEvent) => void)[] = [];
  focused: "select" | "body" = "body";
  /** What applying a choice answers. */
  applied = "ok";
  /** Holds the page's description until opened (ordering). */
  gate: Promise<void> | null = null;

  connect = async (): Promise<CdpConnection> => ({
    send: async (method, params = {}, sessionId) => {
      const call = {
        method,
        params: { ...params } as Record<string, unknown>,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      if (
        method === "Runtime.callFunctionOn" &&
        String(params.functionDeclaration).includes("__lazurioPickerGuards") &&
        this.gate !== null
      )
        await this.gate;
      this.calls.push(call);
      return this.answer(method, call.params);
    },
    onEvent: (listener) => {
      this.listeners.push(listener);
    },
    onClose: () => {},
    close: () => {},
  });

  emit(method: string, params: Record<string, unknown>, sessionId?: string) {
    for (const listener of this.listeners)
      listener({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  called(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  private answer(
    method: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (method) {
      case "Target.setDiscoverTargets":
        queueMicrotask(() =>
          this.emit("Target.targetCreated", {
            targetInfo: {
              type: "page",
              targetId: page,
              url: "https://example.com/form",
              title: "Formulář",
              attached: false,
            },
          }),
        );
        return {};
      case "Target.attachToTarget":
        return { sessionId: `S-${params.targetId}` };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: frame } } };
      case "Page.getNavigationHistory":
        return { currentIndex: 0, entries: [{ id: 1 }] };
      case "Page.createIsolatedWorld":
        return { executionContextId: 9 };
      case "DOM.getNodeForLocation":
        if (params.x === 100 && params.y === 50)
          return { backendNodeId: 77, frameId: frame };
        return { backendNodeId: 5, frameId: frame };
      case "DOM.resolveNode":
        return {
          object: { objectId: `node-${params.backendNodeId}` },
        };
      case "DOM.describeNode":
        return { node: { backendNodeId: 77 } };
      case "DOM.getBoxModel":
        return { model: { border: [90, 40, 210, 40, 210, 60, 90, 60] } };
      case "Runtime.evaluate":
        if (params.expression === "document.activeElement")
          return {
            result: {
              objectId: this.focused === "select" ? "node-77" : "node-body",
            },
          };
        return { result: { value: "" } };
      case "Runtime.callFunctionOn": {
        const script = String(params.functionDeclaration);
        if (script.includes("__lazurioPickerGuards")) {
          if (params.objectId !== "node-77") return { result: { value: null } };
          return {
            result: {
              value: {
                kind: "select",
                name: "Měsíc",
                items: [
                  {
                    i: 0,
                    text: "Měsíc",
                    value: "",
                    disabled: false,
                    group: -1,
                  },
                  {
                    i: 1,
                    text: "Leden",
                    value: "1",
                    disabled: false,
                    group: -1,
                  },
                  { i: 2, text: "Únor", value: "2", disabled: true, group: -1 },
                ],
                groups: [],
                selected: 0,
              },
            },
          };
        }
        if (script.includes('"gone"'))
          return { result: { value: this.applied } };
        return { result: { value: true } };
      }
      default:
        return {};
    }
  }
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await settle(5);
  }
}

async function hubWith(peer: Peer) {
  const hub = new BrowserHub({
    connect: peer.connect,
    holds: async () => noHolds,
    uploadDirectory: tmpdir(),
    screen: { width: 1920, height: 1080 },
    log: () => {},
    reconnectMs: 20,
  });
  hub.start();
  await until(() => hub.ready);
  await until(() => peer.called("Page.getFrameTree").length > 0);
  return hub;
}

function viewer(hub: BrowserHub) {
  const got: ServerMessage[] = [];
  const v: Viewer = {
    send: (message) => got.push(message),
    sendFrame: () => {},
    buffered: () => 0,
    close: () => {},
    size: null,
    resize: false,
    picture: "standard",
    acks: false,
  };
  const of = <T extends ServerMessage["t"]>(t: T) =>
    got.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  const say = (message: ClientMessage) => hub.handle(page, v, message);
  return { v, got, of, say };
}

const press = (x: number, y: number): ClientMessage => ({
  t: "mouse",
  type: "mousePressed",
  x,
  y,
  button: "left",
  buttons: 1,
  clickCount: 1,
  modifiers: 0,
});
const release = (x: number, y: number): ClientMessage => ({
  t: "mouse",
  type: "mouseReleased",
  x,
  y,
  button: "left",
  buttons: 0,
  clickCount: 1,
  modifiers: 0,
});
const key = (
  k: string,
  type: "keyDown" | "keyUp" = "keyDown",
): ClientMessage => ({
  t: "key",
  type,
  key: k,
  code: k === " " ? "Space" : k,
  keyCode: k === " " ? 32 : 0,
  ...(k === " " && type === "keyDown" ? { text: " " } : {}),
  modifiers: 0,
  location: 0,
  repeat: false,
});

describe("the hub shows the view's picker for a person's input", () => {
  test("a press on a select: guarded before Chrome gets it, the list goes to that person only, the choice is written", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    const other = viewer(hub);
    expect(hub.attach(page, one.v)).toBe(true);
    expect(hub.attach(page, other.v)).toBe(true);
    await one.say(press(100, 50));
    const [picker] = one.of("picker");
    expect(picker).toMatchObject({
      kind: "select",
      name: "Měsíc",
      rect: { x: 90, y: 40, width: 120, height: 20 },
      selected: 0,
    });
    expect(other.of("picker")).toHaveLength(0);
    // The guard was armed in the view's own world before the press reached
    // Chrome, and the press still reached it.
    const guarded = peer.calls.findIndex(
      (c) =>
        c.method === "Runtime.callFunctionOn" &&
        String(c.params.functionDeclaration).includes("__lazurioPickerGuards"),
    );
    const pressed = peer.calls.findIndex(
      (c) =>
        c.method === "Input.dispatchMouseEvent" &&
        c.params.type === "mousePressed",
    );
    expect(guarded).toBeGreaterThan(-1);
    expect(pressed).toBeGreaterThan(guarded);
    expect(
      peer
        .called("Page.createIsolatedWorld")
        .some((c) => c.params.worldName === "lazurio-view-pickers"),
    ).toBe(true);
    // Nothing the page could notice as automation.
    expect(peer.called("Runtime.enable")).toHaveLength(0);
    expect(peer.called("DOM.enable")).toHaveLength(0);
    await one.say(release(100, 50));
    const token = picker?.token ?? "";
    // Another person cannot answer it, nor a disabled option be chosen.
    await other.say({ t: "pick", token, index: 1 });
    await one.say({ t: "pick", token: "nope", index: 1 });
    const applies = () =>
      peer
        .called("Runtime.callFunctionOn")
        .filter((c) => String(c.params.functionDeclaration).includes('"gone"'));
    expect(applies()).toHaveLength(0);
    await one.say({ t: "pick", token, index: 1 });
    expect(applies()).toHaveLength(1);
    expect(applies()[0]?.params.arguments).toEqual([
      { value: { kind: "select", index: 1, value: "1", text: "Leden" } },
    ]);
    // Once answered, the token is spent.
    await one.say({ t: "pick", token, index: 1 });
    expect(applies()).toHaveLength(1);
    hub.stop();
  });

  test("a disabled option is never written", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    hub.attach(page, one.v);
    await one.say(press(100, 50));
    await one.say({
      t: "pick",
      token: one.of("picker")[0]?.token ?? "",
      index: 2,
    });
    expect(
      peer
        .called("Runtime.callFunctionOn")
        .filter((c) => String(c.params.functionDeclaration).includes('"gone"')),
    ).toHaveLength(0);
    hub.stop();
  });

  test("a press elsewhere, a right press or a key on no control opens nothing", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    hub.attach(page, one.v);
    await one.say(press(300, 300));
    await one.say({
      ...(press(100, 50) as object),
      button: "right",
    } as ClientMessage);
    await one.say(key(" "));
    await one.say(key("a"));
    expect(one.of("picker")).toHaveLength(0);
    // Every input still reached the page.
    expect(peer.called("Input.dispatchMouseEvent")).toHaveLength(2);
    expect(peer.called("Input.dispatchKeyEvent")).toHaveLength(2);
    hub.stop();
  });

  test("Space on a focused select opens the list; the key still reaches the page", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    hub.attach(page, one.v);
    peer.focused = "select";
    await one.say(key(" "));
    expect(one.of("picker")).toHaveLength(1);
    const guard = peer
      .called("Runtime.callFunctionOn")
      .find((c) =>
        String(c.params.functionDeclaration).includes("__lazurioPickerGuards"),
      );
    expect(guard?.params.arguments).toEqual([
      { value: { kinds: ["select", "color"], key: " ", ms: 1_500 } },
    ]);
    expect(peer.called("Input.dispatchKeyEvent")).toHaveLength(1);
    hub.stop();
  });

  test("a tap opens the picker when it ends; a scroll that began on the control does not", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    hub.attach(page, one.v);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      x = 100,
      y = 50,
    ): ClientMessage => ({
      t: "touch",
      type,
      points: type === "touchEnd" ? [] : [{ x, y, id: 0 }],
      modifiers: 0,
    });
    await one.say(touch("touchStart"));
    expect(one.of("picker")).toHaveLength(0);
    await one.say(touch("touchEnd"));
    expect(one.of("picker")).toHaveLength(1);
    await one.say(touch("touchStart"));
    await one.say(touch("touchMove", 100, 120));
    await one.say(touch("touchEnd"));
    expect(one.of("picker")).toHaveLength(1);
    expect(peer.called("Input.dispatchTouchEvent")).toHaveLength(5);
    hub.stop();
  });

  test("the person's input keeps its order while the hub looks at a control", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    hub.attach(page, one.v);
    let open!: () => void;
    peer.gate = new Promise((resolve) => {
      open = resolve;
    });
    const first = one.say(press(100, 50));
    const second = one.say(release(100, 50));
    const third = one.say({ t: "text", text: "x" });
    await settle(30);
    // Nothing overtook the press that waits for its look.
    expect(peer.called("Input.dispatchMouseEvent")).toHaveLength(0);
    expect(peer.called("Input.insertText")).toHaveLength(0);
    open();
    await Promise.all([first, second, third]);
    const order = peer.calls
      .filter((c) => c.method.startsWith("Input."))
      .map((c) => `${c.method}:${c.params.type ?? c.params.text}`);
    expect(order).toEqual([
      "Input.dispatchMouseEvent:mousePressed",
      "Input.dispatchMouseEvent:mouseReleased",
      "Input.insertText:x",
    ]);
    hub.stop();
  });

  test("a navigation closes the open picker and its answer is not written", async () => {
    const peer = new Peer();
    const hub = await hubWith(peer);
    const one = viewer(hub);
    hub.attach(page, one.v);
    await one.say(press(100, 50));
    const token = one.of("picker")[0]?.token ?? "";
    peer.emit(
      "Page.frameNavigated",
      { frame: { id: frame, url: "https://example.com/next", loaderId: "L2" } },
      session,
    );
    await until(() => one.of("picker-closed").length > 0);
    expect(one.of("picker-closed")[0]?.token).toBe(token);
    await one.say({ t: "pick", token, index: 1 });
    expect(
      peer
        .called("Runtime.callFunctionOn")
        .filter((c) => String(c.params.functionDeclaration).includes('"gone"')),
    ).toHaveLength(0);
    hub.stop();
  });
});
