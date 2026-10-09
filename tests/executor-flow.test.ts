import { expect, test } from "bun:test";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runExecutorCommand } from "../src/executor/cli";
import {
  type ExecutorFacts,
  type ExecutorPhase,
  executorSetup,
  executorState,
  executorStatus,
} from "../src/executor/flow";
import { processExecutorHost } from "../src/executor/host";
import { acquireFileLock } from "../src/platform/flock";
import { runTool } from "../src/tools/status";
import { embeddedIdentity } from "../src/update/identity";
import { executorWorld, fakeVersion } from "./fixtures/fake-executor";

// One core for the CLI, the Launchpad and the convergence (decision F44):
// `status` reads, `setup` moves what is there on, and both say one plain
// state.

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

test("setup from nothing installs the pin, starts the service and connects both agents; status then says running", async () => {
  const world = await executorWorld();
  try {
    const before = await executorStatus(world.host);
    expect(before).toMatchObject({
      kind: "executor-status",
      state: "not-installed",
      version: fakeVersion,
      installed: null,
      address: "127.0.0.1:4789",
      entry: "missing",
      service: "missing",
      settings: "missing",
      answering: false,
      agents: { codex: "missing", claude: "missing" },
    });
    // Reading wrote nothing.
    expect(await exists(world.host.root)).toBe(false);
    expect(await exists(join(world.home, ".config"))).toBe(false);
    const phases: ExecutorPhase[] = [];
    const after = await executorSetup(world.host, (phase) =>
      phases.push(phase),
    );
    expect(phases).toEqual(["install", "service", "agents"]);
    expect(after).toEqual({
      kind: "executor-status",
      state: "running",
      version: fakeVersion,
      installed: fakeVersion,
      address: "127.0.0.1:4789",
      entry: "lazurio",
      service: "running",
      settings: "current",
      answering: true,
      linger: "yes",
      agents: { codex: "registered", claude: "registered" },
    });
    expect(world.journal).toEqual([{ operation: "setup", outcome: "running" }]);
    expect(await executorStatus(world.host)).toEqual(after);
    // A second setup changes nothing.
    world.registry.requests.length = 0;
    const systemctl = (await world.calls("systemctl.calls")).length;
    expect(await executorSetup(world.host)).toEqual(after);
    expect(world.registry.requests).toEqual([]);
    expect(
      (await world.calls("systemctl.calls"))
        .slice(systemctl)
        .every((line) => line.startsWith("--user show ")),
    ).toBe(true);
  } finally {
    await world.close();
  }
}, 30_000);

test("Executor's token never reaches an answer, the journal or the CLI", async () => {
  const world = await executorWorld();
  try {
    const canary = "exec-token-canary-5f1e2d3c4b5a69788796a5b4c3d2e1f0";
    await mkdir(join(world.home, ".executor", "server-control"), {
      recursive: true,
    });
    await writeFile(
      join(world.home, ".executor", "server-control", "auth.json"),
      JSON.stringify({ token: canary }),
    );
    await writeFile(
      join(world.home, ".executor", "server-control", "server.json"),
      JSON.stringify({
        connection: { auth: { kind: "bearer", token: canary } },
      }),
    );
    const answers = [
      JSON.stringify(await executorSetup(world.host)),
      JSON.stringify(await executorStatus(world.host)),
      JSON.stringify(world.journal),
    ];
    const context = {
      identity: embeddedIdentity(),
      platform: "linux",
      env: world.host.env,
      executable: process.execPath,
      host: world.host,
    };
    for (const args of [["status"], ["status", "--json"], ["setup"]]) {
      const output = await runExecutorCommand(args, context);
      answers.push(`${output.stdout ?? ""}${output.stderr ?? ""}`);
    }
    for (const answer of answers) expect(answer).not.toContain(canary);
  } finally {
    await world.close();
  }
}, 30_000);

test("where Executor is not offered, status and setup say why and change nothing", async () => {
  const world = await executorWorld({
    context: { kind: "unsupported", reason: "workstation" },
  });
  try {
    const expected = {
      kind: "executor-status",
      state: "unsupported",
      reason: "workstation",
    } as const;
    expect(await executorStatus(world.host)).toEqual(expected);
    expect(await executorSetup(world.host)).toEqual(expected);
    expect(await exists(world.host.root)).toBe(false);
    expect(world.registry.requests).toEqual([]);
    expect(world.journal).toEqual([
      { operation: "setup", outcome: "unsupported" },
    ]);
  } finally {
    await world.close();
  }
}, 30_000);

test("conflicts are reported and left alone: a foreign entry stops before anything is installed; a foreign MCP server leaves the rest running", async () => {
  const world = await executorWorld();
  try {
    await mkdir(world.host.bin, { recursive: true });
    await writeFile(join(world.host.bin, "executor"), "#!/bin/sh\n");
    expect(await executorSetup(world.host)).toMatchObject({
      state: "conflict",
      entry: "conflict",
      installed: null,
    });
    expect(world.registry.requests).toEqual([]);
    await rm(join(world.host.bin, "executor"));
    await writeFile(
      join(world.home, ".claude.json"),
      JSON.stringify({ mcpServers: { executor: { command: "/opt/other" } } }),
    );
    expect(await executorSetup(world.host)).toMatchObject({
      state: "conflict",
      entry: "lazurio",
      service: "running",
      answering: true,
      agents: { codex: "registered", claude: "conflict" },
    });
  } finally {
    await world.close();
  }
}, 30_000);

test("a setup that stops says where; the next one completes it, and older versions go only once the service runs the pin", async () => {
  const world = await executorWorld();
  try {
    await mkdir(join(world.host.root, "1.6.9"), { recursive: true });
    world.registry.tamper(world.pin.platforms["linux-x64"].url);
    expect(await executorSetup(world.host)).toMatchObject({
      state: "not-installed",
      failure: { stage: "integrity", reason: "integrity-mismatch" },
    });
    world.registry.restore();
    await world.flag("executor-world/install-fails");
    expect(await executorSetup(world.host)).toMatchObject({
      state: "not-running",
      installed: fakeVersion,
      failure: { stage: "service", reason: "install-exit-1" },
    });
    // The service did not switch: the older version stays.
    expect(await readdir(world.host.root)).toContain("1.6.9");
    await world.flag("executor-world/install-fails", false);
    const done = await executorSetup(world.host);
    expect(done.state).toBe("running");
    expect("failure" in done).toBe(false);
    expect(
      (await readdir(world.host.root)).filter((name) => !name.startsWith(".")),
    ).toEqual([fakeVersion]);
    expect(world.journal.map((entry) => entry.outcome)).toEqual([
      "not-installed",
      "not-running",
      "running",
    ]);
    expect(world.journal[0]).toEqual({
      operation: "setup",
      outcome: "not-installed",
      stage: "integrity",
      reason: "integrity-mismatch",
    });
  } finally {
    await world.close();
  }
}, 30_000);

test("two setups never run at once: the second one answers busy", async () => {
  const world = await executorWorld();
  try {
    await mkdir(world.host.root, { recursive: true });
    const lock = await acquireFileLock(join(world.host.root, ".lazurio.lock"), {
      timeoutMs: 0,
    });
    try {
      expect(await executorSetup(world.host)).toMatchObject({
        state: "not-installed",
        failure: { stage: "busy", reason: "busy" },
      });
      expect(world.registry.requests).toEqual([]);
    } finally {
      await lock.release();
    }
  } finally {
    await world.close();
  }
}, 30_000);

test("status follows the live state: stopped is not-running, a missing drop-in or agent entry is incomplete, and setup repairs both", async () => {
  const world = await executorWorld();
  try {
    await executorSetup(world.host);
    await world.setActive("inactive");
    expect(await executorStatus(world.host)).toMatchObject({
      state: "not-running",
      service: "stopped",
      answering: false,
    });
    expect((await executorSetup(world.host)).state).toBe("running");
    await rm(
      join(
        world.home,
        ".config/systemd/user/sh.executor.daemon.service.d/lazurio.conf",
      ),
    );
    await writeFile(join(world.home, ".claude.json"), "{}");
    expect(await executorStatus(world.host)).toMatchObject({
      state: "incomplete",
      settings: "missing",
      agents: { claude: "missing" },
    });
    expect((await executorSetup(world.host)).state).toBe("running");
  } finally {
    await world.close();
  }
}, 30_000);

test("the row's state from the facts", () => {
  const running: ExecutorFacts = {
    version: "1.6.10",
    installed: "1.6.10",
    address: "127.0.0.1:4789",
    entry: "lazurio",
    service: "running",
    settings: "current",
    answering: true,
    linger: "yes",
    agents: { codex: "registered", claude: "absent" },
  };
  const pin = { version: "1.6.10" };
  expect(executorState(running, pin)).toBe("running");
  expect(executorState({ ...running, entry: "conflict" }, pin)).toBe(
    "conflict",
  );
  expect(
    executorState({ ...running, entry: "missing", installed: null }, pin),
  ).toBe("not-installed");
  expect(executorState({ ...running, installed: "1.6.9" }, pin)).toBe(
    "outdated",
  );
  // A newer pin of a newer release is not outdated.
  expect(executorState({ ...running, installed: "1.7.0" }, pin)).toBe(
    "running",
  );
  expect(
    executorState(
      { ...running, agents: { codex: "conflict", claude: "absent" } },
      pin,
    ),
  ).toBe("conflict");
  expect(executorState({ ...running, answering: false }, pin)).toBe(
    "not-running",
  );
  for (const change of [
    { service: "other" as const },
    { settings: "different" as const },
    { agents: { codex: "missing" as const, claude: "absent" as const } },
    { agents: { codex: "registered" as const, claude: "unknown" as const } },
  ])
    expect(executorState({ ...running, ...change }, pin)).toBe("incomplete");
  // The operator's switched-off entry in Codex is the operator's choice.
  expect(
    executorState(
      { ...running, agents: { codex: "disabled", claude: "absent" } },
      pin,
    ),
  ).toBe("running");
});

test("the production host offers Executor only to the declared operator of a readable handover on Linux", async () => {
  const host = (
    platform: string,
    hostedFolder: () => Promise<string | undefined>,
    home = "/home/operator",
  ) =>
    processExecutorHost({
      hostedFolder,
      env: { HOME: home, PATH: "/usr/bin" },
      platform,
      run: runTool,
    });
  expect(
    await host("linux", async () => "/home/operator/Lazurio").context(),
  ).toEqual({ kind: "supported" });
  expect(
    await host("darwin", async () => "/home/operator/Lazurio").context(),
  ).toEqual({ kind: "unsupported", reason: "workstation" });
  expect(await host("linux", async () => undefined).context()).toEqual({
    kind: "unsupported",
    reason: "workstation",
  });
  expect(
    await host("linux", async () => {
      throw new Error("unreadable");
    }).context(),
  ).toEqual({ kind: "unsupported", reason: "handover-unreadable" });
  expect(
    await host("linux", async () => "/home/someone/Lazurio").context(),
  ).toEqual({ kind: "unsupported", reason: "not-operator" });
  const production = host("linux", async () => "/home/operator/Lazurio");
  expect({
    bin: production.bin,
    root: production.root,
  }).toEqual({
    bin: "/home/operator/.local/bin",
    root: "/home/operator/.local/share/executor-cli",
  });
}, 30_000);
