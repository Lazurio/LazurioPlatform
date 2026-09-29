import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import {
  inspectToolsChange,
  readFolderTools,
  sharedSignInsWarning,
} from "../folder/inspect-tools-change";
import { withFolderReadLock } from "../folder/lock";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { allowedPresets } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import { enabledTools, stateFields } from "../folder/state";
import { ownDataValue } from "../folder/state-fields";
import { updateProfile, updateTools } from "../folder/update-profile";
import { createApplicationLifecycle } from "../modules/lifecycle";
import {
  createModuleOperations,
  type ModuleAnswer,
  type ModuleBlocked,
  type ModuleHost,
  processModuleHost,
} from "../modules/module-operations";
import { readFolderCatalog } from "../organizations/catalog";
import { readOrganizationApplications } from "../organizations/read-applications";
import type { RecoveryResult } from "../recover/recover";
import { activatableTools, toolSelection } from "../tools/catalog";
import {
  folderPreset,
  githubLoginRefused,
  githubRefusal,
} from "../tools/github-gate";
import { curatedTool, type InstallFetch, installTool } from "../tools/install";
import {
  createLoginSessions,
  type LoginEnvironment,
  type LoginState,
} from "../tools/login";
import {
  type ToolsEnvironment,
  toolsEnvironmentOf,
  toolsOverview,
} from "../tools/overview";
import { qrMatrix, qrSvg } from "../tools/qr";
import type { GithubAction } from "../tools/team-github";
import { issueChatLink, publicEntry } from "./chat";
import { serveHealthSocket } from "./health-socket";
import { type AuthFetcher, createHostedTrust } from "./hosted-trust";
import { admitLocal, pageRoutes, privatePage, serveShell } from "./page";
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
  /** How long the gateway's `ensure` waits for a started app to report
   * healthy (default `ensureWaitMsDefault`). */
  ensureWaitMs?: number;
}>;

// The module lifecycle routes (launchpad-parity B3): `<org>` and `<module>`
// are URL-encoded segments naming the module as `lazurio module` does.
const moduleRoute = /^\/api\/modules\/([^/]+)\/([^/]+)\/(start|stop|status)$/;

// The gateway's `ensure` (launchpad-parity B5), the path the Machines gateway
// rewrites a module hostname's readiness subrequest to
// (`M:workloads/workspace-vm/ingress.ts:129`) and the resident served
// (`R:launchpad/src/server.mjs:1377`); `<id>` is the exact lazurio.module.v1
// id of the gateway catalog (`M:workloads/workspace-vm/gateway-catalog.py:235`).
const ensureRoute = /^\/api\/internal\/hosted\/modules\/([^/]+)\/ensure$/;

/** Whether a gateway `ensure` may start a stopped app: a signed-in top-level
 * navigation (Fetch Metadata `navigate`, or none) is an Open; a background
 * fetch or a WebSocket reconnect only reports. The resident's rule
 * (`R:launchpad/src/hosted-readiness-lib.mjs:4-8`); the gateway keeps the
 * browser's Fetch Metadata on the subrequest
 * (`M:workloads/workspace-vm/ingress.ts:118-123`). A lifecycle hint after
 * admission, never an access decision. */
export function ensureMayStart(headers: Headers): boolean {
  if (headers.has("sec-websocket-key")) return false;
  const mode = headers.get("sec-fetch-mode");
  return mode === null || mode === "navigate";
}

/** The status of an `ensure` answer, the only part of it the gateway reads
 * (`M:workloads/workspace-vm/ingress.ts:139-157`): 204 continues to the app,
 * 503 shows "starting" and reloads, 404 shows "not available here", anything
 * else (409 here) shows "could not be prepared". */
export function ensureStatus(result: ModuleAnswer | ModuleBlocked): number {
  if (result.kind === "module") return result.healthy ? 204 : 503;
  if (["closing", "coordination-busy"].includes(result.reason)) return 503;
  if (result.reason === "module-ambiguous") return 409;
  // The id names no single runnable default app of this Folder.
  if (result.operation === "ensure") return 404;
  // The lifecycle refused the status read or the start.
  return 409;
}

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
  toolsEnvironment: ToolsEnvironment = toolsEnvironmentOf(
    process.env,
    process.platform,
  ),
  // Test seams of the curated install and login (decision F19): the
  // official-source fetcher, the architecture and the login timings.
  curatedOptions: Readonly<{
    fetch?: InstallFetch;
    arch?: string;
    login?: Partial<LoginEnvironment>;
  }> = {},
  // The recovery use case of this installation (`lazurio recover`), for the
  // read-only Recovery view of Settings. Trusted composition, never HTTP
  // input.
  recovery?: (() => Promise<RecoveryResult>) | undefined,
  // Where the module lifecycle runs: this process's account, its standard
  // Bun and the runner of this platform. Trusted composition, never HTTP
  // input; tests supply a fake service manager.
  moduleHost: ModuleHost = processModuleHost(),
) {
  const pill = installed?.pill;
  const organizationDirectory = discovery?.organizationDirectory;
  if (organizationDirectory !== undefined)
    await inspectCheckoutDirectory(organizationDirectory);
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
  // even its shell.
  const shell = trust === null ? null : await serveShell();
  const token = trust === null ? randomBytes(32).toString("hex") : "";
  const applications = applicationAdapters
    ? createApplicationLifecycle(applicationAdapters)
    : null;
  // The module lifecycle of the catalog: the same core as `lazurio module`.
  // This Launchpad holds one lifecycle per Organization, so a session app
  // (macOS) is its child and ends with it; a service app outlives it.
  const modules = createModuleOperations({
    folder,
    owner: "launchpad",
    host: moduleHost,
  });
  // The curated logins of this Launchpad (decision F19): in memory, held by
  // the browser that started each one through its session handle, ended on
  // completion, cancel, expiry and shutdown.
  // A running gh session asks the Team rule again, on this Folder's current
  // preset, before every step that changes the account or the Machine
  // (Principal 2026-09-28).
  const logins = createLoginSessions({
    ...toolsEnvironment,
    ...curatedOptions.login,
    refused: async (tool, action) =>
      githubLoginRefused(await folderPreset(folder), tool, action),
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
      if (trust !== null && shell !== null) {
        // Hosted: the gateway's admission, revalidated here; the request's
        // own URL is loopback and is not evidence of anything.
        const admission = await trust.admit(request);
        if (!admission.ok)
          return response({ error: "denied", reason: admission.reason }, 401);
        if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
          const page = await shell.get(
            `${url.pathname}${url.search}`,
            request.headers.get("accept"),
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
      } else if (!admitLocal(request, origin, token))
        return response({ error: "denied" }, 403);
      if (request.method === "GET" && url.pathname === "/api/recovery") {
        // The Recovery view of Settings: the same read-only use case and
        // result as `lazurio recover --json` (docs/recovery.md).
        if (closing) return response({ error: "closing" }, 503);
        if (!recovery) return response({ error: "recovery-unavailable" }, 503);
        try {
          return response(await recovery());
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
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
      if (url.pathname === "/api/entry") {
        // The recorded entry's public parts, read-only (launchpad-parity B8):
        // the page links to these origins and composes none. `null` on a
        // workstation, which has no entry.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        return response({ kind: "entry", entry: publicEntry(entry) });
      }
      const ensureRequest = ensureRoute.exec(url.pathname);
      if (ensureRequest !== null) {
        // Only behind a gateway: a workstation has no module hostnames.
        if (trust === null) return response({ error: "not-found" }, 404);
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        let id: string;
        try {
          id = decodeURIComponent(ensureRequest[1] as string);
        } catch {
          id = "";
        }
        // The wait for health is bounded below the request's idle deadline.
        server.timeout(request, 30);
        try {
          const result = await modules.ensure(id, {
            mayStart: ensureMayStart(request.headers),
            ...(hostedOptions.ensureWaitMs === undefined
              ? {}
              : { waitMs: hostedOptions.ensureWaitMs }),
          });
          const status = ensureStatus(result);
          return status === 204
            ? new Response(null, { status, headers })
            : response(result, status);
        } catch {
          return response({ error: "operation-failed" }, 503);
        }
      }
      const moduleRequest = moduleRoute.exec(url.pathname);
      if (moduleRequest !== null) {
        if (request.method !== (moduleRequest[3] === "status" ? "GET" : "POST"))
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        let name: string;
        let app: string | undefined;
        try {
          name = `${decodeURIComponent(moduleRequest[1] as string)}/${decodeURIComponent(moduleRequest[2] as string)}`;
          if (moduleRequest[3] === "status") {
            const keys = [...url.searchParams.keys()];
            if (keys.some((key) => key !== "app") || keys.length > 1)
              return response({ error: "invalid-query" }, 400);
            app = url.searchParams.get("app") ?? undefined;
          } else {
            if (request.headers.get("content-type") !== "application/json")
              return response({ error: "invalid-content-type" }, 415);
            const input: unknown = await request.json();
            const withApp = ownDataValue(input, "app") !== undefined;
            const value = stateFields(input, withApp ? ["app"] : []);
            if (withApp && typeof value.app !== "string")
              return response({ error: "invalid-app" }, 400);
            app = value.app as string | undefined;
          }
        } catch {
          return response({ error: "invalid-request" }, 400);
        }
        const options = app === undefined ? {} : { app };
        try {
          // A start runs the module's declared check first (bounded by
          // the preparation budget); the request waits for it.
          if (moduleRequest[3] === "start") server.timeout(request, 660);
          const result =
            moduleRequest[3] === "start"
              ? await modules.start(name, options)
              : moduleRequest[3] === "stop"
                ? await modules.stop(name, options)
                : await modules.status(name, options);
          return response(result, result.kind === "blocked" ? 409 : 200);
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
        if (url.pathname === "/api/chat/pair") {
          // Chat (launchpad-parity B8): a one-time T3 Code pairing link for
          // this admitted browser, minted by T3's own CLI. Only behind a
          // gateway: a workstation's T3 Code is wherever the operator runs it.
          stateFields(input, []);
          if (entry === null) return response({ error: "not-found" }, 404);
          server.timeout(request, 30);
          const result = await issueChatLink(entry, toolsEnvironment);
          return response(result, result.kind === "blocked" ? 409 : 200);
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
        if (url.pathname === "/api/catalog") {
          // The Launchpad home (launchpad-parity B1): the Organizations and
          // modules of this Folder, the same catalog as `lazurio organization
          // list --json`, recomputed on every read. Nothing is written.
          stateFields(input, []);
          return response(await readFolderCatalog(folder));
        }
        if (url.pathname === "/api/profile") {
          stateFields(input, []);
          const current = await withFolderReadLock(state, () =>
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
          // gh on a Team Environment (Principal 2026-09-28): no person's
          // sign-in or SSH key; a sign-out only of a person's account left
          // there. The preset is read per request: a profile change may
          // switch it while the Launchpad runs.
          const teamRefusal = async (action: GithubAction) =>
            tool === "gh"
              ? githubRefusal(await folderPreset(folder), tool, action, logins)
              : undefined;
          if (url.pathname === "/api/tools/logout") {
            // gh first removes this Machine's SSH key from the account.
            server.timeout(request, 180);
            const refusal = await teamRefusal("logout");
            if (refusal !== undefined) return response(refusal, 409);
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
            const refusal = await teamRefusal(
              value.sshKey === true ? "ssh-key" : "login",
            );
            if (refusal !== undefined) return response(refusal, 409);
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
          // A gh login cannot go on there either; cancelling one always can.
          if (url.pathname === "/api/tools/login/poll") {
            const refusal = await teamRefusal("login");
            if (refusal !== undefined) {
              // The session ends as refused; its holder reads that refusal
              // (with the session's own action), or the generic one.
              logins.refuse(tool);
              const ended = logins.poll(tool, handle);
              return response(ended.kind === "blocked" ? ended : refusal, 409);
            }
          }
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
        // A profile change that makes this a Team Environment ends a running
        // gh sign-in or key linking at once: its holder reads the refusal.
        if (url.pathname === "/api/update" && result.kind === "updated") {
          const preset = await folderPreset(folder).catch(() => undefined);
          if (preset === undefined || githubLoginRefused(preset, "gh", "login"))
            logins.refuse("gh");
        }
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
          const moduleClose = modules.close();
          const loginClose = logins.close();
          pill?.stop();
          await server.stop(true);
          await shell?.stop();
          await health?.stop(true);
          await loginClose;
          const result = applicationClose
            ? await applicationClose
            : Object.freeze({ kind: "closed" as const });
          // Session apps of the catalog end with this Launchpad.
          return (await moduleClose).kind === "closed"
            ? result
            : Object.freeze({ kind: "incomplete" as const });
        })().finally(() => {
          closePending = null;
        });
      return closePending;
    },
  };
}
