import { buddyRoutePaths } from "./buddy-paths";
import {
  type BuddyReading,
  type BuddySignInState,
  buddySignInStep,
  idleBuddySignIn,
  type PersonaDraft,
  type PersonaSaveResult,
  parseBuddyReading,
  parsePersona,
  parseTelegram,
  personaBody,
  type TelegramApproveResult,
  type TelegramConnectResult,
  type TelegramReading,
  telegramIntentOf,
  unknownBuddyReading,
} from "./buddy-view";

// Buddy in the page (decision F65): his reading (`GET /api/buddy`), the one
// sign-in this page holds (`/api/buddy/sign-in/*`, F63), a change of his
// persona (`POST /api/buddy/persona`) and his Telegram
// (`/api/buddy/telegram/*`, F66), for Začínáme, its dialogs and
// Nastavení → Buddy alike. Nothing is kept in the browser: a reload reads it
// all again, and a bot's token passes through on its way to the Launchpad
// only. While a change of the persona is still on its way to him the
// reading is asked again every ten seconds, while the page is shown, so the
// line that says so goes once it is in place; while his Telegram starts or
// waits for the person's Start, every four seconds, so who asked shows soon.
//
// An answer never takes back what the page already knows (Pablo's review of
// #637). What the page learns from its own operations, a persona its save
// wrote, the persona a 409 says is there now, a sign-in that finished, one
// the Launchpad holds no more, a sign-out Hermes confirmed, moves one epoch;
// a reading begun before that may have been served before it, so its answer
// is dropped and the reading asked again, at most three times. A save's
// answer is installed only when no later save's answer was. A counter, not
// the revision: revisions have no order (each is a sha256), and the sign-in
// has none at all.

export type BuddyTransport = Readonly<{
  get: (path: string) => Promise<Readonly<{ ok: boolean; value: unknown }>>;
  post: (
    path: string,
    body: unknown,
  ) => Promise<Readonly<{ ok: boolean; value: unknown }>>;
}>;

export type BuddyTimers = Readonly<{
  after(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}>;

const pageTimers: BuddyTimers = {
  after: (callback, ms) => setTimeout(callback, ms),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** How often a pending change of the persona is read again. */
export const buddyPendingReadMs = 10_000;
/** How often Telegram is read again while it starts or waits for the
 * person's Start. */
export const buddyTelegramReadMs = 4_000;
/** How many times a reading overtaken by newer knowledge is asked in all. */
export const buddyReadAttempts = 3;
/** A code past its time by this much is no longer asked about. */
const lateMs = 60_000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function createBuddyClient(
  options: Readonly<{
    transport: BuddyTransport;
    /** Something changed: what shows Buddy is drawn again. */
    changed: () => void;
    timers?: BuddyTimers;
    now?: () => number;
    /** Whether the page is shown: a pending change is read again only
     * then. */
    visible?: () => boolean;
  }>,
) {
  const timers = options.timers ?? pageTimers;
  const now = options.now ?? (() => Date.now());
  const visible =
    options.visible ??
    (() =>
      typeof document === "undefined" ||
      document.visibilityState === "visible");
  let reading: BuddyReading | null = null;
  let absent = false;
  let signIn: BuddySignInState = idleBuddySignIn;
  // A newer start, cancel or sign-out ends the questions of an older one.
  let turn = 0;
  let pollTimer: unknown;
  let rereadTimer: unknown;
  let expiryTimer: unknown;
  let reading$: Promise<void> | null = null;
  // What the page learned since a reading began (see the head of the file).
  let epoch = 0;
  // The saves started, and the latest whose answer was installed.
  let saves = 0;
  let installedSave = 0;
  /** The page learned something no reading begun before may take back. */
  const learned = () => {
    epoch += 1;
  };

  const set = (next: BuddySignInState) => {
    signIn = next;
    timers.cancel(expiryTimer);
    expiryTimer = undefined;
    // A code that runs out while nobody asks shows it at once.
    if (next.kind === "pending") {
      const left = next.expiresAt - now();
      if (left > 0)
        expiryTimer = timers.after(() => options.changed(), left + 50);
    }
  };

  /** The reading again while a change is on its way: in ten seconds for
   * the persona, in four while Telegram starts or waits for the person. */
  function follow() {
    timers.cancel(rereadTimer);
    rereadTimer = undefined;
    const telegram = reading?.telegram;
    const telegramMoving =
      telegram !== undefined &&
      (telegram.state === "starting" ||
        telegram.state === "waiting" ||
        telegram.pending);
    if (reading?.persona?.pending !== true && !telegramMoving) return;
    rereadTimer = timers.after(
      () => {
        rereadTimer = undefined;
        if (visible()) void read();
        else follow();
      },
      telegramMoving ? buddyTelegramReadMs : buddyPendingReadMs,
    );
  }

  /** Telegram as an answer of the page's own says it now. */
  function installTelegram(telegram: TelegramReading) {
    learned();
    reading = { ...(reading ?? unknownBuddyReading), telegram };
    follow();
    options.changed();
  }

  async function readOnce(): Promise<void> {
    for (let attempt = 1; attempt <= buddyReadAttempts; attempt += 1) {
      const begun = epoch;
      let answer: Readonly<{ ok: boolean; value: unknown }> | undefined;
      try {
        answer = await options.transport.get(buddyRoutePaths.read);
      } catch {
        answer = undefined;
      }
      // Overtaken: the page learned something after this reading began, and
      // its answer may predate it. Asked again.
      if (begun !== epoch) continue;
      if (
        answer !== undefined &&
        !answer.ok &&
        isRecord(answer.value) &&
        answer.value.error === "buddy-absent"
      ) {
        absent = true;
        reading = null;
        options.changed();
        return;
      }
      const parsed =
        answer?.ok === true ? parseBuddyReading(answer.value) : null;
      // A failed read keeps what was read before; a first one claims nothing.
      if (parsed !== null) {
        reading = parsed;
        absent = false;
      } else if (reading === null) reading = unknownBuddyReading;
      // Once the reading says he is signed in, "Připojeno" is its.
      if (signIn.kind === "signed-in" && reading.signIn === "connected")
        set(idleBuddySignIn);
      follow();
      options.changed();
      return;
    }
    // Overtaken every time: what the page knows stays, and claims nothing
    // where it knows nothing yet.
    if (reading === null) reading = unknownBuddyReading;
    follow();
    options.changed();
  }

  /** `GET /api/buddy`; one at a time. */
  function read(): Promise<void> {
    if (reading$ !== null) return reading$;
    reading$ = readOnce().finally(() => {
      reading$ = null;
    });
    return reading$;
  }

  const ask = (path: string, body: unknown) =>
    options.transport.post(path, body).then(
      (answer) => answer.value,
      () => undefined,
    );

  function schedulePoll(mine: number) {
    timers.cancel(pollTimer);
    if (signIn.kind !== "pending") return;
    const { session, pollMs } = signIn;
    pollTimer = timers.after(() => void poll(mine, session), pollMs);
  }

  async function poll(mine: number, session: string) {
    if (mine !== turn) return;
    const step = buddySignInStep(await ask(buddyRoutePaths.poll, { session }));
    if (mine !== turn || signIn.kind !== "pending") return;
    if (step?.kind === "signed-in") {
      set({ kind: "signed-in" });
      learned();
      options.changed();
      void read();
      return;
    }
    if (step?.kind === "failed") {
      set({ kind: "failed", reason: step.reason });
      options.changed();
      return;
    }
    if (step?.kind === "none") {
      // The Launchpad holds it no more (it restarted): the reading says
      // whether the person finished it meanwhile.
      set(idleBuddySignIn);
      learned();
      options.changed();
      void read();
      return;
    }
    // Still pending, or no answer this time: asked again, until the code is
    // long past its time.
    if (now() > signIn.expiresAt + lateMs) {
      set({ kind: "failed", reason: "expired" });
      options.changed();
      return;
    }
    schedulePoll(mine);
  }

  return Object.freeze({
    reading: (): BuddyReading | null => reading,
    /** The Environment has no Buddy (404 `buddy-absent`). */
    absent: (): boolean => absent,
    signIn: (): BuddySignInState => signIn,
    read,

    /** "Přihlásit Buddyho", "Nový kód", "Přihlásit znovu": a new code. A
     * start Hermes refuses while another sign-in runs keeps the code shown. */
    async start(): Promise<void> {
      timers.cancel(pollTimer);
      const mine = ++turn;
      const before = signIn;
      set({ kind: "starting" });
      options.changed();
      const value = await ask(buddyRoutePaths.start, {});
      if (mine !== turn) return;
      const step = buddySignInStep(value);
      if (step?.kind === "pending") set(step);
      else if (step?.kind === "failed")
        set({ kind: "failed", reason: step.reason });
      else if (step?.kind === "blocked")
        set(
          step.reason === "sign-in-running" && before.kind === "pending"
            ? before
            : { kind: "failed", reason: step.reason },
        );
      else if (step?.kind === "unavailable")
        set({ kind: "failed", reason: "unavailable" });
      else if (step?.kind === "absent") {
        absent = true;
        set(idleBuddySignIn);
      } else
        set({
          kind: "failed",
          reason: value === undefined ? "no-answer" : "failed",
        });
      schedulePoll(mine);
      options.changed();
    },

    /** "Zrušit": the code ends on Hermes. One Hermes did not confirm ending
     * stays on screen, since it may still complete. */
    async cancel(): Promise<void> {
      const state = signIn;
      if (state.kind !== "pending") {
        set(idleBuddySignIn);
        options.changed();
        return;
      }
      timers.cancel(pollTimer);
      const mine = ++turn;
      const step = buddySignInStep(
        await ask(buddyRoutePaths.cancel, { session: state.session }),
      );
      if (mine !== turn) return;
      if (step?.kind === "none") set(idleBuddySignIn);
      else schedulePoll(mine);
      options.changed();
    },

    /** "Odhlásit": Hermes forgets his sign-in. True once it did. */
    async signOut(): Promise<boolean> {
      const mine = ++turn;
      timers.cancel(pollTimer);
      const value = await ask(buddyRoutePaths.signOut, {});
      const done = isRecord(value) && value.kind === "signed-out";
      if (done) {
        // A reading begun before the sign-out still says he is signed in.
        learned();
        if (mine === turn) set(idleBuddySignIn);
      }
      await read();
      return done;
    },

    /** A change of his persona; `confirm` from Začínáme's introduction. */
    async savePersona(
      draft: PersonaDraft,
      confirm: boolean,
      locale: "cs" | "en",
    ): Promise<PersonaSaveResult> {
      const revision = reading?.persona?.revision ?? null;
      const mine = ++saves;
      /** The persona an answer says is there, unless a later save's answer
       * was installed already. */
      const install = (persona: BuddyReading["persona"]) => {
        if (mine < installedSave) return;
        installedSave = mine;
        learned();
        reading = { ...(reading ?? unknownBuddyReading), persona };
        follow();
        options.changed();
      };
      let answer: Readonly<{ ok: boolean; value: unknown }>;
      try {
        answer = await options.transport.post(
          buddyRoutePaths.persona,
          personaBody(draft, revision, confirm, locale),
        );
      } catch {
        return { kind: "failed" };
      }
      const value = answer.value;
      if (!isRecord(value)) return { kind: "failed" };
      if (answer.ok && value.kind === "persona") {
        const persona = parsePersona(value.persona);
        if (persona === null) return { kind: "failed" };
        install(persona);
        return { kind: "saved", pending: persona.pending };
      }
      if (typeof value.error === "string") {
        if (value.error === "invalid-buddy-name")
          return { kind: "invalid", field: "buddy-name" };
        if (value.error.startsWith("invalid-user"))
          return { kind: "invalid", field: "user" };
        return { kind: "failed" };
      }
      if (value.kind === "blocked" && value.reason === "persona-changed") {
        // What is there now, for the page to show and to change again.
        install(parsePersona(value.current));
        return { kind: "changed" };
      }
      return { kind: "failed" };
    },

    /** Připojit Telegram: the token as the person pasted it, sent once and
     * kept nowhere here. `intent`: the id of a connect that waited, when
     * the dialog sends its token once more. */
    async connectTelegram(
      token: string,
      intent?: string,
    ): Promise<TelegramConnectResult> {
      let answer: Readonly<{ ok: boolean; value: unknown }>;
      try {
        answer = await options.transport.post(
          buddyRoutePaths.telegramConnect,
          intent === undefined ? { token } : { token, intent },
        );
      } catch {
        return { kind: "failed" };
      }
      const value = answer.value;
      if (!isRecord(value)) return { kind: "failed" };
      if (answer.ok && value.kind === "telegram") {
        installTelegram(parseTelegram(value));
        // Waiting, with the id of this connect: the dialog keeps the token
        // for it. Waiting without one (a write after the token's own, in
        // doubt): the token is saved, nothing to send again.
        const held =
          value.held === true ? telegramIntentOf(value.intent) : null;
        return held === null
          ? { kind: "saved" }
          : { kind: "held", intent: held };
      }
      if (value.kind === "blocked" && value.reason === "superseded") {
        void read();
        return { kind: "superseded" };
      }
      if (value.error === "invalid-token") return { kind: "invalid" };
      if (value.error === "buddy-unavailable") return { kind: "unavailable" };
      if (value.kind === "failed")
        return value.reason === "token-refused"
          ? { kind: "refused" }
          : value.reason === "telegram-unreachable"
            ? { kind: "unreachable" }
            : { kind: "failed" };
      return { kind: "failed" };
    },

    /** "Ano, to jsem já": the account of this request allowed. */
    async approveTelegram(request: string): Promise<TelegramApproveResult> {
      let answer: Readonly<{ ok: boolean; value: unknown }>;
      try {
        answer = await options.transport.post(buddyRoutePaths.telegramApprove, {
          request,
        });
      } catch {
        return { kind: "failed" };
      }
      const value = answer.value;
      if (!isRecord(value)) return { kind: "failed" };
      if (answer.ok && value.kind === "telegram") {
        installTelegram(parseTelegram(value));
        return { kind: "approved" };
      }
      if (value.kind === "blocked" && value.reason === "request-gone") {
        void read();
        return { kind: "gone" };
      }
      if (value.error === "buddy-unavailable") return { kind: "unavailable" };
      return { kind: "failed" };
    },

    /** Odpojit: his bot off. True once Hermes took it. */
    async disconnectTelegram(): Promise<boolean> {
      let answer: Readonly<{ ok: boolean; value: unknown }>;
      try {
        answer = await options.transport.post(
          buddyRoutePaths.telegramDisconnect,
          {},
        );
      } catch {
        return false;
      }
      const value = answer.value;
      if (!answer.ok || !isRecord(value) || value.kind !== "telegram")
        return false;
      installTelegram(parseTelegram(value));
      return true;
    },

    /** The page goes: nothing more is asked. */
    stop() {
      turn += 1;
      timers.cancel(pollTimer);
      timers.cancel(rereadTimer);
      timers.cancel(expiryTimer);
    },
  });
}

export type BuddyClient = ReturnType<typeof createBuddyClient>;
