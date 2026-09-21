import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  automaticRollback,
  reconcileAsLaunchpad,
  reconcilePending,
  withUpdateLock,
} from "../src/update/activation";
import type { UpdateFailure } from "../src/update/errors";
import {
  layout,
  readHighWater,
  readPrevious,
  readSelector,
  setPrevious,
  swapSelector,
  versionDirectory,
} from "../src/update/layout";
import {
  performAutomaticRollback,
  performRollback,
  performUpdate,
  readStatus,
} from "../src/update/update";
import {
  closeSharedSigstore,
  createWorld,
  executable,
  fakeService,
  type World,
} from "./fixtures/update-world";

// Every row of the table in docs/update.md "Reconciling the marker", for each
// of the three reconcilers: a mutating update command, a starting Launchpad
// and the rollback unit. The outcome depends only on what is on disk.
let world: World;
afterEach(async () => world?.close());
afterAll(closeSharedSigstore);

type Disk = {
  active: string;
  previous?: string;
  pending?: string;
  highWater?: string;
};

/** Put the base into exactly this state; 1.0.0, 1.1.0 and 1.2.0 are staged. */
async function arrange(disk: Disk) {
  world = await createWorld();
  for (const version of ["1.1.0", "1.2.0"]) {
    await mkdir(versionDirectory(world.base, version));
    await writeFile(
      join(versionDirectory(world.base, version), "lazurio"),
      executable(version),
      { mode: 0o500 },
    );
  }
  await swapSelector(world.base, disk.active);
  if (disk.previous) await setPrevious(world.base, disk.previous);
  const { update } = layout(world.base);
  if (disk.pending !== undefined)
    await writeFile(join(update, "pending.json"), disk.pending);
  if (disk.highWater !== undefined)
    await writeFile(join(update, "high-water"), disk.highWater);
}

const marker = (from: string, to: string) => JSON.stringify({ from, to });
const snapshot = async () => ({
  active: await readSelector(world.base),
  previous: await readPrevious(world.base),
  pending: await readFile(layout(world.base).pending, "utf8").catch(() => null),
  highWater: await readFile(layout(world.base).highWater, "utf8").catch(
    () => null,
  ),
  versions: (await readdir(layout(world.base).versions)).sort(),
});
const underLock = <T>(operation: () => Promise<T>) =>
  withUpdateLock(world.base, 0, operation);

test("row 1 — no marker: every reconciler proceeds and touches nothing", async () => {
  await arrange({ active: "1.1.0", previous: "1.0.0" });
  const before = await snapshot();
  const service = fakeService(world.base);
  expect(
    await underLock(() => reconcilePending({ base: world.base, service })),
  ).toBe("none");
  expect(
    await reconcileAsLaunchpad({ base: world.base, version: "1.1.0" }),
  ).toBe("none");
  expect(await automaticRollback({ base: world.base, service })).toBe("none");
  expect(await snapshot()).toEqual(before);
  expect(service.restarts).toBe(0);
});

test("row 2 — valid marker, selector on `from`: the marker is stale and is deleted", async () => {
  // Crashed before the switch (previous already points at `from`) …
  await arrange({
    active: "1.0.0",
    previous: "1.0.0",
    pending: marker("1.0.0", "1.1.0"),
  });
  const service = fakeService(world.base);
  // … the rollback unit does nothing in this row, not even cleaning up.
  expect(await automaticRollback({ base: world.base, service })).toBe("none");
  expect((await snapshot()).pending).not.toBeNull();
  expect(
    await underLock(() => reconcilePending({ base: world.base, service })),
  ).toBe("discarded");
  expect(await snapshot()).toMatchObject({
    active: "1.0.0",
    pending: null,
    highWater: null,
  });
  expect(service.restarts).toBe(0);

  // … or after an undo, with any `previous`: a starting Launchpad deletes it.
  await world.close();
  await arrange({
    active: "1.0.0",
    previous: "1.2.0",
    pending: marker("1.0.0", "1.1.0"),
  });
  expect(
    await reconcileAsLaunchpad({ base: world.base, version: "1.0.0" }),
  ).toBe("discarded");
  expect(await snapshot()).toMatchObject({
    active: "1.0.0",
    previous: "1.2.0",
    pending: null,
  });
});

const switched: Disk = {
  active: "1.1.0",
  previous: "1.0.0",
  pending: marker("1.0.0", "1.1.0"),
};

test("row 3 — switched, not committed: a healthy Launchpad of `to` commits", async () => {
  await arrange(switched);
  // A Launchpad of any other version leaves it alone.
  expect(
    await reconcileAsLaunchpad({ base: world.base, version: "1.0.0" }),
  ).toBe("none");
  expect((await snapshot()).pending).not.toBeNull();
  expect(
    await reconcileAsLaunchpad({ base: world.base, version: "1.1.0" }),
  ).toBe("committed");
  // Commit: the mark is raised, the marker deleted, older versions pruned.
  expect(await snapshot()).toEqual({
    active: "1.1.0",
    previous: "1.0.0",
    pending: null,
    highWater: "1.1.0\n",
    versions: ["1.0.0", "1.1.0"],
  });
});

test("row 3 — while an updater holds the lock, the Launchpad and the rollback unit wait or do nothing", async () => {
  await arrange(switched);
  const service = fakeService(world.base);
  await underLock(async () => {
    expect(await automaticRollback({ base: world.base, service })).toBe("none");
    const waited = await reconcileAsLaunchpad({
      base: world.base,
      version: "1.1.0",
      lockTimeoutMs: 100,
    }).catch((error: unknown) => error);
    expect((waited as UpdateFailure).failure.code).toBe("busy");
  });
  expect((await snapshot()).pending).not.toBeNull();
});

test("row 3 — the rollback unit undoes: switch back, restart, delete the marker", async () => {
  await arrange(switched);
  const service = fakeService(world.base);
  expect(await performAutomaticRollback({ base: world.base, service })).toEqual(
    { kind: "reconciled", outcome: "undone" },
  );
  expect(service).toMatchObject({ restarts: 1, running: "1.0.0" });
  // An undone activation never raised the mark.
  expect(await snapshot()).toMatchObject({
    active: "1.0.0",
    pending: null,
    highWater: null,
  });
});

test("row 3 — a mutating command asks the service once: healthy at `to` commits, and the command continues", async () => {
  await arrange(switched);
  await world.release("1.1.0");
  const service = fakeService(world.base);
  service.running = "1.1.0";
  expect(
    await performUpdate(world.environment("1.1.0", { service })),
  ).toMatchObject({ kind: "up-to-date" });
  expect(await snapshot()).toMatchObject({
    active: "1.1.0",
    pending: null,
    highWater: "1.1.0\n",
  });
  expect(service.restarts).toBe(0);
});

test("row 3 — anything else undoes, and the command then does what was asked", async () => {
  await arrange(switched);
  await world.release("1.2.0");
  // The Launchpad of 1.1.0 is alive but not healthy; 1.2.0 will be.
  const service = fakeService(world.base, { unhealthy: ["1.1.0"] });
  service.running = "1.1.0";
  expect(
    await performUpdate(world.environment("1.1.0", { service })),
  ).toMatchObject({ kind: "updated", from: "1.0.0", to: "1.2.0" });
  // Undo restarted 1.0.0; the fresh activation restarted 1.2.0.
  expect(service).toMatchObject({ restarts: 2, running: "1.2.0" });
  expect(await snapshot()).toMatchObject({
    active: "1.2.0",
    previous: "1.0.0",
    pending: null,
    highWater: "1.2.0\n",
  });

  // `update rollback` on the same state: the undo was the way back, and what
  // remains — previous equals active — is honestly "nothing to roll back to".
  await world.close();
  await arrange(switched);
  const other = fakeService(world.base, { unhealthy: ["1.1.0"] });
  expect(
    await performRollback(world.environment("1.1.0", { service: other })),
  ).toMatchObject({
    code: "rollback-unavailable",
    context: { reason: "none" },
  });
  expect(await snapshot()).toMatchObject({ active: "1.0.0", pending: null });
});

const invalidStates: Record<string, Disk & { path: string }> = {
  "row 4 — selector on `to`, previous not `from`": {
    active: "1.1.0",
    previous: "1.2.0",
    pending: marker("1.0.0", "1.1.0"),
    path: "update/pending.json",
  },
  "row 4 — selector on `to`, no previous": {
    active: "1.1.0",
    pending: marker("1.0.0", "1.1.0"),
    path: "update/pending.json",
  },
  "row 5 — selector on neither": {
    active: "1.2.0",
    previous: "1.0.0",
    pending: marker("1.0.0", "1.1.0"),
    path: "update/pending.json",
  },
  "row 6 — unreadable marker": {
    active: "1.1.0",
    previous: "1.0.0",
    pending: '{"from":"1.0.0","to":',
    path: "update/pending.json",
  },
  "row 6 — wrong schema": {
    active: "1.1.0",
    previous: "1.0.0",
    pending: JSON.stringify({ from: "1.0.0", to: "latest" }),
    path: "update/pending.json",
  },
  "an unreadable high-water mark": {
    active: "1.1.0",
    previous: "1.0.0",
    highWater: "not a version\n",
    path: "update/high-water",
  },
};

for (const [name, state] of Object.entries(invalidStates))
  test(`${name}: state-invalid — never cleared, rewritten or guessed`, async () => {
    const { path, ...disk } = state;
    await arrange(disk);
    await world.release("1.2.0");
    const before = await snapshot();
    const service = fakeService(world.base);
    const environment = world.environment("1.1.0", { service });
    // Mutating commands refuse, naming the offending path.
    for (const result of [
      await performUpdate(environment),
      await performUpdate(environment, "1.2.0"),
      await performRollback(environment),
    ])
      expect(result).toEqual({
        kind: "error",
        code: "state-invalid",
        context: { path },
      });
    // The rollback unit and a starting Launchpad do nothing about it either.
    if (disk.pending !== undefined) {
      expect(
        await performAutomaticRollback({ base: world.base, service }),
      ).toMatchObject({ code: "state-invalid" });
      const launchpad = await reconcileAsLaunchpad({
        base: world.base,
        version: "1.1.0",
      }).catch((error: unknown) => error);
      expect((launchpad as UpdateFailure).failure.code).toBe("state-invalid");
    }
    expect(await snapshot()).toEqual(before);
    expect(service.restarts).toBe(0);
    // The product keeps running what the selector names, and status shows it.
    expect(await readStatus(environment)).toMatchObject({
      active: disk.active,
      stateInvalid: path,
      updateAvailable: false,
    });
    // Resolved by a person: remove the offending file, and updates work again.
    await rm(join(world.base, path));
    expect((await performUpdate(environment)).kind).toBe(
      disk.active === "1.2.0" ? "up-to-date" : "updated",
    );
  });

// Every reconciler reads and validates the WHOLE state before it decides: a
// switched marker that would otherwise be committed or undone is not touched
// while the high-water mark is unreadable.
test("a valid switched marker beside an unreadable high-water mark: every reconciler answers state-invalid and changes nothing", async () => {
  await arrange({ ...switched, highWater: "\u0000garbage" });
  await world.release("1.2.0");
  const before = await snapshot();
  const calls: string[] = [];
  // Healthy at `to`: without the validation a command would commit, the
  // Launchpad would commit and the rollback unit would undo.
  const service = {
    folder: undefined,
    async restartLaunchpad() {
      calls.push("restart");
    },
    async launchpadVersion() {
      calls.push("health");
      return "1.1.0";
    },
  };
  const environment = world.environment("1.1.0", { service });
  const refusal = {
    kind: "error",
    code: "state-invalid",
    context: { path: "update/high-water" },
  } as const;
  // The rollback unit …
  expect(await performAutomaticRollback({ base: world.base, service })).toEqual(
    refusal,
  );
  expect(await snapshot()).toEqual(before);
  // … every mutating update command …
  for (const result of [
    await performUpdate(environment),
    await performUpdate(environment, "1.2.0"),
    await performRollback(environment),
  ])
    expect(result).toEqual(refusal);
  expect(await snapshot()).toEqual(before);
  // … and a starting Launchpad of `to`.
  const launchpad = await reconcileAsLaunchpad({
    base: world.base,
    version: "1.1.0",
  }).catch((error: unknown) => error);
  expect((launchpad as UpdateFailure).failure).toEqual({
    code: "state-invalid",
    context: { path: "update/high-water" },
  });
  // Selector, previous, marker and mark byte-identical; no service call at all.
  expect(await snapshot()).toEqual(before);
  expect(calls).toEqual([]);
  expect(world.origin.requests).toEqual([]);
  expect(await readStatus(environment)).toMatchObject({
    active: "1.1.0",
    stateInvalid: "update/high-water",
    updateAvailable: false,
  });
  // A person removes the unreadable mark; the marker is then decided as usual.
  await rm(layout(world.base).highWater);
  expect(await performAutomaticRollback({ base: world.base, service })).toEqual(
    { kind: "reconciled", outcome: "undone" },
  );
  expect(calls).toEqual(["restart"]);
});

test("a missing high-water mark means the floor is the active version", async () => {
  await arrange({ active: "1.1.0", previous: "1.0.0" });
  await world.release("1.0.0");
  expect(await readHighWater(world.base)).toBeNull();
  expect(
    await performUpdate(world.environment("1.1.0"), "1.0.0"),
  ).toMatchObject({
    code: "release-invalid",
    context: { reason: "below-floor" },
  });
  expect((await performUpdate(world.environment("1.1.0"))).kind).toBe(
    "up-to-date",
  );
  expect(await readSelector(world.base)).toBe("1.1.0");
});
