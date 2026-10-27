import { afterEach, expect, test } from "bun:test";
import {
  createTelegramDialog,
  type TelegramEntry,
} from "../src/launchpad/buddy-telegram-dialog";
import type {
  TelegramConnectResult,
  TelegramReading,
} from "../src/launchpad/buddy-view";
import { messages } from "../src/launchpad/messages";

// "Připojit Telegram" opened from the meeting's last screen is part of the
// meeting (decision F66 with F60's addendum of 2026-10-26, the approved
// prototype prototypes-lazurio #92): however it closes, the meeting ends as
// "Teď ne" ends it, and his window opens. Opened from Nastavení → Buddy →
// Kanály, closing it ends nothing. While a write to Hermes is in doubt, a
// connect waits (F66 point 13): only the dialog keeps its token, and sends it
// once when a reading says `retry`. The dialog runs on a small stand-in for
// the page's DOM, enough for what it draws; the browser closes it by itself
// on Escape.

type Listener = (event: { type: string; preventDefault(): void }) => void;

/** One element of the stand-in: what the dialog sets, appends and listens
 * to, and a dialog's `open`, `showModal` and `close`. */
class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  value = "";
  open = false;
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const node of nodes) this.children.push(FakeNode.of(node));
  }
  prepend(...nodes: (FakeNode | string)[]) {
    this.children.unshift(...nodes.map(FakeNode.of));
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    this.children.length = 0;
    this.append(...nodes);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ type, preventDefault() {} });
  }
  click() {
    this.dispatch("click");
  }
  focus() {}
  /** Lines found by class are not looked for here. */
  querySelector() {
    return null;
  }
  showModal() {
    this.open = true;
  }
  /** The browser's own close: Escape, or the page's `close()`. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  /** This node and every one under it. */
  *walk(): Generator<FakeNode> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
  static of(node: FakeNode | string): FakeNode {
    if (typeof node !== "string") return node;
    const text = new FakeNode("#text");
    text.textContent = node;
    return text;
  }
}

const original = globalThis.document;
afterEach(() => {
  globalThis.document = original;
});

const cs = messages("cs");

/** The dialog on the stand-in, with what its closes led to. */
function page(
  reading: TelegramReading,
  connect: (token: string) => Promise<TelegramConnectResult> = async () =>
    ({ kind: "invalid" }) as never,
) {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#buddy-telegram" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    querySelector: node,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  const ends: string[] = [];
  let current = reading;
  const dialog = createTelegramDialog({
    copy: () => cs,
    telegram: () => current,
    connect,
    approve: async () => ({ kind: "failed" }),
    closed: () => ends.push("closed"),
    meetingOver: () => ends.push("meeting over"),
  });
  /** The nav's button of `label`. */
  const navButton = (label: string) => {
    const found = [...node("#buddy-telegram-nav").walk()].find(
      (child) => child.tagName === "button" && child.textContent === label,
    );
    if (found === undefined) throw new Error(`No button ${label}`);
    return found;
  };
  return {
    ends,
    open: (from: TelegramEntry) => dialog.open(undefined, from),
    shows: () => node("#buddy-telegram").open,
    /** The dialog's own close button (×). */
    cross: () => node("#buddy-telegram-close").click(),
    /** Escape: the browser closes the dialog itself. */
    escape: () => node("#buddy-telegram").close(),
    navButton,
    /** The token's field of this visit. */
    field: () => {
      const found = [...node("#buddy-telegram-body").walk()].find(
        (child) => child.tagName === "input",
      );
      if (found === undefined) throw new Error("No token field");
      return found;
    },
    /** His Telegram changed while the dialog shows. */
    becomes: (next: TelegramReading) => {
      current = next;
      dialog.render();
    },
    /** The reading changed, and nothing draws yet. */
    takes: (next: TelegramReading) => {
      current = next;
    },
  };
}

const waiting: TelegramReading = {
  state: "waiting",
  bot: "rex_buddy_bot",
  requests: [],
  pending: false,
};

test("from the meeting's last screen, every way the dialog closes ends the meeting once: Zavřít, the cross, Escape, Hotovo once his bot is connected", () => {
  const ways: readonly (readonly [
    TelegramReading,
    (view: ReturnType<typeof page>) => void,
  ])[] = [
    [waiting, (view) => view.navButton(cs.toolsClose).click()],
    [waiting, (view) => view.cross()],
    [waiting, (view) => view.escape()],
    [{ state: "none", requests: [], pending: false }, (view) => view.cross()],
    [
      waiting,
      (view) => {
        // Approved meanwhile: connected, and Hotovo.
        view.becomes({
          state: "connected",
          bot: "rex_buddy_bot",
          requests: [],
          pending: false,
        });
        view.navButton(cs.buddyDone).click();
      },
    ],
  ];
  for (const [reading, close] of ways) {
    const view = page(reading);
    view.open("meeting");
    expect(view.shows()).toBe(true);
    expect(view.ends).toEqual([]);
    close(view);
    expect(view.shows()).toBe(false);
    expect({ state: reading.state, ends: view.ends }).toEqual({
      state: reading.state,
      ends: ["closed", "meeting over"],
    });
    // Closed once, ended once.
    view.escape();
    expect(view.ends).toEqual(["closed", "meeting over"]);
  }
});

test("from Nastavení → Buddy → Kanály, closing it ends nothing, also after a visit from the meeting", () => {
  const view = page(waiting);
  view.open("channels");
  view.navButton(cs.toolsClose).click();
  expect(view.ends).toEqual(["closed"]);
  view.open("meeting");
  view.cross();
  expect(view.ends).toEqual(["closed", "closed", "meeting over"]);
  // The next visit from Kanály is its own.
  view.open("channels");
  view.escape();
  expect(view.ends).toEqual(["closed", "closed", "meeting over", "closed"]);
});

test("a connect that waits for a write in doubt: only the dialog keeps its token, sends it once when the reading asks, and forgets it otherwise", async () => {
  const token = `${"7".repeat(10)}:AAH${"q".repeat(32)}`;
  const none: TelegramReading = { state: "none", requests: [], pending: false };
  const held: TelegramReading = {
    state: "starting",
    requests: [],
    pending: true,
    held: true,
  };
  const asked: TelegramReading = { ...none, retry: true };
  const turn = () => Bun.sleep(1);
  /** Připojit with the token pasted, the connect answering `answers` in turn
   * ("saved" after them). */
  async function paste(answers: TelegramConnectResult[]) {
    const sent: string[] = [];
    // The client takes the answer in as the reading before it says "held".
    const view: ReturnType<typeof page> = page(none, async (value) => {
      sent.push(value);
      const answer = answers.shift() ?? { kind: "saved" };
      if (answer.kind === "held") view.takes(held);
      return answer;
    });
    view.open("channels");
    view.navButton(cs.telegramBotCreated).click();
    const field = view.field();
    field.value = token;
    view.navButton(cs.telegramConnect).click();
    await turn();
    // The field holds it no longer than the sending.
    expect(field.value).toBe("");
    // Read again while it waits.
    view.becomes(held);
    await turn();
    return { view, sent };
  }

  // Asked once the barrier lifts: sent again, once.
  {
    const { view, sent } = await paste([{ kind: "held" }]);
    expect(sent).toEqual([token]);
    view.becomes(asked);
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([token, token]);
  }
  // Waiting again on its way: kept, and sent at the next ask.
  {
    const { view, sent } = await paste([{ kind: "held" }, { kind: "held" }]);
    view.becomes(asked);
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([token, token, token]);
  }
  // A reading without the ask (a later disconnect, or its time gone):
  // forgotten, and never sent after.
  {
    const { view, sent } = await paste([{ kind: "held" }]);
    view.becomes({ ...none, pending: true });
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([token]);
  }
  // The dialog closed meanwhile: forgotten.
  {
    const { view, sent } = await paste([{ kind: "held" }]);
    view.cross();
    view.open("channels");
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([token]);
  }
  // Refused when sent again: back to the token's step, and nothing kept.
  {
    const { view, sent } = await paste([{ kind: "held" }, { kind: "refused" }]);
    view.becomes(asked);
    await turn();
    expect(view.field().value).toBe("");
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([token, token]);
  }
});
