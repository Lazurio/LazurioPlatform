import { probeListenerHealth } from "../src/modules/health";
import {
  compareListenerGroup,
  observeListenerBindings,
} from "../src/modules/listener-ownership";

// Compile this runner before use: its child is the same standalone executable.
if (process.argv[2] === "--fixture") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture"),
  });
  process.stdout.write(`${server.port}\n`);
} else {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("POSIX fixture only");
  const child = Bun.spawn([process.execPath, "--fixture"], {
    cwd: "/",
    env: {},
    detached: true,
    stdout: "pipe",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Fixture start timeout")),
          3000,
        );
      }),
    ]);
    clearTimeout(timer);
    reader.releaseLock();
    const port = Number(new TextDecoder().decode(chunk.value).trim());
    const observed = await observeListenerBindings(port);
    if (
      compareListenerGroup(observed, "127.0.0.1", port, child.pid) !==
      "matches-process-group"
    )
      throw new Error("Fixture ownership not observed");
    if (
      compareListenerGroup(observed, "127.0.0.1", port, child.pid + 1) !==
      "foreign-group"
    )
      throw new Error("Foreign group not refused");
    if (
      (
        await probeListenerHealth({
          host: "127.0.0.1",
          port,
          protocol: "http",
          health: { kind: "http", path: "/" },
        })
      ).kind !== "responding"
    )
      throw new Error("Fixture did not survive observation");
    child.kill("SIGKILL");
    await child.exited;
    if (
      (
        await probeListenerHealth({
          host: "127.0.0.1",
          port,
          protocol: "http",
          health: { kind: "http", path: "/" },
        })
      ).kind !== "unavailable"
    )
      throw new Error("Fixture still responds after cleanup");
    console.log(
      JSON.stringify({
        result: "pass",
        scope: "listener-group-and-health-observation",
        platform: process.platform,
        arch: process.arch,
        processTreeLifecycle: false,
      }),
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
