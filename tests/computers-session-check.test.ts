import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachPath, createComputerAttach } from "../src/computers/attach-ws";
import {
  computerSessionHeader,
  createComputerSessionCheck,
} from "../src/computers/session-check";
import cases from "./fixtures/device-launchpad-cases.json";
import { type ManualClock, manualClock } from "./fixtures/manual-clock";

// The Launchpad's side of contract v3 against every `device.launchpad` case
// of Lazurio Auth's oracle (tests/fixtures/device-launchpad-cases.json, pinned
// verbatim): the attach route's answer before the upgrade, the first message
// after it and the session's deadline, then the recheck of an open session.
// A fake check endpoint on loopback stands for the gateway helper's.

const posix = process.platform !== "win32";
type Message = Record<string, unknown>;
type Check =
  | null
  | Readonly<{ unreachable: true }>
  | Readonly<{ status: number; body?: unknown }>;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const newProof = () => randomBytes(32).toString("base64url");

/** A fake helper: answers each proof as told, every other proof with 404. */
function fakeHelper() {
  const answers = new Map<string, Check>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const answer = answers.get(
        request.headers.get(computerSessionHeader) ?? "",
      );
      if (answer === undefined || answer === null || "unreachable" in answer)
        return new Response(null, { status: 404 });
      return answer.body === undefined
        ? new Response(null, { status: answer.status })
        : Response.json(answer.body, { status: answer.status });
    },
  });
  cleanup.push(() => server.stop(true));
  return {
    url: `http://127.0.0.1:${server.port}/check`,
    answers,
    stop: () => server.stop(true),
  };
}

/** A loopback address nothing listens on: the check cannot be made. */
async function deadUrl(): Promise<string> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const url = `http://127.0.0.1:${server.port}/check`;
  server.stop(true);
  return url;
}

async function launchpad(checkUrl: string, assignedUser: string) {
  const home = await mkdtemp(join(tmpdir(), "lzs-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const sessionCheck = createComputerSessionCheck({
    checkUrl,
    assignedSubject: assignedUser,
  });
  const attach = createComputerAttach({
    home,
    uid: process.getuid?.(),
    version: "test",
    verifyGatewayProof: sessionCheck.verifyGatewayProof,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: attach.websocket,
    fetch(request, server) {
      return attach.upgrade(request, server, "127.0.0.1") ?? undefined;
    },
  });
  cleanup.push(() => server.stop(true));
  return { home, attach, server };
}

/** A computer on contract v3 behind the gateway: the gateway's proof in its
 * upgrade, then MCP as Lazurio App answers it. */
function computer(port: number, proof: string, query = "") {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${attachPath}${query === "" ? "" : `?${query}`}`,
    { headers: { [computerSessionHeader]: proof } } as unknown as string[],
  );
  const seen: Message[] = [];
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve(event.code));
    ws.addEventListener("error", () => resolve(-1));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    seen.push(message);
    if (message.jsonrpc === undefined || message.id === undefined) return;
    const reply = (result: unknown) =>
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize")
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "lazurio-device", version: "0.2.0" },
        _meta: { "io.lazurio/app": { version: "0.2.0", deviceLock: 1 } },
      });
    else if (message.method === "tools/list") reply({ tools: [] });
    else reply({});
  });
  return { ws, seen, closed };
}

async function waitFor(check: () => boolean, ms = 3_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const upgradeHeaders = { connection: "Upgrade", upgrade: "websocket" };

for (const c of cases.attach)
  test.skipIf(!posix)(`device.launchpad attach: ${c.id}`, async () => {
    const assigned = c.environment.assignedUser;
    const check = c.check as Check;
    const helper = fakeHelper();
    const checkUrl =
      check !== null && "unreachable" in check ? await deadUrl() : helper.url;
    const { attach, server } = await launchpad(checkUrl, assigned);
    // The devices that already hold a session.
    for (const device of c.attached) {
      const proof = newProof();
      helper.answers.set(proof, {
        status: 200,
        body: { subject: assigned, deviceId: device, expiresIn: 280 },
      });
      const held = computer(server.port as number, proof);
      await waitFor(() => held.seen.some((m) => m.type === "ready"));
      cleanup.push(() => held.ws.close());
    }
    const proof = newProof();
    if (check !== null && !("unreachable" in check))
      helper.answers.set(proof, check);
    const expected = c.expected as Readonly<{
      status?: number;
      upgrade?: boolean;
      message?: Message;
      closeIn?: number;
    }>;
    if (expected.status !== undefined) {
      let upgraded = false;
      const answer = await attach.upgrade(
        new Request(
          `http://127.0.0.1${attachPath}${c.request.query === "" ? "" : `?${c.request.query}`}`,
          {
            headers: {
              ...upgradeHeaders,
              ...(c.request.proof ? { [computerSessionHeader]: proof } : {}),
            },
          },
        ),
        {
          upgrade: () => {
            upgraded = true;
            return true;
          },
        },
        "127.0.0.1",
      );
      expect(upgraded).toBe(false);
      expect(answer?.status).toBe(expected.status);
      return;
    }
    const fake = computer(server.port as number, proof, c.request.query);
    await waitFor(() => fake.seen.length > 0);
    expect(fake.seen[0]).toEqual(expected.message as Message);
    if (expected.closeIn !== undefined) {
      // The session's deadline is the check's `expiresIn`.
      const at = 1_000_000;
      const timed = createComputerSessionCheck({
        checkUrl,
        assignedSubject: assigned,
        now: () => at,
      });
      const verified = await timed.verifyGatewayProof(
        new Request("http://127.0.0.1/", {
          headers: { [computerSessionHeader]: proof },
        }),
      );
      expect(verified.ok).toBe(true);
      if (verified.ok)
        expect(verified.identity.deadline?.()).toBe(
          at + expected.closeIn * 1000,
        );
    }
    fake.ws.close();
    await fake.closed;
  });

for (const c of cases.recheck)
  test(`device.launchpad recheck: ${c.id}`, async () => {
    const assigned = c.environment.assignedUser;
    const helper = fakeHelper();
    let at = 1_000_000;
    const proof = newProof();
    // The session as it was admitted.
    helper.answers.set(proof, {
      status: 200,
      body: { subject: assigned, deviceId: "mira-laptop", expiresIn: 280 },
    });
    const admit = createComputerSessionCheck({
      checkUrl: helper.url,
      assignedSubject: assigned,
      now: () => at,
    });
    const admitted = await admit.verifyGatewayProof(
      new Request("http://127.0.0.1/", {
        headers: { [computerSessionHeader]: proof },
      }),
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // Later, within the deadline, the helper answers the recheck as the case
    // says, or does not answer at all.
    at += 60_000;
    const check = c.check as Check;
    if (check !== null && "unreachable" in check) helper.stop();
    else if (check !== null) helper.answers.set(proof, check);
    const expected = c.expected as Readonly<{
      action: string;
      closeIn?: number;
    }>;
    const kept = await admitted.identity.stillAllowed();
    expect(kept).toBe(expected.action === "keep");
    if (expected.action === "keep" && expected.closeIn !== undefined)
      expect(admitted.identity.deadline?.()).toBe(at + expected.closeIn * 1000);
  });

/** A Launchpad on a clock the test moves (`./fixtures/manual-clock`): the
 * check of the gateway's proof and the session's timers follow the same
 * time. The journal notes when each line was written. */
async function timedLaunchpad(
  checkUrl: string,
  assignedUser: string,
  clock: ManualClock,
  fetcher?: (input: string, init: RequestInit) => Promise<Response>,
) {
  const home = await mkdtemp(join(tmpdir(), "lzs-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const sessionCheck = createComputerSessionCheck({
    checkUrl,
    assignedSubject: assignedUser,
    now: clock.now,
    ...(fetcher === undefined ? {} : { fetcher }),
  });
  const journal: Record<string, string>[] = [];
  const attach = createComputerAttach({
    home,
    uid: process.getuid?.(),
    version: "test",
    verifyGatewayProof: sessionCheck.verifyGatewayProof,
    now: clock.now,
    setTimer: clock.setTimer,
    journal: (line) => journal.push({ ...line, at: String(clock.now()) }),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: attach.websocket,
    fetch(request, server) {
      return attach.upgrade(request, server, "127.0.0.1") ?? undefined;
    },
  });
  cleanup.push(() => server.stop(true));
  return { home, attach, server, journal };
}

/** When the journal said a session expired, by the test's clock. */
const expiredAt = (journal: readonly Record<string, string>[]) => {
  const at = journal.find((line) => line.reason === "expired")?.at;
  return at === undefined ? undefined : Number(at);
};

test.skipIf(!posix)(
  "an open session whose proof is no longer confirmed ends with denied expired",
  async () => {
    const assigned = "00000000-0000-4000-8000-0000000000c1";
    const helper = fakeHelper();
    const clock = manualClock();
    const { server } = await timedLaunchpad(helper.url, assigned, clock);
    const proof = newProof();
    helper.answers.set(proof, {
      status: 200,
      body: { subject: assigned, deviceId: "mira-laptop", expiresIn: 280 },
    });
    const fake = computer(server.port as number, proof);
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    helper.answers.set(proof, { status: 404 });
    // The next check comes within the contract's 60 seconds.
    clock.advance(60_000);
    expect(await fake.closed).toBe(1008);
    expect(fake.seen.at(-1)).toEqual({
      type: "denied",
      v: 3,
      reason: "expired",
    });
  },
);

test.skipIf(!posix)(
  "a confirmation of one second is checked again before its deadline, and every confirmation moves the next check",
  async () => {
    const assigned = "00000000-0000-4000-8000-0000000000c1";
    const clock = manualClock();
    const proof = newProof();
    // When the helper was asked, by the test's clock.
    const asked: number[] = [];
    const fetcher = async () => {
      asked.push(clock.now());
      return Response.json({
        subject: assigned,
        deviceId: "mira-laptop",
        expiresIn: 1,
      });
    };
    const { server, journal } = await timedLaunchpad(
      "http://127.0.0.1:9/check",
      assigned,
      clock,
      fetcher,
    );
    const fake = computer(server.port as number, proof);
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    const admitted = asked[0] as number;
    expect(asked.length).toBe(1);
    // Half the time to the deadline at the latest: checked at 500 ms.
    clock.advance(500);
    await waitFor(() => asked.length === 2);
    expect(asked[1]).toBe(admitted + 500);
    expect(asked[1] as number).toBeLessThan(admitted + 1_000);
    // The confirmation moved the deadline and the next check from its own
    // time; past the first deadline the session lives on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock.advance(500);
    await waitFor(() => asked.length === 3);
    expect(asked[2]).toBe(admitted + 1_000);
    expect(expiredAt(journal)).toBeUndefined();
    expect(fake.seen.some((m) => m.type === "denied")).toBe(false);
    fake.ws.close();
    await fake.closed;
  },
);

test.skipIf(!posix)(
  "a long confirmation is still checked again within 60 seconds",
  async () => {
    const assigned = "00000000-0000-4000-8000-0000000000c1";
    const clock = manualClock();
    const asked: number[] = [];
    const fetcher = async () => {
      asked.push(clock.now());
      return Response.json({
        subject: assigned,
        deviceId: "mira-laptop",
        expiresIn: 300,
      });
    };
    const { server } = await timedLaunchpad(
      "http://127.0.0.1:9/check",
      assigned,
      clock,
      fetcher,
    );
    const fake = computer(server.port as number, newProof());
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    clock.advance(59_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked.length).toBe(1);
    clock.advance(1);
    await waitFor(() => asked.length === 2);
    expect(asked[1]).toBe((asked[0] as number) + 60_000);
    fake.ws.close();
    await fake.closed;
  },
);

test("a confirmation that arrives after the deadline revives nothing and moves no deadline", async () => {
  const assigned = "00000000-0000-4000-8000-0000000000c1";
  let at = 1_000_000;
  let calls = 0;
  const sessionCheck = createComputerSessionCheck({
    checkUrl: "http://127.0.0.1:9/check",
    assignedSubject: assigned,
    now: () => at,
    fetcher: async () => {
      calls += 1;
      // The recheck starts at 999 ms and comes back at 1001 ms, past the
      // deadline of 1000 ms (review of #1050).
      if (calls > 1) at = 1_000_000 + 1_001;
      return Response.json({
        subject: assigned,
        deviceId: "mira-laptop",
        expiresIn: 1,
      });
    },
  });
  const admitted = await sessionCheck.verifyGatewayProof(
    new Request("http://127.0.0.1/", {
      headers: { [computerSessionHeader]: newProof() },
    }),
  );
  expect(admitted.ok).toBe(true);
  if (!admitted.ok) return;
  expect(admitted.identity.deadline()).toBe(1_001_000);
  at = 1_000_000 + 999;
  expect(await admitted.identity.stillAllowed()).toBe(false);
  expect(admitted.identity.deadline()).toBe(1_001_000);
  // Nor does a later one: the session is over.
  expect(await admitted.identity.stillAllowed()).toBe(false);
  expect(admitted.identity.deadline()).toBe(1_001_000);
});

test.skipIf(!posix)(
  "a session ends exactly at the deadline of its last confirmed check, without another check",
  async () => {
    const assigned = "00000000-0000-4000-8000-0000000000c1";
    const clock = manualClock();
    let calls = 0;
    // The first check confirms 30 seconds; the recheck never comes back.
    const fetcher = (_input: string, _init: RequestInit) => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(
            Response.json({
              subject: assigned,
              deviceId: "mira-laptop",
              expiresIn: 30,
            }),
          )
        : new Promise<Response>(() => undefined);
    };
    const { server, journal } = await timedLaunchpad(
      "http://127.0.0.1:9/check",
      assigned,
      clock,
      fetcher,
    );
    const fake = computer(server.port as number, newProof());
    await waitFor(() => fake.seen.some((m) => m.type === "ready"));
    const deadline = clock.now() + 30_000;
    clock.advance(29_999);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(2);
    expect(expiredAt(journal)).toBeUndefined();
    expect(fake.seen.some((message) => message.type === "denied")).toBe(false);
    clock.advance(1);
    // Closed at the deadline itself, not a moment after.
    expect(expiredAt(journal)).toBe(deadline);
    expect(await fake.closed).toBe(1008);
    expect(fake.seen.at(-1)).toEqual({
      type: "denied",
      v: 3,
      reason: "expired",
    });
    // Nothing is served after it: no timer of the session is left.
    expect(clock.pending()).toEqual([]);
  },
);
