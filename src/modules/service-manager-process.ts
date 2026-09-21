import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export type ServiceManagerProgram = "systemctl" | "systemd-run" | "busctl";
export type ServiceManagerProcess = (
  program: ServiceManagerProgram,
  args: readonly string[],
  options: Readonly<{ timeoutMs: number }>,
) => Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>;

const executables: Readonly<Record<ServiceManagerProgram, string>> = {
  systemctl: "/usr/bin/systemctl",
  "systemd-run": "/usr/bin/systemd-run",
  // Read-only here: the manager's D-Bus properties as JSON, for the values that
  // `systemctl show` cannot render faithfully (argument and environment vectors).
  busctl: "/usr/bin/busctl",
};

// The only place that executes the service manager's tools: fixed absolute
// executables, argv arrays (never a shell), a sanitized environment that carries
// nothing but the user manager's location, bounded time and bounded output.
export function createServiceManagerProcess(
  runtimeDirectory: string,
): ServiceManagerProcess {
  if (!/^\/[^\0\n]*$/.test(runtimeDirectory))
    throw new Error("Absolute user runtime directory required");
  return (program, args, options) => {
    if (
      !Object.hasOwn(executables, program) ||
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 60_000 ||
      args.some((value) => typeof value !== "string" || value.includes("\0"))
    )
      throw new Error("Bounded service manager invocation required");
    return new Promise((resolve) => {
      execFile(
        executables[program],
        [...args],
        {
          env: {
            PATH: "/usr/bin:/bin",
            LC_ALL: "C",
            XDG_RUNTIME_DIR: runtimeDirectory,
          },
          timeout: options.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
        },
        (error, stdout, stderr) => {
          const failure = error as
            | (NodeJS.ErrnoException & { killed?: boolean })
            | null;
          resolve(
            Object.freeze({
              // A timeout, spawn failure or oversized output is never an exit code.
              code: !failure
                ? 0
                : typeof failure.code === "number" && !failure.killed
                  ? failure.code
                  : null,
              stdout: String(stdout),
              stderr: String(stderr),
            }),
          );
        },
      );
    });
  };
}

// State of the user service manager, or null when it does not answer.
export async function userManagerState(run: ServiceManagerProcess) {
  try {
    const result = await run("systemctl", ["--user", "is-system-running"], {
      timeoutMs: 5000,
    });
    // The exit code is non-zero for every state but `running`; the word is the answer.
    const state = result.stdout.trim();
    return result.code !== null && /^[a-z]+$/.test(state) ? state : null;
  } catch {
    return null;
  }
}

// Control group of a live process as the kernel reports it (cgroup v2, or the
// systemd hierarchy on a hybrid host). Null when it cannot be read.
export async function readProcessControlGroup(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const text = await readFile(`/proc/${pid}/cgroup`, "utf8");
    for (const line of text.split("\n")) {
      const unified = /^0::(\/.*)$/.exec(line);
      if (unified) return unified[1] as string;
      const named = /^\d+:name=systemd:(\/.*)$/.exec(line);
      if (named) return named[1] as string;
    }
    return null;
  } catch {
    return null;
  }
}

// True only when the kernel reports no process in the control group, or the
// group no longer exists. Unreadable evidence is never "empty".
export async function isControlGroupEmpty(controlGroup: string) {
  if (
    !controlGroup.startsWith("/") ||
    controlGroup.split("/").includes("..") ||
    controlGroup.includes("\0")
  )
    return false;
  try {
    // `populated` is hierarchical: it also covers every descendant group.
    const text = await readFile(
      `/sys/fs/cgroup${controlGroup}/cgroup.events`,
      "utf8",
    );
    return /^populated 0$/m.test(text);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
