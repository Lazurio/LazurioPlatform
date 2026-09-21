import type { probeListenerHealth } from "./health";
import type { parseProcessLaunch } from "./process-launch";

// The single seam between the application lifecycle core and whoever OWNS a
// running application's processes. The core owns authorization, declaration
// revalidation and sequencing; a runner owns processes, their identity and the
// evidence that a listener belongs to them. Two implementations exist:
// `session` (guarded process group, dies with its Launchpad) and `systemd-user`
// (a transient user service, owned by the OS service manager). No runner adopts,
// replaces or signals a process or unit it cannot prove is its own.
export type ApplicationRef = Readonly<{
  company: string;
  module: string;
  package: string;
}>;
export type ProcessLaunch = ReturnType<typeof parseProcessLaunch>;
export type RunnerKind = "session" | "systemd-user";

// Service-manager identity of one invocation. Never a saved PID: a new start of
// the same application gets a new invocation id from the manager.
export type ServiceIdentity = Readonly<{
  unit: string;
  invocationId: string;
  activeState: string;
  subState: string;
  result: string;
}>;

export type ApplicationState = Readonly<
  | { kind: "not-running" }
  | {
      kind: "running";
      phase: "starting" | "running" | "stopping";
      cwd: string;
      // Digest of the declaration this invocation was started from; null only
      // when the owner cannot report it (never guessed from the current files).
      declarationDigest: string | null;
      service: ServiceIdentity | null;
    }
  | {
      // The application is no longer running but its owner still holds a record:
      // an exited session group awaiting confirmed cleanup, or a failed unit.
      kind: "ended";
      cwd: string;
      result: string;
      // `explicit-stop`: only Stop may clear it. `on-start`: the owner proved no
      // process remains, so a new Start may clear the record itself.
      cleanup: "explicit-stop" | "on-start";
      service: ServiceIdentity | null;
    }
  // Something answers to this application's name that this runner did not
  // create in its expected shape. It is reported and never touched.
  | { kind: "unrecognized" }
  | { kind: "unavailable" }
>;

export type ApplicationStart = Readonly<{
  application: ApplicationRef;
  launch: ProcessLaunch;
  declarationDigest: string;
  // Declared listener ports; the runner refuses any observed or claimed binding.
  ports: readonly number[];
}>;

export type StartResult = Readonly<
  | { kind: "started" }
  | { kind: "launch-failed" }
  | { kind: "already-managed" }
  | { kind: "application-cleanup-required" }
  | { kind: "port-managed" }
  | { kind: "port-occupied" }
  | { kind: "inspection-unavailable" }
>;

export type StopResult = Readonly<
  // The owner confirmed the whole group is gone: the process group for a
  // session application, the control group for a service.
  { kind: "group-stopped" } | { kind: "incomplete" }>;

export type ListenerObservation = Readonly<
  | { kind: "lifecycle-inactive" }
  | { kind: "ownership-unconfirmed"; reason: string }
  | { kind: "bindings-changed" }
  | {
      kind: "observed-healthy" | "health-failed";
      health: Awaited<ReturnType<typeof probeListenerHealth>>;
    }
>;

export type RunningApplication = Readonly<{
  // Owner-local identifier, comparable with `identify(application)`.
  id: string;
  state: "running" | "ended";
}>;

export interface ApplicationRunner {
  readonly kind: RunnerKind;
  // True when applications keep running after the lifecycle owner (Launchpad)
  // exits. The core then refuses to stop a running application as a side effect
  // of dependency preparation, and owner shutdown leaves applications alone.
  readonly survivesOwnerExit: boolean;
  identify(application: ApplicationRef): string;
  inspect(application: ApplicationRef): Promise<ApplicationState>;
  start(request: ApplicationStart): Promise<StartResult>;
  // One bounded readiness observation: declared health combined with fresh
  // evidence that the listener belongs to this application's owner.
  observeListener(
    application: ApplicationRef,
    listener: unknown,
    timeoutMs?: number,
  ): Promise<ListenerObservation>;
  stop(application: ApplicationRef): Promise<StopResult>;
  // Applications this owner currently holds for its Organization directory.
  list(): Promise<
    Readonly<
      | { kind: "listed"; applications: readonly RunningApplication[] }
      | { kind: "unavailable" }
    >
  >;
  // Owner shutdown. A session runner drains every group it started; a service
  // runner stops nothing, because it never owned the processes' lifetime.
  close(): Promise<Readonly<{ kind: "closed" | "incomplete" }>>;
}

// Explicit and narrow selection, no other detection: Linux with a reachable user
// service manager gets `systemd-user`; everything else gets `session`. An
// explicit request is honored exactly or refused, never silently downgraded.
export async function selectApplicationRunnerKind(input: {
  platform: string;
  environment: Readonly<Record<string, string | undefined>>;
  requested?: string;
  userManagerState: () => Promise<string | null>;
}): Promise<RunnerKind> {
  const requested = input.requested ?? "auto";
  if (!["auto", "session", "systemd-user"].includes(requested))
    throw new Error("Unknown application runner");
  if (requested === "session") return "session";
  const runtimeDirectory = input.environment.XDG_RUNTIME_DIR;
  const reachable =
    input.platform === "linux" &&
    typeof runtimeDirectory === "string" &&
    runtimeDirectory.startsWith("/") &&
    ["running", "degraded", "starting"].includes(
      (await input.userManagerState()) ?? "",
    );
  if (reachable) return "systemd-user";
  if (requested === "systemd-user")
    throw new Error("Requested user service manager is not reachable");
  return "session";
}
