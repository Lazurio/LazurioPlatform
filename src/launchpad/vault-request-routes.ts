import { stateFields } from "../folder/state-fields";
import type { VaultHost } from "../vault/flow";
import {
  declineSecretRequest,
  listSecretRequests,
  type SecretRequestAnswer,
  type SecretRequestRefusal,
  saveSecretRequest,
  secretRequestOf,
} from "../vault/requests";
import { BodyTooLarge, readJsonBody } from "./json-body";

// An agent's secret request in the Launchpad (root decision 0198 point 9
// (c), decision F53), behind the admission of every `/api/*` route (locally
// the token and same origin, behind the gateway its session and same origin
// for a write), over the one core of `lazurio vault request`:
//
//   GET  /api/vault/requests                   the requests that wait, oldest
//                                              first
//   GET  /api/vault/requests/<id>              one request, in any state
//   POST /api/vault/requests/<id>/save {values}
//                                              the values, by field name,
//                                              become one Secure note in the
//                                              Environment's vault; 200 the
//                                              request, saved
//   POST /api/vault/requests/<id>/decline {}   200 the request, declined
//
// Any admitted person may answer; no account in the vault is needed. A
// value is read from the body, handed to the core and dropped: no answer,
// journal line or error ever holds one. Refusals are `{kind: "blocked",
// reason}`: 400 for what was sent, 404 an unknown request, 409 a request
// answered already or a vault that cannot take it, 503 a vault that is busy,
// locked or unreachable (try again).

export const vaultRequestsPath = "/api/vault/requests";
const requestPath = /^\/api\/vault\/requests\/([^/]+)(?:\/(save|decline))?$/;

/** The refusals of what was sent. */
const inputRefusals: ReadonlySet<SecretRequestRefusal> = new Set([
  "values-invalid",
]);
/** The refusals that pass: the vault is busy, locked or unreachable. */
const transientRefusals: ReadonlySet<SecretRequestRefusal> = new Set([
  "busy",
  "locked",
  "unreachable",
]);

/** A save may install nothing but runs bw twice over the network. */
const saveSeconds = 300;

export function createVaultRequestRoutes(
  input: Readonly<{
    host: () => VaultHost;
    headers: Readonly<Record<string, string>>;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });

  const answer = (result: SecretRequestAnswer): Response => {
    if (result.kind === "vault-request") return response(result);
    const status =
      result.reason === "not-found"
        ? 404
        : inputRefusals.has(result.reason)
          ? 400
          : transientRefusals.has(result.reason)
            ? 503
            : 409;
    return response(
      {
        kind: "blocked",
        reason: result.reason,
        ...(result.state === undefined ? {} : { state: result.state }),
      },
      status,
    );
  };

  /** A POST body with exactly these keys, as JSON from this page. */
  async function body(
    request: Request,
    keys: readonly string[],
  ): Promise<Record<string, unknown> | Response> {
    if (request.headers.get("content-type") !== "application/json")
      return response({ error: "invalid-content-type" }, 415);
    try {
      return stateFields(await readJsonBody(request), keys);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return response({ error: "body-too-large" }, 413);
      return response({ error: "invalid-request" }, 400);
    }
  }

  return Object.freeze({
    handles: (path: string) =>
      path === vaultRequestsPath || path.startsWith(`${vaultRequestsPath}/`),
    async handle(
      request: Request,
      url: URL,
      timeout?: (seconds: number) => void,
    ): Promise<Response> {
      if ([...url.searchParams.keys()].length > 0)
        return response({ error: "invalid-query" }, 400);
      if (url.pathname === vaultRequestsPath) {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        const listed = await listSecretRequests(input.host());
        // Without the Environment's own vault nothing waits: the page shows
        // no section, as for an empty list.
        return response({
          kind: "vault-requests",
          requests:
            listed.kind === "vault-requests"
              ? listed.requests.filter((entry) => entry.state === "pending")
              : [],
        });
      }
      const match = requestPath.exec(url.pathname);
      if (match === null) return response({ error: "not-found" }, 404);
      const id = match[1] as string;
      const action = match[2];
      if (action === undefined) {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        return answer(await secretRequestOf(input.host(), id));
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (action === "decline") {
        const value = await body(request, []);
        if (value instanceof Response) return value;
        return answer(await declineSecretRequest(input.host(), id));
      }
      const value = await body(request, ["values"]);
      if (value instanceof Response) return value;
      timeout?.(saveSeconds);
      return answer(await saveSecretRequest(input.host(), id, value.values));
    },
  });
}
