import { join } from "node:path";
import type { ActiveWork } from "../buddy/gateway-refresh";
import type { ToolRunner } from "../tools/status";

// Whether Buddy GEN4 is in a turn (plan LZD-0033 R11a, Lazurio/LazurioPlatform
// #1103). Buddy GEN4 is a thread of the person's shared T3 Code (`~/.t3`),
// and T3 Code's own agent CLI answers both questions, so there is one way
// to this information (agreed with the thread that holds Buddy's T3 Code):
// - `t3 lazurio buddy signal --json` names Buddy's thread (`threadId`), or
//   refuses with `no_thread` where he has none yet: then nothing runs;
// - `t3 events --thread <id>` prints that thread's line with its `status`,
//   then a `synced` line.
// Fail closed: a refusal of any other kind, an answer that is not that JSON
// (a T3 Code before 0.1.10-lazurio.3 prints its help for `signal`), a
// thread missing from the events, no `synced` line, or no answer in time is
// `unknown`, which the brain takes for work.

/** A thread's states (T3 Code 0.1.10-lazurio.3: `idle` and its runs'
 * `OrchestrationV2RunStatus`): while a turn is under way, and once none is.
 * A state of neither list (a later T3 Code's) is `unknown`. */
const busyStates: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);
const idleStates: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

const timeoutMs = 20_000;

/** The JSON lines of a command's output; null where one is not JSON. */
function jsonLines(
  stdout: string,
): readonly Readonly<Record<string, unknown>>[] | null {
  const lines: Readonly<Record<string, unknown>>[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
      lines.push(value as Record<string, unknown>);
    } catch {
      return null;
    }
  }
  return lines;
}

/** Buddy GEN4's turn, as his T3 Code says it: `t3` is the person's T3 Code
 * CLI, `home` their home (T3 Code's data in `<home>/.t3`). */
export async function buddyGen4Turn(
  input: Readonly<{
    run: ToolRunner;
    t3: string;
    home: string;
    env: Readonly<Record<string, string>>;
  }>,
): Promise<ActiveWork> {
  const baseDir = join(input.home, ".t3");
  const ask = async (args: readonly string[]) => {
    const result = await input
      .run([input.t3, ...args, "--base-dir", baseDir], timeoutMs, input.env)
      .catch(() => "timeout" as const);
    return result === "timeout" ? null : jsonLines(result.stdout);
  };
  const signal = await ask(["lazurio", "buddy", "signal", "--json"]);
  const answer = signal?.length === 1 ? signal[0] : undefined;
  if (answer === undefined) return "unknown";
  const error = answer.error as Record<string, unknown> | undefined;
  if (error !== undefined)
    return error.code === "no_thread" ? "idle" : "unknown";
  const threadId = answer.threadId;
  if (typeof threadId !== "string" || threadId.length === 0) return "unknown";
  const events = await ask(["events", "--thread", threadId]);
  if (events === null || !events.some((line) => line.kind === "synced"))
    return "unknown";
  const thread = events.find(
    (line) => line.kind === "thread" && line.threadId === threadId,
  );
  if (thread === undefined || typeof thread.status !== "string")
    return "unknown";
  if (busyStates.has(thread.status)) return "busy";
  return idleStates.has(thread.status) ? "idle" : "unknown";
}
