import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  environmentKeyPath,
  environmentsKnownHostsPath,
  expireEnvironmentRoutes,
  pruneEnvironmentRoutes,
  renderEnvironmentsKnownHosts,
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
  /** With `test`, only after the service answered and the config was
   * written: each route tried (onboarding, `machine folder-*`). */
  tests?: readonly RouteTest[];
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
  test = false,
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
  const synced = { sourceKey, registration, targets: targets.kind, ssh };
  if (
    !test ||
    targets.kind !== "answered" ||
    (ssh.kind !== "written" && ssh.kind !== "unchanged")
  )
    return synced;
  return {
    ...synced,
    tests: await testRoutes(
      targets.targets.filter((route) =>
        ssh.environments.includes(route.environment),
      ),
      location.home,
      seams.run,
      seams.now,
    ),
  };
}

// ---- Testing a route ---------------------------------------------------------

// Each route is tried in two steps, both bound to the exact route given (the
// one the doctor compared, or the one this synchronization wrote), never to
// whatever the files hold a moment later:
//
// 1. What `ssh <environment id>` would use now: `ssh -G <id>` through the
//    account's own config must resolve to that route's host and account,
//    pinned under its own alias in the managed known-hosts file, with only
//    this Environment's key, on port 22, without a jump or proxy command and
//    without a shared connection (`ControlPath none`: OpenSSH reuses an open
//    master whenever a path is set, even with `ControlMaster no`). Anything
//    else (the `Include` removed, another `Host` for the same id first, a
//    `Host *` before it that shares connections) is `not-configured`, and
//    nothing is connected.
// 2. The connection itself, with that route's values on the command line
//    and its pinned keys in a private known-hosts file written for this try
//    alone (`-F none`, so no other config, connection sharing or forwarding
//    takes part). Its two paths are quoted and their `%` doubled, because
//    OpenSSH splits an option's value at spaces and expands `%` tokens in
//    both; a path with a double quote cannot be passed and is `unknown`. A route the Launchpad replaces between the two steps or
//    during the try therefore never lends its result to another route.
//
// Both steps are non-interactive (`BatchMode=yes`, no password, no question
// about a host key) and bounded in time. Nothing runs on the target but
// `true`, and nothing is written there. The result names one cause from
// OpenSSH's own words; what cannot be told apart (a target that is off and
// a network that drops packets both time out) stays `timeout` or `unknown`,
// never a guessed reason.

export const routeCauses = [
  "host-key-mismatch",
  "login-refused",
  "timeout",
  "connection-refused",
  "unresolved",
  "network-unreachable",
  "not-configured",
  "unknown",
] as const;
export type RouteCause = (typeof routeCauses)[number];

export type RouteTest =
  | Readonly<{ environment: string; result: "reached"; at: string }>
  | Readonly<{
      environment: string;
      result: "failed";
      cause: RouteCause;
      at: string;
    }>;

const connectTimeoutSeconds = 10;
const testTimeoutMs = 20_000;
const resolveTimeoutMs = 5_000;
const testsAtOnce = 4;

/** The cause of a failed `ssh` from its standard error. */
export function routeCause(stderr: string): RouteCause {
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No (?:ED25519 )?host key is known/i.test(
      stderr,
    )
  )
    return "host-key-mismatch";
  if (/Permission denied/i.test(stderr)) return "login-refused";
  if (/Connection timed out|Operation timed out|timed out/i.test(stderr))
    return "timeout";
  if (/Connection refused/i.test(stderr)) return "connection-refused";
  if (/Could not resolve hostname|Name or service not known/i.test(stderr))
    return "unresolved";
  if (/No route to host|Network is unreachable/i.test(stderr))
    return "network-unreachable";
  return "unknown";
}

/** `ssh -G` output as option → values (a repeated option keeps every value,
 * in order). */
function effectiveOptions(stdout: string): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const name = line.slice(0, space).toLowerCase();
    options.set(name, [...(options.get(name) ?? []), line.slice(space + 1)]);
  }
  return options;
}

const expandHome = (path: string, home: string) =>
  path.startsWith("~/") ? join(home, path.slice(2)) : path;

/** Whether `ssh <id>`, as the account's config resolves it, is this route
 * exactly as the managed config writes it. */
export function resolvesToRoute(
  stdout: string,
  route: EnvironmentRoute,
  home: string,
): boolean {
  const options = effectiveOptions(stdout);
  const only = (name: string, ...accepted: string[]) => {
    const values = options.get(name);
    return (
      values !== undefined &&
      values.length === 1 &&
      accepted.includes(values[0] as string)
    );
  };
  const path = (value: string) => [value, expandHome(value, home)];
  const absent = (name: string) => {
    const values = options.get(name);
    return values === undefined || values.every((value) => value === "none");
  };
  return (
    only("hostname", route.host) &&
    only("user", route.user) &&
    only("port", "22") &&
    only("hostkeyalias", route.environment) &&
    only("stricthostkeychecking", "true", "yes") &&
    only("identitiesonly", "yes") &&
    only("identityfile", ...path(environmentKeyPath)) &&
    only("userknownhostsfile", ...path(environmentsKnownHostsPath)) &&
    absent("proxyjump") &&
    absent("proxycommand") &&
    only("controlmaster", "false", "no") &&
    absent("controlpath")
  );
}

/** A path as one `-o` value: quoted, with `%` doubled so no token expands;
 * null when it cannot be quoted. */
export function optionPath(path: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refused on purpose
  if (/["\x00-\x1f\x7f]/.test(path)) return null;
  return `"${path.replaceAll("%", "%%")}"`;
}

/** Tries every route, a few at a time, and answers each result with the time
 * it was observed. */
export async function testRoutes(
  routes: readonly EnvironmentRoute[],
  home: string,
  run: ToolRunner,
  now: () => number,
): Promise<readonly RouteTest[]> {
  const env = { HOME: home, PATH: process.env.PATH ?? "" };
  const observedAt = () =>
    new Date(Math.floor(now() / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z");
  const failed = (environment: string, cause: RouteCause): RouteTest => ({
    environment,
    result: "failed",
    cause,
    at: observedAt(),
  });
  const one = async (route: EnvironmentRoute): Promise<RouteTest> => {
    const { environment } = route;
    const resolved = await run(
      ["ssh", "-G", environment],
      resolveTimeoutMs,
      env,
    ).catch(() => "timeout" as const);
    if (
      resolved === "timeout" ||
      resolved.exitCode !== 0 ||
      !resolvesToRoute(resolved.stdout, route, home)
    )
      return failed(environment, "not-configured");
    const directory = await mkdtemp(join(tmpdir(), "lazurio-route-"));
    try {
      const knownHosts = join(directory, "known_hosts");
      await writeFile(knownHosts, renderEnvironmentsKnownHosts([route]), {
        mode: 0o600,
        flag: "wx",
      });
      const option = (value: string) => ["-o", value];
      const knownHostsValue = optionPath(knownHosts);
      const identityValue = optionPath(expandHome(environmentKeyPath, home));
      if (knownHostsValue === null || identityValue === null)
        return failed(environment, "unknown");
      const result = await run(
        [
          "ssh",
          "-F",
          "none",
          ...option("BatchMode=yes"),
          ...option(`ConnectTimeout=${connectTimeoutSeconds}`),
          ...option(`HostName=${route.host}`),
          ...option(`User=${route.user}`),
          ...option("Port=22"),
          ...option(`HostKeyAlias=${environment}`),
          ...option(`UserKnownHostsFile=${knownHostsValue}`),
          ...option("GlobalKnownHostsFile=/dev/null"),
          ...option("StrictHostKeyChecking=yes"),
          ...option("UpdateHostKeys=no"),
          ...option(`IdentityFile=${identityValue}`),
          ...option("IdentitiesOnly=yes"),
          ...option("ForwardAgent=no"),
          ...option("ProxyJump=none"),
          ...option("ClearAllForwardings=yes"),
          ...option("ControlMaster=no"),
          ...option("ControlPath=none"),
          "-n",
          "-T",
          environment,
          "true",
        ],
        testTimeoutMs,
        env,
      ).catch(() => "timeout" as const);
      if (result === "timeout") return failed(environment, "timeout");
      return result.exitCode === 0
        ? { environment, result: "reached", at: observedAt() }
        : failed(environment, routeCause(result.stderr));
    } catch {
      return failed(environment, "unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const results: RouteTest[] = [];
  for (let index = 0; index < routes.length; index += testsAtOnce)
    results.push(
      ...(await Promise.all(routes.slice(index, index + testsAtOnce).map(one))),
    );
  return results;
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
