import type { BuddyPersonaShown } from "../buddy/persona-save";
import { keepTogether } from "../shell/messages";
import { codexDeviceCode, codexDevicePage } from "../tools/ai";
import { namesFromInput, type PersonNames } from "./buddy-names";
import type { BuddyFact } from "./first-run";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Buddy in the Launchpad's page (decisions F65 and F66; the wireframe of
// prototypes-lazurio #90): what Začínáme's step "Seznamte se s Buddym", its
// dialog, "Připojit Telegram" and Nastavení → Buddy say, from
// `GET /api/buddy` and the sign-in this page holds. Lazurio's own lines say vy (root decision 0199); the
// lines Buddy says himself in the dialog (his introduction, his questions,
// the Telegram screen) follow how he addresses the person, and change at
// once with "Tykej mi". No line names a model, Hermes, a code name or a
// reason code. Pure: the DOM is start-panel.ts, buddy-dialog.ts and
// buddy-panel.ts.
//
// His first meeting (decision F60's addendum of 2026-10-26; the prototype of
// prototypes-lazurio #92, approved by the Admin): the introduction is five short
// beats in his own words, each with one small drawing (who he is, what he
// takes care of, his bots, his memory, where he is), then his questions in
// the order people introduce themselves: his name, the person's name and
// how he writes it, then ty or vy, which nobody chooses for the person.
// Until they choose he says vy, as Lazurio does.

/** His default name, as the installer names a Buddy nobody named. */
export const defaultBuddyName = "Buddy";

/** His Telegram as `GET /api/buddy` says it (decision F66): Hermes's state
 * of his own bot, its username where the Launchpad saw it, its address as a
 * code to scan while the person still opens it, who asked to talk to it while
 * it waits, and whether a change waits for Buddy to be idle. */
export type TelegramReading = Readonly<{
  state: "none" | "starting" | "waiting" | "connected" | "failed" | "unknown";
  reason?: "refused" | "conflict" | "failed";
  bot?: string;
  botQr?: string;
  requests: readonly Readonly<{ request: string; name: string }>[];
  pending: boolean;
}>;

/** What `GET /api/buddy` answers, as the page reads it. */
export type BuddyReading = Readonly<{
  state: "works" | "waits" | "unknown";
  reason?: "not-running";
  signIn: "connected" | "none" | "unknown";
  persona: BuddyPersonaShown | null;
  /** Absent where the Launchpad does not say. */
  telegram?: TelegramReading;
}>;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const revisionShape = /^[0-9a-f]{64}$/;

/** A persona of an answer, or null for none or any other shape. */
export function parsePersona(value: unknown): BuddyPersonaShown | null {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const { buddyName, address, confirmed, revision, pending } = value;
  const { nominative, accusative, dative } = value.user;
  if (
    typeof buddyName !== "string" ||
    (address !== "ty" && address !== "vy") ||
    typeof nominative !== "string" ||
    typeof accusative !== "string" ||
    typeof dative !== "string" ||
    typeof confirmed !== "boolean" ||
    typeof revision !== "string" ||
    !revisionShape.test(revision) ||
    typeof pending !== "boolean"
  )
    return null;
  return {
    buddyName,
    address,
    user: { nominative, accusative, dative },
    confirmed,
    revision,
    pending,
  };
}

/** Telegram that could not be read: no claim either way. */
export const unknownTelegram: TelegramReading = Object.freeze({
  state: "unknown",
  requests: Object.freeze([]),
  pending: false,
});

const telegramStates = new Set([
  "none",
  "starting",
  "waiting",
  "connected",
  "failed",
  "unknown",
]);
const botShape = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const requestShape = /^[0-9a-f]{32}$/;

/** Telegram of an answer; any other shape is no claim. A request is taken
 * only with the page's handle of it and a name of at most 64 characters. */
export function parseTelegram(value: unknown): TelegramReading {
  if (!isRecord(value)) return unknownTelegram;
  const { state, reason, bot, botQr, requests, pending } = value;
  if (typeof state !== "string" || !telegramStates.has(state))
    return unknownTelegram;
  const asked = Array.isArray(requests)
    ? requests.flatMap((entry) =>
        isRecord(entry) &&
        typeof entry.request === "string" &&
        requestShape.test(entry.request) &&
        typeof entry.name === "string" &&
        [...entry.name].length <= 64
          ? [Object.freeze({ request: entry.request, name: entry.name })]
          : [],
      )
    : [];
  return Object.freeze({
    state: state as TelegramReading["state"],
    ...(state === "failed"
      ? {
          reason:
            reason === "refused" || reason === "conflict" ? reason : "failed",
        }
      : {}),
    ...(typeof bot === "string" && botShape.test(bot) ? { bot } : {}),
    ...(typeof botQr === "string" ? { botQr } : {}),
    requests: Object.freeze(asked),
    pending: pending === true,
  });
}

/** `GET /api/buddy`'s answer, or null for any other shape. */
export function parseBuddyReading(value: unknown): BuddyReading | null {
  if (!isRecord(value) || value.kind !== "buddy" || !isRecord(value.signIn))
    return null;
  const { state, reason } = value;
  const signIn = value.signIn.state;
  if (
    (state !== "works" && state !== "waits" && state !== "unknown") ||
    (signIn !== "connected" && signIn !== "none" && signIn !== "unknown") ||
    !(reason === undefined || reason === "not-running")
  )
    return null;
  const persona = value.persona === null ? null : parsePersona(value.persona);
  if (value.persona !== null && persona === null) return null;
  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    signIn,
    persona,
    ...(value.telegram === undefined
      ? {}
      : { telegram: parseTelegram(value.telegram) }),
  };
}

/** A reading that could not be made: no claim either way. */
export const unknownBuddyReading: BuddyReading = Object.freeze({
  state: "unknown",
  signIn: "unknown",
  persona: null,
});

/** The first run's fact of Buddy (first-run.ts): `loading` until read; a
 * reading that failed claims nothing of his names, as an AI that could not
 * be read is never claimed missing. */
export function buddyFact(reading: BuddyReading | null): BuddyFact {
  if (reading === null) return "loading";
  return {
    signIn: reading.signIn,
    confirmed:
      reading.persona?.confirmed ??
      (reading === unknownBuddyReading ? null : false),
  };
}

// ---- The sign-in this page holds ------------------------------------------

/** Why a sign-in did not go on, as the page says it: the core's reasons
 * (`expired`, `refused`, `lost`, `failed`), no gateway (`unavailable`), no
 * answer from the Launchpad (`no-answer`), a Hermes without the cancellation
 * contract (`hermes-outdated`), or another sign-in still running
 * (`sign-in-running`). */
export type BuddySignInFailure =
  | "expired"
  | "refused"
  | "lost"
  | "failed"
  | "unavailable"
  | "no-answer"
  | "hermes-outdated"
  | "sign-in-running";

export type BuddySignInState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "starting" }>
  /** The code is on its way to the person: OpenAI's page, the code, when it
   * stops working (ms since 1970) and how often the page asks. */
  | Readonly<{
      kind: "pending";
      session: string;
      code: string;
      url: string;
      expiresAt: number;
      pollMs: number;
    }>
  /** The person finished it here: Připojeno, until the next reading. */
  | Readonly<{ kind: "signed-in" }>
  | Readonly<{ kind: "failed"; reason: BuddySignInFailure }>;

export const idleBuddySignIn: BuddySignInState = Object.freeze({
  kind: "idle",
});

/** One answer of the sign-in routes, normalized. */
export type BuddySignInStep =
  | Extract<BuddySignInState, { kind: "pending" }>
  | Readonly<{ kind: "signed-in" }>
  | Readonly<{
      kind: "failed";
      reason: "expired" | "refused" | "lost" | "failed";
    }>
  /** No sign-in by this handle (any more), or one cancelled. */
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "blocked"; reason: "hermes-outdated" | "sign-in-running" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "absent" }>;

const sessionShape = /^[0-9a-f]{32}$/;

/** A sign-in route's answer; null for any other shape. A code is taken only
 * as OpenAI's exact page and a whole code, as the core passes them. */
export function buddySignInStep(value: unknown): BuddySignInStep | null {
  if (!isRecord(value)) return null;
  if (value.error === "buddy-unavailable") return { kind: "unavailable" };
  if (value.error === "buddy-absent") return { kind: "absent" };
  switch (value.kind) {
    case "pending": {
      const { session, code, url, expiresAt, pollMs } = value;
      const expires =
        typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
      if (
        typeof session !== "string" ||
        !sessionShape.test(session) ||
        typeof code !== "string" ||
        !codexDeviceCode.test(code) ||
        url !== codexDevicePage ||
        Number.isNaN(expires) ||
        typeof pollMs !== "number" ||
        !Number.isSafeInteger(pollMs) ||
        pollMs < 500
      )
        return null;
      return {
        kind: "pending",
        session,
        code,
        url: codexDevicePage,
        expiresAt: expires,
        pollMs,
      };
    }
    case "signed-in":
      return { kind: "signed-in" };
    case "failed":
      return {
        kind: "failed",
        reason:
          value.reason === "expired" ||
          value.reason === "refused" ||
          value.reason === "lost"
            ? value.reason
            : "failed",
      };
    case "none":
    case "cancelled":
      return { kind: "none" };
    case "blocked":
      return value.reason === "hermes-outdated" ||
        value.reason === "sign-in-running"
        ? { kind: "blocked", reason: value.reason }
        : null;
    case "unavailable":
      return { kind: "unavailable" };
    default:
      return null;
  }
}

/** Whole seconds a code still holds; 0 once it expired. */
export function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** "14:05", the time a code still holds. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A line that counts down: the DOM fills `{left}` again each second. */
export type Countdown = Readonly<{ template: string; expiresAt: number }>;

export const countdownText = (countdown: Countdown, now: number): string =>
  fill(countdown.template, {
    left: clock(secondsLeft(countdown.expiresAt, now)),
  });

/** A failure in one plain line, and for a refused sign-in by code what to
 * do about it (the "?"). */
function failureLine(
  reason: BuddySignInFailure,
  copy: Copy,
): Readonly<{ line: string; help?: string }> {
  switch (reason) {
    case "expired":
      return { line: copy.buddyCodeExpired };
    case "refused":
      return { line: copy.buddyRefused, help: copy.buddyRefusedHelp };
    case "lost":
      return { line: copy.buddyLost };
    case "unavailable":
      return { line: copy.buddyNotRunning };
    case "no-answer":
      return { line: copy.buddyNoAnswer };
    case "hermes-outdated":
      return { line: copy.buddyOutdated };
    case "sign-in-running":
      return { line: copy.buddyRunning };
    case "failed":
      return { line: copy.buddyFailed };
  }
}

/** Whether a new code can help after this failure: not where Buddy needs
 * an update first. */
const retryable = (reason: BuddySignInFailure) => reason !== "hermes-outdated";

/** Whether a code shown now is past its time. */
const expired = (
  signIn: Extract<BuddySignInState, { kind: "pending" }>,
  now: number,
) => now >= signIn.expiresAt;

/** Buddy is signed in, by the reading or by the sign-in this page saw
 * finish before the reading followed. */
const connectedOf = (reading: BuddyReading | null, signIn: BuddySignInState) =>
  reading?.signIn === "connected" || signIn.kind === "signed-in";

// ---- Začínáme: the step -----------------------------------------------------

export type BuddyPartMark = "done" | "open" | "warn";

/** One quiet part of the step, with its state. */
export type BuddyPart = Readonly<{
  id: "sign-in" | "persona" | "telegram";
  mark: BuddyPartMark;
  title: string;
  status: string;
  /** The status counts down (a code on its way). */
  countdown?: Countdown;
  /** Something runs: a spinner before the status. */
  busy?: boolean;
  /** What to do about it, behind a "?". */
  help?: string;
}>;

/** The step's one action: "Přihlásit Buddyho" (starts the sign-in and opens
 * the dialog), "Zrušit" and "Pokračovat" while a code is on its way,
 * "Nový kód", "Pokračovat" to his introduction once he is signed in, or
 * "Upravit" (Nastavení → Buddy) once the step is done. */
export type BuddyStepAction =
  | "sign-in"
  | "resume"
  | "new-code"
  | "introduce"
  | "edit"
  | "none";

export type BuddyStepView = Readonly<{
  /** Done only when he is signed in and the person confirmed the names. */
  done: boolean;
  /** A part needs attention: the step's mark says so. */
  failed: boolean;
  parts: readonly BuddyPart[];
  action: BuddyStepAction;
}>;

export type BuddyStepFacts = Readonly<{
  /** `GET /api/buddy`; null until it answered. */
  reading: BuddyReading | null;
  signIn: BuddySignInState;
  now: number;
}>;

/** The sign-in part of the step and of Nastavení → Buddy. */
function signInPart(facts: BuddyStepFacts, copy: Copy): BuddyPart {
  const { reading, signIn, now } = facts;
  const base = { id: "sign-in" as const, title: copy.buddyPartSignIn };
  if (reading === null)
    return { ...base, mark: "open", status: copy.startChecking };
  if (signIn.kind === "pending") {
    if (expired(signIn, now))
      return { ...base, mark: "warn", status: copy.buddyCodeExpired };
    const countdown = {
      template: copy.buddySignInWaiting,
      expiresAt: signIn.expiresAt,
    };
    return {
      ...base,
      mark: "open",
      status: countdownText(countdown, now),
      countdown,
      busy: true,
    };
  }
  if (signIn.kind === "starting")
    return {
      ...base,
      mark: "open",
      status: copy.buddySignInStarting,
      busy: true,
    };
  if (connectedOf(reading, signIn))
    return { ...base, mark: "done", status: copy.startConnected };
  if (signIn.kind === "failed") {
    const { line, help } = failureLine(signIn.reason, copy);
    return {
      ...base,
      mark: "warn",
      status: line,
      ...(help === undefined ? {} : { help }),
    };
  }
  if (reading.signIn === "unknown")
    return reading.reason === "not-running"
      ? { ...base, mark: "warn", status: copy.buddyNotRunning }
      : { ...base, mark: "open", status: copy.buddyUnknown };
  return { ...base, mark: "open", status: copy.startNotConnected };
}

/** What a sign-in that is not under way offers next. */
function nextSignIn(
  facts: BuddyStepFacts,
): "resume" | "new-code" | "sign-in" | "none" {
  const { reading, signIn, now } = facts;
  if (reading === null) return "none";
  if (signIn.kind === "pending")
    return expired(signIn, now) ? "new-code" : "resume";
  if (signIn.kind === "starting") return "none";
  if (signIn.kind === "failed")
    return !retryable(signIn.reason)
      ? "none"
      : signIn.reason === "unavailable" || signIn.reason === "sign-in-running"
        ? "sign-in"
        : "new-code";
  // A gateway that does not run, or a reading that failed, cannot start one.
  return reading.signIn === "unknown" ? "none" : "sign-in";
}

/** Začínáme's step "Seznamte se s Buddym" (the wireframe's `BuddyStep`):
 * the sign-in, the names and Telegram as quiet parts, one action at a time.
 * Telegram is optional (decision F66): its part shows its state once Hermes
 * said it, and never decides whether the step is done. */
export function buddyStep(facts: BuddyStepFacts, copy: Copy): BuddyStepView {
  const { reading, signIn } = facts;
  const persona = reading?.persona ?? null;
  const confirmed = persona?.confirmed === true;
  const connected = connectedOf(reading, signIn);
  const sign = signInPart(facts, copy);
  const names: BuddyPart = {
    id: "persona",
    mark: confirmed ? "done" : "open",
    title: copy.buddyPartPersona,
    status:
      reading === null
        ? copy.startChecking
        : persona !== null && confirmed
          ? fill(
              persona.address === "ty"
                ? copy.buddyPersonaTy
                : copy.buddyPersonaVy,
              { name: persona.buddyName },
            )
          : copy.buddyNotYet,
  };
  // Signing in again leaves him working on the sign-in he has until the new
  // one replaces it: the step stays done meanwhile.
  const done = connected && confirmed;
  const next = nextSignIn(facts);
  const action: BuddyStepAction = done
    ? "edit"
    : next === "resume" || signIn.kind === "starting"
      ? next
      : connected
        ? "introduce"
        : next;
  const telegram = reading?.telegram;
  const channel =
    telegram === undefined || telegram.state === "unknown"
      ? []
      : [telegramPart(telegram, copy)];
  return {
    done,
    failed: !done && sign.mark === "warn",
    parts: [sign, names, ...channel],
    action,
  };
}

/** Telegram as the step's optional part. */
function telegramPart(telegram: TelegramReading, copy: Copy): BuddyPart {
  const row = telegramRow(telegram, copy);
  return {
    id: "telegram",
    mark:
      telegram.state === "connected"
        ? "done"
        : telegram.state === "failed"
          ? "warn"
          : "open",
    title: copy.buddyPartTelegram,
    status: row.line,
    ...(row.busy ? { busy: true } : {}),
  };
}

// ---- The dialog "Seznamte se s Buddym" --------------------------------------

export type MeetScreen = "sign-in" | "introduce" | "telegram";
export const meetScreens: readonly MeetScreen[] = [
  "sign-in",
  "introduce",
  "telegram",
];

/** Where the dialog opens: the sign-in until he is signed in, then his
 * introduction. */
export function meetStart(facts: BuddyStepFacts): MeetScreen {
  return connectedOf(facts.reading, facts.signIn) &&
    facts.signIn.kind !== "pending"
    ? "introduce"
    : "sign-in";
}

/** The dialog's first screen. */
export type SignInScreen =
  | Readonly<{ kind: "checking" }>
  /** "Přihlásit Buddyho", and that the sign-in is his alone. */
  | Readonly<{ kind: "start" }>
  | Readonly<{ kind: "starting" }>
  /** The page and the code, the time it holds, "Čekám na přihlášení…" and
   * "Nový kód". */
  | Readonly<{
      kind: "code";
      code: string;
      url: string;
      holds: Countdown;
    }>
  /** "Kód vypršel." with "Nový kód" as the main action. */
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "connected" }>
  /** A line, what to do about it where it says, and whether a new code
   * may help. */
  | Readonly<{
      kind: "failed";
      line: string;
      help?: string;
      retry: boolean;
    }>;

export function signInScreen(facts: BuddyStepFacts, copy: Copy): SignInScreen {
  const { reading, signIn, now } = facts;
  if (signIn.kind === "pending")
    return expired(signIn, now)
      ? { kind: "expired" }
      : {
          kind: "code",
          code: signIn.code,
          url: signIn.url,
          holds: { template: copy.buddyHolds, expiresAt: signIn.expiresAt },
        };
  if (signIn.kind === "starting") return { kind: "starting" };
  if (connectedOf(reading, signIn)) return { kind: "connected" };
  if (signIn.kind === "failed") {
    if (signIn.reason === "expired") return { kind: "expired" };
    const { line, help } = failureLine(signIn.reason, copy);
    return {
      kind: "failed",
      line,
      ...(help === undefined ? {} : { help }),
      retry: retryable(signIn.reason),
    };
  }
  if (reading === null) return { kind: "checking" };
  if (reading.signIn === "unknown")
    return {
      kind: "failed",
      line:
        reading.reason === "not-running"
          ? copy.buddyNotRunning
          : copy.buddyUnknown,
      retry: false,
    };
  return { kind: "start" };
}

/** What the person fills in on the second screen: his name, their own name
 * in its three forms, and ty or vy, null until they choose. */
export type PersonaDraft = Readonly<{
  buddyName: string;
  address: "ty" | "vy" | null;
  user: PersonNames;
}>;

/** The draft from the persona there is: his name and the person's names as
 * the installer proposed them, which the dialog offers. Ty or vy is the
 * person's own choice (decision F60's addendum of 2026-10-26: both people of
 * the first handovers changed the preselected vy): in Czech it is chosen
 * only once they confirmed it, and the installer's proposal chooses
 * nothing. English asks no ty or vy and keeps what the file says. A Buddy
 * without a persona is Buddy and asks for the person's name. */
export function draftOf(
  persona: BuddyPersonaShown | null,
  locale: "cs" | "en",
): PersonaDraft {
  if (persona === null)
    return {
      buddyName: defaultBuddyName,
      address: null,
      user: { nominative: "", accusative: "", dative: "" },
    };
  return {
    buddyName: persona.buddyName,
    address: persona.confirmed || locale === "en" ? persona.address : null,
    user: persona.user,
  };
}

/** How Buddy speaks to the person now: as they chose, and vy until then. */
export const addressOf = (draft: Pick<PersonaDraft, "address">): "ty" | "vy" =>
  draft.address ?? "vy";

/** The person typed their name: the forms are guessed from it again (a
 * correction by hand comes after, with Opravit). */
export function withYourName(
  draft: PersonaDraft,
  value: string,
  locale: "cs" | "en",
): PersonaDraft {
  return { ...draft, user: namesFromInput(value, locale) };
}

/** Opravit: one form corrected by hand. */
export function withForm(
  draft: PersonaDraft,
  form: "accusative" | "dative",
  value: string,
): PersonaDraft {
  return { ...draft, user: { ...draft.user, [form]: value } };
}

/** Whether the draft can be sent: a name for him and for the person, in
 * Czech both forms and ty or vy chosen. English has no ty or vy to choose. */
export function draftReady(draft: PersonaDraft, locale: "cs" | "en"): boolean {
  return (
    draft.buddyName.trim() !== "" &&
    draft.user.nominative.trim() !== "" &&
    draft.user.accusative.trim() !== "" &&
    draft.user.dative.trim() !== "" &&
    (locale === "en" || draft.address !== null)
  );
}

/** Whether the draft says something else than the persona. */
export function draftChanged(
  draft: PersonaDraft,
  persona: BuddyPersonaShown | null,
): boolean {
  if (persona === null) return true;
  return (
    draft.buddyName.trim() !== persona.buddyName ||
    draft.address !== persona.address ||
    draft.user.nominative.trim() !== persona.user.nominative ||
    draft.user.accusative.trim() !== persona.user.accusative ||
    draft.user.dative.trim() !== persona.user.dative
  );
}

/** What `POST /api/buddy/persona` takes for the draft; English keeps the
 * one form in all three. */
export function personaBody(
  draft: PersonaDraft,
  revision: string | null,
  confirm: boolean,
  locale: "cs" | "en",
): Readonly<Record<string, unknown>> {
  const name = draft.user.nominative.trim();
  return {
    buddyName: draft.buddyName.trim(),
    // English chooses none: Lazurio's vy, as the installer proposes.
    address: addressOf(draft),
    user:
      locale === "en"
        ? { nominative: name, accusative: name, dative: name }
        : {
            nominative: name,
            accusative: draft.user.accusative.trim(),
            dative: draft.user.dative.trim(),
          },
    revision,
    ...(confirm ? { confirm: true } : {}),
  };
}

/** A line Buddy says himself, in his address: the Ty or Vy one, and vy
 * before the person chose. */
export function said(
  copy: Copy,
  line:
    | "buddyHello"
    | "buddyHelloNamed"
    | "buddyHere"
    | "buddyDoes"
    | "buddyDoesFind"
    | "buddyMemory"
    | "buddyWhere"
    | "buddyWhereTelegram"
    | "buddyAskName"
    | "buddyAskAddress"
    | "buddyAskYou"
    | "buddyForms"
    | "buddyTelegramAsk"
    | "buddyTelegramHere"
    | "buddyTelegramPair",
  address: "ty" | "vy" | null,
): string {
  return copy[`${line}${address === "ty" ? "Ty" : "Vy"}`];
}

/** What Buddy's bot answers an account it does not know yet (decision F66),
 * in his name and address: the person confirms in Lazurio and writes again.
 * Never a code or a command: the page approves. */
export function telegramPairingLine(
  persona: Readonly<{ buddyName: string; address: "ty" | "vy" }>,
  copy: Copy,
): string {
  return fill(said(copy, "buddyTelegramPair", persona.address), {
    name: persona.buddyName.trim() || defaultBuddyName,
  });
}

// ---- His introduction: five beats ------------------------------------------

/** Czech typesetting of his lines on screen, as his bubble's: one function,
 * the shell's (`keepTogether`). */
export { keepTogether };

/** The beats of his introduction, in their order. */
export const meetBeats = Object.freeze([
  "hello",
  "does",
  "bots",
  "memory",
  "where",
] as const);
export type MeetBeat = (typeof meetBeats)[number];

/** On the introduction screen: a beat (`0` to `4`), then his questions. */
export const meetQuestionsAt = meetBeats.length;

/** The small drawing of a beat, built from the design system's parts; the
 * first beat has none, his waving figure is its picture. */
export type BeatDrawing =
  | Readonly<{
      kind: "does";
      /** Four things he takes care of (Hlas: no list of three), each true
       * on an Osobní Prostředí without an Organization or a tailnet. */
      cards: readonly Readonly<{ icon: string; text: string }>[];
    }>
  | Readonly<{
      kind: "bots";
      /** Where his bots live, as the switch names it, and two at work. */
      title: string;
      rows: readonly Readonly<{
        task: string;
        status: string;
        done: boolean;
      }>[];
    }>
  | Readonly<{ kind: "memory"; title: string; items: readonly string[] }>
  | Readonly<{
      kind: "where";
      /** The Environment's apps as its switch names them, and the phone. */
      apps: readonly string[];
      phone: string;
    }>;

export type BeatView = Readonly<{
  beat: MeetBeat;
  /** Its place, from 0, and how the progress names it ("2 z 5"). */
  index: number;
  progress: string;
  /** One or two of his speech bubbles. */
  lines: readonly string[];
  drawing: BeatDrawing | null;
  /** His figure waves (the first beat). */
  waves: boolean;
}>;

/** His hello: "Ahoj, já jsem váš Buddy." A Buddy named Buddy is never
 * "Buddy, váš Buddy" (as SOUL.md's `who`, F64). */
export function helloLine(
  buddyName: string,
  address: "ty" | "vy" | null,
  copy: Copy,
): string {
  const own = buddyName.trim() || defaultBuddyName;
  return own.toLowerCase() === defaultBuddyName.toLowerCase()
    ? said(copy, "buddyHello", address)
    : fill(said(copy, "buddyHelloNamed", address), { name: own });
}

/** One beat of his introduction, in his address (vy before the person
 * chose). `apps` names the Environment's apps as its switch does, the ones
 * it has; `automate` is the switch's name of the app where his bots work. */
export function beatView(
  index: number,
  input: Readonly<{
    buddyName: string;
    address: "ty" | "vy" | null;
    apps: readonly string[];
    automate: string;
  }>,
  copy: Copy,
): BeatView {
  const at = Math.max(0, Math.min(meetBeats.length - 1, Math.floor(index)));
  const beat = meetBeats[at] as MeetBeat;
  const { address } = input;
  const base = {
    beat,
    index: at,
    progress: fill(copy.buddyBeatProgress, {
      n: String(at + 1),
      total: String(meetBeats.length),
    }),
    waves: beat === "hello",
  };
  switch (beat) {
    case "hello":
      return {
        ...base,
        lines: [
          helloLine(input.buddyName, address, copy),
          said(copy, "buddyHere", address),
        ],
        drawing: null,
      };
    case "does":
      return {
        ...base,
        lines: [said(copy, "buddyDoes", address)],
        drawing: {
          kind: "does",
          cards: [
            { icon: "globe", text: copy.buddyDoesTrip },
            { icon: "search", text: said(copy, "buddyDoesFind", address) },
            { icon: "mail", text: copy.buddyDoesMail },
            { icon: "file", text: copy.buddyDoesSum },
          ],
        },
      };
    case "bots":
      return {
        ...base,
        lines: [copy.buddyBots],
        drawing: {
          kind: "bots",
          title: input.automate,
          rows: [
            {
              task: copy.buddyBotFlights,
              status: copy.buddyBotWorking,
              done: false,
            },
            {
              task: copy.buddyBotContract,
              status: copy.buddyBotDone,
              done: true,
            },
          ],
        },
      };
    case "memory":
      return {
        ...base,
        lines: [said(copy, "buddyMemory", address)],
        drawing: {
          kind: "memory",
          title: copy.buddyMemoryTitle,
          items: [
            copy.buddyMemoryInvoices,
            copy.buddyMemoryShort,
            copy.buddyMemoryMornings,
            copy.buddyMemoryHoliday,
          ],
        },
      };
    case "where":
      return {
        ...base,
        lines: [
          said(copy, "buddyWhere", address),
          said(copy, "buddyWhereTelegram", address),
        ],
        drawing: { kind: "where", apps: input.apps, phone: copy.buddyPhone },
      };
  }
}

/** The introduction's way on, where it stands (`at`: a beat, then his
 * questions at `meetQuestionsAt`): Zpět from the second beat on; Další
 * through the beats, then Pokračovat, which may go only once the draft is
 * ready (in Czech: ty or vy chosen); and whether the launcher of his
 * bubble rises over the dialog, while the beat that shows where he is
 * stands. */
export type IntroduceNav = Readonly<{
  back: boolean;
  next: "beat" | "confirm";
  ready: boolean;
  spotlight: boolean;
}>;

export function introduceNav(
  at: number,
  draft: PersonaDraft,
  locale: "cs" | "en",
): IntroduceNav {
  const questions = at >= meetQuestionsAt;
  return {
    back: at > 0,
    next: questions ? "confirm" : "beat",
    ready: questions ? draftReady(draft, locale) : true,
    spotlight: at === meetBeats.length - 1,
  };
}

/** His questions after the beats (the second screen's last part): every
 * line his, in the address the person chose, vy until then. English asks
 * no ty or vy and shows the one form. Ty or vy is asked last, as people
 * introduce themselves, and nothing is chosen until the person chooses. */
export type IntroduceScreen = Readonly<{
  askName: string;
  askYou: string;
  forms: string;
  /** Null in English. */
  askAddress: string | null;
  answers: Readonly<{ vy: string; ty: string }>;
  /** What the person chose; null before (English asks nothing). */
  chosen: "ty" | "vy" | null;
  /** How he writes the person's name: „Buddy za Alenu“ and „Výsledek pošli
   * Aleně“; in English „Buddy for Alena“ alone. */
  traces: readonly string[];
  /** The forms can be corrected (Czech). */
  fixable: boolean;
  ready: boolean;
}>;

export function introduceScreen(
  draft: PersonaDraft,
  locale: "cs" | "en",
  copy: Copy,
): IntroduceScreen {
  const address = draft.address;
  const nominative = draft.user.nominative.trim();
  return {
    askName: said(copy, "buddyAskName", address),
    askYou: said(copy, "buddyAskYou", address),
    forms: said(copy, "buddyForms", address),
    askAddress: locale === "cs" ? said(copy, "buddyAskAddress", address) : null,
    answers: { vy: copy.buddyAnswerVy, ty: copy.buddyAnswerTy },
    chosen: address,
    traces:
      locale === "cs"
        ? [
            fill(copy.buddyTraceFor, { name: draft.user.accusative.trim() }),
            fill(copy.buddyTraceSend, { name: draft.user.dative.trim() }),
          ]
        : [fill(copy.buddyTraceFor, { name: nominative })],
    fixable: locale === "cs",
    ready: draftReady(draft, locale),
  };
}

/** The third screen, in his address: whether the person wants to write to
 * him on Telegram too (Připojit Telegram, or Teď ne), his chat here; once his
 * bot is connected, that it is. */
export function telegramScreen(
  persona: Readonly<{ address: "ty" | "vy" | null }> | null,
  copy: Copy,
  telegram?: TelegramReading,
): Readonly<{ ask: string; here: string; connected: string | null }> {
  const address = persona?.address ?? "vy";
  return {
    ask: said(copy, "buddyTelegramAsk", address),
    here: said(copy, "buddyTelegramHere", address),
    connected:
      telegram?.state === "connected"
        ? telegramConnectedLine(telegram, copy)
        : null,
  };
}

/** What a change of the persona answered, as the page says it. */
export type PersonaSaveResult =
  | Readonly<{ kind: "saved"; pending: boolean }>
  | Readonly<{ kind: "invalid"; field: "buddy-name" | "user" }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "failed" }>;

/** The line under the names after a change, or under the dialog's form. */
export function saveLine(result: PersonaSaveResult, copy: Copy): string | null {
  switch (result.kind) {
    case "saved":
      return result.pending ? copy.buddyPending : copy.buddySaved;
    case "invalid":
      return result.field === "buddy-name"
        ? copy.buddySaveInvalidName
        : copy.buddySaveInvalidYou;
    case "changed":
      return copy.buddySaveChanged;
    case "failed":
      return copy.buddySaveFailed;
  }
}

// ---- Nastavení → Buddy --------------------------------------------------------

/** His state in a dot and a word: Pracuje, Čeká na přihlášení, or Buddy teď
 * neběží; nothing claimed while it is not known. */
export function buddyStateView(
  reading: BuddyReading | null,
  copy: Copy,
): Readonly<{ tone: "ok" | "off" | "warn"; word: string }> {
  if (reading === null) return { tone: "off", word: copy.startChecking };
  if (reading.state === "works") return { tone: "ok", word: copy.buddyWorks };
  if (reading.state === "waits") return { tone: "off", word: copy.buddyWaits };
  return reading.reason === "not-running"
    ? { tone: "warn", word: copy.buddyStateNotRunning }
    : { tone: "off", word: copy.buddyStateUnknown };
}

/** Přihlášení k ChatGPT in Nastavení → Buddy: the part's state, and its
 * controls: ⋯ with Přihlásit znovu and Odhlásit once he is signed in,
 * "Přihlásit" before, "Zrušit" and "Pokračovat" while a code is on its way,
 * "Nový kód" after one that did not finish. */
export type BuddySignInRow = Readonly<{
  part: BuddyPart;
  controls: "menu" | "sign-in" | "resume" | "new-code" | "none";
}>;

export function buddySignInRow(
  facts: BuddyStepFacts,
  copy: Copy,
): BuddySignInRow {
  const part = signInPart(facts, copy);
  const next = nextSignIn(facts);
  const connected = connectedOf(facts.reading, facts.signIn);
  return {
    part,
    controls:
      next === "resume"
        ? "resume"
        : facts.signIn.kind === "starting"
          ? "none"
          : connected
            ? "menu"
            : next,
  };
}

/** His name as the page shows it. */
export const buddyNameOf = (reading: BuddyReading | null): string =>
  reading?.persona?.buddyName ?? defaultBuddyName;

// ---- Telegram (decision F66) ------------------------------------------------

/** "Připojeno: @bot", or "Připojeno" where this Launchpad did not see the
 * bot's name. */
const telegramConnectedLine = (telegram: TelegramReading, copy: Copy) =>
  telegram.bot === undefined
    ? copy.telegramConnectedPlain
    : fill(copy.telegramConnected, { bot: telegram.bot });

/** The one action of the Telegram row: Připojit, Pokračovat (back to the
 * dialog's last step while it starts or waits for the person's message),
 * Odpojit once connected; none while nothing can be said. */
export type TelegramRowAction = "connect" | "continue" | "disconnect" | "none";

export type TelegramRowView = Readonly<{
  tone: "ok" | "off" | "warn";
  line: string;
  /** Something runs: a spinner before the line. */
  busy: boolean;
  /** A quiet line under it: a change that waits for Buddy. */
  quiet?: string;
  action: TelegramRowAction;
}>;

/** Nastavení → Buddy → Kanály → Telegram, and the step's part: its state in
 * Lazurio's words, never Hermes's, and its one action. */
export function telegramRow(
  telegram: TelegramReading | undefined,
  copy: Copy,
): TelegramRowView {
  const value = telegram ?? unknownTelegram;
  switch (value.state) {
    case "none":
      return value.pending
        ? {
            tone: "off",
            line: copy.telegramNone,
            busy: false,
            quiet: copy.telegramDisconnecting,
            action: "connect",
          }
        : {
            tone: "off",
            line: copy.telegramNone,
            busy: false,
            action: "connect",
          };
    case "starting":
      return {
        tone: "off",
        line: copy.telegramStarting,
        busy: true,
        ...(value.pending ? { quiet: copy.buddyPending } : {}),
        action: "continue",
      };
    case "waiting":
      return {
        tone: "off",
        line: copy.telegramWaiting,
        busy: false,
        action: "continue",
      };
    case "connected":
      return {
        tone: "ok",
        line: telegramConnectedLine(value, copy),
        busy: false,
        action: "disconnect",
      };
    case "failed":
      return {
        tone: "warn",
        line:
          value.reason === "refused"
            ? copy.telegramRefusedBot
            : value.reason === "conflict"
              ? copy.telegramConflict
              : copy.telegramFailed,
        busy: false,
        action: "connect",
      };
    case "unknown":
      return {
        tone: "off",
        line: copy.telegramUnknown,
        busy: false,
        action: "none",
      };
  }
}

/** The three steps of "Připojit Telegram", as Propojit Bitwarden has them:
 * the bot at BotFather, its token, and Start in the bot. */
export type TelegramStep = "botfather" | "token" | "start";
export const telegramSteps: readonly TelegramStep[] = [
  "botfather",
  "token",
  "start",
];

/** Where the dialog opens: at Start while the bot starts or waits for the
 * person's message, else at BotFather. */
export const telegramFirstStep = (
  telegram: TelegramReading | undefined,
): TelegramStep =>
  telegram?.state === "starting" || telegram?.state === "waiting"
    ? "start"
    : "botfather";

/** Whether a pasted text has the shape of a BotFather token: the bot's
 * numeric id, a colon and its secret. Telegram decides on the server. */
export const looksLikeBotToken = (text: string): boolean =>
  /^\d{1,20}:[A-Za-z0-9_-]{30,200}$/.test(text.trim());

/** What a connect answered, as the page says it. */
export type TelegramConnectResult =
  | Readonly<{ kind: "saved" }>
  /** Not a token of a bot's shape. */
  | Readonly<{ kind: "invalid" }>
  /** Telegram does not know the token. */
  | Readonly<{ kind: "refused" }>
  /** Telegram did not answer. */
  | Readonly<{ kind: "unreachable" }>
  /** Buddy does not run. */
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "failed" }>;

/** The line under the token's field after a connect that did not happen. */
export function telegramConnectLine(
  result: TelegramConnectResult,
  copy: Copy,
): string | null {
  switch (result.kind) {
    case "saved":
      return null;
    case "invalid":
      return copy.telegramTokenShape;
    case "refused":
      return copy.telegramTokenRefused;
    case "unreachable":
      return copy.telegramUnreachable;
    case "unavailable":
      return copy.buddyNotRunning;
    case "failed":
      return copy.telegramSaveFailed;
  }
}

/** What an approval answered. */
export type TelegramApproveResult =
  | Readonly<{ kind: "approved" }>
  /** The request is no longer there. */
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "failed" }>;

/** The last step, from the reading: on its way, waiting for the person's
 * Start (and who asked), connected, or what stopped it. */
export type TelegramStartScreen =
  | Readonly<{
      kind: "starting";
      quiet: string | null;
      bot: string | null;
      botQr: string | null;
    }>
  | Readonly<{
      kind: "waiting";
      bot: string | null;
      botQr: string | null;
      /** "Je to váš účet …?", one per account that asked; empty while
       * nobody did. */
      asks: readonly Readonly<{ request: string; line: string }>[];
      /** More than one account asked. */
      many: boolean;
    }>
  | Readonly<{ kind: "connected"; line: string }>
  | Readonly<{
      kind: "failed";
      line: string;
      /** Where the dialog goes again: a new token, or a new bot. */
      again: TelegramStep;
    }>
  /** Disconnected meanwhile: back to the first step. */
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unknown"; line: string }>;

export function telegramStartScreen(
  telegram: TelegramReading | undefined,
  copy: Copy,
): TelegramStartScreen {
  const value = telegram ?? unknownTelegram;
  const bot = value.bot ?? null;
  const botQr = value.botQr ?? null;
  switch (value.state) {
    case "starting":
      return {
        kind: "starting",
        quiet: value.pending ? copy.buddyPending : null,
        bot,
        botQr,
      };
    case "waiting":
      return {
        kind: "waiting",
        bot,
        botQr,
        asks: value.requests.map(({ request, name }) => ({
          request,
          line:
            name === ""
              ? copy.telegramIsItYouNoName
              : fill(copy.telegramIsItYou, { name }),
        })),
        many: value.requests.length > 1,
      };
    case "connected":
      return { kind: "connected", line: telegramConnectedLine(value, copy) };
    case "failed":
      return {
        kind: "failed",
        line:
          value.reason === "refused"
            ? copy.telegramRefusedBot
            : value.reason === "conflict"
              ? copy.telegramConflict
              : copy.telegramFailed,
        again: value.reason === "conflict" ? "botfather" : "token",
      };
    case "none":
      return { kind: "none" };
    case "unknown":
      return { kind: "unknown", line: copy.telegramUnknown };
  }
}

/** The line after an approval that did not happen. */
export function telegramApproveLine(
  result: TelegramApproveResult,
  copy: Copy,
): string | null {
  switch (result.kind) {
    case "approved":
      return null;
    case "gone":
      return copy.telegramApproveGone;
    case "unavailable":
      return copy.buddyNotRunning;
    case "failed":
      return copy.telegramApproveFailed;
  }
}
