import { ownDataValue, stateFields } from "../folder/state-fields";
import {
  addDevice,
  inputRefusals,
  removeDevice,
  sshAccessOverview,
} from "../ssh-access/access";
import type { SshAccessHost } from "../ssh-access/host";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Settings → SSH from your devices (decision F49), behind the admission of
// every `/api/*` route (the local token and same origin, or the gateway's
// session and same origin for a write), over the one use case of
// `src/ssh-access/`:
//
//   GET  /api/ssh          the keys of this account and the settings for a
//                          computer
//   POST /api/ssh/add      {device, publicKey, addedBy?}: 200 added or
//                          already present (an agent may simply retry),
//                          400 for what was sent, 409 for the file
//   POST /api/ssh/remove   {fingerprint}: only a key the Launchpad added;
//                          404 unknown, 409 a line added outside Launchpad
//
// The journal names the operation, the outcome and the key's public
// fingerprint, never the key itself.

export const sshRoutePaths = Object.freeze({
  read: "/api/ssh",
  add: "/api/ssh/add",
  remove: "/api/ssh/remove",
});

const fingerprintPattern = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function createSshRoutes(
  input: Readonly<{
    host: () => SshAccessHost | Promise<SshAccessHost>;
    headers: Readonly<Record<string, string>>;
    journal?: (entry: Readonly<Record<string, string>>) => void;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const journal = (entry: Record<string, string>) =>
    input.journal?.({ scope: "ssh-access", ...entry });

  /** One POST body with exactly these keys (and these optional ones). */
  async function body(
    request: Request,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Promise<Record<string, unknown> | Response> {
    if (request.method !== "POST")
      return response({ error: "method-not-allowed" }, 405);
    if (request.headers.get("content-type") !== "application/json")
      return response({ error: "invalid-content-type" }, 415);
    try {
      const value = await readJsonBody(request);
      const present = optional.filter(
        (key) => ownDataValue(value, key) !== undefined,
      );
      return stateFields(value, [...required, ...present]);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return response({ error: "body-too-large" }, 413);
      return response({ error: "invalid-request" }, 400);
    }
  }

  return Object.freeze({
    handles: (path: string) =>
      path === sshRoutePaths.read || path.startsWith(`${sshRoutePaths.read}/`),
    async handle(request: Request, url: URL): Promise<Response> {
      if (url.pathname === sshRoutePaths.read) {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if ([...url.searchParams.keys()].length > 0)
          return response({ error: "invalid-query" }, 400);
        return response(await sshAccessOverview(await input.host()));
      }
      if (url.pathname === sshRoutePaths.add) {
        const value = await body(request, ["device", "publicKey"], ["addedBy"]);
        if (value instanceof Response) return value;
        const answer = await addDevice(await input.host(), {
          device: value.device,
          publicKey: value.publicKey,
          addedBy: value.addedBy,
        });
        if (answer.kind === "blocked") {
          journal({
            operation: "add",
            outcome: "refused",
            reason: answer.reason,
          });
          return response(answer, inputRefusals.has(answer.reason) ? 400 : 409);
        }
        if (answer.key.fingerprint !== null)
          journal({
            operation: "add",
            outcome: answer.outcome,
            fingerprint: answer.key.fingerprint,
          });
        return response(answer);
      }
      if (url.pathname === sshRoutePaths.remove) {
        const value = await body(request, ["fingerprint"]);
        if (value instanceof Response) return value;
        if (
          typeof value.fingerprint !== "string" ||
          !fingerprintPattern.test(value.fingerprint)
        )
          return response({ error: "invalid-fingerprint" }, 400);
        const answer = await removeDevice(
          await input.host(),
          value.fingerprint,
        );
        if (answer.kind === "blocked") {
          journal({
            operation: "remove",
            outcome: "refused",
            reason: answer.reason,
          });
          return response(answer, answer.reason === "not-found" ? 404 : 409);
        }
        journal({
          operation: "remove",
          outcome: "removed",
          fingerprint: answer.key.fingerprint,
        });
        return response(answer);
      }
      return response({ error: "not-found" }, 404);
    },
  });
}
