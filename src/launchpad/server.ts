import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import { stateFields } from "../folder/state";
import { updateProfile } from "../folder/update-profile";
import index from "./index.html";

// Local development profile consumer, not a remote admin service or app supervisor.
export async function startLaunchpad(folder: string) {
  await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  await withFolderOperationLock(state, () => readFolderState(state));
  const token = randomBytes(32).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    maxRequestBodySize: 16 * 1024,
    routes: { "/": index },
    async fetch(request, server) {
      const origin = `http://127.0.0.1:${server.port}`;
      const url = new URL(request.url);
      const headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      };
      const response = (body: unknown, status = 200) =>
        Response.json(body, { status, headers });
      if (
        url.origin !== origin ||
        request.headers.get("host") !== new URL(origin).host ||
        request.headers.get("origin") !== origin ||
        request.headers.get("authorization") !== `Bearer ${token}`
      )
        return response({ error: "denied" }, 403);
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      try {
        const input: unknown = await request.json();
        if (url.pathname === "/api/profile") {
          stateFields(input, []);
          const current = await withFolderOperationLock(state, () =>
            readFolderState(state),
          );
          return response({
            revision: current.preferences.revision,
            profile: current.preferences.profile,
          });
        }
        if (!["/api/preview", "/api/update"].includes(url.pathname))
          return response({ error: "not-found" }, 404);
        const value = stateFields(input, ["expectedRevision", "profile"]);
        if (
          typeof value.expectedRevision !== "number" ||
          !Number.isSafeInteger(value.expectedRevision) ||
          value.expectedRevision < 1
        )
          return response({ error: "invalid-revision" }, 400);
        const operation =
          url.pathname === "/api/update" ? updateProfile : inspectProfileChange;
        const result = await operation(
          folder,
          value.expectedRevision,
          value.profile,
        );
        return response(result, result.kind === "blocked" ? 409 : 200);
      } catch {
        return response(
          { error: "operation-failed", recoveryMayBeRequired: true },
          400,
        );
      }
    },
  });
  return { server, url: `${server.url.href}#${token}` };
}
