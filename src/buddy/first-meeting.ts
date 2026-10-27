import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { ToolRunner } from "../tools/status";
import { buddyStateDirectory, writeBuddyStateFile } from "./gateway-refresh";
import type { Persona, PersonaLocale } from "./persona";
import { buddyT3Home, buddyT3Runtime } from "./t3-runtime";

// Buddy's first message (decision F60's addendum of 2026-10-26; the
// prototype of prototypes-lazurio #92, `firstMessage` and its rules in
// `docs/buddy-onboarding.md`). Right after the person first confirms his
// names in Začínáme, the Launchpad gives Buddy one turn in his conversation
// in Lazurio, which the person never sees: it tells him to greet them in
// three short paragraphs, by the name they gave him and in the address they
// chose. The person sees only his reply, a real message of his.
//
// The turn takes the path and the mark of Delegace's notices (its README,
// "The contract"): Buddy's own `t3` (`buddyT3Runtime`, the runtime his T3
// Code's unit names, never the `t3` on PATH) finds his one thread with `t3
// lazurio buddy thread` and sends with `t3 thread send <thread> --mode queue
// --idempotency-key <key> --message-file -`, both against his T3 Code
// (`--base-dir ~/.t3-buddy`) and with `T3CODE_ACTING_SENDER=delegace` in
// that `t3`'s own environment alone: T3 Code's acting-sender kind that it
// shows to Buddy and never to the person (Lazurio/t3code#106; the web hides
// such a message, `apps/web/src/lazurio/actingSender.ts` `hidesMessage`).
// `queue` never interrupts a turn of his, so a busy Buddy greets after it.
//
// Once per confirmation: the persona's first `confirmed_at` (F64 keeps the
// first) names the turn. The Launchpad records it before anything else, in
// its own file in Buddy's state directory, with its exact text and its key,
// so that a retry after a crash or a restart sends the same message under
// the same key, which T3 Code never sends twice. A confirmation that is not
// the first owes nothing, nor does any other writer of the persona. The
// record ends `sent`, `refused` (a refusal of T3 Code that the same key never
// fixes) or `expired` (a day after the confirmation, when a greeting would no
// longer be one); until then each failure that may pass leaves it `owed`.
// Nothing goes to Telegram, ever: the greeting belongs to his conversation in
// Lazurio, which the meeting's end opens.

/** The record of the first meeting's turn. */
export const firstMeetingSchema = "lazurio.buddy-first-meeting.v1";

/** The record, in Buddy's state directory beside F64's: 0600 in 0700. */
export const firstMeetingPath = (home: string): string =>
  join(buddyStateDirectory(home), "first-meeting.json");

/** A day after the confirmation the turn is no greeting any more. */
export const firstMeetingWithinMs = 24 * 60 * 60 * 1000;

/** How long one `t3` may take. */
const commandMs = 60_000;

/** A record is a few kilobytes; a larger one is no record of ours. */
const recordBytes = 16 * 1024;

export type FirstMeetingState = "owed" | "sent" | "refused" | "expired";

export type FirstMeetingRecord = Readonly<{
  /** The confirmation it greets: the persona's `confirmed_at`. */
  confirmedAt: string;
  /** T3 Code's idempotency key, from the confirmation. */
  key: string;
  /** The turn's exact text. */
  text: string;
  state: FirstMeetingState;
  /** A refusal's code, as T3 Code names it. */
  reason?: string;
}>;

/** T3 Code's idempotency key of the turn: the confirmation's time, digits
 * only. */
export const firstMeetingKey = (confirmedAt: string): string =>
  `lazurio-first-meeting-${confirmedAt.replace(/[^0-9]/g, "")}`;

/** The turn's text: Lazurio's note to Buddy, in the Folder's language, with
 * the greeting of the prototype in the person's address. He forms the
 * Czech vocative himself; the persona keeps its three forms. Buddy's own
 * words say nothing about the person's gender ("rád" is his own), name no
 * tool, model or service, list nothing he can do and are not signed. The
 * last sentence is his limit by root decision 0089: nothing that cannot be
 * undone without the person's consent. */
export function firstMeetingText(
  persona: Pick<Persona, "address" | "user">,
  locale: PersonaLocale,
): string {
  const name = persona.user.nominative.trim();
  if (locale === "en")
    return [
      "Lazurio: first meeting. This is an internal note for you: the user does not see it, only your reply.",
      `The user has just finished meeting you in Getting started. Call them “${name}”. Your reply is the first message they see from you in the chat.`,
      "Reply with exactly this message, in three short paragraphs:",
      `Hi ${name}, nice to meet you.`,
      "Tell me what's ahead of you this week, and I'll make sure nothing slips.",
      "I won't do anything irreversible without your OK.",
      "Add nothing else: no emoji, no list of what you can do, no names of tools or services, and no signature.",
    ].join("\n\n");
  const ty = persona.address === "ty";
  return [
    "Lazurio: první seznámení. Toto je interní pokyn pro tebe: uživatel ho nevidí, uvidí jen tvoji odpověď.",
    `Uživatel s tebou právě v Začínáme dokončil seznámení. Říkej mu „${name}“ a ${ty ? "tykej mu" : "vykej mu"}. Tvoje odpověď je první zpráva, kterou od tebe v chatu uvidí.`,
    "Odpověz právě touto zprávou ve třech krátkých odstavcích, jméno ve 5. pádě a oddělené čárkami:",
    ty
      ? "Ahoj, <jméno ve 5. pádě>, rád tě poznávám."
      : "Ahoj, <jméno ve 5. pádě>, rád vás poznávám.",
    ty
      ? "Napiš mi, co tě tento týden čeká, a já pohlídám, ať na nic nezapomeneš."
      : "Napište mi, co vás tento týden čeká, a já pohlídám, ať na nic nezapomenete.",
    ty
      ? "Nic nevratného neudělám bez tvého souhlasu."
      : "Nic nevratného neudělám bez vašeho souhlasu.",
    "Nic dalšího nepřidávej: žádné emoji, žádný seznam toho, co umíš, žádné názvy nástrojů ani služeb a žádný podpis.",
  ].join("\n\n");
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const states: readonly string[] = ["owed", "sent", "refused", "expired"];

/** The record as it is: none where there is no file, a link, another kind
 * of file, one larger than a record, or one of another schema or shape. */
export async function readFirstMeeting(
  home: string,
): Promise<FirstMeetingRecord | null> {
  try {
    const handle = await open(
      firstMeetingPath(home),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > recordBytes) return null;
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const value: unknown = JSON.parse(text);
    if (
      !isObject(value) ||
      value.schema_version !== firstMeetingSchema ||
      typeof value.confirmed_at !== "string" ||
      typeof value.key !== "string" ||
      typeof value.text !== "string" ||
      typeof value.state !== "string" ||
      !states.includes(value.state) ||
      !(value.reason === undefined || typeof value.reason === "string")
    )
      return null;
    return Object.freeze({
      confirmedAt: value.confirmed_at,
      key: value.key,
      text: value.text,
      state: value.state as FirstMeetingState,
      ...(value.reason === undefined ? {} : { reason: value.reason }),
    });
  } catch {
    return null;
  }
}

const writeRecord = (home: string, record: FirstMeetingRecord) =>
  writeBuddyStateFile(firstMeetingPath(home), {
    schema_version: firstMeetingSchema,
    confirmed_at: record.confirmedAt,
    key: record.key,
    text: record.text,
    state: record.state,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  });

/** The refusals of `t3 thread send` that sending the same key again never
 * fixes (Lazurio/t3code#105, as Delegace's `T3_FINAL_REFUSALS`). */
export const t3FinalRefusals: readonly string[] = Object.freeze([
  "idempotency_conflict",
  "command_rejected",
  "thread_not_found",
  "thread_not_sendable",
  "invalid_request",
  "capability_denied",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
]);

/** A thread's id as Delegace takes it (`THREAD_ID_RE`): never one that would
 * read as an option. */
const threadId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** What one delivery did: nothing owed; the turn sent; refused or expired,
 * recorded and never tried again; or still owed (`waiting`: no T3 Code of
 * Buddy's, none running, no answer, or a failure that may pass). */
export type FirstMeetingDelivery =
  | "none"
  | "sent"
  | "refused"
  | "expired"
  | "waiting";

export type FirstMeetingJournal = (
  entry: Readonly<{
    operation: "owe" | "deliver";
    outcome: string;
    reason?: string;
  }>,
) => void;

/** The Launchpad's side: `owe` after the first confirmation, `deliver` when
 * Buddy's persona is applied and on later readings, one delivery at a time
 * in this process. The journal names the operation, the outcome and a
 * refusal's code, never a name, the text or the key. */
export function createFirstMeeting(
  input: Readonly<{
    home: string;
    path?: string | undefined;
    xdg?: Readonly<Record<string, string>> | undefined;
    run: ToolRunner;
    journal?: FirstMeetingJournal | undefined;
    now?: (() => Date) | undefined;
  }>,
) {
  const now = input.now ?? (() => new Date());
  const journal: FirstMeetingJournal = (entry) => input.journal?.(entry);
  let delivering: Promise<FirstMeetingDelivery> | null = null;

  /** Exactly the environment of Delegace's own `t3`: the account's home,
   * PATH and XDG base directories, and the acting sender T3 Code hides from
   * the person; none of Buddy's own acting names. */
  const environment = (): Record<string, string> => ({
    HOME: input.home,
    ...(input.path ? { PATH: input.path } : {}),
    ...(input.xdg ?? {}),
    T3CODE_ACTING_SENDER: "delegace",
  });

  async function t3(
    runtime: string,
    args: readonly string[],
    stdin?: string,
  ): Promise<Readonly<{ code: number; data: Json | null }> | null> {
    const result = await input
      .run(
        [
          runtime,
          ...args,
          ...(stdin === undefined ? [] : ["--message-file", "-"]),
          "--base-dir",
          join(input.home, buddyT3Home),
          "--json",
        ],
        commandMs,
        environment(),
        stdin === undefined
          ? { maxBytes: 64 * 1024 }
          : { maxBytes: 64 * 1024, stdin },
      )
      .catch(() => "timeout" as const);
    if (result === "timeout") return null;
    let data: unknown = null;
    try {
      data = JSON.parse(result.stdout);
    } catch {}
    return { code: result.exitCode, data: isObject(data) ? data : null };
  }

  async function attempt(): Promise<FirstMeetingDelivery> {
    const record = await readFirstMeeting(input.home);
    if (record === null || record.state !== "owed") return "none";
    const confirmed = Date.parse(record.confirmedAt);
    if (
      !Number.isFinite(confirmed) ||
      now().getTime() - confirmed > firstMeetingWithinMs
    ) {
      await writeRecord(input.home, { ...record, state: "expired" });
      journal({ operation: "deliver", outcome: "expired" });
      return "expired";
    }
    const runtime = await buddyT3Runtime(input.home);
    if (runtime === undefined) return "waiting";
    const found = await t3(runtime, ["lazurio", "buddy", "thread"]);
    const thread = found?.data?.threadId;
    if (
      found === null ||
      found.code !== 0 ||
      typeof thread !== "string" ||
      !threadId.test(thread)
    )
      return "waiting";
    const sent = await t3(
      runtime,
      [
        "thread",
        "send",
        thread,
        "--mode",
        "queue",
        "--idempotency-key",
        record.key,
      ],
      record.text,
    );
    if (sent === null) return "waiting";
    const error = sent.data?.error;
    if (sent.code === 0 && sent.data !== null && error === undefined) {
      await writeRecord(input.home, { ...record, state: "sent" });
      journal({ operation: "deliver", outcome: "sent" });
      return "sent";
    }
    const refusal = isObject(error) ? error.code : undefined;
    if (
      sent.code !== 0 &&
      typeof refusal === "string" &&
      t3FinalRefusals.includes(refusal)
    ) {
      await writeRecord(input.home, {
        ...record,
        state: "refused",
        reason: refusal,
      });
      journal({ operation: "deliver", outcome: "refused", reason: refusal });
      return "refused";
    }
    return "waiting";
  }

  return Object.freeze({
    /** The person confirmed Buddy's names for the first time: his first
     * meeting's turn is owed, once for this confirmation. A record of the
     * same confirmation stays as it is, whatever its state; one of another
     * confirmation (a persona that was confirmed anew) gives way. */
    async owe(
      persona: Pick<Persona, "address" | "user" | "confirmedAt">,
      locale: PersonaLocale,
    ): Promise<boolean> {
      const confirmedAt = persona.confirmedAt;
      if (confirmedAt === undefined) return false;
      const before = await readFirstMeeting(input.home);
      if (before?.confirmedAt === confirmedAt) return false;
      await writeRecord(input.home, {
        confirmedAt,
        key: firstMeetingKey(confirmedAt),
        text: firstMeetingText(persona, locale),
        state: "owed",
      });
      journal({ operation: "owe", outcome: "owed" });
      return true;
    },

    /** Whether a turn is owed now (its record says so). */
    async owed(): Promise<boolean> {
      return (await readFirstMeeting(input.home))?.state === "owed";
    },

    /** Sends what is owed, if anything; the one under way where one runs. */
    deliver(): Promise<FirstMeetingDelivery> {
      delivering ??= attempt()
        .catch((): FirstMeetingDelivery => "waiting")
        .finally(() => {
          delivering = null;
        });
      return delivering;
    },
  });
}

export type FirstMeeting = ReturnType<typeof createFirstMeeting>;
