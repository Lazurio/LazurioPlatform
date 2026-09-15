import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { object } from "./manifest";
import { parseProcessLaunch } from "./process-launch";

export const processGuardCommand = "__lazurio-process-guard";

// Same executable, private stdin/stdout protocol, one guard INSIDE the owned
// process group. No locator, listener, persisted PID or remote command surface.
export async function runProcessGuard() {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Unsupported guard platform");
  const { stdout, stderr } = await promisify(execFile)(
    "/bin/ps",
    ["-o", "pgid=", "-p", String(process.pid)],
    {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 2000,
      maxBuffer: 1024,
    },
  );
  if (
    stderr ||
    !/^\d+$/.test(stdout.trim()) ||
    Number(stdout.trim()) !== process.pid ||
    process.pid <= 1
  )
    throw new Error("Guard must own its process group");
  let stopping = false;
  let launched = false;
  function stop(graceMs = 1000) {
    if (stopping) return;
    stopping = true;
    // This process is still alive and is the group leader: its own PID cannot
    // be recycled underneath this signal. Never signal a stored foreign group.
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), graceMs);
  }
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop());
  process.stdout.on("error", () => stop());
  let buffer = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const bytes of Bun.stdin.stream()) {
      buffer += decoder.decode(bytes, { stream: true });
      if (Buffer.byteLength(buffer) > 65_536)
        throw new Error("Guard input too large");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!launched) {
          if (stopping) return;
          const config = parseProcessLaunch(JSON.parse(line));
          await inspectOwnedDirectory(config.cwd);
          if (stopping) return;
          // This dedicated guard, not the caller, owns the child environment.
          // Managed install/app descendants must not inherit a group-writable
          // creation default and produce trees our private-owner checks refuse.
          // Only tighten creation permissions; never chmod existing/shared inodes
          // or relax a stricter inherited mask. This is not a script sandbox.
          process.umask(process.umask() | 0o077);
          const app = Bun.spawn([config.executable, ...config.args], {
            cwd: config.cwd,
            env: config.env,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: false,
          });
          launched = true;
          process.stdout.write(
            `${JSON.stringify({ event: "started", pid: app.pid })}\n`,
          );
          void app.exited.then((code) => {
            if (!stopping)
              process.stdout.write(
                `${JSON.stringify({ event: "app-exited", code })}\n`,
              );
          });
        } else {
          const command = object(JSON.parse(line), ["action", "graceMs"]);
          if (
            command.action !== "stop" ||
            !Number.isInteger(command.graceMs) ||
            (command.graceMs as number) < 1 ||
            (command.graceMs as number) > 10_000
          )
            throw new Error("Invalid guard command");
          stop(command.graceMs as number);
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    // Owner death closes the pipe. A guard never silently outlives that owner.
    stop();
  }
}
