import type { ProcessRunner } from "../update/self-check";
import {
  detectServiceControl,
  userUnitDirectory,
} from "../update/service-control";
import { compareVersions } from "../update/version";
import type { ExecutorStatus } from "./flow";

// Who moves Executor on, and when (decision F44, addendum of 2026-10-11,
// #298). `lazurio install` and `lazurio update` only read its state and
// report it: a Platform install must not wait minutes for a tool's download,
// and a Machines apply gives its install step a bounded time. The Launchpad
// of the same base sets it up in the background after it starts
// (`setUpAtStart`, `createExecutorRoutes().atStart`). Both follow the rule
// of the entry units (F29): a supervised base, for the hosted operator.

type ScopeInput = Readonly<{
  base: string;
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
  run?: ProcessRunner | undefined;
  /** Whether this process is the declared operator of a Machine handover;
   * asked only for a supervised base. */
  hosted: () => Promise<boolean>;
}>;

/** Where Lazurio looks after Executor for this base, the F29 rule of the
 * entry units: `unsupervised` unless this base's Launchpad unit is there
 * (Linux, a user manager), then `hosted` for the hosted operator and
 * `not-hosted` otherwise. The one rule of install, update and the
 * Launchpad's start. */
export async function executorScope(
  input: ScopeInput,
): Promise<"unsupervised" | "not-hosted" | "hosted"> {
  if (input.platform !== "linux" || userUnitDirectory(input.env) === undefined)
    return "unsupervised";
  if ((await detectServiceControl(input)) === null) return "unsupervised";
  return (await input.hosted().catch(() => false)) ? "hosted" : "not-hosted";
}

/** What `lazurio install` or `lazurio update` reports of Executor on a
 * supervised Remote Environment: the state it read, never a setup. Never a
 * reason for either to fail: the product is installed and switched whatever
 * is read here, and `next` says what happens next. */
export type ExecutorReport =
  /** Installed, running, agents connected. */
  | Readonly<{ state: "running" }>
  /** Not the declared operator of a Machine handover: nothing is read. */
  | Readonly<{ state: "skipped-not-hosted" }>
  | Readonly<{
      state:
        | "not-installed"
        | "outdated"
        | "conflict"
        | "not-running"
        | "incomplete"
        | "unsupported"
        /** The state could not be read. */
        | "failed";
      /** `unsupported` only: why Lazurio does not set it up here. */
      reason?: string;
      next: string;
    }>;

const launchpadNext =
  "Executor is not ready yet. The Launchpad sets it up in the background after it starts, and Settings → Tools → executor shows how it goes; without a running Launchpad, lazurio executor setup does the same. Agents work without its direct Integrations meanwhile.";
const conflictNext =
  "Executor is not set up: ~/.local/bin/executor or an MCP server named executor is not Lazurio's and is left as it is. lazurio executor status names it; remove it and run lazurio executor setup.";
const notHereNext =
  "Lazurio does not set Executor up here; lazurio executor status says why.";
const unreadNext =
  "Executor's state could not be read; lazurio executor status says what is there.";

const newer = (version: string, than: string) => {
  try {
    return compareVersions(version, than) > 0;
  } catch {
    return false;
  }
};

/** Whether the Launchpad's start sets Executor up: where Lazurio's setup
 * moves it on (`not-installed`, `outdated`, `not-running`, `incomplete`).
 * Not when it runs, conflicts (never touched), is not Lazurio's to set up
 * here, or when the wrapper of a newer pin is there (a newer release's to
 * look after). */
export function setUpAtStart(status: ExecutorStatus): boolean {
  switch (status.state) {
    case "unsupported":
    case "running":
    case "conflict":
      return false;
    case "not-installed":
    case "outdated":
    case "not-running":
    case "incomplete":
      return (
        status.installed === null || !newer(status.installed, status.version)
      );
  }
}

/** The report of a state read: `next` promises the Launchpad's setup only
 * where its start does it (`setUpAtStart`). */
export function reportOf(status: ExecutorStatus): ExecutorReport {
  if (status.state === "running") return Object.freeze({ state: "running" });
  return Object.freeze({
    state: status.state,
    ...(status.state === "unsupported" ? { reason: status.reason } : {}),
    next: setUpAtStart(status)
      ? launchpadNext
      : status.state === "conflict"
        ? conflictNext
        : notHereNext,
  });
}

export const executorReportFailed: ExecutorReport = Object.freeze({
  state: "failed",
  next: unreadNext,
});

/** `lazurio install` and `lazurio update` on a supervised base of the hosted
 * operator: Executor's state (`status`, read only: no download, npm, change
 * of its service or agent's entry). An installation without its Launchpad
 * unit is left alone and the result has no `executor` (undefined here); a
 * workstation's supervised base is `skipped-not-hosted`. */
export async function reportExecutor(
  input: ScopeInput & Readonly<{ status: () => Promise<ExecutorStatus> }>,
): Promise<ExecutorReport | undefined> {
  const scope = await executorScope(input);
  if (scope === "unsupervised") return undefined;
  if (scope === "not-hosted")
    return Object.freeze({ state: "skipped-not-hosted" });
  try {
    return reportOf(await input.status());
  } catch {
    return executorReportFailed;
  }
}

/** The finding in words, only when something needs a person. */
export const executorFinding = (value: ExecutorReport | undefined): string[] =>
  value === undefined ||
  value.state === "running" ||
  value.state === "skipped-not-hosted"
    ? []
    : [value.next];
