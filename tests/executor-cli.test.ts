import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ExecutorCliContext,
  executorHelp,
  executorStatusText,
  runExecutorCommand,
} from "../src/executor/cli";
import type { ExecutorHost } from "../src/executor/flow";
import { embeddedIdentity } from "../src/update/identity";
import { executorWorld, fakeVersion } from "./fixtures/fake-executor";

// `lazurio executor status|setup [--json]` (decision F44): the same core as
// the Launchpad, plain lines or the status as JSON, and an exit status a
// script can act on.

const contextOf = (
  host: ExecutorHost,
  progress?: (line: string) => void,
): ExecutorCliContext => ({
  identity: embeddedIdentity(),
  platform: "linux",
  env: host.env,
  executable: process.execPath,
  host,
  ...(progress === undefined ? {} : { progress }),
});

test("status reads and setup sets up, with plain lines, JSON and an exit status per state", async () => {
  const world = await executorWorld();
  try {
    const before = await runExecutorCommand(["status"], contextOf(world.host));
    expect(before.code).toBe(0);
    expect(before.stdout?.split("\n")).toEqual([
      `Executor is not installed; lazurio executor setup installs ${fakeVersion}.`,
      "Service sh.executor.daemon.service: missing; Lazurio's settings: missing; lingering: yes.",
      "Codex: not connected yet. Claude Code: not connected yet.",
    ]);
    const lines: string[] = [];
    const setup = await runExecutorCommand(
      ["setup"],
      contextOf(world.host, (line) => lines.push(line)),
    );
    expect(lines).toEqual([
      "Installing the pinned Executor…",
      "Starting its service…",
      "Connecting the agents…",
    ]);
    expect(setup.code).toBe(0);
    expect(setup.stdout?.split("\n")[0]).toBe(
      `Executor ${fakeVersion} runs on 127.0.0.1:4789 (this Environment only) and the agents are connected.`,
    );
    const json = await runExecutorCommand(
      ["status", "--json"],
      contextOf(world.host),
    );
    expect(JSON.parse(json.stdout ?? "")).toMatchObject({
      kind: "executor-status",
      state: "running",
    });
    // --json reports no phases.
    lines.length = 0;
    const quiet = await runExecutorCommand(
      ["setup", "--json"],
      contextOf(world.host, (line) => lines.push(line)),
    );
    expect(lines).toEqual([]);
    expect(JSON.parse(quiet.stdout ?? "").state).toBe("running");
  } finally {
    await world.close();
  }
}, 30_000);

test("setup exits 2 where a person must act and 1 where it did not finish", async () => {
  const conflict = await executorWorld();
  try {
    await mkdir(conflict.host.bin, { recursive: true });
    await writeFile(join(conflict.host.bin, "executor"), "#!/bin/sh\n");
    const output = await runExecutorCommand(
      ["setup"],
      contextOf(conflict.host),
    );
    expect(output.code).toBe(2);
    expect(output.stdout?.split("\n")[0]).toBe(
      "~/.local/bin/executor is not Lazurio's, so Lazurio leaves Executor alone. Remove that entry (or ask an agent to) and run lazurio executor setup.",
    );
  } finally {
    await conflict.close();
  }
  const unsupported = await executorWorld({
    context: { kind: "unsupported", reason: "workstation" },
  });
  try {
    const output = await runExecutorCommand(
      ["setup"],
      contextOf(unsupported.host),
    );
    expect(output).toEqual({
      code: 2,
      stdout:
        "Not available: Lazurio sets Executor up only in a Remote Environment on Linux for now; on this computer it comes once its macOS service is verified.",
    });
  } finally {
    await unsupported.close();
  }
  const failing = await executorWorld({ npm: false });
  try {
    const output = await runExecutorCommand(["setup"], contextOf(failing.host));
    expect(output.code).toBe(1);
    expect(output.stdout?.split("\n").at(-1)).toBe(
      "The setup stopped at preflight: npm-missing.",
    );
  } finally {
    await failing.close();
  }
}, 30_000);

test("a wrong invocation is a usage error with the help", async () => {
  const world = await executorWorld();
  try {
    for (const args of [
      [],
      ["install"],
      ["status", "extra"],
      ["status", "--json", "--json"],
      ["setup", "--force"],
    ]) {
      const output = await runExecutorCommand(args, contextOf(world.host));
      expect(output.code).toBe(2);
      expect(output.stderr).toContain(executorHelp);
    }
  } finally {
    await world.close();
  }
});

test("the status text speaks of conflicts of an agent and of a stopped setup without paths or values", () => {
  const base = {
    kind: "executor-status" as const,
    version: "1.6.10",
    installed: "1.6.10",
    address: "127.0.0.1:4789",
    entry: "lazurio" as const,
    service: "running" as const,
    settings: "current" as const,
    answering: true,
    linger: "yes" as const,
  };
  expect(
    executorStatusText({
      ...base,
      state: "conflict",
      agents: { codex: "conflict", claude: "absent" },
    }),
  ).toBe(
    [
      "An MCP server named executor that is not Lazurio's is configured; Lazurio leaves it as it is. Remove it (codex mcp remove executor, claude mcp remove executor --scope user) and run lazurio executor setup.",
      "Service sh.executor.daemon.service: running; Lazurio's settings: current; lingering: yes.",
      "Codex: has another MCP server named executor. Claude Code: not installed.",
    ].join("\n"),
  );
  expect(
    executorStatusText({
      ...base,
      state: "not-running",
      service: "failed",
      answering: false,
      agents: { codex: "registered", claude: "disabled" },
      failure: { stage: "service", reason: "health-not-answering" },
    }).split("\n"),
  ).toEqual([
    "Executor 1.6.10 is installed and does not answer on 127.0.0.1:4789; lazurio executor setup starts it.",
    "Service sh.executor.daemon.service: failed; Lazurio's settings: current; lingering: yes.",
    "Codex: connected. Claude Code: switched off by the operator.",
    "The setup stopped at service: health-not-answering.",
  ]);
});
