import type { Connections } from "../connections/pairing";
import { isClientId, isSession } from "../connections/pairing";
import { stateFields } from "../folder/state-fields";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Settings → Connections → Telefon přes ChatGPT (decision F71), behind the
// admission of every `/api/*` route (the local token and same origin, or the
// gateway's session and same origin), JSON `POST` for every change:
//
//   GET  /api/connections              the state and the paired devices;
//                                      never a code
//   POST /api/connections/pair         {}: the code still valid, or a new
//                                      one once it expired or a phone took
//                                      it (Codex cannot end a code, so there
//                                      is no cancel); the manual code, its
//                                      QR and a session
//   POST /api/connections/pair/poll    {session}: waiting, paired, expired
//                                      or gone
//   POST /api/connections/revoke       {clientId}: after the person
//                                      confirmed in place
//   POST /api/connections/restart      {confirm: true}: restarts Codex where
//                                      remote control is not usable; running
//                                      chats end
//
// No answer, journal line or error carries a code, its QR payload or the
// session; every answer is `no-store` (the shared headers).

export const connectionsRoutePaths = Object.freeze({
  read: "/api/connections",
  pair: "/api/connections/pair",
  poll: "/api/connections/pair/poll",
  revoke: "/api/connections/revoke",
  restart: "/api/connections/restart",
});

const refusalStatus: Readonly<Record<string, number>> = {
  team: 403,
  "organization-ai": 409,
  "no-chatgpt": 409,
  "no-remote-control": 409,
  "too-many-starts": 429,
  "unknown-device": 404,
  "restart-not-needed": 409,
  "restart-not-managed": 409,
  "restart-failed": 502,
};

export function createConnectionsRoutes(
  input: Readonly<{
    connections: () => Connections;
    headers: Readonly<Record<string, string>>;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });

  /** One JSON POST body with exactly these keys. */
  async function body(
    request: Request,
    keys: readonly string[],
  ): Promise<Record<string, unknown> | Response> {
    if (request.method !== "POST")
      return response({ error: "method-not-allowed" }, 405);
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

  const answer = (
    result: Readonly<{ kind: string; reason?: string }>,
  ): Response =>
    result.kind === "blocked"
      ? response(result, refusalStatus[result.reason ?? ""] ?? 409)
      : response(result);

  return Object.freeze({
    handles: (path: string) =>
      path === connectionsRoutePaths.read ||
      path.startsWith(`${connectionsRoutePaths.read}/`),
    async handle(request: Request, url: URL): Promise<Response> {
      const connections = input.connections();
      if ([...url.searchParams.keys()].length > 0)
        return response({ error: "invalid-query" }, 400);
      switch (url.pathname) {
        case connectionsRoutePaths.read: {
          if (request.method !== "GET")
            return response({ error: "method-not-allowed" }, 405);
          return response(await connections.overview());
        }
        case connectionsRoutePaths.pair: {
          const value = await body(request, []);
          if (value instanceof Response) return value;
          return answer(await connections.start());
        }
        case connectionsRoutePaths.poll: {
          const value = await body(request, ["session"]);
          if (value instanceof Response) return value;
          if (!isSession(value.session))
            return response({ error: "invalid-session" }, 400);
          return response(await connections.poll(value.session));
        }
        case connectionsRoutePaths.revoke: {
          const value = await body(request, ["clientId"]);
          if (value instanceof Response) return value;
          if (!isClientId(value.clientId))
            return response({ error: "invalid-client" }, 400);
          return answer(await connections.revoke(value.clientId));
        }
        case connectionsRoutePaths.restart: {
          const value = await body(request, ["confirm"]);
          if (value instanceof Response) return value;
          if (value.confirm !== true)
            return response({ error: "confirmation-required" }, 400);
          return answer(await connections.restart());
        }
        default:
          return response({ error: "not-found" }, 404);
      }
    },
  });
}
