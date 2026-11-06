import { afterEach, expect, test } from "bun:test";
import type { NewModuleOffer } from "../src/launchpad/apps-view";
import type { NewModuleOutcome } from "../src/launchpad/catalog-panel";
import { messages } from "../src/launchpad/messages";
import { createNewModuleDialog } from "../src/launchpad/new-module-dialog";
import { FakeNode } from "./fixtures/fake-dialog-dom";

// The dialog "+ Nový modul" on the small stand-in for the page's DOM
// (decision F36's addendum of 2026-11-05): what it says about the clipboard,
// and that each hand-over carries the words of its own offer. How it looks
// and takes the focus is checked in a browser (root decision 0178).

const hadDocument = "document" in globalThis;
const original = globalThis.document;
afterEach(() => {
  if (hadDocument) globalThis.document = original;
  else Reflect.deleteProperty(globalThis, "document");
});

const cs = messages("cs");
const settled = () => Bun.sleep(1);

const admin: NewModuleOffer = {
  id: "new-module",
  variant: "admin",
  organization: "Example-Org",
  name: "Example Company",
};
const member: NewModuleOffer = {
  ...admin,
  id: "new-module-request",
  variant: "member",
};

function page(copyText: (text: string) => Promise<boolean>) {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#new-module" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  globalThis.document = {
    querySelector: node,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
  } as unknown as Document;
  const kept: { offer: NewModuleOffer; description: string }[] = [];
  const said: string[] = [];
  const handed: {
    id: string;
    brief?: (() => Promise<string | null>) | undefined;
  }[] = [];
  let outcome: NewModuleOutcome = "handed-over";
  // With `hold`, each hand-over waits for the test, as a slow pairing does.
  let held = false;
  const waiting: ((outcome: NewModuleOutcome) => void)[] = [];
  const dialog = createNewModuleDialog({
    copy: () => cs,
    locale: () => "cs",
    handOver: async (prompt) => {
      handed.push(prompt);
      await prompt.brief?.();
      return held
        ? new Promise((resolve) => {
            waiting.push(resolve);
          })
        : outcome;
    },
    keepBrief: async (offer, description) => {
      kept.push({ offer, description });
      return `${offer.id}-${kept.length}`;
    },
    copyText,
    say: (text) => said.push(text),
  });
  const body = () => [...node("#new-module-body").walk()];
  const primary = () => {
    const button = [...node("#new-module-nav").walk()].find((child) =>
      child.className.split(" ").includes("primary"),
    );
    if (button === undefined) throw new Error("No main action");
    return button;
  };
  const field = () => {
    const found = body().find((child) => child.tagName === "textarea");
    if (found === undefined) throw new Error("No field");
    return found;
  };
  return {
    kept,
    said,
    handed,
    fails() {
      outcome = "failed";
    },
    hold() {
      held = true;
    },
    /** Ends the oldest hand-over that waits. */
    async finish(ending: NewModuleOutcome = "handed-over") {
      waiting.shift()?.(ending);
      await settled();
    },
    /** One screen back. */
    back() {
      const button = [...node("#new-module-nav").walk()].find(
        (child) => child.textContent === cs.newModuleBack,
      );
      if (button === undefined) throw new Error("No way back");
      button.click();
    },
    /** New words in the field of the second screen. */
    type(description: string) {
      const input = field();
      input.value = description;
      input.dispatch("input");
    },
    field: () => field().value,
    onward: () => primary().click(),
    waitsForChat: () => primary().disabled,
    open(offer: NewModuleOffer) {
      dialog.open(offer, new FakeNode("button") as unknown as HTMLElement);
    },
    close: () => node("#new-module").close(),
    status: () => node("#new-module-status").textContent,
    tone: () => node("#new-module-status").dataset.tone,
    isOpen: () => node("#new-module").open,
    /** On to the brief, with these words in the field. */
    describe(description: string) {
      primary().click();
      const input = field();
      input.value = description;
      input.dispatch("input");
      primary().click();
    },
    copy() {
      const button = body().find(
        (child) => child.textContent === cs.newModuleCopy,
      );
      if (button === undefined) throw new Error("No copy button");
      button.click();
    },
    brief: () =>
      body().find((child) => child.tagName === "pre")?.textContent ?? "",
    openInChat: () => primary().click(),
  };
}

test("Kopírovat zadání says it is there only once the clipboard took it", async () => {
  let answer: (done: boolean) => void = () => {};
  const copied: string[] = [];
  const view = page((text) => {
    copied.push(text);
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  view.open(admin);
  view.describe("Chci přehled reklamací.");
  view.copy();
  expect(copied).toEqual([view.brief()]);
  // The clipboard has not answered: nothing is claimed.
  await settled();
  expect(view.status()).toBe("");
  answer(true);
  await settled();
  expect(view.status()).toBe(cs.newModuleCopied);
  expect(view.tone()).toBeUndefined();
});

test("a refused clipboard, and one that is not there, say so and how to take the brief", async () => {
  for (const copyText of [
    async () => false,
    async () => {
      throw new Error("No clipboard");
    },
  ]) {
    const view = page(copyText);
    view.open(member);
    view.describe("Chci přehled reklamací.");
    view.copy();
    await settled();
    expect(view.status()).toBe(cs.newModuleCopyFailed);
    expect(view.tone()).toBe("warning");
  }
  expect(cs.newModuleCopyFailed).toContain("ručně");
});

test("an answer of the clipboard after the dialog closed says nothing in the next showing", async () => {
  let answer: (done: boolean) => void = () => {};
  const view = page(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  view.open(admin);
  view.describe("Popis.");
  view.copy();
  view.close();
  view.open(admin);
  answer(true);
  await settled();
  expect(view.status()).toBe("");
});

test("each hand-over keeps the words and the offer of its own showing; another offer starts empty", async () => {
  const view = page(async () => true);
  view.open(member);
  view.describe("Žádost o reklamace.");
  view.openInChat();
  await settled();
  view.open(admin);
  view.describe("Modul faktur.");
  view.openInChat();
  await settled();
  expect(
    view.kept.map(({ offer, description }) => [offer.id, description]),
  ).toEqual([
    ["new-module-request", "Žádost o reklamace."],
    ["new-module", "Modul faktur."],
  ]);
  expect(view.said).toEqual([cs.appsNewModuleOpened, cs.appsNewModuleOpened]);
  expect(view.isOpen()).toBe(false);
  // Without words nothing is kept, and the plain prompt goes.
  view.open(admin);
  view.describe("");
  view.openInChat();
  await settled();
  expect(view.kept).toHaveLength(2);
  expect(view.handed.at(-1)).toMatchObject({ id: "new-module" });
  expect(view.handed.at(-1)?.brief).toBeUndefined();
});

test("a hand-over that ends after the person went back and changed the words leaves them and the dialog", async () => {
  const view = page(async () => true);
  view.hold();
  view.open(admin);
  view.describe("První popis.");
  view.openInChat();
  await settled();
  expect(view.waitsForChat()).toBe(true);
  view.back();
  view.type("Druhý popis.");
  await view.finish("handed-over");
  expect(view.isOpen()).toBe(true);
  expect(view.field()).toBe("Druhý popis.");
  // Chat did open with the first words: the message says so.
  expect(view.said).toEqual([cs.appsNewModuleOpened]);
  view.onward();
  expect(view.brief()).toContain("Druhý popis.");
  expect(view.waitsForChat()).toBe(false);
});

test("a hand-over that ends after the dialog was closed and opened anew changes nothing in the new showing", async () => {
  const view = page(async () => true);
  view.hold();
  view.open(admin);
  view.describe("První popis.");
  view.openInChat();
  await settled();
  view.close();
  view.open(admin);
  view.describe("Nový popis.");
  await view.finish("handed-over");
  expect(view.isOpen()).toBe(true);
  expect(view.brief()).toContain("Nový popis.");
  expect(view.waitsForChat()).toBe(false);
  // Its failure too: only the short message, nothing in the new showing.
  view.openInChat();
  await settled();
  view.close();
  view.open(admin);
  await view.finish("failed");
  expect(view.isOpen()).toBe(true);
  expect(view.status()).toBe("");
  expect(view.said.at(-1)).toBe(cs.appsNewModuleCopyFailed);
});

test("the first of two hand-overs does not release the second's button, and each closes only its own showing", async () => {
  const view = page(async () => true);
  view.hold();
  view.open(admin);
  view.describe("První popis.");
  view.openInChat();
  await settled();
  view.close();
  view.open(admin);
  view.describe("Druhý popis.");
  view.openInChat();
  await settled();
  expect(view.kept.map((entry) => entry.description)).toEqual([
    "První popis.",
    "Druhý popis.",
  ]);
  await view.finish("handed-over");
  expect(view.isOpen()).toBe(true);
  expect(view.waitsForChat()).toBe(true);
  await view.finish("handed-over");
  expect(view.isOpen()).toBe(false);
});

test("a dialog closed while Chat was awaited forgets the words that went out, and only those", async () => {
  const view = page(async () => true);
  view.hold();
  view.open(admin);
  view.describe("Odeslaný popis.");
  view.openInChat();
  await settled();
  view.close();
  await view.finish("handed-over");
  view.open(admin);
  view.onward();
  expect(view.field()).toBe("");
  // No AI yet: nothing went out, so the words wait.
  view.type("Čekající popis.");
  view.onward();
  view.openInChat();
  await settled();
  view.close();
  await view.finish("needs-ai");
  view.open(admin);
  view.onward();
  expect(view.field()).toBe("Čekající popis.");
});

test("words wait for the same offer when the dialog is closed by mistake, and a failed hand-over keeps it open", async () => {
  const view = page(async () => true);
  view.open(admin);
  view.describe("Rozepsaný popis.");
  view.close();
  view.open(admin);
  view.describe("Rozepsaný popis.");
  expect(view.brief()).toContain("Rozepsaný popis.");
  view.fails();
  view.openInChat();
  await settled();
  expect(view.isOpen()).toBe(true);
  expect(view.status()).toBe(cs.appsNewModuleCopyFailed);
  expect(view.said).toEqual([]);
});
