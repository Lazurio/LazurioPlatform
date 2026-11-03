import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assignedEnvironments,
  type MachineBinding,
} from "../folder/machine-binding";
import { machineBinding } from "../machine/binding";
import {
  type MachineContextSource,
  productionMachineContextSource,
  readMachineContext,
} from "../machine/context";
import { acquireFileLock, type FileLock } from "../platform/flock";
import type { ToolRunner } from "../tools/status";
import {
  type AccessServiceFetch,
  type AccessServiceLocation,
  accessServiceOf,
  askTargets,
  type RegistrationAnswer,
  registerSourceKey,
  type TargetsAnswer,
} from "./access-service";
import {
  type EnvironmentRoute,
  type EnvironmentSshLocation,
  type EnvironmentSshResult,
  expireEnvironmentRoutes,
  pruneEnvironmentRoutes,
  writeEnvironmentRoutes,
} from "./environments";
import { ensureSourceKey, type SourceKeyResult } from "./source-key";

// One synchronization of this Environment's routes with its home access
// service (root decision 0224), in this order:
//
// 1. its one key exists (created here when missing, `source-key.ts`);
// 2. its public part is registered (`PUT /v1/source-key`), every time: the
//    service answers `changed: false` for the same key and writes nothing,
//    and a re-enrolled Environment registers again by itself;
// 3. its targets are asked (`GET /v1/targets`) and written as they are,
//    each pinned to its host key, expired ones dropped;
// 4. without a valid answer (unreachable, refused, unavailable, malformed)
//    nothing is added: the recorded routes whose deadline has passed go,
//    the others stay until theirs passes. The service's deadline is at most
//    210 s after its last good read of the facts, so a route the service
//    stops confirming disappears here within that time plus one
//    synchronization, whatever the reason; the target's own key check
//    closes it at the same deadline.
//
// Steps 3 and 4 write only under the routes lock and only while the live
// handover still declares the service that was asked (decision F70,
// amendment of 2026-11-03, point 5): an answer that arrives after the
// handover changed writes nothing (`superseded`), whichever writer of the
// newer declaration came first. A writer without a service holds to the
// same rule for the routes it writes (`RoutesSource`).
//
// Each step's outcome is reported as it is; a failure of one step is never
// reported as another's (a down service is `unreachable`, not a missing
// key or a missing route).

/** Where a binding's routes come from (decision F70, amendment of
 * 2026-11-03, point 5): the home access service it declares, or without one
 * its own routes, exactly: a personal Machine's assigned peers (each with its
 * host, account and host keys, in their order), none on any other Machine. */
export type RoutesSource = AccessServiceLocation | readonly EnvironmentRoute[];

export const routesSourceOf = (
  machine: MachineBinding | null | undefined,
): RoutesSource => accessServiceOf(machine) ?? assignedEnvironments(machine);

/** Reads the live handover's `RoutesSource`. Throws when the handover cannot
 * be read. */
export type ReadRoutesSource = () => Promise<RoutesSource>;

/** The `RoutesSource` of the live handover, `/etc/lazurio/lazurio.machine.json`
 * outside tests, as its binding declares it. */
export const liveRoutesSource =
  (source: MachineContextSource = productionMachineContextSource) =>
  async (): Promise<RoutesSource> => {
    const { context, digest } = await readMachineContext(source);
    return routesSourceOf(machineBinding(context, digest));
  };

export type RoutesSeams = Readonly<{
  run: ToolRunner;
  now: () => number;
  fetch?: AccessServiceFetch;
  /** The live declaration, read again under the routes lock right before
   * anything is written (`liveRoutesSource()` outside tests). */
  current: ReadRoutesSource;
}>;

/** Nothing written: the live handover no longer declares what the writer
 * acted on, or cannot be read. */
export type Superseded = Readonly<{ kind: "superseded" }>;

export type RoutesWrite =
  | EnvironmentSshResult
  | Superseded
  | Readonly<{ kind: "failed" }>;

export type RoutesSync = Readonly<{
  sourceKey: SourceKeyResult | Readonly<{ kind: "failed" }>;
  registration: RegistrationAnswer | Readonly<{ kind: "skipped" }>;
  targets: TargetsAnswer["kind"];
  ssh: RoutesWrite;
}>;

/** The one lock of every writer of the routes, the Launchpad's tick and
 * `machine folder-*` alike: a path fixed under the home (never moved by
 * `XDG_STATE_HOME`, so both processes take the same file). */
export const routesLockPath = (home: string) =>
  join(home, ".local", "state", "lazurio", "environment-routes.lock");
const routesLockTimeoutMs = 15_000;

/** `work` under the routes lock: a kernel `flock`, released when the
 * holder ends or dies, so nothing on disk records a holder. A lock not
 * taken in time, or a failing `work`, is `failed`. */
export async function withRoutesLock(
  location: EnvironmentSshLocation,
  work: () => Promise<RoutesWrite>,
): Promise<RoutesWrite> {
  const path = routesLockPath(location.home);
  let lock: FileLock;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    lock = await acquireFileLock(path, { timeoutMs: routesLockTimeoutMs });
  } catch {
    return { kind: "failed" };
  }
  try {
    return await work();
  } catch {
    return { kind: "failed" };
  } finally {
    await lock.release();
  }
}

// Two sources are the same when they name the same origin, or are the same
// own routes value for value (an own route is plain data: strings and the
// host keys' `{type, key}`), so a refresh of an older handover whose peers
// were since removed or changed is never the current one.
const sameSource = (declared: RoutesSource, live: RoutesSource) =>
  Array.isArray(declared) || Array.isArray(live)
    ? Array.isArray(declared) &&
      Array.isArray(live) &&
      JSON.stringify(declared.map(ownRoute)) ===
        JSON.stringify(live.map(ownRoute))
    : (declared as AccessServiceLocation).origin ===
      (live as AccessServiceLocation).origin;
const ownRoute = (route: EnvironmentRoute) => [
  route.environment,
  route.host,
  route.user,
  route.hostKeys.map((hostKey) => [hostKey.type, hostKey.key]),
  route.validUntil ?? null,
];

/** `write` under the routes lock, only while the live handover declares
 * exactly `declared` (the same origin, or without a service the same own
 * routes); otherwise, and when it cannot be read, nothing is written and the
 * answer is `superseded`. */
export function commitRoutes(
  location: EnvironmentSshLocation,
  declared: RoutesSource,
  current: ReadRoutesSource,
  write: () => Promise<EnvironmentSshResult>,
): Promise<RoutesWrite> {
  return withRoutesLock(location, async () => {
    let live: RoutesSource;
    try {
      live = await current();
    } catch {
      return { kind: "superseded" };
    }
    return sameSource(declared, live) ? write() : { kind: "superseded" };
  });
}

/** Without a declared service (or a readable handover): under the routes
 * lock, the recorded routes whose deadline has passed go and nothing is
 * added (decision F70, amendment of 2026-11-03, point 6). Safe whatever the
 * handover declares meanwhile: it only ever removes what has expired. */
export function expireRoutes(
  location: EnvironmentSshLocation,
  now: () => number,
): Promise<RoutesWrite> {
  return withRoutesLock(location, () =>
    expireEnvironmentRoutes(location, now()),
  );
}

export async function syncEnvironmentRoutes(
  location: EnvironmentSshLocation,
  service: AccessServiceLocation,
  seams: RoutesSeams,
): Promise<RoutesSync> {
  let sourceKey: RoutesSync["sourceKey"];
  try {
    sourceKey = await ensureSourceKey(location, seams.run);
  } catch {
    sourceKey = { kind: "failed" };
  }
  const registration: RoutesSync["registration"] =
    sourceKey.kind === "present" || sourceKey.kind === "created"
      ? await registerSourceKey(service, sourceKey.publicKey, seams.fetch)
      : { kind: "skipped" };
  const targets = await askTargets(service, seams.now, seams.fetch);
  const ssh = await commitRoutes(location, service, seams.current, () =>
    targets.kind === "answered"
      ? writeEnvironmentRoutes(location, targets.targets)
      : pruneEnvironmentRoutes(location, seams.now()),
  );
  return { sourceKey, registration, targets: targets.kind, ssh };
}

/** What one tick of the Launchpad's loop finds: this base keeps no routes
 * and has none recorded (`off`); the live handover declares the service or
 * none; or this base cannot show now that it is a hosted operator's (a
 * missing or unreadable handover fails that check too) while the Platform's
 * route files are there (`unconfirmed`), so it was one and only lets expired
 * routes go. A handover that cannot be read is a thrown error. */
export type RoutesDeclaration =
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "declared"; service: AccessServiceLocation }>
  | Readonly<{ kind: "undeclared" }>
  | Readonly<{ kind: "unconfirmed" }>;

/** The live loop of the routes (review of #833): every tick reads the
 * current handover's declaration again, so a service declared after start
 * is used from the next tick, a replaced origin replaces the old one and a
 * removed declaration stops every call to the old origin. Without a
 * declaration, when the handover cannot be read, and on a base that cannot
 * show it is hosted but has route files, it only lets expired routes go
 * (`expire`), so no route of the service outlives its deadline by more than a
 * tick; only where this base keeps and has no routes (`off`) it does nothing. What a
 * tick writes, it writes only for the declaration that is still current
 * (`commitRoutes`). One tick at a time, never awaited, never a reason for its
 * caller to fail. Returns its stop. */
export function runEnvironmentRoutes(
  read: () => Promise<RoutesDeclaration>,
  synchronize: (service: AccessServiceLocation) => Promise<unknown>,
  expire: () => Promise<unknown>,
  timer: Readonly<{
    everyMs: number;
    setInterval: (tick: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  }>,
): () => void {
  let stopped = false;
  let running = false;
  const tick = () => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      let declaration: RoutesDeclaration | null;
      try {
        declaration = await read();
      } catch {
        declaration = null;
      }
      if (stopped || declaration?.kind === "off") return;
      if (declaration?.kind === "declared")
        await synchronize(declaration.service);
      else await expire();
    })()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  };
  tick();
  const handle = timer.setInterval(tick, timer.everyMs);
  return () => {
    stopped = true;
    timer.clearInterval(handle);
  };
}
