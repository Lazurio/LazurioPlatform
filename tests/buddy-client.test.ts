import { expect, test } from "bun:test";
import type { BuddyPersonaShown } from "../src/buddy/persona-save";
import {
  type BuddyTimers,
  type BuddyTransport,
  buddyPendingReadMs,
  buddyReadAttempts,
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

// ---- An answer never takes back what the page knows (Pablo's review) -----

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
const revA = "a".repeat(64);
const revB = "b".repeat(64);
const revC = "f".repeat(64);
const readingOf = (
  revision: string,
  overrides: Record<string, unknown> = {},
) => ({
  ok: true,
  value: answer({ persona: persona({ revision }), ...overrides }),
});
const savedAs = (revision: string, buddyName = "Rex") => ({
  ok: true,
  value: {
    kind: "persona",
    outcome: "written",
    persona: persona({ buddyName, revision, confirmed: true }),
    applied: { state: "applied" },
  },
});

/** Routes whose GETs answer only when the test releases them, in order;
 * POSTs answer what the test lined up, or wait for it (`hold`). */
function heldRoutes() {
  const gets: ((reply: Reply) => void)[] = [];
  const posts = new Map<string, Reply[]>();
  const held: ((reply: Reply) => void)[] = [];
  const sent: { path: string; body: unknown }[] = [];
  let holding = false;
  const transport: BuddyTransport = {
    get: () =>
      new Promise((resolve) => {
        gets.push(resolve);
      }),
    post: (path, body) => {
      sent.push({ path, body });
      if (holding)
        return new Promise((resolve) => {
          held.push(resolve);
        });
      const reply = posts.get(path)?.shift();
      if (reply === undefined) throw new Error(`no reply for ${path}`);
      return Promise.resolve(reply);
    },
  };
  return {
    transport,
    sent,
    asked: () => gets.length,
    reply(path: string, ...replies: Reply[]) {
      posts.set(path, [...replies]);
    },
    hold(on: boolean) {
      holding = on;
    },
    /** The GET asked `index`-th answers now. */
    async release(index: number, reply: Reply) {
      const resolve = gets[index];
      if (resolve === undefined) throw new Error(`no GET ${index}`);
      resolve(reply);
      await tick();
    },
    async answerHeld(index: number, reply: Reply) {
      held[index]?.(reply);
      await tick();
    },
  };
}

function heldClient() {
  const routes = heldRoutes();
  const clock = timers();
  const buddy = createBuddyClient({
    transport: routes.transport,
    changed: () => undefined,
    timers: clock.hand,
    now: () => at,
    visible: () => true,
  });
  return { buddy, routes };
}

test("a reading begun before a save answered is dropped and asked again: the saved persona stays, and the next save names its revision", async () => {
  const { buddy, routes } = heldClient();
  const first = buddy.read();
  await routes.release(0, readingOf(revA));
  await first;
  // A reading under way (the pending re-read, a move to the page)...
  const overtaken = buddy.read();
  // ...while the person saves; the server answers revision B.
  routes.reply(buddyRoutePaths.persona, savedAs(revB));
  const draft = {
    ...draftOf(buddy.reading()?.persona ?? null),
    buddyName: "Rex",
  };
  expect(await buddy.savePersona(draft, true, "cs")).toEqual({
    kind: "saved",
    pending: false,
  });
  expect(buddy.reading()?.persona?.revision).toBe(revB);
  // The earlier reading answers with A, served before the write.
  await routes.release(1, readingOf(revA));
  expect(buddy.reading()?.persona?.revision).toBe(revB);
  expect(buddy.reading()?.persona?.buddyName).toBe("Rex");
  // It was asked again, and that answer is the server's of now.
  expect(routes.asked()).toBe(3);
  await routes.release(
    2,
    readingOf(revB, {
      persona: persona({ revision: revB, buddyName: "Rex", confirmed: true }),
    }),
  );
  await overtaken;
  expect(buddy.reading()?.persona).toMatchObject({
    revision: revB,
    buddyName: "Rex",
    confirmed: true,
  });
  // The next save names B, not A: no avoidable 409.
  routes.reply(buddyRoutePaths.persona, savedAs(revC, "Max"));
  await buddy.savePersona({ ...draft, buddyName: "Max" }, false, "cs");
  expect(routes.sent.at(-1)?.body).toMatchObject({ revision: revB });
});

test("a reading begun before a 409 installed the persona there now is dropped too", async () => {
  const { buddy, routes } = heldClient();
  const first = buddy.read();
  await routes.release(0, readingOf(revA));
  await first;
  const overtaken = buddy.read();
  routes.reply(buddyRoutePaths.persona, {
    ok: false,
    value: {
      kind: "blocked",
      reason: "persona-changed",
      current: persona({ buddyName: "Max", revision: revC }),
    },
  });
  const draft = draftOf(buddy.reading()?.persona ?? null);
  expect(await buddy.savePersona(draft, false, "cs")).toEqual({
    kind: "changed",
  });
  expect(buddy.reading()?.persona?.revision).toBe(revC);
  await routes.release(1, readingOf(revA));
  expect(buddy.reading()?.persona).toMatchObject({
    revision: revC,
    buddyName: "Max",
  });
  await routes.release(
    2,
    readingOf(revC, { persona: persona({ buddyName: "Max", revision: revC }) }),
  );
  await overtaken;
  expect(buddy.reading()?.persona?.revision).toBe(revC);
  routes.reply(buddyRoutePaths.persona, savedAs(revB));
  await buddy.savePersona(draft, false, "cs");
  expect(routes.sent.at(-1)?.body).toMatchObject({ revision: revC });
});

test("a reading begun before a sign-out Hermes confirmed does not bring the sign-in back; the sign-out waits for the fresh one", async () => {
  const { buddy, routes } = heldClient();
  const signedIn = readingOf(revA, {
    state: "works",
    signIn: { state: "connected" },
  });
  const first = buddy.read();
  await routes.release(0, signedIn);
  await first;
  expect(buddy.reading()?.signIn).toBe("connected");
  const overtaken = buddy.read();
  routes.reply(buddyRoutePaths.signOut, {
    ok: true,
    value: { kind: "signed-out" },
  });
  let out: boolean | undefined;
  const signingOut = buddy.signOut().then((done) => {
    out = done;
  });
  await tick();
  // The earlier reading answers: still signed in, as before the sign-out.
  await routes.release(1, signedIn);
  expect(buddy.reading()?.signIn).toBe("connected");
  expect(out).toBeUndefined();
  await routes.release(2, readingOf(revA));
  await Promise.all([overtaken, signingOut]);
  expect(out).toBe(true);
  expect(buddy.reading()?.signIn).toBe("none");
});

test("a reading begun before a sign-in finished does not take back Připojeno", async () => {
  const { buddy, routes } = heldClient();
  const first = buddy.read();
  await routes.release(0, readingOf(revA));
  await first;
  routes.reply(buddyRoutePaths.start, { ok: true, value: pending() });
  routes.reply(buddyRoutePaths.poll, {
    ok: true,
    value: { kind: "signed-in" },
  });
  const clock = timers();
  const own = createBuddyClient({
    transport: routes.transport,
    changed: () => undefined,
    timers: clock.hand,
    now: () => at,
    visible: () => true,
  });
  // A client of its own, so the poll's timer is in the test's hand.
  const ownFirst = own.read();
  await routes.release(1, readingOf(revA));
  await ownFirst;
  await own.start();
  const overtaken = own.read();
  await clock.run(2000);
  expect(own.signIn()).toEqual({ kind: "signed-in" });
  // The reading begun before it answers: not signed in.
  await routes.release(2, readingOf(revA));
  expect(own.signIn()).toEqual({ kind: "signed-in" });
  expect(own.reading()?.signIn).toBe("none");
  await routes.release(
    3,
    readingOf(revA, { state: "works", signIn: { state: "connected" } }),
  );
  await overtaken;
  expect(own.reading()?.signIn).toBe("connected");
  expect(own.signIn()).toEqual({ kind: "idle" });
  // The first client was never asked to sign in.
  expect(buddy.signIn()).toEqual({ kind: "idle" });
});

test("an older save's answer that arrives after a newer one's is not installed", async () => {
  const { buddy, routes } = heldClient();
  const first = buddy.read();
  await routes.release(0, readingOf(revA));
  await first;
  routes.hold(true);
  const draft = draftOf(buddy.reading()?.persona ?? null);
  const older = buddy.savePersona({ ...draft, buddyName: "Rex" }, false, "cs");
  const newer = buddy.savePersona({ ...draft, buddyName: "Max" }, false, "cs");
  await tick();
  await routes.answerHeld(1, savedAs(revC, "Max"));
  await routes.answerHeld(0, savedAs(revB, "Rex"));
  await Promise.all([older, newer]);
  expect(buddy.reading()?.persona).toMatchObject({
    revision: revC,
    buddyName: "Max",
  });
});

test("a reading overtaken every time stops after its tries and keeps what the page knows", async () => {
  const { buddy, routes } = heldClient();
  const first = buddy.read();
  await routes.release(0, readingOf(revA));
  await first;
  const overtaken = buddy.read();
  const names = ["Rex", "Max", "Ben"];
  const revisions = ["1", "2", "3"].map((digit) => digit.repeat(64));
  for (let attempt = 0; attempt < buddyReadAttempts; attempt += 1) {
    routes.reply(
      buddyRoutePaths.persona,
      savedAs(revisions[attempt] ?? revA, names[attempt]),
    );
    await buddy.savePersona(
      {
        ...draftOf(buddy.reading()?.persona ?? null),
        buddyName: names[attempt] ?? "",
      },
      false,
      "cs",
    );
    await routes.release(attempt + 1, readingOf(revA));
  }
  await overtaken;
  expect(routes.asked()).toBe(1 + buddyReadAttempts);
  expect(buddy.reading()?.persona).toMatchObject({
    revision: revisions[2],
    buddyName: "Ben",
  });
});
