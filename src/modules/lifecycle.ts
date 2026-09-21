import { dirname, join } from "node:path";
import type { ApplicationRunner } from "./application-runner";
import { object, text } from "./manifest";
import { parseProcessLaunch } from "./process-launch";
import { readModuleApplication } from "./read-application";

type Selection = Readonly<{ company: string; module: string; package: string }>;
type Operation =
  | "start"
  | "status"
  | "open"
  | "stop"
  | "prepare"
  | "clean-prepare";
export type CoordinationRefusal = Readonly<{
  kind: "coordination-busy" | "preparation-recovery-required" | "closing";
}>;
type Plan = Extract<
  Awaited<ReturnType<typeof readModuleApplication>>,
  { kind: "declared-runtime-plan" }
>;
type PreparationFactory = (
  plan: Plan,
  cwd: string,
) => Promise<{
  run: (
    signal: AbortSignal,
  ) => Promise<{ kind: "prepared" | "preparation-failed" }>;
  close: () => Promise<{ kind: "closed" | "incomplete" }>;
}>;

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
// This core owns authorization, declaration revalidation and sequencing only.
// Process ownership, identity and listener ownership evidence live entirely
// behind `runner`; nothing here remembers which applications are running, so a
// new instance sees exactly what the runner's owner reports.
export function createApplicationLifecycle(adapters: {
  runner: ApplicationRunner;
  authorize: (
    selection: Selection,
    operation: Operation,
  ) => Promise<{ moduleDirectory: string }>;
  prepareLaunch: (plan: Plan, cwd: string) => Promise<unknown>;
  // Explicit module preparation. Preflight is read-only and checks its actual
  // dependency owner before any app stop. The effect owns bounded subprocess
  // cleanup; close remains retained if cleanup cannot be confirmed.
  preflightPreparation?: PreparationFactory;
  // Optional start-time check, without install/repair. Its subprocess ownership
  // is retained in the same set and drained by the same shutdown as preparation.
  preflightStartCheck?: PreparationFactory;
  // Separate explicit capability: never substitute ordinary preparation when
  // the caller asks to discard and regenerate derived dependencies.
  preflightCleanPreparation?: PreparationFactory;
  // Trusted composition boundary for cross-process exclusion. null selects owner
  // shutdown; the coordinator must drain its accepted mutations. `intent` lets the
  // composition choose the KIND of exclusion: a transaction that can die
  // half-written (preparation) versus coordination of operations whose truth
  // lives in the application's owner. It may refuse with a typed result instead
  // of running the action; it never runs the action more than once.
  coordinateMutation?: <T>(
    selection: Selection | null,
    action: () => Promise<T>,
    intent?: Operation,
  ) => Promise<T | CoordinationRefusal>;
}) {
  const runner = adapters.runner;
  let queue = Promise.resolve();
  let closing = false;
  const preparationAbort = new AbortController();
  const preparations = new Set<
    Awaited<ReturnType<NonNullable<typeof adapters.preflightPreparation>>>
  >();
  const applicationDirectory = (value: Selection, directory: string) =>
    dirname(join(directory, value.package));
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function mutation<T>(
    value: Selection | null,
    operation: () => Promise<T>,
    intent?: Operation,
  ) {
    // Reject an invalid selection before an owner coordinator tries to resolve
    // its filesystem scope. The operation still rechecks authority under lock.
    if (adapters.coordinateMutation && value !== null && intent) {
      if (closing) return Object.freeze({ kind: "closing" as const });
      const directory = await authorized(value, intent);
      if (closing) return Object.freeze({ kind: "closing" as const });
      if (!directory) return Object.freeze({ kind: "denied" as const });
    }
    return adapters.coordinateMutation
      ? adapters.coordinateMutation(value, () => exclusive(operation), intent)
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
  type Held = Extract<
    Awaited<ReturnType<ApplicationRunner["inspect"]>>,
    { kind: "running" | "ended" }
  >;
  const ownership = () => ({
    runner: runner.kind,
    // The interface may tell people that this application keeps running when
    // the Launchpad restarts. It is a property of the owner, not a promise of
    // persistence across a reboot.
    survivesLaunchpadRestart: runner.survivesOwnerExit,
  });
  // Shared answer for an owner that cannot be read, or a record under this
  // application's name that this owner did not create: nothing is touched.
  function unusable(state: Awaited<ReturnType<ApplicationRunner["inspect"]>>) {
    if (state.kind === "unavailable")
      return Object.freeze({ kind: "inspection-unavailable" as const });
    if (state.kind === "unrecognized")
      return Object.freeze({ kind: "service-unrecognized" as const });
    return null;
  }
  async function inspect(value: Selection, directory: string, state: Held) {
    if (state.kind === "ended")
      return Object.freeze({
        kind: "status" as const,
        ...ownership(),
        state: "ended" as const,
        result: state.result,
        ...(state.service ? { service: state.service } : {}),
        observedHealthy: false,
        listeners: Object.freeze([]),
      });
    // Observe the declaration this invocation was started from. A changed or
    // unreadable declaration is never observed as the running application.
    let plan: Plan | null = null;
    try {
      plan = await read(value, directory);
    } catch {
      plan = null;
    }
    const current =
      plan !== null && plan.declarationDigest === state.declarationDigest;
    const listeners = [];
    if (plan && current)
      for (const listener of plan.listeners) {
        const { host, port, protocol, health } = listener;
        const observation = await runner.observeListener(value, {
          host,
          port,
          protocol,
          health,
        });
        listeners.push(Object.freeze({ id: listener.id, observation }));
      }
    return Object.freeze({
      kind: "status" as const,
      ...ownership(),
      state: state.phase,
      ...(state.service ? { service: state.service } : {}),
      ...(current ? {} : { declarationChanged: true }),
      // Each endpoint is a snapshot, not a cross-listener atomic transaction.
      observedHealthy:
        !closing &&
        current &&
        state.phase === "running" &&
        listeners.every((item) => item.observation.kind === "observed-healthy"),
      listeners: Object.freeze(listeners),
    });
  }
  return Object.freeze({
    prepare(input: unknown, mode: "prepare" | "clean-prepare" = "prepare") {
      if (!["prepare", "clean-prepare"].includes(mode))
        throw new Error("Invalid preparation mode");
      const value = selection(input);
      const preflight =
        mode === "clean-prepare"
          ? adapters.preflightCleanPreparation
          : adapters.preflightPreparation;
      return mutation(
        value,
        async () => {
          if (closing) return Object.freeze({ kind: "closing" as const });
          if (!preflight)
            return Object.freeze({ kind: "preparation-unavailable" as const });
          if (preparations.size)
            return Object.freeze({
              kind: "preparation-cleanup-required" as const,
            });
          const directory = await authorized(value, mode);
          if (!directory) return Object.freeze({ kind: "denied" as const });
          if (closing) return Object.freeze({ kind: "closing" as const });
          // Until shared-owner overlap resolution is composed, do not mutate
          // dependencies while any other managed app could be consuming them.
          const held = await runner.list();
          if (held.kind !== "listed")
            return Object.freeze({ kind: "inspection-unavailable" as const });
          if (
            held.applications.some((item) => item.id !== runner.identify(value))
          )
            return Object.freeze({ kind: "other-app-managed" as const });
          const state = await runner.inspect(value);
          const refused = unusable(state);
          if (refused) return refused;
          const run =
            state.kind === "running" || state.kind === "ended" ? state : null;
          if (run && run.cwd !== applicationDirectory(value, directory))
            return Object.freeze({ kind: "scope-changed" as const });
          // A session application exists only inside this session and is stopped
          // for its own preparation. An application owned by the service manager may be
          // in use by people who never asked for this: refuse before any effect.
          if (run?.kind === "running" && runner.survivesOwnerExit)
            return Object.freeze({ kind: "application-running" as const });
          let plan: Plan;
          let preparation: Awaited<
            ReturnType<NonNullable<typeof adapters.preflightPreparation>>
          >;
          try {
            plan = await read(value, directory);
            preparation = await preflight(
              plan,
              applicationDirectory(value, directory),
            );
          } catch {
            return Object.freeze({
              kind: "preparation-preflight-failed" as const,
            });
          }
          preparations.add(preparation);
          try {
            if (closing) return Object.freeze({ kind: "closing" as const });
            if ((await authorized(value, mode)) !== directory)
              return Object.freeze({ kind: "denied" as const });
            if (
              JSON.stringify(await read(value, directory)) !==
              JSON.stringify(plan)
            )
              return Object.freeze({ kind: "declaration-changed" as const });
            if (run) {
              if ((await authorized(value, "stop")) !== directory)
                return Object.freeze({ kind: "denied" as const });
              if ((await runner.stop(value)).kind !== "group-stopped")
                return Object.freeze({
                  kind: "preparation-cleanup-required" as const,
                });
            }
            if (closing) return Object.freeze({ kind: "closing" as const });
            if ((await authorized(value, mode)) !== directory)
              return Object.freeze({ kind: "denied" as const });
            if (closing) return Object.freeze({ kind: "closing" as const });
            if (
              JSON.stringify(await read(value, directory)) !==
              JSON.stringify(plan)
            )
              return Object.freeze({ kind: "declaration-changed" as const });
            // The owner's view immediately before the effect: dependencies are
            // never changed beneath an application that is running right now.
            if ((await runner.inspect(value)).kind !== "not-running")
              return Object.freeze({
                kind: runner.survivesOwnerExit
                  ? ("application-running" as const)
                  : ("preparation-cleanup-required" as const),
              });
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
        },
        mode,
      );
    },
    start(input: unknown) {
      const value = selection(input);
      return mutation(
        value,
        async () => {
          if (closing) return Object.freeze({ kind: "closing" as const });
          if (preparations.size)
            return Object.freeze({
              kind: "preparation-cleanup-required" as const,
            });
          const directory = await authorized(value, "start");
          if (!directory) return Object.freeze({ kind: "denied" as const });
          if (closing) return Object.freeze({ kind: "closing" as const });
          const cwd = applicationDirectory(value, directory);
          const existing = await runner.inspect(value);
          const refused = unusable(existing);
          if (refused) return refused;
          if (existing.kind === "running" || existing.kind === "ended") {
            if (existing.cwd !== cwd)
              return Object.freeze({ kind: "scope-changed" as const });
            if (existing.kind === "running")
              return Object.freeze({ kind: "already-managed" as const });
            // An ended record is cleared by this Start only when its owner has
            // proved that no process remains; otherwise Stop must confirm it.
            if (existing.cleanup === "explicit-stop")
              return Object.freeze({
                kind: "application-cleanup-required" as const,
              });
          }
          let plan: Plan;
          let launch: ReturnType<typeof parseProcessLaunch>;
          try {
            plan = await read(value, directory);
            if (adapters.preflightStartCheck) {
              const check = await adapters.preflightStartCheck(plan, cwd);
              preparations.add(check);
              try {
                if (closing) return Object.freeze({ kind: "closing" as const });
                if ((await authorized(value, "start")) !== directory)
                  return Object.freeze({ kind: "denied" as const });
                if (
                  JSON.stringify(await read(value, directory)) !==
                  JSON.stringify(plan)
                )
                  return Object.freeze({
                    kind: "declaration-changed" as const,
                  });
                const result = await check.run(preparationAbort.signal);
                if ((await check.close()).kind !== "closed")
                  return Object.freeze({
                    kind: "preparation-cleanup-required" as const,
                  });
                preparations.delete(check);
                if (result.kind !== "prepared")
                  return Object.freeze({
                    kind: "prerequisites-not-ready" as const,
                  });
              } finally {
                if (preparations.has(check)) {
                  try {
                    if ((await check.close()).kind === "closed")
                      preparations.delete(check);
                  } catch {
                    /* retain incomplete check ownership for shutdown */
                  }
                }
              }
            }
            if (closing) return Object.freeze({ kind: "closing" as const });
            launch = parseProcessLaunch(
              await adapters.prepareLaunch(plan, cwd),
            );
            if (launch.cwd !== cwd) throw new Error("Launch path mismatch");
            if (
              JSON.stringify(await read(value, directory)) !==
              JSON.stringify(plan)
            )
              return Object.freeze({ kind: "declaration-changed" as const });
          } catch {
            return Object.freeze({ kind: "invalid-or-unavailable" as const });
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
          // The runner serializes nothing itself: this owner's queue does. It
          // refuses a claimed or observed port before it creates any process.
          // Absence is not an OS reservation; status still checks ownership.
          return runner.start(
            Object.freeze({
              application: value,
              launch,
              declarationDigest: plan.declarationDigest,
              ports: Object.freeze(plan.listeners.map((item) => item.port)),
            }),
          );
        },
        "start",
      );
    },
    async entrypoint(input: unknown) {
      const value = selection(input);
      if (closing) return Object.freeze({ kind: "closing" as const });
      const directory = await authorized(value, "open");
      if (!directory) return Object.freeze({ kind: "denied" as const });
      const run = await runner.inspect(value);
      const refused = unusable(run);
      if (refused) return refused;
      if (run.kind !== "running" && run.kind !== "ended")
        return Object.freeze({ kind: "not-managed" as const });
      if (run.cwd !== applicationDirectory(value, directory))
        return Object.freeze({ kind: "scope-changed" as const });
      if (run.kind === "ended")
        return Object.freeze({ kind: "not-ready" as const });
      let plan: Plan;
      try {
        plan = await read(value, directory);
      } catch {
        return Object.freeze({ kind: "declaration-changed" as const });
      }
      if (plan.declarationDigest !== run.declarationDigest)
        return Object.freeze({ kind: "declaration-changed" as const });
      const listener = plan.listeners.find(
        (item) => item.role === "entrypoint",
      );
      if (!listener || !["http", "https"].includes(listener.protocol))
        return Object.freeze({ kind: "no-browser-entrypoint" as const });
      const observation = await inspect(value, directory, run);
      if (!observation.observedHealthy)
        return Object.freeze({
          kind:
            "declarationChanged" in observation
              ? ("declaration-changed" as const)
              : ("not-ready" as const),
        });
      if ((await authorized(value, "open")) !== directory)
        return Object.freeze({ kind: "denied" as const });
      try {
        if (
          JSON.stringify(await read(value, directory)) !== JSON.stringify(plan)
        )
          return Object.freeze({ kind: "declaration-changed" as const });
      } catch {
        return Object.freeze({ kind: "declaration-changed" as const });
      }
      // The same invocation must still be running after the observation.
      const latest = await runner.inspect(value);
      if (
        closing ||
        latest.kind !== "running" ||
        latest.phase !== "running" ||
        latest.cwd !== run.cwd ||
        latest.declarationDigest !== run.declarationDigest ||
        latest.service?.invocationId !== run.service?.invocationId
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
      const run = await runner.inspect(value);
      const refused = unusable(run);
      if (refused) return refused;
      if (run.kind !== "running" && run.kind !== "ended")
        return Object.freeze({ kind: "not-managed" as const });
      if (run.cwd !== applicationDirectory(value, directory))
        return Object.freeze({ kind: "scope-changed" as const });
      return inspect(value, directory, run);
    },
    stop(input: unknown) {
      const value = selection(input);
      return mutation(
        value,
        async () => {
          const directory = await authorized(value, "stop");
          if (!directory) return Object.freeze({ kind: "denied" as const });
          const run = await runner.inspect(value);
          const refused = unusable(run);
          if (refused) return refused;
          if (run.kind !== "running" && run.kind !== "ended")
            return Object.freeze({ kind: "not-managed" as const });
          if (run.cwd !== applicationDirectory(value, directory))
            return Object.freeze({ kind: "scope-changed" as const });
          return runner.stop(value);
        },
        "stop",
      );
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
        // The runner decides what owner shutdown means: a session runner drains
        // every group it started, a service runner leaves applications running.
        const applications = await runner.close();
        return Object.freeze({
          kind:
            applications.kind !== "closed" || preparations.size
              ? ("incomplete" as const)
              : ("closed" as const),
        });
      });
    },
  });
}
