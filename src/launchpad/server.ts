import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type BrowserViewSeams,
  browserEntryOf,
  isBrowserSession,
  resolveBrowserView,
} from "../browser/view";
import {
  type ContentHost,
  preparationAnswer,
  processContentHost,
} from "../content/host";
import { type DocumentsHost, processDocumentsHost } from "../files/documents";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import {
  inspectToolsChange,
  readFolderTools,
  sharedSignInsWarning,
} from "../folder/inspect-tools-change";
import { withFolderReadLock } from "../folder/lock";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { selectablePresets } from "../folder/presets";
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
  moduleAnswerWithinMsDefault,
  processModuleHost,
} from "../modules/module-operations";
import { readFolderCatalog } from "../organizations/catalog";
import { selectCatalogOrganization } from "../organizations/catalog-selection";
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
import { runProcess } from "../update/self-check";
import { createChatPromptCheck, issueChatLink, publicEntry } from "./chat";
import { createContentRoutes } from "./content-routes";
import { prepareContext } from "./content-view";
import { createFilesRoutes, maxRequestBytes } from "./files-routes";
import { signsInAsPerson } from "./first-run";
import { serveHealthSocket } from "./health-socket";
import { type AuthFetcher, createHostedTrust } from "./hosted-trust";
import { BodyTooLarge, readJsonBody } from "./json-body";
import { issueMausbotLink } from "./mausbot";
import { messages } from "./messages";
import { createMaintainerCheck } from "./module-maintainer";
import { createOwnerCheck } from "./organization-owner";
import { admitLocal, pageRoutes, privatePage, serveShell } from "./page";
import {
  isOrganizationPrompt,
  isPromptId,
  prepareContentDocument,
  promptAudience,
  promptDocument,
  promptOrganization,
} from "./prompts";
import {
  type ContentReader,
  createGithubProbe,
  readContent,
  shellSetup,
} from "./setup-state";
import { shellDocument } from "./shell-document";
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
  /** How long the module routes wait for a start or a preparation before
   * they answer that it is still running (default
   * `moduleAnswerWithinMsDefault`, decision F34); also on a workstation. */
  moduleAnswerWithinMs?: number;
}>;

/** The Lazurio shell's data document (decision F36). */
export const shellDocumentPath = "/.lazurio/shell.json";

// Whether this Environment's GitHub identity is an Owner of an Organization
// (decision F36 addendum of 2026-10-04): `<org>` names it as the catalog's
// routes do.
const ownerRoute = /^\/api\/organizations\/([^/]+)\/owner$/;

// Whether it may maintain one module's repository (decision 0185 S15, the
// Steward's "Přístup k modulu"): `<org>` as above, `<module>` its id.
const maintainRoute =
  /^\/api\/organizations\/([^/]+)\/modules\/([^/]+)\/maintain$/;

/** A prepared prompt for Chat (`GET /.lazurio/prompts/<id>?org=<login>`,
 * Lazurio/t3code#35), in the gateway's segment grammar. */
const promptRoute = /^\/\.lazurio\/prompts\/([A-Za-z0-9._-]+)$/;

/** The Environment browser's view (decision F38): the JSON answer the panels
 * of the Launchpad and of T3 Code read, and the hand-over a link opens. Both
 * under `/.lazurio/`, so the gateway forwards them from the forks' origins
 * too. */
export const browserViewDocumentPath = "/.lazurio/browser.json";
export const browserViewPath = "/.lazurio/browser";

/** The Launchpad's own data under `/.lazurio/`, answered after admission
 * like every read; every other path there is the page's static asset. */
const isLazurioDocument = (path: string) =>
  path === shellDocumentPath ||
  path === browserViewDocumentPath ||
  path === browserViewPath ||
  promptRoute.test(path);

// The module lifecycle routes (launchpad-parity B3): `<org>` and `<module>`
// are URL-encoded segments naming the module as `lazurio module` does.
const moduleRoute =
  /^\/api\/modules\/([^/]+)\/([^/]+)\/(start|prepare|stop|status)$/;

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
  // Whose Documents folder the Files page serves (decision F35): this
  // process's account. Trusted composition, never HTTP input; tests supply
  // a temporary home.
  documentsHost: DocumentsHost = processDocumentsHost(folder),
  // Where content installation runs (decision F9, addendum of 2026-10-04):
  // this Environment's gh and git, the install base's content lock and the
  // module core's preparation. Trusted composition, never HTTP input; tests
  // supply a stub GitHub and local repositories.
  contentHost?: ContentHost | undefined,
  // What the shell document's `setup` and the prompt `prepare-content` read
  // about the content (root decision 0188, setup-state.ts): the content
  // routes below, unless tests supply a stub.
  contentReader?: ContentReader | undefined,
  // Where the Environment browser's view is asked (decision F38): this
  // account's agent-browser and the dashboard on loopback. Trusted
  // composition, never HTTP input; tests supply stubs.
  browserViewSeams: BrowserViewSeams = Object.freeze({
    run: runProcess,
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    env: process.env,
  }),
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
  // (Matěj 2026-09-28).
  // The start and the end of each sign-in go to this process's journal (the
  // unit's journal on a Machine): the tool and the outcome, nothing else.
  const logins = createLoginSessions({
    ...toolsEnvironment,
    journal: (entry) =>
      console.log(JSON.stringify({ scope: "tools-login", ...entry })),
    ...curatedOptions.login,
    refused: async (tool, action) =>
      githubLoginRefused(await folderPreset(folder), tool, action),
  });
  const installing = new Set<string>();
  const owners = createOwnerCheck(toolsEnvironment);
  const maintainers = createMaintainerCheck(toolsEnvironment);
  const chatPrompts = createChatPromptCheck(toolsEnvironment);
  // What this Environment still lacks (root decision 0188), for the shell
  // document's `setup` and the prompt `prepare-content`: GitHub's sign-in of
  // its person, kept a minute, and its content as the content routes report
  // it (below).
  const github = createGithubProbe(toolsEnvironment);
  let closing = false;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  // The Files page (decision F35): the Operator's Documents folder.
  const files = createFilesRoutes({ host: documentsHost, headers });
  // Content installation: one job at a time per Folder, over the same core
  // as `lazurio organization install` and `lazurio personalspace install`.
  const content = createContentRoutes({
    folder,
    headers,
    host: () =>
      contentHost ??
      processContentHost({
        env: process.env,
        platform: toolsEnvironment.platform,
        tools: toolsEnvironment,
        base: installed?.base,
        prepare: async (name) => preparationAnswer(await modules.prepare(name)),
      }),
  });
  const contentState: ContentReader = contentReader ?? content;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: entry === null ? 0 : entry.listenPort,
    development: false,
    // Uploads stream to disk, so bodies may be large; every JSON route reads
    // its body through `readJsonBody`, bounded at 16 KiB.
    maxRequestBodySize: maxRequestBytes,
    ...(trust === null ? { routes: pageRoutes } : {}),
    async fetch(request, server) {
      const origin = `http://127.0.0.1:${server.port}`;
      const url = new URL(request.url);
      const response = (body: unknown, status = 200) =>
        Response.json(body, { status, headers });
      if (trust !== null && shell !== null) {
        // Hosted: the gateway's admission, revalidated here; the request's
        // own URL is loopback and is not evidence of anything.
        const admission = await trust.admit(request);
        if (!admission.ok)
          return response({ error: "denied", reason: admission.reason }, 401);
        if (
          (request.method === "GET" || request.method === "HEAD") &&
          (url.pathname === "/files" || url.pathname.startsWith("/files/"))
        ) {
          // A Files link: a regular file is its download, through the same
          // admission as the page; a folder, or anything not served, is
          // the page, which says what is there.
          if (closing) return response({ error: "closing" }, 503);
          let answer: Awaited<ReturnType<typeof files.page>>;
          try {
            answer = await files.page(request, server, url);
          } catch {
            return response({ error: "operation-failed" }, 500);
          }
          if (answer instanceof Response) return answer;
          const page = await shell.get(
            url.pathname,
            request.headers.get("accept"),
          );
          return new Response(request.method === "HEAD" ? null : page.body, {
            status: page.ok ? answer.status : page.status,
            headers: {
              ...headers,
              "Content-Type":
                page.headers.get("content-type") ?? "application/octet-stream",
            },
          });
        }
        if (
          request.method === "GET" &&
          !url.pathname.startsWith("/api/") &&
          !isLazurioDocument(url.pathname)
        ) {
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
      if (url.pathname === shellDocumentPath) {
        // The Lazurio shell's data (decision F36): this Environment, its
        // Organizations and the addresses of its apps, behind the same
        // admission as every read (the token locally, the gateway's session
        // hosted). Read-only, recomputed on every read.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        try {
          const current = await withFolderReadLock(state, () =>
            readFolderState(state),
          );
          const preset = current.preferences.preset.name;
          // GitHub and the content only where the Environment signs in as
          // its person; the first answer of `gh` is awaited a few seconds
          // at most (setup-state.ts).
          server.timeout(request, 30);
          const [catalog, setup] = await Promise.all([
            readFolderCatalog(folder),
            signsInAsPerson(preset)
              ? Promise.all([github.state(), readContent(contentState)])
                  .then(([state, read]) =>
                    shellSetup({ preset, github: state, ...read }),
                  )
                  // What the Environment lacks never costs the rail.
                  .catch(() => undefined)
              : undefined,
          ]);
          return response(
            shellDocument({
              preset,
              machine: current.preferences.machine,
              locale: current.preferences.profile.locale === "cs" ? "cs" : "en",
              catalog,
              computer: hostname(),
              ...(setup === undefined ? {} : { setup }),
            }),
          );
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      const promptRequest = promptRoute.exec(url.pathname);
      if (promptRequest !== null) {
        // A prepared prompt for Chat (prompts.ts): its id in the path, the
        // Organization's GitHub login as the only query. Only for whom the
        // prompt names; anyone else, an unknown id or Organization and any
        // failure get the same 404, never more (fail closed).
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        const notFound = () => response({ error: "not-found" }, 404);
        const id = promptRequest[1] as string;
        const login = url.searchParams.get("org");
        const keys = [...url.searchParams.keys()];
        if (!isPromptId(id) || keys.some((key) => key !== "org"))
          return notFound();
        if (!isOrganizationPrompt(id)) {
          // The Folder's prompt (`prepare-content`): only on an Environment
          // that signs in as its person, only while the last installation
          // stopped, and, when the link names a login, only for the content
          // of that login (the Organization, or the person for the
          // Personalspace).
          if (keys.length > 1) return notFound();
          try {
            const current = await withFolderReadLock(state, () =>
              readFolderState(state),
            );
            if (!signsInAsPerson(current.preferences.preset.name))
              return notFound();
            const copy = messages(
              current.preferences.profile.locale === "cs" ? "cs" : "en",
            );
            const read = await readContent(contentState);
            const context = prepareContext(read.list, read.job, copy);
            if (
              context === null ||
              (login !== null &&
                context.login?.toLowerCase() !== login.toLowerCase())
            )
              return notFound();
            return response(prepareContentDocument(folder, context, copy));
          } catch {
            return notFound();
          }
        }
        if (login === null || keys.length !== 1) return notFound();
        try {
          const organization = promptOrganization(
            await readFolderCatalog(folder),
            login,
          );
          if (organization === null) return notFound();
          server.timeout(request, 30);
          if (
            promptAudience(id) === "organization-owner" &&
            !(await owners.owner(
              organization.forgeLogin,
              await folderPreset(folder),
            ))
          )
            return notFound();
          const current = await withFolderReadLock(state, () =>
            readFolderState(state),
          );
          return response(
            promptDocument(
              id,
              folder,
              organization,
              messages(
                current.preferences.profile.locale === "cs" ? "cs" : "en",
              ),
            ),
          );
        } catch {
          return notFound();
        }
      }
      if (
        url.pathname === browserViewDocumentPath ||
        url.pathname === browserViewPath
      ) {
        // The Environment browser's view (decision F38), behind the same
        // admission as every read: the dashboard's address with the window
        // of one agent-browser session selected and the dashboard's access
        // token in the fragment. The JSON answer is for the panels; the
        // hand-over redirects a link's browser there. Only `session`, and
        // only a name agent-browser accepts.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        const keys = [...url.searchParams.keys()];
        const session = url.searchParams.get("session");
        if (
          keys.some((key) => key !== "session") ||
          keys.length > 1 ||
          (session !== null && !isBrowserSession(session))
        )
          return response({ error: "invalid-request" }, 400);
        server.timeout(request, 30);
        const view = await resolveBrowserView(
          browserEntryOf(entry),
          session,
          browserViewSeams,
        );
        if (url.pathname === browserViewDocumentPath) return response(view);
        if (!view.available) return response(view, 404);
        return new Response(null, {
          status: 302,
          headers: { ...headers, Location: view.view },
        });
      }
      const ownerRequest = ownerRoute.exec(url.pathname);
      if (ownerRequest !== null) {
        // Read-only and behind the same admission as every read: GitHub's
        // own answer, never a local rule (organization-owner.ts).
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        try {
          const name = decodeURIComponent(ownerRequest[1] as string);
          const selection = selectCatalogOrganization(
            await readFolderCatalog(folder),
            name,
          );
          server.timeout(request, 30);
          const owner =
            selection.kind === "found" &&
            (await owners.owner(
              selection.organization.forgeLogin,
              await folderPreset(folder),
            ));
          return response({ kind: "organization-owner", owner });
        } catch {
          return response({ kind: "organization-owner", owner: false });
        }
      }
      const maintainRequest = maintainRoute.exec(url.pathname);
      if (maintainRequest !== null) {
        // Read-only and behind the same admission as every read: GitHub's
        // own answer for the module's declared repository, never a local
        // rule (module-maintainer.ts).
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        try {
          const name = decodeURIComponent(maintainRequest[1] as string);
          const id = decodeURIComponent(maintainRequest[2] as string);
          const selection = selectCatalogOrganization(
            await readFolderCatalog(folder),
            name,
          );
          const module =
            selection.kind === "found"
              ? selection.organization.modules.find(
                  (entry) => entry.module === id,
                )
              : undefined;
          server.timeout(request, 30);
          const maintain =
            selection.kind === "found" &&
            module !== undefined &&
            (await maintainers.maintain(
              selection.organization.forgeLogin,
              module.url,
              await folderPreset(folder),
            ));
          return response({ kind: "module-maintain", maintain });
        } catch {
          return response({ kind: "module-maintain", maintain: false });
        }
      }
      if (url.pathname.startsWith("/api/files/")) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await files.api(request, server, url);
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
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
      if (url.pathname === "/api/chat/prompt-handoff") {
        // Whether Chat on this Environment takes a prepared prompt by link
        // (chat.ts): "+ Nový modul" then copies nothing. No on a
        // workstation, which has no Chat origin, without a call.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        server.timeout(request, 30);
        return response({
          kind: "chat-prompt-handoff",
          accepted: entry !== null && (await chatPrompts.accepted()),
        });
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
            const input: unknown = await readJsonBody(request);
            const withApp = ownDataValue(input, "app") !== undefined;
            const value = stateFields(input, withApp ? ["app"] : []);
            if (withApp && typeof value.app !== "string")
              return response({ error: "invalid-app" }, 400);
            app = value.app as string | undefined;
          }
        } catch (error) {
          if (error instanceof BodyTooLarge)
            return response({ error: "body-too-large" }, 413);
          return response({ error: "invalid-request" }, 400);
        }
        const options = app === undefined ? {} : { app };
        try {
          // A start runs the module's start-time step first, and a prepare
          // its preparation. The request waits at most until the answer
          // deadline (below this idle timeout, decision F34), which includes
          // the queue, the locks and the preflight; a start or preparation
          // still running then is answered 202 with its pending outcome and
          // goes on.
          const answer = {
            answerWithinMs:
              hostedOptions.moduleAnswerWithinMs ?? moduleAnswerWithinMsDefault,
          };
          if (moduleRequest[3] === "start" || moduleRequest[3] === "prepare")
            server.timeout(request, 660);
          const result =
            moduleRequest[3] === "start"
              ? await modules.start(name, options, answer)
              : moduleRequest[3] === "prepare"
                ? await modules.prepare(name, options, answer)
                : moduleRequest[3] === "stop"
                  ? await modules.stop(name, options)
                  : await modules.status(name, options);
          return response(
            result,
            result.kind === "blocked"
              ? 409
              : result.kind === "module" && result.outcome.endsWith("-pending")
                ? 202
                : 200,
          );
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (content.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await content.handle(request, url, (seconds) =>
            server.timeout(request, seconds),
          );
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      try {
        const input: unknown = await readJsonBody(request);
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
        if (url.pathname === "/api/mausbot/pair") {
          // Lazurio MausBot (DEV-6632): a one-time pairing link, minted by
          // MausBot's own API on its recorded loopback port. Only on a
          // Machine whose entry records MausBot.
          stateFields(input, []);
          if (entry?.mausbotOrigin === undefined)
            return response({ error: "not-found" }, 404);
          server.timeout(request, 30);
          const result = await issueMausbotLink(entry);
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
          // binding is shown and never accepted back from the browser. The
          // presets offered are those a change may end on: the recorded one
          // and what the handover offers as a new choice (issue #107).
          return response({
            revision: current.preferences.revision,
            preset: current.preferences.preset,
            allowedPresets: selectablePresets(
              current.preferences.machine,
              current.preferences.preset.name,
            ),
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
          const overview = await toolsOverview(folder, toolsEnvironment, {
            signIn: value.signIn === true,
          });
          // The shell document's GitHub follows this reading.
          const gh = overview.tools.find((tool) => tool.name === "gh");
          if (gh !== undefined) github.remember(gh.installed, gh.signIn);
          return response(overview);
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
          // gh on a Team Environment (Matěj 2026-09-28): no person's
          // sign-in or SSH key; a sign-out only of a person's account left
          // there. The preset is read per request: a profile change may
          // switch it while the Launchpad runs.
          const teamRefusal = async (action: GithubAction) =>
            tool === "gh"
              ? githubRefusal(await folderPreset(folder), tool, action, logins)
              : undefined;
          // A sign-in or sign-out of gh changes what the shell says.
          if (tool === "gh") github.forget();
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
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return response({ error: "body-too-large" }, 413);
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
          // An upload cut off by the stop removes its temporary file first.
          await files.close();
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
