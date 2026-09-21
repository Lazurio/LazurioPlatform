import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivationStep } from "../src/update/activation";
import {
  layout,
  readHighWater,
  readPending,
  readPrevious,
  readSelector,
  versionDirectory,
} from "../src/update/layout";
import { performUpdate, readStatus } from "../src/update/update";
import {
  closeSharedSigstore,
  createWorld,
  executable,
  fakeService,
  type World,
} from "./fixtures/update-world";

// A real process runs a real activation and is killed by SIGKILL after each
// durable step (docs/update.md "Evidence required": kill at every activation
// step). Whatever it left, the next command converges without manual repair.
let world: World;
afterEach(async () => world?.close());
afterAll(closeSharedSigstore);

async function killedAfter(step: ActivationStep, supervised: boolean) {
  world = await createWorld();
  await world.release("1.1.0");
  await mkdir(versionDirectory(world.base, "1.1.0"));
  await writeFile(
    join(versionDirectory(world.base, "1.1.0"), "lazurio"),
    executable("1.1.0"),
    { mode: 0o500 },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/update-kill.ts", import.meta.url).pathname,
      world.base,
      "1.1.0",
      supervised ? "supervised" : "unsupervised",
      step,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  await child.exited;
  expect([step, child.signalCode]).toEqual([step, "SIGKILL"]);
  return {
    active: await readSelector(world.base),
    previous: await readPrevious(world.base),
    pending: await readPending(world.base),
    highWater: await readHighWater(world.base),
  };
}

const supervisedSteps: Record<string, object> = {
  previous: { active: "1.0.0", pending: null, highWater: null },
  pending: { active: "1.0.0", pending: { from: "1.0.0", to: "1.1.0" } },
  switch: { active: "1.1.0", pending: { from: "1.0.0", to: "1.1.0" } },
  restarted: { active: "1.1.0", pending: { from: "1.0.0", to: "1.1.0" } },
  // Killed inside the commit: the mark is raised, the marker still there.
  "high-water": {
    active: "1.1.0",
    pending: { from: "1.0.0", to: "1.1.0" },
    highWater: "1.1.0",
  },
};

for (const [step, left] of Object.entries(supervisedSteps))
  for (const healthy of [true, false])
    test(`supervised, killed after "${step}", Launchpad ${healthy ? "healthy" : "not healthy"} afterwards: the next update converges`, async () => {
      expect(await killedAfter(step as ActivationStep, true)).toMatchObject({
        previous: "1.0.0",
        highWater: null,
        ...left,
      });
      const switchedBefore = (await readSelector(world.base)) === "1.1.0";
      // After the crash the unit runs whatever the selector names.
      const service = fakeService(world.base, {
        unhealthy: healthy ? [] : ["1.1.0"],
      });
      service.running = await readSelector(world.base);
      const status = await readStatus(world.environment("1.0.0", { service }));
      expect(status.stateInvalid).toBeNull();
      // The kernel released the dead updater's lock: no `busy`, no repair.
      const result = await performUpdate(
        world.environment("1.0.0", { service, healthDeadlineMs: 200 }),
      );
      const committed = {
        active: "1.1.0",
        previous: "1.0.0",
        pending: null,
        highWater: "1.1.0",
      };
      const undone = { active: "1.0.0", previous: "1.0.0", pending: null };
      if (healthy) {
        // Reconciled by committing, or never switched and activated afresh.
        expect(result.kind).toBe(switchedBefore ? "up-to-date" : "updated");
        expect(await disk()).toMatchObject(committed);
      } else {
        // Undone — by the reconcile, and again by the fresh attempt.
        expect(result).toMatchObject({ code: "activation-failed" });
        expect(await disk()).toMatchObject(undone);
        expect(service.running).toBe("1.0.0");
      }
      expect(await readdir(layout(world.base).update)).not.toContain(
        "pending.json",
      );
    });

const disk = async () => ({
  active: await readSelector(world.base),
  previous: await readPrevious(world.base),
  pending: await readPending(world.base),
  highWater: await readHighWater(world.base),
});

const unsupervisedSteps: Record<string, object> = {
  previous: { active: "1.0.0", highWater: null },
  // The switch is the commit; only the mark may be missing, and a missing
  // mark means the floor is the active version.
  switch: { active: "1.1.0", highWater: null },
  "high-water": { active: "1.1.0", highWater: "1.1.0" },
};

for (const [step, left] of Object.entries(unsupervisedSteps))
  test(`unsupervised, killed after "${step}": no marker exists and the next update converges`, async () => {
    expect(await killedAfter(step as ActivationStep, false)).toMatchObject({
      previous: "1.0.0",
      pending: null,
      ...left,
    });
    await world.release("1.2.0");
    expect(
      await performUpdate(
        world.environment((await readSelector(world.base)) as string),
      ),
    ).toMatchObject({ kind: "updated", to: "1.2.0" });
    expect(await disk()).toMatchObject({
      active: "1.2.0",
      pending: null,
      highWater: "1.2.0",
    });
  });
