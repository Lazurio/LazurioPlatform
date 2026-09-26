import { access, constants, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ProcessRunner } from "../update/self-check";
import { type ToolEntry, toolCatalog } from "./catalog";

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
  run: ProcessRunner;
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
      const output = result.stdout.trim();
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
      const version = versionOf(result.stdout);
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
