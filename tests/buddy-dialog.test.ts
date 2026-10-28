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

const original = globalThis.document;
afterEach(() => {
  globalThis.document = original;
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
        : "Tento účet ChatGPT nemůže používat model, se kterým Buddy pracuje. Přihlaste ho jiným účtem.",
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
