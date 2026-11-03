import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assignedEnvironments } from "../src/folder/machine-binding";
import { withEnvironmentSsh } from "../src/machine/cli";
import { hostedOperatorFolder } from "../src/machine/operator";
import { acquireFileLock } from "../src/platform/flock";
import type {
  AccessServiceFetch,
  AccessServiceLocation,
} from "../src/ssh-access/access-service";
import {
  type EnvironmentRoute,
  recordedRoutes,
  writeEnvironmentRoutes,
  writeEnvironmentSsh,
} from "../src/ssh-access/environments";
import {
  expireRoutes,
  liveRoutesSource,
  type RoutesDeclaration,
  type RoutesSource,
  routesLockPath,
  routesSourceOf,
  runEnvironmentRoutes,
  syncEnvironmentRoutes,
} from "../src/ssh-access/routes";
import { runTool } from "../src/tools/status";
import { type CliContext, routesAtStart } from "../src/update/cli";
import { embeddedIdentity } from "../src/update/identity";
import { renderLaunchpadUnit } from "../src/update/install";
import { launchpadUnit } from "../src/update/service-control";
import { binding, bindings } from "./fixtures/machine-bindings";
import assignedHandover from "./fixtures/machine-context-personal-assigned.json";

// The Launchpad's live loop of the routes and its writers (root decision
// 0224; decision F70, amendment of 2026-11-03, points 4 to 6; reviews of
// #833): every tick reads the handover's declaration again; a writer writes
// only under the routes lock and only for the declaration still current, so
// a late answer of an old origin never overwrites a newer writer; and
// without a declaration, or with a handover that cannot be read, a tick only
// lets expired routes go, on a personal and a work Machine alike. The
// service is a fake `fetch`, the files are real, in a temporary home; every
// fixture is synthetic.

const service = (origin: string): AccessServiceLocation => ({ origin });
const declared = (origin: string): RoutesDeclaration => ({
  kind: "declared",
  service: service(origin),
});
const originA = "http://host-a.tailnet.example.invalid:8444";
const originB = "http://host-b.tailnet.example.invalid:8444";

function harness(read: () => RoutesDeclaration) {
  let tick: (() => void) | undefined;
  let cleared = false;
  const asked: string[] = [];
  let expired = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const stop = runEnvironmentRoutes(
    async () => read(),
    async (location) => {
      asked.push(location.origin);
      if (hold) await new Promise<void>((resolve) => (release = resolve));
    },
    async () => {
      expired += 1;
    },
    {
      everyMs: 60_000,
      setInterval: (next: () => void) => {
        tick = next;
        return "handle";
      },
      clearInterval: (handle: unknown) => {
        cleared = handle === "handle";
      },
    },
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    asked,
    stop,
    async next() {
      tick?.();
      await settle();
    },
    settle,
    holdNext() {
      hold = true;
    },
    release() {
      hold = false;
      release?.();
    },
    get expired() {
      return expired;
    },
    get cleared() {
      return cleared;
    },
  };
}

test("a service declared after start is used from the next tick, a replaced origin replaces the old one, a removed one is never asked again, and without one a tick only lets expired routes go", async () => {
  let current: RoutesDeclaration = { kind: "undeclared" };
  const h = harness(() => current);
  await h.settle();
  expect(h.asked).toEqual([]);
  expect(h.expired).toBe(1);

  current = declared(originA);
  await h.next();
  expect(h.asked).toEqual([originA]);

  current = declared(originB);
  await h.next();
  await h.next();
  expect(h.asked).toEqual([originA, originB, originB]);
  expect(h.expired).toBe(1);

  // Removed: no further call, to the old origin or any other; expiry only.
  current = { kind: "undeclared" };
  await h.next();
  await h.next();
  expect(h.asked.length).toBe(3);
  expect(h.expired).toBe(3);

  // A base that keeps no routes does nothing at all.
  current = { kind: "off" };
  await h.next();
  expect(h.asked.length).toBe(3);
  expect(h.expired).toBe(3);
});

test("one tick at a time, a handover that cannot be read only lets expired routes go, a failing tick never stops the loop, and stop ends it", async () => {
  let reads = 0;
  let current: RoutesDeclaration = declared(originA);
  const h = harness(() => {
    reads += 1;
    if (reads === 3) throw new Error("handover unreadable");
    return current;
  });
  await h.settle();
  expect(h.asked.length).toBe(1);

  // A tick while one synchronization runs does not start a second.
  h.holdNext();
  await h.next();
  expect(h.asked.length).toBe(2);
  await h.next();
  expect(h.asked.length).toBe(2);
  h.release();
  await h.settle();

  // The third read throws: nothing is asked, expired routes go, and the
  // loop goes on.
  await h.next();
  expect(h.asked.length).toBe(2);
  expect(h.expired).toBe(1);
  await h.next();
  expect(h.asked.length).toBe(3);

  h.stop();
  expect(h.cleared).toBe(true);
  current = declared(originB);
  await h.next();
  expect(h.asked.length).toBe(3);
});

// The writers, on real files.

const uid = process.getuid?.();
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "lazurio-routes-loop-"));
  homes.push(path);
  return { home: path, uid };
}
const confPath = (home: string) =>
  join(home, ".ssh", "config.d", "lazurio-environments.conf");
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const now = Date.parse("2026-11-03T12:00:00Z");
const keyA =
  "AAAAC3NzaC1lZDI1NTE5AAAAIOosFYFA3vTPDE3z8629wlmF0Qecl1enPwpEjCjOsnfj";
const keyB =
  "AAAAC3NzaC1lZDI1NTE5AAAAIIFygZVmr1cFYx//JrQ0yWhRLdAwCbc1XS4H6ktOFDTx";
const target = (environment: string, key: string, validUntil: string) => ({
  environment,
  host: `${environment.replace(".", "-")}-vm.tailnet.example.invalid`,
  user: "alice",
  host_key: `ssh-ed25519 ${key}`,
  valid_until: validUntil,
});
const route = (
  environment: string,
  key: string,
  validUntil?: string,
): EnvironmentRoute => ({
  environment,
  host: `${environment.replace(".", "-")}-vm.tailnet.example.invalid`,
  user: "alice",
  hostKeys: [{ type: "ssh-ed25519", key }],
  ...(validUntil === undefined ? {} : { validUntil }),
});
const names = (routes: readonly EnvironmentRoute[]) =>
  routes.map((entry) => entry.environment);

/** A fake service per origin; the targets of an origin may be held until
 * released, as a slow answer is. */
function services(
  answers: Record<string, readonly unknown[]>,
  held: Set<string> = new Set(),
) {
  const waiting = new Map<string, () => void>();
  const asked: string[] = [];
  const fetchImpl: AccessServiceFetch = async (url, init) => {
    const { origin, pathname } = new URL(url);
    const key = `${origin}`;
    if (pathname === "/v1/source-key")
      return new Response(
        JSON.stringify({
          schema_version: "machines.access-source-key-receipt.v1",
          changed: false,
        }),
        { status: 200 },
      );
    asked.push(`${init.method} ${key}`);
    if (held.has(key))
      await new Promise<void>((resolve) => waiting.set(key, resolve));
    return new Response(
      JSON.stringify({
        schema_version: "machines.access-targets.v1",
        targets: answers[key] ?? [],
      }),
      { status: 200 },
    );
  };
  return {
    fetchImpl,
    asked,
    async waitAsked(origin: string) {
      while (!asked.includes(`GET ${origin}`))
        await new Promise((resolve) => setTimeout(resolve, 5));
    },
    release(origin: string) {
      held.delete(origin);
      waiting.get(origin)?.();
    },
  };
}

test("an old origin's answer that arrives after the handover moved to another origin writes nothing: the newer synchronization's routes stay", async () => {
  const location = await home();
  let live: RoutesSource = service(originA);
  const fake = services(
    {
      [originA]: [target("old.example", keyA, "2026-11-03T12:03:30Z")],
      [originB]: [target("new.example", keyB, "2026-11-03T12:03:30Z")],
    },
    new Set([originA]),
  );
  const seams = {
    run: runTool,
    now: () => now,
    fetch: fake.fetchImpl,
    current: async () => live,
  };
  const old = syncEnvironmentRoutes(location, service(originA), seams);
  await fake.waitAsked(originA);
  // The handover now declares B, and B's synchronization writes first.
  live = service(originB);
  const newer = await syncEnvironmentRoutes(location, service(originB), seams);
  expect(newer.ssh).toEqual({ kind: "written", environments: ["new.example"] });
  fake.release(originA);
  const late = await old;
  expect(late.targets).toBe("answered");
  expect(late.ssh).toEqual({ kind: "superseded" });
  expect(names(await recordedRoutes(location))).toEqual(["new.example"]);
});

test("an answer held while the declaration is removed writes nothing: the refresh's routes stay, a personal Machine's assigned peers and a work Machine's none", async () => {
  const peers = assignedEnvironments(bindings.personalAssigned).map(
    (entry) => entry.environment,
  );
  expect(peers.length).toBeGreaterThan(0);
  for (const machine of [bindings.personalAssigned, bindings.organization]) {
    const location = await home();
    // Routes the service wrote while it was declared.
    await writeEnvironmentRoutes(location, [
      route("old.example", keyA, "2026-11-03T12:03:30Z"),
    ]);
    let live: RoutesSource = service(originA);
    const fake = services(
      { [originA]: [target("late.example", keyA, "2026-11-03T12:05:00Z")] },
      new Set([originA]),
    );
    const seams = {
      run: runTool,
      now: () => now,
      fetch: fake.fetchImpl,
      current: async () => live,
    };
    const old = syncEnvironmentRoutes(location, service(originA), seams);
    await fake.waitAsked(originA);
    // Machines removes the member and folder-refresh records the binding
    // without it.
    live = routesSourceOf(machine);
    const refreshed = await withEnvironmentSsh(
      { kind: "refreshed", revision: 2 },
      machine,
      location,
      undefined,
      seams,
    );
    fake.release(originA);
    expect((await old).ssh).toEqual({ kind: "superseded" });
    if (machine.kind === "personal-vm") {
      expect(refreshed).toMatchObject({
        environmentSsh: { kind: "written", environments: peers },
      });
      expect(names(await recordedRoutes(location))).toEqual(peers);
    } else {
      // On a work Machine the removed service's routes go at once.
      expect(refreshed).toMatchObject({ environmentSsh: { kind: "removed" } });
      expect(await exists(confPath(location.home))).toBe(false);
    }
  }
});

test("a refresh of a binding that no longer matches the live handover writes nothing, either way", async () => {
  // A personal binding without the service, while the live handover
  // declares it again and its routes are written: the peers do not replace
  // them.
  const location = await home();
  await writeEnvironmentRoutes(location, [
    route("svc.example", keyA, "2026-11-03T12:03:30Z"),
  ]);
  const seams = {
    run: runTool,
    now: () => now,
    current: async () => service(originB),
  };
  const stale = await withEnvironmentSsh(
    { kind: "refreshed", revision: 3 },
    bindings.personalAssigned,
    location,
    undefined,
    seams,
  );
  expect(stale).toMatchObject({ environmentSsh: { kind: "superseded" } });
  // A work binding without the service: nothing is removed either.
  const work = await withEnvironmentSsh(
    { kind: "refreshed", revision: 3 },
    bindings.organization,
    location,
    undefined,
    seams,
  );
  expect(work).toMatchObject({ environmentSsh: { kind: "superseded" } });
  // A handover that cannot be read counts as changed.
  const unreadable = await withEnvironmentSsh(
    { kind: "refreshed", revision: 3 },
    bindings.personalAssigned,
    location,
    undefined,
    {
      ...seams,
      current: async () => {
        throw new Error("handover unreadable");
      },
    },
  );
  expect(unreadable).toMatchObject({ environmentSsh: { kind: "superseded" } });
  expect(names(await recordedRoutes(location))).toEqual(["svc.example"]);
});

test("without a declaration or a readable handover, no route of the service outlives its deadline, on a personal and a work Machine, and the assigned peers stay", async () => {
  // A work Machine: the service's routes, one still ahead.
  const work = await home();
  await writeEnvironmentRoutes(work, [
    route("ahead.example", keyA, "2026-11-03T12:03:30Z"),
    route("passed.example", keyB, "2026-11-03T11:59:59Z"),
  ]);
  expect(await expireRoutes(work, () => now)).toEqual({
    kind: "written",
    environments: ["ahead.example"],
  });
  // Nothing more has expired: no file is touched.
  const before = await stat(confPath(work.home));
  expect(await expireRoutes(work, () => now)).toEqual({
    kind: "unchanged",
    environments: ["ahead.example"],
  });
  expect((await stat(confPath(work.home))).mtimeMs).toBe(before.mtimeMs);
  // A tick after the last deadline: nothing is left.
  expect(
    await expireRoutes(work, () => Date.parse("2026-11-03T12:04:00Z")),
  ).toEqual({ kind: "removed" });
  expect(await exists(confPath(work.home))).toBe(false);
  expect(await expireRoutes(work, () => now)).toEqual({ kind: "none" });

  // A personal Machine before its refresh: the service's routes expire, and
  // once the refresh wrote the handover's peers, they stay as they are.
  const personal = await home();
  await writeEnvironmentRoutes(personal, [
    route("svc.example", keyA, "2026-11-03T12:03:30Z"),
  ]);
  expect(
    await expireRoutes(personal, () => Date.parse("2026-11-03T12:04:00Z")),
  ).toEqual({ kind: "removed" });
  await writeEnvironmentSsh(personal, bindings.personalAssigned);
  const peers = await recordedRoutes(personal);
  expect(peers.length).toBeGreaterThan(0);
  const written = await readFile(confPath(personal.home), "utf8");
  expect(
    await expireRoutes(personal, () => Date.parse("2027-01-01T00:00:00Z")),
  ).toEqual({ kind: "unchanged", environments: names(peers) });
  expect(await readFile(confPath(personal.home), "utf8")).toBe(written);

  // The Platform's own file that cannot be read back is removed: nothing
  // shows its deadlines.
  const broken = await home();
  await writeEnvironmentRoutes(broken, [
    route("svc.example", keyA, "2026-11-03T12:03:30Z"),
  ]);
  const bytes = await readFile(confPath(broken.home), "utf8");
  await writeFile(
    confPath(broken.home),
    bytes.replace("  User alice\n", "  User alice extra\n"),
  );
  expect(await expireRoutes(broken, () => now)).toEqual({ kind: "removed" });
  expect(await exists(confPath(broken.home))).toBe(false);
});

test("the Launchpad's loop with an unreadable handover lets the service's expired routes go on real files", async () => {
  const location = await home();
  await writeEnvironmentRoutes(location, [
    route("passed.example", keyA, "2026-11-03T11:59:00Z"),
  ]);
  let done: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const stop = runEnvironmentRoutes(
    async () => {
      throw new Error("handover unreadable");
    },
    async () => {
      throw new Error("never asked");
    },
    async () => {
      await expireRoutes(location, () => now);
      done?.();
    },
    {
      everyMs: 60_000,
      setInterval: () => "handle",
      clearInterval: () => undefined,
    },
  );
  await finished;
  stop();
  expect(await exists(confPath(location.home))).toBe(false);
});

test("both writers take one lock: a write waits while another writer holds it, then commits", async () => {
  const location = await home();
  await mkdir(dirname(routesLockPath(location.home)), { recursive: true });
  const lock = await acquireFileLock(routesLockPath(location.home), {
    timeoutMs: 1_000,
  });
  const fake = services({
    [originA]: [target("svc.example", keyA, "2026-11-03T12:03:30Z")],
  });
  let finished = false;
  const sync = syncEnvironmentRoutes(location, service(originA), {
    run: runTool,
    now: () => now,
    fetch: fake.fetchImpl,
    current: async () => service(originA),
  }).then((result) => {
    finished = true;
    return result;
  });
  await fake.waitAsked(originA);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(finished).toBe(false);
  expect(await exists(confPath(location.home))).toBe(false);
  await lock.release();
  expect((await sync).ssh).toEqual({
    kind: "written",
    environments: ["svc.example"],
  });
});

// Review of b1540ee8, point 2: a refresh of a personal Machine without the
// service writes only the assigned peers the live handover still declares.
// An older refresh that paused before the routes lock never overwrites what
// a newer refresh wrote after the peers were removed or changed: those
// routes have no deadline, so nothing would ever correct them.
const [laptopPeer, assignedPeer] = assignedHandover.relationships
  .peers as unknown as [Record<string, unknown>, Record<string, unknown>];
const withPeers = (peers: readonly unknown[]) =>
  binding({
    ...assignedHandover,
    relationships: { ...assignedHandover.relationships, peers },
  });
const assignedSsh = assignedPeer.ssh as Record<string, unknown>;
const plain = (routes: readonly EnvironmentRoute[]) =>
  routes.map(({ environment, host, user, hostKeys }) => ({
    environment,
    host,
    user,
    hostKeys,
  }));
const olderPeers = bindings.personalAssigned;
const newerPeers = {
  removed: withPeers([laptopPeer]),
  changed: withPeers([
    laptopPeer,
    {
      ...assignedPeer,
      ssh: {
        ...assignedSsh,
        host_keys: [{ type: "ssh-ed25519", key: keyB }],
      },
    },
  ]),
};

test("an older refresh without the service, held before the routes lock while a newer handover removes or changes the assigned peers, writes nothing: the newer refresh's peers stay", async () => {
  expect(assignedEnvironments(olderPeers).length).toBe(1);
  expect(assignedEnvironments(newerPeers.removed)).toEqual([]);
  expect(assignedEnvironments(newerPeers.changed)[0]?.hostKeys).toEqual([
    { type: "ssh-ed25519", key: keyB },
  ]);
  for (const [change, newer] of Object.entries(newerPeers)) {
    for (const order of ["newer-first", "older-first"] as const) {
      const location = await home();
      // The older handover's peers, as its earlier refresh wrote them.
      await writeEnvironmentSsh(location, olderPeers);
      let live: RoutesSource = routesSourceOf(olderPeers);
      const seams = {
        run: runTool,
        now: () => now,
        current: async () => live,
      };
      await mkdir(dirname(routesLockPath(location.home)), { recursive: true });
      const lock = await acquireFileLock(routesLockPath(location.home), {
        timeoutMs: 1_000,
      });
      // The older refresh has recorded its binding and now waits for the
      // routes lock.
      let finished = false;
      const older = withEnvironmentSsh(
        { kind: "refreshed", revision: 2 },
        olderPeers,
        location,
        undefined,
        seams,
      ).then((result) => {
        finished = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(finished).toBe(false);
      // Machines rewrites the handover.
      live = routesSourceOf(newer);
      let newerResult: unknown;
      if (order === "newer-first") {
        await lock.release();
        // Whichever takes the lock first, the older one writes nothing.
        const [olderResult, result] = await Promise.all([
          older,
          withEnvironmentSsh(
            { kind: "refreshed", revision: 3 },
            newer,
            location,
            undefined,
            seams,
          ),
        ]);
        expect(olderResult).toMatchObject({
          environmentSsh: { kind: "superseded" },
        });
        newerResult = result;
      } else {
        await lock.release();
        expect(await older).toMatchObject({
          environmentSsh: { kind: "superseded" },
        });
        newerResult = await withEnvironmentSsh(
          { kind: "refreshed", revision: 3 },
          newer,
          location,
          undefined,
          seams,
        );
      }
      expect(newerResult).toMatchObject({
        environmentSsh:
          change === "removed"
            ? { kind: "removed" }
            : {
                kind: "written",
                environments: names(assignedEnvironments(newer)),
              },
      });
      // The files hold exactly the newer handover's peers, and a late older
      // refresh still writes nothing.
      expect(plain(await recordedRoutes(location))).toEqual(
        plain(assignedEnvironments(newer)),
      );
      expect(
        await withEnvironmentSsh(
          { kind: "refreshed", revision: 2 },
          olderPeers,
          location,
          undefined,
          seams,
        ),
      ).toMatchObject({ environmentSsh: { kind: "superseded" } });
      expect(plain(await recordedRoutes(location))).toEqual(
        plain(assignedEnvironments(newer)),
      );
    }
  }
});

// Review of b1540ee8, point 1: the Launchpad's real `routesAtStart` drives
// the loop. A missing handover fails the hosted-operator check itself
// (`hostedOperatorFolder` finds no operator), so a base that still has the
// Platform's route files is `unconfirmed` and its expired routes go; where
// the check passes but the handover cannot be read, the read throws and they
// go too; a base with no route files keeps none and does nothing.
async function supervisedBase(location: { home: string }) {
  const base = join(location.home, "base");
  const folder = join(location.home, "Lazurio");
  const config = join(location.home, ".config");
  await mkdir(join(config, "systemd", "user"), { recursive: true });
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(config, "systemd", "user", launchpadUnit),
    renderLaunchpadUnit(base, folder),
  );
  // A machine root without `/etc/lazurio/lazurio.machine.json`.
  const missing = {
    platform: "linux",
    root: join(location.home, "machine-root"),
    custodian: uid ?? 0,
  };
  const context = (
    hostedFolder: () => Promise<string | undefined>,
  ): CliContext => ({
    identity: embeddedIdentity(),
    platform: "linux",
    env: { HOME: location.home, XDG_CONFIG_HOME: config },
    executable: process.execPath,
    run: async () => ({ exitCode: 0, stdout: "" }),
    hostedFolder,
  });
  return { base, folder, missing, context };
}

async function oneTick(
  read: () => Promise<RoutesDeclaration>,
  location: { home: string; uid: number | undefined },
) {
  const seen: string[] = [];
  let done: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const stop = runEnvironmentRoutes(
    async () => {
      try {
        const declaration = await read();
        seen.push(declaration.kind);
        if (declaration.kind === "off") setTimeout(() => done?.(), 20);
        return declaration;
      } catch (error) {
        seen.push("thrown");
        throw error;
      }
    },
    async () => {
      seen.push("synchronized");
      done?.();
    },
    async () => {
      seen.push(`expire:${(await expireRoutes(location, () => now)).kind}`);
      done?.();
    },
    {
      everyMs: 60_000,
      setInterval: () => "handle",
      clearInterval: () => undefined,
    },
  );
  await finished;
  stop();
  return seen;
}

test("routesAtStart with a missing handover still lets the service's expired routes go through the loop, on a base whose hosted check fails and on one where only the handover read fails; without route files it does nothing", async () => {
  // The hosted-operator check fails: no handover, so no operator.
  const unhosted = await home();
  const world = await supervisedBase(unhosted);
  const noOperator = () =>
    hostedOperatorFolder({
      handover: world.missing,
      operator: async () => {
        throw new Error("never read without a handover");
      },
    });
  expect(await noOperator()).toBeUndefined();
  await writeEnvironmentRoutes(unhosted, [
    route("passed.example", keyA, "2026-11-03T11:59:00Z"),
    route("ahead.example", keyB, "2026-11-03T12:03:30Z"),
  ]);
  const read = routesAtStart(world.context(noOperator), world.base, {
    location: unhosted,
    read: liveRoutesSource(world.missing),
  });
  expect(await oneTick(read, unhosted)).toEqual([
    "unconfirmed",
    "expire:written",
  ]);
  expect(names(await recordedRoutes(unhosted))).toEqual(["ahead.example"]);

  // The check passes (the operator's Folder is known), the handover itself
  // is missing: the read throws and the tick only lets expired routes go.
  const hosted = await home();
  const hostedWorld = await supervisedBase(hosted);
  await writeEnvironmentRoutes(hosted, [
    route("passed.example", keyA, "2026-11-03T11:59:00Z"),
  ]);
  const hostedRead = routesAtStart(
    hostedWorld.context(async () => hostedWorld.folder),
    hostedWorld.base,
    { location: hosted, read: liveRoutesSource(hostedWorld.missing) },
  );
  expect(await oneTick(hostedRead, hosted)).toEqual([
    "thrown",
    "expire:removed",
  ]);
  expect(await exists(confPath(hosted.home))).toBe(false);

  // A base with no route files keeps none: `off`, nothing expires.
  const clean = await home();
  const cleanWorld = await supervisedBase(clean);
  const cleanRead = routesAtStart(
    cleanWorld.context(noOperator),
    cleanWorld.base,
    {
      location: clean,
      read: liveRoutesSource(cleanWorld.missing),
    },
  );
  expect(await oneTick(cleanRead, clean)).toEqual(["off"]);
  expect(await exists(join(clean.home, ".ssh"))).toBe(false);
});
