import type { AgentRegistration } from "../executor/agents";
import type {
  ExecutorFailureStage,
  ExecutorPhase,
  ExecutorService,
  ExecutorStatus,
  ExecutorUnsupportedReason,
} from "../executor/flow";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

// Executor's row on the tools screen (decision F44): pure, so it is testable
// without a DOM. The server's answers are accepted only in their exact form;
// everything returned is text for `textContent`, never markup. The row says
// the state in plain words and offers one next step; versions, the address,
// the service and the agents are in Details. There is no way into
// Executor's console from here: its page shows the access token, and people
// never need it.

type Copy = Readonly<Record<MessageKey, string>>;

const states = [
  "unsupported",
  "not-installed",
  "outdated",
  "conflict",
  "not-running",
  "incomplete",
  "running",
] as const;
const unsupportedReasons: readonly ExecutorUnsupportedReason[] = [
  "workstation",
  "handover-unreadable",
  "not-operator",
];
const services: readonly ExecutorService[] = [
  "running",
  "stopped",
  "failed",
  "missing",
  "other",
  "unknown",
];
const registrations: readonly AgentRegistration[] = [
  "registered",
  "disabled",
  "missing",
  "conflict",
  "absent",
  "unknown",
];
const stages: readonly ExecutorFailureStage[] = [
  "preflight",
  "download",
  "integrity",
  "npm",
  "verify",
  "place",
  "service",
  "agents",
  "busy",
];
const phases: readonly ExecutorPhase[] = ["install", "service", "agents"];

const version = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/.test(value);
const code = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value);
const oneOf =
  <T>(list: readonly T[]) =>
  (value: unknown): value is T =>
    list.includes(value as T);

/** A status answer of the server, only in its exact form. */
export function parseExecutorStatus(input: unknown): ExecutorStatus | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.kind !== "executor-status" || !oneOf(states)(value.state))
    return null;
  if (value.state === "unsupported")
    return oneOf(unsupportedReasons)(value.reason)
      ? { kind: "executor-status", state: "unsupported", reason: value.reason }
      : null;
  const agents = value.agents as Record<string, unknown> | null | undefined;
  const failure = value.failure as Record<string, unknown> | null | undefined;
  if (
    !version(value.version) ||
    !(value.installed === null || version(value.installed)) ||
    value.address !== "127.0.0.1:4789" ||
    !oneOf(["lazurio", "missing", "conflict"] as const)(value.entry) ||
    !oneOf(services)(value.service) ||
    !oneOf(["current", "missing", "different"] as const)(value.settings) ||
    typeof value.answering !== "boolean" ||
    !oneOf(["yes", "no", "unknown"] as const)(value.linger) ||
    !agents ||
    typeof agents !== "object" ||
    !oneOf(registrations)(agents.codex) ||
    !oneOf(registrations)(agents.claude) ||
    (failure !== undefined &&
      (!failure ||
        typeof failure !== "object" ||
        !oneOf(stages)(failure.stage) ||
        !code(failure.reason)))
  )
    return null;
  return {
    kind: "executor-status",
    state: value.state,
    version: value.version,
    installed: value.installed,
    address: value.address,
    entry: value.entry,
    service: value.service,
    settings: value.settings,
    answering: value.answering,
    linger: value.linger,
    agents: { codex: agents.codex, claude: agents.claude },
    ...(failure === undefined
      ? {}
      : {
          failure: {
            stage: failure.stage as ExecutorFailureStage,
            reason: failure.reason as string,
          },
        }),
  };
}

/** A running setup: `202 {kind: "executor-setting-up", job, phase}`. */
export function parseExecutorSettingUp(
  input: unknown,
): Readonly<{ job: string; phase: ExecutorPhase }> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  return value.kind === "executor-setting-up" &&
    typeof value.job === "string" &&
    /^[0-9a-f]{32}$/.test(value.job) &&
    oneOf(phases)(value.phase)
    ? { job: value.job, phase: value.phase }
    : null;
}

export type ExecutorRowLine = Readonly<{
  text: string;
  /** The colour of the line: `signed-in` (success), `signed-out`
   * (warning), `unknown` (quiet). */
  state: "signed-in" | "signed-out" | "unknown";
}>;

/** The state under the row's name: the running setup's step while it runs,
 * otherwise the state the server read last. */
export function executorRowLine(
  status: ExecutorStatus | null,
  running: ExecutorPhase | null,
  copy: Copy,
): ExecutorRowLine {
  if (running !== null)
    return {
      text: {
        install: copy.executorPhaseInstall,
        service: copy.executorPhaseService,
        agents: copy.executorPhaseAgents,
      }[running],
      state: "unknown",
    };
  if (status === null)
    return { text: copy.executorRowChecking, state: "unknown" };
  switch (status.state) {
    case "unsupported":
      return {
        text:
          status.reason === "workstation"
            ? copy.executorRowSecondWave
            : copy.executorRowUnavailable,
        state: "unknown",
      };
    case "running":
      return { text: copy.executorRowRunning, state: "signed-in" };
    case "not-installed":
      return { text: copy.executorRowNotInstalled, state: "signed-out" };
    case "outdated":
      return { text: copy.executorRowOutdated, state: "signed-out" };
    case "not-running":
      return { text: copy.executorRowNotRunning, state: "signed-out" };
    case "incomplete":
      return { text: copy.executorRowIncomplete, state: "signed-out" };
    case "conflict":
      return { text: copy.executorRowConflict, state: "signed-out" };
  }
}

export type ExecutorAction = Readonly<{
  /** `setup`: Lazurio's own setup; `agent`: the prepared prompt for an
   * agent who resolves a conflict with the Operator. */
  kind: "setup" | "agent";
  label: string;
}>;

/** The row's one next step in each state; none while it runs or when there
 * is nothing to do. */
export function executorAction(
  status: ExecutorStatus | null,
  copy: Copy,
): ExecutorAction | null {
  if (status === null) return null;
  switch (status.state) {
    case "unsupported":
    case "running":
      return null;
    case "not-installed":
      return { kind: "setup", label: copy.executorActionInstall };
    case "outdated":
      return { kind: "setup", label: copy.executorActionUpdate };
    case "not-running":
    case "incomplete":
      return { kind: "setup", label: copy.executorActionRepair };
    case "conflict":
      return { kind: "agent", label: copy.executorActionResolve };
  }
}

export type ExecutorFact = Readonly<{ label: string; value: string }>;

/** What Details says: the version, the address, the service, the agents and,
 * after a setup that stopped, where. */
export function executorFacts(
  status: ExecutorStatus | null,
  copy: Copy,
): readonly ExecutorFact[] {
  if (status === null || status.state === "unsupported") return [];
  const serviceWord: Readonly<Record<ExecutorService, string>> = {
    running: copy.executorServiceRunning,
    stopped: copy.executorServiceStopped,
    failed: copy.executorServiceFailed,
    missing: copy.executorServiceMissing,
    other: copy.executorServiceOther,
    unknown: copy.executorServiceUnknown,
  };
  const agentWord: Readonly<Record<AgentRegistration, string>> = {
    registered: copy.executorAgentConnected,
    disabled: copy.executorAgentDisabled,
    missing: copy.executorAgentMissing,
    conflict: copy.executorAgentConflict,
    absent: copy.executorAgentAbsent,
    unknown: copy.executorAgentUnknown,
  };
  const facts: ExecutorFact[] = [
    {
      label: copy.executorDetailVersion,
      value:
        status.installed === null
          ? fill(copy.executorVersionPinned, { version: status.version })
          : status.installed === status.version
            ? status.installed
            : fill(copy.executorVersionOther, {
                installed: status.installed,
                version: status.version,
              }),
    },
    {
      label: copy.executorDetailAddress,
      value: fill(copy.executorAddressLocal, { address: status.address }),
    },
    { label: copy.executorDetailService, value: serviceWord[status.service] },
    {
      label: copy.executorDetailAgents,
      value: `Codex: ${agentWord[status.agents.codex]} · Claude Code: ${agentWord[status.agents.claude]}`,
    },
  ];
  if (status.failure !== undefined)
    facts.push({
      label: copy.toolsWhatHappened,
      value: fill(copy.executorFailed, {
        stage: status.failure.stage,
        reason: status.failure.reason,
      }),
    });
  return facts;
}

/** How soon a running setup is asked again. */
export const executorPollMs = 1_000;
