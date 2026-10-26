import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";

// Buddy's Hermes gateway, the Launchpad's side (decision F63, variant A of the
// shaping for plan DEV-6676): the Launchpad is one more local client of the
// `hermes-gateway.service` that already runs Buddy, the way Hermes Desktop is
// (Lazurio/hermes-agent v0.22.4-lazurio.1, `apps/desktop/electron/
// local-gateway.ts`). Every gateway binds a loopback listener that serves
// Hermes's dashboard API (`gateway/run_api.py`) and withholds the dashboard's
// session token, which any local account could read; a client of the same
// account instead asks the gateway's owner-only control socket for a ticket
// that lives 30 seconds and is spent on its first use
// (`gateway/control_socket.py`, `gateway/runtime_bootstrap.py`), and sends it
// as `X-Hermes-Gateway-Ticket`, from loopback, with no `Origin`
// (`hermes_cli/dashboard_auth/native_http.py`).
//
// - The control socket of Buddy's home `~/.hermes` (the home `lazurio buddy
//   chat` gives his T3 Code, src/buddy/chat.ts) is `<home>/gateway.sock`, or,
//   for a home too long for a socket path, the socket a private pointer
//   `<home>/gateway.sock.path` names, only as
//   `…/hermes-gw-<sha256(home)[:16]>/control.sock`. The home is taken as the
//   real directory, as the gateway reserves it (`Path(home).resolve()`): it is
//   the profile a ticket is minted for. It must be a directory of this account
//   that no other account may write to (read and search grant nothing against
//   the socket); the socket, the pointer and the pointer's directory must be
//   of their kind, of this account, with no access for anyone else, and never
//   a link. Desktop's `privateNode` and Hermes's own discovery
//   (`hermes_cli/gateway_runtime_discovery.py`) refuse the same. A group-
//   writable home, which only Hermes's Python could prove private, is refused
//   as Desktop refuses it without its Python bridge. Node cannot ask for the
//   listener's credentials (SO_PEERCRED); the gateway asks for ours before it
//   mints a ticket.
// - One JSON line in, one out, then the gateway closes. `identify` first: the
//   gateway must be ready, of runtime protocol 1, with session authority,
//   serving exactly this home, and its API origin exactly
//   `http://127.0.0.1:<port>` or `http://[::1]:<port>` (Hermes's own
//   `gateway_runtime._endpoint` and Desktop's `assertLocalGatewayEndpoint`).
//   Then one `session-ticket` per request, purpose `native-http`, checked as
//   Desktop checks it: ok, protocol 1, the same id, instance and profile.
// - HTTP/1.1 with `node:http` and no agent of its own, as the relay's client
//   (src/organization-settings/relay.ts): Bun's `fetch` takes `HTTP_PROXY`
//   even for a loopback address (observed with Bun 1.4.2), which would hand
//   the ticket to a proxy; Hermes's own test client turns proxies off for the
//   same call (`trust_env=False`). Nothing follows a redirect; exactly the
//   headers set here go out: no `Origin`, never a `profile` query, so the
//   ticket's own home applies.
// - Every exchange has a deadline (5 s on the socket, 15 s over HTTP) and a
//   bounded answer. A result is `{ok, value}` or one closed reason. A refused
//   ticket (`401`: Hermes authenticates before any route runs) is replaced
//   once with a new one; nothing else is ever tried again, a write least of
//   all.
// - A body goes out only with the writes named in `gatewayBodyCalls`
//   (decision F66: Buddy's Telegram through Hermes's own writers): a JSON
//   object of at most 16 KiB, as `application/json`, with its exact length.
//   It may hold a secret (the bot's token), so it is serialized once, sent
//   with the call and, after a 401, with the one replacement ticket, and
//   never kept, logged or answered.
//
// The ticket, the gateway's answers and the paths never leave this module
// except as the answer of a request to its caller.

/** Buddy's one Hermes home: the home `lazurio buddy chat` gives his T3 Code
 * and his gateway serves. */
export const buddyHermesHome = (home: string) => join(home, ".hermes");

export type GatewayFailure =
  /** No gateway answers: no home, socket or pointer, or nothing listens. */
  | "no-socket"
  /** A link, another account's or a too open path: nothing was sent. */
  | "unsafe-path"
  /** The gateway is starting or failed. */
  | "not-ready"
  /** The gateway is stopping (an update or a restart). */
  | "draining"
  /** The gateway refused the ticket twice. */
  | "refused"
  | "timeout"
  /** An answer of no known shape, a foreign API origin among them. */
  | "invalid-answer"
  /** The gateway does not advertise what a call requires, Hermes's OAuth
   * cancellation contract (`oauthCancelContract`) or the call's
   * `capability`: nothing was sent. */
  | "outdated";

export type GatewayResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; reason: GatewayFailure }>;

/** The gateway as its `identify` answered. */
export type GatewayEndpoint = Readonly<{
  /** Buddy's real home: the profile of every ticket. */
  home: string;
  socket: string;
  instanceId: string;
  apiOrigin: string;
  /** Whether it advertises Hermes's OAuth cancellation contract. */
  contract: boolean;
  /** The capabilities its `identify` lists, Hermes's words. */
  capabilities: readonly string[];
}>;

/** Hermes's OAuth cancellation contract (Lazurio/hermes-agent#17, at
 * d1cf093e, `gateway/lazurio_oauth_contract.py`): whatever removes a running
 * sign-in from Hermes's map (its cancel, its 15-minute sweep, a failed start)
 * and the release of a stopping gateway's runtime lock first mark it cancelled
 * under the lock its worker takes to check that mark and save; so once a
 * session answers "session not found" or the poll's 404, here or from a
 * successor, nothing saves it. At v0.22.4-lazurio.1 the sweep removes a
 * session without the mark. A ready gateway lists the value in its
 * `identify`'s `capabilities`; the check also takes the member holding it. */
export const oauthCancelContract = Object.freeze({
  member: "capabilities",
  value: "lazurio-oauth-cancel-contract-v1",
});

/** Whether an `identify` result advertises the contract. */
const advertisesContract = (result: Readonly<Record<string, unknown>>) => {
  const advertised = result[oauthCancelContract.member];
  return Array.isArray(advertised)
    ? advertised.includes(oauthCancelContract.value)
    : advertised === oauthCancelContract.value;
};

/** One answer of Hermes's dashboard API: its status and its JSON body
 * (undefined for anything else). */
type HttpAnswer = Readonly<{ status: number; body: unknown }>;

/** An answer, the gateway instance that gave it (its `identify`'s
 * `instance_id`, which every ticket is bound to), and whether that instance
 * advertises Hermes's OAuth cancellation contract. */
export type GatewayAnswer = HttpAnswer &
  Readonly<{ instanceId: string; contract: boolean }>;

export type GatewayMethod = "GET" | "POST" | "PUT" | "DELETE";

/** The only calls that carry a JSON body (decision F66): Hermes's own
 * writers of Buddy's Telegram, its messaging platform, its allowlist and
 * home channel, its pairing approval and the quiet keys of its display.
 * Any other call with a body is refused before anything is sent. */
export const gatewayBodyCalls: ReadonlySet<string> = Object.freeze(
  new Set([
    "PUT /api/messaging/platforms/telegram",
    "POST /api/pairing/approve",
    "PUT /api/env",
    "DELETE /api/env",
    "PUT /api/config",
  ]),
);

/** A body of at most this many bytes: Telegram's settings are a few
 * hundred. */
export const gatewayBodyBytesMax = 16 * 1024;

export type GatewayRequestOptions = Readonly<{
  requireContract?: boolean;
  /** Only a gateway whose `identify` lists this capability is asked: a
   * write an older Hermes would not honour never reaches it. */
  capability?: string;
  /** A JSON object, only for a call of `gatewayBodyCalls`. */
  body?: Readonly<Record<string, unknown>>;
}>;

export type HermesGateway = Readonly<{
  identify(): Promise<GatewayResult<GatewayEndpoint>>;
  /** One call of Hermes's dashboard API with a ticket of its own; `path`
   * is an `/api/` path without a query. A body only for the writes of
   * `gatewayBodyCalls`, as JSON. With `requireContract`, a gateway that
   * does not advertise Hermes's OAuth cancellation contract is not asked
   * (`outdated`), and with `capability` one whose `identify` does not list
   * it. */
  request(
    method: GatewayMethod,
    path: string,
    options?: GatewayRequestOptions,
  ): Promise<GatewayResult<GatewayAnswer>>;
}>;

export type HermesGatewayOptions = Readonly<{
  /** The user's home, absolute. */
  home: string | undefined;
  /** Tests only: the account the paths must belong to (this process's). */
  uid?: number;
  /** Tests only: the deadlines. */
  controlMs?: number;
  httpMs?: number;
}>;

export const gatewayControlMs = 5_000;
export const gatewayHttpMs = 15_000;
// Hermes's own client bounds: 512 KiB for `identify`
// (`gateway_runtime_discovery.query_identify`), 64 KiB for a ticket
// (Desktop's `mintLocalGatewayTicket`); a pointer holds at most 4 KiB.
const identifyBytesMax = 512 * 1024;
const ticketBytesMax = 64 * 1024;
const pointerBytesMax = 4096;
// The dashboard's answers here are a few KiB.
const answerBytesMax = 256 * 1024;

const apiPath = /^\/api\/[A-Za-z0-9._~/-]+$/;
const loopbackOrigin = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const instancePattern = /^[A-Za-z0-9._-]{1,128}$/;
// `secrets.token_urlsafe(32)`; Hermes redeems at most 256 characters.
const ticketPattern = /^[A-Za-z0-9_-]{16,256}$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failed = (reason: GatewayFailure) =>
  Object.freeze({ ok: false as const, reason });
const succeeded = <T>(value: T) => Object.freeze({ ok: true as const, value });

type NodeKind = "home" | "directory" | "socket";
type NodeCheck = "ok" | "missing" | "unsafe";

const missingError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Desktop's `privateNode`: of its kind and never a link, of this account,
 * and open to nobody else (the home: writable by nobody else). */
async function privateNode(
  path: string,
  kind: NodeKind,
  uid: number,
): Promise<NodeCheck> {
  let node: Awaited<ReturnType<typeof lstat>>;
  try {
    node = await lstat(path);
  } catch (error) {
    return missingError(error) ? "missing" : "unsafe";
  }
  const valid = kind === "socket" ? node.isSocket() : node.isDirectory();
  if (!valid || node.uid !== uid) return "unsafe";
  const mode = Number(node.mode) & 0o777;
  return (mode & (kind === "home" ? 0o022 : 0o077)) === 0 ? "ok" : "unsafe";
}

/** The pointer's target, read through a descriptor that refuses a link and a
 * FIFO, of this account and open to nobody else, at most 4 KiB. */
async function readPointer(
  pointer: string,
  uid: number,
): Promise<Readonly<{ target: string }> | Exclude<NodeCheck, "ok">> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      pointer,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return missingError(error) ? "missing" : "unsafe";
  }
  try {
    const node = await handle.stat();
    if (!node.isFile() || node.uid !== uid || (node.mode & 0o077) !== 0)
      return "unsafe";
    const buffer = Buffer.alloc(pointerBytesMax + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > pointerBytesMax) return "unsafe";
    return {
      target: new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, bytesRead))
        .trim(),
    };
  } catch {
    return "unsafe";
  } finally {
    await handle.close();
  }
}

/** Buddy's real home and its control socket, or why there is none. */
async function locate(
  userHome: string | undefined,
  uid: number,
): Promise<GatewayResult<Readonly<{ home: string; socket: string }>>> {
  if (userHome === undefined || !isAbsolute(userHome))
    return failed("no-socket");
  let home: string;
  try {
    home = await realpath(buddyHermesHome(userHome));
  } catch (error) {
    return failed(missingError(error) ? "no-socket" : "unsafe-path");
  }
  const homeCheck = await privateNode(home, "home", uid);
  if (homeCheck !== "ok")
    return failed(homeCheck === "missing" ? "no-socket" : "unsafe-path");
  const direct = join(home, "gateway.sock");
  const directCheck = await privateNode(direct, "socket", uid);
  if (directCheck === "ok") return succeeded({ home, socket: direct });
  if (directCheck === "unsafe") return failed("unsafe-path");
  const pointer = await readPointer(join(home, "gateway.sock.path"), uid);
  if (pointer === "missing") return failed("no-socket");
  if (pointer === "unsafe") return failed("unsafe-path");
  const { target } = pointer;
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  if (
    !isAbsolute(target) ||
    basename(target) !== "control.sock" ||
    basename(dirname(target)) !== `hermes-gw-${hash}`
  )
    return failed("unsafe-path");
  for (const [path, kind] of [
    [dirname(target), "directory"],
    [target, "socket"],
  ] as const) {
    const check = await privateNode(path, kind, uid);
    if (check !== "ok")
      return failed(check === "missing" ? "no-socket" : "unsafe-path");
  }
  return succeeded({ home, socket: target });
}

/** One request line to the control socket and its one answer line. */
function controlExchange(
  socket: string,
  request: Json,
  maxBytes: number,
  timeoutMs: number,
): Promise<GatewayResult<Json>> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const connection = createConnection(socket);
    const finish = (result: GatewayResult<Json>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(failed("timeout")), timeoutMs);
    connection.on("connect", () =>
      connection.write(`${JSON.stringify(request)}\n`),
    );
    connection.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) {
        if (buffer.length > maxBytes) finish(failed("invalid-answer"));
        return;
      }
      if (newline > maxBytes) return finish(failed("invalid-answer"));
      try {
        const answer: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, newline),
          ),
        );
        finish(isObject(answer) ? succeeded(answer) : failed("invalid-answer"));
      } catch {
        finish(failed("invalid-answer"));
      }
    });
    connection.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        failed(
          error.code === "EACCES" || error.code === "EPERM"
            ? "unsafe-path"
            : error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? "no-socket"
              : "not-ready",
        ),
      ),
    );
    // Closed before a whole line (Hermes's `incomplete_control_response`).
    connection.on("close", () => finish(failed("invalid-answer")));
  });
}

/** The `identify` answer as an endpoint of this home, or why it is none:
 * Hermes's own `gateway_runtime._endpoint`, then Desktop's loopback rule, made
 * exact. */
export function gatewayEndpoint(
  answer: Json,
  home: string,
  socket: string,
): GatewayResult<GatewayEndpoint> {
  if (
    answer.ok !== true ||
    answer.protocol !== 1 ||
    answer.id !== 1 ||
    !isObject(answer.result)
  )
    return failed("invalid-answer");
  const result = answer.result;
  if (result.runtime_protocol !== 1) return failed("invalid-answer");
  const served = Array.isArray(result.served_profiles)
    ? result.served_profiles.filter(
        (profile) => isObject(profile) && profile.home === home,
      )
    : [];
  if (served.length !== 1 || (served[0] as Json).profile_id !== home)
    return failed("invalid-answer");
  if (result.state === "draining") return failed("draining");
  if (result.state !== "ready") return failed("not-ready");
  if (
    !Array.isArray(result.capabilities) ||
    !result.capabilities.includes("session-authority-v1")
  )
    return failed("invalid-answer");
  const epoch = result.authority_epoch;
  const instance = result.instance_id;
  if (
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch <= 0 ||
    typeof instance !== "string" ||
    !instancePattern.test(instance)
  )
    return failed("invalid-answer");
  const origin = result.api_origin;
  const port =
    typeof origin === "string" ? loopbackOrigin.exec(origin)?.[1] : undefined;
  if (port === undefined || Number(port) > 65535)
    return failed("invalid-answer");
  return succeeded({
    home,
    socket,
    instanceId: instance,
    apiOrigin: origin as string,
    contract: advertisesContract(result),
    capabilities: Object.freeze(
      result.capabilities.filter(
        (capability): capability is string => typeof capability === "string",
      ),
    ),
  });
}

/** A ticket for exactly this endpoint, as Desktop checks it. */
async function mintTicket(
  endpoint: GatewayEndpoint,
  timeoutMs: number,
): Promise<GatewayResult<string>> {
  const answer = await controlExchange(
    endpoint.socket,
    {
      protocol: 1,
      id: 1,
      verb: "session-ticket",
      params: {
        profile_id: endpoint.home,
        instance_id: endpoint.instanceId,
        purpose: "native-http",
      },
    },
    ticketBytesMax,
    timeoutMs,
  );
  if (!answer.ok) return answer;
  const reply = answer.value;
  if (reply.ok === false && reply.protocol === 1) return failed("refused");
  const grant = reply.result;
  if (
    reply.ok !== true ||
    reply.protocol !== 1 ||
    reply.id !== 1 ||
    !isObject(grant) ||
    grant.instance_id !== endpoint.instanceId ||
    grant.profile_id !== endpoint.home ||
    typeof grant.ticket !== "string" ||
    !ticketPattern.test(grant.ticket)
  )
    return failed("invalid-answer");
  return succeeded(grant.ticket);
}

/** One HTTP exchange with the gateway's listener: exactly these headers, no
 * proxy, no redirect, bounded in time and size; `body`, already serialized,
 * as JSON with its exact length. */
function httpExchange(
  origin: string,
  method: GatewayMethod,
  path: string,
  ticket: string,
  timeoutMs: number,
  body: Buffer | undefined,
): Promise<GatewayResult<HttpAnswer>> {
  const url = new URL(origin);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GatewayResult<HttpAnswer>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outgoing.destroy();
      resolve(result);
    };
    const outgoing = httpRequest(
      {
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port),
        path,
        method,
        agent: false,
        headers: {
          host: url.host,
          accept: "application/json",
          "x-hermes-gateway-ticket": ticket,
          ...(body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(body.byteLength),
              }
            : method === "GET"
              ? {}
              : { "content-length": "0" }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          size += chunk.byteLength;
          if (size > answerBytesMax) {
            finish(failed("invalid-answer"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const type = String(response.headers["content-type"] ?? "");
          let body: unknown;
          if (/^application\/json\b/i.test(type))
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              body = undefined;
            }
          finish(succeeded({ status: response.statusCode ?? 0, body }));
        });
        response.on("error", () => finish(failed("not-ready")));
      },
    );
    const timer = setTimeout(() => finish(failed("timeout")), timeoutMs);
    outgoing.on("error", () => finish(failed("not-ready")));
    if (body === undefined) outgoing.end();
    else outgoing.end(body);
  });
}

/** The body of a named write, serialized once: a plain JSON object of at
 * most `gatewayBodyBytesMax` bytes. Anything else is a caller's error. */
function serializedBody(
  method: GatewayMethod,
  path: string,
  body: Readonly<Record<string, unknown>> | undefined,
): Buffer | undefined {
  if (body === undefined) return undefined;
  if (!gatewayBodyCalls.has(`${method} ${path}`))
    throw new Error("Only a named write of Hermes carries a body");
  if (!isObject(body)) throw new Error("A body is one JSON object");
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.byteLength > gatewayBodyBytesMax)
    throw new Error("A body of at most 16 KiB is sent");
  return bytes;
}

export function createHermesGateway(
  options: HermesGatewayOptions,
): HermesGateway {
  const controlMs = options.controlMs ?? gatewayControlMs;
  const httpMs = options.httpMs ?? gatewayHttpMs;
  const uid = options.uid ?? process.getuid?.();

  async function identify(): Promise<GatewayResult<GatewayEndpoint>> {
    // A control socket is POSIX's; Hermes's Windows pipe is not asked here.
    if (uid === undefined) return failed("no-socket");
    const located = await locate(options.home, uid);
    if (!located.ok) return located;
    const answer = await controlExchange(
      located.value.socket,
      { protocol: 1, verb: "identify", id: 1 },
      identifyBytesMax,
      controlMs,
    );
    if (!answer.ok) return answer;
    return gatewayEndpoint(
      answer.value,
      located.value.home,
      located.value.socket,
    );
  }

  return Object.freeze({
    identify,
    async request(
      method: GatewayMethod,
      path: string,
      options: GatewayRequestOptions = {},
    ) {
      if (!apiPath.test(path) || path.includes(".."))
        throw new Error("Only an /api/ path without a query is asked");
      const body = serializedBody(method, path, options.body);
      for (let attempt = 0; ; attempt += 1) {
        const endpoint = await identify();
        if (!endpoint.ok) return endpoint;
        // The ticket binds the call to this instance, so the instance that
        // advertised the contract is the one that serves the call.
        if (options.requireContract === true && !endpoint.value.contract)
          return failed("outdated");
        if (
          options.capability !== undefined &&
          !endpoint.value.capabilities.includes(options.capability)
        )
          return failed("outdated");
        const ticket = await mintTicket(endpoint.value, controlMs);
        if (!ticket.ok) {
          if (ticket.reason === "refused" && attempt === 0) continue;
          return ticket;
        }
        const answer = await httpExchange(
          endpoint.value.apiOrigin,
          method,
          path,
          ticket.value,
          httpMs,
          body,
        );
        if (!answer.ok) return answer;
        const { status, body: answered } = answer.value;
        // Hermes authenticates before any route runs: nothing ran, a write
        // included, so its one replacement ticket carries the same body.
        if (status === 401) {
          if (attempt === 0) continue;
          return failed("refused");
        }
        // The listener stopped taking requests between `identify` and now.
        if (
          status === 503 &&
          isObject(answered) &&
          answered.error === "gateway_not_ready"
        )
          return failed(
            answered.state === "draining" ? "draining" : "not-ready",
          );
        return succeeded({
          status,
          body: answered,
          instanceId: endpoint.value.instanceId,
          contract: endpoint.value.contract,
        });
      }
    },
  });
}
