import { isAbsolute } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { array, object } from "./manifest";

type StopResult = Readonly<
  | { kind: "group-stopped"; forced: boolean; exitCode: number }
  | {
      kind: "incomplete";
      reason: "signal-failed" | "exit-not-confirmed" | "launcher-exited";
    }
>;

// A platform adapter, not a service/registry. Only the future single lifecycle
// owner may retain these handles after verifying the caller's actual mandate.
export async function startOwnedProcess(input: unknown) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unqualified process platform");
  const value = object(input, ["executable", "args", "cwd", "env"]);
  const string = (value: unknown) => {
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error("Invalid process input");
    return value;
  };
  const executable = string(value.executable);
  const cwd = string(value.cwd);
  const args = array(value.args).map(string);
  if (!isAbsolute(executable))
    throw new Error("Explicit executable path required");
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env))
    throw new Error("Explicit environment required");
  const env: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(value.env)) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error("Invalid environment key");
    const entry = Object.getOwnPropertyDescriptor(value.env, key);
    if (!entry || !("value" in entry))
      throw new Error("Environment values must be data");
    env[key] = string(entry.value);
  }
  await inspectOwnedDirectory(cwd);
  const child = Bun.spawn([executable, ...args], {
    cwd,
    env,
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const group = child.pid;
  if (!Number.isSafeInteger(group) || group <= 1) {
    child.kill();
    throw new Error("Invalid spawned process group");
  }
  let exitCode: number | null = null;
  let signalingRetired = false;
  void child.exited.then((code) => {
    exitCode = code;
    signalingRetired = true;
  });
  let retired = false;
  let pending: Promise<StopResult> | null = null;

  function groupPresent() {
    if (retired) return false;
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        throw new Error("Process group inspection failed");
      retired = true;
      return false;
    }
  }
  async function awaitGone(duration: number) {
    const deadline = performance.now() + duration;
    do {
      if (!groupPresent() && exitCode !== null) return true;
      await Bun.sleep(Math.min(20, Math.max(1, deadline - performance.now())));
    } while (performance.now() < deadline);
    return !groupPresent() && exitCode !== null;
  }
  function signal(signal: "SIGTERM" | "SIGKILL") {
    if (!groupPresent()) return;
    // An old numeric PGID is not a durable identity. Check the live subprocess
    // state as well as the exit callback before *each* destructive signal.
    if (
      signalingRetired ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      signalingRetired = true;
      throw new Error("launcher-exited");
    }
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        throw new Error("Process group signal failed");
      retired = true;
    }
  }
  async function stopGroup(graceMs: number): Promise<StopResult> {
    try {
      signal("SIGTERM");
      if (await awaitGone(graceMs))
        return Object.freeze({
          kind: "group-stopped",
          forced: false,
          exitCode: exitCode as number,
        });
      signal("SIGKILL");
      if (await awaitGone(1500))
        return Object.freeze({
          kind: "group-stopped",
          forced: true,
          exitCode: exitCode as number,
        });
      return Object.freeze({
        kind: "incomplete",
        reason: "exit-not-confirmed",
      });
    } catch (error) {
      return Object.freeze({
        kind: "incomplete",
        reason:
          error instanceof Error && error.message === "launcher-exited"
            ? "launcher-exited"
            : "signal-failed",
      });
    }
  }
  return Object.freeze({
    // Observability only. There is deliberately no stop(pid) or restore(pid).
    pid: child.pid,
    group,
    inspect() {
      const present = groupPresent();
      return Object.freeze({
        groupPresent: present,
        launcherExited: exitCode !== null,
        exitCode,
        stopping: pending !== null,
      });
    },
    stop(graceMs = 1500): Promise<StopResult> {
      if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 10_000)
        return Promise.reject(new Error("Bounded stop grace required"));
      if (pending) return pending;
      pending = stopGroup(graceMs).finally(() => {
        pending = null;
      });
      return pending;
    },
  });
}
