import { randomBytes } from "node:crypto";
import {
  type ExecutorHost,
  type ExecutorPhase,
  executorSetup,
  executorStatus,
} from "../executor/flow";

// Executor in the Launchpad (decision F44): Settings → Tools → executor over
// the same core as `lazurio executor`. Two routes behind the admission of
// every route:
//
//   POST /api/tools/executor/status  {}     the local status (loopback only)
//   POST /api/tools/executor/setup   {}     starts the one setup, or joins
//                                            the one that runs
//                                    {job}  asks how that one goes
//
// A setup may download about 100 MB and start a service: the route answers
// within a second, `202 {kind: "executor-setting-up", job, phase}` while it
// runs and the status once it ended; the page asks again with the job. It
// runs in this process and a closed page never cancels it.

export const executorRoutePaths = Object.freeze({
  status: "/api/tools/executor/status",
  setup: "/api/tools/executor/setup",
});

export type ExecutorSettingUp = Readonly<{
  kind: "executor-setting-up";
  job: string;
  phase: ExecutorPhase;
}>;

export type ExecutorAnswer = Readonly<{ status: number; body: unknown }>;

type Job = {
  id: string;
  phase: ExecutorPhase;
  done: Promise<ExecutorAnswer>;
  ended: boolean;
};

const failed: ExecutorAnswer = Object.freeze({
  status: 500,
  body: Object.freeze({ error: "operation-failed" }),
});

/** A job handle as the page sends it back. */
export const isExecutorJob = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export function createExecutorRoutes(
  options: Readonly<{
    host: () => ExecutorHost;
    /** How long a setup request waits before it answers 202. */
    answerWithinMs?: number | undefined;
  }>,
) {
  let current: Job | null = null;

  function start(): Job {
    const started: Job = {
      id: randomBytes(16).toString("hex"),
      phase: "install",
      done: Promise.resolve(failed),
      ended: false,
    };
    started.done = executorSetup(options.host(), (phase) => {
      started.phase = phase;
    })
      .then(
        (result): ExecutorAnswer => ({ status: 200, body: result }),
        () => failed,
      )
      .finally(() => {
        started.ended = true;
      });
    return started;
  }

  async function answer(job: Job): Promise<ExecutorAnswer> {
    let late: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      job.done,
      new Promise<null>((resolve) => {
        late = setTimeout(() => resolve(null), options.answerWithinMs ?? 1_000);
      }),
    ]).finally(() => clearTimeout(late));
    if (ended !== null) return ended;
    return {
      status: 202,
      body: {
        kind: "executor-setting-up",
        job: job.id,
        phase: job.phase,
      } satisfies ExecutorSettingUp,
    };
  }

  return Object.freeze({
    handles(path: string): boolean {
      return (Object.values(executorRoutePaths) as string[]).includes(path);
    },
    /** `job` only with a setup: the handle a 202 answered. */
    async handle(path: string, job?: string): Promise<ExecutorAnswer> {
      if (path === executorRoutePaths.status) {
        try {
          return { status: 200, body: await executorStatus(options.host()) };
        } catch {
          return failed;
        }
      }
      if (job !== undefined) {
        // Only the setup this Launchpad runs or ran last; any other handle is
        // unknown and the page starts again.
        if (current === null || current.id !== job)
          return {
            status: 404,
            body: { kind: "blocked", reason: "job-unknown", tool: "executor" },
          };
        return answer(current);
      }
      // A new setup, or the one that runs: never two at once.
      if (current === null || current.ended) current = start();
      return answer(current);
    },
    /** The setup that runs or ran last, for tests. */
    async settled(): Promise<void> {
      await current?.done;
    },
  });
}
