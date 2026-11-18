import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buddyChat } from "../src/buddy/chat";
import { writePersona } from "../src/buddy/persona";
import { buddyPersona } from "../src/buddy/persona-apply";
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
import { buddyOwnSignIn, parseBuddyReading } from "../src/launchpad/buddy-view";
import { pairsBuddysOwnT3 } from "../src/launchpad/chat";
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
  expect(buddyGeneration(null)).toBeUndefined();
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
      const machine = converted();
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
      expect(
        await buddyChat(environment.tools, { folder, apply: true }),
      ).toEqual({ kind: "buddy-chat", state: "skipped", reason: "shared-t3" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
);
