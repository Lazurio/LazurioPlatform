import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFirstMeeting,
  type FirstMeetingDelivery,
  firstMeetingKey,
  firstMeetingPath,
  firstMeetingText,
  firstMeetingWithinMs,
  readFirstMeeting,
  t3FinalRefusals,
} from "../src/buddy/first-meeting";
import {
  readPromptInputs,
  recordPromptInputs,
} from "../src/buddy/gateway-refresh";
import { personaPath, readPersona, writePersona } from "../src/buddy/persona";
import type { BuddyPersona } from "../src/buddy/persona-apply";
import {
  createPersonaSave,
  type PersonaSaveAnswer,
  type PersonaTimers,
  personaFailedRetryMs,
  personaRetryMs,
} from "../src/buddy/persona-save";
import type { BuddySignIn } from "../src/buddy/sign-in";
import { buddyT3Unit } from "../src/buddy/t3-runtime";
import { buddyRulesPath } from "../src/folder/outputs";
import {
  buddyRoutePaths,
  createBuddyRoutes,
} from "../src/launchpad/buddy-routes";
import type { ToolProcessResult, ToolRunner } from "../src/tools/status";

// Buddy's first message (decision F60's addendum of 2026-10-26): after the
// person's first confirmation of his names the Launchpad gives him one turn
// in his conversation in Lazurio, which T3 Code shows to Buddy and never to
// the person (the acting sender `delegace`, Lazurio/t3code#106), queued
// behind a turn of his, once per confirmation, never on Telegram. Buddy's T3
// Code is a fake `t3` with the shapes Delegace's tests record; example names
// only.

const posix = test.skipIf(process.platform === "win32");
const version = "0.1.2-lazurio.4";
const confirmedAt = "2026-10-26T17:05:12Z";
const confirmed = Date.parse(confirmedAt);

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** A home with Buddy's T3 Code installed as Machines install it. */
async function home(
  body: (user: string, runtime: string) => Promise<void>,
  options: Readonly<{ unit?: boolean }> = {},
) {
  const user = await realpath(await mkdtemp(join(tmpdir(), "first-meeting-")));
  try {
    const versions = join(user, ".t3-buddy", "runtime", "versions");
    const runtime = join(versions, version, "t3");
    if (options.unit !== false) {
      const units = join(user, ".config", "systemd", "user");
      await mkdir(units, { recursive: true });
      await mkdir(join(versions, version), { recursive: true });
      await writeFile(runtime, "#!/bin/sh\nexit 0\n");
      await chmod(runtime, 0o755);
      await writeFile(
        join(units, buddyT3Unit),
        `[Service]\nExecStart=${runtime} serve --base-dir ${join(user, ".t3-buddy")}\n`,
      );
    }
    await body(user, runtime);
  } finally {
    await rm(user, { recursive: true, force: true });
  }
}

type Call = Readonly<{
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: string | undefined;
}>;

/** Buddy's T3 Code as `t3` answers: its thread, then each send as lined up
 * (the last one again). */
function fakeT3(
  ...sends: (
    | "sent"
    | "not-running"
    | "timeout"
    | Readonly<{ refused: string }>
    | "garbled"
    | "error-anyway"
  )[]
) {
  const calls: Call[] = [];
  let sent = 0;
  let thread: "found" | "not-running" = "found";
  const run: ToolRunner = async (command, _timeout, env, options) => {
    calls.push({ command, env, stdin: options?.stdin });
    const json = (exitCode: number, value: unknown): ToolProcessResult => ({
      exitCode,
      stdout: JSON.stringify(value),
      stderr: "",
    });
    if (command[1] === "lazurio")
      return thread === "found"
        ? json(0, { threadId: "buddy", projectId: "project-buddy" })
        : json(3, {
            error: { code: "not_running", message: "T3 Code is not running." },
          });
    const answer = sends[Math.min(sent, sends.length - 1)] ?? "sent";
    sent += 1;
    if (answer === "timeout") return "timeout";
    if (answer === "not-running")
      return json(3, {
        error: { code: "not_running", message: "T3 Code is not running." },
      });
    if (answer === "garbled")
      return { exitCode: 1, stdout: "no json", stderr: "" };
    // Exit 0 with an error is no send either (as Delegace reads it).
    if (answer === "error-anyway")
      return json(0, { error: { code: "request_failed", message: "Lost." } });
    if (answer === "sent")
      return json(0, { threadId: "buddy", delivery: "queued" });
    return json(1, {
      error: { code: answer.refused, message: "Refused." },
    });
  };
  return {
    run,
    calls,
    sends: () => calls.filter((call) => call.command[1] === "thread"),
    threadDown: () => {
      thread = "not-running";
    },
    threadUp: () => {
      thread = "found";
    },
  };
}

const persona = (address: "ty" | "vy", nominative = "Alena") =>
  ({
    address,
    user: { nominative, accusative: "Alenu", dative: "Aleně" },
    confirmedAt,
  }) as const;

test("the turn is Lazurio's note to Buddy with the prototype's greeting in the person's address, in the Folder's language; its key is the confirmation's", () => {
  const vy = firstMeetingText(persona("vy"), "cs");
  expect(vy).toContain("uživatel ho nevidí, uvidí jen tvoji odpověď");
  expect(vy).toContain("Říkej mu „Alena“ a vykej mu.");
  for (const line of [
    "Ahoj, <jméno ve 5. pádě>, rád vás poznávám.",
    "Napište mi, co vás tento týden čeká, a já pohlídám, ať na nic nezapomenete.",
    "Nic nevratného neudělám bez vašeho souhlasu.",
  ])
    expect(vy.split("\n\n")).toContain(line);
  const ty = firstMeetingText(persona("ty", "Bob"), "cs");
  expect(ty).toContain("Říkej mu „Bob“ a tykej mu.");
  for (const line of [
    "Ahoj, <jméno ve 5. pádě>, rád tě poznávám.",
    "Napiš mi, co tě tento týden čeká, a já pohlídám, ať na nic nezapomeneš.",
    "Nic nevratného neudělám bez tvého souhlasu.",
  ])
    expect(ty.split("\n\n")).toContain(line);
  expect(ty).not.toContain("vás");
  const en = firstMeetingText(persona("vy"), "en");
  for (const line of [
    "Hi Alena, nice to meet you.",
    "Tell me what's ahead of you this week, and I'll make sure nothing slips.",
    "I won't do anything irreversible without your OK.",
  ])
    expect(en.split("\n\n")).toContain(line);
  // Nothing of the mechanism, no tool, no emoji asked of him; a name keeps
  // its own spaces trimmed.
  for (const text of [vy, ty, en]) {
    expect(text).not.toMatch(/delegace|hermes|t3|mausbot|telegram/i);
    expect(text).toMatch(/emoji/);
  }
  expect(firstMeetingText(persona("vy", " Alena "), "cs")).toBe(vy);
  expect(firstMeetingKey(confirmedAt)).toBe(
    "lazurio-first-meeting-20261026170512",
  );
});

posix(
  "once per confirmation: owed and recorded first, sent once into his one thread queued behind his turn, as Delegace's kind T3 Code hides; never again",
  async () => {
    await home(async (user, runtime) => {
      const t3 = fakeT3("sent");
      const journal: unknown[] = [];
      const meeting = createFirstMeeting({
        home: user,
        path: "/usr/bin:/bin",
        run: t3.run,
        journal: (entry) => journal.push(entry),
        now: () => new Date(confirmed + 60_000),
      });
      expect(await meeting.deliver()).toBe("none");
      expect(t3.calls).toEqual([]);
      expect(await meeting.owe(persona("ty"), "cs")).toBe(true);
      // The same confirmation again owes nothing more.
      expect(await meeting.owe(persona("ty"), "cs")).toBe(false);
      const record = await readFirstMeeting(user);
      expect(record).toEqual({
        confirmedAt,
        key: firstMeetingKey(confirmedAt),
        text: firstMeetingText(persona("ty"), "cs"),
        state: "owed",
      });
      // Private, as F64's records beside it.
      const info = await lstat(firstMeetingPath(user));
      expect(info.mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(firstMeetingPath(user)))).mode & 0o777).toBe(
        0o700,
      );
      expect(await meeting.deliver()).toBe("sent");
      // Exactly Delegace's two commands, with Buddy's own runtime and home.
      const base = ["--base-dir", join(user, ".t3-buddy"), "--json"];
      expect(t3.calls.map((call) => call.command)).toEqual([
        [runtime, "lazurio", "buddy", "thread", ...base],
        [
          runtime,
          "thread",
          "send",
          "buddy",
          "--mode",
          "queue",
          "--idempotency-key",
          "lazurio-first-meeting-20261026170512",
          "--message-file",
          "-",
          ...base,
        ],
      ]);
      // The text only on stdin, never on the command line.
      expect(t3.calls[1]?.stdin).toBe(firstMeetingText(persona("ty"), "cs"));
      expect(t3.calls.flatMap((call) => call.command).join(" ")).not.toContain(
        "Alena",
      );
      // The acting sender T3 Code hides from the person, and none of
      // Buddy's own names.
      for (const call of t3.calls)
        expect(call.env).toEqual({
          HOME: user,
          PATH: "/usr/bin:/bin",
          T3CODE_ACTING_SENDER: "delegace",
        });
      expect((await readFirstMeeting(user))?.state).toBe("sent");
      // Sent: never again, whoever asks.
      expect(await meeting.deliver()).toBe("none");
      expect(await meeting.owe(persona("ty"), "cs")).toBe(false);
      expect(t3.sends().length).toBe(1);
      // The journal names no name, text or key.
      expect(journal).toEqual([
        { operation: "owe", outcome: "owed" },
        { operation: "deliver", outcome: "sent" },
      ]);
      // A new confirmation (a persona confirmed anew) owes its own.
      expect(
        await meeting.owe(
          { ...persona("vy"), confirmedAt: "2026-10-27T08:00:00Z" },
          "cs",
        ),
      ).toBe(true);
      expect((await readFirstMeeting(user))?.key).toBe(
        "lazurio-first-meeting-20261027080000",
      );
    });
  },
);

posix(
  "busy or away: T3 Code queues it behind his turn; while T3 Code is not there or does not answer it stays owed and goes later with the same key and text",
  async () => {
    await home(async (user) => {
      const t3 = fakeT3(
        "not-running",
        "timeout",
        "garbled",
        "error-anyway",
        "sent",
      );
      const meeting = createFirstMeeting({
        home: user,
        run: t3.run,
        now: () => new Date(confirmed + 60_000),
      });
      await meeting.owe(persona("vy"), "cs");
      const outcomes: FirstMeetingDelivery[] = [];
      for (let attempt = 0; attempt < 5; attempt++)
        outcomes.push(await meeting.deliver());
      expect(outcomes).toEqual([
        "waiting",
        "waiting",
        "waiting",
        "waiting",
        "sent",
      ]);
      const sends = t3.sends();
      expect(new Set(sends.map((call) => call.stdin)).size).toBe(1);
      expect(new Set(sends.map((call) => call.command.join(" "))).size).toBe(1);
      // Every send queues: it never steers or interrupts a turn of his.
      for (const call of sends) {
        const mode = call.command.indexOf("--mode");
        expect(call.command[mode + 1]).toBe("queue");
      }
      // A thread T3 Code cannot find yet: owed, nothing sent.
      await meeting.owe(
        { ...persona("vy"), confirmedAt: "2026-10-26T18:00:00Z" },
        "cs",
      );
      t3.threadDown();
      const before = t3.sends().length;
      expect(await meeting.deliver()).toBe("waiting");
      expect(t3.sends().length).toBe(before);
      t3.threadUp();
      expect(await meeting.deliver()).toBe("sent");
    });
    // No T3 Code of Buddy's: nothing runs at all, it waits.
    await home(
      async (user) => {
        const t3 = fakeT3("sent");
        const meeting = createFirstMeeting({
          home: user,
          run: t3.run,
          now: () => new Date(confirmed + 60_000),
        });
        await meeting.owe(persona("vy"), "cs");
        expect(await meeting.deliver()).toBe("waiting");
        expect(t3.calls).toEqual([]);
        expect((await readFirstMeeting(user))?.state).toBe("owed");
      },
      { unit: false },
    );
  },
);

posix(
  "a refusal the same key never fixes ends it, recorded with its code, and nothing goes elsewhere; a day later it is no greeting",
  async () => {
    for (const refusal of t3FinalRefusals)
      await home(async (user) => {
        const t3 = fakeT3({ refused: refusal });
        const meeting = createFirstMeeting({
          home: user,
          run: t3.run,
          now: () => new Date(confirmed + 60_000),
        });
        await meeting.owe(persona("vy"), "cs");
        expect(await meeting.deliver()).toBe("refused");
        expect(await readFirstMeeting(user)).toMatchObject({
          state: "refused",
          reason: refusal,
        });
        expect(await meeting.deliver()).toBe("none");
        // Only T3 Code was ever asked: no Telegram, no Kanban, no Hermes.
        expect(
          t3.calls.every((call) =>
            ["lazurio", "thread"].includes(call.command[1] ?? ""),
          ),
        ).toBe(true);
      });
    // Another refusal may pass: owed still.
    await home(async (user) => {
      const t3 = fakeT3({ refused: "request_failed" });
      const meeting = createFirstMeeting({
        home: user,
        run: t3.run,
        now: () => new Date(confirmed + 60_000),
      });
      await meeting.owe(persona("vy"), "cs");
      expect(await meeting.deliver()).toBe("waiting");
      expect((await readFirstMeeting(user))?.state).toBe("owed");
    });
    // A day after the confirmation: expired, nothing sent.
    await home(async (user) => {
      const t3 = fakeT3("sent");
      let now = confirmed + firstMeetingWithinMs;
      const meeting = createFirstMeeting({
        home: user,
        run: t3.run,
        now: () => new Date(now),
      });
      await meeting.owe(persona("vy"), "cs");
      now += 1;
      expect(await meeting.deliver()).toBe("expired");
      expect(t3.calls).toEqual([]);
      expect((await readFirstMeeting(user))?.state).toBe("expired");
      expect(await meeting.deliver()).toBe("none");
    });
  },
);

posix(
  "a record that is no record of ours owes nothing: a link, another schema, another shape",
  async () => {
    await home(async (user) => {
      const t3 = fakeT3("sent");
      const meeting = createFirstMeeting({
        home: user,
        run: t3.run,
        now: () => new Date(confirmed + 60_000),
      });
      await meeting.owe(persona("vy"), "cs");
      const path = firstMeetingPath(user);
      const text = await readFile(path, "utf8");
      const record = JSON.parse(text) as Record<string, unknown>;
      for (const changed of [
        { ...record, schema_version: "lazurio.buddy-first-meeting.v2" },
        { ...record, state: "maybe" },
        { ...record, text: 1 },
        [],
      ]) {
        await writeFile(path, JSON.stringify(changed));
        expect(await meeting.deliver()).toBe("none");
      }
      const elsewhere = join(user, "elsewhere.json");
      await writeFile(elsewhere, text);
      await rm(path);
      await symlink(elsewhere, path);
      expect(await readFirstMeeting(user)).toBeNull();
      expect(await meeting.deliver()).toBe("none");
      expect(t3.calls).toEqual([]);
    });
  },
);

// ---- In the Launchpad's persona (persona-save.ts) ---------------------------

/** A timer the test moves by hand. */
function handTimers() {
  let next = 0;
  const due = new Map<number, Readonly<{ at: number; run: () => void }>>();
  let clock = confirmed;
  const timers: PersonaTimers = {
    after: (run, ms) => {
      next += 1;
      due.set(next, { at: clock + ms, run });
      return next;
    },
    cancel: (timer) => {
      due.delete(timer as number);
    },
  };
  return {
    timers,
    now: () => new Date(clock),
    async pass(ms: number) {
      clock += ms;
      for (const [id, timer] of [...due.entries()])
        if (timer.at <= clock) {
          due.delete(id);
          timer.run();
        }
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Waits, in real time, until `check` holds or `ms` passed: the turn's record
 * is written after T3 Code answers, a moment after the fake counted the send,
 * and a busy machine may take longer than one `settle`. */
async function until(check: () => Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms;
  while (!(await check()) && Date.now() < end) await settle();
}

const sentRecord = (user: string) => async () =>
  (await readFirstMeeting(user))?.state === "sent";

const values = {
  buddyName: "Rex",
  address: "ty",
  user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
} as const;

type ApplyAnswer = "applied" | "waiting" | "failed" | "unavailable";

/** F64's apply answering what the test lines up, the last one again. */
function applies(...answers: ApplyAnswer[]) {
  let calls = 0;
  return {
    calls: () => calls,
    apply: async (): Promise<BuddyPersona> => {
      const state = answers[Math.min(calls, answers.length - 1)] ?? "applied";
      calls += 1;
      if (state === "failed")
        return { kind: "buddy-persona", state, reason: "files-unwritable" };
      if (state === "unavailable")
        return { kind: "buddy-persona", state, reason: "persona-busy" };
      return state === "waiting"
        ? { kind: "buddy-persona", state, restart: "pending" }
        : {
            kind: "buddy-persona",
            state,
            restart: "done",
            prompts: { state: "refreshed", refreshed: 1, live: 1 },
          };
    },
  };
}

async function launchpad(
  user: string,
  answers: ApplyAnswer[],
  t3 = fakeT3("sent"),
) {
  const folder = join(user, "Lazurio");
  await mkdir(dirname(join(folder, buddyRulesPath)), { recursive: true });
  await writeFile(join(folder, buddyRulesPath), "Buddy's rules\n");
  await recordPromptInputs(user, await readPromptInputs(folder));
  const hand = handTimers();
  const fake = applies(...answers);
  const save = createPersonaSave({
    home: user,
    folder,
    apply: fake.apply,
    now: hand.now,
    timers: hand.timers,
    answerWithinMs: 1_000,
    firstMeeting: {
      meeting: createFirstMeeting({ home: user, run: t3.run, now: hand.now }),
      locale: async () => "cs",
    },
  });
  return { save, hand, fake, t3 };
}

posix(
  "the first confirmation in Začínáme owes his first meeting and it goes once his persona is applied; a save that confirms nothing new owes nothing",
  async () => {
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      expect((await writePersona(user, values, null)).kind).toBe("written");
      const { save, t3 } = await launchpad(user, ["applied"]);
      const revision = await sha256(personaPath(user));
      // Pokračovat: the names with the confirmation.
      const answer = await save.save({ ...values, confirm: true }, revision);
      expect(answer).toMatchObject({ kind: "persona", outcome: "written" });
      await settle();
      expect(t3.sends().length).toBe(1);
      expect(t3.sends()[0]?.stdin).toContain("Říkej mu „Alena“ a tykej mu.");
      const read = await readPersona(user);
      const confirmedAt =
        read.state === "valid" ? read.persona.confirmedAt : undefined;
      expect((await readFirstMeeting(user))?.confirmedAt).toBe(confirmedAt);
      // Saved again with the confirmation, and from Settings: the first
      // confirmation stays, nothing more is owed or sent.
      const again = await save.save(
        { ...values, buddyName: "Max", confirm: true },
        await sha256(personaPath(user)),
      );
      expect(again).toMatchObject({ outcome: "written" });
      await save.save(
        { ...values, buddyName: "Ben" },
        await sha256(personaPath(user)),
      );
      await save.read();
      await settle();
      expect(t3.sends().length).toBe(1);
      save.close();
    });
    // A save without the confirmation owes nothing either.
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, values, null);
      const { save, t3 } = await launchpad(user, ["applied"]);
      await save.save(
        { ...values, buddyName: "Max" },
        await sha256(personaPath(user)),
      );
      await save.read();
      await settle();
      expect(t3.calls).toEqual([]);
      expect(await readFirstMeeting(user)).toBeNull();
      save.close();
    });
  },
);

posix(
  "while Buddy is busy his persona waits, and so does his first meeting; it goes once the apply is through, and a reading after a restart takes it up",
  async () => {
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, values, null);
      const { save, hand, fake, t3 } = await launchpad(user, [
        "waiting",
        "waiting",
        "applied",
      ]);
      await save.save(
        { ...values, confirm: true },
        await sha256(personaPath(user)),
      );
      await settle();
      expect((await readFirstMeeting(user))?.state).toBe("owed");
      expect(t3.calls).toEqual([]);
      // A reading meanwhile sends nothing: the persona still waits.
      await save.read();
      await settle();
      expect(t3.calls).toEqual([]);
      await hand.pass(15_000);
      expect(fake.calls()).toBe(2);
      expect(t3.calls).toEqual([]);
      await hand.pass(15_000);
      expect(fake.calls()).toBe(3);
      await until(sentRecord(user));
      expect(t3.sends().length).toBe(1);
      expect((await readFirstMeeting(user))?.state).toBe("sent");
      save.close();
    });
    // The apply restarted his T3 Code: not there for a moment, so the turn
    // is asked again 10 s later, and goes.
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, values, null);
      const { save, hand, t3 } = await launchpad(
        user,
        ["applied"],
        fakeT3("not-running", "not-running", "sent"),
      );
      await save.save(
        { ...values, confirm: true },
        await sha256(personaPath(user)),
      );
      await settle();
      expect(t3.sends().length).toBe(1);
      expect((await readFirstMeeting(user))?.state).toBe("owed");
      await hand.pass(9_000);
      expect(t3.sends().length).toBe(1);
      await hand.pass(1_000);
      expect(t3.sends().length).toBe(2);
      // Then 20 s later.
      await hand.pass(20_000);
      await until(sentRecord(user));
      expect(t3.sends().length).toBe(3);
      expect((await readFirstMeeting(user))?.state).toBe("sent");
      // Sent: nothing more is asked.
      await hand.pass(120_000);
      expect(t3.sends().length).toBe(3);
      save.close();
    });
    // The Launchpad restarted with the turn owed and T3 Code back: its first
    // reading applies once, so the persona is in place, then sends it.
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, { ...values, confirm: true }, null);
      const owed = createFirstMeeting({
        home: user,
        run: fakeT3("not-running").run,
        now: () => new Date(confirmed),
      });
      const read = await readPersona(user);
      if (read.state !== "valid") throw new Error("a persona");
      await owed.owe({ ...read.persona, confirmedAt: confirmedAt }, "cs");
      const { save, fake, t3 } = await launchpad(user, ["applied"]);
      await save.start();
      await until(sentRecord(user));
      expect(fake.calls()).toBe(1);
      expect(t3.sends().length).toBe(1);
      save.close();
    });
  },
);

posix(
  "an apply that fails or is refused sends no first meeting: the turn stays owed, every retry asks again, and it goes once an apply answers applied",
  async () => {
    // Failed (files that could not be written): no greeting in the old
    // names; the apply's own retry, 30 s later, applies and greets once.
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, values, null);
      const { save, hand, fake, t3 } = await launchpad(user, [
        "failed",
        "applied",
      ]);
      const answer = await save.save(
        { ...values, confirm: true },
        await sha256(personaPath(user)),
      );
      expect(answer).toMatchObject({
        kind: "persona",
        outcome: "written",
        applied: { state: "failed" },
      });
      await settle();
      expect(fake.calls()).toBe(1);
      expect(t3.calls).toEqual([]);
      expect((await readFirstMeeting(user))?.state).toBe("owed");
      // A reading meanwhile sends nothing: the failed apply's retry is due.
      await save.read();
      await settle();
      expect(t3.calls).toEqual([]);
      await hand.pass(personaFailedRetryMs);
      expect(fake.calls()).toBe(2);
      await until(sentRecord(user));
      expect(t3.sends().length).toBe(1);
      // Sent: nothing more is asked.
      await hand.pass(120_000);
      expect(t3.sends().length).toBe(1);
      save.close();
    });
    // Refused (another writer holds the persona): nothing either; a reading
    // after the retry pause applies, then greets once.
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, values, null);
      const { save, hand, fake, t3 } = await launchpad(user, [
        "unavailable",
        "applied",
      ]);
      await save.save(
        { ...values, confirm: true },
        await sha256(personaPath(user)),
      );
      await save.read();
      await settle();
      expect(fake.calls()).toBe(1);
      expect(t3.calls).toEqual([]);
      expect((await readFirstMeeting(user))?.state).toBe("owed");
      await hand.pass(personaRetryMs);
      await save.read();
      await until(sentRecord(user));
      expect(fake.calls()).toBe(2);
      expect(t3.sends().length).toBe(1);
      save.close();
    });
    // A greeting that waits for his T3 Code asks the gate again: an apply
    // that fails meanwhile holds it until an apply answers applied.
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      await writePersona(user, values, null);
      const { save, hand, fake, t3 } = await launchpad(
        user,
        ["applied", "failed", "applied"],
        fakeT3("not-running", "sent"),
      );
      await save.save(
        { ...values, confirm: true },
        await sha256(personaPath(user)),
      );
      await settle();
      expect(t3.sends().length).toBe(1);
      expect((await readFirstMeeting(user))?.state).toBe("owed");
      // A layer change starts another apply, which fails, before the
      // greeting's retry 10 s later.
      await save.save(
        { ...values, buddyName: "Max" },
        await sha256(personaPath(user)),
      );
      await settle();
      expect(fake.calls()).toBe(2);
      await hand.pass(10_000);
      expect(t3.sends().length).toBe(1);
      expect((await readFirstMeeting(user))?.state).toBe("owed");
      // The failed apply's retry applies; the turn goes.
      await hand.pass(personaFailedRetryMs);
      expect(fake.calls()).toBe(3);
      await until(sentRecord(user));
      expect(t3.sends().length).toBe(2);
      save.close();
    });
  },
);

posix(
  "only the write that records the person's first confirmation says so; a later one, one without confirm and the confirmation's repeat do not",
  async () => {
    await home(async (user) => {
      await mkdir(dirname(personaPath(user)), { recursive: true, mode: 0o700 });
      const first = await writePersona(user, values, null);
      expect(first).toMatchObject({ kind: "written" });
      expect(Object.hasOwn(first, "firstConfirmation")).toBe(false);
      const revision = await sha256(personaPath(user));
      const confirmed = await writePersona(
        user,
        { ...values, confirm: true },
        revision,
      );
      expect(confirmed).toMatchObject({
        kind: "written",
        firstConfirmation: true,
      });
      const again = await writePersona(
        user,
        { ...values, buddyName: "Max", confirm: true },
        await sha256(personaPath(user)),
      );
      expect(again.kind).toBe("written");
      expect(Object.hasOwn(again, "firstConfirmation")).toBe(false);
      const plain = await writePersona(
        user,
        { ...values, buddyName: "Ben" },
        await sha256(personaPath(user)),
      );
      expect(Object.hasOwn(plain, "firstConfirmation")).toBe(false);
      // The values the confirmation already wrote, again: nothing to write.
      const same = await writePersona(
        user,
        { ...values, buddyName: "Ben", confirm: true },
        await sha256(personaPath(user)),
      );
      expect(same.kind).toBe("unchanged");
    });
  },
);

test("his routes say when his step changed: a sign-in that finished, a sign-out, names written; nothing else", async () => {
  const changes: string[] = [];
  const answers: Record<string, Readonly<{ kind: string; reason?: string }>> = {
    start: { kind: "pending" },
    poll: { kind: "signed-in" },
    cancel: { kind: "cancelled" },
    signOut: { kind: "signed-out" },
  };
  let saved: "written" | "unchanged" = "written";
  const routes = createBuddyRoutes({
    present: () => true,
    signIn: {
      start: async () => answers.start,
      poll: async () => answers.poll,
      cancel: async () => answers.cancel,
      signOut: async () => answers.signOut,
    } as unknown as BuddySignIn,
    facts: async () => {
      throw new Error("not read here");
    },
    persona: {
      read: async () => null,
      save: async () =>
        ({
          kind: "persona",
          outcome: saved,
          persona: null,
          applied: { state: "applied" },
        }) as unknown as PersonaSaveAnswer,
    },
    locale: async () => "cs",
    headers: {},
    changed: () => changes.push("changed"),
  });
  const post = (path: string, body: unknown) =>
    routes.handle(
      new Request(`https://launchpad.ada.lazurio.io${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      new URL(`https://launchpad.ada.lazurio.io${path}`),
      () => undefined,
    );
  const session = { session: "0123456789abcdef0123456789abcdef" };
  await post(buddyRoutePaths.start, {});
  expect(changes).toEqual([]);
  await post(buddyRoutePaths.poll, session);
  expect(changes).toEqual(["changed"]);
  answers.poll = { kind: "pending" };
  await post(buddyRoutePaths.poll, session);
  await post(buddyRoutePaths.cancel, session);
  expect(changes).toEqual(["changed"]);
  await post(buddyRoutePaths.signOut, {});
  expect(changes).toEqual(["changed", "changed"]);
  const persona = {
    ...values,
    revision: null,
    confirm: true,
  };
  await post(buddyRoutePaths.persona, persona);
  expect(changes.length).toBe(3);
  saved = "unchanged";
  await post(buddyRoutePaths.persona, persona);
  expect(changes.length).toBe(3);
});
