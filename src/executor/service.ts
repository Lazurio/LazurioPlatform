import { mkdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { ToolRunner } from "../tools/status";
import { writeDurableFile } from "../update/durable-file";
import { executorPort, executorUnit } from "./pin";

// The Executor service of a Remote Environment (decision F44): Executor's own
// systemd user unit, which `executor install` writes, enables and starts
// (`sh.executor.daemon.service`: `<program> daemon run --foreground --port
// 4789 --hostname 127.0.0.1`, data in `~/.executor`), plus one drop-in of
// Lazurio's that keeps analytics and the check for a newer version off for
// the daemon. The unit file is Executor's and Lazurio never writes it; the
// drop-in `lazurio.conf` is Lazurio's. Nothing here ever stops a service
// that runs the pinned program and answers, and nothing changes lingering:
// `executor install` asks for it itself, best effort, and the Machine
// enables it for its operator.

/** Where `executor install` writes its unit: `~/.config/systemd/user`, not
 * `$XDG_CONFIG_HOME` (`systemdUnitDir` of v1.6.10). */
export const executorUnitDirectory = (home: string) =>
  join(home, ".config", "systemd", "user");
export const executorDropInDirectory = (home: string) =>
  join(executorUnitDirectory(home), `${executorUnit}.d`);
export const executorDropInName = "lazurio.conf";

/** The text of Lazurio's drop-in: the two variables of the root runbook. */
export function executorDropIn(): string {
  return [
    "# Written by Lazurio (decision F44) and rewritten by it; the unit itself is Executor's (executor install).",
    "[Service]",
    "Environment=EXECUTOR_DISABLE_ANALYTICS=1",
    "Environment=EXECUTOR_DISABLE_UPDATE_CHECK=1",
    "",
  ].join("\n");
}

/** The service's command line, as `executor install` writes it for the
 * program it runs from. */
export const serviceCommand = (binary: string) =>
  Object.freeze([
    binary,
    "daemon",
    "run",
    "--foreground",
    "--port",
    String(executorPort),
    "--hostname",
    "127.0.0.1",
  ]);

/** The arguments of a unit's `ExecStart=` as systemd reads Executor's form:
 * bare words, or double-quoted words with C escapes. Null for anything
 * else. */
export function parseExecStart(unitText: string): readonly string[] | null {
  const line = unitText
    .split("\n")
    .find((entry) => entry.startsWith("ExecStart="));
  if (line === undefined) return null;
  const value = line.slice("ExecStart=".length);
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === " ") {
      index++;
      continue;
    }
    if (value[index] === '"') {
      let word = "";
      index++;
      for (;;) {
        const character = value[index];
        if (character === undefined) return null;
        index++;
        if (character === '"') break;
        if (character === "\\") {
          const escaped = value[index];
          index++;
          if (escaped === "n") word += "\n";
          else if (escaped === "r") word += "\r";
          else if (escaped === "t") word += "\t";
          else if (escaped === "\\" || escaped === '"') word += escaped;
          else return null;
        } else word += character;
      }
      words.push(word);
      continue;
    }
    const end = value.indexOf(" ", index);
    words.push(value.slice(index, end === -1 ? value.length : end));
    index = end === -1 ? value.length : end;
  }
  return words;
}

export type ExecutorServiceFacts = Readonly<{
  /** `pinned`: the unit runs exactly `binary` as Executor writes it;
   * `other`: a unit that runs something else. */
  unit: "absent" | "pinned" | "other";
  active:
    | "active"
    | "activating"
    | "reloading"
    | "inactive"
    | "failed"
    | "deactivating"
    | "unknown";
  /** Whether the unit is enabled to start with the user manager. */
  enabled: boolean | null;
  /** Lazurio's drop-in. */
  settings: "current" | "missing" | "different";
  linger: "yes" | "no" | "unknown";
  /** Whether `GET http://127.0.0.1:4789/api/health` answers `ok`. */
  answering: boolean;
}>;

export type ServiceInput = Readonly<{
  home: string;
  /** The variables a user-manager client needs (XDG_RUNTIME_DIR,
   * DBUS_SESSION_BUS_ADDRESS); nothing else of it is passed on. */
  env: Readonly<Record<string, string | undefined>>;
  run: ToolRunner;
  /** The pinned program the service is to run. */
  binary: string;
  /** For the lingering report; this process's when absent. */
  uid?: number | undefined;
  /** Test seam: the loopback health probe. */
  probe?: (() => Promise<boolean>) | undefined;
  /** How long a (re)started service has to answer (default 30 s). */
  healthDeadlineMs?: number | undefined;
  pollMs?: number | undefined;
}>;

const systemctlTimeoutMs = 60_000;
const installTimeoutMs = 120_000;

function managerEnvironment(input: ServiceInput): Record<string, string> {
  const env: Record<string, string> = { HOME: input.home };
  for (const name of ["PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    const value = input.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function systemctl(
  input: ServiceInput,
  ...args: string[]
): Promise<Readonly<{ ok: boolean; stdout: string }>> {
  const result = await input
    .run(
      ["systemctl", "--user", ...args],
      systemctlTimeoutMs,
      managerEnvironment(input),
    )
    .catch(() => "timeout" as const);
  return result === "timeout"
    ? { ok: false, stdout: "" }
    : { ok: result.exitCode === 0, stdout: result.stdout };
}

/** `GET /api/health` on Executor's loopback port, past any HTTP proxy of
 * the process environment (Bun's fetch would take HTTP_PROXY even for
 * 127.0.0.1): Executor answers `ok` without a credential, and none is ever
 * sent. */
export function executorHealth(timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const call = request(
      {
        host: "127.0.0.1",
        port: executorPort,
        path: "/api/health",
        method: "GET",
        timeout: timeoutMs,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64) call.destroy();
        });
        response.on("end", () =>
          resolve(response.statusCode === 200 && body.trim() === "ok"),
        );
        response.on("error", () => resolve(false));
      },
    );
    call.on("timeout", () => call.destroy());
    call.on("error", () => resolve(false));
    call.end();
  });
}

const activeStates = [
  "active",
  "activating",
  "reloading",
  "inactive",
  "failed",
  "deactivating",
] as const;

/** Read-only: the unit file, the manager's view of it, Lazurio's drop-in,
 * lingering and the loopback answer. Null when the user manager cannot be
 * asked. */
export async function observeExecutorService(
  input: ServiceInput,
): Promise<ExecutorServiceFacts | null> {
  const shown = await systemctl(
    input,
    "show",
    "--property=LoadState,ActiveState,UnitFileState",
    "--",
    executorUnit,
  );
  if (!shown.ok) return null;
  const properties = new Map<string, string>();
  for (const line of shown.stdout.split("\n")) {
    const split = line.indexOf("=");
    if (split > 0) properties.set(line.slice(0, split), line.slice(split + 1));
  }
  const text = await readFile(
    join(executorUnitDirectory(input.home), executorUnit),
    "utf8",
  ).catch(() => null);
  const command = text === null ? null : parseExecStart(text);
  const wanted = serviceCommand(input.binary);
  const unit =
    text === null
      ? ("absent" as const)
      : command !== null &&
          command.length === wanted.length &&
          command.every((word, index) => word === wanted[index])
        ? ("pinned" as const)
        : ("other" as const);
  const state = properties.get("ActiveState");
  const active =
    properties.get("LoadState") === "not-found"
      ? ("inactive" as const)
      : (activeStates as readonly string[]).includes(state ?? "")
        ? (state as (typeof activeStates)[number])
        : ("unknown" as const);
  const fileState = properties.get("UnitFileState") ?? "";
  const enabled =
    fileState === ""
      ? null
      : ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(
          fileState,
        );
  const dropIn = await readFile(
    join(executorDropInDirectory(input.home), executorDropInName),
    "utf8",
  ).catch(() => null);
  const settings =
    dropIn === null
      ? ("missing" as const)
      : dropIn === executorDropIn()
        ? ("current" as const)
        : ("different" as const);
  return Object.freeze({
    unit,
    active,
    enabled,
    settings,
    linger: await linger(input),
    answering: await (input.probe ?? executorHealth)(),
  });
}

async function linger(input: ServiceInput): Promise<"yes" | "no" | "unknown"> {
  const uid = input.uid ?? process.getuid?.();
  if (uid === undefined) return "unknown";
  const result = await input
    .run(
      ["loginctl", "show-user", String(uid), "--property=Linger", "--value"],
      systemctlTimeoutMs,
      managerEnvironment(input),
    )
    .catch(() => "timeout" as const);
  if (result === "timeout" || result.exitCode !== 0) return "unknown";
  const value = result.stdout.trim();
  return value === "yes" || value === "no" ? value : "unknown";
}

export type ServiceStep =
  | "user-manager"
  | "settings"
  | "reload"
  | "stop"
  | "install"
  | "enable"
  | "start"
  | "restart"
  | "health";

export type ServiceOutcome =
  | Readonly<{
      kind: "running";
      /** What this run did to the service. */
      change: "none" | "started" | "restarted" | "installed";
    }>
  | Readonly<{ kind: "failed"; step: ServiceStep; reason: string }>;

const failed = (step: ServiceStep, reason: string): ServiceOutcome =>
  Object.freeze({ kind: "failed", step, reason });

/** The environment of `executor install`: the operator's standard tool path
 * (the unit keeps the PATH it was installed with) and both switches off;
 * nothing else of the caller's. */
function installEnvironment(input: ServiceInput): Record<string, string> {
  return {
    ...managerEnvironment(input),
    PATH: `${input.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    EXECUTOR_DISABLE_ANALYTICS: "1",
    EXECUTOR_DISABLE_UPDATE_CHECK: "1",
  };
}

async function writeDropIn(input: ServiceInput): Promise<boolean> {
  const directory = executorDropInDirectory(input.home);
  const current = await readFile(
    join(directory, executorDropInName),
    "utf8",
  ).catch(() => null);
  if (current === executorDropIn()) return false;
  // The user's own directories are created, never re-moded.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeDurableFile(
    directory,
    executorDropInName,
    Buffer.from(executorDropIn()),
  );
  return true;
}

/** The service as Lazurio needs it: Lazurio's drop-in in place (written
 * first, so a first start already has it), the unit running the pinned
 * program (`executor install` when it does not: a version switch, a unit of
 * another program; a running one of those is stopped first, because
 * `executor install` neither restarts it nor finishes while another version
 * answers), enabled, started when it is not, restarted only when the drop-in
 * changed or it does not answer, and answering on 127.0.0.1:4789. */
export async function ensureExecutorService(
  input: ServiceInput,
): Promise<ServiceOutcome> {
  const before = await observeExecutorService({
    ...input,
    // The answer is asked below, when it matters.
    probe: async () => false,
  });
  if (before === null) return failed("user-manager", "unreachable");
  let changed: boolean;
  try {
    changed = await writeDropIn(input);
  } catch {
    return failed("settings", "write-failed");
  }
  const running = ["active", "activating", "reloading"].includes(before.active);
  let change: "none" | "started" | "restarted" | "installed" = "none";
  if (before.unit !== "pinned") {
    if (running || before.active === "deactivating") {
      if (!(await systemctl(input, "stop", executorUnit)).ok)
        return failed("stop", "refused");
    }
    const result = await input
      .run(
        [input.binary, "install"],
        installTimeoutMs,
        installEnvironment(input),
      )
      .catch(() => "timeout" as const);
    if (result === "timeout") return failed("install", "timeout");
    if (result.exitCode !== 0)
      return failed("install", `exit-${result.exitCode}`);
    const after = await readFile(
      join(executorUnitDirectory(input.home), executorUnit),
      "utf8",
    ).catch(() => null);
    const command = after === null ? null : parseExecStart(after);
    const wanted = serviceCommand(input.binary);
    if (
      command === null ||
      command.length !== wanted.length ||
      command.some((word, index) => word !== wanted[index])
    )
      return failed("install", "unit-unexpected");
    change = "installed";
  } else {
    if (changed && !(await systemctl(input, "daemon-reload")).ok)
      return failed("reload", "refused");
    if (
      before.enabled === false &&
      !(await systemctl(input, "enable", executorUnit)).ok
    )
      return failed("enable", "refused");
    if (changed && running) {
      if (!(await systemctl(input, "restart", executorUnit)).ok)
        return failed("restart", "refused");
      change = "restarted";
    } else if (!running) {
      await systemctl(input, "reset-failed", executorUnit);
      if (!(await systemctl(input, "start", executorUnit)).ok)
        return failed("start", "refused");
      change = "started";
    }
  }
  const probe = input.probe ?? executorHealth;
  if (change === "none") {
    if (await probe()) return Object.freeze({ kind: "running", change });
    // Active and silent: a hung daemon is restarted once.
    if (!(await systemctl(input, "restart", executorUnit)).ok)
      return failed("restart", "refused");
    change = "restarted";
  }
  const deadline = performance.now() + (input.healthDeadlineMs ?? 30_000);
  for (;;) {
    if (await probe()) return Object.freeze({ kind: "running", change });
    if (performance.now() >= deadline) return failed("health", "not-answering");
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 500));
  }
}
