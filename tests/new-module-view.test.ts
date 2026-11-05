import { expect, test } from "bun:test";
import type { NewModuleOffer } from "../src/launchpad/apps-view";
import { chatPromptHref } from "../src/launchpad/chat-view";
import { messages } from "../src/launchpad/messages";
import {
  newModuleBrief,
  newModuleDescription,
  newModuleDescriptionLength,
  newModuleExamples,
  newModuleScreen,
  parseBriefAnswer,
} from "../src/launchpad/new-module-view";
import {
  briefKeptMs,
  briefPromptOf,
  briefsKept,
  createPromptBriefs,
  isBriefPrompt,
} from "../src/launchpad/prompt-briefs";

// The dialog "+ Nový modul" (decision F36's addendum of 2026-11-05): its three
// screens for the Admin, a member and the personal space's holder, the brief
// it hands over, and the description the Launchpad keeps for Chat. How it
// moves and takes the focus is checked in a browser (root decision 0178).

const cs = messages("cs");
const en = messages("en");

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
const personal: NewModuleOffer = {
  id: "new-personal-module",
  variant: "personal",
  organization: "example",
  name: null,
};

test("the first screen says what a module is, and who builds it for each person", () => {
  const screen = newModuleScreen("what", admin, "", cs);
  expect(screen).toMatchObject({
    title: "Nový modul",
    intro: "Modul je jedna oblast práce vaší firmy. Drží pohromadě tři věci:",
    parts: [
      {
        term: "Postup",
        text: "jak se v ní pracuje. Podle něj pracují agenti.",
      },
      { term: "Data", text: "záznamy a obsah, se kterými se pracuje." },
      { term: "Aplikace", text: "obrazovka, ve které data vidíte a měníte." },
    ],
    who: "Modul vám postaví agent v Chatu. Popíšete mu, co má řešit, technické věci zvolí sám a před stavbou vám ukáže plán.",
    template: true,
    video: true,
  });
  expect(newModuleScreen("what", member, "", cs)).toMatchObject({
    who: "Nový modul v Organizaci zakládá Admin: založí ho a určí, kdo k němu bude mít přístup. Vy mu pošlete popis.",
    template: true,
  });
  expect(newModuleScreen("what", member, "", en)).toMatchObject({
    who: "The Organization's Admin creates new modules and decides who gets access. You send them a description.",
  });
  // Templates go into an Organization only: no link that leads nowhere, and
  // no video that tells of an Organization's Admin.
  expect(newModuleScreen("what", personal, "", en)).toMatchObject({
    title: "New module",
    who: "An agent builds the module with you in Chat. You describe what it should do; it picks the technical details and shows you a plan before it builds.",
    template: false,
    video: false,
  });
});

test("the second screen has six things to remember and the space's examples, each a whole description", () => {
  const screen = newModuleScreen("describe", admin, "", cs);
  expect(screen).toMatchObject({
    title: "Co má modul řešit?",
    text: "Popište ho vlastními slovy. Čím víc napíšete, tím méně se agent bude doptávat.",
    mentionTitle: "Na co nezapomenout",
    mentions: [
      "Jaký problém řeší a co vás dnes zdržuje",
      "Kdo ho bude používat a kde",
      "Co v něm chcete vidět a dělat",
      "Odkud se berou data",
      "Co se má dít samo",
      "Kdo k němu má mít přístup",
    ],
  });
  expect(newModuleExamples(admin, cs).map((item) => item.label)).toEqual([
    "Přehled zakázek",
    "Přehled klientů",
    "Firemní web",
  ]);
  expect(newModuleExamples(member, cs)).toEqual(newModuleExamples(admin, cs));
  expect(newModuleExamples(personal, cs).map((item) => item.label)).toEqual([
    "Výdaje domácnosti",
    "Rodinné recepty",
    "Plánovač cesty",
  ]);
  for (const copy of [cs, en])
    for (const offer of [admin, personal])
      for (const example of newModuleExamples(offer, copy)) {
        expect(newModuleDescription(example.story)).toBe(example.story);
        expect(example.story.length).toBeGreaterThan(300);
      }
});

test("the third screen shows the whole brief: the Admin's for the agent, the member's a request to the Admin", () => {
  const description = "Chci přehled reklamací.";
  expect(newModuleScreen("brief", admin, description, cs)).toEqual({
    step: "brief",
    title: "Zadání pro agenta",
    text: "Otevře se v Chatu v novém vlákně, neodeslané. Zkontrolujte ho a odešlete. Agent se doptá na zbytek, ukáže plán a modul založí až po vašem souhlasu.",
    brief:
      "Chci postavit nový modul do Workspace Lazuria.\nBude v Organizaci Example Company (GitHub Example-Org).\n\nMoje představa:\nChci přehled reklamací.\n\nPoužij skill `new-module`. Vyptej se mě jen na to, co z mé představy nevyplývá, technické věci zvol sám a než začneš stavět, ukaž mi plán k potvrzení.",
  });
  expect(newModuleScreen("brief", member, description, cs)).toEqual({
    step: "brief",
    title: "Žádost pro Admina",
    text: "Váš agent z popisu připraví žádost pro Admina Organizace a před odesláním vám ji ukáže.",
    brief:
      "Chci v Organizaci Example Company (GitHub Example-Org) nový modul. Nový modul zakládá Admin, proto mi připrav žádost pro Admina skillem `admin-request`.\n\nMoje představa:\nChci přehled reklamací.\n\nNejdřív se mě doptej na to, co z představy nevyplývá, pak mi žádost ukaž a pošli ji až s mým souhlasem.",
  });
  expect(newModuleBrief(personal, description, cs)).toBe(
    "Chci postavit nový modul do Workspace Lazuria.\nBude v mém osobním prostoru, jako soukromý repozitář na mém GitHub účtu example.\n\nMoje představa:\nChci přehled reklamací.\n\nPoužij skill `new-module`. Vyptej se mě jen na to, co z mé představy nevyplývá, technické věci zvol sám a než začneš stavět, ukaž mi plán k potvrzení.",
  );
  // Without a description the agent starts by asking.
  expect(newModuleBrief(admin, "  \n", cs)).toContain(
    "Nejdřív se mě vyptej, k čemu modul bude",
  );
  expect(newModuleBrief(member, "", cs)).toContain(
    "skillem `admin-request`.\n\nNejdřív se mě vyptej, k čemu modul bude",
  );
  expect(newModuleBrief(member, "", en)).toContain("`admin-request`");
});

test("a description stays word for word: tokens and replacement patterns in it mean nothing", () => {
  const description = "{name} $& $1 {login} {description}";
  const brief = newModuleBrief(admin, description, cs);
  expect(brief).toContain(`Moje představa:\n${description}\n\n`);
  expect(newModuleBrief(member, description, en)).toContain(
    `What I have in mind:\n${description}\n\n`,
  );
});

test("a description: line breaks and tabs stay, other control characters go, nothing and too much are none", () => {
  expect(newModuleDescription("  a\r\nb\tc\u0007\rd  ")).toBe("a\nb\tc\nd");
  for (const value of ["", "  \n ", 1, null, undefined, {}])
    expect(newModuleDescription(value)).toBeNull();
  const longest = "x".repeat(newModuleDescriptionLength);
  expect(newModuleDescription(longest)).toBe(longest);
  expect(newModuleDescription(`${longest}x`)).toBeNull();
});

test("a brief: kept a while for its prompt and login, its id within Chat's grammar, the oldest giving way", () => {
  let now = 1_000;
  let key = 0;
  const briefs = createPromptBriefs(
    () => now,
    () => (key++).toString(16).padStart(32, "0"),
  );
  const id = briefs.keep("new-module-request", "Example-Org", "popis");
  expect(id).toBe(`new-module-request-${"0".repeat(32)}`);
  expect(briefPromptOf(id)).toBe("new-module-request");
  expect(
    chatPromptHref("https://chat.example/", "https://chat.example", {
      id,
      organization: "Example-Org",
    }),
  ).not.toBeNull();
  // Letter case as GitHub ignores it; another login, the same as none.
  expect(briefs.read(id, "example-org")).toBe("popis");
  expect(briefs.read(id, "other")).toBeNull();
  expect(briefs.read(`new-module-${"f".repeat(32)}`, "example-org")).toBeNull();
  now += briefKeptMs - 1;
  expect(briefs.read(id, "example-org")).toBe("popis");
  now += 1;
  expect(briefs.read(id, "example-org")).toBeNull();
  const first = briefs.keep("new-module", "a", "1");
  for (let index = 1; index < briefsKept; index++)
    briefs.keep("new-module", "a", String(index));
  expect(briefs.read(first, "a")).toBe("1");
  briefs.keep("new-module", "a", "last");
  expect(briefs.read(first, "a")).toBeNull();
  // Real keys are random and differ.
  const real = createPromptBriefs();
  expect(real.keep("new-module", "a", "x")).not.toBe(
    real.keep("new-module", "a", "x"),
  );
});

test("a brief's id names one of the three prompts and nothing else", () => {
  const key = "0123456789abcdef0123456789abcdef";
  expect(briefPromptOf(`new-module-${key}`)).toBe("new-module");
  expect(briefPromptOf(`new-personal-module-${key}`)).toBe(
    "new-personal-module",
  );
  for (const id of [
    "new-module",
    `prepare-content-${key}`,
    `new-module-${key.slice(1)}`,
    `new-module-${key}x`,
    `marketplace-${key}`,
  ])
    expect([id, briefPromptOf(id)]).toEqual([id, null]);
  expect(isBriefPrompt("new-module-request")).toBe(true);
  expect(isBriefPrompt("prepare-content")).toBe(false);
});

test("the Launchpad's answer names a brief, anything else none", () => {
  expect(parseBriefAnswer({ kind: "prompt-brief", id: "x" })).toBe("x");
  for (const value of [
    null,
    {},
    { kind: "other", id: "x" },
    { kind: "prompt-brief" },
  ])
    expect(parseBriefAnswer(value)).toBeNull();
});
