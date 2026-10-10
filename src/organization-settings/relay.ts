import { request as httpRequest } from "node:http";
import {
  type DeliveredSettings,
  errorCode,
  isCommitId,
  parseSettingsAnswer,
  type ReportError,
  reportBody,
  type SettingsReport,
  settingsAnswerBytesMax,
} from "./contract";

// The Launchpad's side of the Environment's relay (contract C3, Machines
// #449; root decision 0194 point 3). The relay is one server of the
// gateway's Caddy on a unix socket only the operator account can reach; it
// forwards exactly two calls to the Dashboard and attaches the Environment's
// own token, which neither the Launchpad nor any agent ever holds:
//
//   GET  /organization/settings          (If-None-Match: "<version>")
//   POST /organization/settings/report   (application/json, at most 4 KiB)
//
// HTTP/1.1 over the socket with `node:http` and no agent of its own: no
// proxy of the environment can stand in, nothing follows a redirect, and
// every exchange is bounded in time and size. Any answer other than 200 or
// 304 keeps the last applied version; 502, 503 and 504 (and a relay that is
// not there or does not answer) are tried again after the backoff delays.

export const relayPaths = Object.freeze({
  settings: "/organization/settings",
  report: "/organization/settings/report",
});

/** One attempt waits at most this long: past the relay's own deadlines to
 * the Dashboard (5 s to connect, 10 s to the headers), so its 504 comes
 * first. */
export const relayTimeoutMs = 20_000;
/** The waits before the second and the third attempt. */
export const relayRetryDelaysMs: readonly number[] = Object.freeze([
  2_000, 5_000,
]);

/** One HTTP exchange over the relay, as the transport saw it. */
export type RelayExchange =
  | Readonly<{
      kind: "answer";
      status: number;
      type: string;
      text: string;
    }>
  | Readonly<{
      kind: "failed";
      reason:
        | "socket-absent"
        | "socket-denied"
        | "socket-refused"
        | "timeout"
        | "too-large"
        | "network";
    }>;

export type RelayTransport = (
  input: Readonly<{
    method: "GET" | "POST";
    path: string;
    headers: Readonly<Record<string, string>>;
    body: string | null;
    timeoutMs: number;
    maxBytes: number;
  }>,
) => Promise<RelayExchange>;

function failure(error: unknown): Extract<RelayExchange, { kind: "failed" }> {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    kind: "failed",
    reason:
      code === "ENOENT"
        ? "socket-absent"
        : code === "EACCES" || code === "EPERM"
          ? "socket-denied"
          : code === "ECONNREFUSED"
            ? "socket-refused"
            : "network",
  };
}

/** The relay of this Machine, by the socket its handover names. */
export function unixSocketTransport(socket: string): RelayTransport {
  return (input) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (result: RelayExchange): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const outgoing = httpRequest(
        {
          socketPath: socket,
          path: input.path,
          method: input.method,
          agent: false,
          headers: {
            // Any host: the relay names the Dashboard's own.
            host: "localhost",
            ...input.headers,
            ...(input.body === null
              ? {}
              : { "content-length": String(Buffer.byteLength(input.body)) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > input.maxBytes) {
              response.destroy();
              outgoing.destroy();
              finish({ kind: "failed", reason: "too-large" });
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            finish({
              kind: "answer",
              status: response.statusCode ?? 0,
              type: String(response.headers["content-type"] ?? ""),
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", (error) => finish(failure(error)));
        },
      );
      const timer = setTimeout(() => {
        outgoing.destroy();
        finish({ kind: "failed", reason: "timeout" });
      }, input.timeoutMs);
      outgoing.on("error", (error) => finish(failure(error)));
      if (input.body !== null) outgoing.write(input.body);
      outgoing.end();
    });
}

/** What one settings read gave. */
export type SettingsRead =
  /** 200: the settings at the Organization root's current version. */
  | Readonly<{ kind: "settings"; settings: DeliveredSettings }>
  /** 304: the version asked about is still current. */
  | Readonly<{ kind: "not-modified"; version: string }>
  /** 409: the Organization's settings break the contract at that version;
   * the Admin sees it in the Dashboard. */
  | Readonly<{ kind: "invalid"; version: string | null }>
  /** No usable answer: keep the last applied version. */
  | Readonly<{
      kind: "failed";
      error: Exclude<ReportError, "settings_invalid">;
      /** A short code for the journal and the details, never shown raw. */
      detail: string;
    }>;

export type ReportSent =
  | Readonly<{ kind: "accepted" }>
  /** The Dashboard or the relay refused this report as it is. */
  | Readonly<{ kind: "refused"; status: number; detail: string }>
  /** No answer: report again later. */
  | Readonly<{ kind: "failed"; detail: string }>;

export type RelayClient = Readonly<{
  /** The Organization's settings now; `known` is the version this
   * Environment applied last, asked as `If-None-Match`. */
  readSettings(known: string | null): Promise<SettingsRead>;
  sendReport(report: SettingsReport): Promise<ReportSent>;
}>;

const retried = (exchange: RelayExchange) =>
  exchange.kind === "failed"
    ? exchange.reason !== "too-large"
    : [502, 503, 504].includes(exchange.status);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createRelayClient(
  options: Readonly<{
    transport: RelayTransport;
    timeoutMs?: number;
    retryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  }>,
): RelayClient {
  const timeoutMs = options.timeoutMs ?? relayTimeoutMs;
  const delays = options.retryDelaysMs ?? relayRetryDelaysMs;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  async function exchange(
    method: "GET" | "POST",
    path: string,
    headers: Readonly<Record<string, string>>,
    body: string | null,
  ): Promise<RelayExchange> {
    let answer = await options.transport({
      method,
      path,
      headers,
      body,
      timeoutMs,
      maxBytes: settingsAnswerBytesMax,
    });
    for (const delay of delays) {
      if (!retried(answer)) break;
      await sleep(delay);
      answer = await options.transport({
        method,
        path,
        headers,
        body,
        timeoutMs,
        maxBytes: settingsAnswerBytesMax,
      });
    }
    return answer;
  }
  return Object.freeze({
    async readSettings(known) {
      const answer = await exchange(
        "GET",
        relayPaths.settings,
        {
          accept: "application/json",
          ...(known === null ? {} : { "if-none-match": `"${known}"` }),
        },
        null,
      );
      if (answer.kind === "failed")
        return {
          kind: "failed",
          error: "dashboard_unreachable",
          detail: answer.reason,
        };
      const { status } = answer;
      if (status === 200) {
        const settings = parseSettingsAnswer(parseJson(answer.text));
        return settings === null
          ? {
              kind: "failed",
              error: "dashboard_unreachable",
              detail: "answer-invalid",
            }
          : { kind: "settings", settings };
      }
      // Not modified is an answer only to a question that named a version.
      if (status === 304)
        return known === null
          ? {
              kind: "failed",
              error: "dashboard_unreachable",
              detail: "answer-invalid",
            }
          : { kind: "not-modified", version: known };
      const body = parseJson(answer.text);
      const code = errorCode(body);
      if (status === 409 && code === "settings_invalid") {
        const version = (body as { version?: unknown }).version;
        return {
          kind: "invalid",
          version: isCommitId(version) ? version : null,
        };
      }
      // The relay has no token for this Environment yet, or the Dashboard
      // refuses the one it attached: the Environment's identity is what is
      // missing, not the Dashboard.
      if (status === 503 && code === "environment_identity_unavailable")
        return {
          kind: "failed",
          error: "identity_unavailable",
          detail: "environment_identity_unavailable",
        };
      if (status === 401 || status === 403)
        return {
          kind: "failed",
          error: "identity_unavailable",
          detail: `status-${status}`,
        };
      return {
        kind: "failed",
        error: "dashboard_unreachable",
        detail: `status-${status}`,
      };
    },
    async sendReport(report) {
      const answer = await exchange(
        "POST",
        relayPaths.report,
        { "content-type": "application/json", accept: "application/json" },
        reportBody(report),
      );
      if (answer.kind === "failed")
        return { kind: "failed", detail: answer.reason };
      if (answer.status === 202) return { kind: "accepted" };
      if ([502, 503, 504].includes(answer.status))
        return { kind: "failed", detail: `status-${answer.status}` };
      return {
        kind: "refused",
        status: answer.status,
        detail: errorCode(parseJson(answer.text)) ?? `status-${answer.status}`,
      };
    },
  });
}
