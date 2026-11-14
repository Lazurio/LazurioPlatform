import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { acquireFileLock, type FileLock } from "../platform/flock";
import type { ProcessRunner } from "../update/self-check";
import {
  agentBrowserSocketDirectory,
  holderDirectory,
  processAlive,
} from "./contract/node";
import {
  browserBounds,
  isThreadWindow,
  parseHolder,
  stripAppOf,
  targetIdOf,
  threadOfWindow,
} from "./contract/pure";
import { addressKey } from "./people/sleep";
import { browserCdpPort } from "./units";

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
  /** The page targets with their addresses, for "no duplicate opens"
   * (decision F57, `threadPage`); absent: a window is never shared. */
  pages?: () => Promise<ReadonlyMap<string, string>>;
  /** Tests only: whether a daemon's process runs (`processAlive`). */
  alive?: (pid: number) => boolean;
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
      | "bind-failed"
      // `openInThreadWindow`: agent-browser did not open the address in the
      // thread's bound window.
      | "navigate-failed",
  ) {
    super(reason);
  }
}

/** `ensureThreadWindow` with a limit: the thread holds as many windows as
 * it may already, `windows` being their sessions, so no new one opens. */
export class ThreadWindowLimit extends Error {
  constructor(
    readonly limit: number,
    readonly windows: readonly string[],
  ) {
    super("window-limit");
  }
}

/** How many windows one thread may hold at once (`lazurio browser window`):
 * its own session's and its further windows' (`<session>-2`, …,
 * `<session>-preview`) whose agent-browser daemon runs. PROVISIONAL, an
 * open decision: no decision sets a number. Five keeps a few threads that
 * each hold all theirs under the 28 tabs the reference Environment (4 vCPU,
 * 8 GiB) carried without losing a renderer on 2026-10-20 (`pressure.ts`,
 * decision F57 point 6), where every remote tab is a window of its own (root
 * decision 0191 point 11), and still leaves an agent its own window, one
 * for a page it works in beside it, a preview and two more. A window let go
 * (`done`, or agent-browser's idle timeout of 1 h) no longer counts, even
 * while a person keeps it open. */
export const threadWindowLimit = 5;

/** One session of a thread as agent-browser's files record it (C7): its
 * bound target, when its binding names one, and whether its daemon runs
 * (its `.pid` names a running process, or cannot be read, which counts as
 * running as the hub counts it), or may be asked to stop (`.sock`). */
export type ThreadSession = Readonly<{
  session: string;
  targetId: string | null;
  running: boolean;
  socket: boolean;
}>;

/** The sessions of the thread's windows (`isThreadWindow`) that have any
 * of agent-browser's files, sorted by name with numbers in order. Another
 * thread's sessions are never read. Empty where there is no socket
 * directory or it does not exist. */
export async function readThreadSessions(
  thread: string,
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => boolean = processAlive,
): Promise<readonly ThreadSession[]> {
  const directory = agentBrowserSocketDirectory(env);
  if (directory === undefined) return [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = new Map<string, Set<string>>();
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const session = name.slice(0, dot);
    const kind = name.slice(dot + 1);
    if (
      (kind !== "target" && kind !== "pid" && kind !== "sock") ||
      !isThreadWindow(thread, session)
    )
      continue;
    const kinds = files.get(session) ?? new Set<string>();
    kinds.add(kind);
    files.set(session, kinds);
  }
  const sessions = [...files.keys()].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  return Promise.all(
    sessions.map(async (session) => {
      const kinds = files.get(session) as Set<string>;
      let targetId: string | null = null;
      if (kinds.has("target"))
        try {
          targetId = targetIdOf(
            (
              JSON.parse(
                await readFile(join(directory, `${session}.target`), "utf8"),
              ) as { targetId?: unknown } | null
            )?.targetId,
          );
        } catch {}
      let running = false;
      if (kinds.has("pid"))
        try {
          const digits = (
            await readFile(join(directory, `${session}.pid`), "utf8")
          ).trim();
          const pid = /^[0-9]{1,10}$/.test(digits)
            ? Number(digits)
            : Number.NaN;
          running = !(Number.isSafeInteger(pid) && pid >= 2) || alive(pid);
        } catch (error) {
          // Gone between the listing and the read: not running. Anything
          // else is unclear, and unclear counts as running.
          running = (error as NodeJS.ErrnoException).code !== "ENOENT";
        }
      return Object.freeze({
        session,
        targetId,
        running,
        socket: kinds.has("sock"),
      });
    }),
  );
}

/** The thread's windows that count against its limit: the distinct open
 * targets its running sessions are bound to, with their sessions. */
async function heldThreadWindows(
  thread: string,
  seams: WindowSeams,
): Promise<readonly string[]> {
  const sessions = await readThreadSessions(thread, seams.env, seams.alive);
  const open = await seams.targets();
  const held = new Map<string, string>();
  for (const { session, targetId, running } of sessions)
    if (
      running &&
      targetId !== null &&
      open.has(targetId) &&
      !held.has(targetId)
    )
      held.set(targetId, session);
  return [...held.values()];
}

const commandTimeoutMs = 30_000;
// Longer than one creation (a CDP call and two agent-browser commands).
const windowLockTimeoutMs = 90_000;

/** One lock for every window check-and-create of this account: the CLI
 * (`lazurio browser window`) and the Launchpad's view (a T3 thread's panel)
 * may ask for the same thread's window at the same moment, and two creations
 * would leave the person and the agent in different windows. A kernel
 * `flock` (src/platform/flock.ts): the next holder re-reads the binding and
 * converges. It lives next to agent-browser's directory, never inside it, so
 * agent-browser never reads it as a session. Null where there is no runtime
 * directory, and then no binding to find either. */
export function windowLockPath(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && isAbsolute(runtime))
    return join(runtime, "lazurio-browser-window.lock");
  const sockets = agentBrowserSocketDirectory(env);
  return sockets === undefined
    ? null
    : join(dirname(sockets), "lazurio-browser-window.lock");
}

/** The target the session is bound to, from agent-browser's binding file
 * (`<socket dir>/<session>.target`, `{"targetId": …}`), when it is a target
 * id (the contract's `targetIdOf`, F50 C1) and still a page of the
 * browser. */
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
    const id = targetIdOf(binding.targetId);
    if (id === null) return null;
    return (await seams.targets()).has(id) ? id : null;
  } catch {
    return null;
  }
}

function agentBrowser(
  seams: Pick<WindowSeams, "env" | "run">,
  args: readonly string[],
) {
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

/** `operation` under the account's window lock (`windowLockPath`); a lock
 * that cannot be taken is `window-create-failed`. */
async function underWindowLock<T>(
  env: WindowSeams["env"],
  operation: () => Promise<T>,
): Promise<T> {
  const path = windowLockPath(env);
  let lock: FileLock | null = null;
  if (path !== null)
    try {
      lock = await acquireFileLock(path, { timeoutMs: windowLockTimeoutMs });
    } catch {
      throw new BrowserWindowFailure("window-create-failed");
    }
  try {
    return await operation();
  } finally {
    await lock?.release();
  }
}

/** The session's window: the bound one while it is open, otherwise a new
 * window in the default context bound to the session, pinned, at the
 * thread window's size (which is also the view's viewport). Checked and
 * created under the account's window lock (`windowLockPath`). */
export async function ensureThreadWindow(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
  /** With a limit (`lazurio browser window`), a new window is refused as
   * `ThreadWindowLimit` once the session's thread (`threadOfWindow`) holds that
   * many; the window a session has already is never refused. */
  limit?: number,
): Promise<ThreadWindow> {
  return underWindowLock(seams.env, () =>
    ensureThreadWindowLocked(session, url, seams, limit),
  );
}

/** Binds the session to the tab with agent-browser's own commands and pins
 * it with a command that changes nothing: its agent works there next, and an
 * app that follows the session's binding shows it (T3 Code records a tab its
 * thread's session newly binds, F47 point 4). False when either command
 * failed. */
async function bindSession(
  session: string,
  targetId: string,
  seams: Pick<WindowSeams, "env" | "run">,
): Promise<boolean> {
  const ok = (result: Awaited<ReturnType<ProcessRunner>>) =>
    result !== "timeout" && result.exitCode === 0;
  const bound = await agentBrowser(seams, [
    "--session",
    session,
    "--no-pin-tab",
    "tab",
    targetId,
  ]).catch(() => "timeout" as const);
  // Pinned with a command that changes nothing. The page keeps the window's
  // size, which the people's view sets to the person's page area (F39 point
  // 3); a fixed viewport served only the dashboard's pointer mapping.
  if (!ok(bound)) return false;
  const pinned = await agentBrowser(seams, [
    "--session",
    session,
    "--pin-tab",
    "get",
    "url",
  ]).catch(() => "timeout" as const);
  return ok(pinned);
}

/** The default browser's page becomes the thread's window (root decision
 * 0201 point 5): the session is bound to the tab the hub opened, under the
 * account's window lock, so a `lazurio browser window` of the same thread at
 * the same moment converges on it. The thread's earlier window stays as long
 * as something holds it. False when it could not be bound. */
export async function bindThreadWindow(
  session: string,
  targetId: string,
  seams: Pick<WindowSeams, "env" | "run">,
): Promise<boolean> {
  try {
    return await underWindowLock(seams.env, () =>
      bindSession(session, targetId, seams),
    );
  } catch {
    return false;
  }
}

/** No duplicate opens (decision F57): an open page of the session's own
 * thread that shows `url` already, all but its fragment (`addressKey`).
 * Only an explicit identity counts: a T3 Code thread's session has the
 * thread's strip by the same name (`t3-<thread>`, F47 point 4), and the
 * pages are the tabs that holder file lists. No name is ever taken apart,
 * so `t3-thread` and `t3-thread-2` stay two threads. Any other session has
 * no strip of its own and reuses nothing, and so does anything that cannot
 * be read: when in doubt the session gets a window of its own, never
 * another thread's page. The page is taken as it is: an address never
 * moves an open window. */
export async function threadPage(
  session: string,
  url: string,
  seams: WindowSeams,
): Promise<string | null> {
  const key = addressKey(url);
  const holders = holderDirectory(seams.env);
  if (
    key === null ||
    seams.pages === undefined ||
    holders === undefined ||
    stripAppOf(session) !== "t3code"
  )
    return null;
  const file = `${session}.json`;
  let tabs: readonly string[];
  try {
    const hold = parseHolder(file, await readFile(join(holders, file), "utf8"));
    if (hold === null || hold.strip !== session) return null;
    tabs = hold.tabs;
  } catch {
    return null;
  }
  if (tabs.length === 0) return null;
  const pages = await seams.pages();
  for (const id of tabs) {
    const at = pages.get(id);
    if (at !== undefined && addressKey(at) === key) return id;
  }
  return null;
}

async function ensureThreadWindowLocked(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
  limit: number | undefined,
): Promise<ThreadWindow> {
  let existing: string | null;
  try {
    existing = await boundTarget(session, seams);
  } catch {
    throw new BrowserWindowFailure("browser-unreachable");
  }
  if (existing !== null)
    return Object.freeze({ session, targetId: existing, created: false });
  // The thread shows the page already: the session works there too.
  const shown =
    url === undefined
      ? null
      : await threadPage(session, url, seams).catch(() => null);
  if (shown !== null) {
    if (!(await bindSession(session, shown, seams)))
      throw new BrowserWindowFailure("bind-failed");
    return Object.freeze({ session, targetId: shown, created: false });
  }
  if (limit !== undefined) {
    const thread = threadOfWindow(session) ?? session;
    let held: readonly string[];
    try {
      held = await heldThreadWindows(thread, seams);
    } catch {
      throw new BrowserWindowFailure("browser-unreachable");
    }
    if (held.length >= limit) throw new ThreadWindowLimit(limit, held);
  }
  return createThreadWindow(session, url, seams);
}

/** A new window in the default context at `url`, bound to the session and
 * pinned (`ensureThreadWindow`). */
async function createThreadWindow(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
): Promise<ThreadWindow> {
  let created: unknown;
  try {
    created = (
      (await seams.cdp("Target.createTarget", {
        url: url ?? "about:blank",
        newWindow: true,
        width: browserBounds.window.width,
        height: browserBounds.window.height,
      })) as { targetId?: unknown }
    ).targetId;
  } catch {
    throw new BrowserWindowFailure("window-create-failed");
  }
  const targetId = targetIdOf(created);
  if (targetId === null) throw new BrowserWindowFailure("window-create-failed");
  if (!(await bindSession(session, targetId, seams)))
    throw new BrowserWindowFailure("bind-failed");
  return Object.freeze({ session, targetId, created: true });
}

/** A page the thread opens in its own window (a colleague's application
 * through its hand-over, Lazurio Auth docs/agent-application-entry.md,
 * LZD-0009 M9): unlike `ensureThreadWindow`, the address does move the
 * window. Without a bound window, a new one at `url`; with one, agent-
 * browser's own `open` navigates it there. Both are navigations the browser
 * starts itself (DevTools' `Target.createTarget` and `Page.navigate`), never
 * a page's link or form, which the hosting gateway's landing requires
 * (`Sec-Fetch-Site: none`). The address is opened exactly as given. Under
 * the account's window lock. */
export async function openInThreadWindow(
  session: string,
  url: string,
  seams: WindowSeams,
): Promise<ThreadWindow> {
  return underWindowLock(seams.env, async () => {
    let existing: string | null;
    try {
      existing = await boundTarget(session, seams);
    } catch {
      throw new BrowserWindowFailure("browser-unreachable");
    }
    if (existing === null) return createThreadWindow(session, url, seams);
    const opened = await agentBrowser(seams, [
      "--session",
      session,
      "open",
      url,
    ]).catch(() => "timeout" as const);
    if (opened === "timeout" || opened.exitCode !== 0)
      throw new BrowserWindowFailure("navigate-failed");
    return Object.freeze({ session, targetId: existing, created: false });
  });
}

/** The real seams: the browser's loopback DevTools endpoint. */
export function cdpSeams(
  env: Readonly<Record<string, string | undefined>>,
  run: ProcessRunner,
): WindowSeams {
  const base = `http://127.0.0.1:${browserCdpPort}`;
  const pages = async () => {
    const response = await fetch(`${base}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
    const list = (await response.json()) as unknown;
    const found = new Map<string, string>();
    if (Array.isArray(list))
      for (const item of list) {
        const { id, type, url } = (item ?? {}) as Record<string, unknown>;
        const target = targetIdOf(id);
        if (type === "page" && target !== null)
          found.set(target, typeof url === "string" ? url : "");
      }
    return found;
  };
  const targets = async () => new Set((await pages()).keys());
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
  return Object.freeze({ env, run, targets, cdp, pages });
}
