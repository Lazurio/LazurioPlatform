import { join } from "node:path";
import type { ActiveWork } from "../buddy/gateway-refresh";
import type { ToolRunner } from "../tools/status";

// Whether Buddy GEN4 is in a turn (plan LZD-0033 R11a, Lazurio/LazurioPlatform
// #1103). Buddy GEN4 is a thread of the person's shared T3 Code (`~/.t3`),
// and T3 Code's own agent CLI answers both questions, so there is one way
// to this information (agreed with the thread that holds Buddy's T3 Code):
// - `t3 lazurio buddy signal --json` names Buddy's thread (`threadId`);
// - `t3 events --thread <id>` prints that thread's line with its `status`,
//   then a `synced` line.
// Fail closed: every refusal is `unknown`, which the brain takes for work,
// with one exception. `no_thread` is `idle` (a Buddy without a thread runs no
// turn) only where his T3 Code tells it from a failed read: from
// 0.1.10-lazurio.4 (Lazurio/t3code#239) a thread confirmed absent answers
// `no_thread` and a failed read `unavailable`. Before it, `no_thread` also
// stood for a failed search for his thread or a failed read of its records,
// so it did not prove that no turn runs (Lazurio/LazurioPlatform#1111). So
// are `unknown` an answer that is not that JSON (a T3 Code before
// 0.1.10-lazurio.3 prints its help for `signal`), a thread missing from the
// events, no `synced` line, and no answer in time.

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

/** Whether a T3 Code, by what `t3 --version` prints (`t3 v0.1.10-lazurio.4`),
 * tells a thread confirmed absent from a failed read: a release of Lazurio's
 * fork from 0.1.10-lazurio.4 on. Any other version (upstream's, a preview
 * build, one that cannot be read) does not, as far as Lazurio can know. */
export function tellsNoThread(version: string): boolean {
  const found = /^(?:t3 )?v?(\d+)\.(\d+)\.(\d+)-lazurio\.(\d+)$/.exec(
    version.trim(),
  );
  if (found === null) return false;
  const mine = found.slice(1).map(Number);
  // Compared part by part: major, minor, patch, then the fork's release.
  const fixed = [0, 1, 10, 4];
  for (const [i, part] of fixed.entries()) {
    const own = mine[i] ?? 0;
    if (own !== part) return own > part;
  }
  return true;
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
  if ("error" in answer) {
    // `{"error":{"code":"no_thread",…}}`: no thread, where this T3 Code says
    // so only when it knows. Every other refusal, whatever its shape
    // (`unavailable`, `{"error": null}`), leaves the brain waiting.
    const error = answer.error as { code?: unknown } | null;
    if (
      typeof error !== "object" ||
      error === null ||
      error.code !== "no_thread"
    )
      return "unknown";
    const version = await input
      .run([input.t3, "--version"], timeoutMs, input.env)
      .catch(() => "timeout" as const);
    return version !== "timeout" &&
      version.exitCode === 0 &&
      tellsNoThread(version.stdout)
      ? "idle"
      : "unknown";
  }
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
