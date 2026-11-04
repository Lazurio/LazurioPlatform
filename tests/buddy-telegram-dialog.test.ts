import { afterEach, expect, test } from "bun:test";
import { createHermesGateway } from "../src/buddy/hermes-gateway";
import { createBuddyTelegram } from "../src/buddy/telegram";
import {
  createTelegramDialog,
  type TelegramEntry,
} from "../src/launchpad/buddy-telegram-dialog";
import {
  parseTelegram,
  type TelegramApproveResult,
  type TelegramConnectResult,
  type TelegramReading,
} from "../src/launchpad/buddy-view";
import { messages } from "../src/launchpad/messages";
import { FakeNode } from "./fixtures/fake-dialog-dom";
import { fakeHermesGateway } from "./fixtures/fake-hermes-gateway";

// "Připojit Telegram" opened from the meeting's last screen is part of the
// meeting (decision F66 with F60's addendum of 2026-10-26, the approved
// prototype prototypes-lazurio #92): however it closes, the meeting ends as
// "Teď ne" ends it, and his window opens. Opened from Nastavení → Buddy →
// Kanály, closing it ends nothing. While a write to Hermes is in doubt, a
// connect waits (F66 point 13): only the dialog keeps its token, with the id
// the Launchpad gave that connect, and sends both once when a reading says
// `retry`; an answer that comes after its visit closed changes nothing. The
// dialog runs on a small stand-in for the page's DOM, enough for what it
// draws; the browser closes it by itself on Escape.

const original = globalThis.document;
afterEach(() => {
  globalThis.document = original;
});

const cs = messages("cs");

/** The dialog on the stand-in, with what its closes led to. */
function page(
  reading: TelegramReading,
  connect: (
    token: string,
    intent?: string,
  ) => Promise<TelegramConnectResult> = async () =>
    ({ kind: "invalid" }) as never,
  approve: (request: string) => Promise<TelegramApproveResult> = async () => ({
    kind: "failed",
  }),
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
    approve,
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
    /** Every text the body draws now. */
    texts: () =>
      [...node("#buddy-telegram-body").walk()].map(
        (child) => child.textContent,
      ),
    /** The body's buttons of `label`. */
    bodyButtons: (label: string) =>
      [...node("#buddy-telegram-body").walk()].filter(
        (child) => child.tagName === "button" && child.textContent === label,
      ),
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

const token = `${"7".repeat(10)}:AAH${"q".repeat(32)}`;
const none: TelegramReading = { state: "none", requests: [], pending: false };
const heldReading: TelegramReading = {
  state: "starting",
  requests: [],
  pending: true,
  held: true,
};
const asked: TelegramReading = { ...none, retry: true };
const turn = () => Bun.sleep(1);
const first = "1".repeat(32);
const second = "2".repeat(32);
const held = (intent: string): TelegramConnectResult => ({
  kind: "held",
  intent,
});

/** A connect the test answers when it chooses. */
function deferred() {
  let answer: (result: TelegramConnectResult) => void = () => {};
  const promise = new Promise<TelegramConnectResult>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

/** Připojit with the token pasted, the connect answering `answers` in turn
 * ("saved" after them; a promise when the test answers it later). */
async function paste(
  answers: (TelegramConnectResult | Promise<TelegramConnectResult>)[],
) {
  const sent: { token: string; intent?: string }[] = [];
  // The client takes the answer in as the reading before it says "held".
  const view: ReturnType<typeof page> = page(none, async (value, intent) => {
    sent.push(
      intent === undefined ? { token: value } : { token: value, intent },
    );
    const answer = await (answers.shift() ?? { kind: "saved" });
    if (answer.kind === "held") view.takes(heldReading);
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
  return { view, sent };
}

test("a connect that waits for a write in doubt: only the dialog keeps its token with its id, sends both once when the reading asks, and forgets it otherwise", async () => {
  // Asked once the barrier lifts: sent again, once, with its id.
  {
    const { view, sent } = await paste([held(first)]);
    view.becomes(heldReading);
    await turn();
    expect(sent).toEqual([{ token }]);
    view.becomes(asked);
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }, { token, intent: first }]);
  }
  // Waiting again on its way: kept with its new id, and sent at the next ask.
  {
    const { view, sent } = await paste([held(first), held(second)]);
    view.becomes(asked);
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([
      { token },
      { token, intent: first },
      { token, intent: second },
    ]);
  }
  // A reading without the ask (a later disconnect, or its time gone):
  // forgotten, and never sent after.
  {
    const { view, sent } = await paste([held(first)]);
    view.becomes({ ...none, pending: true });
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }]);
  }
  // The dialog closed meanwhile: forgotten.
  {
    const { view, sent } = await paste([held(first)]);
    view.cross();
    view.open("channels");
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }]);
  }
  // Refused when sent again: back to the token's step, and nothing kept.
  {
    const { view, sent } = await paste([held(first), { kind: "refused" }]);
    view.becomes(asked);
    await turn();
    expect(view.field().value).toBe("");
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }, { token, intent: first }]);
  }
  // A newer change took its place: forgotten quietly, no line, no step back.
  {
    const { view, sent } = await paste([held(first), { kind: "superseded" }]);
    view.becomes(asked);
    await turn();
    expect(() => view.field()).toThrow();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }, { token, intent: first }]);
  }
});

test("closed before the answer came: the answer keeps no token, moves no step, and nothing is sent after the dialog opens again (#677)", async () => {
  // The first Připojit answered "held" only after the dialog closed.
  {
    const late = deferred();
    const { view, sent } = await paste([late.promise]);
    view.cross();
    late.answer(held(first));
    await turn();
    view.becomes(asked);
    view.open("channels");
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }]);
    // The new visit opened where it should, not where the old answer led.
    expect(() => view.navButton(cs.telegramBotCreated)).not.toThrow();
  }
  // The token sent once more, answered after the dialog closed.
  {
    const late = deferred();
    const { view, sent } = await paste([held(first), late.promise]);
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }, { token, intent: first }]);
    view.cross();
    late.answer(held(second));
    await turn();
    view.open("channels");
    view.becomes(asked);
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }, { token, intent: first }]);
  }
  // Closed and opened again while the first answer is still on its way: a
  // Připojit of the new visit is its own, and the old answer touches it not.
  {
    const late = deferred();
    const { view, sent } = await paste([late.promise, held(second)]);
    view.cross();
    view.open("channels");
    view.navButton(cs.telegramBotCreated).click();
    view.field().value = token;
    view.navButton(cs.telegramConnect).click();
    await turn();
    late.answer(held(first));
    await turn();
    view.becomes(asked);
    await turn();
    expect(sent).toEqual([{ token }, { token }, { token, intent: second }]);
  }
});

test("an approval answered after the dialog closed is not the new visit's: Ano is not held up and no line of it shows", async () => {
  const request = "a".repeat(32);
  const waiting: TelegramReading = {
    state: "waiting",
    bot: "rex_buddy_bot",
    requests: [{ request, name: "jana_s" }],
    pending: false,
  };
  let answer: (result: TelegramApproveResult) => void = () => {};
  const view = page(
    waiting,
    undefined,
    () =>
      new Promise<TelegramApproveResult>((resolve) => {
        answer = resolve;
      }),
  );
  view.open("channels");
  const [yes] = view.bodyButtons(cs.telegramYes);
  yes?.click();
  await turn();
  expect(view.bodyButtons(cs.telegramYes)[0]?.disabled).toBe(true);
  view.cross();
  view.open("channels");
  expect(view.bodyButtons(cs.telegramYes)[0]?.disabled).toBe(false);
  answer({ kind: "failed" });
  await turn();
  view.becomes(waiting);
  expect(view.texts().join(" ")).not.toContain(cs.telegramApproveFailed);
});

// ---- Two pages against F66's core (#676) ---------------------------------------

/** Two dialogs, as two tabs of one Launchpad, against the real core and the
 * stand-in for Buddy's gateway: the first token write held past the
 * client's timeout, the barrier as F64's controller holds it, each tab's
 * reading its own, delivered when the test says. */
async function twoTabs() {
  const fake = await fakeHermesGateway();
  let owed = false;
  let barrier = false;
  const core = createBuddyTelegram({
    gateway: createHermesGateway({ home: fake.userHome, httpMs: 1_000 }),
    home: fake.userHome,
    owed: () => owed,
    changed: async () => {
      owed = true;
    },
    uncertain: async () => {
      owed = true;
      barrier = true;
    },
    blocked: async () => barrier,
    checkBot: async () => ({ kind: "bot", username: "rex_buddy_bot" }),
  });
  // The first token write: held until released, then run by the gateway
  // that took it.
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  fake.state.http = async (request) => {
    if (
      !holding ||
      request.method !== "PUT" ||
      request.path !== "/api/messaging/platforms/telegram"
    )
      return undefined;
    holding = false;
    await gate;
    return undefined;
  };
  const tab = (pasted: string) => {
    const sent: { token: string; intent?: string }[] = [];
    let settled = 0;
    // As the client does: the answer is this tab's reading at once.
    const view: ReturnType<typeof page> = page(none, async (value, intent) => {
      sent.push(
        intent === undefined ? { token: value } : { token: value, intent },
      );
      const answer = await core.connect(value, intent);
      settled += 1;
      if (answer.kind === "telegram") {
        view.takes(parseTelegram(answer));
        return answer.held === true && answer.intent !== undefined
          ? { kind: "held", intent: answer.intent }
          : { kind: "saved" };
      }
      return answer.kind === "blocked" && answer.reason === "superseded"
        ? { kind: "superseded" }
        : { kind: "failed" };
    });
    view.open("channels");
    view.navButton(cs.telegramBotCreated).click();
    view.field().value = pasted;
    return {
      view,
      sent,
      settled: () => settled,
      connect: () => view.navButton(cs.telegramConnect).click(),
    };
  };
  const until = async (done: () => boolean) => {
    for (let wait = 0; wait < 600 && !done(); wait += 1) await Bun.sleep(5);
    expect(done()).toBe(true);
  };
  return {
    fake,
    core,
    tab,
    until,
    release,
    /** The restart: a new gateway, nothing owed, the barrier lifted and the
     * follow-up run. */
    restart: async () => {
      fake.restart();
      owed = false;
      barrier = false;
      await core.cleared("lifted");
    },
  };
}

const tokenA = `${"5".repeat(10)}:AAA${"a".repeat(32)}`;
const tokenB = `${"6".repeat(10)}:BBB${"b".repeat(32)}`;

for (const then of ["B connects", "B disconnects"] as const)
  test(`two tabs hold two tokens across a write in doubt; ${then}; A's late retry from its older reading is refused, and B's outcome stays (#676)`, async () => {
    const world = await twoTabs();
    try {
      const a = world.tab(tokenA);
      const b = world.tab(tokenB);
      // A's token write ends in doubt (the client's 1 s); B's connect waits
      // behind it, the latest change.
      a.connect();
      await world.until(() => a.settled() === 1);
      b.connect();
      await world.until(() => b.settled() === 1);
      // A's old write lands in the gateway that took it; the restart.
      world.release();
      await Bun.sleep(50);
      expect(world.fake.state.telegram).toMatchObject({ token: tokenA });
      await world.restart();
      const reading = parseTelegram(await world.core.read());
      expect(reading.retry).toBe(true);
      if (then === "B connects") {
        // B's reading comes first: B sends its token once more and goes on.
        b.view.becomes(reading);
        await world.until(() => b.settled() === 2);
        expect(world.fake.state.telegram).toMatchObject({
          token: tokenB,
          enabled: true,
        });
      } else {
        // B disconnects before either retry.
        expect(await world.core.disconnect()).toMatchObject({ state: "none" });
        b.view.becomes(reading);
        await world.until(() => b.settled() === 2);
      }
      // A's older reading, delivered late: A sends its token, refused.
      a.view.becomes(reading);
      await world.until(() => a.settled() === 2);
      expect(a.sent).toEqual([
        { token: tokenA },
        { token: tokenA, intent: expect.stringMatching(/^[0-9a-f]{32}$/) },
      ]);
      expect(world.fake.state.telegram).toMatchObject(
        then === "B connects"
          ? { token: tokenB, enabled: true }
          : { token: null, enabled: false },
      );
      // Neither tab keeps a token, and nothing is sent again.
      a.view.becomes(reading);
      b.view.becomes(reading);
      await Bun.sleep(50);
      expect([a.sent.length, b.sent.length]).toEqual([2, 2]);
    } finally {
      await world.fake.close();
    }
  });
