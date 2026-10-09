import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installPinnedExecutor, pinnedBinary } from "../src/executor/install";
import {
  ensureExecutorService,
  executorDropIn,
  executorDropInDirectory,
  executorUnitDirectory,
  observeExecutorService,
  parseExecStart,
  type ServiceInput,
  serviceCommand,
} from "../src/executor/service";
import { runTool } from "../src/tools/status";
import { type ExecutorWorld, executorWorld } from "./fixtures/fake-executor";

// The service (decision F44): Executor's own unit through `executor install`,
// Lazurio's drop-in with both switches, and nothing stopped or restarted
// that runs the pinned program and answers.

async function installed(world: ExecutorWorld) {
  await installPinnedExecutor({
    root: world.host.root,
    bin: world.host.bin,
    home: world.home,
    path: world.path,
    platform: "linux",
    arch: "x64",
    run: runTool,
    fetch: world.registry.fetch,
    pin: world.pin,
  });
  return pinnedBinary(world.host.root, "linux-x64", world.pin);
}

const inputOf = (world: ExecutorWorld, binary: string): ServiceInput => ({
  home: world.home,
  env: world.host.env,
  run: runTool,
  binary,
  uid: 1000,
  probe: world.answers,
  healthDeadlineMs: 500,
  pollMs: 25,
});

const dropIn = (world: ExecutorWorld) =>
  join(executorDropInDirectory(world.home), "lazurio.conf");
const unitFile = (world: ExecutorWorld) =>
  join(executorUnitDirectory(world.home), "sh.executor.daemon.service");

test("the drop-in sets both switches, and the command line is the one executor install writes", () => {
  expect(executorDropIn().split("\n")).toEqual([
    "# Written by Lazurio (decision F44) and rewritten by it; the unit itself is Executor's (executor install).",
    "[Service]",
    "Environment=EXECUTOR_DISABLE_ANALYTICS=1",
    "Environment=EXECUTOR_DISABLE_UPDATE_CHECK=1",
    "",
  ]);
  expect(serviceCommand("/home/a/x/executor")).toEqual([
    "/home/a/x/executor",
    "daemon",
    "run",
    "--foreground",
    "--port",
    "4789",
    "--hostname",
    "127.0.0.1",
  ]);
  // Executor's own quoting: bare words, or double quotes with C escapes.
  expect(
    parseExecStart(
      '[Service]\nExecStart="/home/a b/executor" daemon run --port 4789\n',
    ),
  ).toEqual(["/home/a b/executor", "daemon", "run", "--port", "4789"]);
  expect(parseExecStart('ExecStart="/x/\\"q\\"\\\\y" run\n')).toEqual([
    '/x/"q"\\y',
    "run",
  ]);
  expect(parseExecStart('ExecStart="/unterminated run\n')).toBeNull();
  expect(parseExecStart("[Service]\nType=simple\n")).toBeNull();
});

test("a first setup writes the drop-in before executor install, which runs with both switches off and the standard tool path; nothing is stopped", async () => {
  const world = await executorWorld();
  try {
    const binary = await installed(world);
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "installed",
    });
    expect(await readFile(dropIn(world), "utf8")).toBe(executorDropIn());
    const install = (await world.calls("executor.calls")).filter((line) =>
      line.startsWith("install|"),
    );
    expect(install).toEqual([
      `install|analytics=1|update=1|path=${world.home}/.local/bin:/usr/local/bin:/usr/bin:/bin|data=|dropin=yes`,
    ]);
    expect(parseExecStart(await readFile(unitFile(world), "utf8"))).toEqual(
      serviceCommand(binary),
    );
    const systemctl = await world.calls("systemctl.calls");
    expect(systemctl.some((line) => /^--user (stop|restart)/.test(line))).toBe(
      false,
    );
    expect(systemctl).toContain(
      "--user enable --now sh.executor.daemon.service",
    );
    // Lingering is reported, never changed.
    expect(await world.calls("loginctl.calls")).toEqual([
      "show-user 1000 --property=Linger --value",
    ]);
  } finally {
    await world.close();
  }
}, 20_000);

test("a service that runs the pinned program and answers is never touched: no write, no reload, no restart", async () => {
  const world = await executorWorld();
  try {
    const binary = await installed(world);
    await ensureExecutorService(inputOf(world, binary));
    const written = await stat(dropIn(world));
    const before = (await world.calls("systemctl.calls")).length;
    const installs = (await world.calls("executor.calls")).length;
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "none",
    });
    expect((await world.calls("systemctl.calls")).slice(before)).toEqual([
      "--user show --property=LoadState,ActiveState,UnitFileState -- sh.executor.daemon.service",
    ]);
    expect(await world.calls("executor.calls")).toHaveLength(installs);
    expect((await stat(dropIn(world))).mtimeMs).toBe(written.mtimeMs);
  } finally {
    await world.close();
  }
}, 20_000);

test("a changed drop-in is rewritten, reread once and restarts the running service; the next run changes nothing", async () => {
  const world = await executorWorld();
  try {
    const binary = await installed(world);
    await ensureExecutorService(inputOf(world, binary));
    await writeFile(dropIn(world), "[Service]\nEnvironment=X=1\n");
    const before = (await world.calls("systemctl.calls")).length;
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "restarted",
    });
    expect(await readFile(dropIn(world), "utf8")).toBe(executorDropIn());
    expect((await world.calls("systemctl.calls")).slice(before)).toEqual([
      "--user show --property=LoadState,ActiveState,UnitFileState -- sh.executor.daemon.service",
      "--user daemon-reload",
      "--user restart sh.executor.daemon.service",
    ]);
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "none",
    });
  } finally {
    await world.close();
  }
}, 20_000);

test("a stopped or failed service is started, never restarted; a disabled one is enabled", async () => {
  const world = await executorWorld();
  try {
    const binary = await installed(world);
    await ensureExecutorService(inputOf(world, binary));
    await world.setActive("failed");
    await world.flag("systemd-world/enabled", false);
    const before = (await world.calls("systemctl.calls")).length;
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "started",
    });
    expect((await world.calls("systemctl.calls")).slice(before)).toEqual([
      "--user show --property=LoadState,ActiveState,UnitFileState -- sh.executor.daemon.service",
      "--user enable sh.executor.daemon.service",
      "--user reset-failed sh.executor.daemon.service",
      "--user start sh.executor.daemon.service",
    ]);
  } finally {
    await world.close();
  }
}, 20_000);

test("a unit of another program (a version switch, the manual pilot) is stopped and executor install repoints it", async () => {
  const world = await executorWorld();
  try {
    const binary = await installed(world);
    await mkdir(executorUnitDirectory(world.home), { recursive: true });
    await writeFile(
      unitFile(world),
      `[Service]\nExecStart=${world.host.root}/1.6.9/lib/node_modules/executor-linux-x64/bin/executor daemon run --foreground --port 4789 --hostname 127.0.0.1\n`,
    );
    await world.setActive("active");
    await world.flag("systemd-world/enabled");
    expect((await observeExecutorService(inputOf(world, binary)))?.unit).toBe(
      "other",
    );
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "installed",
    });
    const systemctl = await world.calls("systemctl.calls");
    const stop = systemctl.indexOf("--user stop sh.executor.daemon.service");
    const now = systemctl.indexOf(
      "--user enable --now sh.executor.daemon.service",
    );
    expect(stop).toBeGreaterThan(-1);
    expect(now).toBeGreaterThan(stop);
    expect(parseExecStart(await readFile(unitFile(world), "utf8"))).toEqual(
      serviceCommand(binary),
    );
  } finally {
    await world.close();
  }
}, 20_000);

test("failures name their step: no user manager writes nothing, a failed executor install keeps the drop-in, a silent service gets one restart", async () => {
  const world = await executorWorld();
  try {
    const binary = await installed(world);
    await world.flag("systemd-world/unreachable");
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "failed",
      step: "user-manager",
      reason: "unreachable",
    });
    expect(
      await stat(dropIn(world)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await world.flag("systemd-world/unreachable", false);
    await world.flag("executor-world/install-fails");
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "failed",
      step: "install",
      reason: "exit-1",
    });
    expect(await readFile(dropIn(world), "utf8")).toBe(executorDropIn());
    await world.flag("executor-world/install-fails", false);
    expect(await ensureExecutorService(inputOf(world, binary))).toMatchObject({
      kind: "running",
    });
    // Active and silent: one restart, and it must answer.
    await world.flag("systemd-world/silent");
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "running",
      change: "restarted",
    });
    await world.flag("systemd-world/silent");
    await world.flag("systemd-world/stays-silent");
    expect(await ensureExecutorService(inputOf(world, binary))).toEqual({
      kind: "failed",
      step: "health",
      reason: "not-answering",
    });
  } finally {
    await world.close();
  }
}, 20_000);
