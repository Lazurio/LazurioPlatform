import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { readFolderState } from "../folder/read-state";
import { stateFields } from "../folder/state";
import { updateProfile } from "../folder/update-profile";
import { createApplicationLifecycle } from "../modules/lifecycle";
import { readOrganizationApplications } from "../organizations/read-applications";
import index from "./index.html";

// One local owner. Optional application adapters are trusted composition, never
// HTTP input; the browser cannot supply a filesystem root or executable.
export async function startLaunchpad(
  folder: string,
  applicationAdapters?: Parameters<typeof createApplicationLifecycle>[0],
  discovery?: Readonly<{ organizationDirectory: string }>,
) {
  const organizationDirectory = discovery?.organizationDirectory;
  if (organizationDirectory !== undefined)
    await inspectOwnedDirectory(organizationDirectory);
  await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  await withFolderOperationLock(state, () => readFolderState(state));
  const token = randomBytes(32).toString("hex");
  const applications = applicationAdapters
    ? createApplicationLifecycle(applicationAdapters)
    : null;
  let closing = false;
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
        if (closing) return response({ error: "closing" }, 503);
        if (url.pathname === "/api/apps/discover") {
          stateFields(input, []);
          if (!organizationDirectory)
            return response({ error: "discovery-unavailable" }, 503);
          return response(
            await readOrganizationApplications(organizationDirectory),
          );
        }
        if (url.pathname.startsWith("/api/apps/")) {
          if (!applications)
            return response({ error: "applications-unavailable" }, 503);
          const operations = {
            "/api/apps/prepare": applications.prepare,
            "/api/apps/clean-prepare": (input: unknown) =>
              applications.prepare(input, "clean-prepare"),
            "/api/apps/start": applications.start,
            "/api/apps/status": applications.status,
            "/api/apps/open": applications.entrypoint,
            "/api/apps/stop": applications.stop,
          };
          if (!Object.hasOwn(operations, url.pathname))
            return response({ error: "not-found" }, 404);
          const operation = operations[url.pathname as keyof typeof operations];
          // Only an authenticated, fully-read preparation request gets the
          // longer wait. Keep the normal idle deadline on request admission.
          if (
            ["/api/apps/prepare", "/api/apps/clean-prepare"].includes(
              url.pathname,
            )
          )
            server.timeout(request, 660);
          return response(await operation(input));
        }
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
  let closePending: ReturnType<
    ReturnType<typeof createApplicationLifecycle>["close"]
  > | null = null;
  return {
    server,
    url: `${server.url.href}#${token}`,
    close() {
      closing = true;
      if (!closePending)
        closePending = (async () => {
          // Close admission immediately, before waiting for HTTP requests to drain.
          // Existing requests and shutdown must share the same lifecycle queue.
          const applicationClose = applications?.close();
          await server.stop(true);
          const result = applicationClose
            ? await applicationClose
            : Object.freeze({ kind: "closed" as const });
          return result;
        })().finally(() => {
          closePending = null;
        });
      return closePending;
    },
  };
}
