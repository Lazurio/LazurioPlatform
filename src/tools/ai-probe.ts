import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import {
  type AiProviderReading,
  type AiReading,
  aiState,
  claudeReading,
  codexReading,
} from "./ai";
import type { ToolsEnvironment } from "./overview";
import { resolveOnPath } from "./status";

// Asks Codex and Claude Code whether an agent can work in this Environment
// (root decision 0201 point 6; the rules are ai.ts). Codex is asked through
// a short-lived app-server of its own (`codex app-server`, JSON lines over
// stdio): `initialize`, then `account/read` without refreshing a token, then
// it is stopped. Claude Code through `claude auth status --json`. Both run as
// the operator with this Environment's PATH and home, as Settings → Nástroje
// runs the tools, and only on request: Začínáme, the shell document's
// `setup` and nothing else ask, and an answer is kept a minute.

/** A conversation with a process over its standard streams: `input` is
 * written and stdin stays open until a line of stdout satisfies `until` or
 * the time is up; then stdin is closed and the process (its group) stopped.
 * The lines read up to the one that satisfied it, `timeout`, or `failed`
 * when it could not start or ended first. */
export type Converse = (
  command: readonly string[],
  env: Readonly<Record<string, string>>,
  input: string,
  until: (line: string) => boolean,
  timeoutMs: number,
) => Promise<readonly string[] | "timeout" | "failed">;

const maxAnswerBytes = 256 * 1024;

export const converse: Converse = (command, env, input, until, timeoutMs) =>
  new Promise((resolve) => {
    const [executable, ...args] = command;
    if (!executable) {
      resolve("failed");
      return;
    }
    const group = process.platform !== "win32";
    const child = spawn(executable, args, {
      env: { ...env },
      stdio: ["pipe", "pipe", "ignore"],
      detached: group,
      windowsHide: true,
    });
    const lines: string[] = [];
    let buffer = "";
    let bytes = 0;
    let done = false;
    const stop = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const finish = (value: readonly string[] | "timeout" | "failed") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // The process ends on its own once its input closes; whatever is
      // still running a moment later is stopped.
      child.stdin?.end();
      setTimeout(stop, 1_000).unref?.();
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.once("error", () => finish("failed"));
    child.once("close", () => finish("failed"));
    child.stdin?.on("error", () => undefined);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += chunk.length;
      if (bytes > maxAnswerBytes) return finish("failed");
      buffer += chunk;
      for (
        let index = buffer.indexOf("\n");
        index >= 0;
        index = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        lines.push(line);
        if (until(line)) return finish(lines);
      }
    });
    child.stdin?.write(input);
  });

const accountReadId = 1;

/** The messages that ask Codex's app-server for the account. */
const codexQuestion = `${[
  {
    method: "initialize",
    id: 0,
    params: {
      clientInfo: { name: "lazurio", title: "Lazurio", version: "1" },
    },
  },
  { method: "initialized" },
  {
    method: "account/read",
    id: accountReadId,
    params: { refreshToken: false },
  },
]
  .map((message) => JSON.stringify(message))
  .join("\n")}\n`;

function answerOf(line: string): unknown {
  try {
    const value = JSON.parse(line) as { id?: unknown };
    return value?.id === accountReadId ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The tool's environment: PATH, home and XDG as Settings → Nástroje give
 * them, and the account's name, by which Claude Code finds its sign-in in
 * the macOS keychain (without it, it answers signed out). */
function toolEnv(environment: ToolsEnvironment): Record<string, string> {
  const env: Record<string, string> = { HOME: environment.home ?? "" };
  try {
    const { username } = userInfo();
    env.USER = username;
    env.LOGNAME = username;
  } catch {}
  if (environment.path) env.PATH = environment.path;
  for (const [name, value] of Object.entries(environment.xdg ?? {}))
    env[name] = value;
  return env;
}

export async function readCodex(
  environment: ToolsEnvironment,
  talk: Converse,
  timeoutMs: number,
): Promise<AiProviderReading> {
  const codex = await resolveOnPath(
    "codex",
    environment.path,
    environment.platform,
  );
  if (codex === undefined) return { provider: "codex", state: "not-installed" };
  if (!environment.home) return { provider: "codex", state: "unknown" };
  const lines = await talk(
    [codex, "app-server"],
    toolEnv(environment),
    codexQuestion,
    (line) => answerOf(line) !== undefined,
    timeoutMs,
  ).catch(() => "failed" as const);
  if (typeof lines === "string") return { provider: "codex", state: "unknown" };
  const answer = answerOf(lines.at(-1) ?? "") as
    | { result?: unknown }
    | undefined;
  return codexReading(answer?.result);
}

export async function readClaude(
  environment: ToolsEnvironment,
  timeoutMs: number,
): Promise<AiProviderReading> {
  const claude = await resolveOnPath(
    "claude",
    environment.path,
    environment.platform,
  );
  if (claude === undefined)
    return { provider: "claude", state: "not-installed" };
  if (!environment.home) return { provider: "claude", state: "unknown" };
  const result = await environment
    .run([claude, "auth", "status", "--json"], timeoutMs, toolEnv(environment))
    .catch(() => "timeout" as const);
  return result === "timeout"
    ? { provider: "claude", state: "unknown" }
    : claudeReading(result.stdout);
}

/** This Environment's AI, both CLIs asked side by side. */
export async function readAi(
  environment: ToolsEnvironment,
  options: Readonly<{ converse?: Converse; timeoutMs?: number }> = {},
): Promise<AiReading> {
  const timeout = options.timeoutMs ?? 10_000;
  const providers = await Promise.all([
    readCodex(environment, options.converse ?? converse, timeout),
    readClaude(environment, timeout),
  ]);
  return Object.freeze({ state: aiState(providers), providers });
}

/** The AI as last read, kept `ttlMs` (a minute) so that the shell document
 * and Začínáme do not start Codex on every read; one reading at a time.
 * `forget` drops it (a sign-in or sign-out through this Launchpad, task 742)
 * and makes a reading running then stale. */
export function createAiProbe(
  environment: ToolsEnvironment,
  options: Readonly<{
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
    converse?: Converse;
  }> = {},
) {
  const ttl = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  let known: Readonly<{ reading: AiReading; at: number }> | null = null;
  let asking: Promise<AiReading> | null = null;
  let generation = 0;
  return {
    async state(): Promise<AiReading> {
      if (known !== null && now() - known.at < ttl) return known.reading;
      if (asking === null) {
        const asked = generation;
        asking = readAi(environment, options)
          .catch(
            (): AiReading => Object.freeze({ state: "unknown", providers: [] }),
          )
          .then((reading) => {
            if (asked === generation) known = { reading, at: now() };
            return reading;
          })
          .finally(() => {
            asking = null;
          });
      }
      return asking;
    },
    forget() {
      generation += 1;
      known = null;
    },
  };
}

export type AiProbe = ReturnType<typeof createAiProbe>;
