import { serveHealthSocket } from "./health-socket";
import { createHostedTrust } from "./hosted-trust";
import type { HostedOptions } from "./server";
import { LaunchpadStartRefused, type StartRefusal } from "./start-check";

/** Recovery mode, minimal (docs/update.md "Recovery mode"): when the Launchpad
 * cannot start normally for a reason it can name, it does not exit. It keeps
 * the port it would have served on and answers every request with that reason:
 * the page as plain text, every API route as a typed refusal, the health
 * socket with 503. The page with the repair action is a later slice; nothing
 * here reads the Folder, starts an application or changes anything.
 */
export const recoveryCheck = "start-refused";

export type RecoveryAnswer = Readonly<{
  error: "recovery-mode";
  check: typeof recoveryCheck;
  reason: StartRefusal;
}>;

export async function startRecoveryMode(
  input: Readonly<{
    refusal: LaunchpadStartRefused;
    /** The install base whose health socket this instance answers. */
    base?: string | undefined;
    hostedOptions?: HostedOptions | undefined;
  }>,
) {
  const { reason, entry } = input.refusal;
  // Behind the gateway only with the gateway's admission. Without a readable
  // entry the port is unknown: an ephemeral loopback port that no gateway
  // proxies to, so nothing is served through it.
  const trust =
    entry === null ? null : createHostedTrust(entry, input.hostedOptions ?? {});
  const refusal: RecoveryAnswer = Object.freeze({
    error: "recovery-mode",
    check: recoveryCheck,
    reason,
  });
  // Every value is an enumerated id: no markup and nothing of the Folder.
  const text = `Lazurio Launchpad: Recovery mode\ncheck: ${recoveryCheck}\nreason: ${reason}\n`;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: entry === null ? 0 : entry.listenPort,
    development: false,
    maxRequestBodySize: 16 * 1024,
    async fetch(request) {
      if (trust !== null) {
        const admission = await trust.admit(request);
        if (!admission.ok)
          return Response.json(
            { error: "denied", reason: admission.reason },
            { status: 401, headers },
          );
      }
      if (new URL(request.url).pathname.startsWith("/api/"))
        return Response.json(refusal, { status: 503, headers });
      return new Response(text, {
        status: 503,
        headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
      });
    },
  });
  const health =
    input.base === undefined
      ? null
      : await serveHealthSocket(input.base, {
          mode: "recovery",
          check: recoveryCheck,
          reason,
        }).catch(async (error: unknown) => {
          await server.stop(true);
          throw error;
        });
  let closed: Promise<Readonly<{ kind: "closed" }>> | null = null;
  return {
    server,
    url: entry === null ? server.url.href : `${entry.externalOrigin}/`,
    hosted: entry !== null,
    reason,
    close() {
      closed ??= (async () => {
        await server.stop(true);
        await health?.stop(true);
        return Object.freeze({ kind: "closed" as const });
      })();
      return closed;
    },
  };
}

/** How long a start waits out a Folder that another operation holds right
 * now, before it names the condition: a profile change in flight holds the
 * lock and has a transaction for a moment. */
export const transientStartRetry = Object.freeze({
  attempts: 5,
  delayMs: 1_000,
});
const transient: readonly StartRefusal[] = [
  "folder-lock-unavailable",
  "folder-transaction-pending",
];

/** Start normally, or serve Recovery mode for a named refusal. Anything else
 * is not a condition this executable can name and still ends the process. */
export async function startOrRecover<T, R>(
  start: () => Promise<T>,
  recover: (refusal: LaunchpadStartRefused) => Promise<R>,
  retry: Readonly<{ attempts: number; delayMs: number }> = transientStartRetry,
): Promise<
  Readonly<{ mode: "normal"; value: T } | { mode: "recovery"; value: R }>
> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { mode: "normal", value: await start() };
    } catch (error) {
      if (!(error instanceof LaunchpadStartRefused)) throw error;
      if (attempt >= retry.attempts || !transient.includes(error.reason))
        return { mode: "recovery", value: await recover(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
  }
}
