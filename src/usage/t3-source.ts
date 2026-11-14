import { Database } from "bun:sqlite";
import {
  harnessOf,
  instant,
  type UsageEvent,
  type UsageOrigin,
  usableModel,
  usageId,
} from "./events";

// Usage from T3 Code's own state (proposed, docs/usage-producer.md). T3 Code
// owns the database; this adapter opens it read-only and selects named
// columns and named JSON keys only:
//
//   runs        -> task.started, task.completed | failed | cancelled
//   subagents   -> the same, with the run as parent_task_id (a subtask)
//   provider    -> model.usage: input and output tokens of a turn, with the
//   turns          run's model; T3 Code records no cost, so none is sent
//   scheduled   -> a run in a scheduled task's thread is automation
//   tasks
//
// Never read: thread titles, messages, prompts, scheduled task titles or
// prompts, paths, branches, pull requests. When a table or column this
// adapter needs is missing, T3 Code has changed its schema: nothing is
// produced (`unavailable`), never a guess.

export type T3UsageRead =
  | Readonly<{ kind: "ready"; events: readonly UsageEvent[] }>
  | Readonly<{ kind: "unavailable"; reason: "absent" | "schema" | "locked" }>;

const required: Readonly<Record<string, readonly string[]>> = {
  orchestration_v2_projection_runs: [
    "run_id",
    "thread_id",
    "provider",
    "status",
    "requested_at",
    "completed_at",
    "payload_json",
  ],
  orchestration_v2_projection_run_attempts: ["attempt_id", "run_id"],
  orchestration_v2_projection_provider_turns: [
    "provider_turn_id",
    "run_attempt_id",
    "completed_at",
    "payload_json",
  ],
  orchestration_v2_projection_subagents: [
    "subagent_id",
    "run_id",
    "provider",
    "status",
    "started_at",
    "completed_at",
  ],
};

const terminal: Readonly<
  Record<string, "task.completed" | "task.failed" | "task.cancelled">
> = {
  completed: "task.completed",
  failed: "task.failed",
  cancelled: "task.cancelled",
  canceled: "task.cancelled",
  interrupted: "task.cancelled",
};

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((row) => row.name));
}

function schemaFits(db: Database): boolean {
  return Object.entries(required).every(([table, columns]) => {
    const present = columnsOf(db, table);
    return columns.every((column) => present.has(column));
  });
}

type Run = {
  run_id: string;
  thread_id: string;
  provider: string;
  status: string;
  requested_at: string;
  completed_at: string | null;
  model: string | null;
};

/**
 * Every event of runs, subagents and provider turns that happened at or
 * after `since` (an instant). A run that started earlier but ended since
 * gives its outcome; its start was delivered with an earlier read.
 */
export function readT3Usage(path: string, since: string): T3UsageRead {
  let db: Database;
  try {
    db = new Database(path, { readonly: true });
  } catch {
    return { kind: "unavailable", reason: "absent" };
  }
  try {
    if (!schemaFits(db)) return { kind: "unavailable", reason: "schema" };
    const automatedThreads = new Set<string>();
    if (columnsOf(db, "scheduled_tasks").has("thread_id")) {
      for (const row of db
        .query(
          "SELECT thread_id FROM scheduled_tasks WHERE thread_id IS NOT NULL",
        )
        .all() as { thread_id: string }[]) {
        automatedThreads.add(row.thread_id);
      }
    }
    const originOf = (thread: string): UsageOrigin =>
      automatedThreads.has(thread) ? "automation" : "interactive";
    const events: UsageEvent[] = [];
    const runs = db
      .query(
        `SELECT run_id, thread_id, provider, status, requested_at, completed_at,
                json_extract(payload_json, '$.modelSelection.model') AS model
           FROM orchestration_v2_projection_runs
          WHERE requested_at >= ?1 OR completed_at >= ?1`,
      )
      .all(since) as Run[];
    const runOf = new Map<string, Run>();
    for (const run of runs) {
      runOf.set(run.run_id, run);
      const task = usageId(`task:${run.run_id}`);
      const origin = originOf(run.thread_id);
      const harness = harnessOf(run.provider);
      const started = instant(run.requested_at);
      if (started !== null && started >= since) {
        events.push({
          event_id: usageId(`run:${run.run_id}:started`),
          occurred_at: started,
          type: "task.started",
          origin,
          task_id: task,
          harness,
        });
      }
      const outcome = terminal[run.status];
      const ended = instant(run.completed_at);
      if (outcome !== undefined && ended !== null && ended >= since) {
        events.push({
          event_id: usageId(`run:${run.run_id}:${outcome}`),
          occurred_at: ended,
          type: outcome,
          origin,
          task_id: task,
        });
      }
    }

    const subagents = db
      .query(
        `SELECT s.subagent_id, s.run_id, s.provider, s.status, s.started_at, s.completed_at, r.thread_id
           FROM orchestration_v2_projection_subagents s
           LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = s.run_id
          WHERE s.started_at >= ?1 OR s.completed_at >= ?1`,
      )
      .all(since) as {
      subagent_id: string;
      run_id: string | null;
      provider: string;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      thread_id: string | null;
    }[];
    for (const sub of subagents) {
      const task = usageId(`subagent:${sub.subagent_id}`);
      const parent =
        sub.run_id === null ? undefined : usageId(`task:${sub.run_id}`);
      const origin =
        sub.thread_id === null ? "interactive" : originOf(sub.thread_id);
      const started = instant(sub.started_at);
      if (started !== null && started >= since) {
        events.push({
          event_id: usageId(`subagent:${sub.subagent_id}:started`),
          occurred_at: started,
          type: "task.started",
          origin,
          task_id: task,
          ...(parent === undefined ? {} : { parent_task_id: parent }),
          harness: harnessOf(sub.provider),
        });
      }
      const outcome = terminal[sub.status];
      const ended = instant(sub.completed_at);
      if (outcome !== undefined && ended !== null && ended >= since) {
        events.push({
          event_id: usageId(`subagent:${sub.subagent_id}:${outcome}`),
          occurred_at: ended,
          type: outcome,
          origin,
          task_id: task,
        });
      }
    }

    const turns = db
      .query(
        `SELECT t.provider_turn_id, t.completed_at, a.run_id,
                json_extract(t.payload_json, '$.turnTokenUsage.usageStatus') AS usage_status,
                json_extract(t.payload_json, '$.turnTokenUsage.inputTokens') AS input_tokens,
                json_extract(t.payload_json, '$.turnTokenUsage.outputTokens') AS output_tokens
           FROM orchestration_v2_projection_provider_turns t
           JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
          WHERE t.completed_at >= ?1`,
      )
      .all(since) as {
      provider_turn_id: string;
      completed_at: string | null;
      run_id: string;
      usage_status: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }[];
    for (const turn of turns) {
      const ended = instant(turn.completed_at);
      const tokens = [turn.input_tokens, turn.output_tokens];
      if (
        ended === null ||
        turn.usage_status === "unavailable" ||
        !tokens.every((n) => Number.isSafeInteger(n) && (n ?? -1) >= 0)
      )
        continue;
      const run = runOf.get(turn.run_id);
      const model = usableModel(run?.model);
      events.push({
        event_id: usageId(`turn:${turn.provider_turn_id}:usage`),
        occurred_at: ended,
        type: "model.usage",
        origin: run === undefined ? "interactive" : originOf(run.thread_id),
        task_id: usageId(`task:${turn.run_id}`),
        model: model ?? "unknown",
        input_tokens: turn.input_tokens ?? 0,
        output_tokens: turn.output_tokens ?? 0,
      });
    }
    events.sort(
      (a, b) =>
        a.occurred_at.localeCompare(b.occurred_at) ||
        a.event_id.localeCompare(b.event_id),
    );
    return { kind: "ready", events };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      kind: "unavailable",
      reason: /locked|busy/i.test(message) ? "locked" : "schema",
    };
  } finally {
    db.close();
  }
}
