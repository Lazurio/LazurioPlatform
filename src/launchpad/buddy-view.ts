import type { BuddyPersonaShown } from "../buddy/persona-save";
import { codexDeviceCode, codexDevicePage } from "../tools/ai";
import { namesFromInput, type PersonNames } from "./buddy-names";
import type { BuddyFact } from "./first-run";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Buddy in the Launchpad's page (decision F65; the wireframe of
// prototypes-lazurio #90): what Začínáme's step "Seznamte se s Buddym", its
// dialog and Nastavení → Buddy say, from `GET /api/buddy` and the sign-in
// this page holds. Lazurio's own lines say vy (root decision 0199); the
// lines Buddy says himself in the dialog (his introduction, his questions,
// the Telegram screen) follow how he addresses the person, and change at
// once with "Tykej mi". No line names a model, Hermes, a code name or a
// reason code. Pure: the DOM is start-panel.ts, buddy-dialog.ts and
// buddy-panel.ts.

/** His default name, as the installer names a Buddy nobody named. */
export const defaultBuddyName = "Buddy";

/** What `GET /api/buddy` answers, as the page reads it. */
export type BuddyReading = Readonly<{
  state: "works" | "waits" | "unknown";
  reason?: "not-running";
  signIn: "connected" | "none" | "unknown";
  persona: BuddyPersonaShown | null;
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
  id: "sign-in" | "persona";
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
 * the sign-in and the names as two quiet parts, one action at a time. The
 * Telegram part comes with Telegram itself (its state is Hermes's, which
 * this page does not read yet). */
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
  return {
    done,
    failed: !done && sign.mark === "warn",
    parts: [sign, names],
    action,
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

/** What the person fills in on the second screen: his name, ty or vy, and
 * their own name in its three forms. */
export type PersonaDraft = Readonly<{
  buddyName: string;
  address: "ty" | "vy";
  user: PersonNames;
}>;

/** The draft from the persona there is: his name, his address and the
 * person's names as the installer collected them; a Buddy without one is
 * Buddy, says vy and asks for the person's name. */
export function draftOf(persona: BuddyPersonaShown | null): PersonaDraft {
  if (persona === null)
    return {
      buddyName: defaultBuddyName,
      address: "vy",
      user: { nominative: "", accusative: "", dative: "" },
    };
  return {
    buddyName: persona.buddyName,
    address: persona.address,
    user: persona.user,
  };
}

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

/** Whether the draft can be sent: a name for him and for the person, and
 * in Czech both forms. */
export function draftReady(draft: PersonaDraft): boolean {
  return (
    draft.buddyName.trim() !== "" &&
    draft.user.nominative.trim() !== "" &&
    draft.user.accusative.trim() !== "" &&
    draft.user.dative.trim() !== ""
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
    address: draft.address,
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

/** A line Buddy says himself, in his address: the Ty or Vy one. */
export function said(
  copy: Copy,
  line:
    | "buddySaysIntro"
    | "buddyAskName"
    | "buddyAskAddress"
    | "buddyAnswer"
    | "buddyAskYou"
    | "buddyForms"
    | "buddyTelegramAsk"
    | "buddyTelegramHere",
  address: "ty" | "vy",
): string {
  return copy[`${line}${address === "ty" ? "Ty" : "Vy"}`];
}

/** Buddy introduces himself and asks (the second screen): every line his,
 * in the address of the draft. English asks no ty or vy and shows the one
 * form. */
export type IntroduceScreen = Readonly<{
  hello: string;
  intro: string;
  askName: string;
  /** Null in English. */
  askAddress: string | null;
  answers: Readonly<{ vy: string; ty: string }>;
  askYou: string;
  forms: string;
  /** How he writes the person's name: „Buddy za Matěje“ and „Výsledek pošli
   * Matějovi“; in English „Buddy for Matěj“ alone. */
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
  const name = draft.buddyName.trim() || defaultBuddyName;
  const nominative = draft.user.nominative.trim();
  return {
    hello: fill(copy.buddySaysHello, { name }),
    intro: said(copy, "buddySaysIntro", address),
    askName: said(copy, "buddyAskName", address),
    askAddress: locale === "cs" ? said(copy, "buddyAskAddress", address) : null,
    answers: { vy: copy.buddyAnswerVy, ty: copy.buddyAnswerTy },
    askYou: said(copy, "buddyAskYou", address),
    forms: said(copy, "buddyForms", address),
    traces:
      locale === "cs"
        ? [
            fill(copy.buddyTraceFor, { name: draft.user.accusative.trim() }),
            fill(copy.buddyTraceSend, { name: draft.user.dative.trim() }),
          ]
        : [fill(copy.buddyTraceFor, { name: nominative })],
    fixable: locale === "cs",
    ready: draftReady(draft),
  };
}

/** The third screen, in his address: Telegram later, his chat here. */
export function telegramScreen(
  persona: Readonly<{ address: "ty" | "vy" }> | null,
  copy: Copy,
): Readonly<{ ask: string; here: string }> {
  const address = persona?.address ?? "vy";
  return {
    ask: said(copy, "buddyTelegramAsk", address),
    here: said(copy, "buddyTelegramHere", address),
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
