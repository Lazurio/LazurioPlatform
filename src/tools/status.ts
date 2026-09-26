import { spawn } from "node:child_process";
import { access, constants, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type ToolEntry, toolCatalog } from "./catalog";

/** A tool process with both streams captured, bounded, or "timeout". */
export type ToolProcessResult =
  | Readonly<{ exitCode: number; stdout: string; stderr: string }>
  | "timeout";
export type ToolRunner = (
  command: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>>,
) => Promise<ToolProcessResult>;

const maxStreamBytes = 256 * 1024;

async function readBounded(
  stream: NodeJS.ReadableStream,
  onOverflow: () => void,
): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maxStreamBytes) {
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
export const runTool: ToolRunner = async (command, timeoutMs, env) => {
  const [executable, ...args] = command;
  if (!executable) throw new Error("A command is required");
  const child = spawn(executable, args, {
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
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
      readBounded(child.stdout as NodeJS.ReadableStream, killAll),
      readBounded(child.stderr as NodeJS.ReadableStream, killAll),
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
 * version the tool itself reports. Read-only; never the network; versions are
 * facts, not drift (decision 0161). */
export type ToolStatus = Readonly<{
  name: string;
  command: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  versionOutput?: string;
  versionError?: string;
  updater: "self" | "installer" | "none";
  source: string;
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
  const token = line.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
  return token ? token[0] : line;
}

export async function toolsStatus(
  input: ToolsStatusInput,
): Promise<ToolsStatusResult> {
  const tools: ToolStatus[] = [];
  for (const entry of input.catalog ?? toolCatalog) {
    const base = {
      name: entry.name,
      command: entry.command,
      updater: entry.updater.kind,
      source: entry.source,
    } as const;
    const path = await resolveOnPath(entry.command, input.path, input.platform);
    if (!path) {
      tools.push({ ...base, installed: false });
      continue;
    }
    let resolved = path;
    try {
      resolved = await realpath(path);
    } catch {}
    const env: Record<string, string> = {};
    if (input.path) env.PATH = input.path;
    if (input.home) env.HOME = input.home;
    try {
      const result = await input.run(
        [path, ...entry.versionArgs],
        versionTimeoutMs,
        env,
      );
      if (result === "timeout") {
        tools.push({
          ...base,
          installed: true,
          path,
          realPath: resolved,
          versionError: `timeout after ${versionTimeoutMs} ms`,
        });
        continue;
      }
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.exitCode !== 0) {
        tools.push({
          ...base,
          installed: true,
          path,
          realPath: resolved,
          versionOutput: output.slice(0, 400),
          versionError: `exit ${result.exitCode}`,
        });
        continue;
      }
      const version = versionOf(result.stdout) ?? versionOf(result.stderr);
      tools.push({
        ...base,
        installed: true,
        path,
        realPath: resolved,
        ...(version ? { version } : {}),
        versionOutput: output.slice(0, 400),
      });
    } catch (error) {
      tools.push({
        ...base,
        installed: true,
        path,
        realPath: resolved,
        versionError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { kind: "tools-status", tools };
}
