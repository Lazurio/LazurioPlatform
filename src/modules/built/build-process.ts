import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

// The build script of a static app, run in the background of the people who
// work in the Environment (decision F58, root decision 0195 point 19): with
// a low priority and, under the user service manager, a bound on its memory
// and time, its output into the build's log. One build runs at a time
// (`builds.ts` holds the lock); this only runs one.
//
// Linux with the user service manager: a transient unit of its own, so that
// the kernel bounds it (CPUWeight and IOWeight low, nice 10, MemoryMax, its
// own control group, which the manager kills at RuntimeMaxSec), and a build
// that grows is the first thing the kernel's OOM killer takes, before any
// module or the browser. Elsewhere (macOS): a child in its own process group
// at nice 10, whose group is ended at the deadline.

export type BuildProcessOutcome = Readonly<
  | { kind: "exited"; code: number }
  | { kind: "timed-out" }
  | { kind: "cancelled" }
  | { kind: "launch-failed" }
>;

export type BuildProcessInput = Readonly<{
  runner: "systemd-user" | "session";
  /** `XDG_RUNTIME_DIR` of the user manager (systemd-user only). */
  runtimeDirectory?: string | undefined;
  /** The Bun the app pins, its runtime (decision F62): the user's when it
   * is that version. */
  executable: string;
  /** The app's package directory. */
  cwd: string;
  script: string;
  env: Readonly<Record<string, string>>;
  /** The build's log, created or truncated. */
  log: string;
  timeoutMs: number;
  signal: AbortSignal;
}>;

/** The bounds of one build (decision F58). */
export const buildTimeoutMs = 600_000;
export const buildMemoryMax = "2G";
/** Above the browser's tabs (300), the browser (250) and modules (220): a
 * build is retried later; what people use is not. */
const buildOomScoreAdjust = 400;
const systemdRun = "/usr/bin/systemd-run";
const systemctl = "/usr/bin/systemctl";
const nice = "/usr/bin/nice";

const managerEnvironment = (runtimeDirectory: string) => ({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  XDG_RUNTIME_DIR: runtimeDirectory,
});

function managerCall(runtimeDirectory: string, args: string[]) {
  return new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      systemctl,
      args,
      {
        env: managerEnvironment(runtimeDirectory),
        timeout: 20_000,
        killSignal: "SIGKILL",
        maxBuffer: 256 * 1024,
        encoding: "utf8",
      },
      (error, stdout) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
        }),
    );
  });
}

function validate(input: BuildProcessInput) {
  const texts = [input.executable, input.cwd, input.script, input.log];
  for (const [name, value] of Object.entries(input.env))
    texts.push(name, value);
  if (
    !isAbsolute(input.executable) ||
    !isAbsolute(input.cwd) ||
    !isAbsolute(input.log) ||
    !/^[A-Za-z][A-Za-z0-9:_-]*$/.test(input.script) ||
    texts.some((value) => /[\0\n\r]/.test(value)) ||
    // The manager would expand `$NAME` in a command line.
    [input.executable, input.cwd].some((value) => value.includes("$")) ||
    !Object.keys(input.env).every((name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ) ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > buildTimeoutMs
  )
    throw new Error("Bounded build process required");
}

export async function runBuildProcess(
  input: BuildProcessInput,
): Promise<BuildProcessOutcome> {
  validate(input);
  if (input.signal.aborted)
    return Object.freeze({ kind: "cancelled" as const });
  const log = await open(input.log, "w", 0o600);
  try {
    return input.runner === "systemd-user"
      ? await underManager(input, log.fd)
      : await inSession(input, log.fd);
  } finally {
    await log.close();
  }
}

async function underManager(
  input: BuildProcessInput,
  fd: number,
): Promise<BuildProcessOutcome> {
  const runtimeDirectory = input.runtimeDirectory;
  if (runtimeDirectory === undefined || !isAbsolute(runtimeDirectory))
    return Object.freeze({ kind: "launch-failed" as const });
  // Nothing of the manager's own environment (session sockets, display,
  // credentials) reaches the build: only what the build is given.
  const shown = await managerCall(runtimeDirectory, [
    "--user",
    "show-environment",
  ]);
  if (shown.code !== 0)
    return Object.freeze({ kind: "launch-failed" as const });
  const unset = shown.stdout
    .split("\n")
    .map((line) => line.slice(0, Math.max(0, line.indexOf("="))))
    .filter(
      (name) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        !Object.hasOwn(input.env, name),
    )
    .sort();
  const unit = `lazurio-build-${randomBytes(8).toString("hex")}.service`;
  const seconds = Math.ceil(input.timeoutMs / 1000);
  const argv = [
    "--user",
    "--quiet",
    "--no-ask-password",
    "--wait",
    "--pipe",
    "--collect",
    `--unit=${unit}`,
    "--service-type=exec",
    `--working-directory=${input.cwd}`,
    "--nice=10",
    "--property=CPUWeight=20",
    "--property=IOWeight=20",
    `--property=MemoryMax=${buildMemoryMax}`,
    `--property=RuntimeMaxSec=${seconds}s`,
    "--property=KillMode=control-group",
    "--property=UMask=0077",
    `--property=OOMScoreAdjust=${buildOomScoreAdjust}`,
    ...Object.entries(input.env).map(
      ([name, value]) => `--setenv=${name}=${value}`,
    ),
    ...(unset.length ? [`--property=UnsetEnvironment=${unset.join(" ")}`] : []),
    "--",
    input.executable,
    "--no-env-file",
    "run",
    input.script,
  ];
  const started = performance.now();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([systemdRun, ...argv], {
      env: managerEnvironment(runtimeDirectory),
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
  } catch {
    return Object.freeze({ kind: "launch-failed" as const });
  }
  let cancelled = false;
  const stop = () => {
    void managerCall(runtimeDirectory, ["--user", "stop", unit]);
  };
  const abort = () => {
    cancelled = true;
    stop();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  // The manager ends the unit at RuntimeMaxSec; this is the backstop.
  const backstop = setTimeout(stop, input.timeoutMs + 15_000);
  try {
    const code = await child.exited;
    if (cancelled) return Object.freeze({ kind: "cancelled" as const });
    if (performance.now() - started >= input.timeoutMs)
      return Object.freeze({ kind: "timed-out" as const });
    return Object.freeze({ kind: "exited" as const, code });
  } finally {
    clearTimeout(backstop);
    input.signal.removeEventListener("abort", abort);
  }
}

async function inSession(
  input: BuildProcessInput,
  fd: number,
): Promise<BuildProcessOutcome> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(
      [
        nice,
        "-n",
        "10",
        input.executable,
        "--no-env-file",
        "run",
        input.script,
      ],
      {
        cwd: input.cwd,
        env: { ...input.env },
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        // Its own process group, ended as a whole.
        detached: true,
      },
    );
  } catch {
    return Object.freeze({ kind: "launch-failed" as const });
  }
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* the group is gone */
    }
  };
  let ending: "timed-out" | "cancelled" | null = null;
  let hard: ReturnType<typeof setTimeout> | undefined;
  const end = (reason: "timed-out" | "cancelled") => {
    if (ending !== null) return;
    ending = reason;
    group("SIGTERM");
    hard = setTimeout(() => group("SIGKILL"), 10_000);
  };
  const abort = () => end("cancelled");
  input.signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => end("timed-out"), input.timeoutMs);
  try {
    const code = await child.exited;
    if (ending !== null) return Object.freeze({ kind: ending });
    return Object.freeze({ kind: "exited" as const, code });
  } finally {
    clearTimeout(deadline);
    clearTimeout(hard);
    input.signal.removeEventListener("abort", abort);
    // What the script left running in its group ends with the build.
    group("SIGKILL");
  }
}
