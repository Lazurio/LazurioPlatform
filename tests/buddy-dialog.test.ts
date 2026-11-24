import { afterEach, expect, test } from "bun:test";
import { createBuddyDialog } from "../src/launchpad/buddy-dialog";
import type {
  BuddyReading,
  BuddySignInState,
  PersonaSaveResult,
} from "../src/launchpad/buddy-view";
import { messages } from "../src/launchpad/messages";
import { codexDevicePage } from "../src/tools/ai";
import { FakeNode } from "./fixtures/fake-dialog-dom";

// The first screen of "Seznamte se s Buddym", the ChatGPT sign-in (decision
// F65 point 4 with F63's addendum of 2026-10-28), as the person sees it after
// the onboarding of 2026-10-28: just the steps, with no line above them and
// nothing about the agents' own sign-ins; step 1 says the account needs a
// subscription and the action is "Přihlásit se"; the code's step says what to
// do where ChatGPT does not take the code; one calm line waits with the
// code's time and no spinner; Připojeno stands alone. The dialog runs on the
// small stand-in for the page's DOM.

const hadDocument = "document" in globalThis;
const original = globalThis.document;
afterEach(() => {
  if (hadDocument) globalThis.document = original;
  else Reflect.deleteProperty(globalThis, "document");
});

const cs = messages("cs");
const en = messages("en");

const reading = (signIn: BuddyReading["signIn"]): BuddyReading => ({
  state: signIn === "connected" ? "works" : "waits",
  signIn,
  persona: null,
});

/** A code that holds for another quarter of an hour. */
const pending = (): BuddySignInState => ({
  kind: "pending",
  session: "0123456789abcdef0123456789abcdef",
  code: "ABCD-12EF3",
  url: codexDevicePage,
  expiresAt: Date.now() + 14 * 60_000 + 32_000,
  pollMs: 2000,
});

/** The dialog on the stand-in, opened on its first screen. */
function page(
  state: Readonly<{ reading: BuddyReading; signIn: BuddySignInState }>,
  mode: "meet" | "sign-in" = "meet",
  locale: "cs" | "en" = "cs",
) {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#buddy-meet" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    querySelector: node,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  const signIns: string[] = [];
  const dialog = createBuddyDialog({
    copy: () => (locale === "cs" ? cs : en),
    locale: () => locale,
    facts: () => ({ ...state, now: Date.now() }),
    avatar: () => null,
    signIn: () => signIns.push("sign-in"),
    save: async () => ({ kind: "saved" }) as unknown as PersonaSaveResult,
    apps: () => ({ apps: [], automate: "Automate" }),
    spotlight: () => undefined,
    finished: () => undefined,
    closed: () => undefined,
    introduced: () => undefined,
    telegram: () => undefined,
  });
  dialog.open("sign-in", mode);
  const body = node("#buddy-meet-body");
  const all = () => [...body.walk()];
  return {
    signIns,
    title: () => node("#buddy-meet-title").textContent,
    dotsHidden: () =>
      (node("#buddy-meet-dots") as unknown as HTMLElement).hidden,
    /** The body's top-level blocks, by class. */
    blocks: () => body.children.map((child) => child.className),
    /** Every text the body draws, in order. */
    texts: () =>
      all()
        .map((child) => child.textContent)
        .filter((text) => text.trim() !== ""),
    /** The body's nodes of one class. */
    withClass: (name: string) =>
      all().filter((child) => child.className.split(" ").includes(name)),
    /** The body's buttons, with whether each is the primary one. */
    buttons: () =>
      all()
        .filter((child) => child.tagName === "button")
        .map((child) => ({
          label: child.textContent,
          primary: child.className.split(" ").includes("primary"),
        })),
    button: (label: string) => {
      const found = all().find(
        (child) => child.tagName === "button" && child.textContent === label,
      );
      if (found === undefined) throw new Error(`No button ${label}`);
      return found;
    },
    nav: () =>
      [...node("#buddy-meet-nav").walk()]
        .filter((child) => child.tagName === "button")
        .map((child) => child.textContent),
  };
}

/** The old lines this screen no longer says anywhere. */
const gone = [
  "Buddy se přihlásí vlastním účtem ChatGPT.",
  "Toto přihlášení patří jen Buddymu. Agenti se přihlašují zvlášť.",
  "Přihlásit Buddyho",
  "Buddy signs in with his own ChatGPT account.",
  "This sign-in is Buddy's own. Agents sign in separately.",
  "Sign Buddy in",
];

test("before a code: step 1's line names the subscription, and the person signs in with Přihlásit se", () => {
  const view = page({ reading: reading("none"), signIn: { kind: "idle" } });
  expect(view.title()).toBe("Seznamte se s Buddym");
  expect(view.texts()).toEqual([
    "Přihlaste se svým účtem ChatGPT s předplatným.",
    "Přihlásit se",
  ]);
  expect(view.buttons()).toEqual([{ label: "Přihlásit se", primary: true }]);
  view.button("Přihlásit se").click();
  expect(view.signIns).toEqual(["sign-in"]);
  // English says the same.
  const english = page(
    { reading: reading("none"), signIn: { kind: "idle" } },
    "meet",
    "en",
  );
  expect(english.texts()).toEqual([
    "Sign in with your ChatGPT account that has a subscription.",
    "Sign in",
  ]);
  for (const text of [...view.texts(), ...english.texts()])
    expect(gone).not.toContain(text);
});

test("the code: just the steps, what to do where ChatGPT refuses it, and one calm line that waits with its time, without a spinner", () => {
  const view = page({ reading: reading("none"), signIn: pending() });
  // No line above the steps; the steps, the setting, the wait, Nový kód.
  expect(view.blocks()).toEqual([
    "buddy-steps",
    "buddy-note",
    "buddy-wait",
    "buddy-again",
  ]);
  const texts = view.texts();
  expect(texts.slice(0, 7)).toEqual([
    "1",
    "Přihlaste se svým účtem ChatGPT s předplatným.",
    "Otevřít ChatGPT",
    "2",
    "Zadejte tento kód.",
    "ABCD-12EF3",
    "Kopírovat",
  ]);
  expect(texts[7]).toBe(
    "Když ChatGPT kód nepřijme, zapněte si přihlášení kódem v nastavení zabezpečení ChatGPT a znovu klikněte na „Otevřít ChatGPT“.",
  );
  // One line: the words that wait, announced once, and the code's time
  // beside them, which the ticker fills each second.
  const [wait] = view.withClass("buddy-wait");
  const [words, , time] = wait?.children ?? [];
  expect(words?.textContent).toBe("Čekám na přihlášení…");
  expect(words?.attributes.get("role")).toBe("status");
  expect(time?.dataset.countdown).toBe("Kód platí ještě {left}.");
  expect(time?.textContent).toMatch(/^Kód platí ještě 14:3\d\.$/);
  expect(time?.attributes.has("role")).toBe(false);
  // No spinner anywhere while the person signs in.
  expect(view.withClass("spinner")).toEqual([]);
  // Otevřít ChatGPT is OpenAI's page; Nový kód is a quiet second action.
  const [link] = view.withClass("button");
  expect(link).toMatchObject({ tagName: "a", href: codexDevicePage });
  expect(view.buttons()).toEqual([
    { label: "Kopírovat", primary: false },
    { label: "Nový kód", primary: false },
  ]);
  for (const text of texts) expect(gone).not.toContain(text);
  // English, the same steps and lines.
  const english = page(
    { reading: reading("none"), signIn: pending() },
    "meet",
    "en",
  );
  expect(english.texts().slice(0, 8)).toEqual([
    "1",
    "Sign in with your ChatGPT account that has a subscription.",
    "Open ChatGPT",
    "2",
    "Enter this code.",
    "ABCD-12EF3",
    "Copy",
    "If ChatGPT does not accept the code, turn on sign-in with a code in your ChatGPT security settings and click “Open ChatGPT” again.",
  ]);
  const [englishWait] = english.withClass("buddy-wait");
  expect(englishWait?.children[2]?.textContent).toMatch(
    /^The code is valid for another 14:3\d\.$/,
  );
});

test("Připojeno stands alone and prominent: no step's line with it", () => {
  const view = page({
    reading: reading("connected"),
    signIn: { kind: "idle" },
  });
  expect(view.blocks()).toEqual(["buddy-connected"]);
  expect(view.texts()).toEqual(["Připojeno"]);
  const [done] = view.withClass("buddy-connected");
  expect(done?.attributes.get("role")).toBe("status");
  const [mark] = done?.children ?? [];
  expect(mark?.tagName).toBe("svg");
  expect(mark?.children[0]?.attributes.get("href")).toBe("#i-check");
  // The meeting goes on to his introduction.
  expect(view.nav()).toEqual(["Pokračovat"]);
  expect(view.dotsHidden()).toBe(false);
});

test('a refused account: the plain sentence, its "?", and Přihlásit jiný účet as the one action', () => {
  for (const reason of ["no-subscription", "model-missing"] as const) {
    const view = page({
      reading: reading("none"),
      signIn: { kind: "failed", reason },
    });
    expect(view.blocks()).toEqual([
      "buddy-status buddy-warn",
      "buddy-help",
      "buddy-again",
    ]);
    expect(view.texts()[0]).toBe(
      reason === "no-subscription"
        ? "Tento účet ChatGPT je bez předplatného a Buddy předplatné potřebuje. Přihlaste ho účtem s předplatným ChatGPT."
        : "Předplatné tohoto účtu ChatGPT Buddymu nestačí. Přihlaste ho jiným účtem.",
    );
    expect(view.buttons()).toEqual([
      { label: "?", primary: false },
      { label: "Přihlásit jiný účet", primary: true },
    ]);
    view.button("Přihlásit jiný účet").click();
    expect(view.signIns).toEqual(["sign-in"]);
    for (const text of view.texts()) expect(gone).not.toContain(text);
  }
  // English names the other account too.
  const english = page(
    {
      reading: reading("none"),
      signIn: { kind: "failed", reason: "no-subscription" },
    },
    "meet",
    "en",
  );
  expect(english.buttons().at(-1)).toEqual({
    label: "Sign in with another account",
    primary: true,
  });
  // A refused code or an expired one still offers a new code, without the
  // agents' line.
  const refused = page({
    reading: reading("none"),
    signIn: { kind: "failed", reason: "refused" },
  });
  expect(refused.buttons().at(-1)).toEqual({
    label: "Nový kód",
    primary: true,
  });
  const expired = page({
    reading: reading("none"),
    signIn: { kind: "failed", reason: "expired" },
  });
  expect(expired.texts()).toEqual(["Kód vypršel.", "Nový kód"]);
});

test("from Nastavení → Buddy the dialog is named as its row, Přihlášení k ChatGPT, and ends with Hotovo", () => {
  const view = page({ reading: reading("none"), signIn: pending() }, "sign-in");
  expect(view.title()).toBe("Přihlášení k ChatGPT");
  expect(view.dotsHidden()).toBe(true);
  const done = page(
    { reading: reading("connected"), signIn: { kind: "idle" } },
    "sign-in",
  );
  expect(done.title()).toBe("Přihlášení k ChatGPT");
  expect(done.texts()).toEqual(["Připojeno"]);
  expect(done.nav()).toEqual(["Hotovo"]);
  const english = page(
    { reading: reading("none"), signIn: pending() },
    "sign-in",
    "en",
  );
  expect(english.title()).toBe("ChatGPT sign-in");
});

test("Buddy GEN4's meeting whose names did not reach him stays open and says so, instead of greeting", async () => {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#buddy-meet" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    // The page here carries no strip of his waving figure.
    querySelector: (selector: string) =>
      selector.startsWith("#buddy-wave-pictures") ? null : node(selector),
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  const finished: string[] = [];
  const saves: boolean[] = [];
  const persona = {
    buddyName: "Bertík",
    address: "vy" as const,
    user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
    confirmed: false,
    revision: "a".repeat(64),
    pending: false,
  };
  const dialog = createBuddyDialog({
    // English asks no ty or vy, so the unconfirmed names are ready as they are.
    copy: () => en,
    locale: () => "en",
    facts: () => ({
      reading: {
        state: "works",
        signIn: "not-needed",
        persona,
      } as BuddyReading,
      signIn: { kind: "idle" } as BuddySignInState,
      now: Date.now(),
    }),
    avatar: () => null,
    signIn: () => undefined,
    // ~/Buddy refused the write: the names are saved, not brought to him.
    save: async (_draft, confirm) => {
      saves.push(confirm);
      return { kind: "saved", pending: true, unapplied: true };
    },
    apps: () => ({ apps: [], automate: "Automate" }),
    spotlight: () => undefined,
    finished: () => finished.push("finished"),
    closed: () => undefined,
    introduced: () => undefined,
    telegram: () => undefined,
  });
  dialog.open("introduce");
  const meet = node("#buddy-meet");
  const navButton = (label: string) =>
    [...node("#buddy-meet-nav").walk()].find(
      (child) => child.tagName === "button" && child.textContent === label,
    );
  for (
    let beat = 0;
    beat < 20 && navButton(en.buddyContinue) === undefined;
    beat += 1
  )
    navButton(en.buddyBeatNext)?.click();
  const confirm = navButton(en.buddyContinue);
  expect(confirm).toBeDefined();
  expect(confirm?.disabled).toBe(false);
  confirm?.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(saves).toEqual([true]);
  expect(meet.open).toBe(true);
  expect(finished).toEqual([]);
  const texts = [...node("#buddy-meet-body").walk()].map(
    (child) => child.textContent,
  );
  expect(texts).toContain(en.buddyNotApplied);
});

test("Buddy GEN4's introduction as a tour plays his six beats alone, keeps that it was seen and ends in his window", () => {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#buddy-meet" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    querySelector: (selector: string) =>
      selector.startsWith("#buddy-wave-pictures") ? null : node(selector),
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  const events: string[] = [];
  const spotlights: boolean[] = [];
  const dialog = createBuddyDialog({
    copy: () => cs,
    locale: () => "cs",
    facts: () => ({
      reading: {
        state: "works",
        signIn: "not-needed",
        persona: {
          buddyName: "Buddy",
          address: "ty",
          user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
          confirmed: true,
          revision: "a".repeat(64),
          pending: false,
        },
      } as BuddyReading,
      signIn: { kind: "idle" } as BuddySignInState,
      now: Date.now(),
    }),
    avatar: () => null,
    signIn: () => undefined,
    save: async () => ({ kind: "saved" }) as unknown as PersonaSaveResult,
    apps: () => ({ apps: ["Chat", "Aplikace"], automate: "Automatizace" }),
    spotlight: (on) => spotlights.push(on),
    finished: () => events.push("finished"),
    closed: () => undefined,
    introduced: () => events.push("introduced"),
    telegram: () => undefined,
  });
  dialog.open("introduce", "tour");
  expect(events).toEqual(["introduced"]);
  const navButton = (label: string) =>
    [...node("#buddy-meet-nav").walk()].find(
      (child) => child.tagName === "button" && child.textContent === label,
    );
  const beats: string[] = [];
  for (let n = 0; n < 10; n += 1) {
    const stage = [...node("#buddy-meet-body").walk()].find(
      (child) => child.dataset?.beat !== undefined,
    );
    beats.push(String(stage?.dataset.beat));
    const next = navButton(cs.buddyBeatNext);
    if (next === undefined) break;
    next.click();
  }
  expect(beats).toEqual(["hello", "chats", "does", "place", "memory", "signs"]);
  // No questions in a tour: the last beat opens his window.
  expect(navButton(cs.buddyContinue)).toBeUndefined();
  // His launcher rises while his signs show.
  expect(spotlights.at(-1)).toBe(true);
  navButton(cs.buddyTourOpen)?.click();
  expect(events).toEqual(["introduced", "finished"]);
});

test("his signs beat: Zapnout oznámení asks right in the click and the row then says they are on and how to turn them off", async () => {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#buddy-meet" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    querySelector: (selector: string) =>
      selector.startsWith("#buddy-wave-pictures") ? null : node(selector),
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  let state: "on" | "off" = "off";
  const asked: string[] = [];
  const dialog = createBuddyDialog({
    copy: () => cs,
    locale: () => "cs",
    facts: () => ({
      reading: {
        state: "works",
        signIn: "not-needed",
        persona: {
          buddyName: "Buddy",
          address: "vy",
          user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
          confirmed: true,
          revision: "a".repeat(64),
          pending: false,
        },
      } as BuddyReading,
      signIn: { kind: "idle" } as BuddySignInState,
      now: Date.now(),
    }),
    avatar: () => null,
    signIn: () => undefined,
    save: async () => ({ kind: "saved" }) as unknown as PersonaSaveResult,
    apps: () => ({ apps: ["Chat"], automate: "Automatizace" }),
    spotlight: () => undefined,
    finished: () => undefined,
    closed: () => undefined,
    introduced: () => undefined,
    telegram: () => undefined,
    notices: {
      state: async () => state,
      enable: async () => {
        asked.push("asked");
        state = "on";
        return state;
      },
    },
  });
  dialog.open("introduce", "tour");
  const navButton = (label: string) =>
    [...node("#buddy-meet-nav").walk()].find(
      (child) => child.tagName === "button" && child.textContent === label,
    );
  for (let n = 0; n < 5; n += 1) navButton(cs.buddyBeatNext)?.click();
  // The state is read first; until then the row shows nothing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const body = () => [...node("#buddy-meet-body").walk()];
  const turnOn = body().find(
    (child) =>
      child.tagName === "button" && child.textContent === cs.buddyNoticesTurnOn,
  );
  expect(turnOn).toBeDefined();
  expect(body().map((child) => child.textContent)).toContain(
    cs.buddyNoticesHowOff,
  );
  turnOn?.click();
  expect(asked).toEqual(["asked"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const texts = body().map((child) => child.textContent);
  expect(texts).toContain(cs.buddyNoticesAreOn);
  expect(
    body().some(
      (child) =>
        child.tagName === "button" &&
        child.textContent === cs.buddyNoticesTurnOn,
    ),
  ).toBe(false);
});

test("his signs beat with an unreadable choice: no claim that notices are on, and Zapnout oznámení stays after a failed click (review of #1166)", async () => {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#buddy-meet" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    querySelector: (selector: string) =>
      selector.startsWith("#buddy-wave-pictures") ? null : node(selector),
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  let enables = 0;
  const dialog = createBuddyDialog({
    copy: () => cs,
    locale: () => "cs",
    facts: () => ({
      reading: {
        state: "works",
        signIn: "not-needed",
        persona: {
          buddyName: "Buddy",
          address: "vy",
          user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
          confirmed: true,
          revision: "a".repeat(64),
          pending: false,
        },
      } as BuddyReading,
      signIn: { kind: "idle" } as BuddySignInState,
      now: Date.now(),
    }),
    avatar: () => null,
    signIn: () => undefined,
    save: async () => ({ kind: "saved" }) as unknown as PersonaSaveResult,
    apps: () => ({ apps: ["Chat"], automate: "Automatizace" }),
    spotlight: () => undefined,
    finished: () => undefined,
    closed: () => undefined,
    introduced: () => undefined,
    telegram: () => undefined,
    notices: {
      // The guide's reading of an Environment whose choice does not answer.
      state: async () => "unknown",
      // The first click fails outright, the second saves nothing readable.
      enable: async () => {
        enables += 1;
        if (enables === 1) throw new Error("not saved");
        return "unknown";
      },
    },
  });
  dialog.open("introduce", "tour");
  const navButton = (label: string) =>
    [...node("#buddy-meet-nav").walk()].find(
      (child) => child.tagName === "button" && child.textContent === label,
    );
  for (let n = 0; n < 5; n += 1) navButton(cs.buddyBeatNext)?.click();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  const body = () => [...node("#buddy-meet-body").walk()];
  const texts = () => body().map((child) => child.textContent);
  const turnOn = () =>
    body().find(
      (child) =>
        child.tagName === "button" &&
        child.textContent === cs.buddyNoticesTurnOn,
    );
  expect(texts()).toContain(cs.buddyNoticesUnknown);
  expect(texts()).not.toContain(cs.buddyNoticesAreOn);
  for (let click = 0; click < 2; click += 1) {
    turnOn()?.click();
    await settle();
    await settle();
    expect(texts()).toContain(cs.buddyNoticesUnknown);
    expect(texts()).not.toContain(cs.buddyNoticesAreOn);
    expect(turnOn()?.disabled).not.toBe(true);
  }
  expect(enables).toBe(2);
});
