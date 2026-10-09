import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentsInput,
  ensureAgents,
  isExecutorEntry,
  observeAgents,
} from "../src/executor/agents";
import { runTool } from "../src/tools/status";
import { type ExecutorWorld, executorWorld } from "./fixtures/fake-executor";

// The agents' MCP server `executor` (decision F44, the amendment of F17 and
// F29): exactly one entry, added with each harness's own CLI where the
// harness is installed; nothing else of the operator's configuration is
// changed, and an entry of that name that is not Lazurio's stays.

const inputOf = (
  world: ExecutorWorld,
  env: Readonly<Record<string, string>> = {},
): AgentsInput => ({
  home: world.home,
  path: world.path,
  platform: "linux",
  env: { ...world.host.env, ...env },
  run: runTool,
  entry: join(world.host.bin, "executor"),
});

const claudeFile = (world: ExecutorWorld) => join(world.home, ".claude.json");
const codexStore = (world: ExecutorWorld) =>
  join(world.home, ".codex", "fake-mcp.json");

test("adds executor to Codex and Claude Code with their own CLIs and both switches, keeps every other entry and key, and does it once", async () => {
  const world = await executorWorld();
  try {
    const entry = join(world.host.bin, "executor");
    // The operator's own configuration: other servers and keys stay.
    await writeFile(
      claudeFile(world),
      JSON.stringify({
        numStartups: 7,
        mcpServers: {
          notes: { type: "stdio", command: "/opt/notes", args: [] },
        },
        projects: { "/home/x": { mcpServers: {} } },
      }),
    );
    await mkdir(join(world.home, ".codex"), { recursive: true });
    await writeFile(
      codexStore(world),
      JSON.stringify({
        notes: {
          transport: {
            type: "stdio",
            command: "/opt/notes",
            args: [],
            env: null,
          },
        },
      }),
    );
    expect(await observeAgents(inputOf(world))).toEqual({
      codex: "missing",
      claude: "missing",
    });
    expect(await ensureAgents(inputOf(world))).toEqual({
      codex: "registered",
      claude: "registered",
    });
    expect(
      (await world.calls("codex.calls")).filter((line) =>
        line.startsWith("mcp add"),
      ),
    ).toEqual([
      `mcp add executor --env EXECUTOR_DISABLE_ANALYTICS=1 --env EXECUTOR_DISABLE_UPDATE_CHECK=1 -- ${entry} mcp|codex_home=`,
    ]);
    expect(
      (await world.calls("claude.calls")).filter((line) =>
        line.startsWith("mcp add"),
      ),
    ).toEqual([
      `mcp add --scope user executor -e EXECUTOR_DISABLE_ANALYTICS=1 -e EXECUTOR_DISABLE_UPDATE_CHECK=1 -- ${entry} mcp|traffic=1|config=`,
    ]);
    const claude = JSON.parse(await readFile(claudeFile(world), "utf8"));
    expect(claude.numStartups).toBe(7);
    expect(claude.projects).toEqual({ "/home/x": { mcpServers: {} } });
    expect(Object.keys(claude.mcpServers).sort()).toEqual([
      "executor",
      "notes",
    ]);
    expect(
      Object.keys(JSON.parse(await readFile(codexStore(world), "utf8"))).sort(),
    ).toEqual(["executor", "notes"]);
    // Again: read only.
    const codexCalls = (await world.calls("codex.calls")).length;
    const claudeCalls = (await world.calls("claude.calls")).length;
    expect(await ensureAgents(inputOf(world))).toEqual({
      codex: "registered",
      claude: "registered",
    });
    expect(await world.calls("codex.calls")).toHaveLength(codexCalls + 1);
    expect(
      (await world.calls("codex.calls"))
        .at(-1)
        ?.startsWith("mcp get executor --json"),
    ).toBe(true);
    expect(await world.calls("claude.calls")).toHaveLength(claudeCalls);
  } finally {
    await world.close();
  }
});

test("an entry named executor that is not Lazurio's is a conflict and stays exactly as it is", async () => {
  const world = await executorWorld();
  try {
    const foreignClaude = JSON.stringify({
      mcpServers: {
        executor: { type: "http", url: "https://executor.example.invalid/mcp" },
      },
    });
    await writeFile(claudeFile(world), foreignClaude);
    await mkdir(join(world.home, ".codex"), { recursive: true });
    const foreignCodex = JSON.stringify({
      executor: {
        transport: {
          type: "stdio",
          command: "/opt/other/executor",
          args: ["mcp"],
          env: null,
        },
      },
    });
    await writeFile(codexStore(world), foreignCodex);
    expect(await ensureAgents(inputOf(world))).toEqual({
      codex: "conflict",
      claude: "conflict",
    });
    expect(await readFile(claudeFile(world), "utf8")).toBe(foreignClaude);
    expect(await readFile(codexStore(world), "utf8")).toBe(foreignCodex);
    for (const name of ["codex.calls", "claude.calls"])
      expect(
        (await world.calls(name)).some((line) => line.startsWith("mcp add")),
      ).toBe(false);
  } finally {
    await world.close();
  }
});

test("a harness that is not installed is absent and nothing runs", async () => {
  const world = await executorWorld({ codex: false, claude: false });
  try {
    expect(await ensureAgents(inputOf(world))).toEqual({
      codex: "absent",
      claude: "absent",
    });
    expect(await world.calls("codex.calls")).toEqual([]);
    expect(await world.calls("claude.calls")).toEqual([]);
  } finally {
    await world.close();
  }
});

test("Codex's entry switched off by the operator stays off; an unreadable Claude configuration is never written", async () => {
  const world = await executorWorld();
  try {
    const entry = join(world.host.bin, "executor");
    await mkdir(join(world.home, ".codex"), { recursive: true });
    await writeFile(
      codexStore(world),
      JSON.stringify({
        executor: {
          enabled: false,
          transport: {
            type: "stdio",
            command: entry,
            args: ["mcp"],
            env: null,
          },
        },
      }),
    );
    await writeFile(claudeFile(world), "{ not json");
    expect(await ensureAgents(inputOf(world))).toEqual({
      codex: "disabled",
      claude: "unknown",
    });
    expect(await readFile(claudeFile(world), "utf8")).toBe("{ not json");
    expect(
      (await world.calls("claude.calls")).some((line) =>
        line.startsWith("mcp add"),
      ),
    ).toBe(false);
  } finally {
    await world.close();
  }
});

test("each harness's own configuration directory is used when the process names one", async () => {
  const world = await executorWorld();
  try {
    const codexHome = join(world.parent, "codex-home");
    const claudeHome = join(world.parent, "claude-home");
    await mkdir(claudeHome);
    const env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
    expect(await ensureAgents(inputOf(world, env))).toEqual({
      codex: "registered",
      claude: "registered",
    });
    expect(
      JSON.parse(await readFile(join(codexHome, "fake-mcp.json"), "utf8")),
    ).toHaveProperty("executor");
    expect(
      JSON.parse(await readFile(join(claudeHome, ".claude.json"), "utf8"))
        .mcpServers,
    ).toHaveProperty("executor");
    expect(
      await readFile(claudeFile(world), "utf8").catch(() => null),
    ).toBeNull();
  } finally {
    await world.close();
  }
});

test("Lazurio's entry is the wrapper with `mcp` over stdio and at most the two switches; anything else is someone else's", () => {
  const entry = "/home/a/.local/bin/executor";
  const own = { type: "stdio", command: entry, args: ["mcp"] };
  expect(isExecutorEntry(own, entry)).toBe("lazurio");
  // Claude Code without a type, Codex with null env and no passthrough.
  expect(isExecutorEntry({ command: entry, args: ["mcp"] }, entry)).toBe(
    "lazurio",
  );
  expect(
    isExecutorEntry({ ...own, env: null, env_vars: [], cwd: null }, entry),
  ).toBe("lazurio");
  // The runbook's registration by hand.
  expect(
    isExecutorEntry(
      {
        ...own,
        env: {
          EXECUTOR_DISABLE_ANALYTICS: "1",
          EXECUTOR_DISABLE_UPDATE_CHECK: "1",
        },
      },
      entry,
    ),
  ).toBe("lazurio");
  for (const other of [
    { ...own, command: "/usr/local/bin/executor" },
    { ...own, args: ["mcp", "--scope", "x"] },
    { ...own, env: { EXECUTOR_DISABLE_ANALYTICS: "0" } },
    { ...own, env: { EXECUTOR_DATA_DIR: "/elsewhere" } },
    { ...own, env_vars: ["HOME"] },
    { ...own, cwd: "/tmp" },
    { type: "http", url: "http://127.0.0.1:4789/mcp" },
    null,
    "executor",
  ])
    expect(isExecutorEntry(other, entry)).toBe("other");
});
