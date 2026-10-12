import { randomBytes } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import {
  type BootTime,
  type HolderReading,
  isStrip,
  liveTabsText,
  parseBootTime,
  parseHolder,
  targetIdOf,
} from "./pure";

// The Environment browser's contract, its Node part (decision F50 point 1):
// what the pure part's rules need of the host, with only `node:` built-ins.
// Where the files are, the boot clock, the atomic owner-only replace, the one
// reading of holder files and agent-browser's bindings for every reader (the
// hub passes the memory of root decision 0191 point 32, a reader for display
// passes none), and letting go of a session's window through its daemon's
// socket.
//
// Who keeps a remote tab of the Environment browser (decision F47 points 4
// and 5), read by the view's hub, which alone ends a tab:
// - the places that hold it: one file per strip that the app's server writes,
//   `$XDG_RUNTIME_DIR/lazurio-browser/holders/<strip>.json` =
//   `{"strip", "label", "tabs": [<target id>…]}` (a T3 Code thread, the
//   Launchpad), with the writer's own `recordedAt`, which the hub ignores;
// - the agents that work in it: an agent-browser session bound to it
//   (`<socket dir>/<session>.target`) whose daemon runs (`<session>.pid`
//   names a live process). The binding alone does not count: agent-browser
//   keeps it past the daemon on purpose, and the daemon ends after an hour
//   without a command.

// ---- Where the files are ----------------------------------------------------

/** `$XDG_RUNTIME_DIR/lazurio-browser/holders`, where the apps' servers write
 * their holds; undefined without an absolute runtime directory. */
export function holderDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "lazurio-browser", "holders")
    : undefined;
}

/** `$XDG_RUNTIME_DIR/lazurio-browser/tabs.json`: the hub's list of the
 * browser's live page targets, which every app's server reconciles its holds
 * with (F47 point 4). */
export function liveTabsPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const runtime = env.XDG_RUNTIME_DIR;
  return runtime !== undefined && isAbsolute(runtime)
    ? join(runtime, "lazurio-browser", "tabs.json")
    : undefined;
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

// ---- The boot clock and the files' replacement ------------------------------

/** Reads the boot clock: `/proc/sys/kernel/random/boot_id` and the first
 * number of `/proc/uptime` (CLOCK_BOOTTIME). Null where there is none: not
 * Linux, where no Environment browser runs. */
export async function readBootClock(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<BootTime | null> {
  try {
    const boot = (await read("/proc/sys/kernel/random/boot_id")).trim();
    const at = Number.parseFloat(
      (await read("/proc/uptime")).trim().split(/\s+/)[0] ?? "",
    );
    return parseBootTime({ boot, at });
  } catch {
    return null;
  }
}

/** Replaces one file of `lazurio-browser` atomically and owner-only (F47
 * point 4): a temporary file of mode 0600 renamed over it, so a reader sees
 * the old text or the new one, never a part. Its directory is made with mode
 * 0700 when missing. */
export async function replaceOwnerFile(
  path: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Writes the list (`liveTabsText`) atomically: a reader sees the old list
 * or the new one. */
export async function writeLiveTabs(
  path: string,
  tabs: readonly string[],
  takenAt: BootTime,
): Promise<void> {
  await replaceOwnerFile(path, liveTabsText(tabs, takenAt));
}

// ---- The holds ----------------------------------------------------------------

export type Hold = Readonly<{ strip: string; label: string }>;

export type Holds = Readonly<{
  /** The strips that hold each target. */
  holders: ReadonlyMap<string, readonly Hold[]>;
  /** The sessions whose agent works in each target: bound, daemon running. */
  working: ReadonlyMap<string, readonly string[]>;
  /** Every session bound to each target, its daemon running or not: who
   * opened an agent's window. */
  bound: ReadonlyMap<string, readonly string[]>;
}>;

export const noHolds: Holds = Object.freeze({
  holders: new Map(),
  working: new Map(),
  bound: new Map(),
});

/** What the files said at their last reading, by file name (root decision
 * 0191 point 32, which changes F47 point 5): a holder file that cannot be
 * read keeps holding what it held then, and only that, and a binding that
 * cannot be read keeps its tab. A file never read holds nothing. */
export type HoldsMemory = Readonly<{
  holders: ReadonlyMap<string, HolderReading>;
  /** Each session's target id, by its binding's file name. */
  bindings: ReadonlyMap<string, string>;
}>;

export const noHoldsMemory: HoldsMemory = Object.freeze({
  holders: new Map(),
  bindings: new Map(),
});

/** One reading of both directories: the holds, what the next reading
 * remembers, and the files this one could not read. */
export type HoldsReading = Readonly<{
  holds: Holds;
  memory: HoldsMemory;
  /** Holder files (`<strip>.json`) and bindings (`<session>.target`). */
  unreadable: readonly string[];
  /** Every holder file and binding there was at this reading, read or not:
   * one missing here is gone. */
  present: readonly string[];
}>;

/** True while a process with this id runs (one of another user counts too,
 * as `kill -0` answers EPERM for it). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const add = (map: Map<string, string[]>, key: string, value: string) => {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
};

/** True for "no such file or directory": the one read failure that means
 * nothing is there. */
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** A directory's names; one that does not exist is empty (no app wrote a
 * hold, no agent ran). Any other failure is thrown. */
async function names(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/** A file's text; null when it is gone (removed between the listing and the
 * read). Any other failure is thrown. */
async function text(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** A file's text, null when it is gone, or "unreadable" for any other
 * failure: a permission, an I/O error. */
const textOf = (path: string) => text(path).catch(() => "unreadable" as const);

/** Reads both directories (F47 point 5 as root decision 0191 point 32
 * changes it). Only a directory or file that does not exist reads as holding
 * nothing. A directory that cannot be listed is thrown, so the hub keeps its
 * last reading and no tab ends. A file that cannot be read (a permission, an
 * I/O error) or is not a holder file stops the ending of its own tabs only:
 * it keeps holding what it held at its last reading in `memory`, the other
 * files count as they read now, and it is named in `unreadable`. A holder
 * file is replaced atomically by its app, so a broken one is a fault to see,
 * not a release. Names that are no strip's file (an app's temporary file)
 * are skipped. An agent-browser session counts as ended only when its `.pid`
 * is gone or names a well-formed process id that no longer runs; one that
 * cannot be read or understood (empty, signed, zero) counts as working,
 * which keeps its tab. */
export async function readHolds(
  directories: Readonly<{
    holders?: string | undefined;
    sockets?: string | undefined;
  }>,
  alive: (pid: number) => boolean = processAlive,
  memory: HoldsMemory = noHoldsMemory,
): Promise<HoldsReading> {
  const holders = new Map<string, Hold[]>();
  const working = new Map<string, string[]>();
  const bound = new Map<string, string[]>();
  const remembered = {
    holders: new Map<string, HolderReading>(),
    bindings: new Map<string, string>(),
  };
  const unreadable: string[] = [];
  const present: string[] = [];
  if (directories.holders !== undefined) {
    const directory = directories.holders;
    for (const name of await names(directory)) {
      if (!name.endsWith(".json") || !isStrip(name.slice(0, -".json".length)))
        continue;
      const content = await textOf(join(directory, name));
      if (content === null) continue;
      present.push(name);
      let hold = content === "unreadable" ? null : parseHolder(name, content);
      if (hold === null) {
        unreadable.push(name);
        hold = memory.holders.get(name) ?? null;
        if (hold === null) continue;
      }
      remembered.holders.set(name, hold);
      for (const id of hold.tabs) {
        const list = holders.get(id);
        const entry = { strip: hold.strip, label: hold.label };
        if (list === undefined) holders.set(id, [entry]);
        else list.push(entry);
      }
    }
  }
  if (directories.sockets !== undefined) {
    const directory = directories.sockets;
    for (const name of await names(directory)) {
      if (!name.endsWith(".target")) continue;
      const session = name.slice(0, -".target".length);
      if (!isStrip(session)) continue;
      const content = await textOf(join(directory, name));
      if (content === null) continue;
      present.push(name);
      let targetId: unknown;
      let read = content !== "unreadable";
      if (read)
        try {
          targetId = (JSON.parse(content) as { targetId?: unknown } | null)
            ?.targetId;
        } catch {
          read = false;
        }
      if (!read) {
        unreadable.push(name);
        targetId = memory.bindings.get(name);
      }
      const id = targetIdOf(targetId);
      if (id === null) continue;
      remembered.bindings.set(name, id);
      add(bound, id, session);
      const pidText = await textOf(join(directory, `${session}.pid`));
      if (pidText === null) continue;
      // Only a well-formed process id proven ended releases the tab; an
      // unreadable, empty, signed or zero one is unclear, and unclear keeps
      // it.
      const digits = pidText === "unreadable" ? "" : pidText.trim();
      const pid = /^[0-9]{1,10}$/.test(digits) ? Number(digits) : Number.NaN;
      if (!(Number.isSafeInteger(pid) && pid >= 2) || alive(pid))
        add(working, id, session);
    }
  }
  return {
    holds: { holders, working, bound },
    memory: remembered,
    unreadable,
    present,
  };
}

/** The hub's reading of the holds: one reading at a time, each remembering
 * what the files it could read held, so a file that cannot be read keeps
 * holding what it held (root decision 0191 point 32). It logs when a file
 * becomes unreadable, and then whether it can be read again or is gone,
 * which lets go of what it held. A directory that cannot be listed is
 * thrown, as `readHolds` does. */
export function holdsReader(
  directories: Readonly<{
    holders?: string | undefined;
    sockets?: string | undefined;
  }>,
  options: Readonly<{
    alive?: (pid: number) => boolean;
    log?: (line: string) => void;
  }> = {},
): () => Promise<Holds> {
  let memory = noHoldsMemory;
  let reported: ReadonlySet<string> = new Set();
  let last: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<Holds> => {
    const reading = await readHolds(directories, options.alive, memory);
    memory = reading.memory;
    const now = new Set(reading.unreadable);
    for (const name of now) {
      if (reported.has(name)) continue;
      const tabs = memory.holders.get(name)?.tabs.length;
      const kept = name.endsWith(".target")
        ? memory.bindings.has(name)
          ? "it keeps its tab"
          : "it was never read, so it binds no tab"
        : tabs !== undefined
          ? `it keeps the ${tabs === 1 ? "tab" : `${tabs} tabs`} it held when it was last read`
          : "it was never read, so it holds no tab";
      options.log?.(`${name} cannot be read: ${kept}; other files count`);
    }
    const present = new Set(reading.present);
    for (const name of reported)
      if (!now.has(name))
        options.log?.(
          present.has(name)
            ? `${name} can be read again`
            : `${name} is gone: it holds nothing now`,
        );
    reported = now;
    return reading.holds;
  };
  return () => {
    const next = last.then(read, read);
    last = next.catch(() => undefined);
    return next;
  };
}

/** The holder files that cannot be read or are not holder files, for
 * `lazurio doctor` (root decision 0191 point 32): their names, or the
 * directory itself when it cannot be listed. Empty without the directory. */
export async function unreadableHolderFiles(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const directory = holderDirectory(env);
  if (directory === undefined) return [];
  let found: string[];
  try {
    found = await names(directory);
  } catch {
    return [directory];
  }
  const failed: string[] = [];
  for (const name of found) {
    if (!name.endsWith(".json") || !isStrip(name.slice(0, -".json".length)))
      continue;
    const content = await textOf(join(directory, name));
    if (content === null) continue;
    if (content === "unreadable" || parseHolder(name, content) === null)
      failed.push(name);
  }
  return failed;
}

/** Calls `changed` whenever something in one of the directories changes.
 * A directory that does not exist yet is watched once it does: `retry` is
 * called by the hub on its periodic read. */
export function watchHolds(
  directories: readonly (string | undefined)[],
  changed: () => void,
): Readonly<{ retry: () => void; stop: () => void }> {
  const watchers = new Map<string, FSWatcher>();
  const retry = () => {
    for (const directory of directories) {
      if (directory === undefined || watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, () =>
          changed(),
        );
        watcher.on("error", () => {
          watcher.close();
          watchers.delete(directory);
        });
        watchers.set(directory, watcher);
      } catch {}
    }
  };
  retry();
  return Object.freeze({
    retry,
    stop: () => {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  });
}

// ---- Letting go of a session's window (C7) -----------------------------------

/** What a session's daemon answered on its socket: nothing listens there
 * (`absent`), a reply line, or no reply in time. */
export type DaemonAnswer =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "reply"; line: string }>
  | Readonly<{ kind: "no-answer" }>;

/** What letting go of a window needs of the host: overridable in tests. */
export type DaemonSeams = Readonly<{
  /** Sends one command line to a socket and answers the reply line. */
  ask?: (socketPath: string, line: string) => Promise<DaemonAnswer>;
  /** Whether a file is still there, polled while the daemon exits. */
  exists?: (path: string) => Promise<boolean>;
  /** How long to wait for the daemon to exit after it acknowledged. */
  exitWithinMs?: number;
}>;

/** agent-browser's own graceful shutdown of a session's daemon, as its CLI
 * sends it before restarting a daemon (`request_graceful_daemon_shutdown`
 * in agent-browser `cli/src/connection.rs`): the daemon runs its close,
 * which only disconnects from a browser it did not launch, answers and
 * exits, removing its `.pid`. An internal action of the agent-browser
 * release Machines pin; the fork's contract check covers it. */
export const agentBrowserShutdownAction = "__agent_browser_internal_shutdown";

const daemonAnswerMs = 5_000;
const maxDaemonReplyBytes = 64 * 1024;

/** Connection errors that prove nothing listens on a socket path: no file,
 * a socket nobody listens on (Linux), a file that is no socket (macOS).
 * Anything else, a permission above all, proves nothing. */
const absentSocketCodes = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

/** One command line to a Unix socket and its reply line. Nothing listening
 * (no socket, a stale one) is `absent`; no reply within 5 s, or a socket
 * that cannot be reached for any other reason, is `no-answer`. */
export function askDaemonSocket(
  socketPath: string,
  line: string,
): Promise<DaemonAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let buffer = "";
    const socket = createConnection({ path: socketPath });
    const done = (answer: DaemonAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done({ kind: "no-answer" }), daemonAnswerMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(line);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end >= 0) done({ kind: "reply", line: buffer.slice(0, end) });
      else if (buffer.length > maxDaemonReplyBytes) done({ kind: "no-answer" });
    });
    socket.on("end", () =>
      done(
        buffer === "" ? { kind: "no-answer" } : { kind: "reply", line: buffer },
      ),
    );
    socket.on("error", (error: NodeJS.ErrnoException) =>
      done(
        !connected && absentSocketCodes.has(error.code ?? "")
          ? { kind: "absent" }
          : { kind: "no-answer" },
      ),
    );
  });
}

/** Whether a file is there: only "no such file" is gone; any other failure
 * is thrown, since it proves nothing. */
const fileExists = (path: string) =>
  access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/** Lets go of a session's window (root decision 0191 point 28): asks the
 * session's own agent-browser daemon, on that session's socket
 * (`<socket dir>/<session>.sock`), to shut down, then waits up to 5 s for
 * its `.pid` to go. The daemon of an attached browser disconnects without
 * closing a tab, so the hub no longer counts the agent as working in it
 * (F47 point 5): the tab ends once nothing holds it and nobody views it.
 * Nothing is signalled by a process id, so a stale `.pid` whose number
 * another process now has, even another session's daemon, is never touched
 * (Pablo's review of #348). Never `agent-browser close` or `tab close`: the
 * tab would close for everyone who holds or views it, and the CLI starts a
 * daemon first when none runs. `stopped`: the daemon answered and its
 * `.pid` is gone; `none`: nothing listens on the session's socket;
 * `refused`: the daemon answered that it did not shut down, so nothing
 * changed; `unconfirmed`: no answer, a socket or `.pid` that cannot be
 * reached, or an answer but the `.pid` still there after the wait, so the
 * daemon may still hold the window. */
export async function stopSessionDaemon(
  socketDirectory: string,
  session: string,
  seams: DaemonSeams = {},
): Promise<"stopped" | "none" | "refused" | "unconfirmed"> {
  if (!isStrip(session)) return "none";
  const answer = await (seams.ask ?? askDaemonSocket)(
    join(socketDirectory, `${session}.sock`),
    `${JSON.stringify({ id: "lazurio-browser-done", action: agentBrowserShutdownAction })}\n`,
  );
  if (answer.kind === "absent") return "none";
  // The command went out: the daemon may have taken it even if its answer
  // was lost.
  if (answer.kind === "no-answer") return "unconfirmed";
  let success = false;
  try {
    success =
      (JSON.parse(answer.line) as { success?: unknown } | null)?.success ===
      true;
  } catch {}
  if (!success) return "refused";
  const exists = seams.exists ?? fileExists;
  const pid = join(socketDirectory, `${session}.pid`);
  const deadline = Date.now() + (seams.exitWithinMs ?? daemonAnswerMs);
  for (;;) {
    // Only a .pid proven gone counts; one that cannot be checked is not.
    const present = await exists(pid).catch(() => null);
    if (present === false) return "stopped";
    if (present === null || Date.now() >= deadline) return "unconfirmed";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
