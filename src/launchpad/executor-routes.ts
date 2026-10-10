import { randomBytes } from "node:crypto";
import { setUpAtStart } from "../executor/converge";
import {
  type ExecutorHost,
  type ExecutorJournalEntry,
  type ExecutorPhase,
  executorSetup,
  executorStatus,
} from "../executor/flow";

// Executor in the Launchpad (decision F44): Settings → Tools → executor over
// the same core as `lazurio executor`. Two routes behind the admission of
// every route:
//
//   POST /api/tools/executor/status  {}     the local status (loopback only),
//                                            or the setup that runs
//   POST /api/tools/executor/setup   {}     starts the one setup, or joins
//                                            the one that runs
//                                    {job}  asks how that one goes
//
// A setup may download about 100 MB and start a service: the route answers
// within a second, `202 {kind: "executor-setting-up", job, phase}` while it
// runs and the status once it ended; the page asks again with the job. It
// runs in this process and a closed page never cancels it. The Launchpad's
// start runs the same one where Lazurio's setup moves Executor on (`atStart`,
// addendum of 2026-10-11), so the status answers a running setup with its
// job too: the row follows it whoever started it. A closing Launchpad starts
// none: the one place a setup is created asks `closing` last.

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

const closingAnswer: ExecutorAnswer = Object.freeze({
  status: 503,
  body: Object.freeze({
    kind: "blocked",
    reason: "closing",
    tool: "executor",
  }),
});

/** A job handle as the page sends it back. */
export const isExecutorJob = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

const settingUp = (job: Job): ExecutorAnswer => ({
  status: 202,
  body: {
    kind: "executor-setting-up",
    job: job.id,
    phase: job.phase,
  } satisfies ExecutorSettingUp,
});

export function createExecutorRoutes(
  options: Readonly<{
    host: () => ExecutorHost;
    /** How long a setup request waits before it answers 202. */
    answerWithinMs?: number | undefined;
    /** Whether the Launchpad is closing: then no setup starts. */
    closing?: (() => boolean) | undefined;
  }>,
) {
  let current: Job | null = null;

  /** The one setup, or none while the Launchpad closes: asked here, after
   * whatever its caller waited for. The start's journals `trigger:
   * "start"`. */
  function start(trigger?: ExecutorJournalEntry["trigger"]): Job | null {
    if (options.closing?.() === true) return null;
    const host = options.host();
    const journal = host.journal;
    const started: Job = {
      id: randomBytes(16).toString("hex"),
      phase: "install",
      done: Promise.resolve(failed),
      ended: false,
    };
    started.done = executorSetup(
      trigger === undefined || journal === undefined
        ? host
        : { ...host, journal: (entry) => journal({ ...entry, trigger }) },
      (phase) => {
        started.phase = phase;
      },
    )
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
    return ended ?? settingUp(job);
  }

  return Object.freeze({
    handles(path: string): boolean {
      return (Object.values(executorRoutePaths) as string[]).includes(path);
    },
    /** `job` only with a setup: the handle a 202 answered. */
    async handle(path: string, job?: string): Promise<ExecutorAnswer> {
      if (path === executorRoutePaths.status) {
        // A setup that runs is the state the row shows, whoever started it.
        if (current !== null && !current.ended) return settingUp(current);
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
      if (current === null || current.ended) {
        const started = start();
        if (started === null) return closingAnswer;
        current = started;
      }
      return answer(current);
    },
    /** After the Launchpad's start (decision F44, addendum of 2026-10-11):
     * the state is read once and, where Lazurio's setup moves Executor on
     * (`setUpAtStart`), the one setup starts as Install starts it. Never
     * beside a running one, never once the Launchpad closes (`start` asks
     * after the read) and never again: a setup that stops leaves the row's
     * action. Whether one started; it runs on in the background. */
    async atStart(): Promise<boolean> {
      if (current !== null && !current.ended) return false;
      if (!setUpAtStart(await executorStatus(options.host()))) return false;
      // Install may have started one while the state was read.
      if (current !== null && !current.ended) return false;
      const started = start("start");
      if (started === null) return false;
      current = started;
      return true;
    },
    /** The setup that runs or ran last, for tests. */
    async settled(): Promise<void> {
      await current?.done;
    },
  });
}
