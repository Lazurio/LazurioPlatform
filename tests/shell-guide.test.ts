import { expect, test } from "bun:test";
import {
  parseShell,
  type Shell,
  type ShellEnvironmentKind,
  shellEnvironmentKinds,
} from "../src/shell/contract";
import {
  createGuide,
  type GuideActions,
  type GuideElement,
  type GuideEvent,
  type GuideInvoker,
  type GuideView,
} from "../src/shell/guide";
import {
  parseGuides,
  principleIds,
  principleIn,
  principleMarks,
  shellMarks,
} from "../src/shell/guide-content";
import {
  type GuideBuddyPlacement,
  guideBuddyPlacement,
  guideBuddySize,
  guidePlacement,
  guideSheetBelow,
  guideWidth,
  type TourBox,
  tourPlacement,
} from "../src/shell/guide-placement";
import { isExplanationId } from "../src/shell/guide-protocol";
import { shellMessages } from "../src/shell/messages";
import { guideTextFindings } from "./fixtures/guide-text";

// The shell's guide (decision F56; root decision 0180's addendum of
// 2026-10-18): the six principles it says in both languages and their
// rules, the explanations a host hands over, the engine that decides what is
// drawn and when (with the drawing and the page faked: how it looks, moves
// and takes the focus is checked in a browser, root decision 0178), the
// arbiter with the Launchpad's onboarding tour, and where its card stands.

const locales = ["cs", "en"] as const;
const kinds: readonly (ShellEnvironmentKind | null)[] = [
  null,
  ...shellEnvironmentKinds,
];
test("the six principles, in the tour's order, with the prototype's ids", () => {
  expect(principleIds).toEqual([
    "environment",
    "buddy",
    "reach",
    "files",
    "integrations",
    "vault",
  ]);
  for (const id of principleIds) expect(isExplanationId(id)).toBe(true);
  expect(principleIn("billing", "cs", null)).toBeNull();
});

test("every principle keeps the guide's rules in both languages and every kind", () => {
  const found: string[] = [];
  for (const locale of locales)
    for (const kind of kinds)
      for (const id of principleIds) {
        const item = principleIn(id, locale, kind);
        if (item === null) throw new Error(id);
        found.push(
          ...guideTextFindings(item).map(
            (line) => `${locale}/${kind}: ${line}`,
          ),
        );
      }
  expect(found).toEqual([]);
});

test("Czech and English say the same steps at the same marks", () => {
  for (const kind of kinds)
    for (const id of principleIds) {
      const cs = principleIn(id, "cs", kind);
      const en = principleIn(id, "en", kind);
      expect(en?.steps.map((step) => step.at)).toEqual(
        cs?.steps.map((step) => step.at) ?? [],
      );
      expect(en?.steps.map((step) => step.sub === null)).toEqual(
        cs?.steps.map((step) => step.sub === null) ?? [],
      );
      expect(en?.aboutBuddy).toBe(cs?.aboutBuddy ?? false);
    }
});

test("every mark a principle points at is the shell's own or one a host may carry", () => {
  const known = new Set<string>([...shellMarks, ...principleMarks]);
  for (const kind of kinds)
    for (const id of principleIds)
      for (const step of principleIn(id, "cs", kind)?.steps ?? [])
        expect({ id, at: step.at, known: known.has(step.at ?? "") }).toEqual({
          id,
          at: step.at,
          known: true,
        });
});

test("the kind comes from the shell's kinds: an automated Environment is a work one, your computer has none", () => {
  const first = (locale: "cs" | "en", kind: ShellEnvironmentKind | null) =>
    principleIn("environment", locale, kind)?.steps[0]?.text;
  expect(first("cs", "team")).toBe(
    "Toto Týmové Prostředí je virtuální počítač vašich agentů",
  );
  expect(first("en", "personal")).toBe(
    "This Personal Environment is your agents' virtual computer",
  );
  expect(first("cs", "automated")).toBe(first("cs", "work"));
  expect(first("en", "automated")).toBe(first("en", "work"));
  expect(first("cs", "workstation")).toBe("Agenti pracují i na vašem počítači");
  expect(first("en", "workstation")).toBe("Agents work on your computer too");
  // Without a kind the plain words stay.
  expect(first("cs", null)).toBe(
    "Toto Prostředí je virtuální počítač vašich agentů",
  );
  expect(principleIn("integrations", "cs", "team")?.steps[1]?.sub).toBe(
    "všichni agenti a boti tohoto Týmového Prostředí",
  );
});

test("on your computer the agents work on it too: its first and last steps say so, every other kind keeps the window into their computer", () => {
  const steps = (locale: "cs" | "en", kind: ShellEnvironmentKind | null) =>
    principleIn("environment", locale, kind)?.steps.map((step) => step.text);
  expect(steps("cs", "workstation")).toEqual([
    "Agenti pracují i na vašem počítači",
    "S vlastním prohlížečem a aplikacemi",
    "Na něm pracují vaši agenti",
    "Lazurio ukazuje, co agenti dělají",
  ]);
  expect(steps("en", "workstation")).toEqual([
    "Agents work on your computer too",
    "With its own browser and apps",
    "Your agents work on it",
    "Lazurio shows what your agents do",
  ]);
  for (const kind of [null, "personal", "work", "team", "automated"] as const) {
    expect(steps("cs", kind)?.at(-1)).toBe(
      "Lazurio je okno do jejich počítače",
    );
    expect(steps("en", kind)?.at(-1)).toBe(
      "Lazurio is a window into their computer",
    );
  }
});

test("Trezor says the approved video's five lines; in a Personal Environment its adaptation", () => {
  expect(
    principleIn("vault", "cs", "work")?.steps.map((step) => step.text),
  ).toEqual([
    "Každá Organizace má vlastní trezor",
    "Každé Prostředí v ní má svůj",
    "Uživatelé do něj sdílejí hesla ze svého Bitwardenu",
    "Agenti v Prostředí je najdou a použijí bez ptaní",
    "Sdílení můžete kdykoli vzít zpět",
  ]);
  expect(
    principleIn("vault", "cs", "personal")?.steps.map((step) => step.text),
  ).toEqual([
    "Agenti mají v Bitwardenu vlastní účet",
    "Sdílíte do něj hesla ze svého Bitwardenu",
    "Agenti je najdou a použijí bez ptaní",
    "Sdílení můžete kdykoli vzít zpět",
  ]);
});

test("a laptop is not the agents' computer: Lazurio is a window into it, and Files say what agents work with", () => {
  expect(principleIn("environment", "cs", "work")?.steps.at(-1)?.text).toBe(
    "Lazurio je okno do jejich počítače",
  );
  expect(principleIn("environment", "en", "work")?.steps.at(-1)?.text).toBe(
    "Lazurio is a window into their computer",
  );
  expect(principleIn("files", "cs", "work")?.steps.at(-1)?.text).toBe(
    "Soubory jen ukazují, s čím agenti pracují",
  );
  expect(principleIn("integrations", "cs", "work")?.steps.at(-1)?.text).toBe(
    "Kam ho přihlásíte, tam agenti můžou",
  );
  // Only the two explanations about Buddy invite a person without one.
  expect(
    principleIds.filter((id) => principleIn(id, "cs", null)?.aboutBuddy),
  ).toEqual(["buddy", "reach"]);
});

test("a host's explanations: kept as given, every refused entry left out, anything but a list withdraws", () => {
  const good = {
    id: "files-team",
    title: "Soubory",
    steps: [
      { text: "Soubor přetáhněte do chatu", at: "tab-chat" },
      { text: "Číst a měnit je může celý Team", at: "files-list", sub: "x" },
      { text: "Bez cíle" },
    ],
    later: "a member of a later version",
  };
  expect(parseGuides([good])).toEqual([
    {
      id: "files-team",
      title: "Soubory",
      aboutBuddy: false,
      docs: null,
      steps: [
        { text: "Soubor přetáhněte do chatu", sub: null, at: "tab-chat" },
        { text: "Číst a měnit je může celý Team", sub: "x", at: "files-list" },
        { text: "Bez cíle", sub: null, at: null },
      ],
    },
  ]);
  const step = { text: "Krok", at: "files-list" };
  for (const refused of [
    { ...good, id: "files" }, // a principle's id
    { ...good, id: "Files" },
    { ...good, title: "" },
    { ...good, title: "a\nb" },
    { ...good, steps: [] },
    { ...good, steps: [step, step, step, step, step] },
    { ...good, steps: [{ text: "" }] },
    { ...good, steps: [{ text: "Krok", at: '[data-x="y"]' }] },
    { ...good, steps: [{ text: "Krok", at: "#files-open" }] },
    { ...good, steps: "Krok" },
    null,
    "files-team",
  ])
    expect(parseGuides([refused])).toEqual([]);
  // The first of two with one id is kept.
  expect(
    parseGuides([good, { ...good, title: "Jiné" }])?.map((g) => g.title),
  ).toEqual(["Soubory"]);
  for (const withdrawn of [null, undefined, {}, "x", 1])
    expect(parseGuides(withdrawn)).toBeNull();
  expect(parseGuides([])).toEqual([]);
});

test("an explanation's documentation: Integrace's principle carries it in each language, a host's only as an https address", () => {
  // The page's "Jak to funguje" moved into the card (F56's addendum of
  // 2026-10-18): the principle "integrations" links its documentation.
  for (const locale of locales) {
    const docs = principleIn("integrations", locale, "work")?.docs ?? "";
    expect(docs).toStartWith(
      `https://documentation.lazurio.ai/${locale}/environment-app-connections/`,
    );
    expect(new URL(docs).protocol).toBe("https:");
  }
  // The other principles have none.
  expect(
    principleIds.filter((id) => principleIn(id, "cs", null)?.docs !== null),
  ).toEqual(["integrations"]);
  const own = {
    id: "integrations-custom",
    title: "Vlastní MCP servery",
    steps: [{ text: "Krok", at: "mcp-list" }],
    docs: "https://documentation.lazurio.ai/cs/environment-app-connections/?utm_source=launchpad",
  };
  expect(parseGuides([own])?.[0]?.docs).toBe(own.docs);
  expect(parseGuides([{ ...own, docs: undefined }])?.[0]?.docs).toBeNull();
  for (const docs of [
    "http://documentation.lazurio.ai/cs/",
    "javascript:alert(1)",
    "https://user:secret@documentation.lazurio.ai/",
    "/cs/environment-app-connections/",
    "https://documentation.lazurio.ai/a b",
    `https://documentation.lazurio.ai/${"a".repeat(2048)}`,
    1,
    "",
  ])
    expect({ docs, kept: parseGuides([{ ...own, docs }]) }).toEqual({
      docs,
      kept: [],
    });
});

/** A shell document whose current Environment is of `kind`. */
function shellOf(kind: ShellEnvironmentKind, locale: "cs" | "en"): Shell {
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale,
    current: "vm-01.example",
    operator: { initials: null, login: null, avatar: null },
    environments: [
      {
        id: "vm-01.example",
        label: null,
        kind,
        organizations: ["example"],
        assignee: null,
        apps: {
          apps: "https://launchpad.vm-01.example.lazurio.io/",
          chat: null,
          automate: null,
        },
      },
    ],
    organizations: [
      {
        slug: "example",
        name: "Example",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: null,
  });
  if (shell === null) throw new Error("The fixture is a valid document");
  return shell;
}

type Drawn = { view: GuideView | null; actions: GuideActions };

/** The engine over a faked page: what it listens to, follows, draws and
 * announces. */
function fakePage(shell: Shell | null = shellOf("work", "cs")) {
  const log = {
    listening: 0,
    following: 0,
    layers: 0,
    drawn: [] as Drawn[],
    said: [] as string[],
    events: [] as GuideEvent[],
  };
  let help: ((id: string, invoker: GuideInvoker | null) => boolean) | null =
    null;
  const guide = createGuide({
    shell: () => shell,
    copy: shellMessages,
    follow: () => {
      log.following += 1;
      return () => {
        log.following -= 1;
      };
    },
    listenHelp: (play) => {
      log.listening += 1;
      help = play;
      return () => {
        log.listening -= 1;
        help = null;
      };
    },
    layer: () => {
      log.layers += 1;
      return {
        draw(view, actions) {
          log.drawn.push({ view, actions });
        },
        say(text) {
          log.said.push(text);
        },
      };
    },
    announce: (_element, event) => {
      log.events.push(event);
    },
  });
  const element = (lang: string | null = null): GuideElement => ({
    getAttribute: () => lang,
  });
  const last = () => log.drawn.at(-1) ?? null;
  const click = (id: string) => help?.(id, null) ?? false;
  return { guide, log, element, last, click };
}

test("a page that hands over nothing (a fork) gets nothing drawn, listened to or announced from <lazurio-buddy>", () => {
  const { guide, log, element } = fakePage();
  guide.attach(element());
  guide.changed();
  expect(guide.play("files", null)).toBe(false);
  expect(guide.active()).toBe(false);
  expect(guide.known()).toEqual([]);
  expect(log).toEqual({
    listening: 0,
    following: 0,
    layers: 0,
    drawn: [],
    said: [],
    events: [],
  });
  // Nor without the element, though the page hands its explanations over.
  const bare = fakePage();
  bare.guide.provide([]);
  expect(bare.guide.play("files", null)).toBe(false);
  expect(bare.log.listening + bare.log.following + bare.log.layers).toBe(0);
});

test("a page that takes part: the '?' plays a principle in the element's language, step by step, then done", () => {
  const { guide, log, element, last, click } = fakePage(shellOf("team", "cs"));
  guide.attach(element("en"));
  guide.provide([]);
  expect(log.listening).toBe(1);
  expect(log.following).toBe(1);
  expect(guide.known()).toEqual(principleIds);
  expect(click("files")).toBe(true);
  expect(log.events).toEqual([{ type: "started", explainer: "files" }]);
  expect(guide.attention.playing()).toBe("files");
  const first = last();
  if (!first?.view) throw new Error("A step is drawn");
  expect(first.view.explanation.title).toBe("Files");
  expect(first.view.stop).toBe(0);
  expect(first.view.words.guideNext).toBe("Next");
  expect(first.view.invite).toBeNull();
  // Without Buddy's bubble the neutral guide of Lazurio presents.
  expect(first.view.buddy).toBeNull();
  first.actions.step(9);
  const end = last();
  if (!end?.view) throw new Error("A step is drawn");
  expect(end.view.stop).toBe(3);
  end.actions.done();
  expect(last()?.view).toBeNull();
  expect(log.events.at(-1)).toEqual({ type: "done", explainer: "files" });
  expect(guide.attention.playing()).toBeNull();
});

test("Escape or Ukončit close it; an unknown id plays nothing; a second '?' waits for the first", () => {
  const { guide, log, element, last, click } = fakePage();
  guide.attach(element());
  guide.provide([]);
  expect(click("billing")).toBe(false);
  expect(click("vault")).toBe(true);
  expect(click("files")).toBe(true);
  expect(guide.attention.playing()).toBe("vault");
  last()?.actions.close();
  expect(log.events).toEqual([
    { type: "started", explainer: "vault" },
    { type: "closed", explainer: "vault" },
  ]);
});

test("never two tours at once: while Začínáme wants attention the '?' plays and draws nothing, the tour hears the ask, and hears the guide end", () => {
  const { guide, log, element, last, click } = fakePage();
  guide.attach(element("cs"));
  guide.provide([]);
  let heard = 0;
  let asked = 0;
  guide.attention.listen(() => {
    heard += 1;
  });
  guide.attention.asked(() => {
    asked += 1;
  });
  guide.attention.tour(true);
  expect(click("files")).toBe(true);
  expect(log.events).toEqual([]);
  expect(log.drawn).toEqual([]);
  expect(guide.attention.playing()).toBeNull();
  expect(asked).toBe(1);
  // Only assistive technology hears why.
  expect(log.said).toEqual(["Nejdřív dokončete Začínáme"]);
  guide.attention.tour(false);
  expect(click("files")).toBe(true);
  expect(heard).toBe(1);
  expect(asked).toBe(1);
  last()?.actions.close();
  expect(heard).toBe(2);
});

test("a page's own explanation plays with the kind filled, and ends when the page moves on", () => {
  const { guide, log, element, last, click } = fakePage(shellOf("team", "cs"));
  guide.attach(element());
  guide.provide([
    {
      id: "files-team",
      title: "Soubory",
      steps: [{ text: "Sdílí {toto}", at: "files-list" }],
    },
  ]);
  expect(guide.known()).toContain("files-team");
  expect(click("files-team")).toBe(true);
  const drawn = last();
  if (!drawn?.view) throw new Error("A step is drawn");
  expect(drawn.view.explanation.steps[0]?.text).toBe(
    "Sdílí toto Týmové Prostředí",
  );
  // Another page hands over its own: this one is gone, so it ends.
  guide.provide([]);
  expect(log.events.at(-1)).toEqual({
    type: "closed",
    explainer: "files-team",
  });
  expect(click("files-team")).toBe(false);
});

test("withdrawing or removing <lazurio-buddy> ends the guide and lets go of the page", () => {
  const { guide, log, element, click } = fakePage();
  const buddy = element();
  guide.attach(buddy);
  guide.provide([]);
  click("files");
  guide.provide(null);
  expect(log.events.at(-1)).toEqual({ type: "closed", explainer: "files" });
  expect(log.listening).toBe(0);
  expect(log.following).toBe(0);
  guide.provide([]);
  expect(log.listening).toBe(1);
  click("files");
  guide.detach(buddy);
  expect(log.events.at(-1)).toEqual({ type: "closed", explainer: "files" });
  expect(log.listening).toBe(0);
  expect(guide.active()).toBe(false);
});

test("a <lazurio-buddy> detached while it explains clears its layer, so reattached it starts afresh", () => {
  const { guide, log, element, click } = fakePage();
  const buddy = element();
  guide.attach(buddy);
  guide.provide([]);
  click("files");
  expect(log.drawn.map(({ view }) => view !== null)).toEqual([true]);
  guide.detach(buddy);
  // The layer draws nothing: its listeners and timer stop with it.
  expect(log.drawn.map(({ view }) => view !== null)).toEqual([true, false]);
  expect(log.events.at(-1)).toEqual({ type: "closed", explainer: "files" });
  expect(guide.attention.playing()).toBeNull();
  guide.attach(buddy);
  expect(click("files")).toBe(true);
  // A first show again, after the layer was cleared.
  expect(log.drawn.map(({ view }) => view !== null)).toEqual([
    true,
    false,
    true,
  ]);
  expect(log.events.at(-1)).toEqual({ type: "started", explainer: "files" });
});

test("at the end of an explanation about Buddy a person without one is asked to get one, where the account lives", () => {
  const { guide, element, last, click } = fakePage();
  guide.attach(element());
  guide.provide([]);
  click("buddy");
  const first = last();
  if (!first?.view) throw new Error("A step is drawn");
  expect(first.view.invite).toBeNull();
  first.actions.step(3);
  const end = last();
  if (!end?.view) throw new Error("A step is drawn");
  expect(end.view.invite).toBe("https://dashboard.lazurio.ai/");
  expect(end.view.words.guideInvite).toBe("Založte si Buddyho");
});

test("the guide's card: beside the element as the tour's bubble, in the middle without one, a sheet below 768 px", () => {
  const anchor = { left: 300, top: 120, right: 420, bottom: 150 };
  const wide = { width: 1440, height: 900 };
  expect(guidePlacement({ anchor, height: 140, viewport: wide })).toEqual({
    ...tourPlacement({ anchor, height: 140, viewport: wide }),
    sheet: false,
  });
  expect(guidePlacement({ anchor: null, height: 140, viewport: wide })).toEqual(
    {
      side: null,
      left: 570,
      top: 380,
      width: 300,
      arrow: null,
      sheet: false,
    },
  );
  const narrow = { width: 700, height: 800 };
  expect(guideSheetBelow).toBe(768);
  for (const at of [anchor, null])
    expect(
      guidePlacement({ anchor: at, height: 160, viewport: narrow }),
    ).toEqual({
      side: null,
      left: 12,
      top: 628,
      width: 676,
      arrow: null,
      sheet: true,
    });
  expect(guideWidth(700)).toBe(676);
  expect(guideWidth(1440)).toBe(300);
  // A sheet taller than the window starts at its top margin.
  expect(
    guidePlacement({ anchor: null, height: 2000, viewport: narrow }).top,
  ).toBe(12);
});

test("where Buddy presents he stands 30 px beside the element, on its right, else its left, else below or above it, his card 10 px past him with its tail at his head, as in the prototype (F56's addendum (7) of 2026-10-25)", () => {
  expect(guideBuddySize).toEqual({ width: 56, height: 64 });
  const wide = { width: 1440, height: 900 };
  // Right of it where he and the card have room: the card 24 px higher than
  // him, its tail 36 px down its left edge (the prototype's).
  expect(
    guideBuddyPlacement({
      anchor: { left: 300, top: 120, right: 420, bottom: 150 },
      height: 140,
      viewport: wide,
    }),
  ).toEqual({
    buddy: { left: 450, top: 103 },
    points: "right",
    side: "right",
    left: 516,
    top: 79,
    width: 300,
    arrow: 41,
    sheet: false,
  });
  // An element at the window's right edge: on its left, the card past him.
  expect(
    guideBuddyPlacement({
      anchor: { left: 1300, top: 20, right: 1400, bottom: 52 },
      height: 160,
      viewport: wide,
    }),
  ).toEqual({
    buddy: { left: 1214, top: 12 },
    points: "left",
    side: "left",
    left: 904,
    top: 12,
    width: 300,
    arrow: 20,
    sheet: false,
  });
  // As wide as the content: below it, the card beside him where it has room.
  expect(
    guideBuddyPlacement({
      anchor: { left: 360, top: 100, right: 1400, bottom: 400 },
      height: 200,
      viewport: wide,
    }),
  ).toEqual({
    buddy: { left: 852, top: 430 },
    points: "below",
    side: "right",
    left: 918,
    top: 430,
    width: 300,
    arrow: 20,
    sheet: false,
  });
  // No room below: above it, the card's foot level with his.
  expect(
    guideBuddyPlacement({
      anchor: { left: 360, top: 600, right: 1400, bottom: 880 },
      height: 200,
      viewport: wide,
    }),
  ).toEqual({
    buddy: { left: 852, top: 506 },
    points: "above",
    side: "right",
    left: 918,
    top: 370,
    width: 300,
    arrow: 153,
    sheet: false,
  });
  // No room on his right: the card on his left, its tail on its right edge.
  expect(
    guideBuddyPlacement({
      anchor: { left: 300, top: 600, right: 790, bottom: 880 },
      height: 200,
      viewport: { width: 800, height: 900 },
    }),
  ).toEqual({
    buddy: { left: 517, top: 506 },
    points: "above",
    side: "left",
    left: 207,
    top: 370,
    width: 300,
    arrow: 153,
    sheet: false,
  });
  // Without the element: the card in the middle, he on its left, pointing at
  // nothing.
  expect(
    guideBuddyPlacement({ anchor: null, height: 140, viewport: wide }),
  ).toEqual({
    buddy: { left: 504, top: 388 },
    points: null,
    side: "right",
    left: 570,
    top: 380,
    width: 300,
    arrow: 25,
    sheet: false,
  });
  // Below 768 px the card is the sheet, the same as the neutral guide's,
  // and he stands on its top edge at its left, pointing at nothing.
  const phone = { width: 390, height: 844 };
  for (const anchor of [
    { left: 20, top: 100, right: 120, bottom: 132 },
    null,
  ]) {
    const sheet = guidePlacement({ anchor, height: 160, viewport: phone });
    expect(
      guideBuddyPlacement({ anchor, height: 160, viewport: phone }),
    ).toEqual({ ...sheet, buddy: { left: 24, top: 614 }, points: null });
  }
  // A sheet as tall as the window: he stays inside it.
  expect(
    guideBuddyPlacement({ anchor: null, height: 2000, viewport: phone }).buddy,
  ).toEqual({ left: 24, top: 12 });
});

test("one rule for Buddy everywhere: he and his card whole in the window, apart, his card's tail at him, and beside a small element he stands 30 px from it on the side he points from", () => {
  const { width: wide, height: high } = guideBuddySize;
  const overlap = (
    a: Readonly<{ left: number; top: number; right: number; bottom: number }>,
    b: Readonly<{ left: number; top: number; right: number; bottom: number }>,
  ) =>
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom;
  const boxes = (at: GuideBuddyPlacement, height: number) => ({
    buddy: {
      left: at.buddy.left,
      top: at.buddy.top,
      right: at.buddy.left + wide,
      bottom: at.buddy.top + high,
    },
    card: {
      left: at.left,
      top: at.top,
      right: at.left + at.width,
      bottom: at.top + height,
    },
  });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 800, height: 600 },
  ])
    for (const height of [120, 220])
      for (let x = 0; x <= viewport.width - 120; x += 40)
        for (let y = 0; y <= viewport.height - 32; y += 40) {
          const anchor: TourBox = {
            left: x,
            top: y,
            right: x + 120,
            bottom: y + 32,
          };
          const at = guideBuddyPlacement({ anchor, height, viewport });
          const { buddy, card } = boxes(at, height);
          const where = { viewport, height, anchor };
          // Whole inside the window's margins.
          expect({
            where,
            inside:
              buddy.left >= 12 &&
              buddy.top >= 12 &&
              buddy.right <= viewport.width - 12 &&
              buddy.bottom <= viewport.height - 12 &&
              card.left >= 12 &&
              card.top >= 12 &&
              card.right <= viewport.width - 12 &&
              card.bottom <= viewport.height - 12,
          }).toEqual({ where, inside: true });
          // Neither covers the other nor the element.
          expect({
            where,
            apart:
              !overlap(buddy, card) &&
              !overlap(buddy, anchor) &&
              !overlap(card, anchor),
          }).toEqual({ where, apart: true });
          // 30 px from the element on the side he points from, the card
          // 10 px past him with its tail on the edge toward him.
          const gap = {
            right: buddy.left - anchor.right,
            left: anchor.left - buddy.right,
            below: buddy.top - anchor.bottom,
            above: anchor.top - buddy.bottom,
          };
          expect({ where, gap: at.points && gap[at.points] }).toEqual({
            where,
            gap: 30,
          });
          expect({
            where,
            card:
              at.side === "right"
                ? card.left - buddy.right
                : buddy.left - card.right,
          }).toEqual({ where, card: 10 });
          expect({
            where,
            tail:
              at.arrow !== null && at.arrow >= 20 && at.arrow <= height - 20,
          }).toEqual({ where, tail: true });
        }
});

test("the rules catch what they forbid", () => {
  const step = (text: string, sub: string | null = null) => ({
    text,
    sub,
    at: null,
  });
  const findings = guideTextFindings({
    id: "bad",
    title: "Launchpad",
    aboutBuddy: false,
    docs: null,
    steps: [
      step("Toto je jen vaše Prostředí"),
      step("Váš laptop = jejich počítač"),
      step("Na serveru přes SSH ve VM"),
      step("Jedna dvě tři čtyři pět šest sedm osm devět deset"),
      step("Konec s tečkou."),
    ],
  });
  for (const rule of [
    "Launchpad, Dashboard, Mašina or VM",
    "jen vám, váš, vaše or pro vás",
    "sameness",
    "SSH, tailnet or a server",
    "more than nine words",
    "a full stop",
    "too many steps",
  ])
    expect({
      rule,
      found: findings.some((line) => line.includes(rule)),
    }).toEqual({ rule, found: true });
  expect(
    guideTextFindings({
      id: "kinds",
      title: "Automatizované Prostředí",
      aboutBuddy: false,
      docs: null,
      steps: [step("Toto Prostředí Buddy", "Nesmíte {toto}")],
    }).map((line) => line.split(": ")[1]),
  ).toEqual([
    "a fourth kind",
    "a fourth kind",
    "forbidding",
    "an unfilled token",
  ]);
});
