import { randomBytes } from "node:crypto";
import {
  setUpAtStart,
  type VaultHost,
  type VaultJournalEntry,
  type VaultPhase,
  vaultRefresh,
  vaultSetup,
  vaultStatus,
} from "../vault/flow";

// The Environment's own vault in the Launchpad (decisions F43, F52): Settings
// → Tools → bitwarden over the same core as `lazurio vault`. Three routes
// behind the admission of every route:
//
//   POST /api/tools/bitwarden/status   {}     the local status (no network),
//                                             or the setup that runs
//   POST /api/tools/bitwarden/refresh  {}     a sync, then the status, or the
//                                             setup that runs
//   POST /api/tools/bitwarden/setup    {}     starts the one setup, or joins
//                                             the one that runs
//                                      {job}  asks how that one goes
//
// A setup installs bw, registers the account, creates the vault and signs it
// in, which may take a minute: the route answers within a second,
// `202 {kind: "vault-setting-up", job, phase}` while it runs and the status
// once it ended; the page asks again with the job. It runs in this process
// and a closed page never cancels it. The Launchpad's start runs the same one
// where the vault needs it (`atStart`, the pattern of Executor's, decision
// F44's addendum of 2026-10-11), so status and refresh answer a running setup
// with its job too: the row follows it whoever started it. A closing
// Launchpad starts none.

export const vaultRoutePaths = Object.freeze({
  status: "/api/tools/bitwarden/status",
  refresh: "/api/tools/bitwarden/refresh",
  setup: "/api/tools/bitwarden/setup",
});

export type VaultSettingUp = Readonly<{
  kind: "vault-setting-up";
  job: string;
  phase: VaultPhase;
}>;

export type VaultAnswer = Readonly<{ status: number; body: unknown }>;

type Job = {
  id: string;
  phase: VaultPhase;
  done: Promise<VaultAnswer>;
  ended: boolean;
};

const failed: VaultAnswer = Object.freeze({
  status: 500,
  body: Object.freeze({ error: "operation-failed" }),
});

const closingAnswer: VaultAnswer = Object.freeze({
  status: 503,
  body: Object.freeze({
    kind: "blocked",
    reason: "closing",
    tool: "bitwarden",
  }),
});

/** A job handle as the page sends it back. */
export const isVaultJob = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

const settingUp = (job: Job): VaultAnswer => ({
  status: 202,
  body: {
    kind: "vault-setting-up",
    job: job.id,
    phase: job.phase,
  } satisfies VaultSettingUp,
});

export function createVaultRoutes(
  options: Readonly<{
    host: () => VaultHost;
    /** How long a setup request waits before it answers 202. */
    answerWithinMs?: number | undefined;
    /** Whether the Launchpad is closing: then no setup starts. */
    closing?: (() => boolean) | undefined;
  }>,
) {
  let current: Job | null = null;

  /** The one setup, or none while the Launchpad closes: asked here, after
   * whatever its caller waited for. The start's journals
   * `trigger: "start"`. */
  function start(trigger?: VaultJournalEntry["trigger"]): Job | null {
    if (options.closing?.() === true) return null;
    const host = options.host();
    const journal = host.journal;
    const started: Job = {
      id: randomBytes(16).toString("hex"),
      phase: "install",
      done: Promise.resolve(failed),
      ended: false,
    };
    started.done = vaultSetup(
      trigger === undefined || journal === undefined
        ? host
        : { ...host, journal: (entry) => journal({ ...entry, trigger }) },
      (phase) => {
        started.phase = phase;
      },
    )
      .then(
        (result): VaultAnswer => ({ status: 200, body: result }),
        () => failed,
      )
      .finally(() => {
        started.ended = true;
      });
    return started;
  }

  async function answer(job: Job): Promise<VaultAnswer> {
    let late: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      job.done,
      new Promise<null>((resolve) => {
        late = setTimeout(() => resolve(null), options.answerWithinMs ?? 1_000);
      }),
    ]).finally(() => clearTimeout(late));
    return ended ?? settingUp(job);
  }

  const read = async (operation: () => Promise<unknown>) => {
    try {
      return { status: 200, body: await operation() };
    } catch {
      return failed;
    }
  };

  return Object.freeze({
    handles(path: string): boolean {
      return (Object.values(vaultRoutePaths) as string[]).includes(path);
    },
    /** `job` only with a setup: the handle a 202 answered. */
    async handle(path: string, job?: string): Promise<VaultAnswer> {
      if (path === vaultRoutePaths.status || path === vaultRoutePaths.refresh) {
        // A setup that runs is the state the row shows, whoever started it.
        if (current !== null && !current.ended) return settingUp(current);
        return read(() =>
          path === vaultRoutePaths.status
            ? vaultStatus(options.host())
            : vaultRefresh(options.host()),
        );
      }
      if (job !== undefined) {
        // Only the setup this Launchpad runs or ran last; any other handle is
        // unknown and the page starts again.
        if (current === null || current.id !== job)
          return {
            status: 404,
            body: { kind: "blocked", reason: "job-unknown", tool: "bitwarden" },
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
    /** After the Launchpad's start: the state is read once and, where the
     * vault needs it (`setUpAtStart`), the one setup starts. Never beside a
     * running one, never once the Launchpad closes and never again: a setup
     * that stops leaves the row's action. Whether one started; it runs on
     * in the background. */
    async atStart(): Promise<boolean> {
      if (current !== null && !current.ended) return false;
      if (!setUpAtStart(await vaultStatus(options.host()))) return false;
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
