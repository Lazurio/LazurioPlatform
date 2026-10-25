import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  owePromptRefresh,
  promptInputsPath,
  promptRefreshMarked,
  readPromptInputs,
  recordPromptInputs,
  settlePromptRefresh,
} from "../src/buddy/gateway-refresh";
import { personaPath, writePersona } from "../src/buddy/persona";
import type { BuddyPersona } from "../src/buddy/persona-apply";
import {
  createPersonaSave,
  type PersonaInvalid,
  type PersonaJournalEntry,
  type PersonaTimers,
  personaFailedRetryMs,
  personaRetryMs,
} from "../src/buddy/persona-save";
import { buddyRulesPath } from "../src/folder/outputs";

// Decision F65: Buddy's persona as Začínáme and Nastavení → Buddy read and
// change it, over F64's core. A change is written only over the file the
// page read and checked as the installer checks it; F64's apply brings it to
// Buddy, and what waits for him to be idle the Launchpad finishes by itself.
// The journal never carries a name, a value or a revision.

const posix = test.skipIf(process.platform === "win32");

const values = {
  buddyName: "Rex",
  address: "ty",
  user: { nominative: "Ada", accusative: "Adu", dative: "Adě" },
} as const;

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A timer the test moves by hand. */
function handTimers() {
  let next = 0;
  const due = new Map<number, Readonly<{ at: number; run: () => void }>>();
  let clock = Date.UTC(2026, 9, 25, 6, 0, 0);
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
    /** The retries still set, as delays from now. */
    set: () => [...due.values()].map(({ at }) => at - clock).sort(),
    /** The clock moves; every timer due runs. */
    async pass(ms: number) {
      clock += ms;
      for (const [id, timer] of [...due.entries()])
        if (timer.at <= clock) {
          due.delete(id);
          timer.run();
        }
      await tick();
    },
  };
}

/** F64's apply, answering what the test lines up, the last one again. */
function applies(...answers: BuddyPersona["state"][]) {
  let calls = 0;
  return {
    calls: () => calls,
    apply: async (): Promise<BuddyPersona> => {
      const state =
        answers[Math.min(calls, answers.length - 1)] ?? ("applied" as const);
      calls += 1;
      return state === "waiting"
        ? { kind: "buddy-persona", state, restart: "pending" }
        : state === "failed"
          ? {
              kind: "buddy-persona",
              state,
              reason: "gateway-restart-failed",
              restart: "failed",
            }
          : state === "applied"
            ? {
                kind: "buddy-persona",
                state,
                restart: "done",
                prompts: { state: "refreshed", refreshed: 2, live: 2 },
              }
            : { kind: "buddy-persona", state, reason: "hermes-home-missing" };
    },
  };
}

/** Where Buddy reads his rules: `.agents/buddy/.hermes.md` of the Folder. */
const rulesOf = (folder: string) => join(folder, buddyRulesPath);

/** A home with Buddy's persona and a Folder with his rules, which his last
 * complete refresh was built from (F64's addendum of 2026-10-25), as an
 * installed Buddy's. */
async function within(
  body: (home: string, folder: string) => Promise<void>,
  options: Readonly<{ persona?: boolean }> = {},
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "persona-save-")));
  const folder = join(home, "Lazurio");
  try {
    if (options.persona !== false) {
      await mkdir(dirname(personaPath(home)), { recursive: true, mode: 0o700 });
      expect((await writePersona(home, values, null)).kind).toBe("written");
    }
    await mkdir(dirname(rulesOf(folder)), { recursive: true, mode: 0o700 });
    await writeFile(rulesOf(folder), "Buddy's rules of this release\n", {
      mode: 0o600,
    });
    await recordPromptInputs(home, await readPromptInputs(folder));
    await body(home, folder);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

posix(
  "the persona as the page shows it: the names, whether confirmed, the revision of its file; none without one",
  async () => {
    await within(async (home, folder) => {
      const save = createPersonaSave({ home, folder, apply: applies().apply });
      expect(await save.read()).toEqual({
        buddyName: "Rex",
        address: "ty",
        user: { nominative: "Ada", accusative: "Adu", dative: "Adě" },
        confirmed: false,
        revision: await sha256(personaPath(home)),
        pending: false,
      });
      save.close();
    });
    await within(
      async (home, folder) => {
        const save = createPersonaSave({
          home,
          folder,
          apply: applies().apply,
        });
        expect(await save.read()).toBeNull();
        // No home known: nothing read, nothing written.
        const none = createPersonaSave({
          home: undefined,
          folder,
          apply: applies().apply,
        });
        expect(await none.read()).toBeNull();
        expect(await none.save(values, null)).toEqual({
          kind: "blocked",
          reason: "persona-unsafe",
        });
      },
      { persona: false },
    );
  },
);

posix(
  "a change is written over the file the page read, then applied; the confirmation stays once given; the journal names no name, value or revision",
  async () => {
    await within(async (home, folder) => {
      const journal: PersonaJournalEntry[] = [];
      const fake = applies("applied");
      const hand = handTimers();
      const save = createPersonaSave({
        home,
        folder,
        apply: fake.apply,
        journal: (entry) => journal.push(entry),
        now: hand.now,
        timers: hand.timers,
      });
      const before = await save.read();
      if (before === null) throw new Error("no persona");
      const answer = await save.save(
        {
          buddyName: "Mattyčus",
          address: "vy",
          user: { nominative: "Ada", accusative: "Adu", dative: "Adě" },
          confirm: true,
        },
        before.revision,
      );
      const revision = await sha256(personaPath(home));
      expect(answer).toEqual({
        kind: "persona",
        outcome: "written",
        persona: {
          buddyName: "Mattyčus",
          address: "vy",
          user: { nominative: "Ada", accusative: "Adu", dative: "Adě" },
          confirmed: true,
          revision,
          pending: false,
        },
        applied: { state: "applied", restart: "done", prompts: 2 },
      });
      expect(fake.calls()).toBe(1);
      const file = JSON.parse(await readFile(personaPath(home), "utf8"));
      expect(file.buddy_name).toBe("Mattyčus");
      expect(file.confirmed_at).toBe("2026-10-25T06:00:00Z");
      // A later change without confirm keeps the first confirmation.
      const again = await save.save(
        { ...values, buddyName: "Mattyčus" },
        revision,
      );
      expect(again.kind === "persona" && again.persona.confirmed).toBe(true);
      expect(
        JSON.parse(await readFile(personaPath(home), "utf8")).confirmed_at,
      ).toBe("2026-10-25T06:00:00Z");
      // The same values again: nothing to write, still applied.
      const same = await save.save(
        { ...values, buddyName: "Mattyčus" },
        await sha256(personaPath(home)),
      );
      expect(same.kind === "persona" && same.outcome).toBe("unchanged");
      expect(journal).toEqual([
        { operation: "apply", outcome: "applied" },
        { operation: "save", outcome: "written", applied: "applied" },
        { operation: "save", outcome: "written", applied: "applied" },
        { operation: "save", outcome: "unchanged", applied: "applied" },
      ]);
      const everything = JSON.stringify(journal);
      for (const secret of ["Mattyčus", "Rex", "Ada", "Adu", "Adě", revision])
        expect(everything).not.toContain(secret);
      save.close();
    });
  },
);

posix(
  "a change over another revision is persona-changed with the persona as it is now, and writes nothing",
  async () => {
    await within(async (home, folder) => {
      const journal: PersonaJournalEntry[] = [];
      const fake = applies("applied");
      const save = createPersonaSave({
        home,
        folder,
        apply: fake.apply,
        journal: (entry) => journal.push(entry),
      });
      const before = await readFile(personaPath(home), "utf8");
      const answer = await save.save(
        { ...values, buddyName: "Bob" },
        "0".repeat(64),
      );
      expect(answer).toEqual({
        kind: "blocked",
        reason: "persona-changed",
        current: {
          buddyName: "Rex",
          address: "ty",
          user: { nominative: "Ada", accusative: "Adu", dative: "Adě" },
          confirmed: false,
          revision: await sha256(personaPath(home)),
          pending: false,
        },
      });
      // A page that read no persona, where there is one.
      expect((await save.save(values, null)).kind).toBe("blocked");
      expect(await readFile(personaPath(home), "utf8")).toBe(before);
      expect(fake.calls()).toBe(0);
      expect(journal).toEqual([
        { operation: "save", outcome: "refused", reason: "persona-changed" },
        { operation: "save", outcome: "refused", reason: "persona-changed" },
      ]);
      save.close();
    });
  },
);

posix(
  "each member the installer would refuse is named, whatever the file, and nothing is written",
  async () => {
    await within(async (home, folder) => {
      const journal: PersonaJournalEntry[] = [];
      const fake = applies("applied");
      const save = createPersonaSave({
        home,
        folder,
        apply: fake.apply,
        journal: (entry) => journal.push(entry),
      });
      const before = await readFile(personaPath(home), "utf8");
      const user = values.user;
      const cases: [Parameters<typeof save.save>[0], PersonaInvalid][] = [
        [{ ...values, buddyName: "" }, "invalid-buddy-name"],
        [{ ...values, buddyName: "Rex{}" }, "invalid-buddy-name"],
        [{ ...values, buddyName: "x".repeat(61) }, "invalid-buddy-name"],
        [{ ...values, address: "oni" }, "invalid-address"],
        [
          { ...values, user: { ...user, nominative: " " } },
          "invalid-user-nominative",
        ],
        [
          { ...values, user: { ...user, accusative: 'Ad"u' } },
          "invalid-user-accusative",
        ],
        [
          { ...values, user: { ...user, dative: "A\nda" } },
          "invalid-user-dative",
        ],
      ];
      for (const [update, reason] of cases)
        expect({
          reason,
          answer: await save.save(update, "0".repeat(64)),
        }).toEqual({ reason, answer: { kind: "invalid", reason } });
      expect(await readFile(personaPath(home), "utf8")).toBe(before);
      expect(fake.calls()).toBe(0);
      // The journal names the member, never what was typed.
      expect(JSON.stringify(journal)).not.toContain("Rex{}");
      expect(journal.map((entry) => entry.reason)).toEqual(
        cases.map(([, reason]) => reason),
      );
      save.close();
    });
  },
);

posix(
  "while Buddy is busy the change waits: pending, and the Launchpad applies again until it is in place",
  async () => {
    await within(async (home, folder) => {
      const journal: PersonaJournalEntry[] = [];
      const fake = applies("waiting", "waiting", "applied");
      const hand = handTimers();
      const save = createPersonaSave({
        home,
        folder,
        apply: fake.apply,
        journal: (entry) => journal.push(entry),
        now: hand.now,
        timers: hand.timers,
      });
      const before = await save.read();
      if (before === null) throw new Error("no persona");
      const answer = await save.save(
        { ...values, buddyName: "Bob" },
        before.revision,
      );
      expect(answer.kind === "persona" && answer.applied).toEqual({
        state: "waiting",
        restart: "pending",
      });
      expect(answer.kind === "persona" && answer.persona.pending).toBe(true);
      expect(hand.set()).toEqual([personaRetryMs]);
      expect((await save.read())?.pending).toBe(true);
      await hand.pass(personaRetryMs);
      expect(fake.calls()).toBe(2);
      expect((await save.read())?.pending).toBe(true);
      await hand.pass(personaRetryMs);
      expect(fake.calls()).toBe(3);
      expect((await save.read())?.pending).toBe(false);
      expect(hand.set()).toEqual([]);
      // One line per outcome, not one per retry.
      expect(journal).toEqual([
        { operation: "apply", outcome: "waiting" },
        { operation: "save", outcome: "written", applied: "waiting" },
        { operation: "apply", outcome: "applied" },
      ]);
      save.close();
    });
  },
);

posix(
  "an apply that takes longer than a moment answers waiting and finishes on its own; a save joins the apply under way",
  async () => {
    await within(async (home, folder) => {
      let finish: (answer: BuddyPersona) => void = () => undefined;
      let calls = 0;
      const save = createPersonaSave({
        home,
        folder,
        apply: () => {
          calls += 1;
          return new Promise<BuddyPersona>((resolve) => {
            finish = resolve;
          });
        },
        answerWithinMs: 20,
      });
      const before = await save.read();
      if (before === null) throw new Error("no persona");
      const first = await save.save(
        { ...values, buddyName: "Bob" },
        before.revision,
      );
      expect(first.kind === "persona" && first.applied).toEqual({
        state: "waiting",
      });
      expect(first.kind === "persona" && first.persona.pending).toBe(true);
      const second = await save.save(
        { ...values, buddyName: "Bo" },
        first.kind === "persona" ? first.persona.revision : "",
      );
      expect(second.kind).toBe("persona");
      // One apply ran for both: F64's reads the persona again before it
      // answers.
      expect(calls).toBe(1);
      finish({ kind: "buddy-persona", state: "applied", restart: "done" });
      await tick();
      expect((await save.read())?.pending).toBe(false);
      save.close();
    });
  },
);

posix(
  "a refresh still owed after a restart of the Launchpad is taken up by a reading, once, not again a moment later",
  async () => {
    await within(async (home, folder) => {
      const fake = applies("unavailable");
      const hand = handTimers();
      const save = createPersonaSave({
        home,
        folder,
        apply: fake.apply,
        now: hand.now,
        timers: hand.timers,
      });
      expect((await save.read())?.pending).toBe(false);
      expect(fake.calls()).toBe(0);
      await owePromptRefresh(home);
      expect((await save.read())?.pending).toBe(true);
      await tick();
      expect(fake.calls()).toBe(1);
      // Nothing could be applied: no retry, and a reading right after asks
      // nothing again.
      expect(hand.set()).toEqual([]);
      await save.read();
      await tick();
      expect(fake.calls()).toBe(1);
      await hand.pass(personaRetryMs);
      await save.read();
      await tick();
      expect(fake.calls()).toBe(2);
      await settlePromptRefresh(home);
      expect((await save.read())?.pending).toBe(false);
      save.close();
    });
  },
);

posix(
  "a reading takes up the refresh Buddy's changed Lazurio layer owes as it takes up the marker (F64's addendum of 2026-10-25): it writes nothing itself and starts one apply; no record counts too",
  async () => {
    await within(async (home, folder) => {
      const fake = applies("applied");
      const hand = handTimers();
      const save = createPersonaSave({
        home,
        folder,
        apply: fake.apply,
        now: hand.now,
        timers: hand.timers,
      });
      expect((await save.read())?.pending).toBe(false);
      await tick();
      expect(fake.calls()).toBe(0);
      // A Platform update's Folder refresh rewrites his rules.
      const recorded = await readFile(promptInputsPath(home), "utf8");
      await writeFile(rulesOf(folder), "Buddy's rules of the next release\n");
      expect((await save.read())?.pending).toBe(true);
      await tick();
      expect(fake.calls()).toBe(1);
      // F64's apply is the one writer: the reading left both records alone.
      expect(await readFile(promptInputsPath(home), "utf8")).toBe(recorded);
      expect(await promptRefreshMarked(home)).toBe(false);
      // The apply refreshed and recorded the layer it began with.
      await recordPromptInputs(home, await readPromptInputs(folder));
      await hand.pass(personaRetryMs);
      expect((await save.read())?.pending).toBe(false);
      await tick();
      expect(fake.calls()).toBe(1);
      // No record, as on a Buddy before this release: owed as well.
      await rm(promptInputsPath(home));
      expect((await save.read())?.pending).toBe(true);
      await tick();
      expect(fake.calls()).toBe(2);
      save.close();
    });
  },
);

posix(
  "a failed apply is asked again later and later; an apply that throws counts as failed; after close nothing runs",
  async () => {
    await within(async (home, folder) => {
      const journal: PersonaJournalEntry[] = [];
      let calls = 0;
      const hand = handTimers();
      const save = createPersonaSave({
        home,
        folder,
        apply: async () => {
          calls += 1;
          if (calls === 1) throw new Error("spawn failed");
          return {
            kind: "buddy-persona",
            state: "failed",
            reason: "units-reload-failed",
          };
        },
        journal: (entry) => journal.push(entry),
        now: hand.now,
        timers: hand.timers,
      });
      const before = await save.read();
      if (before === null) throw new Error("no persona");
      const answer = await save.save(
        { ...values, buddyName: "Bob" },
        before.revision,
      );
      expect(answer.kind === "persona" && answer.applied).toEqual({
        state: "failed",
      });
      // Retried, so still on its way.
      expect(answer.kind === "persona" && answer.persona.pending).toBe(true);
      expect(hand.set()).toEqual([personaFailedRetryMs]);
      await hand.pass(personaFailedRetryMs);
      expect(calls).toBe(2);
      expect(hand.set()).toEqual([personaFailedRetryMs * 2]);
      save.close();
      expect(hand.set()).toEqual([]);
      expect(journal).toEqual([
        { operation: "apply", outcome: "failed" },
        { operation: "save", outcome: "written", applied: "failed" },
        {
          operation: "apply",
          outcome: "failed",
          reason: "units-reload-failed",
        },
      ]);
    });
  },
);
