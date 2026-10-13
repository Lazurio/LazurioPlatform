import { Agent, request as httpRequest } from "node:http";
import { join } from "node:path";
import {
  compareListenerOwner,
  observeListenerBindings,
} from "../modules/listener-ownership";
import { readOwnerOnlyFileBytes } from "../providers/owned-json";

// The Launchpad's client of the Environment's Executor 1 (decision F42,
// docs/integrations.md "Executor API"): its typed HTTP API on loopback, the
// same API Executor's own console uses, so people never need the console.
// Executor 1.6.10 serves it under `/api` on 127.0.0.1:4789 (the port of
// `executor install`) and admits a request by `Authorization: Bearer
// <token>`, the token of `~/.executor/server-control/auth.json` (0600). This
// client:
// - reads the token for each call, only from an owner-only regular file, and
//   never returns, logs or keeps it;
// - sends it only after proving that the 127.0.0.1 listener on the port
//   belongs to this account (lsof): on a shared host the fixed port may be
//   another account's process;
// - connects directly with `node:http` and an agent of its own, so no proxy
//   of the environment (HTTP_PROXY, ALL_PROXY, NODE_USE_ENV_PROXY) ever sees
//   the token, as Bun's `fetch` would let it;
// - follows no redirect, bounds the time and the size of every answer and
//   parses only JSON; the caller checks the exact shape. The one page it
//   asks for, Executor's callback after an authorization server's return,
//   is dropped unread.

/** Executor's port as `executor install` serves it. */
export const executorPort = 4789;
const tokenBytesMax = 4 * 1024;
const answerBytesMax = 2 * 1024 * 1024;
export const executorTimeoutMs = 15_000;

export type ExecutorEndpoint = Readonly<{
  /** Executor's data directory: `EXECUTOR_DATA_DIR`, else `~/.executor`. */
  dataDir: string;
  port: number;
  /** This account: the owner of the token file and of the listener. */
  uid: number;
  /** Whether the 127.0.0.1 listener on `port` is this account's alone. */
  ownsListener: (port: number) => Promise<boolean>;
  /** The HTTP exchange; tests supply their own. */
  transport?: ExecutorTransport;
}>;

export type ExecutorTransport = (
  input: Readonly<{
    method: string;
    port: number;
    path: string;
    headers: Readonly<Record<string, string>>;
    body: string | null;
    timeoutMs: number;
    maxBytes: number;
  }>,
) => Promise<
  | Readonly<{ kind: "answer"; status: number; type: string; text: string }>
  | Readonly<{ kind: "failed"; reason: "timeout" | "too-large" | "network" }>
>;

export type ExecutorResult =
  | Readonly<{ kind: "answer"; status: number; body: unknown }>
  /** Nothing to ask: no token, no listener of this account. */
  | Readonly<{
      kind: "unavailable";
      reason: "token-missing" | "token-unreadable" | "listener-unproven";
    }>
  /** It was asked and gave no usable answer. */
  | Readonly<{
      kind: "failed";
      reason: "timeout" | "too-large" | "network" | "not-json" | "redirect";
    }>;

/** The account's Executor: `EXECUTOR_DATA_DIR` or `~/.executor`, port 4789. */
export function processExecutorEndpoint(
  env: Readonly<Record<string, string | undefined>>,
  uid: number | undefined = process.getuid?.(),
): ExecutorEndpoint | null {
  const home = env.HOME;
  const own = env.EXECUTOR_DATA_DIR;
  const dataDir = own?.startsWith("/")
    ? own
    : home?.startsWith("/")
      ? join(home, ".executor")
      : null;
  if (dataDir === null || uid === undefined) return null;
  return Object.freeze({
    dataDir,
    port: executorPort,
    uid,
    ownsListener: (port: number) => listenerOwnedBy(port, uid),
  });
}

/** Whether every listener on `port` is 127.0.0.1 of `uid`'s processes. */
export async function listenerOwnedBy(
  port: number,
  uid: number,
): Promise<boolean> {
  try {
    const observation = await observeListenerBindings(port);
    return (
      compareListenerOwner(
        observation,
        "127.0.0.1",
        port,
        (binding) => binding.uid === uid,
      ) === "matches-owner"
    );
  } catch {
    return false;
  }
}

/** The token, from an owner-only `server-control/auth.json` (`{token}`). */
async function readToken(
  host: ExecutorEndpoint,
): Promise<string | "missing" | "unreadable"> {
  let bytes: Buffer;
  try {
    bytes = await readOwnerOnlyFileBytes(
      join(host.dataDir, "server-control", "auth.json"),
      host.uid,
      tokenBytesMax,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    const token = (value as { token?: unknown } | null)?.token;
    return typeof token === "string" && /^[A-Za-z0-9_-]{16,512}$/.test(token)
      ? token
      : "unreadable";
  } catch {
    return "unreadable";
  }
}

/** One exchange over `node:http` with an agent of its own: no proxy, no
 * redirect, bounded in time and size. */
export const directTransport: ExecutorTransport = (input) =>
  new Promise((resolve) => {
    const agent = new Agent({ keepAlive: false });
    let settled = false;
    const finish = (result: Awaited<ReturnType<ExecutorTransport>>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      resolve(result);
    };
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: input.method,
        headers: {
          ...input.headers,
          ...(input.body === null
            ? {}
            : { "content-length": String(Buffer.byteLength(input.body)) }),
        },
        agent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > input.maxBytes) {
            response.destroy();
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
        response.on("error", () =>
          finish({ kind: "failed", reason: "network" }),
        );
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy();
      finish({ kind: "failed", reason: "timeout" });
    }, input.timeoutMs);
    outgoing.on("error", () => finish({ kind: "failed", reason: "network" }));
    if (input.body !== null) outgoing.write(input.body);
    outgoing.end();
  });

/** The token, once the listener of the port and the token file are proven
 * this account's; why not otherwise. */
async function proven(
  host: ExecutorEndpoint,
): Promise<string | Extract<ExecutorResult, { kind: "unavailable" }>> {
  if (!(await host.ownsListener(host.port)))
    return { kind: "unavailable", reason: "listener-unproven" };
  const token = await readToken(host);
  if (token === "missing")
    return { kind: "unavailable", reason: "token-missing" };
  if (token === "unreadable")
    return { kind: "unavailable", reason: "token-unreadable" };
  return token;
}

/** One request to Executor's API with a proven token: `path` below `/api`,
 * a JSON body or none. It goes out in the turn this is called. */
function send(
  host: ExecutorEndpoint,
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  timeoutMs: number,
  accept: string,
): ReturnType<ExecutorTransport> {
  return (host.transport ?? directTransport)({
    method,
    port: host.port,
    path: `/api${path}`,
    headers: {
      authorization: `Bearer ${token}`,
      accept,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? null : JSON.stringify(body),
    timeoutMs,
    maxBytes: answerBytesMax,
  });
}

/** One call of Executor's API: `path` below `/api`, a JSON body or none. */
export async function executorCall(
  host: ExecutorEndpoint,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs: number = executorTimeoutMs,
): Promise<ExecutorResult> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("An Executor API path");
  const token = await proven(host);
  if (typeof token !== "string") return token;
  const answer = await send(
    host,
    token,
    method,
    path,
    body,
    timeoutMs,
    "application/json",
  );
  if (answer.kind === "failed") return answer;
  if (answer.status >= 300 && answer.status < 400)
    return { kind: "failed", reason: "redirect" };
  // Executor refuses a token in plain text; the status says it all.
  if (answer.status === 401) return { kind: "answer", status: 401, body: null };
  try {
    return {
      kind: "answer",
      status: answer.status,
      body: answer.text === "" ? null : (JSON.parse(answer.text) as unknown),
    };
  } catch {
    return { kind: "failed", reason: "not-json" };
  }
}

/** The parameters of an authorization server's return that Executor's own
 * callback reads (Executor 1.6.10, `GET /api/oauth/callback`): the flow's
 * state, the code or the error, and the region hints of a multi-site
 * server. */
export const oauthReturnParameters = [
  "state",
  "code",
  "error",
  "error_description",
  "domain",
  "site",
] as const;

/** Hands an authorization server's return to Executor's own callback, as a
 * browser on the Environment would (decision F42, addendum of 2026-10-13):
 * Executor exchanges the code and answers its own popup page, which is
 * dropped unread; the outcome comes from `GET /api/oauth/await/<state>`.
 * Delivered on any 2xx: Executor's page answers a failed exchange too.
 * `proceed` is asked once the listener and the token are proven, in the
 * turn the request goes out: a sign-in cancelled or expired meanwhile is
 * withheld, never sent. */
export async function executorOAuthReturn(
  host: ExecutorEndpoint,
  parameters: Readonly<
    Partial<Record<(typeof oauthReturnParameters)[number], string>>
  >,
  timeoutMs: number,
  proceed: () => boolean,
): Promise<"delivered" | "withheld" | "unavailable" | "failed"> {
  const query = new URLSearchParams();
  for (const key of oauthReturnParameters) {
    const value = parameters[key];
    if (value !== undefined) query.set(key, value);
  }
  const token = await proven(host);
  if (typeof token !== "string") return "unavailable";
  // Asked in the turn the request goes out: nothing can end the sign-in
  // between this answer and the request.
  if (!proceed()) return "withheld";
  const answer = await send(
    host,
    token,
    "GET",
    `/oauth/callback?${query}`,
    undefined,
    timeoutMs,
    "text/html",
  );
  return answer.kind === "answer" && answer.status >= 200 && answer.status < 300
    ? "delivered"
    : "failed";
}
