import type { ToolRunner } from "../tools/status";
import {
  type AccessServiceFetch,
  type AccessServiceLocation,
  askTargets,
  type RegistrationAnswer,
  registerSourceKey,
  type TargetsAnswer,
} from "./access-service";
import {
  type EnvironmentSshLocation,
  type EnvironmentSshResult,
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
// Each step's outcome is reported as it is; a failure of one step is never
// reported as another's (a down service is `unreachable`, not a missing
// key or a missing route).

export type RoutesSeams = Readonly<{
  run: ToolRunner;
  now: () => number;
  fetch?: AccessServiceFetch;
}>;

export type RoutesSync = Readonly<{
  sourceKey: SourceKeyResult | Readonly<{ kind: "failed" }>;
  registration: RegistrationAnswer | Readonly<{ kind: "skipped" }>;
  targets: TargetsAnswer["kind"];
  ssh: EnvironmentSshResult | Readonly<{ kind: "failed" }>;
}>;

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
  let ssh: RoutesSync["ssh"];
  try {
    ssh =
      targets.kind === "answered"
        ? await writeEnvironmentRoutes(location, targets.targets)
        : await pruneEnvironmentRoutes(location, seams.now());
  } catch {
    ssh = { kind: "failed" };
  }
  return { sourceKey, registration, targets: targets.kind, ssh };
}

/** The live loop of the routes (review of #833): every tick reads the
 * current handover's declaration again, so a service declared after start
 * is used from the next tick, a replaced origin replaces the old one and a
 * removed declaration stops every call to the old origin. Without a
 * declaration the loop touches no file: the Folder refresh that recorded
 * the removal writes the handover's routes itself, and a late write of the
 * old service must never overwrite it. One synchronization at a time, never
 * awaited, never a reason for its caller to fail. Returns its stop. */
export function runEnvironmentRoutes(
  read: () => Promise<AccessServiceLocation | null>,
  synchronize: (service: AccessServiceLocation) => Promise<unknown>,
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
      const service = await read();
      if (stopped || service === null) return;
      await synchronize(service);
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
