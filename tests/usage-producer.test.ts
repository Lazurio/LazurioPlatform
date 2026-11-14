import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayTransport } from "../src/organization-settings/relay";
import { usageRelayPath, usageRound } from "../src/usage/collect";
import { usageBatchMaxEvents, usageId } from "../src/usage/events";
import {
  disableUsage,
  enableUsage,
  usageStateStore,
} from "../src/usage/outbox";
import { readT3Usage } from "../src/usage/t3-source";

// Protects the proposed usage producer (docs/usage-producer.md): measuring is
// off unless switched on, and off reads nothing and sends nothing; nothing
// that happened before consent is ever sent; no event carries content (a
// title, a message, a prompt) or a person; an occurrence keeps its id, so a
// redelivery is a no-op at the Dashboard; switching off deletes the queue;
// an Environment the Dashboard does not collect stops measuring.

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "usage-producer-"));
  dirs.push(dir);
  return dir;
}

const SECRET = "Nabídka pro zákazníka: tajné zadání";

/** A T3 Code state with the tables the adapter reads, and content it must never read. */
function t3State(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, text TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER, provider TEXT NOT NULL,
      status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, run_attempt_id TEXT, completed_at TEXT, payload_json TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_subagents (subagent_id TEXT PRIMARY KEY, run_id TEXT, provider TEXT NOT NULL, status TEXT NOT NULL,
      started_at TEXT, completed_at TEXT);
    CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, thread_id TEXT);
  `);
  db.run(
    "INSERT INTO orchestration_v2_projection_threads VALUES ('t-1', ?), ('t-auto', ?)",
    [SECRET, SECRET],
  );
  db.run("INSERT INTO projection_thread_messages VALUES ('m-1', 't-1', ?)", [
    SECRET,
  ]);
  db.run("INSERT INTO scheduled_tasks VALUES ('s-1', ?, ?, 't-auto')", [
    SECRET,
    SECRET,
  ]);
  const run = (
    id: string,
    thread: string,
    provider: string,
    status: string,
    requested: string,
    completed: string | null,
  ) =>
    db.run(
      "INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
      [
        id,
        thread,
        provider,
        status,
        requested,
        completed,
        JSON.stringify({
          modelSelection: { model: "gpt-6.1-sol" },
          prompt: SECRET,
        }),
      ],
    );
  run(
    "r-old",
    "t-1",
    "codex",
    "completed",
    "2026-11-10T08:00:00.000Z",
    "2026-11-10T08:10:00.000Z",
  );
  run(
    "r-done",
    "t-1",
    "codex",
    "completed",
    "2026-11-12T09:00:00.000Z",
    "2026-11-12T09:20:00.000Z",
  );
  run(
    "r-failed",
    "t-1",
    "claudeAgent",
    "failed",
    "2026-11-12T10:00:00.000Z",
    "2026-11-12T10:05:00.000Z",
  );
  run(
    "r-cancelled",
    "t-1",
    "codex",
    "cancelled",
    "2026-11-12T11:00:00.000Z",
    "2026-11-12T11:01:00.000Z",
  );
  run("r-running", "t-1", "codex", "running", "2026-11-12T12:00:00.000Z", null);
  run(
    "r-auto",
    "t-auto",
    "codex",
    "completed",
    "2026-11-12T03:00:00.000Z",
    "2026-11-12T03:30:00.000Z",
  );
  db.run(
    "INSERT INTO orchestration_v2_projection_run_attempts VALUES ('a-done', 'r-done')",
  );
  db.run(
    "INSERT INTO orchestration_v2_projection_provider_turns VALUES ('p-1', 'a-done', '2026-11-12T09:10:00.000Z', ?)",
    [
      JSON.stringify({
        turnTokenUsage: {
          usageStatus: "complete",
          inputTokens: 1200,
          outputTokens: 300,
        },
        text: SECRET,
      }),
    ],
  );
  db.run(
    "INSERT INTO orchestration_v2_projection_provider_turns VALUES ('p-2', 'a-done', '2026-11-12T09:15:00.000Z', ?)",
    [JSON.stringify({ turnTokenUsage: { usageStatus: "unavailable" } })],
  );
  db.run(
    "INSERT INTO orchestration_v2_projection_subagents VALUES ('sub-1', 'r-done', 'codex', 'completed', '2026-11-12T09:05:00.000Z', '2026-11-12T09:08:00.000Z')",
  );
  return db;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS = new Set([
  "event_id",
  "occurred_at",
  "type",
  "origin",
  "app",
  "task_id",
  "parent_task_id",
  "harness",
  "model",
  "input_tokens",
  "output_tokens",
]);

test("an occurrence keeps one id, shaped as the Dashboard's UUID", () => {
  expect(usageId("run:r-1:started")).toBe(usageId("run:r-1:started"));
  expect(usageId("run:r-1:started")).not.toBe(usageId("run:r-2:started"));
  for (let i = 0; i < 200; i++) expect(usageId(`k${i}`)).toMatch(UUID);
});

test("T3 Code's runs, subagents and turns become events; no content and no person", async () => {
  const path = join(await temp(), "state.sqlite");
  t3State(path).close();
  const read = readT3Usage(path, "2026-11-12T00:00:00.000Z");
  if (read.kind !== "ready") throw new Error(read.reason);
  const kinds = read.events.map((e) => `${e.type}:${e.origin}`);
  expect(kinds.filter((k) => k.startsWith("task.started"))).toHaveLength(6);
  expect(kinds).toContain("task.completed:automation");
  expect(kinds).toContain("task.failed:interactive");
  expect(kinds).toContain("task.cancelled:interactive");
  // The run before `since` is not read; the running one has no outcome.
  expect(read.events.some((e) => e.task_id === usageId("task:r-old"))).toBe(
    false,
  );
  expect(
    read.events
      .filter((e) => e.task_id === usageId("task:r-running"))
      .map((e) => e.type),
  ).toEqual(["task.started"]);
  const sub = read.events.find(
    (e) => e.task_id === usageId("subagent:sub-1") && e.type === "task.started",
  );
  expect(sub?.parent_task_id).toBe(usageId("task:r-done"));
  // One usable turn: its tokens and the run's model, and no cost.
  const usage = read.events.filter((e) => e.type === "model.usage");
  expect(usage).toEqual([
    {
      event_id: usageId("turn:p-1:usage"),
      occurred_at: "2026-11-12T09:10:00.000Z",
      type: "model.usage",
      origin: "interactive",
      task_id: usageId("task:r-done"),
      model: "gpt-6.1-sol",
      input_tokens: 1200,
      output_tokens: 300,
    },
  ]);
  const text = JSON.stringify(read.events);
  expect(text).not.toContain("Nabídka");
  expect(text).not.toContain("t-1");
  for (const event of read.events) {
    expect(event.event_id).toMatch(UUID);
    for (const key of Object.keys(event)) expect(KEYS.has(key)).toBe(true);
  }
});

test("a changed or missing T3 Code state produces nothing", async () => {
  const dir = await temp();
  expect(
    readT3Usage(join(dir, "absent.sqlite"), "2026-11-12T00:00:00.000Z"),
  ).toEqual({ kind: "unavailable", reason: "absent" });
  const path = join(dir, "changed.sqlite");
  const db = new Database(path, { create: true });
  db.exec(
    "CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY)",
  );
  db.close();
  expect(readT3Usage(path, "2026-11-12T00:00:00.000Z")).toEqual({
    kind: "unavailable",
    reason: "schema",
  });
});

type Sent = { path: string; ids: string[] };

function relay(statuses: number[], sent: Sent[]): RelayTransport {
  return async (input) => {
    const body = JSON.parse(input.body ?? "{}") as {
      events: { event_id: string }[];
    };
    sent.push({ path: input.path, ids: body.events.map((e) => e.event_id) });
    const status = statuses.shift() ?? 202;
    return status === 0
      ? { kind: "failed", reason: "socket-absent" }
      : { kind: "answer", status, type: "application/json", text: "{}" };
  };
}

test("off by default: no source is read and nothing reaches the relay", async () => {
  const store = usageStateStore(await temp());
  let reads = 0;
  const sent: Sent[] = [];
  const round = await usageRound({
    store,
    read: () => {
      reads += 1;
      return { kind: "ready", events: [] };
    },
    relay: relay([], sent),
    now: () => new Date("2026-11-13T07:00:00.000Z"),
  });
  expect([round.kind, reads, sent.length]).toEqual(["off", 0, 0]);
});

test("on: only what happened after consent is sent; a failed delivery keeps the queue and resends the same ids", async () => {
  const dir = await temp();
  const path = join(dir, "state.sqlite");
  t3State(path).close();
  const store = usageStateStore(dir);
  await enableUsage(store, new Date("2026-11-12T08:30:00.000Z"));
  const sent: Sent[] = [];
  const deps = {
    store,
    read: (since: string) => readT3Usage(path, since),
    now: () => new Date("2026-11-13T07:00:00.000Z"),
  };
  const first = await usageRound({ ...deps, relay: relay([0], sent) });
  expect(first.kind).toBe("waiting");
  // The automated run at 03:00 happened before consent at 08:30 and is never queued.
  expect(sent[0]?.ids).not.toContain(usageId("run:r-auto:started"));
  expect(sent[0]?.path).toBe(usageRelayPath);
  const second = await usageRound({ ...deps, relay: relay([202], sent) });
  expect([second.kind, second.queued]).toEqual(["delivered", 0]);
  expect(sent[1]?.ids).toEqual(sent[0]?.ids);
  const state = await store.read();
  expect(state.lastDelivery?.outcome).toBe("delivered");
});

test("switching off deletes the queue at once; an Environment the Dashboard does not collect stops measuring", async () => {
  const dir = await temp();
  const store = usageStateStore(dir);
  await enableUsage(store, new Date("2026-11-12T00:00:00.000Z"));
  const event = (i: number) => ({
    event_id: usageId(`e${i}`),
    occurred_at: "2026-11-12T09:00:00.000Z",
    type: "task.started" as const,
    origin: "interactive" as const,
    task_id: usageId(`t${i}`),
  });
  const sent: Sent[] = [];
  const many = Array.from({ length: usageBatchMaxEvents + 5 }, (_, i) =>
    event(i),
  );
  await usageRound({
    store,
    read: () => ({ kind: "ready", events: many }),
    relay: relay([0], sent),
    now: () => new Date("2026-11-13T07:00:00.000Z"),
  });
  expect(sent[0]?.ids).toHaveLength(usageBatchMaxEvents);
  expect((await store.read()).queue).toHaveLength(usageBatchMaxEvents + 5);
  await disableUsage(store);
  await expect(stat(join(dir, "usage", "state.json"))).rejects.toThrow();
  expect((await store.read()).enabled).toBe(false);

  await enableUsage(store, new Date("2026-11-12T00:00:00.000Z"));
  const refused = await usageRound({
    store,
    read: () => ({ kind: "ready", events: [event(1)] }),
    relay: relay([403], sent),
    now: () => new Date("2026-11-13T07:00:00.000Z"),
  });
  expect(refused).toEqual({ kind: "off", queued: 0, outcome: "not-collected" });
  expect((await store.read()).enabled).toBe(false);
});
