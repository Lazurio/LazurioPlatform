import { expect, test } from "bun:test";
import { type MessageKey, messages } from "../src/launchpad/messages";

// The words of Buddy in Začínáme and Nastavení → Buddy (decision F65; root
// AGENTS.md "Názvy a texty pro uživatele", root decisions 0199 and 0201):
// Lazurio's own lines say vy; the lines Buddy says himself follow how he
// addresses the person, a Ty and a Vy one for each; no line names a code
// name, a command, a model or a reason; nobody is a "pomocník".

const cs = messages("cs");
const en = messages("en");
const keys = Object.keys(cs) as MessageKey[];

/** Every text this change adds. */
const added = keys.filter(
  (key) =>
    key.startsWith("buddy") ||
    [
      "setupBuddy",
      "setupBuddyAction",
      "tourGearBuddyTitle",
      "tourBuddyTitle",
      "tourBuddyText",
      "guideStartBuddy",
      "guideStartAiAgents",
      "guideBuddyState",
      "guideBuddyPersona",
      "startAiAfterBuddy",
    ].includes(key),
);

/** The lines Buddy says himself, in pairs by his address: his first
 * meeting's beats (decision F60's addendum of 2026-10-26) among them. */
const buddyLines = [
  "buddyHello",
  "buddyHelloNamed",
  "buddyHere",
  "buddyDoes",
  "buddyDoesFind",
  "buddyMemory",
  "buddyWhere",
  "buddyWhereTelegram",
  "buddyAskName",
  "buddyAskAddress",
  "buddyAskYou",
  "buddyForms",
  "buddyTelegramAsk",
  "buddyTelegramHere",
] as const;
const said = new Set<string>(
  buddyLines.flatMap((line) => [`${line}Ty`, `${line}Vy`]),
);
/** Buddy's greeting, the person's answers to him ("Vykej mi", "Tykej mi")
 * and how he writes the person's name (his trace, his line to a bot): his
 * or the person's words, in no address of Lazurio's. */
const notLazurio = new Set<string>([
  ...said,
  // His own words in the beats' drawings, in no address.
  "buddyDoesTrip",
  "buddyDoesMail",
  "buddyDoesSum",
  "buddyBots",
  "buddyBotFlights",
  "buddyBotContract",
  "buddyMemoryInvoices",
  "buddyMemoryShort",
  "buddyMemoryMornings",
  "buddyMemoryHoliday",
  "buddyAnswerVy",
  "buddyAnswerTy",
  "buddyTraceFor",
  "buddyTraceSend",
]);

const words = (text: string) =>
  text
    .toLocaleLowerCase("cs")
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
/** Czech informal address: its pronouns and the verbs' second person
 * singular that these texts could use. */
const tyWords = new Set([
  "ty",
  "ti",
  "tě",
  "tebe",
  "tobě",
  "tebou",
  "tvůj",
  "tvoje",
  "tvá",
  "tvé",
  "tvého",
  "budeš",
  "potřebuješ",
  "chceš",
  "můžeš",
  "máš",
  "zkus",
  "otevři",
  "zadej",
  "přihlas",
  "napiš",
  "najdeš",
  "hledáš",
]);
const vyWords = new Set([
  "vy",
  "vám",
  "vás",
  "váš",
  "vaše",
  "vaším",
  "budete",
  "potřebujete",
  "chcete",
  "můžete",
  "máte",
  "najdete",
  "hledáte",
]);
const has = (text: string, set: ReadonlySet<string>) =>
  words(text).some((word) => set.has(word));

test("Lazurio's own lines say vy, never ty", () => {
  const lazurio = added.filter((key) => !notLazurio.has(key));
  expect(lazurio.length).toBeGreaterThan(60);
  for (const key of lazurio)
    expect({ key, ty: has(cs[key], tyWords) }).toEqual({ key, ty: false });
  // Where they speak to the person, they say vy.
  for (const key of [
    "buddyEnterCode",
    "buddyOpenPage",
    "buddySignOutText",
    "buddyRunning",
    "buddySaveChanged",
    "tourBuddyText",
    "setupBuddy",
  ] as const)
    expect({ key, text: cs[key] }).toEqual({
      key,
      text: expect.stringMatching(/te\b|te[,.]|vám|vás|váš/),
    });
});

test("Buddy's own lines follow his address: each Ty line says ty, each Vy line says vy; English has one", () => {
  for (const line of buddyLines) {
    const ty = cs[`${line}Ty`];
    const vy = cs[`${line}Vy`];
    expect({ line, differ: ty !== vy }).toEqual({ line, differ: true });
    expect({ line, ty: has(ty, tyWords), vy: has(ty, vyWords) }).toEqual({
      line,
      ty: true,
      vy: false,
    });
    expect({ line, ty: has(vy, tyWords), vy: has(vy, vyWords) }).toEqual({
      line,
      ty: false,
      vy: true,
    });
    expect(en[`${line}Ty`]).toBe(en[`${line}Vy`]);
  }
});

test("no line names a code name, a command, a model or a reason; nobody is a pomocník", () => {
  const developer =
    /hermes|gateway|token|oauth|codex|\bapi\b|device|session|persona|soul\b|systemd|systemctl|json|revision|\bacp\b|\bt3\b|lazurio buddy|--|gpt-|\bluna\b|\bsol\b|\bmodel/i;
  const reasons = [
    "hermes-outdated",
    "sign-in-running",
    "buddy-absent",
    "buddy-unavailable",
    "persona-changed",
    "not-running",
    "invalid-",
    "prompts-incomplete",
  ];
  for (const copy of [cs, en])
    for (const key of added) {
      const text = copy[key];
      expect({ key, text, developer: developer.test(text) }).toEqual({
        key,
        text,
        developer: false,
      });
      for (const reason of reasons) expect(text).not.toContain(reason);
      expect(text).not.toMatch(/pomocn|helper/i);
    }
});

test("the dialog's and the step's words are the wireframe's, adapted only where the rules ask", () => {
  expect([
    cs.buddyStepTitle,
    cs.buddySignIn,
    cs.buddySay,
    cs.buddyOpenPage,
    cs.buddyOpenButton,
    cs.buddyEnterCode,
    cs.buddyCopy,
    cs.buddyWaiting,
    cs.buddyCodeExpired,
    cs.buddyNewCode,
    cs.buddyOwn,
    cs.buddyLater,
    cs.buddyPartSignIn,
    cs.buddyPartPersona,
    cs.buddyNotYet,
    cs.buddyWorks,
    cs.buddyWaits,
    cs.buddySignInAgain,
    cs.buddySignOut,
  ]).toEqual([
    "Seznamte se s Buddym",
    "Přihlásit Buddyho",
    "Buddy se přihlásí vlastním účtem ChatGPT.",
    "Otevřete stránku ChatGPT",
    "Otevřít ChatGPT",
    "Přihlaste se a zadejte kód",
    "Kopírovat",
    "Čekám na přihlášení…",
    "Kód vypršel.",
    "Nový kód",
    "Toto přihlášení patří jen Buddymu. Agenti se přihlašují zvlášť.",
    "Teď ne",
    "Přihlášení k ChatGPT",
    "Jméno a oslovení",
    "Zatím ne",
    "Pracuje",
    "Čeká na přihlášení",
    "Přihlásit znovu",
    "Odhlásit",
  ]);
  // The closed reasons of the sign-in, each one plain line (the task's).
  expect(cs.buddyOutdated).toBe(
    "Buddy potřebuje aktualizaci, než se tu dá přihlásit.",
  );
  expect(cs.buddyPending).toBe("Projeví se, až Buddy dokončí, co právě dělá.");
  expect(cs.buddyStateNotRunning).toBe("Buddy teď neběží");
});
