import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activatableTools } from "../src/tools/catalog";
import { readToolsLive } from "../src/tools/overview";
import {
  boundedAll,
  type ToolRunner,
  toolsReadAtOnce,
  toolsStatus,
} from "../src/tools/status";

// How many tools are read at once (plan DEV-6656, decided on 2026-10-20): one
// after another was too slow, every tool at once starts several Node CLIs
// together on an Environment with little memory left. Three at a time, and
// a tool's sign-in takes its place right after its own version.

test("three tools at a time", () => {
  expect(toolsReadAtOnce).toBe(3);
});

test("boundedAll keeps the items' order and never runs more than its bound", async () => {
  let running = 0;
  let most = 0;
  const answers = await boundedAll([5, 1, 4, 2, 3, 1, 2], 3, async (ms) => {
    running += 1;
    most = Math.max(most, running);
    await Bun.sleep(ms * 5);
    running -= 1;
    return ms * 10;
  });
  expect(answers).toEqual([50, 10, 40, 20, 30, 10, 20]);
  expect(most).toBe(3);
  expect(await boundedAll([], 3, async () => 1)).toEqual([]);
  // A failing item fails the whole, as one Promise.all would.
  await expect(
    boundedAll([1, 2], 3, async (item) => {
      if (item === 2) throw new Error("refused");
      return item;
    }),
  ).rejects.toThrow("refused");
});

// Every activatable tool on PATH; each command holds its place a moment and
// is recorded as it starts and ends.
async function world() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "tools-at-once-")),
  );
  const bin = join(parent, "bin");
  await mkdir(bin);
  for (const entry of activatableTools()) {
    await writeFile(join(bin, entry.command), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, entry.command), 0o755);
  }
  const events: Array<{ at: "start" | "end"; tool: string; version: boolean }> =
    [];
  const toolOf = (path: string) =>
    activatableTools().find((entry) => path === join(bin, entry.command))
      ?.name ?? path;
  const run: ToolRunner = async (command) => {
    const tool = toolOf(String(command[0]));
    const version = command.length === 2 && /version/.test(String(command[1]));
    events.push({ at: "start", tool, version });
    await Bun.sleep(30);
    events.push({ at: "end", tool, version });
    return { exitCode: 1, stdout: "", stderr: "" };
  };
  return {
    environment: {
      path: bin,
      home: parent,
      platform: process.platform,
      run,
      xdg: {},
    },
    events,
    close: () => rm(parent, { recursive: true, force: true }),
  };
}

// The most tools in their place at once: from their version's start to the
// end of their last command.
function mostAtOnce(
  events: ReadonlyArray<{ at: "start" | "end"; tool: string }>,
) {
  const last = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.at === "end") last.set(event.tool, index);
  });
  const placed = new Set<string>();
  let most = 0;
  events.forEach((event, index) => {
    if (event.at === "start") placed.add(event.tool);
    most = Math.max(most, placed.size);
    if (event.at === "end" && last.get(event.tool) === index)
      placed.delete(event.tool);
  });
  return most;
}

test.skipIf(process.platform === "win32")(
  "the Launchpad's reading holds at most three tools at a time, each tool's sign-in in its own place right after its version",
  async () => {
    const w = await world();
    try {
      const live = await readToolsLive(w.environment, true);
      expect(live.status.tools.map((tool) => tool.name)).toEqual(
        activatableTools().map((entry) => entry.name),
      );
      expect(live.signIns?.length).toBe(activatableTools().length);
      expect(mostAtOnce(w.events)).toBe(toolsReadAtOnce);
      // A tool's sign-in starts once its version has ended, with no other
      // tool's version started in between in that place.
      const probed = activatableTools().filter(
        (entry) => entry.signInProbe !== undefined,
      );
      for (const entry of probed) {
        const versionEnd = w.events.findIndex(
          (event) =>
            event.tool === entry.name && event.at === "end" && event.version,
        );
        const signInStart = w.events.findIndex(
          (event) =>
            event.tool === entry.name && event.at === "start" && !event.version,
        );
        expect([entry.name, versionEnd < signInStart]).toEqual([
          entry.name,
          true,
        ]);
        const between = w.events
          .slice(versionEnd + 1, signInStart)
          .filter((event) => event.at === "start" && event.version);
        expect([entry.name, between]).toEqual([entry.name, []]);
      }
    } finally {
      await w.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "`tools status` reads at most three tools at a time, in catalog order",
  async () => {
    const w = await world();
    try {
      const result = await toolsStatus({
        ...w.environment,
        catalog: activatableTools(),
      });
      expect(result.tools.map((tool) => tool.name)).toEqual(
        activatableTools().map((entry) => entry.name),
      );
      expect(w.events.every((event) => event.version)).toBe(true);
      expect(mostAtOnce(w.events)).toBe(toolsReadAtOnce);
    } finally {
      await w.close();
    }
  },
);
