import { expect, test } from "bun:test";
import { createHermesGateway } from "../src/buddy/hermes-gateway";
import {
  type BuddySignInJournalEntry,
  buddySignInExpiryGraceMs,
  buddySignInPollMs,
  createBuddySignIn,
} from "../src/buddy/sign-in";
import {
  type BuddyFacts,
  buddyStatus,
  readBuddyFacts,
} from "../src/buddy/status";
import { codexDevicePage } from "../src/tools/ai";
import {
  type FakeHermesGateway,
  fakeHermesGateway,
  recorded,
} from "./fixtures/fake-hermes-gateway";

// Decision F63: Buddy's ChatGPT sign-in through Hermes's own dashboard routes
// and his state as a pure function of what each reading finds, against the
// stand-in gateway with the shapes recorded from v0.22.4-lazurio.1. One
// sign-in at a time; the code and OpenAI's page only in their exact shapes
// and only to the holder of the handle; Hermes's words never leave; the
// journal names the operation, the outcome and the reason only.

const posix = test.skipIf(process.platform === "win32");

async function within(
  options: Parameters<typeof fakeHermesGateway>[0],
  body: (
    fake: FakeHermesGateway,
    signIn: ReturnType<typeof createBuddySignIn>,
    journal: BuddySignInJournalEntry[],
    clock: { now: number },
  ) => Promise<void>,
) {
  const fake = await fakeHermesGateway(options);
  const journal: BuddySignInJournalEntry[] = [];
  const clock = { now: Date.parse("2026-10-25T08:00:00Z") };
  try {
    await body(
      fake,
      createBuddySignIn({
        gateway: createHermesGateway({
          home: fake.userHome,
          httpMs: 1_000,
          controlMs: 1_000,
        }),
        now: () => clock.now,
        journal: (entry) => journal.push(entry),
      }),
      journal,
      clock,
    );
  } finally {
    await fake.close();
  }
}

const hermesIds = (fake: FakeHermesGateway) => [
  ...[...Array(10).keys()].map(
    (index) => `Fixture_Session_${String(index + 1).padStart(6, "0")}`,
  ),
  ...fake.sessions.keys(),
];

/** Nothing secret in what leaves: no ticket, no Hermes session, none of
 * Hermes's words; the code and the handle only where `allowed` says. */
function clean(
  text: string,
  fake: FakeHermesGateway,
  allowed: readonly string[] = [],
) {
  for (const ticket of fake.spent) expect(text).not.toContain(ticket);
  for (const id of hermesIds(fake)) expect(text).not.toContain(id);
  for (const words of [
    "OpenAI rejected",
    "device-auth",
    "deviceauth",
    "token exchange",
    "Device code expired",
    "Unauthorized",
    "Session not found",
    "No stored credentials",
    "hermes auth add",
  ])
    expect(text).not.toContain(words);
  if (!allowed.includes("code"))
    expect(text).not.toContain(recorded.http.start.body.user_code);
}

posix(
  "start: OpenAI's page and the whole code to the holder of a handle of its own, Hermes's session kept here",
  () =>
    within({}, async (fake, signIn, journal, clock) => {
      const answer = await signIn.start();
      expect(answer).toEqual({
        kind: "pending",
        session: expect.stringMatching(/^[0-9a-f]{32}$/),
        code: recorded.http.start.body.user_code,
        url: codexDevicePage,
        expiresAt: new Date(clock.now + 900_000).toISOString(),
        pollMs: buddySignInPollMs,
      });
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /api/providers/oauth/openai-codex/start",
      ]);
      clean(JSON.stringify(answer), fake, ["code"]);
      expect(journal).toEqual([{ operation: "start", outcome: "pending" }]);
    }),
);

posix(
  "the code and the page pass only in their exact shapes; anything else is cancelled on Hermes and shown to nobody",
  () =>
    within({}, async (fake, signIn, journal) => {
      for (const [field, value] of [
        ["user_code", "abcd-12ef3"],
        ["user_code", "ABCD12EF3"],
        ["user_code", "ABCD-12EF3 "],
        ["user_code", "<b>ABCD</b>-1234"],
        ["user_code", 1234],
        ["verification_url", "https://auth.openai.com/codex/device/"],
        ["verification_url", "http://auth.openai.com/codex/device"],
        [
          "verification_url",
          "https://auth.openai.com.evil.example/codex/device",
        ],
        ["verification_url", "https://auth.openai.com/codex/device?x=1"],
        ["expires_in", 0],
        ["expires_in", "900"],
        ["expires_in", 86400],
      ] as const) {
        fake.state.http = (request) =>
          request.path.endsWith("/start")
            ? Response.json({
                ...recorded.http.start.body,
                session_id: "Fixture_Session_bad001",
                [field]: value,
              })
            : undefined;
        fake.sessions.set("Fixture_Session_bad001", {
          status: "pending",
          error_message: null,
        });
        fake.requests.length = 0;
        expect(await signIn.start()).toEqual({
          kind: "failed",
          reason: "failed",
        });
        // Cancelled on Hermes, never left waiting for a code nobody saw.
        expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
          "POST /api/providers/oauth/openai-codex/start",
          "DELETE /api/providers/oauth/sessions/Fixture_Session_bad001",
        ]);
      }
      // A session id of no known shape is never put in a path.
      fake.requests.length = 0;
      fake.state.http = (request) =>
        request.path.endsWith("/start")
          ? Response.json({
              ...recorded.http.start.body,
              session_id: "../../openai-codex",
            })
          : undefined;
      expect(await signIn.start()).toEqual({
        kind: "failed",
        reason: "failed",
      });
      expect(fake.requests).toHaveLength(1);
      expect(journal.every((entry) => entry.outcome === "failed")).toBe(true);
      clean(JSON.stringify(journal), fake);
    }),
);

posix(
  "Hermes's refusals become closed reasons: OpenAI refusing a sign-in by code, a timeout, any other failure",
  () =>
    within({}, async (fake, signIn, journal) => {
      for (const [entry, reason] of [
        [recorded.derived.startRefused, "refused"],
        [recorded.derived.startTimedOut, "failed"],
        [recorded.derived.startFailed, "failed"],
        [
          { status: 400, body: { detail: "Unknown provider openai-codex" } },
          "failed",
        ],
        [{ status: 200, body: "not an object" }, "failed"],
      ] as const) {
        fake.state.http = () =>
          Response.json(entry.body, { status: entry.status });
        const answer = await signIn.start();
        expect(answer).toEqual({ kind: "failed", reason });
        clean(JSON.stringify(answer), fake);
      }
      expect(journal.map((entry) => entry.reason)).toEqual([
        "refused",
        "failed",
        "failed",
        "failed",
        "failed",
      ]);
      clean(JSON.stringify(journal), fake);
    }),
);

posix(
  "poll follows Hermes: pending, then signed in once approved; the handle names none afterwards",
  () =>
    within({}, async (fake, signIn, journal) => {
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      expect(await signIn.poll(started.session)).toEqual(started);
      expect(await signIn.poll("0".repeat(32))).toEqual({ kind: "none" });
      const [hermes] = [...fake.sessions.keys()];
      fake.approve(hermes as string);
      expect(await signIn.poll(started.session)).toEqual({ kind: "signed-in" });
      expect(await signIn.poll(started.session)).toEqual({ kind: "none" });
      expect(journal).toEqual([
        { operation: "start", outcome: "pending" },
        { operation: "poll", outcome: "signed-in" },
      ]);
      // Each poll its own ticket; Hermes's session only in the paths sent
      // to Hermes.
      expect(fake.requests.map((r) => r.method)).toEqual([
        "POST",
        "GET",
        "GET",
      ]);
      expect(new Set(fake.spent).size).toBe(3);
      clean(JSON.stringify(journal), fake);
    }),
);

posix(
  "poll's endings: expired, refused, failed with Hermes's words withheld, lost when Hermes forgot it or restarted",
  () =>
    within({}, async (fake, signIn, journal, clock) => {
      const ending = async (
        status: string,
        message: string | null,
        expected: string,
      ) => {
        const started = await signIn.start();
        if (started.kind !== "pending") throw new Error("not pending");
        const hermes = [...fake.sessions.keys()].at(-1) as string;
        const session = fake.sessions.get(hermes);
        if (session === undefined) throw new Error("no session");
        session.status = status;
        session.error_message = message;
        const answer = await signIn.poll(started.session);
        expect(answer).toEqual({ kind: "failed", reason: expected as never });
        clean(JSON.stringify(answer), fake);
      };
      await ending(
        "expired",
        recorded.derived.pollExpired.body.error_message,
        "expired",
      );
      await ending("denied", null, "refused");
      await ending(
        "error",
        recorded.derived.pollRefused.body.error_message,
        "refused",
      );
      await ending(
        "error",
        recorded.derived.pollError.body.error_message,
        "failed",
      );
      await ending("cancelled", null, "lost");
      await ending("something-new", null, "failed");

      // Hermes no longer knows it: its 404.
      const forgotten = await signIn.start();
      if (forgotten.kind !== "pending") throw new Error("not pending");
      fake.sessions.clear();
      expect(await signIn.poll(forgotten.session)).toEqual({
        kind: "failed",
        reason: "lost",
      });

      // A gateway restart in the middle of a sign-in.
      const restarted = await signIn.start();
      if (restarted.kind !== "pending") throw new Error("not pending");
      fake.restart();
      expect(await signIn.poll(restarted.session)).toEqual({
        kind: "failed",
        reason: "lost",
      });

      // A gateway that is stopping proves nothing: the sign-in stays held
      // (its worker may still save it), and once the gateway is back, Hermes
      // no longer knows it.
      const gone = await signIn.start();
      if (gone.kind !== "pending") throw new Error("not pending");
      fake.state.identify = (answer) => {
        (answer.result as Record<string, unknown>).state = "draining";
        return answer;
      };
      expect(await signIn.poll(gone.session)).toEqual(gone);
      fake.restart();
      fake.state.identify = undefined;
      expect(await signIn.poll(gone.session)).toEqual({
        kind: "failed",
        reason: "lost",
      });

      // Hermes ends a sign-in itself at its code's end, and its last round
      // may run on past it: still waiting then. One it still calls waiting
      // past that round is cancelled, and expired once Hermes confirmed it.
      const late = await signIn.start();
      if (late.kind !== "pending") throw new Error("not pending");
      const lateOnHermes = [...fake.sessions.keys()].at(-1) as string;
      clock.now += 900_000;
      const deletes = () =>
        fake.requests.filter((request) => request.method === "DELETE").length;
      const before = deletes();
      expect(await signIn.poll(late.session)).toEqual(late);
      expect(deletes()).toBe(before);
      clock.now += buddySignInExpiryGraceMs;
      expect(await signIn.poll(late.session)).toEqual({
        kind: "failed",
        reason: "expired",
      });
      expect(fake.sessions.has(lateOnHermes)).toBe(false);

      expect(journal.filter((entry) => entry.operation === "poll")).toEqual([
        { operation: "poll", outcome: "failed", reason: "expired" },
        { operation: "poll", outcome: "failed", reason: "refused" },
        { operation: "poll", outcome: "failed", reason: "refused" },
        { operation: "poll", outcome: "failed", reason: "failed" },
        { operation: "poll", outcome: "failed", reason: "lost" },
        { operation: "poll", outcome: "failed", reason: "failed" },
        { operation: "poll", outcome: "failed", reason: "lost" },
        { operation: "poll", outcome: "failed", reason: "lost" },
        { operation: "poll", outcome: "failed", reason: "lost" },
        { operation: "poll", outcome: "failed", reason: "expired" },
      ]);
      clean(JSON.stringify(journal), fake);
    }),
);

posix(
  "a poll answer about another session, or of no known shape, ends the sign-in and cancels it on Hermes",
  () =>
    within({}, async (fake, signIn) => {
      for (const body of [
        {
          ...recorded.http.pollPending.body,
          session_id: "Fixture_Session_other1",
        },
        { ...recorded.http.pollPending.body, session_id: undefined },
        ["not", "an", "object"],
      ]) {
        const started = await signIn.start();
        if (started.kind !== "pending") throw new Error("not pending");
        const hermes = [...fake.sessions.keys()].at(-1) as string;
        fake.state.http = (request) =>
          request.method === "GET" ? Response.json(body) : undefined;
        expect(await signIn.poll(started.session)).toEqual({
          kind: "failed",
          reason: "failed",
        });
        fake.state.http = undefined;
        expect(fake.sessions.has(hermes)).toBe(false);
      }
      // The same answer while Hermes does not confirm the cancel: nothing
      // proves the sign-in ended, so it stays held and still waits.
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      fake.state.http = (request) =>
        request.method === "GET"
          ? Response.json(["not", "an", "object"])
          : Response.json({ detail: "Internal Server Error" }, { status: 500 });
      expect(await signIn.poll(started.session)).toEqual(started);
      expect(fake.sessions.size).toBe(1);
      fake.state.http = (request) =>
        request.method === "GET"
          ? Response.json(["not", "an", "object"])
          : undefined;
      expect(await signIn.poll(started.session)).toEqual({
        kind: "failed",
        reason: "failed",
      });
      expect(fake.sessions.size).toBe(0);
    }),
);

posix(
  "a poll that times out keeps the sign-in: it is asked again",
  async () => {
    const fake = await fakeHermesGateway();
    try {
      const signIn = createBuddySignIn({
        gateway: createHermesGateway({ home: fake.userHome, httpMs: 300 }),
      });
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      fake.state.http = () => new Promise<Response>(() => undefined);
      expect(await signIn.poll(started.session)).toEqual(started);
      fake.state.http = undefined;
      fake.approve([...fake.sessions.keys()][0] as string);
      expect(await signIn.poll(started.session)).toEqual({ kind: "signed-in" });
    } finally {
      await fake.close();
    }
  },
);

posix(
  "one sign-in at a time: a new start cancels the one before it on Hermes, and its handle names none",
  () =>
    within({}, async (fake, signIn, journal) => {
      const first = await signIn.start();
      if (first.kind !== "pending") throw new Error("not pending");
      const second = await signIn.start();
      if (second.kind !== "pending") throw new Error("not pending");
      expect(second.session).not.toBe(first.session);
      expect([...fake.sessions.keys()]).toEqual(["Fixture_Session_000002"]);
      expect(await signIn.poll(first.session)).toEqual({ kind: "none" });
      expect(await signIn.cancel(first.session)).toEqual({ kind: "none" });
      expect(await signIn.poll(second.session)).toEqual(second);
      // Two at once, as from two tabs: the later one stands, on Hermes too.
      const [a, b] = await Promise.all([signIn.start(), signIn.start()]);
      if (a.kind !== "pending" || b.kind !== "pending")
        throw new Error("not pending");
      expect(await signIn.poll(a.session)).toEqual({ kind: "none" });
      expect(await signIn.poll(b.session)).toEqual(b);
      expect(fake.sessions.size).toBe(1);
      expect(journal.filter((entry) => entry.operation === "cancel")).toEqual([
        { operation: "cancel", outcome: "cancelled", reason: "replaced" },
        { operation: "cancel", outcome: "cancelled", reason: "replaced" },
        { operation: "cancel", outcome: "cancelled", reason: "replaced" },
      ]);
    }),
);

posix(
  "cancel: Hermes marks its session cancelled, the handle names none; another handle cancels nothing",
  () =>
    within({}, async (fake, signIn, journal) => {
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      expect(await signIn.cancel("f".repeat(32))).toEqual({ kind: "none" });
      expect(fake.sessions.size).toBe(1);
      expect(await signIn.cancel(started.session)).toEqual({
        kind: "cancelled",
      });
      expect(fake.sessions.size).toBe(0);
      expect(await signIn.poll(started.session)).toEqual({ kind: "none" });
      expect(fake.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
      expect(journal.at(-1)).toEqual({
        operation: "cancel",
        outcome: "cancelled",
      });
    }),
);

posix(
  "sign-out: Hermes forgets the sign-in, an empty store counts as signed out, a running sign-in is cancelled first",
  () =>
    within({ signedIn: true }, async (fake, signIn, journal) => {
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      expect(await signIn.signOut()).toEqual({ kind: "signed-out" });
      expect(fake.state.signedIn).toBe(false);
      expect(fake.sessions.size).toBe(0);
      expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "POST /api/providers/oauth/openai-codex/start",
        "DELETE /api/providers/oauth/sessions/Fixture_Session_000001",
        "DELETE /api/providers/oauth/openai-codex",
      ]);
      // Hermes's 409: nothing was stored.
      expect(await signIn.signOut()).toEqual({ kind: "signed-out" });
      fake.state.http = () =>
        Response.json({ detail: "Failed to remove" }, { status: 500 });
      expect(await signIn.signOut()).toEqual({
        kind: "failed",
        reason: "failed",
      });
      fake.state.http = undefined;
      await fake.stop();
      expect(await signIn.signOut()).toEqual({
        kind: "unavailable",
        reason: "no-socket",
      });
      expect(journal.filter((e) => e.operation === "sign-out")).toEqual([
        { operation: "sign-out", outcome: "signed-out" },
        { operation: "sign-out", outcome: "signed-out" },
        { operation: "sign-out", outcome: "failed", reason: "failed" },
        { operation: "sign-out", outcome: "unavailable", reason: "no-socket" },
      ]);
      clean(JSON.stringify(journal), fake);
    }),
);

// Pablo's review of #635: a sign-in ends only on Hermes's word. Hermes's
// cancel answers `{ok: true, session_id}` for a session it held and
// `{ok: false, message: "session not found"}` for one it does not (both
// recorded); anything else leaves its worker free to save a sign-in later.
const blocked = { kind: "blocked", reason: "sign-in-running" } as const;
const sessionDeletes =
  (
    reply: () => Response | Promise<Response>,
  ): NonNullable<FakeHermesGateway["state"]["http"]> =>
  (request) =>
    request.method === "DELETE" &&
    request.path.startsWith("/api/providers/oauth/sessions/")
      ? reply()
      : undefined;

posix(
  "a replacement start whose cancel Hermes does not confirm starts nothing, and the sign-in before stays held and addressable",
  () =>
    within({}, async (fake, signIn, journal) => {
      const first = await signIn.start();
      if (first.kind !== "pending") throw new Error("not pending");
      const firstOnHermes = "Fixture_Session_000001";
      for (const [reply, expected] of [
        [
          () =>
            Response.json({ detail: "Internal Server Error" }, { status: 500 }),
          blocked,
        ],
        // A confirmation of another session, another `ok: false`, a 404 that
        // is not Hermes's answer for an unknown session, no JSON.
        [
          () =>
            Response.json({ ok: true, session_id: "Fixture_Session_other1" }),
          blocked,
        ],
        [() => Response.json({ ok: true }), blocked],
        [
          () => Response.json({ ok: false, message: "profile mismatch" }),
          blocked,
        ],
        [
          () => Response.json({ detail: "Not Found" }, { status: 404 }),
          blocked,
        ],
        [() => new Response("not json"), blocked],
        // The gateway refuses the ticket twice.
        [
          () => Response.json(recorded.http.unauthorized.body, { status: 401 }),
          { kind: "unavailable", reason: "refused" },
        ],
        // Reached, and no answer in time.
        [
          () => new Promise<Response>(() => undefined),
          { kind: "unavailable", reason: "timeout" },
        ],
      ] as const) {
        fake.state.http = sessionDeletes(reply);
        expect(await signIn.start()).toEqual(expected);
        // No second session on Hermes, and the first still the holder's.
        expect([...fake.sessions.keys()]).toEqual([firstOnHermes]);
        fake.state.http = undefined;
        expect(await signIn.poll(first.session)).toEqual(first);
      }
      expect(
        fake.requests.filter((request) => request.path.endsWith("/start")),
      ).toHaveLength(1);
      // Confirmed: the replacement goes ahead.
      const second = await signIn.start();
      if (second.kind !== "pending") throw new Error("not pending");
      expect([...fake.sessions.keys()]).toEqual(["Fixture_Session_000002"]);
      expect(await signIn.poll(first.session)).toEqual({ kind: "none" });
      // One Hermes no longer holds (a restart dropped it) is ended too.
      fake.restart();
      const third = await signIn.start();
      expect(third.kind).toBe("pending");
      expect(journal.filter((entry) => entry.operation === "start")).toEqual([
        { operation: "start", outcome: "pending" },
        ...Array(6).fill({
          operation: "start",
          outcome: "blocked",
          reason: "sign-in-running",
        }),
        { operation: "start", outcome: "unavailable", reason: "refused" },
        { operation: "start", outcome: "unavailable", reason: "timeout" },
        { operation: "start", outcome: "pending" },
        { operation: "start", outcome: "pending" },
      ]);
      clean(JSON.stringify(journal), fake);
    }),
);

posix(
  "an explicit cancel Hermes does not confirm is refused with a closed reason, and the sign-in stays held",
  () =>
    within({}, async (fake, signIn, journal) => {
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      fake.state.http = sessionDeletes(() =>
        Response.json({ detail: "Internal Server Error" }, { status: 500 }),
      );
      expect(await signIn.cancel(started.session)).toEqual(blocked);
      fake.state.http = sessionDeletes(
        () => new Promise<Response>(() => undefined),
      );
      expect(await signIn.cancel(started.session)).toEqual({
        kind: "unavailable",
        reason: "timeout",
      });
      fake.state.http = undefined;
      expect(fake.sessions.size).toBe(1);
      expect(await signIn.poll(started.session)).toEqual(started);
      expect(await signIn.cancel(started.session)).toEqual({
        kind: "cancelled",
      });
      expect(fake.sessions.size).toBe(0);
      // A session Hermes no longer holds counts as cancelled.
      const again = await signIn.start();
      if (again.kind !== "pending") throw new Error("not pending");
      fake.restart();
      expect(await signIn.cancel(again.session)).toEqual({ kind: "cancelled" });
      expect(journal.filter((entry) => entry.operation === "cancel")).toEqual([
        { operation: "cancel", outcome: "blocked", reason: "sign-in-running" },
        { operation: "cancel", outcome: "unavailable", reason: "timeout" },
        { operation: "cancel", outcome: "cancelled" },
        { operation: "cancel", outcome: "cancelled" },
      ]);
    }),
);

posix(
  "sign-out never says signed out while a sign-in Hermes did not confirm cancelled may still complete",
  () =>
    within({ signedIn: true }, async (fake, signIn, journal) => {
      const started = await signIn.start();
      if (started.kind !== "pending") throw new Error("not pending");
      const signOuts = () =>
        fake.requests.filter(
          (request) =>
            request.method === "DELETE" &&
            request.path === "/api/providers/oauth/openai-codex",
        ).length;
      fake.state.http = sessionDeletes(() =>
        Response.json({ detail: "Internal Server Error" }, { status: 500 }),
      );
      expect(await signIn.signOut()).toEqual(blocked);
      // Nothing was signed out, and the sign-in is still the holder's.
      expect(signOuts()).toBe(0);
      expect(fake.state.signedIn).toBe(true);
      expect(await signIn.poll(started.session)).toEqual(started);
      // The person enters the code meanwhile: that sign-in is real, and nobody
      // was told Buddy was signed out.
      fake.approve("Fixture_Session_000001");
      expect(await signIn.poll(started.session)).toEqual({ kind: "signed-in" });
      fake.state.http = undefined;
      expect(await signIn.signOut()).toEqual({ kind: "signed-out" });
      expect(fake.state.signedIn).toBe(false);

      // A sign-in held while the gateway stops: nothing is signed out.
      const held = await signIn.start();
      if (held.kind !== "pending") throw new Error("not pending");
      fake.state.identify = (answer) => {
        (answer.result as Record<string, unknown>).state = "draining";
        return answer;
      };
      expect(await signIn.signOut()).toEqual({
        kind: "unavailable",
        reason: "draining",
      });
      fake.state.identify = undefined;
      // Cancelled first, signed out after.
      expect(await signIn.signOut()).toEqual({ kind: "signed-out" });
      expect(fake.sessions.size).toBe(1); // the approved one, kept by Hermes
      expect(journal.filter((e) => e.operation !== "start")).toEqual([
        {
          operation: "sign-out",
          outcome: "blocked",
          reason: "sign-in-running",
        },
        { operation: "poll", outcome: "signed-in" },
        { operation: "sign-out", outcome: "signed-out" },
        { operation: "sign-out", outcome: "unavailable", reason: "draining" },
        { operation: "cancel", outcome: "cancelled" },
        { operation: "sign-out", outcome: "signed-out" },
      ]);
    }),
);

posix(
  "past its code's end a sign-in ends as expired only once Hermes confirmed the cancel",
  () =>
    within({}, async (fake, signIn, _journal, clock) => {
      const late = await signIn.start();
      if (late.kind !== "pending") throw new Error("not pending");
      clock.now += 900_000 + buddySignInExpiryGraceMs;
      fake.state.http = sessionDeletes(() =>
        Response.json({ detail: "Internal Server Error" }, { status: 500 }),
      );
      expect(await signIn.poll(late.session)).toEqual(late);
      expect(fake.sessions.size).toBe(1);
      // Nor does it end while the gateway does not answer.
      fake.state.http = undefined;
      fake.state.identify = () => "hang";
      expect(await signIn.poll(late.session)).toEqual(late);
      fake.state.identify = undefined;
      expect(await signIn.poll(late.session)).toEqual({
        kind: "failed",
        reason: "expired",
      });
      expect(fake.sessions.size).toBe(0);
    }),
);

posix(
  "a start of no known shape whose cancel is not confirmed stays held without a holder: nothing else starts or signs out until it ends",
  () =>
    within({ signedIn: true }, async (fake, signIn) => {
      fake.state.http = (request) =>
        request.path.endsWith("/start")
          ? Response.json({
              ...recorded.http.start.body,
              session_id: "Fixture_Session_bad001",
              user_code: "not a code",
            })
          : request.method === "DELETE" &&
              request.path.startsWith("/api/providers/oauth/sessions/")
            ? Response.json(
                { detail: "Internal Server Error" },
                { status: 500 },
              )
            : undefined;
      fake.sessions.set("Fixture_Session_bad001", {
        status: "pending",
        error_message: null,
      });
      expect(await signIn.start()).toEqual({
        kind: "failed",
        reason: "failed",
      });
      expect(await signIn.start()).toEqual(blocked);
      expect(await signIn.signOut()).toEqual(blocked);
      expect(fake.state.signedIn).toBe(true);
      // Its code went to nobody: no handle names it.
      for (const handle of ["0".repeat(32), "f".repeat(32)]) {
        expect(await signIn.poll(handle)).toEqual({ kind: "none" });
        expect(await signIn.cancel(handle)).toEqual({ kind: "none" });
      }
      fake.state.http = undefined;
      const next = await signIn.start();
      expect(next.kind).toBe("pending");
      expect(fake.sessions.has("Fixture_Session_bad001")).toBe(false);
      clean(JSON.stringify(next), fake, ["code"]);
    }),
);

posix(
  "start without Buddy's gateway: unavailable with its reason, nothing started",
  () =>
    within({}, async (fake, signIn, journal) => {
      await fake.stop();
      expect(await signIn.start()).toEqual({
        kind: "unavailable",
        reason: "no-socket",
      });
      expect(journal).toEqual([
        { operation: "start", outcome: "unavailable", reason: "no-socket" },
      ]);
    }),
);

test("the status truth table: works, waits or unknown, never more than the facts say", () => {
  const table: [BuddyFacts, ReturnType<typeof buddyStatus>][] = [
    [
      { runtime: "ready", loggedIn: true },
      { state: "works", signIn: { state: "connected" } },
    ],
    [
      { runtime: "ready", loggedIn: false },
      { state: "waits", signIn: { state: "none" } },
    ],
    [
      { runtime: "ready", loggedIn: undefined },
      { state: "unknown", signIn: { state: "unknown" } },
    ],
    [
      { runtime: "not-running" },
      {
        state: "unknown",
        reason: "not-running",
        signIn: { state: "unknown" },
      },
    ],
    [
      { runtime: "unknown" },
      { state: "unknown", signIn: { state: "unknown" } },
    ],
  ];
  for (const [facts, status] of table)
    expect(buddyStatus(facts)).toEqual(status);
  // No "attention" until Hermes says a sign-in needs to be renewed
  // (Lazurio/hermes-agent#16).
  for (const [facts] of table)
    expect(JSON.stringify(buddyStatus(facts))).not.toContain("attention");
});

posix(
  "the facts as each reading finds them: Hermes's card, a gateway that does not run, one that cannot be asked",
  async () => {
    const fake = await fakeHermesGateway();
    try {
      const gateway = createHermesGateway({
        home: fake.userHome,
        controlMs: 300,
      });
      expect(await readBuddyFacts(gateway)).toEqual({
        runtime: "ready",
        loggedIn: false,
      });
      fake.state.signedIn = true;
      expect(await readBuddyFacts(gateway)).toEqual({
        runtime: "ready",
        loggedIn: true,
      });
      // A card of no known shape, or no card for openai-codex.
      for (const body of [
        { providers: [] },
        { providers: [{ id: "openai-codex", status: { logged_in: "yes" } }] },
        {
          providers: [
            { id: "openai-codex", status: { logged_in: false, error: "x" } },
            { id: "openai-codex", status: { logged_in: true } },
          ],
        },
        { nothing: true },
      ]) {
        fake.state.http = () => Response.json(body);
        expect(await readBuddyFacts(gateway)).toEqual({
          runtime: "ready",
          loggedIn: undefined,
        });
      }
      // Hermes's card when no credential reads: logged out with an error.
      fake.state.http = () =>
        Response.json({
          providers: [
            {
              id: "openai-codex",
              status: { logged_in: false, error: "not logged in" },
            },
          ],
        });
      expect(await readBuddyFacts(gateway)).toEqual({
        runtime: "ready",
        loggedIn: false,
      });
      fake.state.http = undefined;
      for (const [state, runtime] of [
        ["starting", "not-running"],
        ["draining", "not-running"],
      ] as const) {
        fake.state.identify = (answer) => {
          (answer.result as Record<string, unknown>).state = state;
          return answer;
        };
        expect(await readBuddyFacts(gateway)).toEqual({ runtime });
      }
      fake.state.identify = () => "hang";
      expect(await readBuddyFacts(gateway)).toEqual({ runtime: "unknown" });
      fake.state.identify = () => ({ raw: "{}" });
      expect(await readBuddyFacts(gateway)).toEqual({ runtime: "unknown" });
      fake.state.identify = undefined;
      await fake.stop();
      expect(await readBuddyFacts(gateway)).toEqual({ runtime: "not-running" });
    } finally {
      await fake.close();
    }
  },
);
