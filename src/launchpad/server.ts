import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import {
  inspectToolsChange,
  readFolderTools,
  sharedSignInsWarning,
} from "../folder/inspect-tools-change";
import { withFolderOperationLock } from "../folder/lock";
import { inspectOwnedDirectory } from "../folder/owned-directory";
import { allowedPresets } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { enabledTools, stateFields } from "../folder/state";
import { ownDataValue } from "../folder/state-fields";
import { updateProfile, updateTools } from "../folder/update-profile";
import { createApplicationLifecycle } from "../modules/lifecycle";
import { readOrganizationApplications } from "../organizations/read-applications";
import { activatableTools, toolSelection } from "../tools/catalog";
import { curatedTool, type InstallFetch, installTool } from "../tools/install";
import {
  createLoginSessions,
  type LoginEnvironment,
  type LoginState,
} from "../tools/login";
import { type ToolsEnvironment, toolsOverview } from "../tools/overview";
import { qrMatrix, qrSvg } from "../tools/qr";
import { runTool, xdgOf } from "../tools/status";
import { serveHealthSocket } from "./health-socket";
import { type AuthFetcher, createHostedTrust } from "./hosted-trust";
import index from "./index.html";
import { pagePaths } from "./routes";
import {
  checkBundledPage,
  LaunchpadStartRefused,
  readStartState,
} from "./start-check";
import type { UpdatePill } from "./update-pill";

// One local owner. Optional application adapters are trusted composition, never
// HTTP input; the browser cannot supply a filesystem root or executable.
/** Test seam for the hosted admission: the auth-endpoint fetcher and clock. */
export type HostedOptions = Readonly<{
  fetcher?: AuthFetcher;
  now?: () => number;
}>;

// The page itself under each of its routes (`/`, `/settings/tools`, …): the
// same bundled document, which picks the section from the path. No other
// path serves it, and none of them carries or needs the credential.
const pageRoutes = Object.fromEntries(pagePaths.map((path) => [path, index]));

const curatedRoutes = new Set([
  "/api/tools/install",
  "/api/tools/login/start",
  "/api/tools/login/poll",
  "/api/tools/login/cancel",
  "/api/tools/logout",
  "/api/tools/composio/organizations",
  "/api/tools/composio/organization",
]);

// A pending WhatsApp login carries its QR code drawn here as SVG, so the page
// never draws anything from the tool's output.
function withQr(state: LoginState): LoginState & { qrSvg?: string } {
  if (state.kind !== "pending" || state.challenge?.kind !== "qr") return state;
  return { ...state, qrSvg: qrSvg(qrMatrix(state.challenge.payload)) };
}

// The page of this executable on a private unix socket, asked by `operation`
// and closed again: how a start and a candidate's probe learn that the bundle
// serves, without a port and without writing anything but the socket in a
// private temporary directory.
async function privatePage<T>(
  operation: (get: (path: string) => Promise<Response>) => Promise<T>,
  version?: string,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "lazurio-page-"));
  const socket = join(directory, "page.sock");
  const server = Bun.serve({
    unix: socket,
    development: false,
    routes: pageRoutes,
    fetch: (request) =>
      version !== undefined &&
      new URL(request.url).pathname === "/health" &&
      request.method === "GET"
        ? Response.json({ version })
        : new Response("not-found", { status: 404 }),
  });
  try {
    return await operation((path) =>
      fetch(`http://launchpad.invalid${path}`, { unix: socket }),
    );
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

/** The candidate's probe (`self-check --launchpad`, docs/update.md
 * "Activation"): the Launchpad start sequence against the real Folder,
 * read-only — no Folder lock, no real port, no health socket under the base —
 * then the page and its health answered once on a private socket. Throws
 * `LaunchpadStartRefused` for a condition the start would name.
 */
export async function probeLaunchpad(
  folder: string,
  version: string,
): Promise<void> {
  const { entry } = await readStartState(folder, { locked: false });
  const served = await privatePage(async (get) => {
    const health = (await (await get("/health")).json()) as {
      version?: unknown;
    };
    if (health.version !== version)
      throw new Error("The probe did not answer its own health");
    return checkBundledPage(get);
  }, version);
  if (!served) throw new LaunchpadStartRefused("asset-missing", entry);
}

export async function startLaunchpad(
  folder: string,
  applicationAdapters?: Parameters<typeof createApplicationLifecycle>[0],
  discovery?: Readonly<{ organizationDirectory: string }>,
  // The installed Launchpad service of this base (`launchpad --base`): it
  // answers the updater's health question.
  installed?: Readonly<{
    base: string;
    version: string;
    /** The update pill of this installation (docs/update.md "Surfaces"):
     * `GET /api/update/status` and `POST /api/update/apply`. */
    pill?: UpdatePill | undefined;
  }>,
  hostedOptions: HostedOptions = {},
  // Where the tools screen reads its live facts: this process's PATH and
  // home, as `lazurio tools status` does. Trusted composition, never HTTP
  // input.
  toolsEnvironment: ToolsEnvironment = {
    path: process.env.PATH,
    home: process.env.HOME,
    xdg: xdgOf(process.env),
    platform: process.platform,
    run: runTool,
  },
  // Test seams of the curated install and login (decision F19): the
  // official-source fetcher, the architecture and the login timings.
  curatedOptions: Readonly<{
    fetch?: InstallFetch;
    arch?: string;
    login?: Partial<LoginEnvironment>;
  }> = {},
) {
  const pill = installed?.pill;
  const organizationDirectory = discovery?.organizationDirectory;
  if (organizationDirectory !== undefined)
    await inspectOwnedDirectory(organizationDirectory);
  const state = join(folder, ".lazurio");
  // The recorded hosted entry (decision F16) is the only source of hosted
  // mode: the Launchpad serves on the loopback port the gateway proxies to,
  // admission is the gateway's (docs/hosted-entry.md), and there is no
  // fragment token — the browser's session cookie is the credential. A
  // condition this start can name refuses it with `LaunchpadStartRefused`,
  // before anything listens, so the caller can serve Recovery mode instead.
  const { entry } = await readStartState(folder, { locked: true });
  if (!(await privatePage(checkBundledPage)))
    throw new LaunchpadStartRefused("asset-missing", entry);
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
          routes: pageRoutes,
          fetch: () => new Response("not-found", { status: 404 }),
        });
  const token = trust === null ? randomBytes(32).toString("hex") : "";
  const applications = applicationAdapters
    ? createApplicationLifecycle(applicationAdapters)
    : null;
  // The curated logins of this Launchpad (decision F19): in memory, held by
  // the browser that started each one through its session handle, ended on
  // completion, cancel, expiry and shutdown.
  const logins = createLoginSessions({
    ...toolsEnvironment,
    ...curatedOptions.login,
  });
  const installing = new Set<string>();
  let closing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: entry === null ? 0 : entry.listenPort,
    development: false,
    maxRequestBodySize: 16 * 1024,
    ...(trust === null ? { routes: pageRoutes } : {}),
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
            // The catalog tools agents may be told to use, with tier and
            // whether each is on in this Folder (decision F18).
            tools: toolSelection(enabledTools(current.preferences)),
          });
        }
        const revisionOf = (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 1
            ? value
            : null;
        if (url.pathname === "/api/tools/status") {
          // The tools screen (decision F18): the recorded selection and notes
          // joined with the live facts. The version commands never use the
          // network; the sign-in probes, which may, run only when the body
          // asks for them with `signIn: true`.
          const withSignIn = ownDataValue(input, "signIn") !== undefined;
          const value = stateFields(input, withSignIn ? ["signIn"] : []);
          if (withSignIn && typeof value.signIn !== "boolean")
            return response({ error: "invalid-sign-in" }, 400);
          return response(
            await toolsOverview(folder, toolsEnvironment, {
              signIn: value.signIn === true,
            }),
          );
        }
        if (
          url.pathname.startsWith("/api/tools/") &&
          curatedRoutes.has(url.pathname)
        ) {
          // The curated install and login of a `launchpad` tool (decision
          // F19). A name the catalog does not know, or a tool an agent sets
          // up, is refused; nothing here takes a path, PATH or command.
          const withPhone =
            url.pathname === "/api/tools/login/start" &&
            ownDataValue(input, "phone") !== undefined;
          // "Link SSH key" of a signed-in gh (decision F19, addendum
          // 2026-09-28) starts a login session of its own kind.
          const withSshKey =
            url.pathname === "/api/tools/login/start" &&
            ownDataValue(input, "sshKey") !== undefined;
          const fields: Record<string, readonly string[]> = {
            "/api/tools/install": ["tool"],
            "/api/tools/login/start": [
              "tool",
              ...(withPhone ? ["phone"] : []),
              ...(withSshKey ? ["sshKey"] : []),
            ],
            "/api/tools/login/poll": ["tool", "session"],
            "/api/tools/login/cancel": ["tool", "session"],
            "/api/tools/logout": ["tool"],
            "/api/tools/composio/organizations": [],
            "/api/tools/composio/organization": ["id"],
          };
          const value = stateFields(input, fields[url.pathname] ?? []);
          if (url.pathname === "/api/tools/composio/organizations") {
            server.timeout(request, 60);
            return response(await logins.composioOrganizations());
          }
          if (url.pathname === "/api/tools/composio/organization") {
            if (
              typeof value.id !== "string" ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)
            )
              return response({ error: "invalid-organization" }, 400);
            server.timeout(request, 60);
            return response(await logins.selectComposioOrganization(value.id));
          }
          const tool = value.tool;
          if (typeof tool !== "string")
            return response({ error: "invalid-tool" }, 400);
          if (!activatableTools().some((entry) => entry.name === tool))
            return response(
              { kind: "blocked", reason: "tool-unknown", tool },
              409,
            );
          if (curatedTool(tool) === undefined)
            return response(
              { kind: "blocked", reason: "setup-agent", tool },
              409,
            );
          if (url.pathname === "/api/tools/install") {
            if (installing.has(tool))
              return response({ kind: "blocked", reason: "busy", tool }, 409);
            installing.add(tool);
            server.timeout(request, 660);
            try {
              return response(
                await installTool(tool, {
                  ...toolsEnvironment,
                  ...(curatedOptions.fetch
                    ? { fetch: curatedOptions.fetch }
                    : {}),
                  ...(curatedOptions.arch ? { arch: curatedOptions.arch } : {}),
                }),
              );
            } finally {
              installing.delete(tool);
            }
          }
          if (url.pathname === "/api/tools/logout") {
            // gh first removes this Machine's SSH key from the account.
            server.timeout(request, 180);
            return response(await logins.logout(tool));
          }
          if (url.pathname === "/api/tools/login/start") {
            if (
              value.phone !== undefined &&
              (typeof value.phone !== "string" || tool !== "wacli")
            )
              return response({ error: "invalid-phone" }, 400);
            if (
              value.sshKey !== undefined &&
              (value.sshKey !== true ||
                tool !== "gh" ||
                value.phone !== undefined)
            )
              return response({ error: "invalid-ssh-key" }, 400);
            server.timeout(request, 60);
            return response(
              withQr(
                await logins.start(tool, {
                  ...(typeof value.phone === "string"
                    ? { phone: value.phone }
                    : {}),
                  ...(value.sshKey === true ? { sshKey: true } : {}),
                }),
              ),
            );
          }
          const handle = value.session;
          if (typeof handle !== "string" || !/^[0-9a-f]{32}$/.test(handle))
            return response({ error: "invalid-session" }, 400);
          return response(
            url.pathname === "/api/tools/login/poll"
              ? withQr(logins.poll(tool, handle))
              : logins.cancel(tool, handle),
          );
        }
        if (
          ["/api/tools/preview", "/api/tools/update"].includes(url.pathname)
        ) {
          // The full next selection at the expected revision and, optionally,
          // the full next set of the operator's notes, over the same planner
          // and transaction as a profile change.
          const withNotes = ownDataValue(input, "notes") !== undefined;
          const value = stateFields(
            input,
            withNotes
              ? ["expectedRevision", "tools", "notes"]
              : ["expectedRevision", "tools"],
          );
          const expectedRevision = revisionOf(value.expectedRevision);
          if (expectedRevision === null)
            return response({ error: "invalid-revision" }, 400);
          const operation =
            url.pathname === "/api/tools/update"
              ? updateTools
              : inspectToolsChange;
          const recorded = await readFolderTools(folder);
          const result = await operation(
            folder,
            expectedRevision,
            value.tools,
            value.notes,
          );
          return response(
            result.kind === "blocked"
              ? result
              : { ...result, ...sharedSignInsWarning(recorded, value.tools) },
            result.kind === "blocked" ? 409 : 200,
          );
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
        const expectedRevision = revisionOf(value.expectedRevision);
        if (expectedRevision === null)
          return response({ error: "invalid-revision" }, 400);
        const operation =
          url.pathname === "/api/update" ? updateProfile : inspectProfileChange;
        const result = await operation(
          folder,
          expectedRevision,
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
  // The listener above exists: only now is the version reported, and the
  // updater's health poll reads it. There is nothing to commit or undo here:
  // the switch of `bin/lazurio` was the commit (docs/update.md "Activation").
  const health = installed
    ? await serveHealthSocket(installed.base, { version: installed.version })
    : null;
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
          const loginClose = logins.close();
          pill?.stop();
          await server.stop(true);
          await shell?.stop(true);
          if (shellSocket !== null)
            await rm(dirname(shellSocket), { recursive: true, force: true });
          await health?.stop(true);
          await loginClose;
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
