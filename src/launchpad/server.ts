import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "bun";
import {
  browserViewDocumentPath,
  browserViewPath,
} from "../browser/contract/platform";
import {
  browserViewUrl,
  isStrip,
  launchpadStrip,
} from "../browser/contract/pure";
import { restartStaleBrowserView } from "../browser/units";
import {
  type BrowserViewSeams,
  browserEntryOf,
  resolveBrowserView,
} from "../browser/view";
import { type CdpCall, cdpSeams, ensureThreadWindow } from "../browser/window";
import { createHermesGateway } from "../buddy/hermes-gateway";
import { buddyPersona as applyBuddyPersona } from "../buddy/persona-apply";
import { createPersonaSave } from "../buddy/persona-save";
import { createBuddySignIn } from "../buddy/sign-in";
import { readBuddyFacts } from "../buddy/status";
import { createPersonalspaceHolder } from "../content/holder";
import {
  type ContentHost,
  contentLockDirectory,
  preparationAnswer,
  processContentHost,
  processGitHubHost,
} from "../content/host";
import { syncContent } from "../content/sync";
import type { ExecutorHost } from "../executor/flow";
import { processExecutorHost } from "../executor/host";
import { type DocumentsHost, processDocumentsHost } from "../files/documents";
import { inspectProfileChange } from "../folder/inspect-profile-change";
import {
  inspectToolsChange,
  readFolderTools,
  sharedSignInsWarning,
} from "../folder/inspect-tools-change";
import { withFolderReadLock } from "../folder/lock";
import type { MachineEntry } from "../folder/machine-binding";
import { inspectCheckoutDirectory } from "../folder/owned-directory";
import { isFixed, type PresetName, selectablePresets } from "../folder/presets";
import { readFolderState } from "../folder/read-state";
import {
  enabledTools,
  type FolderPreferences,
  stateFields,
} from "../folder/state";
import { ownDataValue } from "../folder/state-fields";
import { updateProfile, updateTools } from "../folder/update-profile";
import { resolvedVoice } from "../folder/voice";
import {
  composioOrganizationRule,
  convergeComposioOrganization,
} from "../integrations/composio-organization";
import { processExecutorEndpoint } from "../integrations/executor-client";
import { readMachineContext } from "../machine/context";
import { hostedOperatorFolder } from "../machine/operator";
import { createApplicationLifecycle } from "../modules/lifecycle";
import {
  createModuleOperations,
  type ModuleAnswer,
  type ModuleBlocked,
  type ModuleHost,
  moduleAnswerWithinMsDefault,
  processModuleHost,
} from "../modules/module-operations";
import {
  launchpadSettingsPoller,
  type OrganizationSettingsSeams,
} from "../organization-settings/host";
import { selectCatalogOrganization } from "../organizations/catalog-selection";
import { readOrganizationApplications } from "../organizations/read-applications";
import type { RecoveryResult } from "../recover/recover";
import { newTabPagePath } from "../shell/new-tab-protocol";
import { processSshAccessHost, type SshAccessHost } from "../ssh-access/host";
import { shellThemeOf } from "../theme/palettes";
import {
  fileThemeStore,
  fixedThemeReads,
  memoryThemeStore,
  type ThemeStore,
} from "../theme/record";
import { isAiProvider } from "../tools/ai";
import { type AiProbe, createAiProbe } from "../tools/ai-probe";
import { reloadAiServices } from "../tools/ai-services";
import {
  activatableTools,
  executorToolName,
  findTool,
  toolSelection,
  vaultToolName,
} from "../tools/catalog";
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
  type SignInPage,
} from "../tools/login";
import {
  type ToolsEnvironment,
  toolsEnvironmentOf,
  toolsOverview,
} from "../tools/overview";
import { qrMatrix, qrSvg } from "../tools/qr";
import { createSshProofs } from "../tools/ssh-key";
import { resolveOnPath } from "../tools/status";
import type { GithubAction } from "../tools/team-github";
import { toolsUpdate } from "../tools/update";
import { embeddedIdentity } from "../update/identity";
import { runProcess } from "../update/self-check";
import type { VaultHost } from "../vault/flow";
import { enableVaultForAgents, processVaultHost } from "../vault/host";
import type { LaunchpadBoot } from "./boot";
import { launchpadBoot, vaultInAppsOf, withBoot } from "./boot-document";
import { createBuddyRoutes } from "./buddy-routes";
import { createCatalogReading, organizationsOnly } from "./catalog-reading";
import {
  asksForBuddy,
  chatPairingPath,
  createChatPromptCheck,
  isOwnScriptFetch,
  issueChatLink,
  mintBuddyPairing,
  mintChatPairing,
  publicEntry,
} from "./chat";
import { createContentRoutes } from "./content-routes";
import { prepareContext } from "./content-view";
import { createExecutorRoutes, isExecutorJob } from "./executor-routes";
import { createFilesRoutes, maxRequestBytes } from "./files-routes";
import { shellSetup, signsInAsPerson } from "./first-run";
import { guideVideoPath } from "./guide-video";
import { guideVideoAnswer, isGuideVideoPath } from "./guide-video-files";
import { serveHealthSocket } from "./health-socket";
import {
  type AdmittedPerson,
  type AuthFetcher,
  createHostedTrust,
  nobody,
} from "./hosted-trust";
import { notModified } from "./http-conditions";
import {
  createIntegrationsRoutes,
  type IntegrationsSeams,
} from "./integrations-routes";
import { BodyTooLarge, readJsonBody } from "./json-body";
import {
  issueMausbotLink,
  mausbotPairingPath,
  mintMausbotPairing,
} from "./mausbot";
import { messages } from "./messages";
import { createMaintainerCheck } from "./module-maintainer";
import { type LaunchpadHolder, launchpadHolderOf } from "./new-tab/holder";
import { openTab } from "./new-tab/hub-client";
import { runningModules } from "./new-tab/modules";
import {
  createNewTabRoutes,
  type NewTabHost,
  newTabPageHeaders,
  processNewTabHost,
} from "./new-tab-routes";
import {
  offlineGuideHeaders,
  offlineGuidePage,
  offlineGuidePath,
  offlineWorker,
  offlineWorkerHeaders,
  offlineWorkerPath,
  withOfflineGuide,
} from "./offline-guide";
import { createOwnerCheck } from "./organization-owner";
import {
  admitLocal,
  assetCaching,
  pageRoutes,
  privatePage,
  serveShell,
} from "./page";
import {
  isOrganizationPrompt,
  isPromptId,
  personalModuleDocument,
  prepareContentDocument,
  promptAudience,
  promptDocument,
  promptOrganization,
} from "./prompts";
import {
  isPublicEnvironment,
  isToolsApiPath,
  withheldInPublic,
} from "./public-environment";
import { pageRoute } from "./routes";
import {
  type ContentReader,
  createGithubProbe,
  createSetupCache,
  readContent,
} from "./setup-state";
import {
  environmentKind,
  presetKinds,
  readShellInputs,
  shellDocument,
} from "./shell-document";
import { createSshRoutes } from "./ssh-routes";
import {
  checkBundledPage,
  LaunchpadStartRefused,
  readStartState,
} from "./start-check";
import { createThemeRoutes } from "./theme-routes";
import { createToolsReading } from "./tools-reading";
import type { UpdatePill } from "./update-pill";
import { createVaultConnectionRoutes } from "./vault-connection-routes";
import { createVaultPageRoutes } from "./vault-page-routes";
import { createVaultRequestRoutes } from "./vault-request-routes";
import { createVaultRoutes, isVaultJob, vaultRoutePaths } from "./vault-routes";

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
  /** Where the offline guide reads this Environment's tailnet (decision
   * F41): by default the control server the root-custodied Machine handover
   * names, or none (a workstation, no handover). Trusted composition, never
   * HTTP input; tests supply the address. */
  offlineTailnet?: () => Promise<string | null>;
  /** Where the shell document reads the owning Organization's own slug
   * (`owner.organization_key`): by default the root-custodied Machine
   * handover, none where it names none or there is no handover. Trusted
   * composition, never HTTP input; tests supply the key. */
  ownerKey?: () => Promise<string | null>;
}>;

/** The origins of Microsoft's sign-in, whose cookies and storage hold the
 * person's Microsoft session after a company app's sign-in in the
 * Environment browser (decision F42 addendum (c) of 2026-10-14). */
export const microsoftSignInOrigins = Object.freeze([
  "https://login.microsoftonline.com",
  "https://login.microsoft.com",
  "https://login.live.com",
]);

/** Clears Microsoft's sign-in session from the Environment browser, origin
 * by origin (`Storage.clearDataForOrigin` over the browser's own debugging
 * endpoint on loopback, which the people's view already uses): the
 * person's other sign-ins there stay. True when every origin was cleared;
 * null where the Environment has no browser. */
export function forgetMicrosoftSignInOf(
  entry: MachineEntry | null,
  cdp: () => CdpCall,
): (() => Promise<boolean>) | null {
  if (entry === null || browserEntryOf(entry) === undefined) return null;
  return async () => {
    const call = cdp();
    let all = true;
    for (const origin of microsoftSignInOrigins)
      await call("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "all",
      }).catch(() => {
        all = false;
      });
    return all;
  };
}

/** Where a direct sign-in of an Integrace opens when its authorization
 * server returns only to Executor's callback on localhost (decision F42 and
 * its addendum of 2026-10-13; one that takes the Launchpad's own address
 * returns to the person's own browser instead): on a Remote Environment the
 * person signs in in the Environment browser, a new tab the panel shows; a
 * workstation (no entry) answers null and the person's own browser opens
 * the address. An entry whose gateway routes no browser view has none to
 * offer. The tab is the hub's like every other (root decision 0191's
 * addendum of 2026-10-12, F47 point 6): its own window, opened from Nová
 * karta of the Launchpad's strip. */
export function environmentBrowserOf(
  entry: MachineEntry | null,
  hold: (target: string) => Promise<void>,
  open: typeof openTab = openTab,
): IntegrationsSeams["environmentBrowser"] {
  if (entry === null) return null;
  const browser = browserEntryOf(entry);
  return async (url) => {
    if (browser === undefined) return null;
    const opened = await open(browser, url, launchpadStrip);
    if (opened.kind !== "opened") return null;
    const target = opened.tab;
    // The panel shows the sign-in, and its strip shows the tabs the
    // Launchpad holds (F47 point 9's addendum of 2026-10-12): the Launchpad
    // holds it first, as one opened from its Nová karta. Unheld, it would
    // leave the strip at the panel's next reading, so a hold that fails
    // answers that the browser cannot open it now; the hub ends the tab,
    // which nothing holds.
    try {
      await hold(target);
    } catch {
      return null;
    }
    return { view: browserViewUrl(browser.origin, target) };
  };
}

/** Where the sign-in page of codex and claude opens for this Launchpad (root
 * decision 0201 points 4 and 5, F19's addendum of 2026-10-15): on a
 * workstation the computer's own browser, which the CLI opens itself; on a
 * Remote Environment the Environment browser, as an Integrace sign-in opens
 * there (`environmentBrowserOf`: a tab the Launchpad holds, which its right
 * panel shows); nowhere where the entry routes no Environment browser, so the
 * sign-in does not start. `open` is asked for the opener when a page opens. */
export function launchpadSignInPage(
  entry: MachineEntry | null,
  open: () => IntegrationsSeams["environmentBrowser"],
): SignInPage {
  if (entry === null) return { kind: "own" };
  if (browserEntryOf(entry) === undefined) return { kind: "none" };
  return {
    kind: "environment",
    open: async (url) => (await open()?.(url)) ?? null,
  };
}

/** The hold the Integrace sign-in takes for the Launchpad before its tab shows
 * (F47 point 9's addendum of 2026-10-12). Without a holder (no usable runtime
 * directory) it refuses, as `/api/new-tab/open` answers 503 then, so the
 * sign-in never shows a tab the Launchpad does not hold. */
export function launchpadHoldOf(
  holder: LaunchpadHolder | null,
): (target: string) => Promise<void> {
  return (target) =>
    holder === null
      ? Promise.reject(new Error("The Launchpad has no holder"))
      : holder.hold(target);
}

/** The Lazurio shell's data document (decision F36). */
export const shellDocumentPath = "/.lazurio/shell.json";

/** How long a refresh of Settings → Tools or of Integrace waits for the
 * Organization's settings to be asked and applied (decision F45) before it
 * answers with what the Folder records. */
const settingsWaitMs = 5_000;

/** How long the page's boot document may wait for the Folder's lock, and
 * for everything it reads (F36's addendum of 2026-10-08): the page is never
 * held longer for it. */
const bootLockWaitMs = 250;
const bootWithinMs = 500;

/** How often an installed hosted Launchpad looks whether its work
 * Environment was assigned to someone else, so its Správci leave the vault
 * (F53's addendum of 2026-10-14). */
const vaultAudienceEveryMs = 5 * 60_000;

/** The tailnet control server the Machine handover names (decision F41);
 * none where there is no readable handover, as on a workstation. */
async function machineTailnet(): Promise<string | null> {
  try {
    return (
      (await readMachineContext()).context.network?.headscale_server_url ?? null
    );
  } catch {
    return null;
  }
}

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

/** The catalog of a prompt document in the Folder's language, naming this
 * Environment's kind as the page does (decision F28's addendum of
 * 2026-10-18; Služby serveru are a work Environment, root decision 0209); a
 * preset this release does not know names none. */
const folderMessages = (
  preferences: Pick<FolderPreferences, "preset" | "profile" | "machine">,
) =>
  messages(
    preferences.profile.locale === "cs" ? "cs" : "en",
    Object.hasOwn(presetKinds, preferences.preset.name)
      ? environmentKind(
          preferences.preset.name as PresetName,
          preferences.machine,
        )
      : null,
  );

// The Environment browser's view (decision F38): the JSON answer the panels
// of the Launchpad and of T3 Code read (`browserViewDocumentPath`), and the
// hand-over a link opens (`browserViewPath`), the contract's C12. Both under
// `/.lazurio/`, so the gateway forwards them from the forks' origins too.

/** The Launchpad's own data under `/.lazurio/`, answered after admission
 * like every read; every other path there is the page's static asset. */
const isLazurioDocument = (path: string) =>
  path === shellDocumentPath ||
  path === offlineGuidePath ||
  path === offlineWorkerPath ||
  path === browserViewDocumentPath ||
  path === browserViewPath ||
  path === chatPairingPath ||
  path === mausbotPairingPath ||
  promptRoute.test(path);

// The module lifecycle routes (launchpad-parity B3): `<org>` and `<module>`
// are URL-encoded segments naming the module as `lazurio module` does.
const moduleRoute =
  /^\/api\/modules\/([^/]+)\/([^/]+)\/(start|prepare|build|stop|status)$/;

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

/** The header in which the gateway's loopback entry for the Environment
 * browser (#504) passes on the browser's `Sec-Fetch-Mode`: a local `ensure`
 * carries no Fetch Metadata of its own (`isLocalEnsure`). */
export const localEnsureModeHeader = "x-lazurio-fetch-mode";

const loopbackPeer = (address: string | null) =>
  address !== null &&
  (/^127(?:\.[0-9]{1,3}){3}$/.test(address) ||
    address === "::1" ||
    /^::ffff:127(?:\.[0-9]{1,3}){3}$/i.test(address));

/** Whether an `ensure` is the readiness call of the gateway's loopback entry
 * for the Environment browser (LazurioPlatform#504, F39's addendum of
 * 2026-10-18), which the Launchpad answers without a gateway session: the
 * Environment browser never holds a Lazurio session, and that entry serves
 * only this Environment's own apps to its own browser. Accepted only as the
 * view's hub accepts the Launchpad's requests (F47 point 6): a loopback
 * connection, a loopback `Host` naming this listener, and no `Origin` and no
 * Fetch Metadata (`Sec-Fetch-*`), which a browser always sends, so neither a
 * page in the Environment browser nor a request through the gateway, which
 * sends the Launchpad's own Host, is ever one. It only makes a module run or
 * says that it does, as the gateway's `ensure` does after admission. */
export function isLocalEnsure(
  request: Readonly<{ headers: Headers; peer: string | null }>,
  port: number,
): boolean {
  if (!loopbackPeer(request.peer)) return false;
  const host = request.headers.get("host");
  if (
    host !== `127.0.0.1:${port}` &&
    host !== `localhost:${port}` &&
    host !== `[::1]:${port}`
  )
    return false;
  if (request.headers.has("origin")) return false;
  for (const name of request.headers.keys())
    if (name.toLowerCase().startsWith("sec-fetch-")) return false;
  return true;
}

/** Whether a local `ensure` may start a stopped app: only a navigation, as
 * the loopback entry passes the browser's mode on (`localEnsureModeHeader`,
 * Machines#633 sends it only when the browser sent `Sec-Fetch-Mode`). The
 * Environment browser sends that with every request, so a call without it
 * (or with an empty one) comes from no browser's navigation and only
 * reports: unlike through the gateway, an absent mode is never an Open. */
export function localEnsureMayStart(headers: Headers): boolean {
  if (headers.has("sec-websocket-key")) return false;
  return headers.get(localEnsureModeHeader) === "navigate";
}

/** The status of an `ensure` answer, the only part of it the gateway reads
 * (`M:workloads/workspace-vm/ingress.ts:139-157`): 204 continues to the app,
 * 503 shows "starting" and reloads, 404 shows "not available here", anything
 * else (409 here) shows "could not be prepared". */
export function ensureStatus(result: ModuleAnswer | ModuleBlocked): number {
  if (result.kind === "module") return result.healthy ? 204 : 503;
  // Asked again shortly: a closing Launchpad, a busy coordination, or a
  // Personalspace whose holder is not decided within the request (#186).
  if (
    ["closing", "coordination-busy", "personalspace-unverified"].includes(
      result.reason,
    )
  )
    return 503;
  if (result.reason === "module-ambiguous") return 409;
  // The id names no single runnable default app of this Folder.
  if (result.operation === "ensure") return 404;
  // The lifecycle refused the status read or the start.
  return 409;
}

// The tools operations that change what the tools report (an installation,
// an update, a sign-in or sign-out, a setup of Executor or the vault): each
// drops the Launchpad's kept reading of their live facts (tools-reading.ts)
// as it starts and again once it has answered, so a reading made while it ran
// is never answered after it. A setup that goes on after its answer, and a
// sign-in, drop it again when they end; a switch of Composio's organization
// where it happens.
const toolsChangePaths = new Set([
  "/api/tools/install",
  "/api/tools/upgrade",
  "/api/tools/login/start",
  "/api/tools/login/poll",
  "/api/tools/login/cancel",
  "/api/tools/login/code",
  "/api/tools/logout",
  "/api/tools/executor/setup",
  "/api/tools/bitwarden/setup",
]);

const curatedRoutes = new Set([
  "/api/tools/install",
  "/api/tools/upgrade",
  "/api/tools/login/start",
  "/api/tools/login/poll",
  "/api/tools/login/cancel",
  "/api/tools/login/code",
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
    /** Whether this Launchpad sets Executor up after it starts (decision
     * F44, addendum of 2026-10-11): where install and update only report
     * it, a supervised base for the hosted operator (`executorAtStart`).
     * Absent: it never does. */
    executorAtStart?: (() => Promise<boolean>) | undefined;
    /** Whether this Launchpad sets the Environment's own vault up after it
     * starts (decision F53): the same rule as Executor's
     * (`vaultAtStart`). Absent: it never does. */
    vaultAtStart?: (() => Promise<boolean>) | undefined;
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
    openWindow: (session: string) =>
      ensureThreadWindow(session, undefined, cdpSeams(process.env, runProcess)),
  }),
  // Where the Environment's vault runs (decisions F43, F53): this process's
  // home and the handover, for the Folder this Launchpad serves. Trusted
  // composition, never HTTP input; tests supply a fake vault and a fake bw.
  vaultHost?: VaultHost | undefined,
  // Where Executor is set up (decision F44): this process's home, user
  // manager and harnesses, for the handover's declared operator. Trusted
  // composition, never HTTP input; tests supply fakes.
  executorHost?: ExecutorHost | undefined,
  // Where Integrace are read and connected (decision F42): this account's
  // Executor on loopback and, on a Remote Environment, its browser. Trusted
  // composition, never HTTP input; tests supply a fake Executor.
  integrationSeams?: Partial<IntegrationsSeams> | undefined,
  // Where the Organization's settings come from (decision F45): the relay
  // the handover names, or the Organization's root in the Folder. Trusted
  // composition, never HTTP input; tests supply a relay socket of their own
  // and the poller's clock.
  organizationSettingsSeams?: OrganizationSettingsSeams | undefined,
  // Where Nová karta's overview and actions read and write (decision F47):
  // this account's runtime directory, service manager, /proc and boot clock.
  // Trusted composition, never HTTP input; tests supply their own.
  newTabHost: NewTabHost = processNewTabHost(),
  // Whose `authorized_keys` Settings → SSH from your devices lists and
  // changes (decision F49): this process's account, its host key and its
  // Tailscale. Trusted composition, never HTTP input; tests supply a
  // temporary home, a host key and a tailnet answer.
  sshHost: SshAccessHost = processSshAccessHost(toolsEnvironment),
  // Where the Environment's AI is asked (root decision 0201 point 6): its
  // operator's Codex and Claude Code. Trusted composition, never HTTP
  // input; tests supply answers.
  ai: AiProbe = createAiProbe(toolsEnvironment),
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
  // A public Environment (root decision 0204, decision F55): no first run,
  // no Integrace and no Nástroje, and Trezor only with its own vault, by the
  // entry recorded at start.
  const publicEnvironment = isPublicEnvironment(entry);
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
  // Whose Personalspace this Environment holds (#186, decided by Matěj on
  // 2026-10-05): the GitHub account of its gh, decided as `GET /api/content`
  // decides it and remembered a minute (src/content/holder.ts). The content
  // routes and the module lifecycle act on the decision; the page's catalog
  // shows the last one and never waits for GitHub.
  let holderHost: Pick<ContentHost, "github" | "git"> | undefined;
  const personalspace = createPersonalspaceHolder(() => {
    holderHost ??=
      contentHost ??
      processGitHubHost({
        env: process.env,
        platform: toolsEnvironment.platform,
        tools: toolsEnvironment,
      });
    return holderHost;
  });
  // The module lifecycle of the catalog: the same core as `lazurio module`.
  // This Launchpad holds one lifecycle per Organization, so a session app
  // (macOS) is its child and ends with it; a service app outlives it.
  const modules = createModuleOperations({
    folder,
    owner: "launchpad",
    host: moduleHost,
    personalspace: personalspace.decide,
  });
  // What the service manager runs: Nová karta's running Modules, and the
  // apps the Launchpad's sweep lets sleep when nobody uses them.
  const running = () =>
    runningModules({
      folder,
      host: moduleHost,
      personalspace: personalspace.peek,
    });
  // The Folder's primary checkouts follow their published branch (decision
  // F9's amendment of 2026-10-24, root decision 0212 points 2 and 4): the installed
  // Launchpad fast-forwards the clean ones at its start and then hourly
  // (`contentSyncEveryMs`), within the sweep that builds what moved. Its
  // content lock and record are the install base's, as the CLI's; a
  // development run without a base never synchronizes.
  const syncCheckouts =
    installed === undefined
      ? undefined
      : () =>
          syncContent(
            folder,
            contentHost ?? {
              ...processGitHubHost({
                env: process.env,
                platform: toolsEnvironment.platform,
                tools: toolsEnvironment,
              }),
              lockDirectory: contentLockDirectory(installed.base),
            },
          );
  // A static app someone opened is built again after a pull (decision F58);
  // an app nobody uses falls asleep (root decision 0195 point 23).
  modules.keepBuilt({
    running,
    ...(syncCheckouts === undefined ? {} : { sync: syncCheckouts }),
  });
  // The Folder's catalog, kept while nothing it depends on changed
  // (catalog-reading.ts): the page's boot document, the shell document, the
  // catalog and Apps' questions about one Organization read it.
  const catalog = createCatalogReading(folder, {
    holder: personalspace.peek,
  });
  // gh's SSH proof of the status (decision F19, addendum 2026-10-19, #515)
  // is kept here, per key and account (a pass 5 minutes, a failure 20 s),
  // for every reading of the sign-ins this Launchpad makes: Settings →
  // Nástroje's (itself kept a minute, below), Integrace's and the shell
  // document's GitHub. A gh sign-in or sign-out that starts forgets it, and
  // a link keeps what it proved, so the reading after it does not prove
  // again.
  const toolsWithProofs: ToolsEnvironment = {
    ...toolsEnvironment,
    sshProofs: createSshProofs(),
  };
  // Settings → Nástroje's live facts, kept a minute (tools-reading.ts).
  const toolsReading = createToolsReading(toolsWithProofs);
  // A setup goes on after its answer: its end drops the reading again.
  const forgetToolsAfter = (ended: Promise<void>) =>
    void ended.catch(() => undefined).then(() => toolsReading.forget());
  // The curated logins of this Launchpad (decision F19): in memory, held by
  // the browser that started each one through its session handle, ended on
  // completion, cancel, expiry and shutdown.
  // A running gh session asks the Team rule again, on this Folder's current
  // preset, before every step that changes the account or the Machine
  // (Matěj 2026-09-28).
  // The start and the end of each sign-in go to this process's journal (the
  // unit's journal on a Machine): the tool and the outcome, nothing else.
  // codex and claude sign in through the same sessions (F19's addendum of
  // 2026-10-15): their page opens in the Environment browser of a Remote
  // Environment, shown in the right panel (codex by code opens nothing: its
  // page and code go to the page, F19's addendum of 2026-10-21); the
  // sessions ask Codex itself, fresh, whether the Organization provides the
  // AI; afterwards the running services read the sign-in, and the AI is read
  // again.
  const logins = createLoginSessions({
    ...toolsWithProofs,
    journal: (journaled) => {
      console.log(JSON.stringify({ scope: "tools-login", ...journaled }));
      // A sign-in that ends, even with nobody polling it, changes what the
      // tools report.
      if (journaled.event === "end") toolsReading.forget();
      if (journaled.event === "end" && isAiProvider(journaled.tool)) {
        ai.forget();
        setup.forget();
      }
    },
    signInPage: launchpadSignInPage(entry, () =>
      integrationSeams?.environmentBrowser !== undefined
        ? integrationSeams.environmentBrowser
        : environmentBrowserOf(entry, launchpadHoldOf(holder)),
    ),
    reload: (tool, signedIn) =>
      reloadAiServices({
        ...toolsEnvironment,
        tool,
        signedIn,
        env: process.env,
      }),
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
  const github = createGithubProbe(toolsWithProofs);
  let closing = false;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  // The Files page (decision F35): the Operator's Documents folder.
  const files = createFilesRoutes({ host: documentsHost, headers });
  // The Environment's vault (decisions F43, F53): its routes journal the
  // operation, the outcome and a fixed reason, never a value.
  const vaultJournal = (entry: object) =>
    console.log(JSON.stringify({ scope: "tools-vault", ...entry }));
  const defaultVault =
    vaultHost === undefined
      ? processVaultHost({
          folder: async () => folder,
          env: process.env,
          platform: toolsEnvironment.platform,
          run: toolsEnvironment.run,
          journal: vaultJournal,
        })
      : undefined;
  // The setup in which the vault becomes ready turns the agents' switch on
  // in this Launchpad's Folder (decision F53): the default host does so
  // already, a given one gets it here.
  const vaultHostOf = (): VaultHost =>
    vaultHost === undefined
      ? (defaultVault as VaultHost)
      : {
          ...vaultHost,
          journal: vaultHost.journal ?? vaultJournal,
          enableForAgents:
            vaultHost.enableForAgents ?? (() => enableVaultForAgents(folder)),
        };
  // Whether the Apps column lists Trezor here, as the vault core answers now
  // (`vaultInAppsOf`, from local files only). On a public Environment it is
  // also whether Trezor is there at all (plan DEV-6668 slice 6, #499): only
  // with its own vault, the handover's `vault`; without it, its page and API
  // answer as absent.
  const vaultListedHere = () => vaultInAppsOf(vaultHostOf(), publicEnvironment);
  const vault = createVaultRoutes({
    host: vaultHostOf,
    // A closing Launchpad starts no setup (`start` asks it last).
    closing: () => closing,
  });
  // Settings → Vault, Nastavení → Trezor (root decision 0198 point 5, F53's
  // addendum of 2026-10-14): the page, and the membership of the person the
  // gateway admitted, over the same core and the same journal.
  const vaultPage = createVaultPageRoutes({
    host: vaultHostOf,
    setup: () => vault.running(),
    headers,
  });
  // An agent's secret request (decision F54): the same vault host, so the
  // page and `lazurio vault request` share one store and one lock.
  const vaultRequests = createVaultRequestRoutes({
    host: vaultHostOf,
    headers,
  });
  // A personal Environment connects its person's own Bitwarden (root
  // decision 0203 point 7): the same vault host, and the one setup of the
  // Tools row creates its vault right after.
  const vaultConnection = createVaultConnectionRoutes({
    host: vaultHostOf,
    setup: () => vault.handle(vaultRoutePaths.setup),
    running: () => vault.running(),
    headers,
  });
  // Executor (decision F44): its setup journals the outcome and a fixed
  // reason, never a path, an output or a value.
  const executorJournal = (entry: object) =>
    console.log(JSON.stringify({ scope: "tools-executor", ...entry }));
  const defaultExecutor =
    executorHost === undefined
      ? processExecutorHost({
          hostedFolder: hostedOperatorFolder,
          env: process.env,
          platform: toolsEnvironment.platform,
          run: toolsEnvironment.run,
          journal: executorJournal,
        })
      : undefined;
  const executor = createExecutorRoutes({
    host: () =>
      executorHost === undefined
        ? (defaultExecutor as ExecutorHost)
        : {
            ...executorHost,
            journal: executorHost.journal ?? executorJournal,
          },
    // A closing Launchpad starts no setup (`start` asks it last).
    closing: () => closing,
  });
  // Content installation: one job at a time per Folder, over the same core
  // as `lazurio organization install` and `lazurio personalspace install`.
  const content = createContentRoutes({
    folder,
    headers,
    personalspace: personalspace.decide,
    // The content never before AI (root decision 0201 point 3, the same
    // rule as the page's `contentBlockedBy`): where the Environment signs in
    // as its person, an AI that every CLI answered is missing refuses the
    // start. One that could not be checked does not.
    refuseInstall: async () => {
      const preset = await folderPreset(folder).catch(() => undefined);
      if (preset === undefined || !signsInAsPerson(preset) || publicEnvironment)
        return null;
      return (await ai.state()).state === "missing" ? "ai-missing" : null;
    },
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
  // Nová karta (decision F47 points 4 and 6-8): the overview, the actions on
  // the view's hub and the Launchpad's holder file, only where the entry
  // routes the Environment browser's view.
  const browser = browserEntryOf(entry);
  // An update restarts this supervised Launchpad but not the view, whose unit
  // text stays the same: restart the installer's view when it still runs
  // another installation, so the installed version's hub holds the tabs
  // (decision F47, #334).
  if (browser !== undefined && installed !== undefined)
    void restartStaleBrowserView({
      base: installed.base,
      platform: process.platform,
      entry: browser,
      run: runProcess,
      env: process.env,
      executable: process.execPath,
    })
      .catch(() => "unknown" as const)
      .then((outcome) => {
        if (outcome === "restarted" || outcome === "failed")
          console.log(
            JSON.stringify({
              scope: "browser-view",
              event: `stale-${outcome}`,
            }),
          );
      });
  const holder =
    browser === undefined
      ? null
      : launchpadHolderOf(newTabHost.runtimeDirectory, {
          bootClock: newTabHost.bootClock,
          readFile: newTabHost.readFile,
          log: newTabHost.log,
        });
  // Integrace (decision F42): one reading and the connect sessions of this
  // Launchpad, journaled as the operation, the app and the outcome only.
  // The account's Executor: Integrace drives it, and the Organization's
  // company apps are applied to it (decision F42 addendum (c) of 2026-10-14).
  const integrationExecutor = () =>
    integrationSeams?.executor !== undefined
      ? integrationSeams.executor
      : processExecutorEndpoint(process.env);
  const integrations = createIntegrationsRoutes({
    folder,
    // Its reading of the tools has the sign-ins: gh's SSH proof is the one
    // this Launchpad keeps.
    tools: toolsWithProofs,
    headers,
    seams: () => ({
      executor: integrationExecutor(),
      environmentBrowser:
        integrationSeams?.environmentBrowser !== undefined
          ? integrationSeams.environmentBrowser
          : environmentBrowserOf(entry, launchpadHoldOf(holder)),
      // A direct sign-in returns to the Launchpad in the person's own
      // browser, through the gateway it passes to reach the Launchpad
      // (decision F42, addendum of 2026-10-13).
      oauthCallback:
        integrationSeams?.oauthCallback !== undefined
          ? integrationSeams.oauthCallback
          : entry === null
            ? null
            : `${entry.externalOrigin}/api/integrations/oauth/callback`,
      // Whether Lazurio sets Executor up here: F44's context of this
      // Launchpad's Executor host.
      executorContext:
        integrationSeams?.executorContext ??
        (() =>
          (executorHost === undefined
            ? (defaultExecutor as ExecutorHost)
            : executorHost
          ).context()),
      executorPresent: integrationSeams?.executorPresent,
      policy: integrationSeams?.policy,
      composioOrganization: integrationSeams?.composioOrganization,
      catalog: integrationSeams?.catalog,
      now: integrationSeams?.now,
      // After a company app's sign-in in the Environment browser, its
      // Microsoft session there goes (agents use that browser too).
      forgetMicrosoftSignIn:
        integrationSeams?.forgetMicrosoftSignIn !== undefined
          ? integrationSeams.forgetMicrosoftSignIn
          : forgetMicrosoftSignInOf(
              entry,
              () => cdpSeams(process.env, runProcess).cdp,
            ),
    }),
    journal: (line) => console.log(JSON.stringify(line)),
  });
  // SSH from the person's devices (decision F49): the keys of this account
  // and the settings a computer writes; journaled as the operation, the
  // outcome and the key's public fingerprint.
  const ssh = createSshRoutes({
    host: async () => {
      const current = await withFolderReadLock(state, () =>
        readFolderState(state),
      );
      return {
        ...sshHost,
        machine: current.preferences.machine,
        folder: await realpath(folder),
      };
    },
    headers,
    journal: (line) => console.log(JSON.stringify(line)),
  });
  // The Environment's theme (root decision 0208): one record of this Folder
  // in the install base, which `lazurio theme` changes too; a development run
  // without a base keeps it in memory (src/theme/record.ts). Read by
  // `/.lazurio/shell.json` and the page's boot document, changed by
  // Settings → Obecné; fixed on a public Environment, by the entry recorded
  // at start, the one rule that withholds Nástroje and Trezor there: every
  // read there is the default Lazurio, whatever the record kept from before
  // says (root decision 0208 point 6), and every change is refused.
  const themeStore: ThemeStore = fixedThemeReads(
    installed?.base === undefined
      ? memoryThemeStore()
      : fileThemeStore(installed.base, folder),
    () => publicEnvironment,
  );
  const themes = createThemeRoutes({
    store: themeStore,
    headers,
    fixed: () => publicEnvironment,
    journal: (line) => console.log(JSON.stringify(line)),
  });
  // Buddy's state and his ChatGPT sign-in (decision F63): only where the
  // recorded entry names his origin (a personal VM, F60), through his own
  // Hermes gateway, this account's `~/.hermes`. One sign-in at a time, in this
  // process's memory; a restart loses only its handle, as Hermes's worker
  // still saves the sign-in the person finishes. Its journal names the
  // operation, the outcome and the reason, never a code, a handle, a ticket
  // or Hermes's session.
  const buddyGateway = createHermesGateway({ home: toolsEnvironment.home });
  // His persona (decision F65): read and changed from Začínáme and
  // Nastavení → Buddy over F64's core, the change applied as `lazurio buddy
  // persona --apply` applies it, and finished here once he is idle. Its
  // journal never names a name, a value or a revision.
  const buddyPersona = createPersonaSave({
    home: toolsEnvironment.home,
    apply: () =>
      applyBuddyPersona(
        { tools: toolsEnvironment, env: process.env },
        { folder, apply: true },
      ),
    journal: (line) =>
      console.log(JSON.stringify({ scope: "buddy-persona", ...line })),
  });
  const buddy = createBuddyRoutes({
    present: () => entry?.buddyOrigin !== undefined,
    signIn: createBuddySignIn({
      gateway: buddyGateway,
      journal: (line) =>
        console.log(JSON.stringify({ scope: "buddy-sign-in", ...line })),
    }),
    facts: () => readBuddyFacts(buddyGateway),
    persona: buddyPersona,
    locale: async () =>
      (await withFolderReadLock(state, () => readFolderState(state)))
        .preferences.profile.locale,
    headers,
  });
  const newTab = createNewTabRoutes({
    browser,
    holder,
    host: newTabHost,
    modules: running,
    served: (module) =>
      modules.served(`${module.org}/${module.module}`, module.app),
    headers,
  });
  // The Organization's settings (root decision 0194, decision F45), on an
  // Organization's Environment only: asked every two minutes, at once when
  // the page opens and on a refresh, and applied to the Folder; Integrace
  // reads again whenever they change it. Its journal says what happened,
  // never a value.
  const settings = await launchpadSettingsPoller({
    folder,
    base: installed?.base,
    tools: toolsEnvironment,
    journal: (line) => console.log(JSON.stringify(line)),
    onApplied: () => integrations.forget(),
    executor: integrationExecutor,
    seams: organizationSettingsSeams,
  }).catch(() => {
    // The Launchpad serves without them; the Folder keeps what it records.
    console.log(
      JSON.stringify({ scope: "organization-settings", event: "unavailable" }),
    );
    return null;
  });
  // The shell document's `setup` from the last reading, never awaited (F36's
  // addendum of 2026-10-08): the forks' column head says what is missing
  // once it is known, and no page waits for GitHub to learn it.
  const setup = createSetupCache(async () => {
    const current = await withFolderReadLock(state, () =>
      readFolderState(state),
    );
    const preset = current.preferences.preset.name;
    if (!signsInAsPerson(preset) || publicEnvironment) return undefined;
    const [reading, signIn, read] = await Promise.all([
      ai.state(),
      github.state(),
      readContent(contentState),
    ]);
    return shellSetup({ preset, ai: reading.state, github: signIn, ...read });
  });
  // The boot document of the page (F36's addendum of 2026-10-08, boot.ts):
  // what this Launchpad knows from the Folder alone, under one short read of
  // its state, and whether the Apps column lists Trezor from the vault's
  // local facts (F53's addendum of 2026-10-18 (3), never failing). None when
  // that fails or takes longer than a moment: the page then reads it all
  // itself, as before.
  async function pageBoot(): Promise<LaunchpadBoot | null> {
    let late: ReturnType<typeof setTimeout> | undefined;
    const read = (async () => {
      const [inputs, tailnet, theme, vaultInApps] = await Promise.all([
        readShellInputs(folder, {
          ownerKey: hostedOptions.ownerKey,
          lockWaitMs: bootLockWaitMs,
          catalog: catalog.read,
        }),
        (hostedOptions.offlineTailnet ?? machineTailnet)(),
        themeStore.read(),
        vaultListedHere(),
      ]);
      return launchpadBoot({
        ...inputs,
        entry,
        tailnet,
        theme: shellThemeOf(theme),
        vaultInApps,
      });
    })().catch(() => null);
    try {
      return await Promise.race([
        read,
        new Promise<null>((resolve) => {
          late = setTimeout(() => resolve(null), bootWithinMs);
        }),
      ]);
    } finally {
      clearTimeout(late);
    }
  }
  // Behind the gateway, the page or one of its static assets from the inner
  // listener, after admission (F36's addendum of 2026-10-08). The page is
  // never stored and carries its boot document; an asset's caching is
  // `assetCaching`'s: the bundle's content-hashed files a year whatever the
  // inner listener says, since the compiled executable serves them with no
  // caching at all (#532); another asset the inner listener's (the fonts and
  // the stones immutable, the shell's script revalidated by its ETag); one
  // without its own is not stored, and neither is a missing asset. A page
  // may add headers of its own: only Nová karta's does (`newTabPageHeaders`).
  async function fromShell(
    request: Request,
    path: string,
    status: (page: Response) => number,
    pageHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    if (shell === null) throw new Error("No inner listener");
    const page = await shell.get(path, request.headers.get("accept"));
    const type = page.headers.get("content-type") ?? "application/octet-stream";
    const body = request.method === "HEAD" ? null : page.body;
    if (page.ok && type.startsWith("text/html")) {
      const answer = new Response(body, {
        status: status(page),
        headers: { ...headers, ...pageHeaders, "Content-Type": type },
      });
      if (request.method === "HEAD") return answer;
      const boot = await pageBoot();
      // Someone opened the Launchpad: what the Environment lacks is read now
      // (not as the Launchpad starts, when the Folder's operations need its
      // lock), so that Chat and Automate, whose column head reads the shell
      // document once per load, find it when they open. The Organization's
      // settings are asked now too, never twice within a short while. The
      // Launchpad's own page reads the tools with their sign-ins on its load:
      // they are read now, while its files load (tools-reading.ts), but on a
      // public Environment, which has none (Nová karta reads none either).
      void setup.peek();
      void settings?.nudge();
      if (
        !publicEnvironment &&
        new URL(request.url).pathname !== newTabPagePath
      )
        toolsReading.warm();
      return boot === null ? answer : withBoot(answer, boot);
    }
    const kept: Record<string, string> = {};
    const cacheControl = page.headers.get("cache-control");
    const etag = page.headers.get("etag");
    if (page.ok) kept["Cache-Control"] = assetCaching(path, cacheControl);
    if (page.ok && etag !== null) kept.ETag = etag;
    if (kept.ETag !== undefined && notModified(request, kept.ETag)) {
      await page.body?.cancel().catch(() => undefined);
      return new Response(null, {
        status: 304,
        headers: { ...headers, ...kept },
      });
    }
    return new Response(body, {
      status: status(page),
      headers: { ...headers, ...kept, "Content-Type": type },
    });
  }
  // The gateway's `ensure` (launchpad-parity B5), after its admission or as
  // the loopback entry's readiness call (`isLocalEnsure`): the module's
  // default app runs, or the typed reason why not.
  async function answerEnsure(
    request: Request,
    server: Server<undefined>,
    encoded: string,
    mayStart: boolean,
  ): Promise<Response> {
    const response = (body: unknown, status = 200) =>
      Response.json(body, { status, headers });
    if (request.method !== "GET")
      return response({ error: "method-not-allowed" }, 405);
    if (closing) return response({ error: "closing" }, 503);
    let id: string;
    try {
      id = decodeURIComponent(encoded);
    } catch {
      id = "";
    }
    // The wait for health is bounded below the request's idle deadline.
    server.timeout(request, 30);
    try {
      const result = await modules.ensure(id, {
        mayStart,
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
      // Whom the gateway's own answer to this request's admission named, by
      // the subject and the Lazurio username: used only for the membership
      // of the Environment's vault (decision F11's amendments of 2026-10-14
      // and 2026-10-16). Locally nobody is named.
      let person: AdmittedPerson = nobody;
      const ensureRequest = ensureRoute.exec(url.pathname);
      // The readiness call of the gateway's loopback entry for the
      // Environment browser (#504): an `ensure` without a session, answered
      // before the admission and nothing else (`isLocalEnsure`).
      if (
        trust !== null &&
        ensureRequest !== null &&
        isLocalEnsure(
          {
            headers: request.headers,
            peer: server.requestIP(request)?.address ?? null,
          },
          server.port ?? 0,
        )
      )
        return answerEnsure(
          request,
          server,
          ensureRequest[1] as string,
          localEnsureMayStart(request.headers),
        );
      if (trust !== null && shell !== null) {
        // Hosted: the gateway's admission, revalidated here; the request's
        // own URL is loopback and is not evidence of anything.
        const admission = await trust.admit(request);
        if (!admission.ok)
          return response({ error: "denied", reason: admission.reason }, 401);
        person = { subject: admission.subject, username: admission.username };
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
          return fromShell(request, url.pathname, (page) =>
            page.ok ? answer.status : page.status,
          );
        }
        // A guide video, answered here and not through the inner listener,
        // so that its byte range reaches it (guide-video-files.ts).
        if (
          (request.method === "GET" || request.method === "HEAD") &&
          isGuideVideoPath(url.pathname)
        )
          return guideVideoAnswer(
            request,
            url.pathname.slice(guideVideoPath.length),
          );
        if (
          request.method === "GET" &&
          !url.pathname.startsWith("/api/") &&
          !isLazurioDocument(url.pathname)
        ) {
          // What a public Environment does not have answers as absent: the
          // page itself, which shows Apps or Settings in its place. Its
          // vault is read only for Trezor's own routes.
          const route = pageRoute(url.pathname);
          const absent =
            publicEnvironment &&
            withheldInPublic(route, {
              vault: route.view === "vault" && (await vaultListedHere()),
            });
          return fromShell(
            request,
            `${url.pathname}${url.search}`,
            (page) => (page.ok && absent ? 404 : page.status),
            // Nová karta is framed only by the Environment's own apps (F47
            // point 1).
            url.pathname === newTabPagePath && entry !== null
              ? newTabPageHeaders(entry)
              : {},
          );
        }
      } else if (!admitLocal(request, origin, token))
        return response({ error: "denied" }, 403);
      if (url.pathname === shellDocumentPath) {
        // The Lazurio shell's data (decision F36): this Environment, its
        // Organizations and the addresses of its apps, behind the same
        // admission as every read (the token locally, the gateway's session
        // hosted). Read-only, recomputed on every read from the catalog as
        // this Launchpad keeps it (catalog-reading.ts), but for what the
        // Environment lacks: that comes from the last reading and is never
        // awaited (F36's addendum of 2026-10-08), so the rail never waits
        // for GitHub.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        try {
          const [inputs, tailnet, theme] = await Promise.all([
            readShellInputs(folder, {
              ownerKey: hostedOptions.ownerKey,
              catalog: catalog.read,
            }),
            (hostedOptions.offlineTailnet ?? machineTailnet)(),
            themeStore.read(),
          ]);
          // GitHub and the content only where the Environment signs in as
          // its person (setup-state.ts).
          const known = signsInAsPerson(inputs.preset)
            ? setup.peek()
            : undefined;
          // Whether the elements register the offline guide's worker
          // (decision F41): only where the worker's address serves it. The
          // Environment's theme always (root decision 0208).
          return response(
            withOfflineGuide(
              shellDocument({
                ...inputs,
                ...(known === undefined ? {} : { setup: known }),
                theme: shellThemeOf(theme),
              }),
              tailnet,
            ),
          );
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (
        url.pathname === offlineGuidePath ||
        url.pathname === offlineWorkerPath
      ) {
        // The offline guide (decision F41): the page an address of this
        // Environment shows when the network fails, and the worker that keeps
        // it. The page only where the Environment is a node of a tailnet; the
        // worker's address everywhere, elsewhere with the retiring worker, so
        // a worker installed before never outlives the guide. Behind the same
        // admission as every read, recomputed on every read from the kept
        // catalog.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        try {
          const tailnet = await (
            hostedOptions.offlineTailnet ?? machineTailnet
          )();
          let page: string | null = null;
          if (tailnet !== null)
            page = offlineGuidePage(
              shellDocument(
                await readShellInputs(folder, {
                  ownerKey: hostedOptions.ownerKey,
                  catalog: catalog.read,
                }),
              ),
              tailnet,
            );
          if (url.pathname === offlineWorkerPath)
            return new Response(
              offlineWorker(page, embeddedIdentity().version),
              {
                headers: offlineWorkerHeaders,
              },
            );
          return page === null
            ? response({ error: "not-found" }, 404)
            : new Response(page, { headers: offlineGuideHeaders });
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
        if (promptAudience(id) === "personalspace-holder") {
          // The personal space's "+ Nový modul" (`new-personal-module`):
          // only for the account that holds the Personalspace, decided now
          // as `GET /api/content` decides it (#186), and only by its own
          // login.
          if (login === null || keys.length !== 1) return notFound();
          try {
            server.timeout(request, 30);
            const holder = await personalspace.decide(folder);
            const current = await withFolderReadLock(state, () =>
              readFolderState(state),
            );
            const document = personalModuleDocument(
              folder,
              holder,
              login,
              folderMessages(current.preferences),
            );
            return document === null ? notFound() : response(document);
          } catch {
            return notFound();
          }
        }
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
            const copy = folderMessages(current.preferences);
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
            organizationsOnly(await catalog.read()),
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
              folderMessages(current.preferences),
            ),
          );
        } catch {
          return notFound();
        }
      }
      if (url.pathname === chatPairingPath) {
        // The Environment pairs its own browser (decision of 2026-10-17):
        // T3 Code's web client, without a session, asks here on its own
        // origin, which the gateway forwards behind the same admission. Only
        // a page's own fetch (chat.ts), only where Chat is T3 Code behind
        // this Launchpad, minted for the admitted person exactly as
        // `POST /api/chat/pair` mints. On exactly Buddy's recorded origin
        // it is his own T3 Code's pairing instead (F61's addendum of
        // 2026-10-22). A HEAD mints nothing.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        if (entry === null) return response({ error: "not-found" }, 404);
        if ([...url.searchParams.keys()].length > 0)
          return response({ error: "invalid-request" }, 400);
        if (!isOwnScriptFetch(request.headers))
          return response({ error: "not-allowed" }, 403);
        // `t3 lazurio capabilities`, then the pairing call: 15 s each.
        server.timeout(request, 45);
        try {
          const pairing = asksForBuddy(entry, request.headers)
            ? await mintBuddyPairing(toolsEnvironment, person)
            : await mintChatPairing(entry, toolsEnvironment, person);
          return response(pairing, pairing.kind === "blocked" ? 409 : 200);
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (url.pathname === mausbotPairingPath) {
        // MausBot pairs its own browser as T3 Code does (the addendum of
        // 2026-10-22 to the decision of 2026-10-17): its web client, without
        // a session, asks here on its own origin, which the gateway forwards
        // behind the same admission. The chat self-pairing's guards in the
        // same order, only where the entry records MausBot, minted exactly as
        // `POST /api/mausbot/pair` mints. A HEAD mints nothing.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        if (entry?.mausbotOrigin === undefined)
          return response({ error: "not-found" }, 404);
        if ([...url.searchParams.keys()].length > 0)
          return response({ error: "invalid-request" }, 400);
        if (!isOwnScriptFetch(request.headers))
          return response({ error: "not-allowed" }, 403);
        server.timeout(request, 30);
        try {
          const pairing = await mintMausbotPairing(entry);
          return response(pairing, pairing.kind === "blocked" ? 409 : 200);
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (
        url.pathname === browserViewDocumentPath ||
        url.pathname === browserViewPath
      ) {
        // The Environment browser's people's view (decisions F38 and F39),
        // behind the same admission as every read: the address of one
        // agent-browser session's tab, opened when it has none, or of a new
        // remote tab without a session. The JSON answer is for the panels;
        // the hand-over redirects a link's browser there. Only `session`,
        // and only a name agent-browser accepts.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        const keys = [...url.searchParams.keys()];
        const session = url.searchParams.get("session");
        if (
          keys.some((key) => key !== "session") ||
          keys.length > 1 ||
          (session !== null && !isStrip(session))
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
      if (url.pathname === "/api/ai") {
        // Read-only and behind the same admission as every read: whether an
        // agent can work here, as Codex and Claude Code answer (root
        // decision 0201 point 6, tools/ai.ts), kept a minute.
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        const keys = [...url.searchParams.keys()];
        const fresh = url.searchParams.get("fresh");
        if (
          keys.some((key) => key !== "fresh") ||
          keys.length > 1 ||
          !(fresh === null || fresh === "1")
        )
          return response({ error: "invalid-request" }, 400);
        // Začínáme's "Zkontrolovat znovu" asks the CLIs now, and the shell
        // document follows.
        if (fresh === "1") {
          ai.forget();
          setup.forget();
        }
        server.timeout(request, 30);
        return response({ kind: "ai", ...(await ai.state()) });
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
            organizationsOnly(await catalog.read()),
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
            organizationsOnly(await catalog.read()),
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
      if (ensureRequest !== null) {
        // Only behind a gateway: a workstation has no module hostnames.
        if (trust === null) return response({ error: "not-found" }, 404);
        return answerEnsure(
          request,
          server,
          ensureRequest[1] as string,
          ensureMayStart(request.headers),
        );
      }
      const moduleRequest = moduleRoute.exec(url.pathname);
      if (moduleRequest !== null) {
        if (request.method !== (moduleRequest[3] === "status" ? "GET" : "POST"))
          return response({ error: "method-not-allowed" }, 405);
        if (closing) return response({ error: "closing" }, 503);
        let name: string;
        let app: string | undefined;
        // A static app's development version, explicitly (decision F58).
        let dev = false;
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
            const withDev =
              moduleRequest[3] === "start" &&
              ownDataValue(input, "dev") !== undefined;
            const value = stateFields(input, [
              ...(withApp ? ["app"] : []),
              ...(withDev ? ["dev"] : []),
            ]);
            if (withApp && typeof value.app !== "string")
              return response({ error: "invalid-app" }, 400);
            if (withDev && typeof value.dev !== "boolean")
              return response({ error: "invalid-dev" }, 400);
            app = value.app as string | undefined;
            dev = value.dev === true;
          }
        } catch (error) {
          if (error instanceof BodyTooLarge)
            return response({ error: "body-too-large" }, 413);
          return response({ error: "invalid-request" }, 400);
        }
        const options = {
          ...(app === undefined ? {} : { app }),
          ...(dev ? { dev } : {}),
        };
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
          if (
            ["start", "prepare", "build"].includes(moduleRequest[3] as string)
          )
            server.timeout(request, 660);
          const result =
            moduleRequest[3] === "start"
              ? await modules.start(name, options, answer)
              : moduleRequest[3] === "prepare"
                ? await modules.prepare(name, options, answer)
                : moduleRequest[3] === "build"
                  ? await modules.build(name, options, answer)
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
      // A public Environment has no sign-in and no Integrace (root decision
      // 0204 point 4): Nástroje and Integrace (the Try overlay's `withheld`)
      // answer as absent, before anything signs a tool in, installs it or
      // reads Executor or Composio. Trezor follows the vault core (plan
      // DEV-6668 slice 6, as in `withheldInPublic`): without its own vault
      // its API answers as absent too, before anything reads the vault.
      if (
        publicEnvironment &&
        (isToolsApiPath(url.pathname) ||
          integrations.handles(url.pathname) ||
          ((vaultPage.handles(url.pathname) ||
            vaultRequests.handles(url.pathname) ||
            vaultConnection.handles(url.pathname)) &&
            !(await vaultListedHere())))
      )
        return response({ error: "not-found" }, 404);
      // The theme reads everywhere; on a public Environment its change is
      // refused (theme-routes.ts, root decision 0208 point 6).
      if (themes.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await themes.handle(request, url);
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      // Buddy (decision F63): 404 `buddy-absent` without his recorded origin;
      // every POST, the poll included, came through the same-origin rule of
      // the admission above.
      if (buddy.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await buddy.handle(request, url, (seconds) =>
            server.timeout(request, seconds),
          );
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (content.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          const answer = await content.handle(request, url, (seconds) =>
            server.timeout(request, seconds),
          );
          // An installation changes what the Environment lacks: the shell
          // says nothing of it until it is read again, now and once the
          // installation ends.
          if (
            url.pathname === "/api/content/install" &&
            answer.status === 202
          ) {
            setup.forget();
            personalspace.forget();
            catalog.forget();
            void content.settled().then(() => {
              setup.forget();
              personalspace.forget();
              catalog.forget();
            });
          }
          return answer;
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (integrations.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          // "Check connections" asks the Organization's settings first:
          // they decide whether Composio is a path here (decision F45).
          if (
            url.pathname === "/api/integrations" &&
            url.searchParams.get("refresh") === "1"
          ) {
            server.timeout(request, 120);
            await settings?.nudge(settingsWaitMs);
          }
          return await integrations.handle(request, url, (seconds) =>
            server.timeout(request, seconds),
          );
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (ssh.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await ssh.handle(request, url);
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (vaultPage.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        // The membership asks the vault a few times (members, an
        // invitation, a confirmation).
        server.timeout(request, 300);
        try {
          return await vaultPage.handle(request, url, person);
        } catch {
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (vaultRequests.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await vaultRequests.handle(request, url, (seconds) =>
            server.timeout(request, seconds),
          );
        } catch {
          // Never a value, a path or an output of bw.
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (vaultConnection.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        // Connecting asks the cloud a few times and derives the master key;
        // disconnecting signs bw out.
        server.timeout(request, 120);
        try {
          return await vaultConnection.handle(request, url);
        } catch {
          // Never a value, a path or an output of bw.
          return response({ error: "operation-failed" }, 500);
        }
      }
      if (newTab.handles(url.pathname)) {
        if (closing) return response({ error: "closing" }, 503);
        try {
          return await newTab.handle(request, url, (seconds) =>
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
      let changesTools = false;
      try {
        const input: unknown = await readJsonBody(request);
        if (closing) return response({ error: "closing" }, 503);
        changesTools = toolsChangePaths.has(url.pathname);
        if (changesTools) toolsReading.forget();
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
          // this admitted browser, minted by T3's own CLI for its person.
          // Only behind a gateway: a workstation's T3 Code is wherever the
          // operator runs it. Kept although T3 Code now pairs itself
          // (`GET /.lazurio/chat/pairing`): older T3 Code builds need it.
          stateFields(input, []);
          if (entry === null) return response({ error: "not-found" }, 404);
          server.timeout(request, 45);
          const result = await issueChatLink(entry, toolsEnvironment, person);
          return response(result, result.kind === "blocked" ? 409 : 200);
        }
        if (url.pathname === "/api/mausbot/pair") {
          // Lazurio MausBot (DEV-6632): a one-time pairing link, minted by
          // MausBot's own API on its recorded loopback port. Only on a
          // Machine whose entry records MausBot. Kept although MausBot now
          // pairs itself (`GET /.lazurio/mausbot/pairing`): older MausBot
          // builds need it.
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
          try {
            return response(await operation(input));
          } finally {
            // A preparation may write what the catalog reads of a module.
            if (
              ["/api/apps/prepare", "/api/apps/clean-prepare"].includes(
                url.pathname,
              )
            )
              catalog.forget();
          }
        }
        if (url.pathname === "/api/catalog") {
          // The Launchpad home (launchpad-parity B1): the Organizations and
          // modules of this Folder, the same catalog as `lazurio organization
          // list --json`, as this Launchpad keeps it while nothing it depends
          // on changed (catalog-reading.ts). Nothing is written. Its
          // Personalspace group follows the last decision whose it is and
          // never waits for GitHub (#186).
          stateFields(input, []);
          return response(await catalog.read());
        }
        if (url.pathname === "/api/profile") {
          stateFields(input, []);
          const current = await withFolderReadLock(state, () =>
            readFolderState(state),
          );
          // The preset and the communication axes are changeable; the Machine
          // binding is shown and never accepted back from the browser. The
          // presets offered are those a change may end on: the recorded one
          // and what the handover offers as a new choice (issue #107); on a
          // public Environment, whose Try overlay fixes the preset (F55's
          // addendum of 2026-10-20), the recorded one alone.
          return response({
            revision: current.preferences.revision,
            preset: current.preferences.preset,
            allowedPresets: isFixed(current.preferences.machine, "preset")
              ? [current.preferences.preset.name]
              : selectablePresets(
                  current.preferences.machine,
                  current.preferences.preset.name,
                ),
            machine: current.preferences.machine,
            profile: current.preferences.profile,
            voice: resolvedVoice(
              current.preferences.profile.locale,
              current.preferences.agentVoice,
            ),
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
          // asks for them with `signIn: true`. The live facts come from the
          // reading kept a minute unless the body asks for `fresh: true`;
          // with `allowStale: true` an older reading answers at once, marked
          // `stale`, while a new one runs (tools-reading.ts). The recorded
          // part is read every time.
          const asked = ["signIn", "fresh", "allowStale"].filter(
            (field) => ownDataValue(input, field) !== undefined,
          );
          const value = stateFields(input, asked);
          for (const [field, error] of [
            ["signIn", "invalid-sign-in"],
            ["fresh", "invalid-fresh"],
            ["allowStale", "invalid-allow-stale"],
          ] as const)
            if (asked.includes(field) && typeof value[field] !== "boolean")
              return response({ error }, 400);
          const signIn = value.signIn === true;
          let reading = toolsReading.answer(signIn, {
            fresh: value.fresh === true,
            allowStale: value.allowStale === true,
          });
          // Met by the overview below; a refusal before it is not the
          // reading's to report.
          void reading.done.catch(() => undefined);
          // The first reading and "Refresh status" ask the Organization's
          // settings first, so the switches show what applies now (F45),
          // while the tools are read; a stale answer does not wait for them,
          // and the reading after it does.
          if (signIn && !reading.stale) {
            server.timeout(request, 120);
            await settings?.nudge(settingsWaitMs);
          }
          let overview = await toolsOverview(folder, toolsWithProofs, {
            signIn,
            live: () => reading.done,
          });
          // A change through this Launchpad while the tools were read (a
          // sign-in, link or sign-out, an installation: `forget`) leaves the
          // reading from before it: the tools are read again, so neither the
          // answer nor the shell's GitHub below carries the facts from before
          // the change (Pablo's review of #524). Three such changes in a row
          // end as a refusal the page meets as a failed reading, never as the
          // older facts.
          for (let again = 0; !reading.stale && !reading.current(); again++) {
            if (again === 3) return response({ error: "tools-changing" }, 503);
            const anew = toolsReading.answer(signIn);
            void anew.done.catch(() => undefined);
            reading = anew;
            overview = await toolsOverview(folder, toolsWithProofs, {
              signIn,
              live: () => anew.done,
            });
          }
          // The shell document's GitHub, and whose Personalspace this is,
          // follow a current reading.
          const gh = overview.tools.find((tool) => tool.name === "gh");
          if (
            !reading.stale &&
            gh !== undefined &&
            github.remember(gh.installed, gh.signIn)
          ) {
            setup.forget();
            personalspace.forget();
          }
          return response({
            ...overview,
            ...(reading.stale ? { stale: true } : {}),
            ...(settings === null
              ? {}
              : { organizationSettings: settings.status() }),
          });
        }
        if (vault.handles(url.pathname)) {
          // The Environment's vault (decisions F43, F53): `{}`, or a setup's
          // `{job}`; a setup answers within a second and goes on
          // (vault-routes.ts).
          const withJob =
            url.pathname === "/api/tools/bitwarden/setup" &&
            ownDataValue(input, "job") !== undefined;
          const value = stateFields(input, withJob ? ["job"] : []);
          if (withJob && !isVaultJob(value.job))
            return response({ error: "invalid-job" }, 400);
          server.timeout(request, 300);
          const answer = await vault.handle(
            url.pathname,
            withJob ? (value.job as string) : undefined,
          );
          if (url.pathname === "/api/tools/bitwarden/setup")
            forgetToolsAfter(vault.settled());
          return response(answer.body, answer.status);
        }
        if (executor.handles(url.pathname)) {
          // Executor (decision F44): `{}`, or a setup's `{job}`; a setup
          // answers within a second and goes on (executor-routes.ts).
          const withJob =
            url.pathname === "/api/tools/executor/setup" &&
            ownDataValue(input, "job") !== undefined;
          const value = stateFields(input, withJob ? ["job"] : []);
          if (withJob && !isExecutorJob(value.job))
            return response({ error: "invalid-job" }, 400);
          server.timeout(request, 300);
          const answer = await executor.handle(
            url.pathname,
            withJob ? (value.job as string) : undefined,
          );
          if (url.pathname === "/api/tools/executor/setup")
            forgetToolsAfter(executor.settled());
          return response(answer.body, answer.status);
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
          // ChatGPT's sign-in by code (root decision 0201 point 10), codex's
          // fallback for its browser sign-in.
          const withDeviceCode =
            url.pathname === "/api/tools/login/start" &&
            ownDataValue(input, "deviceCode") !== undefined;
          const fields: Record<string, readonly string[]> = {
            "/api/tools/install": ["tool"],
            "/api/tools/upgrade": ["tool"],
            "/api/tools/login/start": [
              "tool",
              ...(withPhone ? ["phone"] : []),
              ...(withSshKey ? ["sshKey"] : []),
              ...(withDeviceCode ? ["deviceCode"] : []),
            ],
            "/api/tools/login/poll": ["tool", "session"],
            "/api/tools/login/cancel": ["tool", "session"],
            "/api/tools/login/code": ["tool", "session", "code"],
            "/api/tools/logout": ["tool"],
            "/api/tools/composio/organizations": [],
            "/api/tools/composio/organization": ["id"],
          };
          const value = stateFields(input, fields[url.pathname] ?? []);
          if (url.pathname === "/api/tools/composio/organizations") {
            server.timeout(request, 60);
            // An Organization's Environment works in the Composio
            // organization of its Organization's name, made current here
            // after the sign-in (decision F42, addendum of 2026-10-13); the
            // person chooses elsewhere.
            const { preferences } = await withFolderReadLock(state, () =>
              readFolderState(state),
            );
            const rule = await composioOrganizationRule(
              folder,
              preferences.machine,
            );
            if (rule.kind === "chosen")
              return response({
                ...(await logins.composioOrganizations()),
                organization: null,
                // By advice the account's default organization.
                personal: preferences.preset.name === "hosted-personal",
              });
            // An Organization's name that cannot be read is said, never
            // guessed, and nothing is switched.
            if (rule.kind === "unverified") {
              const listed = await logins.composioOrganizations();
              return response(
                listed.kind === "composio-organizations"
                  ? {
                      ...listed,
                      organization: { name: null, state: "unverified" },
                    }
                  : listed,
              );
            }
            const command = await resolveOnPath(
              "composio",
              toolsEnvironment.path,
              toolsEnvironment.platform,
            );
            const converged =
              command === undefined
                ? null
                : await convergeComposioOrganization(
                    toolsEnvironment,
                    command,
                    rule,
                    (entry) => {
                      console.log(JSON.stringify(entry));
                      // Composio's sign-in now names another organization.
                      if (entry.outcome === "switched") toolsReading.forget();
                    },
                  );
            if (converged === null)
              return response({
                kind: "composio-organizations-failed",
                reason: "unreadable",
              });
            // Found or made current: the Integrace reading the Launchpad
            // keeps for a minute may still say it is missing, so the next
            // one reads again (the end-to-end test of 2026-10-19).
            if (converged.verdict.kind === "matches") integrations.forget();
            return response({
              kind: "composio-organizations",
              organizations: converged.organizations,
              organization: { name: rule.name, state: converged.verdict.kind },
            });
          }
          if (url.pathname === "/api/tools/composio/organization") {
            if (
              typeof value.id !== "string" ||
              !/^[A-Za-z0-9_-]{1,100}$/.test(value.id)
            )
              return response({ error: "invalid-organization" }, 400);
            server.timeout(request, 60);
            const selected = await logins.selectComposioOrganization(value.id);
            // Integrace's links lead into the organization now current, and
            // Composio's sign-in names it.
            if (selected.kind === "composio-organization-selected") {
              integrations.forget();
              toolsReading.forget();
            }
            return response(selected);
          }
          const tool = value.tool;
          if (typeof tool !== "string")
            return response({ error: "invalid-tool" }, 400);
          // codex and claude only sign in here, from Začínáme's AI step (F19's
          // addendum of 2026-10-15): no installation, update or sign-out, and
          // they are no catalog tools of agents.
          const aiTool = isAiProvider(tool);
          if (
            aiTool
              ? !url.pathname.startsWith("/api/tools/login/")
              : !activatableTools().some((entry) => entry.name === tool)
          )
            return response(
              { kind: "blocked", reason: "tool-unknown", tool },
              409,
            );
          // The Environment vault has its own routes (decision F43).
          if (tool === vaultToolName)
            return response(
              { kind: "blocked", reason: "setup-vault", tool },
              409,
            );
          // So does Executor, which Lazurio sets up itself (decision F44).
          if (tool === executorToolName)
            return response(
              { kind: "blocked", reason: "setup-executor", tool },
              409,
            );
          if (!aiTool && curatedTool(tool) === undefined)
            return response(
              { kind: "blocked", reason: "setup-agent", tool },
              409,
            );
          // A code only for a sign-in that waits for one (claude's code
          // page); never logged or answered.
          if (url.pathname === "/api/tools/login/code") {
            if (
              typeof value.session !== "string" ||
              !/^[0-9a-f]{32}$/.test(value.session)
            )
              return response({ error: "invalid-session" }, 400);
            const taken = logins.code(tool, value.session, value.code);
            return taken === "accepted"
              ? response({ kind: "code-accepted", tool })
              : response(
                  { error: taken },
                  taken === "invalid-code" ? 400 : 409,
                );
          }
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
          // A tool's own update (`lazurio tools update`), only where it is
          // its curated installer at the build Lazurio pins (composio,
          // decision F42 addendum (3)): "Update" in Settings → Tools, the
          // person's click being the consent. One run of a tool's installer
          // at a time, an installation's or an update's.
          if (url.pathname === "/api/tools/upgrade") {
            if (findTool(tool)?.updater.kind !== "curated")
              return response(
                { kind: "blocked", reason: "update-unavailable", tool },
                409,
              );
            if (installing.has(tool))
              return response({ kind: "blocked", reason: "busy", tool }, 409);
            installing.add(tool);
            server.timeout(request, 660);
            try {
              return response(
                await toolsUpdate({
                  tool,
                  path: toolsEnvironment.path,
                  home: toolsEnvironment.home,
                  platform: toolsEnvironment.platform,
                  run: toolsEnvironment.run,
                  install: {
                    xdg: toolsEnvironment.xdg,
                    fetch: curatedOptions.fetch,
                    arch: curatedOptions.arch,
                  },
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
          // A sign-in or sign-out of gh changes what the shell says, and
          // whose Personalspace this is. (A sign-in of codex or claude
          // changes what the AI is when it ends: the sessions' journal.)
          if (tool === "gh") {
            github.forget();
            setup.forget();
            personalspace.forget();
          }
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
              value.deviceCode !== undefined &&
              (value.deviceCode !== true ||
                tool !== "codex" ||
                value.sshKey !== undefined)
            )
              return response({ error: "invalid-device-code" }, 400);
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
            const started = await logins.start(tool, {
              ...(typeof value.phone === "string"
                ? { phone: value.phone }
                : {}),
              ...(value.sshKey === true ? { sshKey: true } : {}),
              ...(value.deviceCode === true ? { deviceCode: true } : {}),
            });
            // Signed in: what connects the apps changed (decision F42,
            // note of 2026-10-19), so Integrace read again.
            if (started.kind === "signed-in") integrations.forget();
            // A refusal before anything ran (codex and claude without the
            // Environment browser, or with the Organization's AI) is one as
            // every other.
            return response(
              withQr(started),
              started.kind === "blocked" ? 409 : 200,
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
          const answered =
            url.pathname === "/api/tools/login/poll"
              ? withQr(logins.poll(tool, handle))
              : logins.cancel(tool, handle);
          if (answered.kind === "signed-in") integrations.forget();
          return response(answered);
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
          // A tool switched on or off for agents changes what connects the
          // apps (Composio's "Používají agenti", decision F42, note of
          // 2026-10-19): Integrace read again, the connect route too.
          if (result.kind === "updated") integrations.forget();
          return response(
            result.kind === "blocked"
              ? result
              : { ...result, ...sharedSignInsWarning(recorded, value.tools) },
            result.kind === "blocked" ? 409 : 200,
          );
        }
        if (!["/api/preview", "/api/update"].includes(url.pathname))
          return response({ error: "not-found" }, 404);
        const withVoice = ownDataValue(input, "voice") !== undefined;
        const withPreset = ownDataValue(input, "preset") !== undefined;
        const value = stateFields(input, [
          "expectedRevision",
          "profile",
          ...(withPreset ? ["preset"] : []),
          ...(withVoice ? ["voice"] : []),
        ]);
        const expectedRevision = revisionOf(value.expectedRevision);
        if (expectedRevision === null)
          return response({ error: "invalid-revision" }, 400);
        const operation =
          url.pathname === "/api/update" ? updateProfile : inspectProfileChange;
        const result = await operation(folder, expectedRevision, {
          profile: value.profile,
          ...(withPreset ? { preset: value.preset } : {}),
          ...(withVoice ? { voice: value.voice } : {}),
        });
        // A profile change that makes this a Team Environment ends a running
        // gh sign-in or key linking at once: its holder reads the refusal.
        if (url.pathname === "/api/update" && result.kind === "updated") {
          // The preset may have changed whether the shell says anything, and
          // what the catalog says of the Personalspace and the secrets.
          setup.forget();
          catalog.forget();
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
      } finally {
        // Answered, whether it succeeded or not (`toolsChangePaths`).
        if (changesTools) toolsReading.forget();
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
  settings?.start();
  // Whose Personalspace this is, decided once in the background now, so
  // that the page's first catalog already knows it. Reads no Folder lock.
  void personalspace.peek(folder).catch(() => undefined);
  // The page's first open finds the catalog read (catalog-reading.ts), in
  // the background once whose Personalspace this is was decided; and, on an
  // installed Launchpad, the service of its base, the tools read with their
  // sign-ins, as its page asks for them on its load (tools-reading.ts). Not
  // on a public Environment, which has no tools.
  const warming = personalspace
    .settled()
    .then(() => (closing ? undefined : catalog.read()))
    .then(
      () => undefined,
      () => undefined,
    );
  if (installed !== undefined && !publicEnvironment) toolsReading.warm();
  // The Launchpad's holds, reconciled with the hub's list from now on.
  await holder?.start();
  // Executor (decision F44, addendum of 2026-10-11, #298): where install and
  // update only report it, this Launchpad sets it up in the background once
  // it listens, through the one setup of Settings → Tools. Never awaited and
  // never a reason for the start to fail; one attempt per start, so a setup
  // that stops waits for the row's action. Closing is asked after each wait:
  // here before the state is read, and by the routes before the setup.
  const executorAtStart = installed?.executorAtStart;
  if (executorAtStart !== undefined)
    void (async () => {
      if ((await executorAtStart()) && !closing && (await executor.atStart()))
        // Once it has ended, the tools are read again for the page.
        void executor
          .settled()
          .catch(() => undefined)
          .then(() => {
            toolsReading.forget();
            if (!closing) toolsReading.warm();
          });
    })().catch(() => undefined);
  // The Environment's own vault (decision F53), by the same pattern: where
  // the vault needs it, the one setup of Settings → Tools runs in the
  // background once the Launchpad listens; never awaited, never a reason for
  // the start to fail, one attempt per start.
  const vaultAtStart = installed?.vaultAtStart;
  // The Správci of a work Environment leave its vault when it is assigned to
  // someone else (F53's addendum of 2026-10-14): looked at once the start's
  // setup has ended, then every five minutes, never waiting for anyone to
  // open the vault page. A look reads the handover and one local file; only
  // a changed assignment asks the vault. One look at a time.
  let audienceTimer: ReturnType<typeof setInterval> | undefined;
  let looking = false;
  const lookAtAudience = () => {
    if (closing || looking) return;
    looking = true;
    void vaultPage
      .audience()
      .catch(() => undefined)
      .finally(() => {
        looking = false;
      });
  };
  if (vaultAtStart !== undefined)
    void (async () => {
      if (!(await vaultAtStart()) || closing) return;
      await vault.atStart();
      await vault.settled();
      toolsReading.forget();
      if (!closing) toolsReading.warm();
      if (closing) return;
      lookAtAudience();
      audienceTimer = setInterval(lookAtAudience, vaultAudienceEveryMs);
    })().catch(() => undefined);
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
    /** Resolves when the reads this Launchpad began on its own in the
     * background have ended: whose Personalspace this is, decided at its
     * start, and the shell's setup, read again after a change. No answer
     * waits for them (none waits for GitHub); what observes what the
     * Launchpad asks GitHub or its Folder waits here first, so that it
     * observes the request it makes and not the start's own work. */
    async settled(): Promise<void> {
      await Promise.all([personalspace.settled(), setup.settled(), warming]);
    },
    close() {
      closing = true;
      clearInterval(audienceTimer);
      catalog.close();
      buddyPersona.close();
      if (!closePending)
        closePending = (async () => {
          // Close admission immediately, before waiting for HTTP requests to drain.
          // Existing requests and shutdown must share the same lifecycle queue.
          const applicationClose = applications?.close();
          const moduleClose = modules.close();
          const loginClose = logins.close();
          pill?.stop();
          // No more questions; a Folder change in progress completes.
          const settingsClose = settings?.stop();
          await server.stop(true);
          // No more holds; a write under way completes.
          await holder?.stop();
          // An upload cut off by the stop removes its temporary file first.
          await files.close();
          await shell?.stop();
          await health?.stop(true);
          await loginClose;
          await settingsClose;
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
