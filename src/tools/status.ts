import { spawn } from "node:child_process";
import {
  access,
  constants,
  mkdtemp,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type SignInProbe, type ToolEntry, toolCatalog } from "./catalog";
import { ghStatus } from "./gh-status";
import { type SshStatus, sshStatus } from "./ssh-key";
import type { GhIdentity } from "./team-github";

/** A tool process with both streams captured, bounded, or "timeout". */
export type ToolProcessResult =
  | Readonly<{ exitCode: number; stdout: string; stderr: string }>
  | "timeout";
export type ToolRunner = (
  command: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
  /** `maxBytes`: the bound of each stream (default 256 KiB); a command
   * whose answer is a whole list (the vault's items) takes a larger one.
   * `stdin`: what the process reads on its standard input, which is then
   * closed; without it the process reads nothing. A value a command must
   * never see on its argv (a vault item, decision F54) goes here.
   * `cwd`: the directory it runs in; without it, this process's own. */
  options?: Readonly<{ maxBytes?: number; stdin?: string; cwd?: string }>,
) => Promise<ToolProcessResult>;

const maxStreamBytes = 256 * 1024;

async function readBounded(
  stream: NodeJS.ReadableStream,
  onOverflow: () => void,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maxBytes) {
      onOverflow();
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Runs one tool process as the current user with exactly the named
// environment; stdout and stderr are both kept (an installer's error is
// usually on stderr) and bounded. The child is the leader of its own process
// group (detached), so the timeout kills the whole group — an installer's
// helpers included — and nothing keeps writing after "timeout" was reported.
export const runTool: ToolRunner = async (command, timeoutMs, env, options) => {
  const maxBytes = options?.maxBytes ?? maxStreamBytes;
  const input = options?.stdin;
  const [executable, ...args] = command;
  if (!executable) throw new Error("A command is required");
  const child = spawn(executable, args, {
    env: { ...env },
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (input !== undefined && child.stdin !== null) {
    // A process that exits without reading all of it closes the pipe: that
    // is its answer to read, not an error of this runner.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  }
  const killAll = () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {}
    }
    child.kill("SIGKILL");
  };
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise<number>((resolve) => {
    child.once("close", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const finished = (async () => {
    await spawned;
    const [stdout, stderr] = await Promise.all([
      readBounded(child.stdout as NodeJS.ReadableStream, killAll, maxBytes),
      readBounded(child.stderr as NodeJS.ReadableStream, killAll, maxBytes),
    ]);
    return Object.freeze({ exitCode: await exited, stdout, stderr });
  })();
  try {
    const result = await Promise.race([finished, expired]);
    if (result === "timeout") {
      killAll();
      finished.catch(() => undefined);
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** `lazurio tools status`: the operator's tools as found on the operator's
 * PATH, each the first executable of its name (decision 0140 rule), with the
 * version the tool itself reports. Read-only; the version commands never use
 * the network (a sign-in probe may, and runs only through `toolsSignIn`);
 * versions are facts, not drift (decision 0161). */
export type ToolStatus = Readonly<{
  name: string;
  command: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  versionOutput?: string;
  versionError?: string;
  updater: "self" | "installer" | "curated" | "none";
  source: string;
  /** Decision 0161 point 6: the tool's PATH entry is `~/.local/bin/<name>`. */
  standardPath?: boolean;
}>;

export type ToolsStatusInput = Readonly<{
  path: string | undefined;
  home: string | undefined;
  platform: string;
  run: ToolRunner;
  catalog?: readonly ToolEntry[] | undefined;
}>;

export type ToolsStatusResult = Readonly<{
  kind: "tools-status";
  tools: readonly ToolStatus[];
}>;

const versionTimeoutMs = 15_000;

// The first executable of that name on PATH, in PATH order; on Windows also
// the PATHEXT-style suffixes a shell would try.
export async function resolveOnPath(
  command: string,
  path: string | undefined,
  platform: string,
): Promise<string | undefined> {
  const suffixes = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of (path ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (platform !== "win32") await access(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

// The version a tool reports: the first non-empty line, plus the first
// version-shaped token in it when there is one.
export function versionOf(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return undefined;
  // Only a version-shaped token is ever reported. A first line without one is
  // not echoed: a tool may print anything there, a secret included.
  const token = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
  return token ? token[0] : undefined;
}

/** One catalog tool as `toolsStatus` finds it: where it is on PATH and the
 * version its own command reports. Never throws. */
export async function toolStatus(
  entry: ToolEntry,
  input: Omit<ToolsStatusInput, "catalog">,
): Promise<ToolStatus> {
  const base = {
    name: entry.name,
    command: entry.command,
    updater: entry.updater.kind,
    source: entry.source,
  } as const;
  const path = await resolveOnPath(entry.command, input.path, input.platform);
  if (!path) return { ...base, installed: false };
  let resolved = path;
  try {
    resolved = await realpath(path);
  } catch {}
  // Exactly ~/.local/bin/<command> (plus a Windows launcher suffix), never a
  // deeper path that merely starts with it.
  const standardEntry = input.home
    ? join(input.home, ".local", "bin", entry.command)
    : undefined;
  const standardPath =
    standardEntry !== undefined &&
    (input.platform === "win32"
      ? ["", ".exe", ".cmd", ".bat"].some(
          (suffix) => path === `${standardEntry}${suffix}`,
        )
      : path === standardEntry);
  const found = {
    ...base,
    installed: true,
    path,
    realPath: resolved,
    standardPath,
  } as const;
  const env: Record<string, string> = {};
  if (input.path) env.PATH = input.path;
  if (input.home) env.HOME = input.home;
  // A tool that writes its store on every start (bw) gets a private
  // temporary data directory, so the probe touches no profile.
  let isolated: string | undefined;
  try {
    if (entry.isolatedData !== undefined) {
      isolated = await mkdtemp(join(tmpdir(), "lazurio-probe-"));
      env[entry.isolatedData] = isolated;
    }
    const result = await input.run(
      [path, ...entry.versionArgs],
      versionTimeoutMs,
      env,
    );
    if (result === "timeout")
      return { ...found, versionError: `timeout after ${versionTimeoutMs} ms` };
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0)
      return {
        ...found,
        versionOutput: output.slice(0, 400),
        versionError: `exit ${result.exitCode}`,
      };
    const version = versionOf(result.stdout) ?? versionOf(result.stderr);
    return {
      ...found,
      ...(version ? { version } : {}),
      versionOutput: output.slice(0, 400),
    };
  } catch (error) {
    return {
      ...found,
      versionError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (isolated !== undefined)
      await rm(isolated, { recursive: true, force: true });
  }
}

/** How many tools are read at once (plan DEV-6656): one after another was
 * too slow, and every tool at once would start several Node CLIs together,
 * a risk on an Environment with little memory left (decided on 2026-10-20). */
export const toolsReadAtOnce = 3;

/** `work` for every item, at most `limit` at a time, the answers in the
 * items' order: each item takes the next free place as one ends. */
export async function boundedAll<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane),
  );
  return answers;
}

/** Every catalog tool's status, in catalog order. At most `toolsReadAtOnce`
 * tools are read at a time (plan DEV-6656): each version command is its own
 * process with its own bound. */
export async function toolsStatus(
  input: ToolsStatusInput,
): Promise<ToolsStatusResult> {
  const tools = await boundedAll(
    input.catalog ?? toolCatalog,
    toolsReadAtOnce,
    (entry) => toolStatus(entry, input),
  );
  return { kind: "tools-status", tools };
}

/** Whether a tool is signed in, and as whom when the tool can tell (decision
 * F18, addendum 2026-09-27). `unknown`: not installed, no probe, a timeout, a
 * failure to run, or output the probe cannot read. */
export type ToolSignIn = Readonly<{
  state: "signed-in" | "signed-out" | "unknown";
  account?: string;
  organization?: string;
  /** gh signed in: whether this Machine's SSH key is on the account
   * (decision F19, addendum 2026-09-28). */
  ssh?: SshStatus;
  /** gh signed in: whether the active account is a person's stored sign-in,
   * a GitHub App's identity or a token from a variable (the Team rule of
   * `team-github.ts`). */
  identity?: GhIdentity;
}>;

export type ToolsSignInInput = Readonly<{
  path: string | undefined;
  home: string | undefined;
  /** The XDG base directories of the serving process, when it has them;
   * nothing else of its environment reaches a probe. */
  xdg?: Readonly<Record<string, string>> | undefined;
  run: ToolRunner;
}>;

const signInTimeoutMs = 10_000;
const labelLength = 120;

// A label for the page and the terminal: plain text without control or
// bidirectional formatting characters, trimmed, at most 120 code points.
export function signInLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = Array.from(
    value
      .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu, "")
      .trim(),
  )
    .slice(0, labelLength)
    .join("")
    .trim();
  return text.length === 0 ? undefined : text;
}

// The first JSON object or array the tool printed: the whole output, or else
// the first line that parses.
function jsonOf(output: string): unknown {
  const candidates = [output, ...output.split(/\r?\n/)];
  for (const candidate of candidates) {
    const text = candidate.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (value !== null && typeof value === "object") return value;
    } catch {}
  }
  return undefined;
}

// Own data only; a numeric segment indexes an array.
function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    const key =
      Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(segment)
        ? Number(segment)
        : segment;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** What one probe answer means. Pure: the raw output goes in and only the
 * state and the extracted labels come out. */
export function readSignIn(
  probe: SignInProbe,
  result: ToolProcessResult,
): ToolSignIn {
  if (result === "timeout") return { state: "unknown" };
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    probe.signedOut !== undefined &&
    new RegExp(probe.signedOut, "i").test(output)
  )
    return { state: "signed-out" };
  if (result.exitCode !== 0) return { state: "signed-out" };
  const account = probe.account;
  if (account === undefined) return { state: "signed-in" };
  if (account.kind === "regex") {
    const label = signInLabel(new RegExp(account.pattern).exec(output)?.[1]);
    return label === undefined
      ? { state: "signed-in" }
      : { state: "signed-in", account: label };
  }
  const document = jsonOf(result.stdout) ?? jsonOf(result.stderr);
  if (document === undefined) return { state: "unknown" };
  if (account.flag !== undefined && at(document, account.flag) !== true)
    return { state: "signed-out" };
  let subject: unknown = document;
  if (account.list !== undefined) {
    const list = account.list
      .map((path) => at(document, path))
      .find((value) => Array.isArray(value));
    // A shape the probe does not know: the exit code decided, no label.
    if (!Array.isArray(list)) return { state: "signed-in" };
    if (list.length === 0) return { state: "signed-out" };
    subject = list[0];
  }
  const label = account.paths
    .map((path) => signInLabel(at(subject, path)))
    .find((value) => value !== undefined);
  if (label === undefined)
    return account.requireAccount === true
      ? { state: "signed-out" }
      : { state: "signed-in" };
  const organization =
    account.organization === undefined
      ? undefined
      : signInLabel(at(subject, account.organization));
  return {
    state: "signed-in",
    account: label,
    ...(organization === undefined ? {} : { organization }),
  };
}

/** The sign-in of every given tool that is installed and has a probe, all
 * probes in parallel, each bounded by 10 s, with only PATH, HOME and the XDG
 * base directories in its environment. A probe may contact the tool's
 * provider, so callers run this only on an explicit request. The raw output
 * of a probe is never returned or logged. A signed-in gh also says whether
 * this Machine's SSH key is on the account: the key's `.pub` file and one
 * call of the account's key list, never the private key and no SSH
 * connection (that proof belongs to the sign-in and "Link SSH key"). */
export async function toolsSignIn(
  tools: readonly Readonly<{
    probe: SignInProbe | undefined;
    status: ToolStatus;
  }>[],
  input: ToolsSignInInput,
): Promise<readonly ToolSignIn[]> {
  const env: Record<string, string> = {};
  if (input.path) env.PATH = input.path;
  if (input.home) env.HOME = input.home;
  for (const [name, value] of Object.entries(input.xdg ?? {}))
    if (/^XDG_[A-Z_]+$/.test(name) && value) env[name] = value;
  return Promise.all(
    tools.map(async ({ probe, status }): Promise<ToolSignIn> => {
      if (probe === undefined || !status.installed || status.path === undefined)
        return { state: "unknown" };
      try {
        const run = (command: readonly string[], timeoutMs: number) =>
          input.run(command, timeoutMs, env);
        if (status.name !== "gh")
          return readSignIn(
            probe,
            await input.run([status.path, ...probe.argv], signInTimeoutMs, env),
          );
        // gh: the JSON status first, the text form of its probe for an
        // older gh (gh-status.ts).
        const { signIn, scopes } = await ghStatus(
          run,
          status.path,
          signInTimeoutMs,
        );
        if (signIn.state !== "signed-in") return signIn;
        const ssh = await sshStatus(input.home, status.path, scopes, run).catch(
          (): SshStatus => ({ state: "unknown", reason: "unreadable" }),
        );
        return { ...signIn, ssh };
      } catch {
        return { state: "unknown" };
      }
    }),
  );
}

// The XDG base directories of an environment, for `toolsSignIn`.
export function xdgOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const xdg: Record<string, string> = {};
  for (const [name, value] of Object.entries(env))
    if (/^XDG_[A-Z_]+$/.test(name) && value) xdg[name] = value;
  return xdg;
}
