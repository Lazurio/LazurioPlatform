import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withUpdateLock } from "../src/update/activation";
import { renderLaunchpadUnit } from "../src/update/install";
import {
  layout,
  readHighWater,
  readSelector,
  swapSelector,
  versionDirectory,
} from "../src/update/layout";
import { removeRollbackLeftovers } from "../src/update/migrations/remove-rollback";
import {
  launchpadUnit,
  type ServiceUnits,
  unitMarker,
} from "../src/update/service-control";
import { performUpdate, readStatus } from "../src/update/update";
import {
  closeSharedSigstore,
  createWorld,
  executable,
  fakeService,
  readLegacyRollbackState,
  type World,
  writeLegacyRollbackState,
} from "./fixtures/update-world";

// The reconcile table WITHOUT undo (migration "remove rollback"): what a
// v0.1.x installation left for rollback — the activation marker, `previous`,
// the rollback unit — is converged forward by the first mutating command of
// a release without rollback. The outcome depends only on what is on disk,
// and no row ever selects an earlier version.
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
  await writeLegacyRollbackState(world.base, disk);
  if (disk.highWater !== undefined)
    await writeFile(layout(world.base).highWater, disk.highWater);
}

const marker = (from: string, to: string) => JSON.stringify({ from, to });
const snapshot = async () => ({
  active: await readSelector(world.base),
  ...(await readLegacyRollbackState(world.base)),
  highWater: await readFile(layout(world.base).highWater, "utf8").catch(
    () => null,
  ),
  versions: (await readdir(layout(world.base).versions)).sort(),
});
const migrate = (service: ReturnType<typeof fakeService> | null) =>
  withUpdateLock(world.base, 0, () =>
    removeRollbackLeftovers({ base: world.base, service, units: null }),
  );

test("row 1 — nothing left: the migration touches nothing", async () => {
  await arrange({ active: "1.1.0" });
  const before = await snapshot();
  const service = fakeService(world.base);
  expect(await migrate(service)).toEqual({
    marker: "none",
    to: null,
    rollbackUnitRemoved: false,
    launchpadUnitRewritten: false,
    previousRemoved: false,
  });
  expect(await snapshot()).toEqual(before);
  expect(service.restarts).toBe(0);
  expect(
    await readStatus(world.environment("1.1.0", { service })),
  ).toMatchObject({ legacyRollbackState: false, stateInvalid: null });
});

test("row 2 — marker with the selector on `from`: deleted; the retained previous version goes too", async () => {
  await arrange({
    active: "1.0.0",
    previous: "1.0.0",
    pending: marker("1.0.0", "1.1.0"),
  });
  const service = fakeService(world.base);
  expect(
    await readStatus(world.environment("1.0.0", { service })),
  ).toMatchObject({ legacyRollbackState: true, stateInvalid: null });
  expect(await migrate(service)).toMatchObject({
    marker: "discarded",
    previousRemoved: true,
  });
  expect(await snapshot()).toEqual({
    active: "1.0.0",
    previous: null,
    pending: null,
    highWater: null,
    // Only the active version is kept.
    versions: ["1.0.0"],
  });
  expect(service.restarts).toBe(0);
  expect(
    await readStatus(world.environment("1.0.0", { service })),
  ).toMatchObject({ legacyRollbackState: false });
});

const switched: Disk = {
  active: "1.1.0",
  previous: "1.0.0",
  pending: marker("1.0.0", "1.1.0"),
};

test("row 3 — switched, its Launchpad healthy at `to`: finished forward, the mark raised", async () => {
  await arrange(switched);
  await world.release("1.1.0");
  const service = fakeService(world.base);
  service.running = "1.1.0";
  // The mutating command runs the migration first and then does its work.
  expect(
    await performUpdate(world.environment("1.1.0", { service })),
  ).toMatchObject({ kind: "up-to-date" });
  expect(await snapshot()).toEqual({
    active: "1.1.0",
    previous: null,
    pending: null,
    highWater: "1.1.0\n",
    versions: ["1.1.0"],
  });
  expect(service.restarts).toBe(0);
});

test("row 3 — switched, its Launchpad NOT healthy: nothing is undone; `to` stays active and the update says activation-unhealthy", async () => {
  await arrange(switched);
  await world.release("1.1.0");
  const service = fakeService(world.base, { unhealthy: ["1.1.0"] });
  service.running = "1.1.0";
  expect(await performUpdate(world.environment("1.1.0", { service }))).toEqual({
    kind: "error",
    code: "activation-unhealthy",
    context: { to: "1.1.0", stage: "legacy-marker" },
  });
  // The selector never moved back, no restart ran, the floor is `to`.
  expect(await snapshot()).toEqual({
    active: "1.1.0",
    previous: null,
    pending: null,
    highWater: "1.1.0\n",
    versions: ["1.1.0"],
  });
  expect(service).toMatchObject({ restarts: 0, running: "1.1.0" });
  // The repeat changes nothing and no longer knows of a marker.
  expect(
    await performUpdate(world.environment("1.1.0", { service })),
  ).toMatchObject({ kind: "up-to-date" });
});

test("row 3 — switched and unhealthy, a newer release exists: the update repairs forward", async () => {
  await arrange(switched);
  await world.release("1.2.0");
  const service = fakeService(world.base, { unhealthy: ["1.1.0"] });
  service.running = "1.1.0";
  expect(
    await performUpdate(world.environment("1.1.0", { service })),
  ).toMatchObject({ kind: "updated", from: "1.1.0", to: "1.2.0" });
  // One restart: the fresh activation's, never one of an earlier version.
  expect(service).toMatchObject({ restarts: 1, running: "1.2.0" });
  expect(await snapshot()).toEqual({
    active: "1.2.0",
    previous: null,
    pending: null,
    highWater: "1.2.0\n",
    versions: ["1.2.0"],
  });
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
    for (const result of [
      await performUpdate(environment),
      await performUpdate(environment, "1.2.0"),
    ])
      expect(result).toEqual({
        kind: "error",
        code: "state-invalid",
        context: { path },
      });
    expect(await snapshot()).toEqual(before);
    expect(service.restarts).toBe(0);
    expect(await readStatus(environment)).toMatchObject({
      active: disk.active,
      stateInvalid: path,
      legacyRollbackState: true,
      updateAvailable: false,
    });
    // Resolved by a person: remove the offending file, and updates work again
    // — forward, from the version the selector names.
    await rm(join(world.base, path));
    expect((await performUpdate(environment)).kind).toBe(
      disk.active === "1.2.0" ? "up-to-date" : "updated",
    );
    expect(await readSelector(world.base)).toBe("1.2.0");
    expect(await readLegacyRollbackState(world.base)).toEqual({
      previous: null,
      pending: null,
    });
  });

// The migration reads and validates the WHOLE state before it decides: a
// switched marker is not touched while the high-water mark is unreadable, and
// the service is not even asked.
test("a switched marker beside an unreadable high-water mark: state-invalid, no service call, nothing changed", async () => {
  await arrange({ ...switched, highWater: "\u0000garbage" });
  const before = await snapshot();
  const calls: string[] = [];
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
  expect(await performUpdate(world.environment("1.1.0", { service }))).toEqual({
    kind: "error",
    code: "state-invalid",
    context: { path: "update/high-water" },
  });
  expect(await snapshot()).toEqual(before);
  expect(calls).toEqual([]);
  expect(world.origin.requests).toEqual([]);
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

/** The units `lazurio install --service systemd-user` of v0.1.x wrote,
 * byte for byte. */
const legacyLaunchpadUnit = (base: string, folder: string) =>
  [
    unitMarker,
    "[Unit]",
    "Description=Lazurio Launchpad",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "OnFailure=lazurio-rollback.service",
    "",
    "[Service]",
    `ExecStart=${base}/bin/lazurio launchpad --base ${base} --folder ${folder}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
    "[X-Lazurio]",
    `Folder=${folder}`,
    "",
  ].join("\n");
const legacyRollbackUnit = (base: string) =>
  [
    unitMarker,
    "[Unit]",
    "Description=Lazurio rollback of an interrupted activation",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${base}/previous/lazurio update rollback --auto --base ${base}`,
    "",
  ].join("\n");

async function unitScene() {
  const directory = join(world.root, "units");
  await mkdir(directory);
  const reloads: number[] = [];
  const units: ServiceUnits = {
    directory,
    async reload() {
      reloads.push(1);
      return true;
    },
  };
  return { directory, units, reloads };
}

test("an installation with the rollback unit and a previous version: the rollback unit is deleted, the Launchpad unit rewritten, the previous version removed; nothing restarts", async () => {
  await arrange({ active: "1.1.0", previous: "1.0.0", highWater: "1.1.0\n" });
  const { directory, units, reloads } = await unitScene();
  const folder = join(world.root, "Lazurio");
  await writeFile(
    join(directory, launchpadUnit),
    legacyLaunchpadUnit(world.base, folder),
  );
  await writeFile(
    join(directory, "lazurio-rollback.service"),
    legacyRollbackUnit(world.base),
  );
  const service = fakeService(world.base, { folder });
  service.running = "1.1.0";
  const environment = world.environment("1.1.0", { service, units });
  expect(await readStatus(environment)).toMatchObject({
    legacyRollbackState: true,
  });
  await world.release("1.1.0");
  expect(await performUpdate(environment)).toMatchObject({
    kind: "up-to-date",
  });
  expect((await readdir(directory)).sort()).toEqual([launchpadUnit]);
  expect(await readFile(join(directory, launchpadUnit), "utf8")).toBe(
    renderLaunchpadUnit(world.base, folder),
  );
  // The manager rereads the units once; the Launchpad is not restarted.
  expect(reloads).toEqual([1]);
  expect(service.restarts).toBe(0);
  expect(await snapshot()).toEqual({
    active: "1.1.0",
    previous: null,
    pending: null,
    highWater: "1.1.0\n",
    versions: ["1.1.0"],
  });
  const status = await readStatus(environment);
  expect(status).toMatchObject({ legacyRollbackState: false });
  expect(Object.keys(status)).not.toContain("previous");
  // Converged: a second run finds nothing to do.
  expect(
    await withUpdateLock(world.base, 0, () =>
      removeRollbackLeftovers({ base: world.base, service, units }),
    ),
  ).toEqual({
    marker: "none",
    to: null,
    rollbackUnitRemoved: false,
    launchpadUnitRewritten: false,
    previousRemoved: false,
  });
  expect(reloads).toEqual([1]);
});

test("units the installer did not write, or wrote for another install base, stay", async () => {
  await arrange({ active: "1.1.0" });
  const { directory, units, reloads } = await unitScene();
  const folder = join(world.root, "Lazurio");
  const foreignRollback = "[Service]\nExecStart=/bin/true\n";
  const otherBase = legacyLaunchpadUnit(join(world.root, "other"), folder);
  await writeFile(join(directory, "lazurio-rollback.service"), foreignRollback);
  await writeFile(join(directory, launchpadUnit), otherBase);
  expect(
    await withUpdateLock(world.base, 0, () =>
      removeRollbackLeftovers({ base: world.base, service: null, units }),
    ),
  ).toMatchObject({
    rollbackUnitRemoved: false,
    launchpadUnitRewritten: false,
  });
  expect(
    await readFile(join(directory, "lazurio-rollback.service"), "utf8"),
  ).toBe(foreignRollback);
  expect(await readFile(join(directory, launchpadUnit), "utf8")).toBe(
    otherBase,
  );
  expect(reloads).toEqual([]);
});

test("the installer's rollback unit of another install base stays: it is that installation's to converge", async () => {
  await arrange({ active: "1.1.0", previous: "1.0.0", highWater: "1.1.0\n" });
  const { directory, units, reloads } = await unitScene();
  const otherRollback = legacyRollbackUnit(join(world.root, "other"));
  await writeFile(join(directory, "lazurio-rollback.service"), otherRollback);
  expect(await readStatus(world.environment("1.1.0", { units }))).toMatchObject(
    { legacyRollbackState: true },
  );
  expect(
    await withUpdateLock(world.base, 0, () =>
      removeRollbackLeftovers({ base: world.base, service: null, units }),
    ),
  ).toMatchObject({
    rollbackUnitRemoved: false,
    launchpadUnitRewritten: false,
    previousRemoved: true,
  });
  expect(await readdir(directory)).toEqual(["lazurio-rollback.service"]);
  expect(
    await readFile(join(directory, "lazurio-rollback.service"), "utf8"),
  ).toBe(otherRollback);
  expect(reloads).toEqual([]);
  // Only another base's unit is left: nothing of THIS base's rollback remains.
  expect(await readStatus(world.environment("1.1.0", { units }))).toMatchObject(
    { legacyRollbackState: false },
  );
});
