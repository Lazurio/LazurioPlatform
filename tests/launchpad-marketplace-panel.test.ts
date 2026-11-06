import { afterEach, expect, test } from "bun:test";
import type {
  NewModuleOutcome,
  NewModulePrompt,
} from "../src/launchpad/catalog-panel";
import {
  adoptionPromptId,
  adoptionRequestPromptId,
  type MarketplaceCatalog,
  type MarketplaceOffer,
  offerById,
  parseMarketplaceIndex,
} from "../src/launchpad/marketplace";
import { createMarketplacePanel } from "../src/launchpad/marketplace-panel";
import type { MarketplaceAnswer } from "../src/launchpad/marketplace-refresh";
import { messages } from "../src/launchpad/messages";
import type { PageRoute } from "../src/launchpad/routes";
import type { Catalog } from "../src/organizations/catalog";
import { FakeNode } from "./fixtures/fake-dialog-dom";
import unreleasedIndex from "./fixtures/marketplace-index-unreleased.json";

// The dialog of "Přidat do Organizace" while "Pokračovat v Chatu" waits for
// Chat (plan DEV-6593, marketplace-panel.ts): the hand-over's outcome is said
// only in the dialog that started it. A read that brings a newer version of
// the offer, or a dialog closed and opened on another offer in the meantime,
// keeps what the dialog shows and says, and its next hand-over is the offer
// it shows. The panel runs on the small stand-in for the page's DOM.

const original = globalThis.document;
afterEach(() => {
  globalThis.document = original;
});

const en = messages("en");
const commit = "0123456789abcdef0123456789abcdef01234567";

/** Every offer of the fixture index, its newest release published. */
const published = parseMarketplaceIndex({
  ...unreleasedIndex,
  offers: unreleasedIndex.offers.map((offer) => ({
    ...offer,
    releases: offer.releases.map((release, i) =>
      i === 0 ? { ...release, commit } : release,
    ),
  })),
}) as readonly MarketplaceOffer[];

/** The registry's catalog at a commit of one repeated character. */
const at = (
  character: string,
  offers: readonly MarketplaceOffer[],
): MarketplaceCatalog => ({
  source: "registry",
  commit: character.repeat(40),
  offers,
});

const first = at("a", published);
const offer = (catalog: MarketplaceCatalog, id: string) =>
  offerById(catalog, id) as MarketplaceOffer;

/** This Folder's catalog: one Organization bound to GitHub. */
const folder = {
  kind: "catalog",
  organizations: [
    {
      directory: "Example_GEN3",
      organization: "Example",
      displayName: "Example Company",
      forgeLogin: "Example-Org",
      state: "current",
      issues: [],
      executable: true,
      teams: [],
      modules: [],
      repositories: [],
    },
  ],
} as unknown as Catalog;

const settled = () => Bun.sleep(1);

/** The Marketplace page on the stand-in, its reads and hand-overs answered
 * by the test. */
function page(role: "admin" | "member" | null = null) {
  const byId = new Map<string, FakeNode>();
  const node = (selector: string) => {
    let found = byId.get(selector);
    if (found === undefined) {
      found = new FakeNode(selector === "#market-dialog" ? "dialog" : "div");
      byId.set(selector, found);
    }
    return found;
  };
  const visible: (() => void)[] = [];
  globalThis.document = {
    querySelector: node,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_space: string, tag: string) => new FakeNode(tag),
    addEventListener: (_type: string, listener: () => void) =>
      visible.push(listener),
    visibilityState: "visible",
  } as unknown as Document;
  const reads: ((answer: MarketplaceAnswer | null) => void)[] = [];
  const handOvers: {
    prompt: NewModulePrompt;
    end: (outcome: NewModuleOutcome) => void;
  }[] = [];
  let route: PageRoute = { view: "marketplace" };
  let catalogRead: Catalog = folder;
  const panel = createMarketplacePanel({
    copy: () => en,
    locale: () => "en",
    route: () => route,
    load: () => new Promise((resolve) => reads.push(resolve)),
    changed: () => undefined,
    catalog: () => catalogRead,
    personalSpace: () => catalogRead.personalspace !== undefined,
    role: async () => role,
    handOver: (prompt) =>
      new Promise((resolve) => handOvers.push({ prompt, end: resolve })),
  });
  const dialog = node("#market-dialog");
  const ok = node("#market-dialog-ok");
  return {
    handOvers,
    ok,
    /** What the dialog's body says, each drawn text. */
    says: () =>
      [...node("#market-dialog-body").walk()].map((child) => child.textContent),
    /** This Folder's catalog from now on. */
    folder(catalog: Catalog) {
      catalogRead = catalog;
    },
    /** Goes to an offer's detail and draws it. */
    detail(id: string) {
      route = { view: "marketplace", offer: id };
      panel.render();
    },
    /** Answers the read the page is waiting for. */
    async answer(catalog: MarketplaceCatalog) {
      const resolve = reads.shift();
      if (resolve === undefined) throw new Error("No read pending");
      resolve(catalog);
      await settled();
    },
    /** The page is shown again: it reads at once. */
    wake() {
      for (const listener of visible) listener();
    },
    /** "Přidat do Organizace" on the detail. */
    add() {
      const button = [...node("#market-body").walk()].find((child) =>
        child.className.split(" ").includes("market-add"),
      );
      if (button === undefined) throw new Error("No add button");
      button.click();
    },
    cancel: () => node("#market-dialog-cancel").click(),
    /** Ends a hand-over the page is waiting for. */
    async end(index: number, outcome: NewModuleOutcome) {
      handOvers[index]?.end(outcome);
      await settled();
    },
    open: () => dialog.open,
    title: () => node("#market-dialog-title").textContent,
    status: () => node("#market-dialog-status").textContent,
    /** Leaves the page, so that it reads nothing more. */
    leave() {
      route = { view: "home" };
      panel.render();
    },
  };
}

const titled = (catalog: MarketplaceCatalog, id: string) =>
  en.marketAddTitle.replace("{title}", offer(catalog, id).title);

test("a hand-over that ends in the dialog that started it says its outcome there", async () => {
  const view = page();
  view.detail("presentations");
  await view.answer(first);
  view.add();
  expect(view.open()).toBe(true);
  expect(view.title()).toBe(titled(first, "presentations"));
  view.ok.click();
  expect(view.handOvers.map((entry) => entry.prompt.id)).toEqual([
    adoptionPromptId(first, offer(first, "presentations"), "empty"),
  ]);
  // One hand-over at a time.
  expect(view.ok.disabled).toBe(true);
  await view.end(0, "handed-over");
  expect(view.status()).toBe(en.marketHandedOver);
  expect(view.ok.disabled).toBe(false);
  view.leave();
});

test("a member of the Organization asks its Admin: the request's prompt and words take the adoption's place", async () => {
  const view = page("member");
  view.detail("presentations");
  await view.answer(first);
  view.add();
  await settled();
  expect(view.ok.textContent).toBe(en.marketAskAdmin);
  expect(view.says()).toContain(
    en.marketRequestWhat.replace("{name}", "Example Company"),
  );
  view.ok.click();
  const shown = offer(first, "presentations");
  expect(view.handOvers[0]?.prompt).toMatchObject({
    id: adoptionRequestPromptId(first, shown, "empty"),
    organization: "Example-Org",
  });
  const text = view.handOvers[0]?.prompt.text ?? "";
  expect(text).toContain("`admin-request`");
  expect(text).toContain(shown.title);
  expect(text).toContain(shown.release.commit);
  await view.end(0, "handed-over");
  view.leave();
});

test("an Admin, and a role that cannot be read, keep the adoption, whose first step is the live rights", async () => {
  for (const role of ["admin", null] as const) {
    const view = page(role);
    view.detail("presentations");
    await view.answer(first);
    view.add();
    await settled();
    expect(view.ok.textContent).toBe(en.marketHandOver);
    view.ok.click();
    expect(view.handOvers[0]?.prompt.id).toBe(
      adoptionPromptId(first, offer(first, "presentations"), "empty"),
    );
    await view.end(0, "handed-over");
    view.leave();
  }
});

test("a personal space without an Organization says that templates go into one", async () => {
  const none = { kind: "catalog", organizations: [] } as unknown as Catalog;
  for (const [catalog, words] of [
    [
      { ...none, personalspace: { directory: "personalspace", modules: [] } },
      en.marketTargetPersonal,
    ],
    [none, en.marketTargetNone],
  ] as const) {
    const view = page();
    view.folder(catalog as unknown as Catalog);
    view.detail("presentations");
    await view.answer(first);
    view.add();
    expect(view.says()).toContain(words);
    expect(view.ok.disabled).toBe(true);
    view.leave();
  }
  expect(messages("cs").marketTargetPersonal).toBe(
    "Šablony zatím přidáte jen do Organizace.",
  );
});

test("a read that changes the offer while Chat is awaited keeps its warning, and the next hand-over is the offer shown", async () => {
  const view = page();
  view.detail("presentations");
  await view.answer(first);
  view.add();
  view.ok.click();
  // While Chat is awaited the registry moves on: the offer has another
  // title, and the dialog shows it and says so.
  const before = offer(first, "presentations");
  const changed: MarketplaceOffer = {
    ...before,
    title: "Slides",
    summary: { cs: "Jiné slajdy", en: "Other slides" },
  };
  const second = at(
    "b",
    first.offers.map((entry) => (entry.id === before.id ? changed : entry)),
  );
  view.wake();
  await view.answer(second);
  const warning = en.marketChanged.replace("{title}", "Slides");
  expect(view.title()).toBe(titled(second, "presentations"));
  expect(view.status()).toBe(warning);
  expect(view.ok.disabled).toBe(true);
  // The earlier hand-over ends: the dialog stays on the new version with its
  // warning, and its button works again.
  await view.end(0, "handed-over");
  expect(view.open()).toBe(true);
  expect(view.title()).toBe(titled(second, "presentations"));
  expect(view.status()).toBe(warning);
  expect(view.ok.disabled).toBe(false);
  // The next click hands over the offer shown, of the catalog shown.
  view.ok.click();
  const next = view.handOvers[1]?.prompt;
  expect(next?.id).toBe(adoptionPromptId(second, changed, "empty"));
  expect(next?.text).toContain("Slides");
  await view.end(1, "handed-over");
  expect(view.status()).toBe(en.marketHandedOver);
  view.leave();
});

test("a dialog closed and opened on another offer while Chat is awaited stays on that offer", async () => {
  const view = page();
  view.detail("presentations");
  await view.answer(first);
  view.add();
  view.ok.click();
  view.cancel();
  expect(view.open()).toBe(false);
  // Another offer's dialog, while the first hand-over still waits.
  view.detail("mission-control");
  view.add();
  expect(view.title()).toBe(titled(first, "mission-control"));
  expect(view.ok.disabled).toBe(true);
  await view.end(0, "copied");
  // Nothing of the first offer comes back.
  expect(view.open()).toBe(true);
  expect(view.title()).toBe(titled(first, "mission-control"));
  expect(view.status()).toBe("");
  expect(view.ok.disabled).toBe(false);
  view.ok.click();
  expect(view.handOvers[1]?.prompt.id).toBe(
    adoptionPromptId(first, offer(first, "mission-control"), "empty"),
  );
  // A dialog closed for good stays closed when its hand-over ends.
  view.cancel();
  await view.end(1, "failed");
  expect(view.open()).toBe(false);
  expect(view.status()).toBe("");
  view.leave();
});
