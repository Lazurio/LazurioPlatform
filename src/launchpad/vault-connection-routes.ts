import { stateFields } from "../folder/state-fields";
import {
  type ConnectionRefusal,
  connectionFields,
  connectPersonalBitwarden,
  disconnectPersonalBitwarden,
} from "../vault/connection";
import { type VaultHost, type VaultPhase, vaultStatus } from "../vault/flow";
import { BodyTooLarge, readJsonBody } from "./json-body";
import type { VaultAnswer } from "./vault-routes";

// A personal Environment connects its person's own Bitwarden in Settings →
// Vault (root decision 0203 point 7, plan DEV-6631 task 775), behind the
// admission of every `/api/*` route (locally the token and same origin,
// behind the gateway its session and same origin for a write):
//
//   POST /api/vault/connect     {region, clientId, clientSecret,
//                               masterPassword, email}: exactly these keys,
//                               JSON of at most 16 KiB; the agents' account
//                               is checked and kept (src/vault/connection.ts)
//                               and the one setup starts, answered as the
//                               Tools row's setup answers: 202 {kind:
//                               "vault-setting-up", job, phase} while it
//                               runs, then the status
//   POST /api/vault/disconnect  {}: the account forgotten, the organization
//                               kept; 200 the status
//
// The values go from the body to the core and nowhere else: no answer,
// journal line or error holds one. Refusals are `{kind: "blocked",
// reason}`: 400 for values that are not the form's, 409 what the person or
// the cloud must change, 503 the cloud or the vault busy or not answering.

export const vaultConnectionPaths = Object.freeze({
  connect: "/api/vault/connect",
  disconnect: "/api/vault/disconnect",
});

const inputRefusals: ReadonlySet<ConnectionRefusal> = new Set([
  "region-invalid",
  "client-id-invalid",
  "client-secret-invalid",
  "password-invalid",
  "email-invalid",
]);
const transientRefusals: ReadonlySet<ConnectionRefusal> = new Set([
  "rate-limited",
  "unreachable",
  "busy",
]);

export function createVaultConnectionRoutes(
  input: Readonly<{
    host: () => VaultHost;
    /** Starts the one setup, or joins the one that runs (vault-routes.ts). */
    setup: () => Promise<VaultAnswer>;
    /** The step of the setup that runs now, or null. */
    running: () => VaultPhase | null;
    headers: Readonly<Record<string, string>>;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const blocked = (reason: ConnectionRefusal | "setting-up") =>
    response(
      { kind: "blocked", reason },
      reason === "setting-up"
        ? 409
        : inputRefusals.has(reason as ConnectionRefusal)
          ? 400
          : transientRefusals.has(reason as ConnectionRefusal)
            ? 503
            : 409,
    );

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
      path === vaultConnectionPaths.connect ||
      path === vaultConnectionPaths.disconnect,
    async handle(request: Request, url: URL): Promise<Response> {
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if ([...url.searchParams.keys()].length > 0)
        return response({ error: "invalid-query" }, 400);
      if (url.pathname === vaultConnectionPaths.connect) {
        const values = await body(request, connectionFields);
        if (values instanceof Response) return values;
        const connected = await connectPersonalBitwarden(input.host(), {
          region: values.region,
          clientId: values.clientId,
          clientSecret: values.clientSecret,
          masterPassword: values.masterPassword,
          email: values.email,
        });
        if (connected.kind !== "vault-connected")
          return blocked(connected.reason);
        // The Environment creates its vault and invites the person now, in
        // the one setup the Tools row and the start share.
        const started = await input.setup();
        return response(started.body, started.status);
      }
      const empty = await body(request, []);
      if (empty instanceof Response) return empty;
      // A setup that runs holds the account; it ends first.
      if (input.running() !== null) return blocked("setting-up");
      const host = input.host();
      const disconnected = await disconnectPersonalBitwarden(host);
      if (disconnected.kind !== "vault-disconnected")
        return blocked(disconnected.reason);
      return response(await vaultStatus(host));
    },
  });
}
