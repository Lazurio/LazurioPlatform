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
  personaBody,
  unknownBuddyReading,
} from "./buddy-view";

// Buddy in the page (decision F65): his reading (`GET /api/buddy`), the one
// sign-in this page holds (`/api/buddy/sign-in/*`, F63) and a change of his
// persona (`POST /api/buddy/persona`), for Začínáme, its dialog and
// Nastavení → Buddy alike. Nothing is kept in the browser: a reload reads it
// all again. While a change of the persona is still on its way to him the
// reading is asked again every ten seconds, while the page is shown, so the
// line that says so goes once it is in place.

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

  /** The reading again in ten seconds while a change is on its way. */
  function follow() {
    timers.cancel(rereadTimer);
    rereadTimer = undefined;
    if (reading?.persona?.pending !== true) return;
    rereadTimer = timers.after(() => {
      rereadTimer = undefined;
      if (visible()) void read();
      else follow();
    }, buddyPendingReadMs);
  }

  async function readOnce(): Promise<void> {
    let answer: Readonly<{ ok: boolean; value: unknown }> | undefined;
    try {
      answer = await options.transport.get(buddyRoutePaths.read);
    } catch {
      answer = undefined;
    }
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
    const parsed = answer?.ok === true ? parseBuddyReading(answer.value) : null;
    // A failed read keeps what was read before; a first one claims nothing.
    if (parsed !== null) {
      reading = parsed;
      absent = false;
    } else if (reading === null) reading = unknownBuddyReading;
    // Once the reading says he is signed in, "Připojeno" is its.
    if (signIn.kind === "signed-in" && reading.signIn !== "unknown")
      set(idleBuddySignIn);
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
      if (mine === turn && done) set(idleBuddySignIn);
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
        reading = { ...(reading ?? unknownBuddyReading), persona };
        follow();
        options.changed();
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
        reading = {
          ...(reading ?? unknownBuddyReading),
          persona: parsePersona(value.current),
        };
        options.changed();
        return { kind: "changed" };
      }
      return { kind: "failed" };
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
