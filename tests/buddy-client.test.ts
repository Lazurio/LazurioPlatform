import { expect, test } from "bun:test";
import type { BuddyPersonaShown } from "../src/buddy/persona-save";
import {
  type BuddyTimers,
  type BuddyTransport,
  buddyPendingReadMs,
  createBuddyClient,
} from "../src/launchpad/buddy-client";
import { buddyRoutePaths } from "../src/launchpad/buddy-paths";
import { buddyRoutePaths as serverPaths } from "../src/launchpad/buddy-routes";
import { draftOf, withYourName } from "../src/launchpad/buddy-view";
import { codexDevicePage } from "../src/tools/ai";

// Decision F65 in the page (buddy-client.ts): Buddy's reading, the one
// sign-in the page holds, and a change of his persona, over the routes of
// F63 and F65. A start Hermes refuses while a sign-in still runs keeps the
// code on screen; a cancel Hermes does not confirm keeps it too.

const revision = "c".repeat(64);
const session = "0123456789abcdef0123456789abcdef";
const at = Date.UTC(2026, 9, 25, 6, 0, 0);

const persona = (
  overrides: Partial<BuddyPersonaShown> = {},
): BuddyPersonaShown => ({
  buddyName: "Buddy",
  address: "vy",
  user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
  confirmed: false,
  revision,
  pending: false,
  ...overrides,
});
const answer = (overrides: Record<string, unknown> = {}) => ({
  kind: "buddy",
  state: "waits",
  signIn: { state: "none" },
  locale: "cs",
  persona: persona(),
  ...overrides,
});
const pending = (code = "ABCD-12EF3") => ({
  kind: "pending" as const,
  session,
  code,
  url: codexDevicePage,
  expiresAt: new Date(at + 15 * 60_000).toISOString(),
  pollMs: 2000,
});

type Reply = Readonly<{ ok: boolean; value: unknown }>;

/** The routes, answering what the test lines up per path. */
function routes() {
  const replies = new Map<string, Reply[]>();
  const sent: { path: string; body: unknown }[] = [];
  const next = (path: string): Reply => {
    const queue = replies.get(path) ?? [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error(`no reply for ${path}`);
    return reply;
  };
  const transport: BuddyTransport = {
    get: async (path) => next(path),
    post: async (path, body) => {
      sent.push({ path, body });
      return next(path);
    },
  };
  return {
    transport,
    sent,
    reply(path: string, ...answers: Reply[]) {
      replies.set(path, [...answers]);
    },
  };
}

/** Timers the test runs by hand. */
function timers() {
  const due: { id: number; ms: number; run: () => void }[] = [];
  let id = 0;
  const hand: BuddyTimers = {
    after: (run, ms) => {
      id += 1;
      due.push({ id, ms, run });
      return id;
    },
    cancel: (timer) => {
      const index = due.findIndex((entry) => entry.id === timer);
      if (index >= 0) due.splice(index, 1);
    },
  };
  return {
    hand,
    delays: () => due.map((entry) => entry.ms),
    /** Runs the timers of exactly `ms`. */
    async run(ms: number) {
      for (const entry of due.filter((item) => item.ms === ms)) {
        hand.cancel(entry.id);
        entry.run();
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  };
}

function client(fake = routes(), clock = timers()) {
  let changes = 0;
  const buddy = createBuddyClient({
    transport: fake.transport,
    changed: () => {
      changes += 1;
    },
    timers: clock.hand,
    now: () => at,
    visible: () => true,
  });
  return { buddy, fake, clock, changes: () => changes };
}

test("the page's paths are the server's", () => {
  expect(buddyRoutePaths).toEqual(serverPaths);
});

test("a reading: his state and persona; 404 buddy-absent is no Buddy; a first read that fails claims nothing", async () => {
  const { buddy, fake } = client();
  fake.reply(buddyRoutePaths.read, { ok: true, value: answer() });
  await buddy.read();
  expect(buddy.reading()).toEqual({
    state: "waits",
    signIn: "none",
    persona: persona(),
  });
  expect(buddy.absent()).toBe(false);
  fake.reply(buddyRoutePaths.read, {
    ok: false,
    value: { error: "buddy-absent" },
  });
  await buddy.read();
  expect(buddy.absent()).toBe(true);
  expect(buddy.reading()).toBeNull();
  const fresh = client();
  fresh.fake.reply(buddyRoutePaths.read, {
    ok: false,
    value: { error: "operation-failed" },
  });
  await fresh.buddy.read();
  expect(fresh.buddy.reading()).toEqual({
    state: "unknown",
    signIn: "unknown",
    persona: null,
  });
});

test("a sign-in: the code, asked every two seconds, signed in once Hermes saved it, then read again", async () => {
  const { buddy, fake, clock } = client();
  fake.reply(buddyRoutePaths.start, { ok: true, value: pending() });
  fake.reply(
    buddyRoutePaths.poll,
    { ok: true, value: pending() },
    { ok: true, value: { kind: "signed-in" } },
  );
  fake.reply(buddyRoutePaths.read, {
    ok: true,
    value: answer({ state: "works", signIn: { state: "connected" } }),
  });
  await buddy.start();
  expect(buddy.signIn()).toEqual({
    kind: "pending",
    session,
    code: "ABCD-12EF3",
    url: codexDevicePage,
    expiresAt: at + 15 * 60_000,
    pollMs: 2000,
  });
  await clock.run(2000);
  expect(buddy.signIn().kind).toBe("pending");
  await clock.run(2000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // The reading says he is signed in: "Připojeno" is its.
  expect(buddy.reading()?.signIn).toBe("connected");
  expect(buddy.signIn()).toEqual({ kind: "idle" });
  expect(fake.sent.map((call) => call.path)).toEqual([
    buddyRoutePaths.start,
    buddyRoutePaths.poll,
    buddyRoutePaths.poll,
  ]);
  expect(fake.sent[1]?.body).toEqual({ session });
});

test("Nový kód while Hermes still holds a sign-in keeps the code on screen; a first start says it runs", async () => {
  const { buddy, fake } = client();
  fake.reply(buddyRoutePaths.start, { ok: true, value: pending() });
  await buddy.start();
  fake.reply(buddyRoutePaths.start, {
    ok: false,
    value: { kind: "blocked", reason: "sign-in-running" },
  });
  await buddy.start();
  expect(buddy.signIn()).toMatchObject({ kind: "pending", code: "ABCD-12EF3" });
  const other = client();
  other.fake.reply(buddyRoutePaths.start, {
    ok: false,
    value: { kind: "blocked", reason: "sign-in-running" },
  });
  await other.buddy.start();
  expect(other.buddy.signIn()).toEqual({
    kind: "failed",
    reason: "sign-in-running",
  });
});

test("a start that cannot happen: Buddy needs an update, his gateway does not run, no answer", async () => {
  const outcome = async (reply: Reply | "throws") => {
    const fake = routes();
    const transport: BuddyTransport =
      reply === "throws"
        ? {
            get: fake.transport.get,
            post: async () => {
              throw new Error("network");
            },
          }
        : fake.transport;
    if (reply !== "throws") fake.reply(buddyRoutePaths.start, reply);
    const { buddy } = client({ ...fake, transport });
    await buddy.start();
    return buddy.signIn();
  };
  expect(
    await outcome({
      ok: false,
      value: { kind: "blocked", reason: "hermes-outdated" },
    }),
  ).toEqual({ kind: "failed", reason: "hermes-outdated" });
  expect(
    await outcome({
      ok: false,
      value: { error: "buddy-unavailable", reason: "no-socket" },
    }),
  ).toEqual({ kind: "failed", reason: "unavailable" });
  expect(await outcome("throws")).toEqual({
    kind: "failed",
    reason: "no-answer",
  });
  expect(
    await outcome({ ok: true, value: { kind: "failed", reason: "refused" } }),
  ).toEqual({ kind: "failed", reason: "refused" });
  // A code not on OpenAI's exact page is no code.
  expect(
    await outcome({
      ok: true,
      value: { ...pending(), url: "https://evil.example/" },
    }),
  ).toEqual({ kind: "failed", reason: "failed" });
});

test("a poll that ends it: expired, refused, or a Launchpad that holds it no more (the reading says the rest)", async () => {
  const run = async (reply: Reply) => {
    const { buddy, fake, clock } = client();
    fake.reply(buddyRoutePaths.start, { ok: true, value: pending() });
    fake.reply(buddyRoutePaths.poll, reply);
    fake.reply(buddyRoutePaths.read, { ok: true, value: answer() });
    await buddy.start();
    await clock.run(2000);
    return { buddy, fake };
  };
  expect(
    (
      await run({ ok: true, value: { kind: "failed", reason: "expired" } })
    ).buddy.signIn(),
  ).toEqual({ kind: "failed", reason: "expired" });
  const none = await run({ ok: true, value: { kind: "none" } });
  expect(none.buddy.signIn()).toEqual({ kind: "idle" });
  expect(none.fake.sent.map((call) => call.path)).toEqual([
    buddyRoutePaths.start,
    buddyRoutePaths.poll,
  ]);
  // No answer this time: asked again, the code kept.
  const silent = await run({
    ok: false,
    value: { error: "buddy-unavailable", reason: "draining" },
  });
  expect(silent.buddy.signIn().kind).toBe("pending");
});

test("Zrušit ends the code on Hermes; one Hermes did not confirm ending stays on screen", async () => {
  const { buddy, fake } = client();
  fake.reply(buddyRoutePaths.start, { ok: true, value: pending() });
  await buddy.start();
  fake.reply(buddyRoutePaths.cancel, {
    ok: false,
    value: { kind: "blocked", reason: "sign-in-running" },
  });
  await buddy.cancel();
  expect(buddy.signIn()).toMatchObject({ kind: "pending", code: "ABCD-12EF3" });
  fake.reply(buddyRoutePaths.cancel, {
    ok: true,
    value: { kind: "cancelled" },
  });
  await buddy.cancel();
  expect(buddy.signIn()).toEqual({ kind: "idle" });
  expect(fake.sent.at(-1)).toEqual({
    path: buddyRoutePaths.cancel,
    body: { session },
  });
});

test("Odhlásit: true once Hermes forgot his sign-in, and the reading follows", async () => {
  const { buddy, fake } = client();
  fake.reply(buddyRoutePaths.signOut, {
    ok: true,
    value: { kind: "signed-out" },
  });
  fake.reply(buddyRoutePaths.read, { ok: true, value: answer() });
  expect(await buddy.signOut()).toBe(true);
  expect(buddy.reading()?.signIn).toBe("none");
  fake.reply(buddyRoutePaths.signOut, {
    ok: false,
    value: { kind: "blocked", reason: "sign-in-running" },
  });
  expect(await buddy.signOut()).toBe(false);
});

test("a change of the persona: the revision read and the confirmation sent; saved, refused members, changed meanwhile", async () => {
  const { buddy, fake, clock } = client();
  fake.reply(buddyRoutePaths.read, { ok: true, value: answer() });
  await buddy.read();
  const draft = {
    ...draftOf(buddy.reading()?.persona ?? null),
    buddyName: "Rex",
  };
  const saved = persona({
    buddyName: "Rex",
    confirmed: true,
    revision: "d".repeat(64),
    pending: true,
  });
  fake.reply(buddyRoutePaths.persona, {
    ok: true,
    value: {
      kind: "persona",
      outcome: "written",
      persona: saved,
      applied: { state: "waiting" },
    },
  });
  expect(await buddy.savePersona(draft, true, "cs")).toEqual({
    kind: "saved",
    pending: true,
  });
  expect(fake.sent.at(-1)).toEqual({
    path: buddyRoutePaths.persona,
    body: {
      buddyName: "Rex",
      address: "vy",
      user: { nominative: "Bob", accusative: "Boba", dative: "Bobovi" },
      revision,
      confirm: true,
    },
  });
  expect(buddy.reading()?.persona).toEqual(saved);
  // Still on its way: the reading is asked again in ten seconds.
  expect(clock.delays()).toContain(buddyPendingReadMs);
  const refused = async (error: string) => {
    fake.reply(buddyRoutePaths.persona, { ok: false, value: { error } });
    return buddy.savePersona(draft, false, "cs");
  };
  expect(await refused("invalid-buddy-name")).toEqual({
    kind: "invalid",
    field: "buddy-name",
  });
  expect(await refused("invalid-user-dative")).toEqual({
    kind: "invalid",
    field: "user",
  });
  expect(await refused("invalid-revision")).toEqual({ kind: "failed" });
  const current = persona({ buddyName: "Max", revision: "e".repeat(64) });
  fake.reply(buddyRoutePaths.persona, {
    ok: false,
    value: { kind: "blocked", reason: "persona-changed", current },
  });
  expect(await buddy.savePersona(draft, false, "cs")).toEqual({
    kind: "changed",
  });
  // What is there now, to show and to change again over its revision.
  expect(buddy.reading()?.persona).toEqual(current);
  // English sends the one form in all three.
  fake.reply(buddyRoutePaths.persona, {
    ok: true,
    value: {
      kind: "persona",
      outcome: "written",
      persona: saved,
      applied: { state: "applied" },
    },
  });
  await buddy.savePersona(withYourName(draft, "Bob", "en"), false, "en");
  expect(fake.sent.at(-1)?.body).toMatchObject({
    user: { nominative: "Bob", accusative: "Bob", dative: "Bob" },
    revision: "e".repeat(64),
  });
});
