/** The `computer` MCP server with a turn: a pass-through in front of the Cua
 * Driver's own proxy (`cua-driver mcp --socket …`, decision F59 point 2).
 *
 * Every JSON-RPC line goes through unchanged, except a `tools/call` of a tool
 * that acts on the screen while a person holds it in the desktop view: that
 * call never reaches the driver and gets a tool error that says why and what
 * to do. Tools that only read (screenshots, window lists, accessibility
 * trees) always pass, so an agent may watch the person work. An input tool
 * that passes is noted in the turn directory, so the desktop page can say
 * which agent is on the screen.
 *
 * Usage: `bun computer-gate.ts [--driver <driver command…>]`; without a command it
 * runs the Environment's `~/.local/bin/cua-driver mcp --socket
 * ~/.local/state/lazurio-computer/driver.sock` with F59's settings. */

import { homedir } from "node:os";
import { join } from "node:path";
import { noteAgent, readPerson } from "./turn";

/** Tools of Cua Driver 0.19.3 that never move the pointer, type, or change a
 * window or the clipboard. Any other tool, also one a later driver adds,
 * counts as input: a new tool waits for the person rather than acting. */
export const readOnlyTools = new Set([
  "check_for_update",
  "check_permissions",
  "clipboard_read",
  "end_session",
  "escalate_session",
  "get_accessibility_tree",
  "get_agent_cursor_state",
  "get_browser_state",
  "get_config",
  "get_cursor_position",
  "get_desktop_state",
  "get_recording_state",
  "get_screen_size",
  "get_session_state",
  "get_window_state",
  "health_report",
  "list_apps",
  "list_windows",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "start_recording",
  "start_session",
  "stop_recording",
  "verify_state",
  "zoom",
]);

export function agentName(
  env: Record<string, string | undefined>,
  args: unknown,
): string {
  const session =
    typeof args === "object" &&
    args !== null &&
    typeof (args as { session?: unknown }).session === "string"
      ? (args as { session: string }).session
      : undefined;
  return (
    env.AGENT_BROWSER_SESSION ??
    (env.CODEX_THREAD_ID ? `codex-${env.CODEX_THREAD_ID}` : undefined) ??
    (env.CLAUDE_CODE_SESSION_ID
      ? `claude-${env.CLAUDE_CODE_SESSION_ID}`
      : undefined) ??
    session ??
    `agent-${process.ppid}`
  );
}

export function refusal(id: unknown, since: number): string {
  const at = new Date(since).toISOString().slice(11, 16);
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `A person holds the Environment's screen in the desktop view (since ${at} UTC). ` +
            "This tool was not run, so nothing moved on the screen. Reading tools still work. " +
            "Do not take the screen back: wait and try again later, or do web pages in the " +
            "Environment browser with agent-browser, and tell the user what you are waiting for.",
        },
      ],
    },
  });
}

type Line = { id?: unknown; method?: unknown; params?: unknown };

/** Decides one line from the agent: forward it, or answer it here. */
export async function gateLine(
  line: string,
  env: Record<string, string | undefined>,
  now = Date.now(),
): Promise<{ forward: string } | { answer: string }> {
  let message: Line;
  try {
    message = JSON.parse(line) as Line;
  } catch {
    return { forward: line };
  }
  if (message.method !== "tools/call") return { forward: line };
  const params = (message.params ?? {}) as {
    name?: unknown;
    arguments?: unknown;
  };
  const name = typeof params.name === "string" ? params.name : "";
  if (readOnlyTools.has(name)) return { forward: line };
  const person = await readPerson(now);
  if (person !== null) return { answer: refusal(message.id, person.since) };
  await noteAgent(agentName(env, params.arguments), name, now).catch(
    () => undefined,
  );
  return { forward: line };
}

async function main(): Promise<void> {
  // `--driver <command…>` names another driver (the tests' stand-in). Bun
  // drops a bare `--` that follows the script, so the flag is explicit, and
  // any other argument is refused rather than falling back to the real
  // driver.
  const args = process.argv.slice(2);
  if (args.length > 0 && (args[0] !== "--driver" || args.length < 2)) {
    process.stderr.write("usage: computer-gate.ts [--driver <command…>]\n");
    process.exit(2);
  }
  const command =
    args.length > 0
      ? args.slice(1)
      : [
          join(homedir(), ".local/bin/cua-driver"),
          "mcp",
          "--socket",
          join(homedir(), ".local/state/lazurio-computer/driver.sock"),
        ];
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      CUA_DRIVER_RS_UPDATE_CHECK: "0",
    },
  });
  // The driver's answers and the gate's own refusals share stdout; both are
  // written only as whole lines, so they never interleave inside a message.
  const fromDriver = (async () => {
    let buffered = "";
    const text = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffered += text.decode(chunk, { stream: true });
      const end = buffered.lastIndexOf("\n");
      if (end < 0) continue;
      process.stdout.write(buffered.slice(0, end + 1));
      buffered = buffered.slice(end + 1);
    }
    if (buffered !== "") process.stdout.write(buffered);
  })();
  const env = process.env;
  let pending = "";
  const decoder = new TextDecoder();
  // One line at a time, in order: a refused call is answered before the next
  // line is looked at, so the agent's requests keep their order.
  for await (const chunk of Bun.stdin.stream()) {
    pending += decoder.decode(chunk, { stream: true });
    let at = pending.indexOf("\n");
    while (at >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.trim() !== "") {
        const decision = await gateLine(line, env);
        if ("forward" in decision) child.stdin.write(`${decision.forward}\n`);
        else process.stdout.write(`${decision.answer}\n`);
      }
      at = pending.indexOf("\n");
    }
  }
  child.stdin.end();
  const code = await child.exited;
  await fromDriver;
  process.exit(code);
}

if (import.meta.main) await main();
