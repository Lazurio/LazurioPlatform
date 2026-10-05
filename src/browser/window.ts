import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ProcessRunner } from "../update/self-check";
import { browserCdpPort, browserWindowSize } from "./units";
import { isBrowserSession } from "./view";

/** A thread's own window of the Environment browser (decision F38).
 *
 * agent-browser binds a pinned session to one tab, but opens that tab in the
 * most recently used window, and Chrome does not paint a background tab: the
 * other thread's view would freeze and its screenshots would hang. Its
 * `window new` opens an isolated context without the Environment's sign-ins.
 * So this creates the window itself, in the default context (CDP
 * `Target.createTarget` with `newWindow`), and binds the thread's session to
 * it with agent-browser's own commands (`tab <targetId>`, then pinned). Kept
 * until agent-browser opens a pinned session's tab in a new window of the
 * default context itself. */

/** The session of the calling thread: named, or the one its harness gives
 * it. T3 Code sets `AGENT_BROWSER_SESSION` per thread; Codex exports
 * `CODEX_THREAD_ID` and Claude Code `CLAUDE_CODE_SESSION_ID` to the commands
 * of a thread. */
export function threadSession(
  named: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const candidates = [
    named,
    env.AGENT_BROWSER_SESSION,
    env.CODEX_THREAD_ID === undefined
      ? undefined
      : `codex-${env.CODEX_THREAD_ID}`,
    env.CLAUDE_CODE_SESSION_ID === undefined
      ? undefined
      : `claude-${env.CLAUDE_CODE_SESSION_ID}`,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    // A name given on purpose is used as given or refused.
    if (candidate === named) return isBrowserSession(named) ? named : null;
    const sanitized = candidate.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
    if (isBrowserSession(sanitized)) return sanitized;
  }
  return null;
}

/** Where agent-browser keeps its sockets and a session's tab binding
 * (`AGENT_BROWSER_SOCKET_DIR`, else `$XDG_RUNTIME_DIR/agent-browser`). */
export function agentBrowserSocketDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const named = env.AGENT_BROWSER_SOCKET_DIR;
  if (named !== undefined && isAbsolute(named)) return named;
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "agent-browser")
    : undefined;
}

export type CdpCall = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export type WindowSeams = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  run: ProcessRunner;
  /** The page targets the browser has now (CDP `/json/list`), by id. */
  targets: () => Promise<ReadonlySet<string>>;
  cdp: CdpCall;
}>;

export type ThreadWindow = Readonly<{
  session: string;
  targetId: string;
  /** False when the session's bound window was there already. */
  created: boolean;
}>;

export class BrowserWindowFailure extends Error {
  constructor(
    readonly reason:
      | "browser-unreachable"
      | "window-create-failed"
      | "bind-failed",
  ) {
    super(reason);
  }
}

const commandTimeoutMs = 30_000;

/** The target the session is bound to, from agent-browser's binding file
 * (`<socket dir>/<session>.target`, `{"targetId": …}`), when it is still a
 * page of the browser. */
async function boundTarget(
  session: string,
  seams: WindowSeams,
): Promise<string | null> {
  const directory = agentBrowserSocketDirectory(seams.env);
  if (directory === undefined) return null;
  try {
    const binding = JSON.parse(
      await readFile(join(directory, `${session}.target`), "utf8"),
    ) as { targetId?: unknown };
    const id = binding.targetId;
    if (typeof id !== "string" || id === "") return null;
    return (await seams.targets()).has(id) ? id : null;
  } catch {
    return null;
  }
}

function agentBrowser(seams: WindowSeams, args: readonly string[]) {
  const home = seams.env.HOME ?? "";
  const environment: Record<string, string> = {
    HOME: home,
    PATH: [
      join(home, ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
  };
  for (const name of ["XDG_RUNTIME_DIR", "AGENT_BROWSER_SOCKET_DIR"]) {
    const value = seams.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return seams.run(
    [
      join(home, ".local", "bin", "agent-browser"),
      "--cdp",
      String(browserCdpPort),
      ...args,
    ],
    commandTimeoutMs,
    environment,
  );
}

/** The session's window: the bound one while it is open, otherwise a new
 * window in the default context bound to the session, pinned, at the
 * thread window's size (which is also the view's viewport). */
export async function ensureThreadWindow(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
): Promise<ThreadWindow> {
  let existing: string | null;
  try {
    existing = await boundTarget(session, seams);
  } catch {
    throw new BrowserWindowFailure("browser-unreachable");
  }
  if (existing !== null)
    return Object.freeze({ session, targetId: existing, created: false });
  let targetId: unknown;
  try {
    targetId = (
      (await seams.cdp("Target.createTarget", {
        url: url ?? "about:blank",
        newWindow: true,
        width: browserWindowSize.width,
        height: browserWindowSize.height + 100,
      })) as { targetId?: unknown }
    ).targetId;
  } catch {
    throw new BrowserWindowFailure("window-create-failed");
  }
  if (typeof targetId !== "string" || targetId === "")
    throw new BrowserWindowFailure("window-create-failed");
  const ok = (result: Awaited<ReturnType<ProcessRunner>>) =>
    result !== "timeout" && result.exitCode === 0;
  const bound = await agentBrowser(seams, [
    "--session",
    session,
    "--no-pin-tab",
    "tab",
    targetId,
  ]).catch(() => "timeout" as const);
  const pinned = ok(bound)
    ? await agentBrowser(seams, [
        "--session",
        session,
        "--pin-tab",
        "set",
        "viewport",
        String(browserWindowSize.width),
        String(browserWindowSize.height),
      ]).catch(() => "timeout" as const)
    : "timeout";
  if (!ok(bound) || !ok(pinned)) throw new BrowserWindowFailure("bind-failed");
  return Object.freeze({ session, targetId, created: true });
}

/** The real seams: the browser's loopback DevTools endpoint. */
export function cdpSeams(
  env: Readonly<Record<string, string | undefined>>,
  run: ProcessRunner,
): WindowSeams {
  const base = `http://127.0.0.1:${browserCdpPort}`;
  const targets = async () => {
    const response = await fetch(`${base}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
    const list = (await response.json()) as unknown;
    const ids = new Set<string>();
    if (Array.isArray(list))
      for (const item of list) {
        const { id, type } = (item ?? {}) as Record<string, unknown>;
        if (type === "page" && typeof id === "string") ids.add(id);
      }
    return ids;
  };
  const cdp: CdpCall = async (method, params) => {
    const version = (await (
      await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(5_000),
      })
    ).json()) as { webSocketDebuggerUrl?: unknown };
    const endpoint = version.webSocketDebuggerUrl;
    if (typeof endpoint !== "string" || !endpoint.startsWith("ws://127.0.0.1:"))
      throw new Error("no browser endpoint");
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("timeout"));
      }, 10_000);
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket"));
      };
      socket.onopen = () =>
        socket.send(JSON.stringify({ id: 1, method, params }));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (message.id !== 1) return;
        clearTimeout(timer);
        socket.close();
        if (message.error !== undefined) reject(new Error("cdp"));
        else resolve(message.result);
      };
    });
  };
  return Object.freeze({ env, run, targets, cdp });
}
