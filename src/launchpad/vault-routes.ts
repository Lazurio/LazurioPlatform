import { randomBytes } from "node:crypto";
import {
  type VaultHost,
  type VaultPhase,
  vaultConnect,
  vaultDisconnect,
  vaultRefresh,
  vaultStatus,
} from "../vault/flow";

// The Environment vault in the Launchpad (decision F43): Settings → Tools →
// bitwarden over the same core as `lazurio vault`. Four routes behind the
// admission of every route:
//
//   POST /api/tools/bitwarden/status      {}  the local status (no network)
//   POST /api/tools/bitwarden/refresh     {}  a sync, then the status
//   POST /api/tools/bitwarden/connect     {}  starts the one connect, or
//                                              joins the one that runs
//                                         {job}  asks how that one goes
//   POST /api/tools/bitwarden/disconnect  {}  signs the account out here
//
// A connect installs, creates the account and signs it in, which may take a
// minute: the route answers within a second, `202 {kind: "vault-connecting",
// job, phase}` while it runs and the status once it ended; the page asks
// again with the job. It runs in this process and a closed dialog never
// cancels it.

export const vaultRoutePaths = Object.freeze({
  status: "/api/tools/bitwarden/status",
  refresh: "/api/tools/bitwarden/refresh",
  connect: "/api/tools/bitwarden/connect",
  disconnect: "/api/tools/bitwarden/disconnect",
});

export type VaultConnecting = Readonly<{
  kind: "vault-connecting";
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

/** A job handle as the page sends it back. */
export const isVaultJob = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value);

export function createVaultRoutes(
  options: Readonly<{
    host: () => VaultHost;
    /** How long a connect request waits before it answers 202. */
    answerWithinMs?: number | undefined;
  }>,
) {
  // The connect that runs or ran last; only its handle asks about it, and a
  // request without one starts the next when none runs.
  let current: Job | null = null;

  function start(): Job {
    const started: Job = {
      id: randomBytes(16).toString("hex"),
      phase: "install",
      done: Promise.resolve(failed),
      ended: false,
    };
    started.done = vaultConnect(options.host(), (phase) => {
      started.phase = phase;
    })
      .then(
        (result): VaultAnswer => ({ status: 200, body: result }),
        () => failed,
      )
      .finally(() => {
        started.ended = true;
      });
    return started;
  }

  const read = async (operation: () => Promise<unknown>) => {
    try {
      return { status: 200, body: await operation() };
    } catch {
      return failed;
    }
  };

  async function answer(current: Job): Promise<VaultAnswer> {
    let late: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      current.done,
      new Promise<null>((resolve) => {
        late = setTimeout(() => resolve(null), options.answerWithinMs ?? 1_000);
      }),
    ]).finally(() => clearTimeout(late));
    if (ended !== null) return ended;
    return {
      status: 202,
      body: {
        kind: "vault-connecting",
        job: current.id,
        phase: current.phase,
      } satisfies VaultConnecting,
    };
  }

  return Object.freeze({
    handles(path: string): boolean {
      return (Object.values(vaultRoutePaths) as string[]).includes(path);
    },
    /** `job` only with a connect: the handle a 202 answered. */
    async handle(path: string, job?: string): Promise<VaultAnswer> {
      if (path === vaultRoutePaths.status)
        return read(() => vaultStatus(options.host()));
      if (path === vaultRoutePaths.refresh)
        return read(() => vaultRefresh(options.host()));
      if (path === vaultRoutePaths.disconnect) {
        if (current !== null && !current.ended)
          return {
            status: 409,
            body: { kind: "blocked", reason: "busy", tool: "bitwarden" },
          };
        return read(() => vaultDisconnect(options.host()));
      }
      if (job !== undefined) {
        // Asking about a connect: only the one this Launchpad runs or ran
        // last; any other handle is unknown and the page starts again.
        if (current === null || current.id !== job)
          return {
            status: 404,
            body: { kind: "blocked", reason: "job-unknown", tool: "bitwarden" },
          };
        return answer(current);
      }
      // A new connect, or the one that runs: never two at once.
      if (current === null || current.ended) current = start();
      return answer(current);
    },
    /** The connect that runs or ran last, for tests. */
    async settled(): Promise<void> {
      await current?.done;
    },
  });
}
