import { randomBytes } from "node:crypto";
import type { ContentHost } from "./host";
import {
  type InstallRequest,
  planContentInstall,
  runContentInstall,
} from "./install";
import { tryContentLock } from "./lock";
import type {
  ContentFailure,
  ContentFailureCause,
  ContentItemRef,
  ContentRefusal,
  ContentStep,
} from "./model";

// The Launchpad's content jobs: `POST /api/content/install` starts one,
// `GET /api/content/jobs/<id>` reads it. One job at a time per Folder: a job
// of this Launchpad is answered by its id, and any other holder of the
// Folder's content lock (a `lazurio organization install` in a terminal)
// refuses a start the same way, without an id. Jobs live in this process's
// memory only; the last few stay readable after they end.

export type ContentJob = Readonly<{
  id: string;
  state: "running" | "succeeded" | "failed";
  /** The latest state of each step, in the order the steps began. */
  steps: readonly ContentStep[];
  failure?: ContentFailure;
  /** The items GitHub's rate limit stopped (`InstallResult.waiting`), with
   * the limit `rate_limit` names at the end of the run (#1223). */
  waiting?: Readonly<{
    items: readonly ContentItemRef[];
    cause: ContentFailureCause;
  }>;
}>;

export type JobStart =
  | Readonly<{ kind: "started"; job: string }>
  | Readonly<{ kind: "busy"; job?: string }>
  | Readonly<{ kind: "not-allowed"; reason: ContentRefusal }>;

const kept = 16;

const stepKey = (item: ContentItemRef, key: string) =>
  `${item.kind === "organization" ? `organization:${item.login.toLowerCase()}` : "personalspace"}:${key}`;

/** The end of a run as a job keeps it: the stop to show, and the items
 * GitHub's rate limit stopped. The cause itself was set by the failing
 * operation (`observeLimit`); this only adds the limit `rate_limit` names
 * now (which GitHub does not count) to that cause, asked only when a stop
 * carries it. */
export async function withLimitDetails(
  result: Readonly<{
    failure?: ContentFailure | undefined;
    waiting?: readonly ContentItemRef[] | undefined;
  }>,
  host: ContentHost,
): Promise<
  Readonly<{ failure?: ContentFailure; waiting?: ContentJob["waiting"] }>
> {
  const { failure, waiting } = result;
  if (waiting === undefined || waiting.length === 0)
    return failure === undefined ? {} : { failure };
  const limit = await host.github.rateLimit?.().catch(() => undefined);
  const cause: ContentFailureCause = Object.freeze({
    kind: "github-rate-limit" as const,
    ...(limit?.kind === undefined ? {} : { limit: limit.kind }),
    ...(limit?.reset === undefined ? {} : { reset: limit.reset }),
  });
  return {
    ...(failure === undefined
      ? {}
      : {
          failure:
            failure.cause === undefined
              ? failure
              : Object.freeze({ ...failure, cause }),
        }),
    waiting: Object.freeze({ items: waiting, cause }),
  };
}

export function createContentJobs(
  input: Readonly<{ folder: string; host: () => ContentHost }>,
) {
  const jobs = new Map<
    string,
    {
      id: string;
      state: ContentJob["state"];
      steps: Map<string, ContentStep>;
      failure?: ContentFailure;
      waiting?: ContentJob["waiting"];
    }
  >();
  // Set synchronously before the first await of a start, so two requests
  // arriving together never both begin.
  let reserved = false;
  let running: { id: string; done: Promise<void> } | null = null;

  const snapshot = (job: NonNullable<ReturnType<typeof jobs.get>>) =>
    Object.freeze({
      id: job.id,
      state: job.state,
      steps: Object.freeze([...job.steps.values()]),
      ...(job.failure === undefined ? {} : { failure: job.failure }),
      ...(job.waiting === undefined ? {} : { waiting: job.waiting }),
    });

  return Object.freeze({
    async start(request: InstallRequest): Promise<JobStart> {
      if (running !== null) return { kind: "busy", job: running.id };
      if (reserved) return { kind: "busy" };
      reserved = true;
      try {
        const host = input.host();
        const plan = await planContentInstall(input.folder, request, host);
        if (plan.kind === "not-allowed") return plan;
        const lock = await tryContentLock(host.lockDirectory, input.folder);
        if (lock === null) return { kind: "busy" };
        const id = randomBytes(16).toString("hex");
        const job: NonNullable<ReturnType<typeof jobs.get>> = {
          id,
          state: "running",
          steps: new Map(),
        };
        jobs.set(id, job);
        while (jobs.size > kept) {
          const oldest = [...jobs.keys()].find((key) => key !== id);
          if (oldest === undefined) break;
          jobs.delete(oldest);
        }
        const done = runContentInstall(
          input.folder,
          plan,
          (step) => job.steps.set(stepKey(step.item, step.key), step),
          host,
        )
          .then(async (result) => ({
            state: result.state,
            ...(await withLimitDetails(result, host)),
          }))
          .then(
            (
              result,
            ): {
              state: ContentJob["state"];
              failure?: ContentFailure;
              waiting?: ContentJob["waiting"];
            } => result,
            () => ({
              state: "failed" as const,
              failure: Object.freeze({
                item: plan.items[0] ?? { kind: "personalspace" as const },
                key: "check" as const,
                code: "operation-failed",
                detail: "unexpected failure",
              }),
            }),
          )
          .then(async (end) => {
            // The lock is free before the job reads as ended, so a client
            // that starts the next job on seeing the end is not refused.
            await lock.release().catch(() => undefined);
            running = null;
            if (end.failure !== undefined) job.failure = end.failure;
            if ("waiting" in end && end.waiting !== undefined)
              job.waiting = end.waiting;
            job.state = end.state;
          });
        running = { id, done };
        return { kind: "started", job: id };
      } finally {
        reserved = false;
      }
    },
    get(id: string): ContentJob | undefined {
      const job = jobs.get(id);
      return job === undefined ? undefined : snapshot(job);
    },
    /** The newest job of this Launchpad (running or ended), or undefined:
     * what the page shows again after a reload. */
    latest(): ContentJob | undefined {
      const newest = [...jobs.values()].at(-1);
      return newest === undefined ? undefined : snapshot(newest);
    },
    /** Resolves when no job runs (for shutdown and tests). */
    async settled(): Promise<void> {
      while (running !== null) await running.done;
    },
  });
}
