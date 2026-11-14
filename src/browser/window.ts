import { access, readdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { acquireFileLock, type FileLock } from "../platform/flock";
import type { ProcessRunner } from "../update/self-check";
import {
  agentBrowserSocketDirectory,
  type DaemonSeams,
  holderDirectory,
  processAlive,
  replaceOwnerFile,
  stopSessionDaemon,
} from "./contract/node";
import {
  browserBounds,
  isStrip,
  parseHolder,
  stripAppOf,
  targetIdOf,
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
 * default context itself.
 *
 * A binding counts only once the session's binding file names the tab
 * (#974): agent-browser's answer alone proves nothing. A fresh daemon attaches
 * to every tab and makes the first live one of `Target.getTargets` its own
 * (any thread's, pinned or not), and it records its tab in `<session>.target`
 * after every command, a failed one too (agent-browser 0.37 and 0.43). So a
 * `tab <targetId>` that fails, say on a new window whose page does not answer
 * agent-browser's probe within its 3 + 10 s, leaves the session bound to
 * another agent's tab, which `window` would then hand out and T3 Code would
 * take into the thread's strip. Such a session is let go as `done` lets go of
 * one, and the binding the failure left is removed (`releaseFailedBinding`). */

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
  /** Tests only: how a session's daemon is asked to shut down after a
   * failed binding (`stopSessionDaemon`). */
  daemon?: DaemonSeams;
  /** Tests only: how long a daemon busy with a command that did not answer
   * is waited for after it was asked to shut down (`daemonEndMs`). */
  endWithinMs?: number;
}>;

export type ThreadWindow = Readonly<{
  session: string;
  targetId: string;
  /** False when the session's bound window was there already. */
  created: boolean;
  /** With `thread` (`WindowOptions`), on a new window only: whether it was
   * recorded as that thread's (`recordThreadWindow`). */
  recorded?: boolean;
}>;

/** What opening a window records: the thread whose window it is (its
 * identity, `threadSession` of its harness, or the session named when it has
 * none). Absent: nothing is recorded, as for the Launchpad's panel, whose
 * session is the T3 Code thread's own. */
export type WindowOptions = Readonly<{ thread?: string | undefined }>;

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

// ---- A thread's windows (F38, addendum of 2026-11-14) -------------------------
//
// A session's name is no evidence of its thread (Pablo's review of #971):
// session names are free, so `team-2` may be a further window of `team` or a
// thread of its own. Only the thread that opened a window knows, so
// `lazurio browser window` records it when it opens one, beside the holder
// files: `$XDG_RUNTIME_DIR/lazurio-browser/windows/<session>.json`. Nothing
// else holds this fact: agent-browser's binding names a session's tab, a
// holder file the tabs a place keeps (T3 Code's `t3-<thread>.json` only the
// tabs its thread's own session binds, F47 point 4), and a Codex or Claude
// Code thread has no holder file at all. The hub never reads a record: it
// changes no hold and no tab's life, only which windows `tabs`, `done
// --all` and the note of `window` take as the thread's.

/** Where `lazurio browser window` records which thread opened a window, one
 * file per session. Beside the holder files in the runtime directory, so a
 * record goes at a reboot as agent-browser's bindings there do. Undefined
 * without an absolute runtime directory: nothing is recorded, and a thread's
 * windows are its own session's only. */
export function windowRecordDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "lazurio-browser", "windows")
    : undefined;
}

const windowRecordSchema = "lazurio.browser-window.v1";

/** What `lazurio browser window` records when it opens a window: the
 * session, the thread whose window it is, and the tab it bound the session
 * to. */
export type WindowRecord = Readonly<{
  session: string;
  thread: string;
  targetId: string;
}>;

/** Records which thread opened the session's window, owner-only and
 * atomically. False when it could not be recorded (no runtime directory, a
 * name outside the grammar, a write that failed): the window then counts as
 * the thread's only where its session is the thread's own. */
export async function recordThreadWindow(
  env: Readonly<Record<string, string | undefined>>,
  record: WindowRecord,
): Promise<boolean> {
  const directory = windowRecordDirectory(env);
  const targetId = targetIdOf(record.targetId);
  if (
    directory === undefined ||
    targetId === null ||
    !isStrip(record.session) ||
    !isStrip(record.thread)
  )
    return false;
  try {
    await replaceOwnerFile(
      join(directory, `${record.session}.json`),
      `${JSON.stringify({
        schema: windowRecordSchema,
        session: record.session,
        thread: record.thread,
        targetId,
      })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** A session's record: none, one that cannot be read or is no record of
 * this session, or the record. */
type RecordReading = WindowRecord | "none" | "unreadable";

async function readWindowRecord(
  directory: string | undefined,
  session: string,
): Promise<RecordReading> {
  if (directory === undefined) return "none";
  let text: string;
  try {
    text = await readFile(join(directory, `${session}.json`), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "none"
      : "unreadable";
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown> | null;
    const targetId = targetIdOf(value?.targetId);
    return value?.schema === windowRecordSchema &&
      value.session === session &&
      isStrip(value.thread) &&
      targetId !== null
      ? Object.freeze({ session, thread: value.thread, targetId })
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** The tab a session's binding names (`<session>.target`, C7); null when
 * there is none or it cannot be read. */
async function bindingOf(
  directory: string,
  session: string,
): Promise<string | null> {
  try {
    return targetIdOf(
      (
        JSON.parse(
          await readFile(join(directory, `${session}.target`), "utf8"),
        ) as { targetId?: unknown } | null
      )?.targetId,
    );
  } catch {
    return null;
  }
}

/** Whether a session's daemon may still run, as the hub counts it
 * (`readHolds`): its `.pid` names a running process, or cannot be read or
 * understood. One that is gone, or names a process that ended, does not. */
async function daemonMayRun(
  directory: string,
  session: string,
  alive: (pid: number) => boolean,
): Promise<boolean> {
  let digits: string;
  try {
    digits = (await readFile(join(directory, `${session}.pid`), "utf8")).trim();
  } catch (error) {
    // Gone: not running. Anything else is unclear, and unclear runs.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const pid = /^[0-9]{1,10}$/.test(digits) ? Number(digits) : Number.NaN;
  return !(Number.isSafeInteger(pid) && pid >= 2) || alive(pid);
}

/** Whether the hub may still count an agent as working in the session's
 * window after nothing answered on its socket (`readHolds`, F47 point 5): a
 * binding is there (read or not) and its daemon may run. A `.pid` naming a
 * running process with a missing or refused socket is such a case: the
 * window is not let go until that hold is gone. */
export async function sessionHoldMayRemain(
  env: Readonly<Record<string, string | undefined>>,
  session: string,
  alive: (pid: number) => boolean = processAlive,
): Promise<boolean> {
  const directory = agentBrowserSocketDirectory(env);
  if (directory === undefined || !isStrip(session)) return false;
  let bound: boolean;
  try {
    await access(join(directory, `${session}.target`));
    bound = true;
  } catch (error) {
    bound = (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  return bound && (await daemonMayRun(directory, session, alive));
}

/** Why a window of a thread is not confirmed as the thread's: its record
 * cannot be read or is no record of it (`unreadable`: it names no thread, so
 * the window may be any thread's), its binding no longer names the tab it
 * was recorded with (`rebound`), or the thread's own session was recorded
 * for another thread (`recorded-elsewhere`). */
export type ThreadWindowDoubt = "unreadable" | "rebound" | "recorded-elsewhere";

/** One window of a thread as agent-browser's files record it (C7): its
 * bound target, when its binding names one; whether its daemon runs (its
 * `.pid` names a running process, or cannot be read, which counts as running
 * as the hub counts it) or may be asked to stop (`.sock`); and whether the
 * thread's record confirms it as the thread's (`confirmed`), else why not
 * (`doubt`). One that is not confirmed may be the thread's or not: `tabs`
 * names it apart, never with its address or title, and `done --all` never
 * lets go of it. */
export type ThreadSession = Readonly<{
  session: string;
  targetId: string | null;
  running: boolean;
  socket: boolean;
  confirmed: boolean;
  doubt: ThreadWindowDoubt | null;
}>;

/** The windows of the thread (its identity, `threadSession` of its harness,
 * or the session named when it has none) that have any of agent-browser's
 * files, sorted by name with numbers in order:
 * - its own session, the one named by the thread itself: the thread's, and
 *   confirmed unless a record says another thread opened it or cannot be
 *   read;
 * - a session `lazurio browser window` recorded for the thread: confirmed
 *   while its binding names the tab it was opened with; when the binding
 *   names another tab or none, the session is the thread's by its record
 *   only, which may be stale, so it is not confirmed;
 * - any session whose record cannot be read or is no record of it, never
 *   confirmed (Pablo's review of #971): such a record names no thread, and a
 *   session's name proves none, so the window may be this thread's as much
 *   as any other's. Leaving it out would let `tabs` say that no window
 *   remains and `done --all` succeed while it may still be held; every
 *   thread therefore sees it, as not confirmed, until its daemon has ended
 *   and its binding names no open tab.
 * No other session is read as the thread's: no record, or a record of
 * another thread, whatever its name. Empty where there is no socket
 * directory or it does not exist. */
export async function readThreadSessions(
  thread: string,
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => boolean = processAlive,
): Promise<readonly ThreadSession[]> {
  const directory = agentBrowserSocketDirectory(env);
  if (directory === undefined || !isStrip(thread)) return [];
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
      !isStrip(session)
    )
      continue;
    const kinds = files.get(session) ?? new Set<string>();
    kinds.add(kind);
    files.set(session, kinds);
  }
  const records = windowRecordDirectory(env);
  const sessions = [...files.keys()].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const read = await Promise.all(
    sessions.map(async (session): Promise<ThreadSession | null> => {
      const record = await readWindowRecord(records, session);
      const own = session === thread;
      const recorded = typeof record === "object" && record.thread === thread;
      if (!own && !recorded && record !== "unreadable") return null;
      const kinds = files.get(session) as Set<string>;
      const targetId = kinds.has("target")
        ? await bindingOf(directory, session)
        : null;
      const running =
        kinds.has("pid") && (await daemonMayRun(directory, session, alive));
      const doubt: ThreadWindowDoubt | null =
        record === "unreadable"
          ? "unreadable"
          : own
            ? record === "none" || recorded
              ? null
              : "recorded-elsewhere"
            : typeof record === "object" && record.targetId === targetId
              ? null
              : "rebound";
      return Object.freeze({
        session,
        targetId,
        running,
        socket: kinds.has("sock"),
        confirmed: doubt === null,
        doubt,
      });
    }),
  );
  return read.filter((entry): entry is ThreadSession => entry !== null);
}

/** Which thread a session named on purpose (`tabs --session`, `done --all
 * --session`) is a window of: the thread its record names while the record
 * confirms it (its binding names the recorded tab, or the record names the
 * session itself), or the session itself, which names its own thread, when
 * it has no record. `ambiguous` when its record cannot be read or no longer
 * confirms it: then the thread cannot be told. */
export async function threadOfSession(
  session: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<
  Readonly<{ kind: "thread"; thread: string }> | Readonly<{ kind: "ambiguous" }>
> {
  const record = await readWindowRecord(windowRecordDirectory(env), session);
  if (record === "none")
    return Object.freeze({ kind: "thread", thread: session });
  if (record === "unreadable") return Object.freeze({ kind: "ambiguous" });
  if (record.thread === session)
    return Object.freeze({ kind: "thread", thread: session });
  const directory = agentBrowserSocketDirectory(env);
  const bound =
    directory === undefined ? null : await bindingOf(directory, session);
  return bound === record.targetId
    ? Object.freeze({ kind: "thread", thread: record.thread })
    : Object.freeze({ kind: "ambiguous" });
}

/** One window the thread's agent-browser still holds, with the address its
 * page shows (empty where the browser did not say). */
export type HeldThreadWindow = Readonly<{
  session: string;
  targetId: string;
  url: string;
}>;

/** The windows the thread still holds: the distinct open pages its confirmed
 * running sessions are bound to, each with the first of its sessions and its
 * address. No number limits them (decided on 2026-11-14): `lazurio browser
 * window` names them when it opens another, so the agent lets go of those it
 * no longer needs. A window let go (`done`, or agent-browser's idle timeout
 * of 1 h) is not held, even while a person keeps it open. */
export async function heldThreadWindows(
  thread: string,
  seams: Pick<WindowSeams, "env" | "targets" | "pages" | "alive">,
): Promise<readonly HeldThreadWindow[]> {
  const sessions = await readThreadSessions(thread, seams.env, seams.alive);
  const pages =
    seams.pages === undefined
      ? new Map([...(await seams.targets())].map((id) => [id, ""]))
      : await seams.pages();
  const held = new Map<string, HeldThreadWindow>();
  for (const { session, targetId, running, confirmed } of sessions) {
    const url = targetId === null ? undefined : pages.get(targetId);
    if (
      confirmed &&
      running &&
      targetId !== null &&
      url !== undefined &&
      !held.has(targetId)
    )
      held.set(targetId, Object.freeze({ session, targetId, url }));
  }
  return [...held.values()];
}

const commandTimeoutMs = 30_000;
// How long a daemon busy with a command that did not answer in time is waited
// for after it was asked to shut down (#974): as long as a command may take.
const daemonEndMs = commandTimeoutMs;
// Longer than one creation: a CDP call (10 s), two agent-browser commands (30 s
// each) or, after a failed binding, one command, the daemon's shutdown (5 s)
// and the wait for its end (#974).
const windowLockTimeoutMs = 120_000;

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
 * thread window's size (which is also the view's viewport), and recorded as
 * the window of `options.thread` (`recordThreadWindow`). Checked and created
 * under the account's window lock (`windowLockPath`). A window the session
 * has already is never recorded anew: a name another thread opened stays
 * that thread's. */
export async function ensureThreadWindow(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
  options: WindowOptions = {},
): Promise<ThreadWindow> {
  return underWindowLock(seams.env, () =>
    ensureThreadWindowLocked(session, url, seams, options),
  );
}

/** What a session's binding file (`<session>.target`, C7) says: there is
 * none, it cannot be read or names no target id, or the target id it names,
 * open or not. */
type BindingReading = string | "none" | "unreadable";

async function readBinding(
  directory: string | undefined,
  session: string,
): Promise<BindingReading> {
  if (directory === undefined) return "unreadable";
  let text: string;
  try {
    text = await readFile(join(directory, `${session}.target`), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "none"
      : "unreadable";
  }
  try {
    return (
      targetIdOf(
        (JSON.parse(text) as { targetId?: unknown } | null)?.targetId,
      ) ?? "unreadable"
    );
  } catch {
    return "unreadable";
  }
}

/** Binds the session to the tab with agent-browser's own commands and pins
 * it with a command that changes nothing: its agent works there next, and an
 * app that follows the session's binding shows it (T3 Code records a tab its
 * thread's session newly binds, F47 point 4). True only when both commands
 * succeeded and the session's binding file then names the tab (#974). When
 * the binding fails and leaves the session on another tab than it was on
 * before, or when a command did not answer in time, the session is let go
 * (`releaseFailedBinding`), which keeps a binding to where it was before. A
 * session a failure that did answer left where it was (its own earlier
 * window, a binding to a tab that is gone) is left as it is, daemon and
 * all. */
async function bindSession(
  session: string,
  targetId: string,
  seams: Pick<WindowSeams, "env" | "run" | "daemon" | "alive" | "endWithinMs">,
): Promise<boolean> {
  const directory = agentBrowserSocketDirectory(seams.env);
  const before = await readBinding(directory, session);
  const ok = (result: Awaited<ReturnType<ProcessRunner>> | null) =>
    result !== null && result !== "timeout" && result.exitCode === 0;
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
  const pinned = ok(bound)
    ? await agentBrowser(seams, [
        "--session",
        session,
        "--pin-tab",
        "get",
        "url",
      ]).catch(() => "timeout" as const)
    : null;
  const after = await readBinding(directory, session);
  if (ok(bound) && ok(pinned) && after === targetId) return true;
  // A command that did not answer in time is not over: its daemon goes on and
  // records its tab when it is done, after this reading (measured on 0.37:
  // the foreign tab 8 s after a timeout).
  const unanswered = bound === "timeout" || pinned === "timeout";
  if (after !== targetId && (after !== before || unanswered))
    await releaseFailedBinding(directory, session, targetId, before, seams);
  return false;
}

/** Lets go of a session whose binding to `targetId` failed and left it, or
 * may yet leave it, on another tab than it was on before (#974). Its daemon
 * is asked to shut down as `lazurio browser done` asks it
 * (`stopSessionDaemon`). One busy with the command that did not answer
 * records its tab when that command ends, and 0.37 drops a shutdown asked
 * meanwhile (0.43 takes it afterwards), so it is asked again until it has
 * ended, refused or `daemonEndMs` passed. Only then is the binding file
 * removed, unless it names `targetId` or what it named before:
 * agent-browser's own way to reset a session's binding (its errors say to
 * delete the file), which takes the session off the tab for `window`, the
 * hub and T3 Code. Never `close` or `tab close`, which would close the tab
 * for the agent and the people whose tab it is; the tab is left as it is. A
 * daemon still running after that may keep the tab as its own; the binding
 * goes all the same, and the next `window` binds the session to a window of
 * its own. */
async function releaseFailedBinding(
  directory: string | undefined,
  session: string,
  targetId: string,
  before: BindingReading,
  seams: Pick<WindowSeams, "daemon" | "alive" | "endWithinMs">,
): Promise<void> {
  if (directory === undefined || !isStrip(session)) return;
  const stop = () =>
    stopSessionDaemon(directory, session, seams.daemon).catch(
      () => "unconfirmed" as const,
    );
  const deadline = Date.now() + (seams.endWithinMs ?? daemonEndMs);
  let outcome = await stop();
  while (
    outcome !== "stopped" &&
    outcome !== "refused" &&
    Date.now() < deadline &&
    (await daemonMayRun(directory, session, seams.alive ?? processAlive))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    outcome = await stop();
  }
  const now = await readBinding(directory, session);
  if (now === "none" || now === targetId || now === before) return;
  await rm(join(directory, `${session}.target`), { force: true }).catch(
    () => undefined,
  );
}

/** The default browser's page becomes the thread's window (root decision
 * 0201 point 5): the session is bound to the tab the hub opened, under the
 * account's window lock, so a `lazurio browser window` of the same thread at
 * the same moment converges on it. The thread's earlier window stays as long
 * as something holds it. False when it could not be bound: the session then
 * stays on its earlier window, or, where the failure moved it to another tab,
 * is let go (`bindSession`), and the page stays open. */
export async function bindThreadWindow(
  session: string,
  targetId: string,
  seams: Pick<WindowSeams, "env" | "run" | "daemon" | "alive" | "endWithinMs">,
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
  options: WindowOptions,
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
  return createThreadWindow(session, url, seams, options);
}

/** A new window in the default context at `url`, bound to the session and
 * pinned (`ensureThreadWindow`), and recorded as the window of
 * `options.thread` when one is given. A window that could not be bound is
 * let go, not retried (#974): nothing holds it, so the hub ends it like any
 * tab nobody holds or views, and `window` never closes it, as `done` never
 * does. A retry would start yet another daemon that takes the first live tab
 * of the browser as its own while the account's window lock keeps every
 * other thread waiting, and
 * the usual failure, a page that does not answer agent-browser's probe within
 * 13 s, would mostly repeat; the agent runs `window` again instead, and the
 * session, now bound to no other tab, gets a new window. Nothing is
 * recorded. */
async function createThreadWindow(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
  options: WindowOptions,
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
  if (options.thread === undefined)
    return Object.freeze({ session, targetId, created: true });
  const recorded = await recordThreadWindow(seams.env, {
    session,
    thread: options.thread,
    targetId,
  });
  return Object.freeze({ session, targetId, created: true, recorded });
}

/** A page the thread opens in its own window (a colleague's application
 * through its hand-over, Lazurio Auth docs/agent-application-entry.md,
 * LZD-0009 M9): unlike `ensureThreadWindow`, the address does move the
 * window. Without a bound window, a new one at `url`; with one, agent-
 * browser's own `open` navigates it there. Both are navigations the browser
 * starts itself (DevTools' `Target.createTarget` and `Page.navigate`), never
 * a page's link or form, which the hosting gateway's landing requires
 * (`Sec-Fetch-Site: none`). The address is opened exactly as given. A new
 * window is recorded as the window of `options.thread` when one is given
 * (`recordThreadWindow`). Under the account's window lock. */
export async function openInThreadWindow(
  session: string,
  url: string,
  seams: WindowSeams,
  options: WindowOptions = {},
): Promise<ThreadWindow> {
  return underWindowLock(seams.env, async () => {
    let existing: string | null;
    try {
      existing = await boundTarget(session, seams);
    } catch {
      throw new BrowserWindowFailure("browser-unreachable");
    }
    if (existing === null)
      return createThreadWindow(session, url, seams, options);
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
