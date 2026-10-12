import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { replaceOwnerFile } from "./people/holds";

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

/** An hour without a command, as F47 point 5 counts on. */
export const agentBrowserIdleTimeout = "1h";

export type AgentBrowserConfigOutcome =
  /** The setting was written now. */
  | "set"
  /** The file names an idle timeout already: someone's explicit choice. */
  | "kept"
  /** The file exists but cannot be read, or is not a JSON object: left as it
   * is, never written over. */
  | "unreadable"
  /** No absolute HOME: no user config to write. */
  | "no-home";

export type AgentBrowserConfigSeams = Readonly<{
  readFile: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
}>;

const defaultSeams: AgentBrowserConfigSeams = {
  readFile: (path) => readFile(path, "utf8"),
  write: replaceOwnerFile,
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

/** Makes sure agent-browser's user config names an idle timeout. A missing file
 * is created with only that setting; a file with other settings keeps them all
 * and gains `idleTimeout`; a file that names one already is left alone, as is a
 * file that cannot be read or is not a JSON object. The write is atomic and
 * owner-only (`replaceOwnerFile`). */
export async function ensureAgentBrowserIdleTimeout(
  env: Readonly<Record<string, string | undefined>>,
  seams: AgentBrowserConfigSeams = defaultSeams,
): Promise<AgentBrowserConfigOutcome> {
  const path = agentBrowserConfigPath(env);
  if (path === undefined) return "no-home";
  let config: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = await seams.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT")
      return "unreadable";
  }
  if (text !== null) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return "unreadable";
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return "unreadable";
    config = value as Record<string, unknown>;
    if (Object.hasOwn(config, "idleTimeout")) return "kept";
  }
  await seams.write(
    path,
    `${JSON.stringify({ ...config, idleTimeout: agentBrowserIdleTimeout }, null, 2)}\n`,
  );
  return "set";
}
