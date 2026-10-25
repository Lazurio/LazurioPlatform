import { isAbsolute } from "node:path";
import { promptRefreshOwed } from "./gateway-refresh";
import {
  type Persona,
  type PersonaAddress,
  type PersonaRead,
  type PersonaUpdate,
  personaFromValues,
  readPersona,
  writePersona,
} from "./persona";
import {
  type BuddyPersona,
  type BuddyPersonaReason,
  type GatewayRestart,
  invalidReason,
} from "./persona-apply";

// Buddy's persona in the Launchpad (decision F65, on F64's core): what
// Začínáme's "Seznamte se s Buddym" and Nastavení → Buddy show of it, and a
// change the person makes there. A change is written as `lazurio buddy
// persona` writes it (`writePersona`: the person's values checked as the
// installer checks them, only while the file is still the one the page read,
// under the writers' lock) and then brought to Buddy by F64's apply, the one
// `lazurio buddy persona --apply` runs. The apply waits for Buddy to be idle
// before it restarts his gateway, so what it could not finish yet the
// Launchpad finishes: it applies again while Buddy is busy, and whenever a
// reading finds a refresh of his stored prompts still owed (the record F64's
// apply keeps until a complete refresh and the restart after it), so a
// Launchpad that restarted takes it up again. Nothing of this is stored
// beside F64's own record. The journal names the operation, its outcome and
// its reason, never a name, a value or a revision.

/** The persona as the page shows it: `revision` names the file a change
 * must still find (null-free: a page that has none sends null); `pending`
 * while a change is written but not yet in Buddy's running conversations. */
export type BuddyPersonaShown = Readonly<{
  buddyName: string;
  address: PersonaAddress;
  user: Readonly<{ nominative: string; accusative: string; dative: string }>;
  confirmed: boolean;
  revision: string;
  pending: boolean;
}>;

/** What F64's apply did with a change: `waiting` until Buddy is idle (the
 * Launchpad goes on applying), `failed` with its reason (retried), or
 * `unavailable` or `skipped` where nothing can be applied. `restart` and
 * `prompts`, the stored prompts it cleared now, where the apply says. */
export type PersonaApplied = Readonly<{
  state: "applied" | "waiting" | "failed" | "unavailable" | "skipped";
  reason?: BuddyPersonaReason;
  restart?: GatewayRestart;
  prompts?: number;
}>;

/** A refused member, as `lazurio buddy persona` names it. */
export type PersonaInvalid = ReturnType<typeof invalidReason>;

export type PersonaSaveAnswer =
  | Readonly<{
      kind: "persona";
      outcome: "written" | "unchanged";
      persona: BuddyPersonaShown;
      applied: PersonaApplied;
    }>
  | Readonly<{ kind: "invalid"; reason: PersonaInvalid }>
  /** The file is not the one the page read: nothing was written, and the
   * persona as it is now (null where none can be shown). */
  | Readonly<{
      kind: "blocked";
      reason: "persona-changed";
      current: BuddyPersonaShown | null;
    }>
  /** Another writer held the persona too long, or its place is not what it
   * should be: nothing was written. */
  | Readonly<{ kind: "blocked"; reason: "persona-busy" | "persona-unsafe" }>;

/** One line of the journal: never a name, a value or a revision. */
export type PersonaJournalEntry = Readonly<{
  operation: "save" | "apply";
  outcome: string;
  reason?: string;
  applied?: string;
}>;

/** When the Launchpad asks again: a timer it can cancel. */
export type PersonaTimers = Readonly<{
  after(callback: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}>;

const processTimers: PersonaTimers = {
  after: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    // A retry never keeps a stopping process alive.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** How long a save waits for the apply before it answers `waiting` and lets
 * it finish on its own. */
export const personaAnswerWithinMs = 20_000;
/** While Buddy is busy the apply is asked again this often. */
export const personaRetryMs = 15_000;
/** A failed apply is asked again after this, doubled each time it fails
 * again, at most `personaRetryMaxMs`. */
export const personaFailedRetryMs = 30_000;
export const personaRetryMaxMs = 15 * 60_000;

/** The persona of a reading, as the page shows it; null where there is none
 * the installer would take (absent, unreadable or refused): the page then
 * offers an empty introduction. */
export function personaShown(
  read: PersonaRead,
  pending: boolean,
): BuddyPersonaShown | null {
  return read.state === "valid"
    ? shownOf(read.persona, read.revision, pending)
    : null;
}

const shownOf = (
  persona: Persona,
  revision: string,
  pending: boolean,
): BuddyPersonaShown =>
  Object.freeze({
    buddyName: persona.buddyName,
    address: persona.address,
    user: Object.freeze({
      nominative: persona.user.nominative,
      accusative: persona.user.accusative,
      dative: persona.user.dative,
    }),
    confirmed: persona.confirmedAt !== undefined,
    revision,
    pending,
  });

/** What an apply answered, without the persona it read (the page has it). */
export function appliedOf(answer: BuddyPersona | "running"): PersonaApplied {
  if (answer === "running") return Object.freeze({ state: "waiting" });
  const state =
    answer.state === "in-place"
      ? "applied"
      : answer.state === "outdated"
        ? "waiting"
        : answer.state;
  const prompts = answer.prompts;
  return Object.freeze({
    state,
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
    ...(answer.restart === undefined ? {} : { restart: answer.restart }),
    ...(prompts !== undefined &&
    (prompts.state === "refreshed" || prompts.state === "incomplete")
      ? { prompts: prompts.refreshed }
      : {}),
  });
}

/** The Launchpad's persona: `apply` is F64's (`buddyPersona` with `apply`),
 * `home` the account's own. */
export function createPersonaSave(
  input: Readonly<{
    /** The account's home; none known reads no persona and writes none. */
    home: string | undefined;
    apply: () => Promise<BuddyPersona>;
    journal?: ((entry: PersonaJournalEntry) => void) | undefined;
    /** Tests only: the clock of `confirmed_at` and of the retries. */
    now?: (() => Date) | undefined;
    /** Tests only: the retries' timer, and how long a save waits. */
    timers?: PersonaTimers | undefined;
    answerWithinMs?: number | undefined;
  }>,
) {
  const timers = input.timers ?? processTimers;
  const now = input.now ?? (() => new Date());
  const answerWithinMs = input.answerWithinMs ?? personaAnswerWithinMs;
  const journal = (entry: PersonaJournalEntry) => input.journal?.(entry);
  const home = input.home ?? "";
  const homeKnown = home !== "" && isAbsolute(home);

  // One apply at a time in this process (F64's own lock orders it against
  // the command): a save joins the one that runs, which reads the persona
  // again before it answers and applies what changed meanwhile.
  let running: Promise<BuddyPersona> | null = null;
  let retry: unknown;
  // A reading starts no apply before this, so a refresh that stays owed
  // (an apply that fails, or answers that nothing can be applied) is not
  // asked again on every reading.
  let notBefore = 0;
  let failedDelay = personaFailedRetryMs;
  let journaled: string | null = null;
  let closed = false;

  const schedule = (delay: number) => {
    if (retry !== undefined) timers.cancel(retry);
    retry = timers.after(() => {
      retry = undefined;
      void run();
    }, delay);
  };

  function settle(answer: BuddyPersona) {
    // A line only when the outcome changes: Buddy busy for an hour is one
    // line, not one per retry.
    const line = JSON.stringify([answer.state, answer.reason ?? null]);
    if (line !== journaled) {
      journaled = line;
      journal({
        operation: "apply",
        outcome: answer.state,
        ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      });
    }
    if (closed) return;
    const at = now().getTime();
    if (answer.state === "waiting") {
      failedDelay = personaFailedRetryMs;
      notBefore = at + personaRetryMs;
      schedule(personaRetryMs);
    } else if (answer.state === "failed") {
      const delay = failedDelay;
      failedDelay = Math.min(failedDelay * 2, personaRetryMaxMs);
      notBefore = at + delay;
      schedule(delay);
    } else {
      failedDelay = personaFailedRetryMs;
      notBefore = at + personaRetryMs;
    }
  }

  function run(): Promise<BuddyPersona> {
    if (running !== null) return running;
    if (retry !== undefined) {
      timers.cancel(retry);
      retry = undefined;
    }
    const current = input
      .apply()
      .catch(
        (): BuddyPersona =>
          Object.freeze({ kind: "buddy-persona", state: "failed" }),
      )
      .then((answer) => {
        running = null;
        settle(answer);
        return answer;
      });
    running = current;
    return current;
  }

  /** An apply now, or the one under way, answered within `within`;
   * `running` when it takes longer and finishes on its own. */
  async function applyWithin(
    within: number,
  ): Promise<BuddyPersona | "running"> {
    let late: unknown;
    try {
      return await Promise.race([
        run(),
        new Promise<"running">((resolve) => {
          late = timers.after(() => resolve("running"), within);
        }),
      ]);
    } finally {
      timers.cancel(late);
    }
  }

  const pending = () => running !== null || retry !== undefined;

  return Object.freeze({
    /** The persona as it is now. A refresh still owed starts an apply,
     * unless one runs, waits or was asked a moment ago. */
    async read(): Promise<BuddyPersonaShown | null> {
      if (!homeKnown) return null;
      const [read, owed] = await Promise.all([
        readPersona(home),
        promptRefreshOwed(home),
      ]);
      if (owed && !closed && !pending() && now().getTime() >= notBefore)
        void run();
      return personaShown(read, owed || pending());
    },

    /** A change from the page, only while the file is the one at
     * `revision` (null: there was none), then applied. */
    async save(
      update: PersonaUpdate,
      revision: string | null,
    ): Promise<PersonaSaveAnswer> {
      const refused = (answer: PersonaSaveAnswer, reason: string) => {
        journal({ operation: "save", outcome: "refused", reason });
        return answer;
      };
      if (!homeKnown)
        return refused(
          Object.freeze({ kind: "blocked", reason: "persona-unsafe" }),
          "persona-unsafe",
        );
      // The members first, so a refusal names the member whatever the file.
      const check = personaFromValues(update, undefined);
      if (!check.ok) {
        const reason = invalidReason(
          check.field === "document" ? "schema_version" : check.field,
        );
        return refused(Object.freeze({ kind: "invalid", reason }), reason);
      }
      const write = await writePersona(home, update, revision, { now });
      if (write.kind === "invalid") {
        const reason = invalidReason(write.field);
        return refused(Object.freeze({ kind: "invalid", reason }), reason);
      }
      if (write.kind === "persona-changed")
        return refused(
          Object.freeze({
            kind: "blocked",
            reason: "persona-changed",
            current: personaShown(
              write.current,
              pending() || (await promptRefreshOwed(home)),
            ),
          }),
          "persona-changed",
        );
      if (write.kind === "busy" || write.kind === "unsafe") {
        const reason =
          write.kind === "busy" ? "persona-busy" : "persona-unsafe";
        return refused(Object.freeze({ kind: "blocked", reason }), reason);
      }
      const applied = appliedOf(await applyWithin(answerWithinMs));
      journal({
        operation: "save",
        outcome: write.kind,
        applied: applied.state,
      });
      const owed = await promptRefreshOwed(home);
      return Object.freeze({
        kind: "persona",
        outcome: write.kind,
        persona: shownOf(
          write.persona,
          write.revision,
          applied.state === "waiting" || pending() || owed,
        ),
        applied,
      });
    },

    /** The Launchpad stops: no retry after it. */
    close() {
      closed = true;
      if (retry !== undefined) timers.cancel(retry);
      retry = undefined;
    },
  });
}

export type PersonaSave = ReturnType<typeof createPersonaSave>;
