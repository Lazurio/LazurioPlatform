import {
  type ComputersHost,
  listComputers,
  removeComputer,
} from "../computers/computers";
import { BodyTooLarge, readJsonBody } from "./json-body";

// People's computers for agents (Lazurio Agent Desktop, root decisions 0240
// and 0241, decision F75), behind the admission of every route (the
// gateway's session; a write same-origin from the Launchpad's own origin,
// which is the protection against a forged request):
//
//   GET  /api/computers         the computers that attached (Settings →
//                               Connections)
//   POST /api/computers/remove  {deviceId}
//
// A computer is admitted by the Environment's gateway on contract v3 and its
// first attach creates it (`../computers/attach-ws`). Contract v1's pairing,
// the page `/connect/computer` and `POST /api/computers`, is gone: both answer
// 404. The journal names the operation, the outcome and the id.

export const computersRoutePaths = Object.freeze({
  api: "/api/computers",
  remove: "/api/computers/remove",
  /** Contract v1's pairing page, retired: answered 404 rather than as a page
   * of the shell. */
  retiredPage: "/connect/computer",
});

export function createComputersRoutes(
  input: Readonly<{
    host: () => ComputersHost | Promise<ComputersHost>;
    headers: Readonly<Record<string, string>>;
    journal?: (entry: Readonly<Record<string, string>>) => void;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const journal = (entry: Record<string, string>) =>
    input.journal?.({ scope: "computers", ...entry });

  return Object.freeze({
    handles: (path: string) =>
      path === computersRoutePaths.api ||
      path.startsWith(`${computersRoutePaths.api}/`),
    handlesRetired: (path: string) => path === computersRoutePaths.retiredPage,
    retired: () => response({ error: "not-found" }, 404),

    async handle(request: Request, url: URL): Promise<Response> {
      if (url.pathname === computersRoutePaths.api) {
        if (request.method === "GET") {
          if ([...url.searchParams.keys()].length > 0)
            return response({ error: "invalid-query" }, 400);
          return response(await listComputers(await input.host()));
        }
        // Contract v1's pairing is gone.
        if (request.method === "POST")
          return response({ error: "not-found" }, 404);
        return response({ error: "method-not-allowed" }, 405);
      }
      if (url.pathname === computersRoutePaths.remove) {
        if (request.method !== "POST")
          return response({ error: "method-not-allowed" }, 405);
        if (request.headers.get("content-type") !== "application/json")
          return response({ error: "invalid-content-type" }, 415);
        let deviceId: unknown;
        try {
          const body = await readJsonBody(request);
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return response({ error: "invalid-request" }, 400);
          const keys = Object.keys(body);
          if (keys.length !== 1 || keys[0] !== "deviceId")
            return response({ error: "invalid-request" }, 400);
          deviceId = (body as Record<string, unknown>).deviceId;
        } catch (error) {
          if (error instanceof BodyTooLarge)
            return response({ error: "body-too-large" }, 413);
          return response({ error: "invalid-request" }, 400);
        }
        const answer = await removeComputer(await input.host(), deviceId);
        if (answer.kind === "blocked") {
          journal({
            operation: "remove",
            outcome: "refused",
            reason: answer.reason,
          });
          return response(
            answer,
            answer.reason === "invalid-id"
              ? 400
              : answer.reason === "not-found"
                ? 404
                : 409,
          );
        }
        journal({
          operation: "remove",
          outcome: "removed",
          device: answer.deviceId,
          agents: answer.agents,
        });
        return response(answer);
      }
      return response({ error: "not-found" }, 404);
    },
  });
}
