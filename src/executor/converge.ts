import type { ProcessRunner } from "../update/self-check";
import {
  detectServiceControl,
  userUnitDirectory,
} from "../update/service-control";
import type { ExecutorStatus } from "./flow";

/** What `lazurio install` or `lazurio update` did with Executor on a
 * supervised Remote Environment (decision F44, as F29 converges the entry
 * units). Never a reason for either to fail: the product is installed and
 * switched whatever happens here, and `next` says what a person or an agent
 * does. */
export type ExecutorConvergence =
  /** Installed, running, agents connected. */
  | Readonly<{ state: "running" }>
  /** Not the declared operator of a Machine handover: nothing ran. */
  | Readonly<{ state: "skipped-not-hosted" }>
  | Readonly<{
      state:
        | "not-installed"
        | "outdated"
        | "conflict"
        | "not-running"
        | "incomplete"
        | "unsupported"
        | "failed";
      stage?: string;
      reason?: string;
      next: string;
    }>;

const repairNext =
  "Executor is not fully set up in this Environment; agents work without its direct Integrations meanwhile. Run lazurio executor setup (Settings → Tools → executor offers the same), then lazurio executor status says what remains.";
const conflictNext =
  "Executor is not set up: ~/.local/bin/executor or an MCP server named executor is not Lazurio's and is left as it is. lazurio executor status names it; remove it and run lazurio executor setup.";

export function convergenceOf(status: ExecutorStatus): ExecutorConvergence {
  if (status.state === "running") return Object.freeze({ state: "running" });
  if (status.state === "unsupported")
    return Object.freeze({
      state: "unsupported",
      reason: status.reason,
      next: repairNext,
    });
  return Object.freeze({
    state: status.state,
    ...(status.failure === undefined
      ? {}
      : { stage: status.failure.stage, reason: status.failure.reason }),
    next: status.state === "conflict" ? conflictNext : repairNext,
  });
}

export const executorConvergenceFailed: ExecutorConvergence = Object.freeze({
  state: "failed",
  next: repairNext,
});

/** Whenever `lazurio install` or `lazurio update` finds this base supervised
 * (its Launchpad unit is this base's) and the process is the hosted
 * operator, Executor is set up (`setup`); an installation without its
 * Launchpad unit is left alone and the result has no `executor` (undefined
 * here), a workstation's supervised base is `skipped-not-hosted`. `hosted`
 * is asked only for a supervised base, as for the entry units. */
export async function convergeExecutor(
  input: Readonly<{
    base: string;
    platform: string;
    env: Readonly<Record<string, string | undefined>>;
    run?: ProcessRunner | undefined;
    hosted: () => Promise<boolean>;
    setup: () => Promise<ExecutorStatus>;
  }>,
): Promise<ExecutorConvergence | undefined> {
  if (input.platform !== "linux" || userUnitDirectory(input.env) === undefined)
    return undefined;
  const service = await detectServiceControl(input);
  if (service === null) return undefined;
  if (!(await input.hosted().catch(() => false)))
    return Object.freeze({ state: "skipped-not-hosted" });
  try {
    return convergenceOf(await input.setup());
  } catch {
    return executorConvergenceFailed;
  }
}

/** The finding in words, only when something needs a person. */
export const executorFinding = (
  value: ExecutorConvergence | undefined,
): string[] =>
  value === undefined ||
  value.state === "running" ||
  value.state === "skipped-not-hosted"
    ? []
    : [value.next];
