import type {
  ApplicationRef,
  ApplicationRunner,
  ApplicationState,
} from "./application-runner";
import { startGuardedProcess } from "./guarded-process";
import { refuseOccupiedPorts } from "./listener-observation";

type Handle = Awaited<ReturnType<typeof startGuardedProcess>>;

// Session-scoped owner: every application is a guarded process group that is a
// child of this process and dies with it. This is the macOS contract and the
// fallback wherever no user service manager is reachable. State is in memory by
// design: there is no locator, durable PID adoption or rediscovery after exit.
export function createSessionRunner(
  platformExecutable: string,
): ApplicationRunner {
  const runs = new Map<
    string,
    Readonly<{
      cwd: string;
      declarationDigest: string;
      ports: readonly number[];
      handle: Handle;
    }>
  >();
  const identify = (application: ApplicationRef) =>
    JSON.stringify([
      application.company,
      application.module,
      application.package,
    ]);
  const ended = (handle: Handle) => {
    const state = handle.inspect();
    return (
      state.stopRequested ||
      state.appExitCode !== null ||
      state.guardExitCode !== null
    );
  };
  const runner: ApplicationRunner = {
    kind: "session" as const,
    survivesOwnerExit: false,
    identify,
    async inspect(application: ApplicationRef): Promise<ApplicationState> {
      const run = runs.get(identify(application));
      if (!run) return Object.freeze({ kind: "not-running" as const });
      if (ended(run.handle)) {
        const state = run.handle.inspect();
        return Object.freeze({
          kind: "ended" as const,
          cwd: run.cwd,
          // Escaped descendants may remain: only a confirmed Stop clears it.
          cleanup: "explicit-stop" as const,
          result: state.stopRequested
            ? "stop-incomplete"
            : state.appExitCode !== null
              ? "application-exited"
              : "guard-exited",
          service: null,
        });
      }
      return Object.freeze({
        kind: "running" as const,
        phase: "running" as const,
        cwd: run.cwd,
        declarationDigest: run.declarationDigest,
        service: null,
      });
    },
    async start(request) {
      const id = identify(request.application);
      const existing = runs.get(id);
      if (existing)
        return Object.freeze({
          kind: ended(existing.handle)
            ? ("application-cleanup-required" as const)
            : ("already-managed" as const),
        });
      // Refuse this owner's already claimed port, then any observed binding.
      for (const port of request.ports)
        if ([...runs.values()].some((run) => run.ports.includes(port)))
          return Object.freeze({ kind: "port-managed" as const });
      const refusal = await refuseOccupiedPorts(request.ports);
      if (refusal) return refusal;
      let handle: Handle;
      try {
        handle = await startGuardedProcess(request.launch, platformExecutable);
      } catch {
        return Object.freeze({ kind: "launch-failed" as const });
      }
      runs.set(
        id,
        Object.freeze({
          cwd: request.launch.cwd,
          declarationDigest: request.declarationDigest,
          ports: Object.freeze([...request.ports]),
          handle,
        }),
      );
      if ((await handle.started).kind !== "started") {
        if ((await handle.stop()).kind === "group-stopped") runs.delete(id);
        return Object.freeze({ kind: "launch-failed" as const });
      }
      return Object.freeze({ kind: "started" as const });
    },
    async observeListener(application, listener, timeoutMs = 1500) {
      const run = runs.get(identify(application));
      if (!run) return Object.freeze({ kind: "lifecycle-inactive" as const });
      return run.handle.observeListener(listener, timeoutMs);
    },
    async stop(application) {
      const id = identify(application);
      const run = runs.get(id);
      if (!run) return Object.freeze({ kind: "group-stopped" as const });
      const result = await run.handle.stop();
      // Remove the record only after confirmed group cleanup.
      if (result.kind === "group-stopped") runs.delete(id);
      return result;
    },
    async list() {
      return Object.freeze({
        kind: "listed" as const,
        applications: Object.freeze(
          [...runs].map(([id, run]) =>
            Object.freeze({
              id,
              state: ended(run.handle)
                ? ("ended" as const)
                : ("running" as const),
            }),
          ),
        ),
      });
    },
    async close() {
      for (const [id, run] of runs)
        if ((await run.handle.stop()).kind === "group-stopped") runs.delete(id);
      return Object.freeze({
        kind: runs.size ? ("incomplete" as const) : ("closed" as const),
      });
    },
  };
  return Object.freeze(runner);
}
