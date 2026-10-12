import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

// agent-browser's idle timeout on the Environment browser (decision F47 point 5,
// Lazurio/LazurioPlatform#326). An agent works in a tab while its session's
// daemon runs, and F47 counts on that daemon ending after an hour without a
// command. agent-browser's own default does not do that here: it skips a
// browser the daemon did not launch (`blocks_default_idle_shutdown`), and every
// daemon on an Environment attaches to the Environment browser over DevTools.
// Only an explicit setting ends such a daemon, so the Platform, which owns
// agent-browser's settings on an Environment (root decision 0191 point 9),
// writes one into agent-browser's user config. Every agent-browser command of
// the user reads that file, so every caller carries the same value: the value is
// part of the daemon's configuration fingerprint, and callers that differ would
// make agent-browser restart the daemon. On the timeout an attached daemon only
// disconnects and removes its `.pid`; the hub still decides when the tab ends.
//
// The file is the person's as much as ours, so nothing of theirs is ever lost
// (Pablo's review of #333): a symbolic link or anything but a regular file is
// left as it is, a missing file is created only while it is still missing, and
// a file that changed since it was read is not replaced.

/** An hour without a command, as F47 point 5 counts on. */
export const agentBrowserIdleTimeout = "1h";

export type AgentBrowserConfigOutcome =
  /** The setting was written now. */
  | "set"
  /** The file names an idle timeout already: someone's explicit choice. */
  | "kept"
  /** The path is a symbolic link or not a regular file (a link into the
   * person's own dotfiles, say): left as it is. */
  | "not-a-file"
  /** The file changed, or appeared, while this ran: left as the person left
   * it; the next start looks again. */
  | "changed"
  /** The file cannot be read, or is not a JSON object: left as it is. */
  | "unreadable"
  /** No absolute HOME: no user config to write. */
  | "no-home";

/** What `lstat` says of a path, or null when nothing is there. */
export type PathState = Readonly<{ kind: "file" | "other" }> | null;

export type AgentBrowserConfigSeams = Readonly<{
  state: (path: string) => Promise<PathState>;
  readFile: (path: string) => Promise<string>;
  /** Writes `text` to a temporary file beside `path` (owner-only) and
   * returns it. */
  stage: (path: string, text: string) => Promise<string>;
  /** Puts the staged file at `path` only while nothing is there: an atomic
   * create that fails when the path exists. False when it does. */
  create: (staged: string, path: string) => Promise<boolean>;
  /** Puts the staged file over `path` (an atomic rename). */
  replace: (staged: string, path: string) => Promise<void>;
  discard: (staged: string) => Promise<void>;
}>;

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

export const defaultAgentBrowserConfigSeams: AgentBrowserConfigSeams = {
  state: async (path) => {
    try {
      const found = await lstat(path);
      return { kind: found.isFile() ? "file" : "other" };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  },
  readFile: (path) => readFile(path, "utf8"),
  stage: async (path, text) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staged = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(staged, text, { mode: 0o600, flag: "wx" });
    return staged;
  },
  create: async (staged, path) => {
    try {
      await link(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST")
        return false;
      throw error;
    } finally {
      await rm(staged, { force: true });
    }
    return true;
  },
  replace: (staged, path) => rename(staged, path),
  discard: (staged) => rm(staged, { force: true }),
};

/** agent-browser's user config file: `~/.agent-browser/config.json`. */
export function agentBrowserConfigPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const home = env.HOME;
  return home !== undefined && isAbsolute(home)
    ? join(home, ".agent-browser", "config.json")
    : undefined;
}

/** The config with the hour added, or the outcome that leaves it alone. */
function withIdleTimeout(
  text: string,
): Readonly<{ text: string }> | "kept" | "unreadable" {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "unreadable";
  const config = value as Record<string, unknown>;
  if (Object.hasOwn(config, "idleTimeout")) return "kept";
  return {
    text: `${JSON.stringify({ ...config, idleTimeout: agentBrowserIdleTimeout }, null, 2)}\n`,
  };
}

/** Makes sure agent-browser's user config names an idle timeout, losing
 * nothing of the person's:
 * - a missing file is created with only that setting, and only while it is
 *   still missing (an atomic create);
 * - a regular file with other settings keeps them all and gains
 *   `idleTimeout`, unless it changed since it was read, which is checked again
 *   right before the atomic rename;
 * - a file that names an idle timeout already is kept;
 * - a symbolic link, anything but a regular file, a file that cannot be read
 *   and one that is not a JSON object are left as they are. */
export async function ensureAgentBrowserIdleTimeout(
  env: Readonly<Record<string, string | undefined>>,
  seams: AgentBrowserConfigSeams = defaultAgentBrowserConfigSeams,
): Promise<AgentBrowserConfigOutcome> {
  const path = agentBrowserConfigPath(env);
  if (path === undefined) return "no-home";
  let state: PathState;
  try {
    state = await seams.state(path);
  } catch {
    return "unreadable";
  }
  if (state === null) {
    const staged = await seams.stage(
      path,
      `${JSON.stringify({ idleTimeout: agentBrowserIdleTimeout }, null, 2)}\n`,
    );
    return (await seams.create(staged, path)) ? "set" : "changed";
  }
  if (state.kind !== "file") return "not-a-file";
  let before: string;
  try {
    before = await seams.readFile(path);
  } catch {
    return "unreadable";
  }
  const next = withIdleTimeout(before);
  if (next === "kept" || next === "unreadable") return next;
  const staged = await seams.stage(path, next.text);
  try {
    const now = await seams.state(path);
    const unchanged =
      now?.kind === "file" && (await seams.readFile(path)) === before;
    if (!unchanged) {
      await seams.discard(staged);
      return "changed";
    }
  } catch {
    await seams.discard(staged);
    return "changed";
  }
  await seams.replace(staged, path);
  return "set";
}
