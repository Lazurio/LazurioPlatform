import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buddyChat } from "../src/buddy/chat";
import { namesConfirmed } from "../src/buddy/names-confirmed";
import { writePersona } from "../src/buddy/persona";
import { buddyPersona } from "../src/buddy/persona-apply";
import { buddyFolderOwed } from "../src/buddy/persona-folder";
import { createPersonaSave } from "../src/buddy/persona-save";
import type { BuddySignIn } from "../src/buddy/sign-in";
import { type BuddyFacts, buddyStatus } from "../src/buddy/status";
import { buddyGeneration } from "../src/folder/machine-binding";
import {
  buddyFactsOf,
  buddyOpenOf,
  buddyT3Active,
} from "../src/launchpad/buddy-gate";
import {
  buddyRoutePaths,
  createBuddyRoutes,
} from "../src/launchpad/buddy-routes";
import {
  buddyFact,
  buddyOwnSignIn,
  parseBuddyReading,
  saveLine,
} from "../src/launchpad/buddy-view";
import { pairsBuddysOwnT3 } from "../src/launchpad/chat";
import { startDecision } from "../src/launchpad/first-run";
import { initializeMachineFolder } from "../src/machine/cli";
import type { ToolRunner } from "../src/tools/status";
import { binding, entries, withBuddy } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";

// Buddy GEN4 in the Launchpad (plan LZD-0033, R3): a converted person's
// Buddy is a thread of the shared T3 Code (Lazurio/t3code#229), so he has no
// Hermes, no ChatGPT sign-in and no Telegram of his own. His window opens on
// his origin once his names are confirmed and the shared T3 Code runs; it
// pairs as the Chat; his names go to `~/Buddy`.

const FOLDER = "/home/operator/Buddy";
const ORIGIN = "https://buddy.example.lazurio.io";
const converted = (origin = true) =>
  binding({
    ...personal,
    entry: {
      ...entries.personal,
      buddy: {
        generation: 4,
        folder: FOLDER,
        profile: "buddy",
        ...(origin ? { external_origin: ORIGIN } : {}),
      },
    },
  });
const gen3 = binding({ ...personal, entry: withBuddy(entries.personal) });
const none = binding({ ...personal, entry: entries.personal });

const shared = (active: boolean): BuddyFacts => ({
  runtime: "shared-t3",
  active,
});

test("the generation is 4 with Buddy's folder, 3 with only his origin, none without either", () => {
  expect(buddyGeneration(converted().entry)).toBe(4);
  expect(buddyGeneration(converted(false).entry)).toBe(4);
  expect(buddyGeneration(gen3.entry)).toBe(3);
  expect(buddyGeneration(none.entry)).toBeUndefined();
  expect(buddyGeneration(undefined)).toBeUndefined();
});

test("Buddy GEN4 needs no sign-in: he works while the shared T3 Code runs, and is open once his names are confirmed", () => {
  expect(buddyStatus(shared(true))).toEqual({
    state: "works",
    signIn: { state: "not-needed" },
  });
  // A stopped T3 Code is never quiet: not running, with no claim of a sign-in.
  expect(buddyStatus(shared(false))).toEqual({
    state: "unknown",
    reason: "not-running",
    signIn: { state: "not-needed" },
  });
  expect(buddyOpenOf(shared(true), true, true)).toBe(true);
  expect(buddyOpenOf(shared(true), false, true)).toBe(false);
  expect(buddyOpenOf(shared(true), true, false)).toBe(false);
});

test("Buddy GEN4's facts come from the shared T3 Code's unit, never from a Hermes gateway", async () => {
  const calls: (readonly string[])[] = [];
  const run: ToolRunner = async (command) => {
    calls.push(command);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const gateway = {
    request: async () => {
      throw new Error("no Hermes for Buddy GEN4");
    },
  } as unknown as Parameters<typeof buddyFactsOf>[1];
  const service = { run, env: {} };
  expect(
    await buddyFactsOf(converted().entry ?? null, gateway, service),
  ).toEqual(shared(true));
  expect(calls.at(-1)?.at(-1)).toBe("t3code.service");
  // Buddy GEN3's own unit stays his.
  expect(await buddyT3Active(service, gen3.entry)).toBe(true);
  expect(calls.at(-1)?.at(-1)).toBe("lazurio-t3-buddy.service");
});

test("the page reads Buddy GEN4 as signed in, with no sign-in or Telegram of his own", () => {
  const reading = parseBuddyReading({
    kind: "buddy",
    state: "works",
    signIn: { state: "not-needed" },
    locale: "cs",
    persona: null,
  });
  expect(reading?.signIn).toBe("not-needed");
  expect(buddyOwnSignIn(reading)).toBe(false);
  expect(
    buddyOwnSignIn(
      parseBuddyReading({
        kind: "buddy",
        state: "works",
        signIn: { state: "connected" },
        locale: "cs",
        persona: null,
      }),
    ),
  ).toBe(true);
});

test("Buddy GEN4's routes answer without Hermes: no Telegram read, and sign-in or Telegram changes refused as not needed", async () => {
  const asked = () => {
    throw new Error("not asked for Buddy GEN4");
  };
  const routes = createBuddyRoutes({
    present: () => true,
    shared: () => true,
    signIn: {
      start: asked,
      poll: asked,
      cancel: asked,
      signOut: asked,
    } as unknown as BuddySignIn,
    facts: async () => shared(true),
    persona: { read: async () => null, save: asked },
    telegram: {
      read: asked,
      connect: asked,
      approve: asked,
      disconnect: asked,
    },
    locale: async () => "cs",
    headers: {},
  });
  const at = (path: string) => `https://launchpad.example.lazurio.io${path}`;
  const read = await routes.handle(
    new Request(at(buddyRoutePaths.read)),
    new URL(at(buddyRoutePaths.read)),
    () => undefined,
  );
  expect(read.status).toBe(200);
  const body = await read.json();
  expect(body.signIn).toEqual({ state: "not-needed" });
  expect(body.telegram).toBeUndefined();
  for (const [path, payload] of [
    [buddyRoutePaths.start, {}],
    [buddyRoutePaths.signOut, {}],
    [buddyRoutePaths.telegramDisconnect, {}],
  ] as const) {
    const answer = await routes.handle(
      new Request(at(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      new URL(at(path)),
      () => undefined,
    );
    expect({ path, status: answer.status, body: await answer.json() }).toEqual({
      path,
      status: 409,
      body: { kind: "blocked", reason: "not-needed" },
    });
  }
});

test("Buddy GEN4's window pairs as the Chat; only Buddy GEN3's origin pairs his own T3 Code", () => {
  const fromBuddy = new Headers({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "buddy.example.lazurio.io",
  });
  const fromChat = new Headers({
    "x-forwarded-proto": "https",
    "x-forwarded-host": "t3code.example.lazurio.io",
  });
  const own = (entry: typeof gen3.entry, headers: Headers) =>
    pairsBuddysOwnT3(entry as NonNullable<typeof entry>, headers);
  expect(own(gen3.entry, fromBuddy)).toBe(true);
  expect(own(gen3.entry, fromChat)).toBe(false);
  expect(own(converted().entry, fromBuddy)).toBe(false);
  expect(own(converted().entry, fromChat)).toBe(false);
});

const posix = test.skipIf(process.platform === "win32");

posix(
  "Buddy GEN4's names go to ~/Buddy without Hermes, and `lazurio buddy chat` has nothing to set up",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "buddy-gen4-")));
    try {
      const folder = join(parent, "Lazurio");
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
      // The handover names the operator's home; here the Folder's temporary
      // home stands for it, as Buddy's folder must be exactly `<home>/Buddy`.
      const recorded = converted();
      const machine = {
        ...recorded,
        entry: {
          ...(recorded.entry as NonNullable<typeof recorded.entry>),
          buddyFolder: join(parent, "Buddy"),
        },
      };
      expect(
        (
          await initializeMachineFolder(folder, machine, {
            preset: undefined,
            locale: "cs",
            detail: undefined,
            coordination: undefined,
          })
        ).code,
      ).toBe(0);
      expect(
        (
          await writePersona(
            parent,
            {
              buddyName: "Bertík",
              address: "ty",
              user: {
                nominative: "Alena",
                accusative: "Alenu",
                dative: "Aleně",
              },
            },
            null,
          )
        ).kind,
      ).toBe("written");
      const run: ToolRunner = async () => {
        throw new Error("no tool runs for Buddy GEN4's persona");
      };
      const environment = {
        tools: { home: parent, path: "", platform: process.platform, run },
        env: {},
      } as unknown as Parameters<typeof buddyPersona>[0];
      // There is no `~/.hermes`: Buddy GEN4 needs none.
      const before = await buddyPersona(environment, { folder });
      expect(before.state).toBe("outdated");
      const applied = await buddyPersona(environment, {
        folder,
        apply: true,
        confirm: true,
      });
      expect(applied.state).toBe("applied");
      expect(applied.persona?.confirmed).toBe(true);
      const agents = await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8");
      expect(agents).toContain("Jsi Bertík, Buddy");
      expect((await buddyPersona(environment, { folder })).state).toBe(
        "in-place",
      );
      // A CLAUDE.md in ~/Buddy refuses the write: the names stay saved, his
      // instructions keep the last ones, and the apply says it failed.
      await writeFile(join(parent, "Buddy", "CLAUDE.md"), "# mine\n");
      const current = await buddyPersona(environment, { folder });
      expect(
        (
          await writePersona(
            parent,
            {
              buddyName: "Rexík",
              address: "ty",
              user: {
                nominative: "Alena",
                accusative: "Alenu",
                dative: "Aleně",
              },
            },
            current.persona?.revision ?? null,
          )
        ).kind,
      ).toBe("written");
      const refused = await buddyPersona(environment, { folder, apply: true });
      expect([refused.state, refused.reason]).toEqual([
        "failed",
        "files-unwritable",
      ]);
      expect(refused.persona?.buddyName).toBe("Rexík");
      expect(
        await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8"),
      ).toContain("Jsi Bertík, Buddy");
      expect(
        await buddyChat(environment.tools, { folder, apply: true }),
      ).toEqual({ kind: "buddy-chat", state: "skipped", reason: "shared-t3" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("a save whose names did not reach Buddy says so, never that it waits for him", () => {
  const copy = {
    buddyNotApplied: "not applied",
    buddyPending: "pending",
    buddySaved: "saved",
  } as unknown as Parameters<typeof saveLine>[1];
  expect(
    saveLine({ kind: "saved", pending: true, unapplied: true }, copy),
  ).toBe("not applied");
  expect(saveLine({ kind: "saved", pending: true }, copy)).toBe("pending");
  expect(saveLine({ kind: "saved", pending: false }, copy)).toBe("saved");
});

/** Waits until `ready`, at most 200 short ticks: the condition, not a time. */
async function until(ready: () => boolean | Promise<boolean>) {
  for (let round = 0; round < 200 && !(await ready()); round += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(await ready()).toBe(true);
}

posix(
  "the Launchpad's names of Buddy GEN4 are pending exactly while ~/Buddy lags them: a fresh apply settles, a refused one stays pending and is taken up again after a restart",
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "buddy-gen4-")));
    try {
      const folder = join(parent, "Lazurio");
      await mkdir(folder, { mode: 0o700 });
      await mkdir(join(folder, "organizations"), { mode: 0o700 });
      await mkdir(join(folder, "personalspace"), { mode: 0o700 });
      const recorded = converted();
      const machine = {
        ...recorded,
        entry: {
          ...(recorded.entry as NonNullable<typeof recorded.entry>),
          buddyFolder: join(parent, "Buddy"),
        },
      };
      expect(
        (
          await initializeMachineFolder(folder, machine, {
            preset: undefined,
            locale: "cs",
            detail: undefined,
            coordination: undefined,
          })
        ).code,
      ).toBe(0);
      const environment = {
        tools: {
          home: parent,
          path: "",
          platform: process.platform,
          run: async () => {
            throw new Error("no tool runs for Buddy GEN4's persona");
          },
        },
        env: {},
      } as unknown as Parameters<typeof buddyPersona>[0];
      let applies = 0;
      // The Launchpad's wiring (server.ts) for a converted person.
      const launchpad = () =>
        createPersonaSave({
          home: parent,
          folder,
          // Counted once done, so a later start never overlaps an apply.
          apply: () =>
            buddyPersona(environment, { folder, apply: true }).finally(() => {
              applies += 1;
            }),
          owed: () => buddyFolderOwed(folder),
          answerWithinMs: 5_000,
        });
      const names = (buddyName: string) => ({
        buddyName,
        address: "ty",
        user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
        confirm: true,
      });
      // A fresh converted home: no GEN3 prompt record, and nothing pending.
      const first = launchpad();
      expect((await first.read())?.pending ?? false).toBe(false);
      const saved = await first.save(names("Bertík"), null);
      expect(saved.kind).toBe("persona");
      expect(saved.kind === "persona" && saved.applied.state).toBe("applied");
      expect((await first.read())?.pending).toBe(false);
      const settled = applies;
      await first.read();
      await first.read();
      expect(applies).toBe(settled);
      expect(
        await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8"),
      ).toContain("Jsi Bertík, Buddy");
      // A CLAUDE.md in ~/Buddy refuses the next write: the names are saved,
      // pending, and his instructions keep the last ones.
      await writeFile(join(parent, "Buddy", "CLAUDE.md"), "# mine\n");
      const revision = (await first.read())?.revision ?? null;
      const refused = await first.save(names("Rexík"), revision);
      expect(refused.kind === "persona" && refused.applied.state).toBe(
        "failed",
      );
      expect((await first.read())?.pending).toBe(true);
      // The confirmed names are not in place: meeting and gate stay open.
      expect(namesConfirmed(await first.read(), true)).toBe(false);
      first.close();
      // After a restart with the folder still refused, the Launchpad finds
      // the names owed, tries again, and keeps meeting and gate open.
      const stillRefused = launchpad();
      const tried = applies;
      expect((await stillRefused.read())?.pending).toBe(true);
      await until(async () => applies > tried);
      expect((await stillRefused.read())?.pending).toBe(true);
      expect(namesConfirmed(await stillRefused.read(), true)).toBe(false);
      stillRefused.close();
      // Once the folder takes them, the next start settles: in place, and
      // the confirmation counts.
      await rm(join(parent, "Buddy", "CLAUDE.md"));
      const restarted = launchpad();
      const before = applies;
      expect((await restarted.read())?.pending).toBe(true);
      await until(async () => applies > before);
      await until(async () => (await restarted.read())?.pending === false);
      expect(namesConfirmed(await restarted.read(), true)).toBe(true);
      expect(
        await readFile(join(parent, "Buddy", "AGENTS.md"), "utf8"),
      ).toContain("Jsi Rexík, Buddy");
      restarted.close();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test("Buddy GEN4's meeting and gate stay incomplete while his confirmed names are owed to ~/Buddy", () => {
  const persona = (confirmed: boolean, pending: boolean) => ({
    buddyName: "Bertík",
    address: "ty" as const,
    user: { nominative: "Alena", accusative: "Alenu", dative: "Aleně" },
    confirmed,
    revision: "a".repeat(64),
    pending,
  });
  // The rule: Buddy GEN4 counts the names once they are in place.
  expect(namesConfirmed(persona(true, true), true)).toBe(false);
  expect(namesConfirmed(persona(true, false), true)).toBe(true);
  expect(namesConfirmed(persona(false, false), true)).toBe(false);
  expect(namesConfirmed(null, true)).toBe(false);
  // Buddy GEN3 counts the confirmation itself, as before.
  expect(namesConfirmed(persona(true, true), false)).toBe(true);
  // The gate: closed while owed.
  expect(
    buddyOpenOf(shared(true), namesConfirmed(persona(true, true), true), true),
  ).toBe(false);
  // The page's fact and Začínáme: while owed, the step is neither done nor
  // missing (`namesStep`, Matěj 2026-11-28: the tour must not lead back to a
  // step the person already did), and his bubble's request still opens the
  // meeting, so the gate's rule above stays the strict one.
  const reading = (pending: boolean) =>
    parseBuddyReading({
      kind: "buddy",
      state: "works",
      signIn: { state: "not-needed" },
      locale: "cs",
      persona: persona(true, pending),
    });
  const tour = (pending: boolean) => ({
    preset: "hosted-personal",
    ai: "missing" as const,
    github: "missing" as const,
    content: { state: "missing" } as never,
    buddy: buddyFact(reading(pending)),
  });
  expect(buddyFact(reading(true))).toEqual({
    signIn: "not-needed",
    confirmed: null,
  });
  expect(startDecision("meet-buddy", tour(true))).toBe("meet-buddy");
  expect(startDecision("meet-buddy", tour(false))).toBe("drop");
});
