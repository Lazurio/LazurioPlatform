import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrainSetupLabels } from "../src/brain/at-start";
import { initializeFolder } from "../src/folder/initialize-folder";
import { executionOs } from "../src/folder/platform";
import { startLaunchpad } from "../src/launchpad/server";
import { runTool } from "../src/tools/status";
import { type ExecutorWorld, executorWorld } from "./fixtures/fake-executor";

// The brain at the Launchpad's start against the Launchpad's own lifecycle
// (plan LZD-0033 R11a, #1120): a setup that waits for Machines' handover mark
// ends when the Launchpad closes and starts no other setup afterwards, both
// while it sleeps between checks and while a check of the mark is under way.
// The setup is a stand-in that only counts its runs; no brain is touched.

const posix = process.platform !== "win32";

async function until(read: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(10);
  }
}

async function launchpad(
  world: ExecutorWorld,
  brain: Readonly<{
    check: () => Promise<boolean>;
    waitMs: number;
  }>,
) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "launchpad-brain-")),
  );
  const folder = join(parent, "Lazurio");
  await initializeFolder(folder, {
    os: executionOs(process.platform),
    access: "local",
    purpose: "human",
    locale: "cs",
    detail: "concise",
    coordination: "direct",
  });
  const base = join(world.parent, "b");
  await mkdir(join(base, "update"), { recursive: true });
  const runs: BrainSetupLabels[] = [];
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    {
      base,
      version: "1.0.0",
      // Executor's start is not under test: nothing to set up.
      executorAtStart: async () => true,
      brainAtStart: async () => {
        const labels = { server: "waits-machines" };
        runs.push(labels);
        return labels;
      },
      brainHandover: brain,
    },
    {},
    {
      path: "/usr/bin:/bin",
      home: world.home,
      xdg: {},
      platform: process.platform,
      run: runTool,
    },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    world.host,
  );
  return {
    runs,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test.skipIf(!posix)(
  "a Launchpad that closes while the brain waits between checks of the mark starts no other setup, even once the mark is there",
  async () => {
    const world = await executorWorld();
    let marked = false;
    let checks = 0;
    const lp = await launchpad(world, {
      check: async () => {
        checks++;
        return marked;
      },
      // A wait that would end on its own within the test: after it, a check
      // would find the mark and run setup again, unless closing ended it.
      waitMs: 300,
    });
    try {
      await until(() => lp.runs.length === 1);
      marked = true;
      await lp.close();
      await Bun.sleep(600);
      expect(lp.runs).toHaveLength(1);
      expect(checks).toBe(0);
    } finally {
      await world.close();
    }
  },
  60_000,
);

test.skipIf(!posix)(
  "a Launchpad that closes while a check of the mark is under way starts no other setup when that check then finds the mark",
  async () => {
    const world = await executorWorld();
    let answer: (marked: boolean) => void = () => undefined;
    let checks = 0;
    const lp = await launchpad(world, {
      check: () =>
        new Promise<boolean>((resolve) => {
          checks++;
          answer = resolve;
        }),
      waitMs: 1,
    });
    try {
      await until(() => checks === 1);
      await lp.close();
      answer(true);
      await Bun.sleep(200);
      expect(lp.runs).toHaveLength(1);
    } finally {
      await world.close();
    }
  },
  60_000,
);
