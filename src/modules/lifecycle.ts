import { dirname, join } from "node:path";
import { startGuardedProcess } from "./guarded-process";
import { observeListenerBindings } from "./listener-ownership";
import { object, text } from "./manifest";
import { parseProcessLaunch } from "./process-launch";
import { readModuleApplication } from "./read-application";

type Selection = Readonly<{ company: string; module: string; package: string }>;
type Operation = "start" | "status" | "open" | "stop" | "prepare";
type Plan = Extract<
  Awaited<ReturnType<typeof readModuleApplication>>,
  { kind: "declared-runtime-plan" }
>;
type Handle = Awaited<ReturnType<typeof startGuardedProcess>>;

function selection(input: unknown): Selection {
  const value = object(input, ["company", "module", "package"]);
  return Object.freeze({
    company: text(value.company, /^[A-Za-z0-9][A-Za-z0-9-]*$/),
    module: text(value.module, /^[a-z0-9][a-z0-9-]*$/),
    package: text(value.package, /\S/),
  });
}

// Instantiate once inside the existing local server/lifecycle owner, not once
// per CLI request. There is no locator, durable PID adoption or alternate ACL.
// The injected adapters are trusted application code, never request JSON.
export function createApplicationLifecycle(adapters: {
  platformExecutable: string;
  authorize: (
    selection: Selection,
    operation: Operation,
  ) => Promise<{ moduleDirectory: string }>;
  prepareLaunch: (plan: Plan, cwd: string) => Promise<unknown>;
  // Explicit module preparation. Preflight is read-only and checks its actual
  // dependency owner before any app stop. The effect owns bounded subprocess
  // cleanup; close remains retained if cleanup cannot be confirmed.
  preflightPreparation?: (
    plan: Plan,
    cwd: string,
  ) => Promise<{
    run: (
      signal: AbortSignal,
    ) => Promise<{ kind: "prepared" | "preparation-failed" }>;
    close: () => Promise<{ kind: "closed" | "incomplete" }>;
  }>;
  // Trusted composition boundary for the shared install/pull/start owner lock.
  // null selects owner shutdown; the coordinator must drain its accepted mutations.
  coordinateMutation?: <T>(
    selection: Selection | null,
    action: () => Promise<T>,
  ) => Promise<T>;
}) {
  const runs = new Map<
    string,
    { directory: string; plan: Plan; handle: Handle }
  >();
  let queue = Promise.resolve();
  let closing = false;
  const preparationAbort = new AbortController();
  const preparations = new Set<
    Awaited<ReturnType<NonNullable<typeof adapters.preflightPreparation>>>
  >();
  const key = (value: Selection) => JSON.stringify(value);
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  function mutation<T>(value: Selection | null, operation: () => Promise<T>) {
    return adapters.coordinateMutation
      ? adapters.coordinateMutation(value, () => exclusive(operation))
      : exclusive(operation);
  }
  async function authorized(value: Selection, operation: Operation) {
    try {
      const result = await adapters.authorize(value, operation);
      if (typeof result.moduleDirectory !== "string") return null;
      return result.moduleDirectory;
    } catch {
      return null;
    }
  }
  async function read(value: Selection, directory: string): Promise<Plan> {
    const plan = await readModuleApplication(directory, value.package);
    if (
      plan.kind !== "declared-runtime-plan" ||
      plan.runtime.company !== value.company ||
      plan.runtime.module !== value.module
    )
      throw new Error("Declared application identity mismatch");
    return plan;
  }
  async function inspect(run: { plan: Plan; handle: Handle }) {
    const listeners = [];
    for (const listener of run.plan.listeners) {
      const { host, port, protocol, health } = listener;
      const observation = await run.handle.observeListener({
        host,
        port,
        protocol,
        health,
      });
      listeners.push(Object.freeze({ id: listener.id, observation }));
    }
    const state = run.handle.inspect();
    return Object.freeze({
      kind: "status" as const,
      // Each endpoint is a snapshot, not a cross-listener atomic transaction.
      observedHealthy:
        !closing &&
        state.appExitCode === null &&
        state.guardExitCode === null &&
        !state.stopped &&
        !state.stopRequested &&
        listeners.every((item) => item.observation.kind === "observed-healthy"),
      listeners: Object.freeze(listeners),
    });
  }
  return Object.freeze({
    prepare(input: unknown) {
      const value = selection(input);
      return mutation(value, async () => {
        if (closing) return Object.freeze({ kind: "closing" as const });
        if (!adapters.preflightPreparation)
          return Object.freeze({ kind: "preparation-unavailable" as const });
        if (preparations.size)
          return Object.freeze({
            kind: "preparation-cleanup-required" as const,
          });
        const directory = await authorized(value, "prepare");
        if (!directory) return Object.freeze({ kind: "denied" as const });
        if (closing) return Object.freeze({ kind: "closing" as const });
        // Until shared-owner overlap resolution is composed, do not mutate
        // dependencies while any other managed app could be consuming them.
        if ([...runs.keys()].some((id) => id !== key(value)))
          return Object.freeze({ kind: "other-app-managed" as const });
        const run = runs.get(key(value));
        if (run && run.directory !== directory)
          return Object.freeze({ kind: "scope-changed" as const });
        let plan: Plan;
        let preparation: Awaited<
          ReturnType<NonNullable<typeof adapters.preflightPreparation>>
        >;
        try {
          plan = await read(value, directory);
          preparation = await adapters.preflightPreparation(
            plan,
            dirname(join(directory, value.package)),
          );
        } catch {
          return Object.freeze({
            kind: "preparation-preflight-failed" as const,
          });
        }
        preparations.add(preparation);
        try {
          if (closing) return Object.freeze({ kind: "closing" as const });
          if ((await authorized(value, "prepare")) !== directory)
            return Object.freeze({ kind: "denied" as const });
          if (
            JSON.stringify(await read(value, directory)) !==
            JSON.stringify(plan)
          )
            return Object.freeze({ kind: "declaration-changed" as const });
          if (run) {
            if ((await authorized(value, "stop")) !== directory)
              return Object.freeze({ kind: "denied" as const });
            if ((await run.handle.stop()).kind !== "group-stopped")
              return Object.freeze({
                kind: "preparation-cleanup-required" as const,
              });
            runs.delete(key(value));
          }
          if (closing) return Object.freeze({ kind: "closing" as const });
          if ((await authorized(value, "prepare")) !== directory)
            return Object.freeze({ kind: "denied" as const });
          if (closing) return Object.freeze({ kind: "closing" as const });
          if (
            JSON.stringify(await read(value, directory)) !==
            JSON.stringify(plan)
          )
            return Object.freeze({ kind: "declaration-changed" as const });
          const result = await preparation.run(preparationAbort.signal);
          if ((await preparation.close()).kind !== "closed")
            return Object.freeze({
              kind: "preparation-cleanup-required" as const,
            });
          preparations.delete(preparation);
          if (
            JSON.stringify(await read(value, directory)) !==
            JSON.stringify(plan)
          )
            return Object.freeze({ kind: "declaration-changed" as const });
          return Object.freeze(result);
        } catch {
          return Object.freeze({ kind: "preparation-failed" as const });
        } finally {
          if (preparations.has(preparation)) {
            try {
              if ((await preparation.close()).kind === "closed")
                preparations.delete(preparation);
            } catch {
              /* retained for owner shutdown; never claim ready */
            }
          }
        }
      });
    },
    start(input: unknown) {
      const value = selection(input);
      return mutation(value, async () => {
        if (closing) return Object.freeze({ kind: "closing" as const });
        if (preparations.size)
          return Object.freeze({
            kind: "preparation-cleanup-required" as const,
          });
        const directory = await authorized(value, "start");
        if (!directory) return Object.freeze({ kind: "denied" as const });
        if (closing) return Object.freeze({ kind: "closing" as const });
        const existing = runs.get(key(value));
        if (existing) {
          if (existing.directory !== directory)
            return Object.freeze({ kind: "scope-changed" as const });
          const state = existing.handle.inspect();
          if (
            state.stopRequested ||
            state.appExitCode !== null ||
            state.guardExitCode !== null
          )
            return Object.freeze({
              kind: "application-cleanup-required" as const,
            });
          return Object.freeze({ kind: "already-managed" as const });
        }
        let plan: Plan;
        let launch: ReturnType<typeof parseProcessLaunch>;
        try {
          plan = await read(value, directory);
          const cwd = dirname(join(directory, value.package));
          launch = parseProcessLaunch(await adapters.prepareLaunch(plan, cwd));
          if (launch.cwd !== cwd) throw new Error("Launch path mismatch");
          if (
            JSON.stringify(await read(value, directory)) !==
            JSON.stringify(plan)
          )
            return Object.freeze({ kind: "declaration-changed" as const });
        } catch {
          return Object.freeze({ kind: "invalid-or-unavailable" as const });
        }
        // Serialize this owner's starts and refuse any observed existing binding.
        // Absence is not an OS reservation; status still checks actual ownership.
        for (const listener of plan.listeners) {
          if (
            [...runs.values()].some((run) =>
              run.plan.listeners.some((other) => other.port === listener.port),
            )
          )
            return Object.freeze({ kind: "port-managed" as const });
          const bindings = await observeListenerBindings(listener.port);
          if (bindings.kind !== "observed")
            return Object.freeze({ kind: "inspection-unavailable" as const });
          if (bindings.bindings.length)
            return Object.freeze({ kind: "port-occupied" as const });
        }
        if (closing) return Object.freeze({ kind: "closing" as const });
        if ((await authorized(value, "start")) !== directory)
          return Object.freeze({ kind: "denied" as const });
        try {
          if (
            JSON.stringify(await read(value, directory)) !==
            JSON.stringify(plan)
          )
            return Object.freeze({ kind: "declaration-changed" as const });
        } catch {
          return Object.freeze({ kind: "declaration-changed" as const });
        }
        if (closing) return Object.freeze({ kind: "closing" as const });
        // The toolchain adapter must honor the declared script and prerequisites.
        // Stable cooperative filesystem custody remains required until spawn.
        let handle: Handle;
        try {
          handle = await startGuardedProcess(
            launch,
            adapters.platformExecutable,
          );
        } catch {
          return Object.freeze({ kind: "launch-failed" as const });
        }
        runs.set(key(value), { directory, plan, handle });
        if ((await handle.started).kind !== "started") {
          if ((await handle.stop()).kind === "group-stopped")
            runs.delete(key(value));
          return Object.freeze({ kind: "launch-failed" as const });
        }
        return Object.freeze({ kind: "started" as const });
      });
    },
    async entrypoint(input: unknown) {
      const value = selection(input);
      if (closing) return Object.freeze({ kind: "closing" as const });
      const directory = await authorized(value, "open");
      if (!directory) return Object.freeze({ kind: "denied" as const });
      const run = runs.get(key(value));
      if (!run) return Object.freeze({ kind: "not-managed" as const });
      if (run.directory !== directory)
        return Object.freeze({ kind: "scope-changed" as const });
      const listener = run.plan.listeners.find(
        (item) => item.role === "entrypoint",
      );
      if (!listener || !["http", "https"].includes(listener.protocol))
        return Object.freeze({ kind: "no-browser-entrypoint" as const });
      const observation = await inspect(run);
      if (!observation.observedHealthy)
        return Object.freeze({ kind: "not-ready" as const });
      if ((await authorized(value, "open")) !== directory)
        return Object.freeze({ kind: "denied" as const });
      try {
        if (
          JSON.stringify(await read(value, directory)) !==
          JSON.stringify(run.plan)
        )
          return Object.freeze({ kind: "declaration-changed" as const });
      } catch {
        return Object.freeze({ kind: "declaration-changed" as const });
      }
      const state = run.handle.inspect();
      if (
        closing ||
        runs.get(key(value)) !== run ||
        state.stopRequested ||
        state.appExitCode !== null ||
        state.guardExitCode !== null
      )
        return Object.freeze({ kind: "not-ready" as const });
      const host = listener.host.includes(":")
        ? `[${listener.host}]`
        : listener.host;
      // Execution-Machine loopback only, never production_url or the health path.
      // The interface owns browser opening / a qualified remote route. This is a
      // fresh observation, not proof that a browser opened or a function worked.
      return Object.freeze({
        kind: "local-entrypoint" as const,
        url: `${listener.protocol}://${host}:${listener.port}/`,
      });
    },
    async status(input: unknown) {
      const value = selection(input);
      const directory = await authorized(value, "status");
      if (!directory) return Object.freeze({ kind: "denied" as const });
      const run = runs.get(key(value));
      if (!run) return Object.freeze({ kind: "not-managed" as const });
      if (run.directory !== directory)
        return Object.freeze({ kind: "scope-changed" as const });
      return inspect(run);
    },
    stop(input: unknown) {
      const value = selection(input);
      return mutation(value, async () => {
        const directory = await authorized(value, "stop");
        if (!directory) return Object.freeze({ kind: "denied" as const });
        const run = runs.get(key(value));
        if (!run) return Object.freeze({ kind: "not-managed" as const });
        if (run.directory !== directory)
          return Object.freeze({ kind: "scope-changed" as const });
        const result = await run.handle.stop();
        if (result.kind === "group-stopped") runs.delete(key(value));
        return result;
      });
    },
    close() {
      closing = true;
      preparationAbort.abort();
      return mutation(null, async () => {
        for (const preparation of preparations) {
          try {
            if ((await preparation.close()).kind === "closed")
              preparations.delete(preparation);
          } catch {
            /* retain incomplete owned work */
          }
        }
        for (const [id, run] of runs) {
          if ((await run.handle.stop()).kind === "group-stopped")
            runs.delete(id);
        }
        return Object.freeze({
          kind:
            runs.size || preparations.size
              ? ("incomplete" as const)
              : ("closed" as const),
        });
      });
    },
  });
}
