import { randomBytes } from "node:crypto";
import type { RecoveryResult } from "../recover/recover";
import { publicEntry } from "./chat";
import { serveHealthSocket } from "./health-socket";
import { createHostedTrust } from "./hosted-trust";
import { admitLocal, privatePage, serveShell } from "./page";
import type { HostedOptions } from "./server";
import {
  checkBundledPage,
  LaunchpadStartRefused,
  recoveryCheck,
  type StartRefusal,
} from "./start-check";

// The CLI prints the check with the Recovery-mode answer.
export { recoveryCheck };

/** Recovery mode (docs/update.md "Recovery mode", docs/recovery.md "The
 * Recovery page"): when the Launchpad cannot start normally for a reason it
 * can name, it does not exit. It keeps the port it would have served on and
 * serves the Recovery page: the bundled page, which needs nothing of the
 * Folder, shows the reason and the result of `GET /api/recovery`, the same
 * read-only use case as `lazurio recover --json`, and `GET /api/entry`, the
 * recorded entry's public parts for the page's T3 Code link. Every other API route
 * answers with the typed refusal, the health socket with 503. When the page
 * does not serve completely, every page path answers the reason as plain
 * text. Nothing here reads the Folder itself, starts an application or
 * changes anything; `collectRecovery` reads the Folder as `lazurio recover`
 * does.
 */

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
    /** The recovery use case of this installation (`lazurio recover`).
     * Trusted composition, never HTTP input. */
    recovery?: (() => Promise<RecoveryResult>) | undefined;
  }>,
) {
  const { reason, entry } = input.refusal;
  const { recovery } = input;
  // Behind the gateway only with the gateway's admission. Without a readable
  // entry the port is unknown: an ephemeral loopback port that no gateway
  // proxies to, so nothing is served through it.
  const trust =
    entry === null ? null : createHostedTrust(entry, input.hostedOptions ?? {});
  // Locally the Recovery page's evidence needs the credential of the
  // terminal link, as every read of the normal page does.
  const token = trust === null ? randomBytes(32).toString("hex") : "";
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
  const plain = () =>
    new Response(text, {
      status: 503,
      headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
    });
  // The page, when this executable's bundle serves completely; otherwise the
  // plain text is the whole page.
  const shell =
    reason !== "asset-missing" && (await privatePage(checkBundledPage))
      ? await serveShell()
      : null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: entry === null ? 0 : entry.listenPort,
    development: false,
    maxRequestBodySize: 16 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (trust !== null) {
        const admission = await trust.admit(request);
        if (!admission.ok)
          return Response.json(
            { error: "denied", reason: admission.reason },
            { status: 401, headers },
          );
      }
      if (request.method === "GET" && url.pathname === "/api/recovery") {
        if (
          trust === null &&
          !admitLocal(request, `http://127.0.0.1:${server.port}`, token)
        )
          return Response.json({ error: "denied" }, { status: 403, headers });
        if (!recovery)
          return Response.json(
            { error: "recovery-unavailable" },
            { status: 503, headers },
          );
        try {
          return Response.json(await recovery(), { headers });
        } catch {
          return Response.json(
            { error: "operation-failed" },
            { status: 500, headers },
          );
        }
      }
      // The recorded entry's public parts, as in normal mode: the page's
      // link to T3 Code for the repair agent (docs/recovery-mode.md C.3).
      if (request.method === "GET" && url.pathname === "/api/entry") {
        if (
          trust === null &&
          !admitLocal(request, `http://127.0.0.1:${server.port}`, token)
        )
          return Response.json({ error: "denied" }, { status: 403, headers });
        return Response.json(
          { kind: "entry", entry: publicEntry(entry) },
          { headers },
        );
      }
      if (url.pathname.startsWith("/api/"))
        return Response.json(refusal, { status: 503, headers });
      if (shell === null || request.method !== "GET") return plain();
      const page = await shell.get(
        `${url.pathname}${url.search}`,
        request.headers.get("accept"),
      );
      if (page.status === 404) {
        await page.body?.cancel().catch(() => undefined);
        return plain();
      }
      const type =
        page.headers.get("content-type") ?? "application/octet-stream";
      // The document itself still says "not healthy"; its scripts and
      // styles must answer 200 for the browser to run them.
      return new Response(page.body, {
        status: type.startsWith("text/html") ? 503 : page.status,
        headers: { ...headers, "Content-Type": type },
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
          await shell?.stop();
          throw error;
        });
  let closed: Promise<Readonly<{ kind: "closed" }>> | null = null;
  return {
    server,
    url:
      entry === null
        ? `${server.url.href}#${token}`
        : `${entry.externalOrigin}/`,
    hosted: entry !== null,
    reason,
    close() {
      closed ??= (async () => {
        await server.stop(true);
        await shell?.stop();
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
