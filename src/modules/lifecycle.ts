import { dirname, join } from "node:path";
import { startGuardedProcess } from "./guarded-process";
import { observeListenerBindings } from "./listener-ownership";
import { object, text } from "./manifest";
import { parseProcessLaunch } from "./process-launch";
import { readModuleApplication } from "./read-application";

type Selection = Readonly<{ company: string; module: string; package: string }>;
type Operation = "start" | "status" | "stop";
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
}) {
  const runs = new Map<
    string,
    { directory: string; plan: Plan; handle: Handle }
  >();
  let queue = Promise.resolve();
  let closing = false;
  const key = (value: Selection) => JSON.stringify(value);
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
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
    start(input: unknown) {
      const value = selection(input);
      return exclusive(async () => {
        if (closing) return Object.freeze({ kind: "closing" as const });
        const directory = await authorized(value, "start");
        if (!directory) return Object.freeze({ kind: "denied" as const });
        const existing = runs.get(key(value));
        if (existing)
          return existing.directory === directory
            ? Object.freeze({ kind: "already-managed" as const })
            : Object.freeze({ kind: "scope-changed" as const });
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
      return exclusive(async () => {
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
      return exclusive(async () => {
        for (const [id, run] of runs) {
          if ((await run.handle.stop()).kind === "group-stopped")
            runs.delete(id);
        }
        return Object.freeze({
          kind: runs.size ? ("incomplete" as const) : ("closed" as const),
        });
      });
    },
  });
}
