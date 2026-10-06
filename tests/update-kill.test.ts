import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActivationStep } from "../src/update/activation";
import {
  layout,
  readHighWater,
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
// step (docs/update.md "Evidence required": kill at every activation step).
// Whatever it left, the next command converges forward without manual repair.
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
    highWater: await readHighWater(world.base),
  };
}

// The switch is ONE rename and the commit: whatever step the updater died
// after, the selector names 1.1.0 and nothing is ever undone. Only the mark
// may be missing, and a missing mark means the floor is the active version.
const steps: Record<ActivationStep, object> = {
  switch: { active: "1.1.0", highWater: null },
  "high-water": { active: "1.1.0", highWater: "1.1.0" },
  restarted: { active: "1.1.0", highWater: "1.1.0" },
};

for (const supervised of [true, false])
  for (const [step, left] of Object.entries(steps)) {
    if (!supervised && step === "restarted") continue;
    test(`${supervised ? "supervised" : "unsupervised"}, killed after "${step}": no marker exists, nothing is undone, and the next update converges forward`, async () => {
      expect(
        await killedAfter(step as ActivationStep, supervised),
      ).toMatchObject(left);
      expect((await readdir(world.base)).sort()).toEqual([
        "bin",
        "update",
        "versions",
      ]);
      // After the crash the unit runs whatever the selector names.
      const service = supervised ? fakeService(world.base) : null;
      if (service) service.running = await readSelector(world.base);
      const environment = (running: string) =>
        world.environment(running, { service, healthDeadlineMs: 200 });
      expect((await readStatus(environment("1.1.0"))).stateInvalid).toBeNull();
      // The kernel released the dead updater's lock: no `busy`, no repair.
      expect(await performUpdate(environment("1.1.0"))).toMatchObject({
        kind: "up-to-date",
      });
      expect(service?.restarts ?? 0).toBe(0);
      await world.release("1.2.0");
      expect(await performUpdate(environment("1.1.0"))).toMatchObject({
        kind: "updated",
        from: "1.1.0",
        to: "1.2.0",
      });
      expect(await disk()).toEqual({
        active: "1.2.0",
        highWater: "1.2.0",
        versions: ["1.2.0"],
      });
    });
  }

const disk = async () => ({
  active: await readSelector(world.base),
  highWater: await readHighWater(world.base),
  versions: (await readdir(layout(world.base).versions)).sort(),
});
