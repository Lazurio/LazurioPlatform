import { isAbsolute } from "node:path";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { parseHealthListener, probeListenerHealth } from "./health";
import {
  compareListenerGroup,
  observeListenerBindings,
} from "./listener-ownership";
import { object } from "./manifest";
import { processGuardCommand } from "./process-guard";
import { parseProcessLaunch } from "./process-launch";

type StartResult = Readonly<
  { kind: "started"; pid: number } | { kind: "failed" }
>;
type StopResult = Readonly<{ kind: "group-stopped" } | { kind: "incomplete" }>;

export async function startGuardedProcess(
  input: unknown,
  platformExecutable: string,
) {
  if (
    !["darwin", "linux"].includes(process.platform) ||
    !isAbsolute(platformExecutable)
  )
    throw new Error("Explicit POSIX Platform executable required");
  const config = parseProcessLaunch(input);
  const request = `${JSON.stringify(config)}\n`;
  if (Buffer.byteLength(request) > 65_536)
    throw new Error("Launch request too large");
  await inspectOwnedDirectory(config.cwd);
  const guard = Bun.spawn([platformExecutable, processGuardCommand], {
    cwd: config.cwd,
    env: {},
    detached: true,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  let appExited: number | null = null;
  let startupResolved = false;
  let appStarted = false;
  let resolveStartup: (value: StartResult) => void = () => {};
  const started = new Promise<StartResult>((resolve) => {
    resolveStartup = resolve;
  });
  function startup(value: StartResult) {
    if (startupResolved) return;
    startupResolved = true;
    appStarted = value.kind === "started";
    clearTimeout(startTimer);
    resolveStartup(Object.freeze(value));
  }
  function closeControl() {
    try {
      guard.stdin.end();
    } catch {
      /* exit may have closed pipe */
    }
  }
  const startTimer = setTimeout(() => {
    startup({ kind: "failed" });
    closeControl();
  }, 5000);
  const monitor = (async () => {
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for await (const chunk of guard.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 4096) throw new Error("Invalid guard response");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as unknown;
          buffer = buffer.slice(newline + 1);
          const event = object(message, ["event"], ["pid", "code"]);
          if (
            event.event === "started" &&
            !startupResolved &&
            Number.isSafeInteger(event.pid) &&
            (event.pid as number) > 1 &&
            !Object.hasOwn(event, "code")
          )
            startup({ kind: "started", pid: event.pid as number });
          else if (
            event.event === "app-exited" &&
            Number.isInteger(event.code) &&
            !Object.hasOwn(event, "pid")
          )
            appExited = event.code as number;
          else throw new Error("Unexpected guard response");
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      closeControl();
    } finally {
      startup({ kind: "failed" });
    }
  })();
  try {
    guard.stdin.write(request);
    await guard.stdin.flush();
  } catch {
    startup({ kind: "failed" });
    closeControl();
  }
  let pending: Promise<StopResult> | null = null;
  let stopped = false;
  let stopRequested = false;
  function active() {
    return (
      appStarted &&
      appExited === null &&
      guard.exitCode === null &&
      !stopRequested
    );
  }
  async function finishStop(graceMs: number): Promise<StopResult> {
    if (stopped) return Object.freeze({ kind: "group-stopped" });
    try {
      guard.stdin.write(`${JSON.stringify({ action: "stop", graceMs })}\n`);
      await guard.stdin.flush();
    } catch {
      /* observe exit, never signal numeric group */
    }
    closeControl();
    const deadline = performance.now() + graceMs + 2500;
    let exited = false;
    void guard.exited.then(() => {
      exited = true;
    });
    do {
      if (exited) {
        try {
          process.kill(-guard.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            stopped = true;
            await monitor;
            return Object.freeze({ kind: "group-stopped" });
          }
          return Object.freeze({ kind: "incomplete" });
        }
      }
      await Bun.sleep(20);
    } while (performance.now() < deadline);
    return Object.freeze({ kind: "incomplete" });
  }
  return Object.freeze({
    group: guard.pid,
    started,
    inspect: () =>
      Object.freeze({
        appExitCode: appExited,
        guardExitCode: guard.exitCode,
        stopped,
        stopRequested,
      }),
    // One bounded observation tied to this retained launch handle, never an
    // imported PID. Not authorization or a continuous readiness guarantee.
    async observeListener(input: unknown, timeoutMs = 1500) {
      const listener = parseHealthListener(input);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
        throw new Error("Bounded health timeout required");
      if (!active())
        return Object.freeze({ kind: "lifecycle-inactive" as const });
      const before = await observeListenerBindings(listener.port);
      if (!active())
        return Object.freeze({ kind: "lifecycle-inactive" as const });
      const ownership = compareListenerGroup(
        before,
        listener.host,
        listener.port,
        guard.pid,
      );
      if (ownership !== "matches-process-group")
        return Object.freeze({
          kind: "ownership-unconfirmed" as const,
          reason: ownership,
        });
      const health = await probeListenerHealth(listener, timeoutMs);
      if (!active())
        return Object.freeze({ kind: "lifecycle-inactive" as const });
      const after = await observeListenerBindings(listener.port);
      if (!active())
        return Object.freeze({ kind: "lifecycle-inactive" as const });
      const finalOwnership = compareListenerGroup(
        after,
        listener.host,
        listener.port,
        guard.pid,
      );
      if (finalOwnership !== "matches-process-group")
        return Object.freeze({
          kind: "ownership-unconfirmed" as const,
          reason: finalOwnership,
        });
      // Refuse even an in-group replacement between observations. Snapshots
      // cannot exclude a replacement and restoration between the two reads.
      const fingerprint = (value: typeof before) =>
        value.kind === "observed"
          ? JSON.stringify(
              value.bindings.map((binding) => JSON.stringify(binding)).sort(),
            )
          : "";
      if (fingerprint(before) !== fingerprint(after))
        return Object.freeze({ kind: "bindings-changed" as const });
      return Object.freeze({
        kind:
          health.kind === "responding"
            ? ("observed-healthy" as const)
            : ("health-failed" as const),
        health,
      });
    },
    stop(graceMs = 1000): Promise<StopResult> {
      if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 10_000)
        return Promise.reject(new Error("Bounded stop grace required"));
      stopRequested = true;
      if (!pending)
        pending = finishStop(graceMs).finally(() => {
          pending = null;
        });
      return pending;
    },
  });
}
