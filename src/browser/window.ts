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
  unverifiedBindingDirectory,
} from "./contract/node";
import {
  browserBounds,
  isStrip,
  parseHolder,
  parseUnverifiedBinding,
  stripAppOf,
  targetIdOf,
  unverifiedBindingText,
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
 * one, and the binding the failure left is removed once its daemon has ended
 * (`releaseBinding`). Until then the binding is not believed at all: the
 * session is marked unverified before the first command and stays so until
 * the binding is read back after commands that answered, or its daemon has
 * ended and the binding is settled (Pablo's review of #986, `markUnverified`,
 * `settleUnverified`).
 *
 * A new window opens at `about:blank` and only then goes to its address
 * (F38, addendum of 2026-11-15, #987): a blank page answers agent-browser's
 * probe at once, so a slow or busy page can no longer fail the binding. The
 * address is opened by the browser itself (`Page.navigate`), never by a page,
 * so the request carries `Sec-Fetch-Site: none` as before. */

export type CdpCall = (
  method: string,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/** What opening an address in a window came to: the browser started it
 * (`started`), it did not answer within its wait while the page loads on
 * (`pending`, a slow server), or it refused it (`failed`, an error the
 * browser named or no answer from DevTools). */
export type Navigation = "started" | "pending" | "failed";

export type WindowSeams = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  run: ProcessRunner;
  /** The page targets the browser has now (CDP `/json/list`), by id. */
  targets: () => Promise<ReadonlySet<string>>;
  cdp: CdpCall;
  /** Opens `url` in the page `targetId` as a navigation the browser starts
   * itself (CDP `Page.navigate` on the page, `Sec-Fetch-Site: none`). */
  navigate: (targetId: string, url: string) => Promise<Navigation>;
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
  /** On a new window opened for an address: how its navigation went. */
  navigation?: Navigation;
  /** The session's earlier window, which another thread took (`takeTab`):
   * this window is a new one, and the earlier stays with that thread. */
  takenBy?: TakenWindow;
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
      // The session's binding cannot be verified (Pablo's review of #986):
      // a failed binding left its daemon running, or its binding could not
      // be removed, so the binding may name another agent's tab. Nothing is
      // opened through the session until that is settled.
      | "binding-unverified"
      // `openInThreadWindow`: agent-browser did not open the address in the
      // thread's bound window, or the browser refused it in a new one.
      | "navigate-failed"
      // `takeTab`: the browser has no such tab.
      | "not-a-tab"
      // `takeTab`: the session is bound to another open window of its own,
      // which taking the tab would leave (`session`).
      | "session-busy"
      // `takeTab`: a session that holds the tab did not let it go: its
      // daemon refused to shut down or did not confirm it (`session`).
      | "holder-busy"
      // `takeTab`: the note that tells an earlier holder its window was
      // taken could not be written, so nothing was taken (`session`).
      | "take-note-failed",
    /** The session the reason is about, where it names one. */
    readonly session?: string,
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

// ---- A binding Lazurio has not verified (Pablo's review of #986) -------------
//
// agent-browser records a session's tab in `<session>.target` after every
// command, a failed one too, and a command that did not answer in time goes
// on and records its tab when it ends, however late (#974). So from the first
// command of a binding until Lazurio has read the binding back after commands
// that answered, or until the session's daemon has ended, the binding is no
// evidence of the session's window. `bindSession` marks the session before
// its first command, in a file of Lazurio's own beside the window records:
// `$XDG_RUNTIME_DIR/lazurio-browser/unverified/<session>.json`, with the tabs
// the binding may keep naming (the one asked for, the one bound before). A
// `window` killed meanwhile leaves the mark too. While it is there, `window`,
// `apps open` and `browser open` never take the binding as the session's
// window: they settle it first (`settleUnverified`), and when its daemon has
// not ended or the binding cannot be removed they fail and run no command in
// the session. `tabs` never counts such a session as a confirmed window of
// the thread; `done` and `done --all` let go of the thread's own session and
// then settle it (F38, addendum of 2026-11-15). agent-browser's own files are
// never changed but for removing a binding, its own way to reset one. The
// mark's place and text are the contract C19 (`src/browser/contract/`), which
// T3 Code reads so its strip takes no unverified binding (#989).

/** The tabs a session's binding may keep naming once its daemon has ended:
 * the one the binding asked for and the one it named before. Anything else
 * the daemon left there is removed. */
type KeptBinding = Readonly<{ targetId: string | null; before: string | null }>;

/** A session's mark (C19, `src/browser/contract/`): none, the mark, or one
 * that is there but cannot be read (`unknown`, which settles nothing and
 * keeps the session unverified). A mark whose text is not a mark of this
 * session keeps no tab. */
async function readUnverified(
  directory: string | undefined,
  session: string,
): Promise<KeptBinding | "none" | "unknown"> {
  if (directory === undefined || !isStrip(session)) return "none";
  let text: string;
  try {
    text = await readFile(join(directory, `${session}.json`), "utf8");
  } catch (error) {
    // No file, or no directory there to hold one: no mark.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "none" : "unknown";
  }
  const mark = parseUnverifiedBinding(`${session}.json`, text);
  return Object.freeze({
    targetId: mark?.targetId ?? null,
    before: mark?.before ?? null,
  });
}

/** Marks the session's binding as not verified, owner-only and atomically.
 * False when it could not be written. */
async function markUnverified(
  directory: string,
  session: string,
  kept: KeptBinding,
): Promise<boolean> {
  if (!isStrip(session)) return false;
  try {
    await replaceOwnerFile(
      join(directory, `${session}.json`),
      unverifiedBindingText({ session, ...kept }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Removes the session's mark; true once it is gone. */
async function clearUnverified(
  directory: string | undefined,
  session: string,
): Promise<boolean> {
  if (directory === undefined || !isStrip(session)) return true;
  try {
    await rm(join(directory, `${session}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

// ---- A window another thread took (F38, addendum of 2026-11-15) -------------
//
// `lazurio browser take` binds the calling thread's session to a tab another
// session is bound to, once its agent confirmed it. The earlier holder's
// binding is left as it is: removed, its next command would start a daemon
// that makes the first live tab of the browser its own, whoever's it is
// (measured on 0.37 and 0.43 on 2026-11-15), and agent-browser's own files
// are never changed. Nothing in agent-browser tells that holder, so Lazurio
// notes it for the holder's session, beside the window records:
// `$XDG_RUNTIME_DIR/lazurio-browser/taken/<session>.json`. While the
// session's binding still names that tab, `tabs` names the window as taken
// and no longer the thread's, `done --all` lets go of it, and `window` and
// `apps open` give the session a new window instead of the taken tab. The
// hub never reads a note.

/** Where `take` notes that another thread took a session's window; undefined
 * without an absolute runtime directory. */
export function takenWindowDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "lazurio-browser", "taken")
    : undefined;
}

const takenSchema = "lazurio.browser-taken-window.v1";

/** A session's window that another thread took: the session, the tab, the
 * thread that took it with the session it took it into (`by`), and when
 * (an ISO time). */
export type TakenWindow = Readonly<{
  session: string;
  targetId: string;
  thread: string;
  by: string;
  at: string;
}>;

/** Notes that another thread took the session's window, owner-only and
 * atomically. False when it could not be written. */
async function noteTakenWindow(
  env: Readonly<Record<string, string | undefined>>,
  note: TakenWindow,
): Promise<boolean> {
  const directory = takenWindowDirectory(env);
  const targetId = targetIdOf(note.targetId);
  if (
    directory === undefined ||
    targetId === null ||
    !isStrip(note.session) ||
    !isStrip(note.thread) ||
    !isStrip(note.by)
  )
    return false;
  try {
    await replaceOwnerFile(
      join(directory, `${note.session}.json`),
      `${JSON.stringify({ schema: takenSchema, ...note, targetId })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** The note of the session's taken window, or null: none, or one that
 * cannot be read or is no note of this session. */
async function readTakenWindow(
  env: Readonly<Record<string, string | undefined>>,
  session: string,
): Promise<TakenWindow | null> {
  const directory = takenWindowDirectory(env);
  if (directory === undefined || !isStrip(session)) return null;
  try {
    const value = JSON.parse(
      await readFile(join(directory, `${session}.json`), "utf8"),
    ) as Record<string, unknown> | null;
    const targetId = targetIdOf(value?.targetId);
    return value?.schema === takenSchema &&
      value.session === session &&
      targetId !== null &&
      isStrip(value.thread) &&
      isStrip(value.by) &&
      typeof value.at === "string"
      ? Object.freeze({
          session,
          targetId,
          thread: value.thread,
          by: value.by,
          at: value.at,
        })
      : null;
  } catch {
    return null;
  }
}

/** Removes the note of the session's taken window. */
async function clearTakenWindow(
  env: Readonly<Record<string, string | undefined>>,
  session: string,
): Promise<void> {
  const directory = takenWindowDirectory(env);
  if (directory === undefined || !isStrip(session)) return;
  await rm(join(directory, `${session}.json`), { force: true }).catch(
    () => undefined,
  );
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
 * the window may be any thread's), another thread took its tab (`taken`,
 * `lazurio browser take`), its binding is not verified since a binding of
 * `window` failed or did not finish, so it may name another agent's tab
 * (`unverified`, Pablo's review of #986), its binding no longer names the tab
 * it was recorded with (`rebound`), or the thread's own session was recorded
 * for another thread (`recorded-elsewhere`). */
export type ThreadWindowDoubt =
  | "unreadable"
  | "taken"
  | "unverified"
  | "rebound"
  | "recorded-elsewhere";

/** One window of a thread as agent-browser's files record it (C7): its
 * bound target, when its binding names one; whether its daemon runs (its
 * `.pid` names a running process, or cannot be read, which counts as running
 * as the hub counts it) or may be asked to stop (`.sock`); and whether the
 * thread's record confirms it as the thread's (`confirmed`), else why not
 * (`doubt`). One that is not confirmed may be the thread's or not: `tabs`
 * names it apart, never with its address or title, and `done --all` never
 * lets go of it, unless the session is the thread's for sure (`owned`) and
 * only its tab is in doubt: a binding not verified, or a tab another thread
 * took (`taken`, the note of `take`). */
export type ThreadSession = Readonly<{
  session: string;
  targetId: string | null;
  running: boolean;
  socket: boolean;
  confirmed: boolean;
  doubt: ThreadWindowDoubt | null;
  owned: boolean;
  taken: TakenWindow | null;
}>;

/** What the Environment's files say of one agent-browser session: its
 * binding (C7), whether its daemon may run (`running`) or has a socket, its
 * window record, whether its binding is marked unverified (C19), and the
 * note of a tab another thread took from it, while its binding still names
 * that tab. */
type SessionFacts = Readonly<{
  session: string;
  targetId: string | null;
  running: boolean;
  socket: boolean;
  record: RecordReading;
  unverified: boolean;
  taken: TakenWindow | null;
}>;

/** Every session with any of agent-browser's files (`.target`, `.pid`,
 * `.sock`), sorted by name with numbers in order. Empty where there is no
 * socket directory or it does not exist. */
async function readSessionFacts(
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => boolean,
): Promise<readonly SessionFacts[]> {
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
      !isStrip(session)
    )
      continue;
    const kinds = files.get(session) ?? new Set<string>();
    kinds.add(kind);
    files.set(session, kinds);
  }
  const records = windowRecordDirectory(env);
  const marks = unverifiedBindingDirectory(env);
  const sessions = [...files.keys()].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  return await Promise.all(
    sessions.map(async (session): Promise<SessionFacts> => {
      const kinds = files.get(session) as Set<string>;
      const targetId = kinds.has("target")
        ? await bindingOf(directory, session)
        : null;
      const note = await readTakenWindow(env, session);
      return Object.freeze({
        session,
        targetId,
        running:
          kinds.has("pid") && (await daemonMayRun(directory, session, alive)),
        socket: kinds.has("sock"),
        record: await readWindowRecord(records, session),
        unverified: (await readUnverified(marks, session)) !== "none",
        taken:
          note !== null && targetId !== null && note.targetId === targetId
            ? note
            : null,
      });
    }),
  );
}

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
 * A session of the thread whose tab another thread took is not confirmed
 * (`taken`): the tab is that thread's now. One whose binding is marked
 * unverified is never confirmed either (`unverified`): its binding may name
 * another agent's tab. Both stay `owned` where the session is the thread's
 * own or its record names the thread and the tab its binding names. No other
 * session is read as the thread's: no record, or a record of another thread,
 * whatever its name. */
export async function readThreadSessions(
  thread: string,
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => boolean = processAlive,
): Promise<readonly ThreadSession[]> {
  if (!isStrip(thread)) return [];
  const read = (await readSessionFacts(env, alive)).map(
    (facts): ThreadSession | null => {
      const { session, targetId, record } = facts;
      const own = session === thread;
      const recorded = typeof record === "object" && record.thread === thread;
      if (!own && !recorded && record !== "unreadable") return null;
      const owned =
        record !== "unreadable" &&
        (own
          ? record === "none" || recorded
          : recorded && record.targetId === targetId);
      const doubt: ThreadWindowDoubt | null =
        record === "unreadable"
          ? "unreadable"
          : owned && facts.taken !== null
            ? "taken"
            : facts.unverified
              ? "unverified"
              : own
                ? owned
                  ? null
                  : "recorded-elsewhere"
                : owned
                  ? null
                  : "rebound";
      return Object.freeze({
        session,
        targetId,
        running: facts.running,
        socket: facts.socket,
        confirmed: doubt === null,
        doubt,
        owned,
        taken: owned ? facts.taken : null,
      });
    },
  );
  return read.filter((entry): entry is ThreadSession => entry !== null);
}

/** One agent-browser session of the Environment as the overview of every
 * tab names it (`lazurio browser tabs --all`, `take`): its binding, whether
 * its daemon may run, the thread whose window it is where its record tells
 * (the record's thread while it confirms the binding, the session itself
 * without a record, else null: unknown), whether its binding is marked
 * unverified, and the note of a tab another thread took from it. */
export type EnvironmentSession = Readonly<{
  session: string;
  targetId: string | null;
  running: boolean;
  thread: string | null;
  unverified: boolean;
  taken: TakenWindow | null;
}>;

/** Every agent-browser session of the Environment (`EnvironmentSession`),
 * sorted by name with numbers in order. */
export async function readEnvironmentSessions(
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => boolean = processAlive,
): Promise<readonly EnvironmentSession[]> {
  return (await readSessionFacts(env, alive)).map(
    ({ session, targetId, running, record, unverified, taken }) =>
      Object.freeze({
        session,
        targetId,
        running,
        thread:
          record === "none"
            ? session
            : record === "unreadable"
              ? null
              : record.thread === session || record.targetId === targetId
                ? record.thread
                : null,
        unverified,
        taken,
      }),
  );
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
// How long opening a new window's address waits for the browser's answer
// (`Page.navigate`), which comes once the page's server answered: a slower
// page goes on loading, and `window` says so (#987).
const navigateWaitMs = 10_000;
// Longer than one creation: settling an unverified binding first (one shutdown
// asked, 5 s for its answer and 5 s for the daemon's end), a CDP call (15 s
// with its endpoint), two agent-browser commands (30 s each), after a failed
// binding the wait for the daemon's end with its last shutdown (40 s) (#974,
// Pablo's review of #986), then the address of the new window (15 s with its
// endpoint) or, for `take`, letting go of a holder (10 s).
const windowLockTimeoutMs = 180_000;

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
 * that thread's. A binding marked unverified is settled first and never
 * taken as the session's window; while it cannot be settled, this fails
 * with `binding-unverified` and opens nothing. */
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

/** What a binding came to: `bound`, verified; `failed`, the session left
 * where it was, on the tab asked for, or let go and its binding settled;
 * `unverified`, a failure whose clean-up could not finish (its daemon has
 * not ended, or the binding it left could not be removed), so the session's
 * binding may still name, or come to name, another agent's tab. */
type Binding = "bound" | "failed" | "unverified";

/** Binds the session to the tab with agent-browser's own commands and pins
 * it with a command that changes nothing: its agent works there next, and an
 * app that follows the session's binding shows it (T3 Code records a tab its
 * thread's session newly binds, F47 point 4). The session is marked
 * unverified before the first command (`markUnverified`); when the mark
 * cannot be written, no command runs and the binding fails. `bound` only
 * when both commands succeeded and the session's binding file then names the
 * tab (#974). After commands that answered, a binding that names the tab
 * asked for or what it named before is verified, so the mark goes and a
 * session such a failure left where it was (its own earlier window, a
 * binding to a tab that is gone) is left as it is, daemon and all. A failure
 * that left the session on another tab, or a command that did not answer in
 * time, lets the session go and settles its binding (`releaseBinding`); the
 * mark goes only once that is done, else the binding is `unverified`. The
 * caller has settled any earlier mark (`settleUnverified`). With `hold`
 * (`takeTab`, review of #993), a failure never leaves the session on the
 * tab asked for: the mark written before the first command keeps neither
 * that tab nor it as the earlier binding, a failure that left the session
 * there is let go like one on another tab, and where that cannot finish the
 * same mark stays, so the session is unverified without a second write. */
async function bindSession(
  session: string,
  targetId: string,
  seams: Pick<WindowSeams, "env" | "run" | "daemon" | "alive" | "endWithinMs">,
  hold = false,
): Promise<Binding> {
  const directory = agentBrowserSocketDirectory(seams.env);
  const marks = unverifiedBindingDirectory(seams.env);
  const before = await readBinding(directory, session);
  const earlier = before === "none" || before === "unreadable" ? null : before;
  const kept: KeptBinding = hold
    ? { targetId: null, before: earlier === targetId ? null : earlier }
    : { targetId, before: earlier };
  if (marks !== undefined && !(await markUnverified(marks, session, kept)))
    return "failed";
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
  // A command that did not answer in time is not over: its daemon goes on and
  // records its tab when it is done, after this reading (measured on 0.37:
  // the foreign tab 8 s after a timeout).
  const unanswered = bound === "timeout" || pinned === "timeout";
  // An unreadable binding says nothing about where the daemon is, so two
  // unreadable readings are not "unchanged".
  const stayed = after === before && after !== "unreadable";
  const verified = ok(bound) && ok(pinned) && after === targetId;
  const settled =
    (!unanswered &&
      (hold
        ? verified || (stayed && after !== targetId)
        : after === targetId || stayed)) ||
    (await releaseBinding(
      directory,
      session,
      kept,
      seams,
      seams.endWithinMs ?? daemonEndMs,
    ));
  if (!settled) return "unverified";
  // Verified or settled, so the mark goes. A mark that cannot be removed
  // keeps the session unverified for `tabs` until the next `window` settles
  // it again, which keeps this binding.
  await clearUnverified(marks, session);
  return verified ? "bound" : "failed";
}

/** Lets go of a session whose binding failed or did not finish and left it,
 * or may yet leave it, on another tab (#974). Its daemon is asked to shut
 * down as `lazurio browser done` asks it (`stopSessionDaemon`). One busy with
 * the command that did not answer records its tab when that command ends,
 * and 0.37 drops a shutdown asked meanwhile (0.43 takes it afterwards), so it
 * is asked again until it has ended, refused or `withinMs` passed. Only once
 * it has ended, so that nothing can record a tab any more, is the binding
 * file removed, unless it names a tab of `kept`: agent-browser's own way to
 * reset a session's binding (its errors say to delete the file), which takes
 * the session off the tab for `window`, the hub and T3 Code. Never `close`
 * or `tab close`, which would close the tab for the agent and the people
 * whose tab it is; the tab is left as it is. True when the daemon has ended
 * and the binding is settled; false when the daemon may still run, which
 * leaves the binding as it is, or when the binding could not be removed
 * (Pablo's review of #986). */
async function releaseBinding(
  directory: string | undefined,
  session: string,
  kept: KeptBinding,
  seams: Pick<WindowSeams, "daemon" | "alive">,
  withinMs: number,
): Promise<boolean> {
  if (directory === undefined || !isStrip(session)) return false;
  const alive = seams.alive ?? processAlive;
  const stop = () =>
    stopSessionDaemon(directory, session, seams.daemon).catch(
      () => "unconfirmed" as const,
    );
  const deadline = Date.now() + withinMs;
  let outcome = await stop();
  while (
    outcome !== "stopped" &&
    outcome !== "refused" &&
    Date.now() < deadline &&
    (await daemonMayRun(directory, session, alive))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    outcome = await stop();
  }
  if (await daemonMayRun(directory, session, alive)) return false;
  const now = await readBinding(directory, session);
  if (now === "none" || now === kept.targetId || now === kept.before)
    return true;
  try {
    await rm(join(directory, `${session}.target`), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Settles a session marked unverified (`markUnverified`) before anything
 * takes its binding as its window: its daemon is asked once more to shut
 * down, and once it has ended, the binding it left is removed unless it names
 * a tab the mark keeps, and the mark goes. `pending` while its daemon may
 * run, or when its mark, its binding or the socket directory cannot be read
 * or removed: the session's binding is then not believed and nothing runs in
 * the session. `settled` at once without a mark. */
async function settleUnverified(
  session: string,
  seams: Pick<WindowSeams, "env" | "daemon" | "alive">,
): Promise<"settled" | "pending"> {
  const marks = unverifiedBindingDirectory(seams.env);
  const kept = await readUnverified(marks, session);
  if (kept === "none") return "settled";
  if (kept === "unknown") return "pending";
  return (await releaseBinding(
    agentBrowserSocketDirectory(seams.env),
    session,
    kept,
    seams,
    0,
  )) && (await clearUnverified(marks, session))
    ? "settled"
    : "pending";
}

/** `lazurio browser done` after it let go of a session (F38, addendum of
 * 2026-11-15): a binding an earlier `window` left unverified is settled once
 * the session's daemon has ended, as the next `window` would settle it, so
 * the agent is not left waiting on a mark. `none` without a mark; `settled`
 * once the mark is gone; `pending` while the daemon may run or the binding or
 * the mark cannot be removed. Under the account's window lock, so it never
 * settles a binding a `window` of the same session is making. */
export async function settleSessionBinding(
  session: string,
  seams: Pick<WindowSeams, "env" | "daemon" | "alive">,
): Promise<"none" | "settled" | "pending"> {
  if (
    (await readUnverified(unverifiedBindingDirectory(seams.env), session)) ===
    "none"
  )
    return "none";
  try {
    return await underWindowLock(seams.env, () =>
      settleUnverified(session, seams),
    );
  } catch {
    return "pending";
  }
}

/** The default browser's page becomes the thread's window (root decision
 * 0201 point 5): the session is bound to the tab the hub opened, under the
 * account's window lock, so a `lazurio browser window` of the same thread at
 * the same moment converges on it. The thread's earlier window stays as long
 * as something holds it. False when it could not be bound: the session then
 * stays on its earlier window, or, where the failure moved it to another tab,
 * is let go (`bindSession`), and the page stays open. False too, with no
 * command run in the session, while an earlier binding of it is not verified
 * (`settleUnverified`). */
export async function bindThreadWindow(
  session: string,
  targetId: string,
  seams: Pick<WindowSeams, "env" | "run" | "daemon" | "alive" | "endWithinMs">,
): Promise<boolean> {
  try {
    return await underWindowLock(
      seams.env,
      async () =>
        (await settleUnverified(session, seams)) === "settled" &&
        (await bindSession(session, targetId, seams)) === "bound",
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
  // A binding that is not verified is never the session's window, and
  // nothing runs in the session until it is settled.
  if ((await settleUnverified(session, seams)) === "pending")
    throw new BrowserWindowFailure("binding-unverified");
  let existing: string | null;
  try {
    existing = await boundTarget(session, seams);
  } catch {
    throw new BrowserWindowFailure("browser-unreachable");
  }
  // A tab another thread took (`take`) is that thread's now: the session
  // gets a new window, never the taken tab.
  const taken =
    existing === null ? null : await takenFrom(session, existing, seams.env);
  if (taken !== null)
    return createInPlaceOfTaken(session, url, seams, options, taken);
  if (existing !== null)
    return Object.freeze({ session, targetId: existing, created: false });
  // The thread shows the page already: the session works there too.
  const shown =
    url === undefined
      ? null
      : await threadPage(session, url, seams).catch(() => null);
  if (shown !== null) {
    bindingFailure(await bindSession(session, shown, seams));
    return Object.freeze({ session, targetId: shown, created: false });
  }
  return createThreadWindow(session, url, seams, options);
}

/** The note of the tab another thread took from the session, while its
 * binding still names that tab (`existing`). */
async function takenFrom(
  session: string,
  existing: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<TakenWindow | null> {
  const note = await readTakenWindow(env, session);
  return note !== null && note.targetId === existing ? note : null;
}

/** A new window for a session whose tab another thread took: the session
 * leaves the taken tab for its new window, and the note goes once it has. */
async function createInPlaceOfTaken(
  session: string,
  url: string | undefined,
  seams: WindowSeams,
  options: WindowOptions,
  taken: TakenWindow,
): Promise<ThreadWindow> {
  const window = await createThreadWindow(session, url, seams, options);
  await clearTakenWindow(seams.env, session);
  return Object.freeze({ ...window, takenBy: taken });
}

/** A binding that failed, as `window` fails: `bind-failed` when the session
 * was left on no other tab, `binding-unverified` when that could not be
 * verified (Pablo's review of #986). */
function bindingFailure(binding: Binding): void {
  if (binding === "bound") return;
  throw new BrowserWindowFailure(
    binding === "unverified" ? "binding-unverified" : "bind-failed",
  );
}

/** A new window in the default context, bound to the session and pinned
 * (`ensureThreadWindow`), recorded as the window of `options.thread` when
 * one is given, and then at `url`. The window opens at `about:blank`, whose
 * blank page answers agent-browser's probe at once, so the binding never
 * waits for a page (#987): before, a page that did not answer within 3 + 10 s
 * failed it. Only once the session is bound does the browser open the
 * address (`seams.navigate`, `Page.navigate`: `Sec-Fetch-Site: none`, no
 * page's link or form); its outcome is the window's `navigation`, and a page
 * that is slow or fails leaves the window bound and recorded. The tab's
 * history keeps the blank page before the address where the address did not
 * load at once (measured on 2026-11-15), so Back from the first page shows a
 * blank page. A window that could not be bound is let go, not retried
 * (#974): nothing holds it, so the hub ends it like any tab nobody holds or
 * views, and `window` never closes it, as `done` never does. A retry would
 * start yet another daemon that takes the first live tab of the browser as
 * its own while the account's window lock keeps every other thread waiting;
 * the agent runs `window` again instead, and the session, now bound to no
 * other tab, gets a new window. Nothing is recorded. Where the clean-up of
 * the failure could not finish, `window` says so (`binding-unverified`) and
 * the next one settles it before anything else. */
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
        url: "about:blank",
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
  bindingFailure(await bindSession(session, targetId, seams));
  const recorded =
    options.thread === undefined
      ? undefined
      : await recordThreadWindow(seams.env, {
          session,
          thread: options.thread,
          targetId,
        });
  const navigation =
    url === undefined || url === "about:blank"
      ? undefined
      : await seams.navigate(targetId, url).catch(() => "failed" as const);
  return Object.freeze({
    session,
    targetId,
    created: true,
    ...(recorded === undefined ? {} : { recorded }),
    ...(navigation === undefined ? {} : { navigation }),
  });
}

/** A page the thread opens in its own window (a colleague's application
 * through its hand-over, Lazurio Auth docs/agent-application-entry.md,
 * LZD-0009 M9): unlike `ensureThreadWindow`, the address does move the
 * window. Without a bound window, a new one, bound at `about:blank` and then
 * sent to `url` (`createThreadWindow`); with one, agent-browser's own `open`
 * navigates it there. Both are navigations the browser starts itself
 * (DevTools' `Page.navigate`), never a page's link or form, which the hosting
 * gateway's landing requires (`Sec-Fetch-Site: none`). The address is opened
 * exactly as given; a new window whose address the browser refused fails
 * with `navigate-failed`, one still loading does not. A new window is
 * recorded as the window of `options.thread` when one is given
 * (`recordThreadWindow`). Under the account's window lock. A session whose
 * binding is not verified gets nothing, and its bound tab is never navigated
 * (`settleUnverified`, Pablo's review of #986); nor is a tab another thread
 * took from the session (`take`): the session gets a new window instead. */
export async function openInThreadWindow(
  session: string,
  url: string,
  seams: WindowSeams,
  options: WindowOptions = {},
): Promise<ThreadWindow> {
  return underWindowLock(seams.env, async () => {
    if ((await settleUnverified(session, seams)) === "pending")
      throw new BrowserWindowFailure("binding-unverified");
    let existing: string | null;
    try {
      existing = await boundTarget(session, seams);
    } catch {
      throw new BrowserWindowFailure("browser-unreachable");
    }
    const taken =
      existing === null ? null : await takenFrom(session, existing, seams.env);
    if (existing === null || taken !== null) {
      const window =
        taken === null
          ? await createThreadWindow(session, url, seams, options)
          : await createInPlaceOfTaken(session, url, seams, options, taken);
      if (window.navigation === "failed")
        throw new BrowserWindowFailure("navigate-failed");
      return window;
    }
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

// ---- Taking another session's tab (F38, addendum of 2026-11-15) -------------

/** A session that held the tab `take` took: its thread where its record
 * tells (`EnvironmentSession`), and whether its daemon ran. */
export type TakenFromSession = Readonly<{
  session: string;
  thread: string | null;
  running: boolean;
}>;

/** What `take` came to: the session now bound to the tab, the tab, the
 * sessions it took it from, whether the window was recorded as the thread's,
 * and `already` where the session held it already and nothing changed. */
export type TakenTab = Readonly<{
  session: string;
  targetId: string;
  from: readonly TakenFromSession[];
  recorded: boolean;
  already: boolean;
}>;

/** The sessions other than `session` whose binding names the tab: who holds
 * it now, or held it, as agent-browser's files say. */
export async function tabHolders(
  session: string,
  targetId: string,
  env: Readonly<Record<string, string | undefined>>,
  alive: (pid: number) => boolean = processAlive,
): Promise<readonly EnvironmentSession[]> {
  return (await readEnvironmentSessions(env, alive)).filter(
    (entry) => entry.session !== session && entry.targetId === targetId,
  );
}

/** Takes a tab into the calling thread's session on purpose, once its agent
 * confirmed it (`lazurio browser take --confirm`): the session is bound to
 * the tab and pinned as `window` binds one (`bindSession`), and the window is
 * recorded as the thread's. Every other session bound to the tab is let go
 * first, as `done` lets go of one (`stopSessionDaemon`): agent-browser 0.43
 * refuses `tab` to a tab another live session has pinned (#2135), and 0.37
 * would leave two agents working in it unseen. Their bindings are left as
 * they are, and each gets a note (`noteTakenWindow`) that its `tabs` and
 * `window` read; no tab is closed, no holder file changes, and the people who
 * view it keep it. Refused, with nothing changed, where the browser has no
 * such tab (`not-a-tab`), the session is bound to another open window of its
 * own, which it would leave (`session-busy`), its binding is not verified
 * (`binding-unverified`), a holder's daemon did not shut down
 * (`holder-busy`, then the holders asked before it are let go and nothing is
 * bound), or a holder's note cannot be written (`take-note-failed`, then the
 * notes go back to what they were and nothing is bound). Where the binding
 * itself fails, the notes go back only once the session is proven off the
 * tab; otherwise they stay and the session is marked unverified
 * (`binding-unverified`), so no two agents work in the tab unseen. A session that holds the tab already changes nothing (`already`),
 * unless another thread took it from it: then it takes it back. Under the
 * account's window lock. */
export async function takeTab(
  session: string,
  targetId: string,
  seams: WindowSeams,
  options: Readonly<{ thread: string }>,
): Promise<TakenTab> {
  return underWindowLock(seams.env, async () => {
    if ((await settleUnverified(session, seams)) === "pending")
      throw new BrowserWindowFailure("binding-unverified", session);
    let open: ReadonlySet<string>;
    try {
      open = await seams.targets();
    } catch {
      throw new BrowserWindowFailure("browser-unreachable");
    }
    if (!open.has(targetId)) throw new BrowserWindowFailure("not-a-tab");
    const sockets = agentBrowserSocketDirectory(seams.env);
    const own = await readBinding(sockets, session);
    const ownTaken =
      own === targetId ? await takenFrom(session, targetId, seams.env) : null;
    if (own === targetId && ownTaken === null)
      return Object.freeze({
        session,
        targetId,
        from: [],
        recorded: false,
        already: true,
      });
    if (
      own !== targetId &&
      own !== "none" &&
      own !== "unreadable" &&
      open.has(own)
    )
      throw new BrowserWindowFailure("session-busy", session);
    const alive = seams.alive ?? processAlive;
    const holders = await tabHolders(session, targetId, seams.env, alive);
    for (const holder of holders.filter((entry) => entry.running)) {
      const outcome =
        sockets === undefined
          ? "unconfirmed"
          : await stopSessionDaemon(
              sockets,
              holder.session,
              seams.daemon,
            ).catch(() => "unconfirmed" as const);
      if (
        outcome === "refused" ||
        outcome === "unconfirmed" ||
        (sockets !== undefined &&
          (await daemonMayRun(sockets, holder.session, alive)))
      )
        throw new BrowserWindowFailure("holder-busy", holder.session);
    }
    // Every earlier holder's note is written before the session is bound:
    // a holder whose note is missing would take the tab for its window
    // again and navigate it. Where one cannot be written, or the binding
    // fails, the notes go back to what they were and nothing is taken.
    const at = new Date().toISOString();
    const earlier = new Map<string, TakenWindow | null>();
    const restore = async () => {
      for (const [held, note] of earlier)
        if (note === null) await clearTakenWindow(seams.env, held);
        else await noteTakenWindow(seams.env, note);
    };
    for (const holder of holders) {
      earlier.set(
        holder.session,
        await readTakenWindow(seams.env, holder.session),
      );
      if (
        !(await noteTakenWindow(seams.env, {
          session: holder.session,
          targetId,
          thread: options.thread,
          by: session,
          at,
        }))
      ) {
        await restore();
        throw new BrowserWindowFailure("take-note-failed", holder.session);
      }
    }
    // Bound with `hold`: a failure is `failed` only once the taker is off
    // the tab, and the holders get their window back; otherwise the mark
    // written before the binding's first command stays, the notes stay,
    // and the taker is unverified (C19) until `done` or `window` settles it.
    const binding = await bindSession(session, targetId, seams, true).catch(
      () => "unverified" as const,
    );
    if (binding === "failed") await restore();
    bindingFailure(binding);
    const recorded = await recordThreadWindow(seams.env, {
      session,
      thread: options.thread,
      targetId,
    });
    await clearTakenWindow(seams.env, session);
    return Object.freeze({
      session,
      targetId,
      from: holders.map(({ session: held, thread, running }) =>
        Object.freeze({ session: held, thread, running }),
      ),
      recorded,
      already: false,
    });
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
  const endpoint = async () => {
    const version = (await (
      await fetch(`${base}/json/version`, {
        signal: AbortSignal.timeout(5_000),
      })
    ).json()) as { webSocketDebuggerUrl?: unknown };
    const found = version.webSocketDebuggerUrl;
    if (typeof found !== "string" || !found.startsWith("ws://127.0.0.1:"))
      throw new Error("no browser endpoint");
    return found;
  };
  const cdp: CdpCall = async (method, params) => {
    const browser = await endpoint();
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(browser);
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
  // The page's own navigation on a session attached to it: `Page.navigate`
  // answers once the page's server answered, so a slower page is `pending`
  // after `navigateWaitMs` and loads on after the socket closes (measured on
  // 2026-11-15). The request carries `Sec-Fetch-Site: none`.
  const navigate = async (
    targetId: string,
    url: string,
  ): Promise<Navigation> => {
    let browser: string;
    try {
      browser = await endpoint();
    } catch {
      return "failed";
    }
    return await new Promise<Navigation>((resolve) => {
      const socket = new WebSocket(browser);
      let sent = false;
      let settled = false;
      const finish = (outcome: Navigation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve(outcome);
      };
      const timer = setTimeout(
        () => finish(sent ? "pending" : "failed"),
        navigateWaitMs,
      );
      socket.onerror = () => finish(sent ? "pending" : "failed");
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Target.attachToTarget",
            params: { targetId, flatten: true },
          }),
        );
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          id?: unknown;
          result?: { sessionId?: unknown; errorText?: unknown } | undefined;
          error?: unknown;
        };
        if (message.id === 1) {
          const sessionId = message.result?.sessionId;
          if (message.error !== undefined || typeof sessionId !== "string") {
            finish("failed");
            return;
          }
          sent = true;
          socket.send(
            JSON.stringify({
              id: 2,
              sessionId,
              method: "Page.navigate",
              params: { url },
            }),
          );
        } else if (message.id === 2)
          finish(
            message.error === undefined &&
              typeof message.result?.errorText !== "string"
              ? "started"
              : "failed",
          );
      };
    });
  };
  return Object.freeze({ env, run, targets, cdp, navigate, pages });
}
