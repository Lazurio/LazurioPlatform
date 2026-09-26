import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { allowedPresets } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { stateFields } from "../folder/state";
import { ownDataValue } from "../folder/state-fields";
import { updateProfile } from "../folder/update-profile";
import { createApplicationLifecycle } from "../modules/lifecycle";
import { readOrganizationApplications } from "../organizations/read-applications";
import { reconcileAsLaunchpad } from "../update/activation";
import { layout } from "../update/layout";
import { launchpadHealth } from "../update/service-control";
import { type AuthFetcher, createHostedTrust } from "./hosted-trust";
import index from "./index.html";
import type { UpdatePill } from "./update-pill";

export const launchpadCommitDelayMs = 15_000;

// The installed service's health question (docs/update.md "Activation"): which
// version is running. A Unix socket under the install base, so only this user
// can ask and the updater needs no port or session token to find it. It states
// the version and nothing else.
async function serveHealth(base: string, version: string) {
  const path = layout(base).healthSocket;
  // A socket file outlives a killed Launchpad; one that still answers is a live
  // Launchpad of this base, and there is only ever one.
  if ((await launchpadHealth(base)) !== null)
    throw new Error("Another Launchpad serves this install base");
  await rm(path, { force: true });
  return Bun.serve({
    unix: path,
    fetch: (request) =>
      new URL(request.url).pathname === "/health" && request.method === "GET"
        ? Response.json({ version })
        : new Response(null, { status: 404 }),
  });
}

// One local owner. Optional application adapters are trusted composition, never
// HTTP input; the browser cannot supply a filesystem root or executable.
/** Test seam for the hosted admission: the auth-endpoint fetcher and clock. */
export type HostedOptions = Readonly<{
  fetcher?: AuthFetcher;
  now?: () => number;
}>;

export async function startLaunchpad(
  folder: string,
  applicationAdapters?: Parameters<typeof createApplicationLifecycle>[0],
  discovery?: Readonly<{ organizationDirectory: string }>,
  // The installed Launchpad service of this base (`launchpad --base`): it
  // answers the updater's health question and commits an activation whose
  // updater is gone.
  installed?: Readonly<{
    base: string;
    version: string;
    commitDelayMs?: number;
    /** The update pill of this installation (docs/update.md "Surfaces"):
     * `GET /api/update/status` and `POST /api/update/apply`. */
    pill?: UpdatePill | undefined;
  }>,
  hostedOptions: HostedOptions = {},
) {
  const pill = installed?.pill;
  const organizationDirectory = discovery?.organizationDirectory;
  if (organizationDirectory !== undefined)
    await inspectOwnedDirectory(organizationDirectory);
  await inspectOwnedDirectory(folder);
  const state = join(folder, ".lazurio");
  const initial = await withFolderOperationLock(state, () =>
    readFolderState(state),
  );
  // The recorded hosted entry (decision F16) is the only source of hosted
  // mode: the Launchpad serves on the loopback port the gateway proxies to,
  // admission is the gateway's (docs/hosted-entry.md), and there is no
  // fragment token — the browser's session cookie is the credential.
  const entry = initial.preferences.machine?.entry ?? null;
  const trust = entry === null ? null : createHostedTrust(entry, hostedOptions);
  // The bundled page is served by an inner listener and proxied only after
  // admission, so nothing of the Launchpad answers an unadmitted browser — not
  // even its shell. The inner listener is a private unix socket: no ambient
  // HTTP proxy of the process environment (HTTP_PROXY, ALL_PROXY) can stand in
  // for it, and nothing else on the Machine can reach it by port.
  const shellSocket =
    trust === null
      ? null
      : join(await mkdtemp(join(tmpdir(), "lazurio-shell-")), "shell.sock");
  const shell =
    shellSocket === null
      ? null
      : Bun.serve({
          unix: shellSocket,
          development: false,
          routes: { "/": index },
          fetch: () => new Response("not-found", { status: 404 }),
        });
  const token = trust === null ? randomBytes(32).toString("hex") : "";
  const applications = applicationAdapters
    ? createApplicationLifecycle(applicationAdapters)
    : null;
  let closing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: entry === null ? 0 : entry.listenPort,
    development: false,
    maxRequestBodySize: 16 * 1024,
    ...(trust === null ? { routes: { "/": index } } : {}),
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
      if (trust !== null && shellSocket !== null) {
        // Hosted: the gateway's admission, revalidated here; the request's
        // own URL is loopback and is not evidence of anything.
        const admission = await trust.admit(request);
        if (!admission.ok)
          return response({ error: "denied", reason: admission.reason }, 401);
        if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
          const page = await fetch(
            `http://shell.invalid${url.pathname}${url.search}`,
            {
              unix: shellSocket,
              headers: { accept: request.headers.get("accept") ?? "*/*" },
            },
          );
          return new Response(page.body, {
            status: page.status,
            headers: {
              ...headers,
              "Content-Type":
                page.headers.get("content-type") ?? "application/octet-stream",
            },
          });
        }
      } else {
        // Local: a browser sends no Origin header with a same-origin GET. The
        // bearer token is the credential; the one GET route is read-only.
        const sameOrigin =
          request.headers.get("origin") === origin ||
          (request.method === "GET" && !request.headers.has("origin"));
        if (
          url.origin !== origin ||
          request.headers.get("host") !== new URL(origin).host ||
          !sameOrigin ||
          request.headers.get("authorization") !== `Bearer ${token}`
        )
          return response({ error: "denied" }, 403);
      }
      if (request.method === "GET" && url.pathname === "/api/update/status") {
        if (closing) return response({ error: "closing" }, 503);
        if (!pill) return response({ error: "update-unavailable" }, 503);
        try {
          return response(await pill.status());
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      try {
        const input: unknown = await request.json();
        if (closing) return response({ error: "closing" }, 503);
        if (url.pathname === "/api/update/apply") {
          if (!pill) return response({ error: "update-unavailable" }, 503);
          const value = stateFields(input, ["version"]);
          if (typeof value.version !== "string")
            return response({ error: "invalid-version" }, 400);
          const result = await pill.apply(value.version);
          return response(result, result.kind === "started" ? 200 : 409);
        }
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
          // The preset and the communication axes are changeable; the Machine
          // binding is shown and never accepted back from the browser.
          return response({
            revision: current.preferences.revision,
            preset: current.preferences.preset,
            allowedPresets: allowedPresets(current.preferences.machine),
            machine: current.preferences.machine,
            profile: current.preferences.profile,
          });
        }
        if (!["/api/preview", "/api/update"].includes(url.pathname))
          return response({ error: "not-found" }, 404);
        const withPreset = ownDataValue(input, "preset") !== undefined;
        const value = stateFields(
          input,
          withPreset
            ? ["expectedRevision", "preset", "profile"]
            : ["expectedRevision", "profile"],
        );
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
          withPreset
            ? { preset: value.preset, profile: value.profile }
            : { profile: value.profile },
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
  // The listener above exists: only now is the version reported, and a live
  // updater commits on that. An activation whose updater is gone is committed
  // by this instance itself — but only once it has stayed up longer than the
  // unit's start limit could still undo it (5 starts in 60 s: a version that
  // dies sooner must reach `OnFailure=lazurio-rollback.service` uncommitted).
  // A failure to reconcile never costs the Launchpad its start.
  const health = installed
    ? await serveHealth(installed.base, installed.version)
    : null;
  const reconcile = installed
    ? setTimeout(
        () => void reconcileAsLaunchpad(installed).catch(() => undefined),
        installed.commitDelayMs ?? launchpadCommitDelayMs,
      )
    : undefined;
  pill?.start();
  let closePending: ReturnType<
    ReturnType<typeof createApplicationLifecycle>["close"]
  > | null = null;
  return {
    server,
    url:
      entry === null
        ? `${server.url.href}#${token}`
        : `${entry.externalOrigin}/`,
    hosted: entry !== null,
    close() {
      closing = true;
      if (!closePending)
        closePending = (async () => {
          // Close admission immediately, before waiting for HTTP requests to drain.
          // Existing requests and shutdown must share the same lifecycle queue.
          const applicationClose = applications?.close();
          clearTimeout(reconcile);
          pill?.stop();
          await server.stop(true);
          await shell?.stop(true);
          if (shellSocket !== null)
            await rm(dirname(shellSocket), { recursive: true, force: true });
          await health?.stop(true);
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
