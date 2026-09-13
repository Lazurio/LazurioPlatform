import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { startGuardedProcess } from "../src/modules/guarded-process";
import { probeListenerHealth } from "../src/modules/health";
import {
  compareListenerGroup,
  observeListenerBindings,
} from "../src/modules/listener-ownership";

// Compile before use. App fixture and its child run from this same executable;
// the guard runs from the separately compiled, actual Platform CLI argument.
const mode = process.argv[4];
if (process.argv[2] === "--fixture-child") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("fixture"),
  });
  if (mode !== "normal") process.on("SIGTERM", () => {});
  await Bun.write(
    process.argv[3] as string,
    JSON.stringify({ port: server.port }),
  );
} else if (process.argv[2] === "--fixture") {
  const path = process.argv[3] as string;
  const child = Bun.spawn(
    [process.execPath, "--fixture-child", path, mode ?? "normal"],
    { env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if (mode === "ignore") process.on("SIGTERM", () => {});
  else if (mode === "exit-grace") process.on("SIGTERM", () => process.exit(9));
  else
    process.on("SIGTERM", () => {
      void child.exited.then(() => process.exit(0));
    });
  if (mode === "exit-before") {
    while (!(await Bun.file(path).exists())) await Bun.sleep(10);
    process.exit(9);
  }
  await child.exited;
} else {
  const platform = process.argv[2];
  if (!platform || !isAbsolute(platform))
    throw new Error("Compiled Platform executable required");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "guarded-process-smoke-")),
  );
  const handles: Awaited<ReturnType<typeof startGuardedProcess>>[] = [];
  const health = (port: number) =>
    probeListenerHealth({
      host: "127.0.0.1",
      port,
      protocol: "http",
      health: { kind: "http", path: "/" },
    });
  async function launch(name: string, mode: string) {
    const cwd = join(root, name);
    await mkdir(cwd, { mode: 0o700 });
    const path = join(cwd, "ready.json");
    const handle = await startGuardedProcess(
      {
        executable: process.execPath,
        args: ["--fixture", path, mode],
        cwd,
        env: {},
      },
      platform as string,
    );
    handles.push(handle);
    if ((await handle.started).kind !== "started")
      throw new Error("Guard fixture start failed");
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      try {
        const ready = JSON.parse(await readFile(path, "utf8")) as {
          port: number;
        };
        if (Number.isInteger(ready.port)) return { handle, port: ready.port };
      } catch {
        /* fixture write may be in progress */
      }
      await Bun.sleep(10);
    }
    throw new Error("Fixture readiness timeout");
  }
  try {
    const other = await launch("unrelated", "normal");
    for (const mode of ["normal", "ignore", "exit-before", "exit-grace"]) {
      const { handle, port } = await launch(mode, mode);
      if (mode === "exit-before") {
        const deadline = performance.now() + 1000;
        while (
          handle.inspect().appExitCode === null &&
          performance.now() < deadline
        )
          await Bun.sleep(10);
        if (
          handle.inspect().appExitCode !== 9 ||
          handle.inspect().guardExitCode !== null
        )
          throw new Error("Guard did not survive launcher exit");
      }
      if (
        compareListenerGroup(
          await observeListenerBindings(port),
          "127.0.0.1",
          port,
          handle.group,
        ) !== "matches-process-group"
      )
        throw new Error("Fixture listener group mismatch");
      if ((await health(port)).kind !== "responding")
        throw new Error("Fixture unavailable");
      const stop = handle.stop(50);
      if (handle.stop(50) !== stop || (await stop).kind !== "group-stopped")
        throw new Error("Group stop not confirmed");
      if ((await health(port)).kind !== "unavailable")
        throw new Error("Stopped fixture still responds");
      if ((await health(other.port)).kind !== "responding")
        throw new Error("Unrelated fixture affected");
      if ((await handle.stop(50)).kind !== "group-stopped")
        throw new Error("Repeated stop failed");
    }
    if ((await other.handle.stop(50)).kind !== "group-stopped")
      throw new Error("Final fixture cleanup failed");
    console.log(
      JSON.stringify({
        result: "pass",
        scope: "compiled-cli-guard-and-inherited-process-groups",
        platform: process.platform,
        arch: process.arch,
        scenarios: ["normal", "ignore", "exit-before", "exit-grace"],
        installedProduct: false,
      }),
    );
  } finally {
    for (const handle of handles) await handle.stop(50);
    await rm(root, { recursive: true, force: true });
  }
}
