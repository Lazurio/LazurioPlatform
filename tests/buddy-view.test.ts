import { expect, test } from "bun:test";
import type { BuddyPersonaShown } from "../src/buddy/persona-save";
import { drawnKey } from "../src/launchpad/buddy-dialog";
import { czechNames, namesFromInput } from "../src/launchpad/buddy-names";
import {
  type BuddyReading,
  type BuddySignInState,
  type BuddyStepFacts,
  buddyFact,
  buddySignInRow,
  buddySignInStep,
  buddyStateView,
  buddyStep,
  clock,
  draftChanged,
  draftOf,
  draftReady,
  introduceScreen,
  looksLikeBotToken,
  meetStart,
  parseBuddyReading,
  parseTelegram,
  personaBody,
  saveLine,
  secondsLeft,
  signInScreen,
  type TelegramReading,
  telegramApproveLine,
  telegramConnectLine,
  telegramFirstStep,
  telegramPairingLine,
  telegramRow,
  telegramScreen,
  telegramStartScreen,
  unknownBuddyReading,
  unknownTelegram,
  withForm,
  withYourName,
} from "../src/launchpad/buddy-view";
import { messages } from "../src/launchpad/messages";
import { codexDevicePage } from "../src/tools/ai";

// Decision F65 in the page (buddy-view.ts): Začínáme's step "Seznamte se s
// Buddym", the three screens of its dialog and Nastavení → Buddy, from
// `GET /api/buddy` and the sign-in the page holds; the prototype's guess of
// the person's name forms (prototypes-lazurio #90, `czechNames`).

const cs = messages("cs");
const en = messages("en");
const at = Date.UTC(2026, 9, 25, 6, 0, 0);
const revision = "a".repeat(64);

const persona = (
  overrides: Partial<BuddyPersonaShown> = {},
): BuddyPersonaShown => ({
  buddyName: "Rex",
  address: "ty",
  user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
  confirmed: false,
  revision,
  pending: false,
  ...overrides,
});

const reading = (overrides: Partial<BuddyReading> = {}): BuddyReading => ({
  state: "waits",
  signIn: "none",
  persona: persona(),
  ...overrides,
});

const works = (confirmed: boolean) =>
  reading({
    state: "works",
    signIn: "connected",
    persona: persona({ confirmed }),
  });

const pending = (expiresAt = at + 14 * 60_000 + 32_000): BuddySignInState => ({
  kind: "pending",
  session: "0123456789abcdef0123456789abcdef",
  code: "ABCD-12EF3",
  url: codexDevicePage,
  expiresAt,
  pollMs: 2000,
});

const facts = (
  read: BuddyReading | null,
  signIn: BuddySignInState = { kind: "idle" },
  now = at,
): BuddyStepFacts => ({ reading: read, signIn, now });

test("the person's name in the forms Buddy writes it, guessed from how they say it (the prototype's cases)", () => {
  const cases: [string, string, string][] = [
    ["Matěj", "Matěje", "Matějovi"],
    ["Petr", "Petra", "Petrovi"],
    ["Pavel", "Pavla", "Pavlovi"],
    ["Marek", "Marka", "Markovi"],
    ["Zdeněk", "Zdeňka", "Zdeňkovi"],
    ["Daniel", "Daniela", "Danielovi"],
    ["Tomáš", "Tomáše", "Tomášovi"],
    ["Jiří", "Jiřího", "Jiřímu"],
    ["Honza", "Honzu", "Honzovi"],
    ["Pablo", "Pabla", "Pablovi"],
    ["Bob", "Boba", "Bobovi"],
    ["Johann", "Johanna", "Johannovi"],
    ["Anna", "Annu", "Anně"],
    ["Vanda", "Vandu", "Vandě"],
    ["Petra", "Petru", "Petře"],
    ["Jitka", "Jitku", "Jitce"],
    ["Tereza", "Terezu", "Tereze"],
    ["Lucie", "Lucii", "Lucii"],
    ["Matěj Suchánek", "Matěje Suchánka", "Matějovi Suchánkovi"],
    ["Anna Nováková", "Annu Novákovou", "Anně Novákové"],
  ];
  for (const [nominative, accusative, dative] of cases)
    expect(czechNames(nominative)).toEqual({ nominative, accusative, dative });
  // Spaces around the name do not reach the forms.
  expect(czechNames("  Matěj ")).toEqual({
    nominative: "Matěj",
    accusative: "Matěje",
    dative: "Matějovi",
  });
  // The field keeps what was typed; English has one form for all three.
  expect(namesFromInput("Matěj ", "cs")).toEqual({
    nominative: "Matěj ",
    accusative: "Matěje",
    dative: "Matějovi",
  });
  expect(namesFromInput(" Bob ", "en")).toEqual({
    nominative: " Bob ",
    accusative: "Bob",
    dative: "Bob",
  });
});

test("GET /api/buddy's answer as the page reads it: his state, his sign-in and his persona, or nothing of another shape", () => {
  const answer = {
    kind: "buddy",
    state: "works",
    signIn: { state: "connected" },
    locale: "cs",
    persona: persona({ confirmed: true }),
  };
  expect(parseBuddyReading(answer)).toEqual({
    state: "works",
    signIn: "connected",
    persona: persona({ confirmed: true }),
  });
  expect(
    parseBuddyReading({
      ...answer,
      state: "unknown",
      reason: "not-running",
      signIn: { state: "unknown" },
      persona: null,
    }),
  ).toEqual({
    state: "unknown",
    reason: "not-running",
    signIn: "unknown",
    persona: null,
  });
  for (const broken of [
    { ...answer, kind: "status" },
    { ...answer, state: "attention" },
    { ...answer, signIn: "connected" },
    { ...answer, persona: { ...persona(), revision: "short" } },
    { ...answer, persona: { ...persona(), address: "oni" } },
    null,
  ])
    expect(parseBuddyReading(broken)).toBeNull();
});

test("a sign-in route's answer: a code only as OpenAI's exact page and a whole code; closed reasons; Hermes's refusals", () => {
  const start = {
    kind: "pending" as const,
    session: "0123456789abcdef0123456789abcdef",
    code: "ABCD-12EF3",
    url: codexDevicePage,
    expiresAt: new Date(at).toISOString(),
    pollMs: 2000,
  };
  expect(buddySignInStep(start)).toEqual({ ...start, expiresAt: at });
  for (const broken of [
    { ...start, url: "https://evil.example/codex/device" },
    { ...start, code: "abcd 1234" },
    { ...start, session: "../x" },
    { ...start, expiresAt: "soon" },
  ])
    expect(buddySignInStep(broken)).toBeNull();
  expect(buddySignInStep({ kind: "failed", reason: "refused" })).toEqual({
    kind: "failed",
    reason: "refused",
  });
  // A reason the page does not know is a plain failure.
  expect(buddySignInStep({ kind: "failed", reason: "teapot" })).toEqual({
    kind: "failed",
    reason: "failed",
  });
  expect(
    buddySignInStep({ kind: "blocked", reason: "hermes-outdated" }),
  ).toEqual({ kind: "blocked", reason: "hermes-outdated" });
  expect(
    buddySignInStep({ error: "buddy-unavailable", reason: "no-socket" }),
  ).toEqual({ kind: "unavailable" });
  expect(buddySignInStep({ kind: "cancelled" })).toEqual({ kind: "none" });
  expect(clock(secondsLeft(at + 14 * 60_000 + 32_000, at))).toBe("14:32");
  expect(clock(65)).toBe("1:05");
  expect(secondsLeft(at - 1, at)).toBe(0);
});

test("Začínáme's step: done only when he is signed in and the person confirmed his names", () => {
  // Nothing read yet: nothing claimed, nothing offered.
  expect(buddyStep(facts(null), cs)).toEqual({
    done: false,
    failed: false,
    parts: [
      {
        id: "sign-in",
        mark: "open",
        title: "Přihlášení k ChatGPT",
        status: "Ověřuji…",
      },
      {
        id: "persona",
        mark: "open",
        title: "Jméno a oslovení",
        status: "Ověřuji…",
      },
    ],
    action: "none",
  });
  // A new Buddy: not signed in, names as the installer collected them.
  expect(buddyStep(facts(reading()), cs)).toEqual({
    done: false,
    failed: false,
    parts: [
      {
        id: "sign-in",
        mark: "open",
        title: "Přihlášení k ChatGPT",
        status: "Nepřipojeno",
      },
      {
        id: "persona",
        mark: "open",
        title: "Jméno a oslovení",
        status: "Zatím ne",
      },
    ],
    action: "sign-in",
  });
  // Confirmed names but no sign-in: still not done.
  expect(
    buddyStep(facts(reading({ persona: persona({ confirmed: true }) })), cs),
  ).toMatchObject({ done: false, action: "sign-in" });
  // Signed in, names not confirmed: his introduction next.
  const signedIn = buddyStep(facts(works(false)), cs);
  expect(signedIn).toMatchObject({ done: false, action: "introduce" });
  expect(signedIn.parts[0]).toMatchObject({
    mark: "done",
    status: "Připojeno",
  });
  // Both: done, and "Upravit" leads to Nastavení → Buddy.
  const done = buddyStep(facts(works(true)), cs);
  expect(done).toMatchObject({ done: true, failed: false, action: "edit" });
  expect(done.parts[1]).toEqual({
    id: "persona",
    mark: "done",
    title: "Jméno a oslovení",
    status: "Rex, tyká vám",
  });
  expect(
    buddyStep(
      facts(
        reading({
          signIn: "connected",
          persona: persona({ confirmed: true, address: "vy" }),
        }),
      ),
      cs,
    ).parts[1]?.status,
  ).toBe("Rex, vyká vám");
  // English says no ty or vy.
  expect(buddyStep(facts(works(true)), en).parts[1]?.status).toBe("Rex");
  // Signed in on this page before the reading followed counts as signed in.
  expect(buddyStep(facts(reading(), { kind: "signed-in" }), cs)).toMatchObject({
    action: "introduce",
  });
  // Signing in again keeps the step done meanwhile.
  expect(buddyStep(facts(works(true), pending()), cs)).toMatchObject({
    done: true,
    action: "edit",
  });
});

test("the step while a code is on its way, and each way it can stop, in one plain line", () => {
  const waiting = buddyStep(facts(reading(), pending()), cs);
  expect(waiting.action).toBe("resume");
  expect(waiting.parts[0]).toEqual({
    id: "sign-in",
    mark: "open",
    title: "Přihlášení k ChatGPT",
    status: "Čeká na přihlášení, kód platí ještě 14:32",
    countdown: {
      template: "Čeká na přihlášení, kód platí ještě {left}",
      expiresAt: at + 14 * 60_000 + 32_000,
    },
    busy: true,
  });
  // Past its time: expired at once, "Nový kód".
  const expired = buddyStep(facts(reading(), pending(at - 1)), cs);
  expect(expired).toMatchObject({ failed: true, action: "new-code" });
  expect(expired.parts[0]).toMatchObject({
    mark: "warn",
    status: "Kód vypršel.",
  });
  const failed = (
    reason: Extract<BuddySignInState, { kind: "failed" }>["reason"],
  ) => buddyStep(facts(reading(), { kind: "failed", reason }), cs);
  expect(failed("expired").parts[0]?.status).toBe("Kód vypršel.");
  expect(failed("expired").action).toBe("new-code");
  // A sign-in by code the account does not allow: one line and a "?".
  expect(failed("refused").parts[0]).toEqual({
    id: "sign-in",
    mark: "warn",
    title: "Přihlášení k ChatGPT",
    status: "ChatGPT přihlášení kódem nepřijal.",
    help: "Účet ChatGPT musí mít přihlášení kódem zapnuté v nastavení zabezpečení ChatGPT. U pracovního účtu ho povoluje jeho správce. Pak si vyžádejte nový kód.",
  });
  expect(failed("refused").action).toBe("new-code");
  // A Hermes without the cancellation contract: an update first, no code.
  expect(failed("hermes-outdated").parts[0]?.status).toBe(
    "Buddy potřebuje aktualizaci, než se tu dá přihlásit.",
  );
  expect(failed("hermes-outdated").action).toBe("none");
  expect(failed("lost").parts[0]?.status).toBe("Tento kód už neplatí.");
  expect(failed("lost").action).toBe("new-code");
  expect(failed("sign-in-running").parts[0]?.status).toBe(
    "Přihlášení ještě běží. Zkuste to za chvíli znovu.",
  );
  expect(failed("sign-in-running").action).toBe("sign-in");
  expect(failed("unavailable").parts[0]?.status).toBe("Buddy teď neběží.");
  expect(failed("no-answer").parts[0]?.status).toBe(
    "Lazurio na přihlášení neodpovědělo.",
  );
  // His gateway does not run: no sign-in can start; a read that failed
  // claims nothing.
  const down = buddyStep(
    facts(
      reading({ state: "unknown", reason: "not-running", signIn: "unknown" }),
    ),
    cs,
  );
  expect(down).toMatchObject({ failed: true, action: "none" });
  expect(down.parts[0]?.status).toBe("Buddy teď neběží.");
  const unread = buddyStep(
    facts(reading({ state: "unknown", signIn: "unknown" })),
    cs,
  );
  expect(unread).toMatchObject({ failed: false, action: "none" });
  expect(unread.parts[0]?.status).toBe(
    "Nepodařilo se ověřit, jestli je Buddy přihlášený.",
  );
});

test("the dialog's first screen: the start, the code with its time, expired, Připojeno, a stop", () => {
  expect(meetStart(facts(reading()))).toBe("sign-in");
  expect(meetStart(facts(works(false)))).toBe("introduce");
  expect(meetStart(facts(works(true), pending()))).toBe("sign-in");
  expect(signInScreen(facts(null), cs)).toEqual({ kind: "checking" });
  expect(signInScreen(facts(reading()), cs)).toEqual({ kind: "start" });
  expect(signInScreen(facts(reading(), { kind: "starting" }), cs)).toEqual({
    kind: "starting",
  });
  expect(signInScreen(facts(reading(), pending()), cs)).toEqual({
    kind: "code",
    code: "ABCD-12EF3",
    url: codexDevicePage,
    holds: {
      template: "Kód platí ještě {left}.",
      expiresAt: at + 14 * 60_000 + 32_000,
    },
  });
  expect(signInScreen(facts(reading(), pending(at)), cs)).toEqual({
    kind: "expired",
  });
  expect(signInScreen(facts(works(false)), cs)).toEqual({
    kind: "connected",
  });
  expect(
    signInScreen(facts(reading(), { kind: "failed", reason: "refused" }), cs),
  ).toMatchObject({ kind: "failed", retry: true, help: expect.any(String) });
  expect(
    signInScreen(
      facts(reading(), { kind: "failed", reason: "hermes-outdated" }),
      cs,
    ),
  ).toEqual({
    kind: "failed",
    line: "Buddy potřebuje aktualizaci, než se tu dá přihlásit.",
    retry: false,
  });
  expect(
    signInScreen(
      facts(
        reading({ state: "unknown", reason: "not-running", signIn: "unknown" }),
      ),
      cs,
    ),
  ).toEqual({ kind: "failed", line: "Buddy teď neběží.", retry: false });
});

test("Buddy introduces himself in his own words: ty or vy at once, the person's name as he writes it, one form in English", () => {
  const vy = draftOf(persona({ address: "vy" }));
  expect(introduceScreen(vy, "cs", cs)).toEqual({
    hello: "Ahoj, já jsem Rex.",
    intro:
      "Hlídám, co běží, zařídím, co potřebujete, a pamatuju si, na čem jsme se domluvili. Stačí mi napsat.",
    askName: "Jak mi budete říkat?",
    askAddress: "Mám vám vykat, nebo tykat?",
    answers: { vy: "Vykej mi", ty: "Tykej mi" },
    askYou: "Jak vám mám říkat?",
    forms: "Takhle o vás budu psát:",
    traces: ["Buddy za Boba", "Výsledek pošli Bobovi"],
    fixable: true,
    ready: true,
  });
  // "Tykej mi": every line of his changes with it.
  const ty = introduceScreen({ ...vy, address: "ty" }, "cs", cs);
  expect([ty.intro, ty.askName, ty.askAddress, ty.askYou, ty.forms]).toEqual([
    "Hlídám, co běží, zařídím, co potřebuješ, a pamatuju si, na čem jsme se domluvili. Stačí mi napsat.",
    "Jak mi budeš říkat?",
    "Mám ti tykat, nebo vykat?",
    "Jak ti mám říkat?",
    "Takhle o tobě budu psát:",
  ]);
  // A blank name is still Buddy in his greeting, and cannot be sent.
  const blank = { ...vy, buddyName: "  " };
  expect(introduceScreen(blank, "cs", cs)).toMatchObject({
    hello: "Ahoj, já jsem Buddy.",
    ready: false,
  });
  // English: no ty or vy, one form.
  const english = introduceScreen(
    withYourName(draftOf(null), "Bob", "en"),
    "en",
    en,
  );
  expect(english).toMatchObject({
    hello: "Hi, I'm Buddy.",
    askAddress: null,
    traces: ["Buddy for Bob"],
    fixable: false,
    ready: true,
  });
  // The third screen, in his address; once his bot is connected, that it
  // is (decision F66).
  expect(telegramScreen(persona({ address: "vy" }), cs)).toEqual({
    ask: "Chcete mi psát i na Telegramu?",
    here: "Psát mi můžete vždycky i tady v Lazuriu, vpravo dole.",
    connected: null,
  });
  expect(telegramScreen(persona({ address: "ty" }), cs)).toEqual({
    ask: "Chceš mi psát i na Telegramu?",
    here: "Psát mi můžeš vždycky i tady v Lazuriu, vpravo dole.",
    connected: null,
  });
  expect(
    telegramScreen(persona({ address: "ty" }), cs, {
      state: "connected",
      bot: "rex_buddy_bot",
      requests: [],
      pending: false,
    }).connected,
  ).toBe("Připojeno: @rex_buddy_bot");
  // What his bot answers an account it does not know yet: his name and
  // address, no code, no command (F66 point 12).
  expect(telegramPairingLine({ buddyName: " Rex ", address: "vy" }, cs)).toBe(
    "Dobrý den, tady Rex. Potvrďte prosím v Lazuriu, že jste to vy, a pak mi napište znovu.",
  );
  expect(telegramPairingLine({ buddyName: "Rex", address: "ty" }, cs)).toBe(
    "Ahoj, tady Rex. Potvrď prosím v Lazuriu, že jsi to ty, a pak mi napiš znovu.",
  );
  expect(telegramPairingLine({ buddyName: "  ", address: "ty" }, en)).toBe(
    "Hi, this is Buddy. Please confirm in Lazurio that it's you, then write to me again.",
  );
});

test("the draft of the names: guessed as the person types, corrected by hand with Opravit, sent with the revision read", () => {
  expect(draftOf(null)).toEqual({
    buddyName: "Buddy",
    address: "vy",
    user: { nominative: "", accusative: "", dative: "" },
  });
  expect(draftReady(draftOf(null))).toBe(false);
  const typed = withYourName(draftOf(null), "Anna", "cs");
  expect(typed.user).toEqual({
    nominative: "Anna",
    accusative: "Annu",
    dative: "Anně",
  });
  const fixed = withForm(typed, "dative", "Aně");
  expect(fixed.user.dative).toBe("Aně");
  expect(draftReady(fixed)).toBe(true);
  // Without a persona every draft is a change; with one, only another value.
  expect(draftChanged(typed, null)).toBe(true);
  const read = persona();
  expect(draftChanged(draftOf(read), read)).toBe(false);
  expect(draftChanged({ ...draftOf(read), buddyName: " Rex " }, read)).toBe(
    false,
  );
  expect(draftChanged({ ...draftOf(read), address: "vy" }, read)).toBe(true);
  expect(personaBody(fixed, null, true, "cs")).toEqual({
    buddyName: "Buddy",
    address: "vy",
    user: { nominative: "Anna", accusative: "Annu", dative: "Aně" },
    revision: null,
    confirm: true,
  });
  // English: the one form in all three; no confirm from Settings.
  expect(
    personaBody(
      { ...draftOf(read), user: { ...read.user, nominative: " Bob " } },
      revision,
      false,
      "en",
    ),
  ).toEqual({
    buddyName: "Rex",
    address: "ty",
    user: { nominative: "Bob", accusative: "Bob", dative: "Bob" },
    revision,
  });
  expect(saveLine({ kind: "saved", pending: true }, cs)).toBe(
    "Projeví se, až Buddy dokončí, co právě dělá.",
  );
  expect(saveLine({ kind: "saved", pending: false }, cs)).toBe("Uloženo.");
  expect(saveLine({ kind: "invalid", field: "buddy-name" }, cs)).toBe(
    "Toto jméno nejde použít. Zkuste ho napsat jinak.",
  );
  expect(saveLine({ kind: "invalid", field: "user" }, cs)).toBe(
    "Takhle vaše jméno nejde použít. Zkuste ho napsat jinak.",
  );
  expect(saveLine({ kind: "changed" }, cs)).toBe(
    "Mezitím se tu něco změnilo. Zkontrolujte to a uložte znovu.",
  );
  expect(saveLine({ kind: "failed" }, cs)).toBe(
    "Uložit se nepovedlo. Zkuste to znovu.",
  );
});

test("Nastavení → Buddy, Stav: Pracuje, Čeká na přihlášení or Buddy teď neběží; the sign-in's controls by its state", () => {
  expect(buddyStateView(null, cs)).toEqual({ tone: "off", word: "Ověřuji…" });
  expect(buddyStateView(works(true), cs)).toEqual({
    tone: "ok",
    word: "Pracuje",
  });
  expect(buddyStateView(reading(), cs)).toEqual({
    tone: "off",
    word: "Čeká na přihlášení",
  });
  expect(
    buddyStateView(
      reading({ state: "unknown", reason: "not-running", signIn: "unknown" }),
      cs,
    ),
  ).toEqual({ tone: "warn", word: "Buddy teď neběží" });
  expect(
    buddyStateView(reading({ state: "unknown", signIn: "unknown" }), cs),
  ).toEqual({ tone: "off", word: "Nepodařilo se ověřit" });
  // Signed in: ⋯ with Přihlásit znovu and Odhlásit.
  expect(buddySignInRow(facts(works(true)), cs)).toEqual({
    part: {
      id: "sign-in",
      mark: "done",
      title: "Přihlášení k ChatGPT",
      status: "Připojeno",
    },
    controls: "menu",
  });
  expect(buddySignInRow(facts(reading()), cs).controls).toBe("sign-in");
  expect(buddySignInRow(facts(reading(), pending()), cs).controls).toBe(
    "resume",
  );
  // Signing in again from the menu: the code, Zrušit and Pokračovat.
  expect(buddySignInRow(facts(works(true), pending()), cs).controls).toBe(
    "resume",
  );
  expect(buddySignInRow(facts(reading(), pending(at)), cs).controls).toBe(
    "new-code",
  );
  expect(
    buddySignInRow(
      facts(
        reading({ state: "unknown", reason: "not-running", signIn: "unknown" }),
      ),
      cs,
    ).controls,
  ).toBe("none");
  expect(
    buddySignInRow(facts(reading(), { kind: "starting" }), cs).controls,
  ).toBe("none");
});

test("the first run's fact of Buddy: loading until read; a reading that failed claims nothing of his names", () => {
  expect(buddyFact(null)).toBe("loading");
  expect(buddyFact(works(true))).toEqual({
    signIn: "connected",
    confirmed: true,
  });
  // A persona the installer would not take, read: known not confirmed.
  expect(buddyFact(reading({ persona: null }))).toEqual({
    signIn: "none",
    confirmed: false,
  });
  expect(buddyFact(unknownBuddyReading)).toEqual({
    signIn: "unknown",
    confirmed: null,
  });
});

test("what is drawn again: a code's countdown ticks in place, any other change of a status draws", () => {
  const waiting = (now: number) =>
    drawnKey(buddyStep(facts(reading(), pending(), now), cs));
  expect(waiting(at)).toBe(waiting(at + 5000));
  expect(waiting(at)).not.toBe(
    drawnKey(buddyStep(facts(reading(), pending(at - 1), at), cs)),
  );
  expect(drawnKey(buddyStep(facts(reading()), cs))).not.toBe(
    drawnKey(buddyStep(facts(works(false)), cs)),
  );
});

// ---- Telegram (decision F66) ------------------------------------------------

const telegram = (
  overrides: Partial<TelegramReading> = {},
): TelegramReading => ({
  state: "none",
  requests: [],
  pending: false,
  ...overrides,
});

test("Telegram of an answer: only its states, a bot's name, the page's handles; any other shape claims nothing", () => {
  expect(
    parseTelegram({
      state: "waiting",
      bot: "rex_buddy_bot",
      botQr: "<svg/>",
      requests: [
        { request: "a".repeat(32), name: "jana_s" },
        { request: "0123456789abcdef", name: "hermes id" },
        { request: "b".repeat(32), name: "x".repeat(65) },
      ],
    }),
  ).toEqual({
    state: "waiting",
    bot: "rex_buddy_bot",
    botQr: "<svg/>",
    requests: [{ request: "a".repeat(32), name: "jana_s" }],
    pending: false,
  });
  expect(parseTelegram({ state: "failed", reason: "odd" })).toEqual({
    state: "failed",
    reason: "failed",
    requests: [],
    pending: false,
  });
  expect(parseTelegram({ state: "connected", bot: "@nope" })).toEqual({
    state: "connected",
    requests: [],
    pending: false,
  });
  for (const value of [null, {}, { state: "linked" }, []])
    expect(parseTelegram(value)).toEqual(unknownTelegram);
  // A reading names it where the Launchpad says it.
  expect(
    parseBuddyReading({
      kind: "buddy",
      state: "works",
      signIn: { state: "connected" },
      persona: null,
      telegram: { state: "none", pending: true },
    })?.telegram,
  ).toEqual({ state: "none", requests: [], pending: true });
});

test("Nastavení → Buddy → Kanály: one state in Lazurio's words and one action; Telegram's waits are never an error", () => {
  expect(telegramRow(telegram(), cs)).toEqual({
    tone: "off",
    line: "Nepřipojeno",
    busy: false,
    action: "connect",
  });
  expect(telegramRow(telegram({ pending: true }), cs)).toEqual({
    tone: "off",
    line: "Nepřipojeno",
    busy: false,
    quiet: "Odpojí se, až Buddy dokončí, co právě dělá.",
    action: "connect",
  });
  expect(
    telegramRow(telegram({ state: "starting", pending: true }), cs),
  ).toEqual({
    tone: "off",
    line: "Připojuje se…",
    busy: true,
    quiet: "Projeví se, až Buddy dokončí, co právě dělá.",
    action: "continue",
  });
  expect(telegramRow(telegram({ state: "waiting" }), cs)).toMatchObject({
    line: "Čeká na vaši zprávu",
    action: "continue",
  });
  expect(
    telegramRow(telegram({ state: "connected", bot: "rex_buddy_bot" }), cs),
  ).toEqual({
    tone: "ok",
    line: "Připojeno: @rex_buddy_bot",
    busy: false,
    action: "disconnect",
  });
  expect(telegramRow(telegram({ state: "connected" }), cs).line).toBe(
    "Připojeno",
  );
  for (const [reason, line] of [
    ["refused", cs.telegramRefusedBot],
    ["conflict", cs.telegramConflict],
    ["failed", cs.telegramFailed],
  ] as const)
    expect(telegramRow(telegram({ state: "failed", reason }), cs)).toEqual({
      tone: "warn",
      line,
      busy: false,
      action: "connect",
    });
  expect(telegramRow(undefined, cs)).toEqual({
    tone: "off",
    line: "Nepodařilo se ověřit",
    busy: false,
    action: "none",
  });
});

test("Připojit Telegram: where it opens, the token's shape, the last step from the reading, and one line per refusal", () => {
  expect(telegramFirstStep(undefined)).toBe("botfather");
  expect(telegramFirstStep(telegram({ state: "starting" }))).toBe("start");
  expect(telegramFirstStep(telegram({ state: "waiting" }))).toBe("start");
  expect(telegramFirstStep(telegram({ state: "failed" }))).toBe("botfather");
  const token = `${"7".repeat(10)}:AAH${"x".repeat(32)}`;
  expect(looksLikeBotToken(` ${token} `)).toBe(true);
  for (const text of ["", "123", "abc:".concat("x".repeat(40)), `${token} x`])
    expect(looksLikeBotToken(text)).toBe(false);
  expect(
    telegramStartScreen(
      telegram({ state: "starting", bot: "rex_buddy_bot", botQr: "<svg/>" }),
      cs,
    ),
  ).toEqual({
    kind: "starting",
    quiet: null,
    bot: "rex_buddy_bot",
    botQr: "<svg/>",
  });
  expect(
    telegramStartScreen(
      telegram({
        state: "waiting",
        requests: [
          { request: "a".repeat(32), name: "jana_s" },
          { request: "b".repeat(32), name: "" },
        ],
      }),
      cs,
    ),
  ).toEqual({
    kind: "waiting",
    bot: null,
    botQr: null,
    asks: [
      { request: "a".repeat(32), line: "Je to váš účet „jana_s“?" },
      { request: "b".repeat(32), line: "Je to váš účet?" },
    ],
    many: true,
  });
  expect(
    telegramStartScreen(
      telegram({ state: "connected", bot: "rex_buddy_bot" }),
      cs,
    ),
  ).toEqual({ kind: "connected", line: "Připojeno: @rex_buddy_bot" });
  expect(
    telegramStartScreen(telegram({ state: "failed", reason: "conflict" }), cs),
  ).toEqual({ kind: "failed", line: cs.telegramConflict, again: "botfather" });
  expect(
    telegramStartScreen(telegram({ state: "failed", reason: "refused" }), cs),
  ).toMatchObject({ again: "token" });
  expect(telegramConnectLine({ kind: "saved" }, cs)).toBeNull();
  expect(telegramConnectLine({ kind: "invalid" }, cs)).toBe(
    cs.telegramTokenShape,
  );
  expect(telegramConnectLine({ kind: "refused" }, cs)).toBe(
    cs.telegramTokenRefused,
  );
  expect(telegramConnectLine({ kind: "unreachable" }, cs)).toBe(
    cs.telegramUnreachable,
  );
  expect(telegramConnectLine({ kind: "unavailable" }, cs)).toBe(
    cs.buddyNotRunning,
  );
  expect(telegramApproveLine({ kind: "gone" }, cs)).toBe(
    cs.telegramApproveGone,
  );
});

test("the step's Telegram part: optional, its state once Hermes said it, never deciding whether the step is done", () => {
  const facts = (value?: TelegramReading): BuddyStepFacts => ({
    reading: reading({
      signIn: "connected",
      persona: persona({ confirmed: true }),
      ...(value === undefined ? {} : { telegram: value }),
    }),
    signIn: { kind: "idle" },
    now: at,
  });
  expect(buddyStep(facts(), cs).parts.map((part) => part.id)).toEqual([
    "sign-in",
    "persona",
  ]);
  expect(buddyStep(facts(unknownTelegram), cs).parts).toHaveLength(2);
  const none = buddyStep(facts(telegram()), cs);
  expect(none.done).toBe(true);
  expect(none.parts[2]).toEqual({
    id: "telegram",
    mark: "open",
    title: "Telegram (volitelné)",
    status: "Nepřipojeno",
  });
  expect(
    buddyStep(facts(telegram({ state: "connected", bot: "rex_buddy_bot" })), cs)
      .parts[2],
  ).toMatchObject({ mark: "done", status: "Připojeno: @rex_buddy_bot" });
  const failed = buddyStep(facts(telegram({ state: "failed" })), cs);
  expect(failed.parts[2]?.mark).toBe("warn");
  expect(failed.failed).toBe(false);
  expect(failed.done).toBe(true);
});
