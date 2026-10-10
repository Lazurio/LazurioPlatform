import { access, constants, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, FileLockError } from "../platform/flock";
import type { InstallFetch } from "../tools/install";
import type { ToolRunner } from "../tools/status";
import { compareVersions } from "../update/version";
import {
  type AgentRegistration,
  type AgentsFacts,
  ensureAgents,
  observeAgents,
} from "./agents";
import {
  type InstallFailureStage,
  inspectEntry,
  installPinnedExecutor,
  markedVersion,
  pinnedBinary,
  removeOlderInstallations,
} from "./install";
import {
  type ExecutorPin,
  executorAddress,
  executorPin,
  executorTarget,
} from "./pin";
import {
  type ExecutorServiceFacts,
  ensureExecutorService,
  observeExecutorService,
} from "./service";

// Executor in a Remote Environment (decision F44): one core for the CLI
// (`lazurio executor status|setup`), the Launchpad (Settings → Tools →
// executor, and its own setup after it starts) and the report of `lazurio
// install` and `lazurio update`, which only read the status (addendum of
// 2026-10-11). Status-driven and idempotent: `setup` reads what is there and
// moves it on (the pinned program and the entry, the service, the agents),
// so an interrupted one is completed by the next. A setup holds a kernel
// lock in the version root; the journal carries the outcome and a fixed
// reason, never a path, an output or a value.

/** Where Executor is set up: trusted composition, never HTTP input. */
export type ExecutorHost = Readonly<{
  /** Whether Lazurio sets Executor up here, read at the start of every
   * operation. */
  context: () => Promise<ExecutorContext>;
  home: string;
  /** `~/.local/bin`. */
  bin: string;
  /** `~/.local/share/executor-cli`. */
  root: string;
  path: string | undefined;
  /** The process environment the user manager and the harnesses are asked
   * with (only the variables they need are passed on). */
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  arch: string;
  run: ToolRunner;
  uid?: number | undefined;
  /** Test seams: the registry download, the loopback probe, the pin. */
  fetch?: InstallFetch | undefined;
  probe?: (() => Promise<boolean>) | undefined;
  pin?: ExecutorPin | undefined;
  journal?: ((entry: ExecutorJournalEntry) => void) | undefined;
  /** How long a setup waits for another one (default 10 s). */
  lockMs?: number | undefined;
  healthDeadlineMs?: number | undefined;
}>;

/** A workstation (macOS, or no Machine handover: the second wave), a
 * handover that cannot be read, or a process that is not the handover's
 * declared operator. */
export type ExecutorUnsupportedReason =
  | "workstation"
  | "handover-unreadable"
  | "not-operator";

export type ExecutorContext =
  | Readonly<{ kind: "supported" }>
  | Readonly<{ kind: "unsupported"; reason: ExecutorUnsupportedReason }>;

export type ExecutorJournalEntry = Readonly<{
  operation: "setup";
  outcome: string;
  stage?: string;
  reason?: string;
  /** `start`: the setup the Launchpad started itself after its start
   * (addendum of 2026-10-11), not a person's or an agent's. */
  trigger?: "start";
}>;

/** The plain states of the row:
 * - `not-installed`: the pinned Executor is not installed;
 * - `outdated`: Lazurio's entry runs an older pin than this release's;
 * - `conflict`: `~/.local/bin/executor` or an MCP server named `executor` is
 *   not Lazurio's, and Lazurio never replaces it;
 * - `not-running`: installed, and nothing answers on 127.0.0.1:4789;
 * - `incomplete`: it answers, and Lazurio's part is not all there yet (its
 *   unit runs another program, Lazurio's drop-in, an agent's entry);
 * - `running`: installed, running and every installed agent connected. */
export type ExecutorState =
  | "not-installed"
  | "outdated"
  | "conflict"
  | "not-running"
  | "incomplete"
  | "running";

/** The service in a word: `running`, `stopped`, `failed`, `missing` (no
 * unit), `other` (a unit of another program) or `unknown` (the user manager
 * could not be asked). */
export type ExecutorService =
  | "running"
  | "stopped"
  | "failed"
  | "missing"
  | "other"
  | "unknown";

export type ExecutorFailureStage =
  | InstallFailureStage
  | "service"
  | "agents"
  | "busy";

export type ExecutorFacts = Readonly<{
  /** The version this release pins: what setup installs. */
  version: string;
  /** The version Lazurio's entry runs, null when there is none. */
  installed: string | null;
  /** Always the loopback address: the service listens nowhere else. */
  address: string;
  entry: "lazurio" | "missing" | "conflict";
  service: ExecutorService;
  /** Lazurio's drop-in of the service. */
  settings: "current" | "missing" | "different";
  answering: boolean;
  linger: "yes" | "no" | "unknown";
  agents: AgentsFacts;
}>;

export type ExecutorStatus =
  | Readonly<{
      kind: "executor-status";
      state: "unsupported";
      reason: ExecutorUnsupportedReason;
    }>
  | (ExecutorFacts &
      Readonly<{
        kind: "executor-status";
        state: ExecutorState;
        /** The setup that answered stopped here; only in its answer. */
        failure?: Readonly<{ stage: ExecutorFailureStage; reason: string }>;
      }>);

export type ExecutorPhase = "install" | "service" | "agents";

const lockMs = 10_000;
const lockName = ".lazurio.lock";

const older = (version: string, than: string) => {
  try {
    return compareVersions(version, than) < 0;
  } catch {
    return false;
  }
};

/** The row's state from the facts; pure. */
export function executorState(
  facts: ExecutorFacts,
  pin: Pick<ExecutorPin, "version"> = executorPin,
): ExecutorState {
  if (facts.entry === "conflict") return "conflict";
  if (facts.installed === null) return "not-installed";
  if (older(facts.installed, pin.version)) return "outdated";
  const agents: readonly AgentRegistration[] = [
    facts.agents.codex,
    facts.agents.claude,
  ];
  if (agents.includes("conflict")) return "conflict";
  if (!facts.answering) return "not-running";
  if (
    facts.service !== "running" ||
    facts.settings !== "current" ||
    agents.includes("missing") ||
    agents.includes("unknown")
  )
    return "incomplete";
  return "running";
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const serviceWord = (facts: ExecutorServiceFacts | null): ExecutorService => {
  if (facts === null) return "unknown";
  if (facts.unit === "absent") return "missing";
  if (facts.unit === "other") return "other";
  switch (facts.active) {
    case "active":
    case "activating":
    case "reloading":
      return "running";
    case "failed":
      return "failed";
    case "inactive":
    case "deactivating":
      return "stopped";
    case "unknown":
      return "unknown";
  }
};

/** What is there, read-only: the entry and the program it runs (no program
 * is started), the service as the user manager and the loopback port say,
 * and the agents' entries. Nothing is written and the network is not used. */
async function observe(host: ExecutorHost): Promise<ExecutorFacts> {
  const pin = host.pin ?? executorPin;
  const target = executorTarget(host.platform, host.arch);
  const entry = await inspectEntry(host.bin, host.root);
  // The program Lazurio's entry runs: its own version is trusted when a
  // newer release placed it, otherwise its marker in the version root.
  let installed: string | null = null;
  let binary: string | null =
    target === undefined ? null : pinnedBinary(host.root, target, pin);
  if (
    entry.kind === "lazurio" &&
    entry.version !== null &&
    entry.binary !== null &&
    (await executable(entry.binary)) &&
    (older(pin.version, entry.version) ||
      (await markedVersion(host.root, entry.version)))
  ) {
    installed = entry.version;
    binary = entry.binary;
  }
  const service =
    binary === null
      ? null
      : await observeExecutorService({
          home: host.home,
          env: host.env,
          run: host.run,
          binary,
          uid: host.uid,
          probe: host.probe,
        });
  const agents = await observeAgents({
    home: host.home,
    path: host.path,
    platform: host.platform,
    env: host.env,
    run: host.run,
    entry: join(host.bin, "executor"),
  });
  return Object.freeze({
    version: pin.version,
    installed,
    address: executorAddress,
    entry:
      entry.kind === "foreign"
        ? ("conflict" as const)
        : entry.kind === "lazurio" && installed !== null
          ? ("lazurio" as const)
          : ("missing" as const),
    service: serviceWord(service),
    settings: service?.settings ?? "missing",
    answering: service?.answering ?? false,
    linger: service?.linger ?? "unknown",
    agents,
  });
}

const unsupportedStatus = (reason: ExecutorUnsupportedReason) =>
  Object.freeze({
    kind: "executor-status" as const,
    state: "unsupported" as const,
    reason,
  });

/** `status`: the state the row shows; reads only. */
export async function executorStatus(
  host: ExecutorHost,
): Promise<ExecutorStatus> {
  const context = await host.context();
  if (context.kind === "unsupported") return unsupportedStatus(context.reason);
  const facts = await observe(host);
  return Object.freeze({
    kind: "executor-status" as const,
    state: executorState(facts, host.pin ?? executorPin),
    ...facts,
  });
}

/** `setup`: the pinned program and the entry, the service, the agents'
 * entries, in that order, each step only what is missing; older versions go
 * once the service runs the pinned one. Never two at once. */
export async function executorSetup(
  host: ExecutorHost,
  onPhase: (phase: ExecutorPhase) => void = () => undefined,
): Promise<ExecutorStatus> {
  const context = await host.context();
  if (context.kind === "unsupported") {
    host.journal?.({ operation: "setup", outcome: "unsupported" });
    return unsupportedStatus(context.reason);
  }
  const pin = host.pin ?? executorPin;
  let failure: { stage: ExecutorFailureStage; reason: string } | undefined;
  const answer = async () => {
    const status = await executorStatus(host);
    const result =
      failure === undefined || status.state === "unsupported"
        ? status
        : Object.freeze({ ...status, failure: Object.freeze(failure) });
    host.journal?.({
      operation: "setup",
      outcome: result.state,
      ...(failure === undefined
        ? {}
        : { stage: failure.stage, reason: failure.reason }),
    });
    return result;
  };
  try {
    await mkdir(host.root, { recursive: true, mode: 0o700 });
  } catch {
    failure = { stage: "place", reason: "write-failed" };
    return answer();
  }
  let lock: Awaited<ReturnType<typeof acquireFileLock>>;
  try {
    lock = await acquireFileLock(join(host.root, lockName), {
      timeoutMs: host.lockMs ?? lockMs,
    });
  } catch (error) {
    failure = {
      stage: "busy",
      reason:
        error instanceof FileLockError && error.reason === "busy"
          ? "busy"
          : "lock-unavailable",
    };
    return answer();
  }
  try {
    onPhase("install");
    const installed = await installPinnedExecutor({
      root: host.root,
      bin: host.bin,
      home: host.home,
      path: host.path,
      platform: host.platform,
      arch: host.arch,
      run: host.run,
      fetch: host.fetch,
      pin,
    });
    switch (installed.kind) {
      case "unsupported-platform":
        failure = { stage: "preflight", reason: "unsupported-platform" };
        return await answer();
      case "install-failed":
        failure = { stage: installed.stage, reason: installed.reason };
        return await answer();
      // Nothing of another's is touched, and a newer pin is a newer
      // release's to look after.
      case "entry-conflict":
      case "newer-installed":
        return await answer();
    }
    onPhase("service");
    const service = await ensureExecutorService({
      home: host.home,
      env: host.env,
      run: host.run,
      binary: installed.binary,
      uid: host.uid,
      probe: host.probe,
      healthDeadlineMs: host.healthDeadlineMs,
    });
    if (service.kind === "failed")
      failure = {
        stage: "service",
        reason: `${service.step}-${service.reason}`,
      };
    // The agents' entries run the standard entry, which exists now: they
    // work as soon as the service does.
    onPhase("agents");
    const agents = await ensureAgents({
      home: host.home,
      path: host.path,
      platform: host.platform,
      env: host.env,
      run: host.run,
      entry: join(host.bin, "executor"),
    });
    for (const [harness, state] of Object.entries(agents))
      if (failure === undefined && (state === "missing" || state === "unknown"))
        failure = { stage: "agents", reason: `${harness}-${state}` };
    if (service.kind === "running")
      await removeOlderInstallations(host.root, pin).catch(() => undefined);
    return await answer();
  } finally {
    await lock.release();
  }
}
