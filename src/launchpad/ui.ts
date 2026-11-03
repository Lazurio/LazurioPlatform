import { pageAccountJson, pageReentry, sessionRefused } from "../shell/account";
import { buddyAvatarSource } from "../shell/buddy-protocol";
import {
  currentEnvironment,
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellEnvironmentKind,
} from "../shell/contract";
import {
  defineShellElements,
  guideAttention,
  provideGuides,
  provideShell,
} from "../shell/elements";
import { shellMessages } from "../shell/messages";
import { environmentName, switchTabs } from "../shell/view";
import { type AiReading, parseAiAnswer } from "../tools/ai";
import type { ToolsOverview } from "../tools/overview";
import { accountWriter, readAccount } from "./account";
import { aiSignInPlace, createAiSignIn } from "./ai-sign-in";
import { personalHolderOf, pluralKey } from "./apps-view";
import { bootElementId, parseBoot } from "./boot";
import { createBrowserPanel } from "./browser-panel";
import { browserPanelOrigin } from "./browser-panel-view";
import { createBuddyClient } from "./buddy-client";
import { createBuddyDialog, tickCountdowns } from "./buddy-dialog";
import { createBuddyPanel } from "./buddy-panel";
import { createTelegramDialog } from "./buddy-telegram-dialog";
import { type BuddyStepFacts, buddyFact, meetStart } from "./buddy-view";
import { createCatalogPanel, type NewModuleOutcome } from "./catalog-panel";
import type { PublicEntry } from "./chat";
import {
  chatHref,
  chatPromptHref,
  isNoEntry,
  type PromptLink,
  parseEntryAnswer,
  parsePromptHandoff,
} from "./chat-view";
import { type ContentTransport, createContentClient } from "./content-client";
import { createContentPanel } from "./content-panel";
import { prepareContext, preparePrompt } from "./content-view";
import { createFilesPanel } from "./files-panel";
import {
  type AiFact,
  type AutoStart,
  appsSetupLine,
  autoStartStep,
  composioFact,
  contentBlockedBy,
  createComposioOrganizationReader,
  githubAccount,
  githubFact,
  hasOnboarding,
  idleAutoStart,
  nextBasic,
  personaGithub,
  readFragment,
  resolveOf,
  responsibleLogin,
  type SetupAction,
  type StartRequest,
  shellSetup,
  startDecision,
  startSection,
  type TourFacts,
  withBuddySetup,
} from "./first-run";
import { type PageHelpId, pageGuide, pageHelpStates } from "./guides";
import { createIntegrationsPanel } from "./integrations-panel";
import { composioSignIn, toolSignInsKey } from "./integrations-view";
import { createColumn, keepCornerFree } from "./layout";
import {
  environmentFacts,
  type Fact,
  type MachineView,
  presetChoice,
} from "./machine-view";
import { createMarketplacePanel } from "./marketplace-panel";
import { type MessageKey, messages } from "./messages";
import { moduleCopy } from "./module-view";
import { createHelpVideo } from "./page-help";
import { isPublicEnvironment, publicRoute } from "./public-environment";
import { createRecoveryPanel } from "./recovery-panel";
import { type RecoveryMode, recoveryModeAnswer } from "./recovery-view";
import {
  type PageRoute,
  routeFrame,
  serviceRequest,
  settingsPath,
} from "./routes";
import { createShell } from "./shell";
import { createSshPanel } from "./ssh-panel";
import { keyGroups, parseSshOverview } from "./ssh-view";
import { createStartPanel, type StartVaultRow } from "./start-panel";
import { demoModule, demoStartView, startCount } from "./start-view";
import { createThemePanel } from "./theme-panel";
import { withAppsTheme } from "./theme-view";
import { createToolsPanel } from "./tools-panel";
import {
  organizationChoices,
  organizationRule,
  type ToolGuideTargets,
} from "./tools-view";
import { createTour } from "./tour";
import type { PillStatus } from "./update-pill";
import { pillView, pillVisible } from "./update-view";
import { createVaultPagePanel } from "./vault-page-panel";
import {
  bitwardenTarget,
  offersBitwarden,
  parseVaultMembership,
  parseVaultPage,
  type VaultPagePerson,
  vaultInApps,
  vaultPageView,
} from "./vault-page-view";
import { createVaultRequestsPanel } from "./vault-requests-panel";
import { pollWhileVisible } from "./visible-poll";
import { type VoiceView, voicePanel } from "./voice-panel";

// The fragment of the first address: locally the session token, and a start
// request of the first run (`#lazurio-start=…`, root decision 0188) from the
// line in Apps or the shell's column head in Chat and Automate.
const fragment = readFragment(location.hash);
const token = fragment.token;
let pendingStart: StartRequest | null = fragment.start;
history.replaceState(null, "", location.pathname);
// Local: the fragment token is the credential. Hosted (no token): the
// gateway's session cookie is, sent by the browser itself; a denial (a 401,
// or the update poll's redirect to the sign-in) means the session ended and
// the page re-enters through the gateway, at most once per tab within five
// minutes, the same guard as the shell's account read (F37's addendum of
// 2026-10-12). Defined first: the page's first drawing already reads with it.
const credential = (): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};
const reentry = pageReentry();
function denied(response: Pick<Response, "status" | "type">) {
  if (!token && sessionRefused(response)) reentry.refused();
}
const form = document.querySelector<HTMLFormElement>("#profile");
const choices = document.querySelector<HTMLFieldSetElement>("#choices");
const apply = document.querySelector<HTMLButtonElement>("#apply");
const status = document.querySelector<HTMLParagraphElement>("#status");
const result = document.querySelector<HTMLPreElement>("#result");
const machine = document.querySelector<HTMLDListElement>("#machine");
const machineSupport =
  document.querySelector<HTMLDetailsElement>("#machine-support");
const machineSupportList = document.querySelector<HTMLDListElement>(
  "#machine-support-list",
);
const presetSelect = document.querySelector<HTMLSelectElement>("#preset");
if (
  !form ||
  !choices ||
  !apply ||
  !status ||
  !result ||
  !machine ||
  !presetSelect ||
  !machineSupport ||
  !machineSupportList
)
  throw new Error("Missing UI");
const controls = {
  form,
  choices,
  apply,
  status,
  result,
  machine,
  presetSelect,
  machineSupport,
  machineSupportList,
};
// The boot document (F36's addendum of 2026-10-08, boot.ts): behind the
// gateway the page carries the Folder's language, the shell document, the
// catalog and the entry, so that it draws its final state at once and reads
// none of them again; a workstation's page carries none and reads them.
const boot = parseBoot(document.getElementById(bootElementId)?.textContent);
// A service's link (`/service/<id>`, root decision 0209 point 6, decision
// F32's addendum of 2026-10-24): the service whose page this load opens in
// the Environment browser, taken once from the address before the frame
// shows the Apps home under `/` in its place (`openAskedService`).
let askedService = serviceRequest(location.pathname);
let locale: "cs" | "en" = boot?.locale ?? "en";
// The catalog names the kind of this Environment wherever a text is about it
// (decision F28's addendum of 2026-10-18): the kind its shell document names,
// none until that is known.
const kindOf = (document: Shell | null): ShellEnvironmentKind | null =>
  document === null ? null : (currentEnvironment(document)?.kind ?? null);
let copy = messages(locale, kindOf(boot?.shell ?? null));
// The recorded entry's public parts (`GET /api/entry`); null on a workstation
// and until read. The tiles' module origins, Chat's origin for
// "+ Nový modul" and the Recovery page's T3 Code link.
let entry: PublicEntry | null = boot?.entry ?? null;
// Whether Chat on this Environment takes a prepared prompt by link
// (`GET /api/chat/prompt-handoff`, Lazurio/t3code#35): read alongside the
// entry, no until answered.
let chatTakesPrompts = false;
// The Lazurio shell (decision F36): the rail and the switch, drawn from
// this Environment's `/.lazurio/shell.json`, which the page reads with its
// own credential and hands over (the forks let the elements read it). The
// boot document's is handed over before the elements are defined, so they
// draw with the page's first paint. It is handed over with the
// Environment's theme as Apps shows it, light only (root decision 0208,
// theme-view.ts), into its place after the page's own tokens: the bundler
// links them at the end of <head>, so the place is there too. A hosted page
// carries it filled (boot-document.ts); a workstation's gets it here, empty,
// before the shell declares anything.
let shellDocument: Shell | null = boot?.shell ?? null;
if (document.querySelector("style[data-lazurio-environment-theme]") === null) {
  const place = document.createElement("style");
  place.dataset.lazurioEnvironmentTheme = "";
  document.head.append(place);
}
if (shellDocument !== null) provideShell(withAppsTheme(shellDocument));
defineShellElements();
const columnHead = document.querySelector<HTMLElement>("#column-head");
const rail = document.querySelector<HTMLElement>("#rail");
// The shell's guide (decision F56 and its addendum of 2026-10-18,
// guides.ts): the "?" right after the page's heading (the header's on
// Settings, Soubory and Trezor; the Apps home's and Integrace's in their own
// heads) and the explanations of the page shown, in the page's language and
// chosen by what the page knows; none in Recovery mode. Where Trezor's "?"
// opens the approved video instead, the page plays it in place
// (page-help.ts).
const pageHelps = Object.fromEntries(
  (["page-help", "catalog-help", "integrations-page-help"] as const).map(
    (id) => [id, document.querySelector<HTMLButtonElement>(`#${id}`)],
  ),
) as Readonly<Record<PageHelpId, HTMLButtonElement | null>>;
const buddy = document.querySelector<HTMLElement>("#buddy");
// Recovery mode ends the guide for the page's life (`enterRecovery`).
let guideOff = false;
/** What Settings → Nástroje's "?" can point at, as the tools panel last
 * drew it; null until the tools are read (`tools`'s `drawn`). */
let toolTargets: ToolGuideTargets | null = null;
/** The "?" of the page now shown when it opens a video (Trezor's). */
let videoHelp: HTMLButtonElement | null = null;
function drawGuide(route: PageRoute) {
  const guide = pageGuide(
    route,
    {
      kind: kindOf(shellDocument),
      locale,
      composio: integrations.composio(),
      vault: vaultPage.facts,
      // What Začínáme shows here, as its navigation decides (`firstRun`).
      start: isPublicEnvironment(entry)
        ? "demo"
        : profileState === null
          ? null
          : hasOnboarding(profileState.preset)
            ? "basics"
            : "none",
      tools: toolTargets,
      buddy: buddyHere(),
    },
    copy,
  );
  provideGuides(guideOff ? null : guide.guides);
  buddy?.setAttribute("lang", locale);
  const states = pageHelpStates(route, guide, guideOff);
  videoHelp = null;
  for (const id of Object.keys(pageHelps) as PageHelpId[]) {
    const help = pageHelps[id];
    if (help === null) continue;
    const state = states[id];
    help.hidden = state.hidden;
    if (state.plays !== null) help.dataset.guideHelp = state.plays;
    else delete help.dataset.guideHelp;
    if (state.controls !== null) {
      videoHelp = help;
      help.setAttribute("aria-controls", state.controls);
      help.setAttribute("aria-expanded", String(vaultVideo.open));
    } else {
      help.removeAttribute("aria-controls");
      help.removeAttribute("aria-expanded");
    }
    help.setAttribute("aria-label", copy.pageHelp);
    help.title = copy.pageHelp;
  }
  // Trezor's video stands open first where its words are true (F56's
  // addendum (4) of 2026-10-19); a new page is a new visit.
  vaultVideo.draw(videoHelp, JSON.stringify(route));
}
// The documentation of the Launchpad's "Guide" (the root Launchpad's
// `guideDocumentationUrl`), in the page's language.
const guide = document.querySelector<HTMLAnchorElement>("#catalog-guide");
// Whether the shell document was asked for once (read or not).
let shellRead = false;
// The page shows once it is drawn (F36's addendum of 2026-10-08, the
// stylesheet's `data-ready`): its language known, the shell document drawn
// or known to be missing, and what its frame shows first read (Apps the
// catalog, Settings the profile). At the latest a second after this script
// ran; the stylesheet shows it anyway after two.
let drawn = false;
const drawnAtTheLatest = setTimeout(() => markDrawn(), 1000);
function markDrawn() {
  if (drawn) return;
  drawn = true;
  clearTimeout(drawnAtTheLatest);
  document.documentElement.dataset.ready = "";
}
function showWhenDrawn() {
  if (drawn) return;
  if (recoveryMode === null) {
    const route = shell.route();
    if (boot === null && !loaded && !loadFailed) return;
    if (shellDocument === null && !shellRead) return;
    if (routeFrame(route) === "catalog" && catalog.reading()) return;
    if (route.view === "settings" && !loaded && !loadFailed) return;
  }
  markDrawn();
}
let toolsOverview: ToolsOverview | null = null;
// The tools' sign-ins as last observed, so Integrace follow a change.
let toolSignIns: string | null = null;
async function readShell() {
  try {
    const response = await fetch("/.lazurio/shell.json", {
      headers: credential(),
      cache: "no-store",
    });
    denied(response);
    const parsed = response.ok ? parseShell(await response.json()) : null;
    if (parsed === null) return;
    // Drawn again only when it says something else.
    const same =
      shellDocument !== null &&
      JSON.stringify(parsed) === JSON.stringify(shellDocument);
    shellDocument = parsed;
    if (same) return;
    provideShell(withAppsTheme(parsed));
    // A kind known only now (a workstation reads its document) names itself
    // in the page's words once they were written.
    const named = messages(locale, kindOf(parsed));
    if (named !== copy) {
      copy = named;
      if (labelled) relabel();
    }
    catalog.render();
    // A theme changed elsewhere (`lazurio theme`, another tab) is shown in
    // Settings too.
    theme.follow(parsed.theme);
  } catch {
    // The rail stays empty; the page itself works without it.
  } finally {
    shellRead = true;
    // The kind the explanations are chosen by may be known only now.
    if (framed) drawGuide(shell.route());
    drawMachine();
    // Buddy is known from the shell document: read him once.
    readBuddy();
    if (framed) drawBuddy();
    firstRun();
    showWhenDrawn();
  }
}
// The login of the personal space's verified holder, as the content routes
// last said it (#186): the personal "+ Nový modul" is its (root decision
// 0185's addendum of 2026-10-13). Null until the content is read.
let personalHolder: string | null = null;
// The Launchpad home: the catalog of this Folder's Organizations and modules
// (launchpad-parity B1), drawn for the route the frame shows.
const catalog = createCatalogPanel({
  catalog: boot?.catalog ?? null,
  setupLine: () => {
    const line = setupLineNow();
    lineDrawn = JSON.stringify(line);
    return line;
  },
  setupAction: (action) => setupAction(action),
  post: (path, body) => post(path, body),
  get: (path) => get(path),
  // A Team Environment's refusals name the Team's access, not a person's.
  copy: () =>
    moduleCopy(
      copy,
      shellDocument !== null &&
        currentEnvironment(shellDocument)?.kind === "team",
    ),
  route: () => shell.route(),
  navigate: (path) => shell.navigate(path),
  loaded: () => {
    shell.relabel();
    if (framed) marketplace.render();
    drawMachine();
    // A public Environment's Začínáme names the module to try.
    startPanel.render();
    showWhenDrawn();
    openAskedService();
  },
  entry: () => entry,
  avatar: (slug) =>
    shellDocument?.organizations.find(
      (organization) => organization.slug.toLowerCase() === slug.toLowerCase(),
    )?.avatar ?? null,
  environment: () => {
    if (shellDocument === null) return null;
    // A Launchpad's document always names its own Environment; only a host
    // page that is no Environment's has none (F36's addendum of 2026-10-05).
    const current = currentEnvironment(shellDocument);
    if (current === null) return null;
    return {
      name: environmentName(current, shellMessages(locale)),
      icon: (
        {
          personal: "user",
          work: "user",
          team: "users",
          automated: "bot",
          workstation: "laptop",
        } as const
      )[current.kind],
    };
  },
  // The space the Apps home shows: on a workstation with several
  // Organizations the rail and the picker name the one opened.
  space: (space) => {
    for (const element of [rail, columnHead]) {
      if (element === null) continue;
      if (space === null) element.removeAttribute("space");
      else if (element.getAttribute("space") !== space)
        element.setAttribute("space", space);
    }
  },
  newModule: (prompt) => handOver(prompt),
  // The person's account through this Environment's gateway (account.ts):
  // plain same-origin requests, never with the Launchpad's local token.
  readAccount: () => readAccount(),
  writeAccount: accountWriter(),
  dashboard: (slug) =>
    shellDocument?.organizations.find(
      (organization) => organization.slug.toLowerCase() === slug.toLowerCase(),
    )?.dashboard ?? null,
  // The switch as the column head draws it, for the personal space's starts
  // (root decision 0185's addendum of 2026-10-13): this Environment's own
  // apps, which the person's account never changes (src/shell/merge.ts).
  tabs: () =>
    shellDocument === null
      ? []
      : switchTabs(shellDocument, shellMessages(locale), "apps"),
  holder: () => personalHolder,
  // A service's page shows in the right panel (root decision 0209 point 6).
  showView: (view) => browser.showView(view),
});
// The first run of an Environment (root decisions 0188 and 0201): Nastavení →
// Začínáme, the line in Apps and the shell's prompt until it has its basics,
// "Obsah Environmentu" in Settings → Tento Environment and the tour over the
// real interface. The facts are read live: the AI from `GET /api/ai`, GitHub
// from Settings → Nástroje's reading of the profile shown, the content from
// the content routes; only where the introduction points is kept, in this
// browser.
let profileState: Readonly<{
  preset: string;
  revision: number;
  machine: string | null;
  /** The login whose own account does not belong in gh here: the
   * Automated Environment's responsible user (`responsibleLogin`, F27's
   * addendum of 2026-10-30); null elsewhere. */
  responsible: string | null;
}> | null = null;
// Whether the profile was read (`POST /api/profile`), and whether that read
// failed.
let loaded = false;
let loadFailed = false;
// Whether what only Settings show was asked for (`readBackground`).
let backgroundRead = false;
let githubSeen: ReturnType<typeof githubFact> = "unknown";
let contentSeen: ReturnType<typeof content.fact>["state"] = "loading";
// The AI as `GET /api/ai` last answered (root decision 0201 point 6); null
// before the first answer.
let aiReading: AiReading | null = null;
let aiRead = false;
const aiFact = (): AiFact =>
  aiReading === null ? (aiRead ? "unknown" : "loading") : aiReading.state;
// The start of the content by itself (0201 point 3, `autoStartStep`): what
// this view last knew of the AI and GitHub, and whether it saw one arrive.
let autoStart: AutoStart = idleAutoStart;
// Buddy (decision F65): only on an Osobní Prostředí whose entry names his
// origin, as the shell document says (`buddy`) and his routes confirm (404
// `buddy-absent` elsewhere). His reading, his sign-in and his persona live
// in one client; Začínáme's step, its dialog and Nastavení → Buddy draw from
// it. Nothing about him is kept in this browser.
const buddyClient = createBuddyClient({
  transport: {
    get: (path) => get(path),
    post: (path, body) => post(path, body),
  },
  changed: () => drawBuddy(),
});
let buddyAsked = false;
const buddyHere = (): boolean =>
  shellDocument?.buddy !== undefined && !buddyClient.absent();
const buddyFacts = (): BuddyStepFacts => {
  const refused = buddyClient.refused();
  return {
    reading: buddyClient.reading(),
    signIn: buddyClient.signIn(),
    now: Date.now(),
    ...(refused === undefined ? {} : { refused }),
  };
};
/** Reads Buddy once the page knows he is here, and again when asked. */
function readBuddy(again = false) {
  if (!buddyHere() || (buddyAsked && !again)) return;
  buddyAsked = true;
  void buddyClient.read();
}
function firstRunFacts(): TourFacts | null {
  if (profileState === null) return null;
  return {
    preset: profileState.preset,
    // A public Environment's demo onboarding (decision F55), by the entry.
    ...(isPublicEnvironment(entry) ? { audience: "public" as const } : {}),
    ai: aiFact(),
    github: githubFact(
      toolsOverview,
      profileState.revision,
      profileState.responsible,
    ),
    content: content.fact(),
    ...(buddyHere()
      ? { buddy: buddyFact(buddyClient.reading(), buddyClient.refused()) }
      : {}),
  };
}
// Whether this Environment's GitHub identity can prepare the Organization
// of a stop that only its root's writers fix (root decision 0201 point 8),
// as `GET /api/content/root-access` answered for that login.
let rootAccess: Readonly<{ login: string; write: boolean | null }> | null =
  null;
/** Where a stopped preparation leads now: Chat, the AI step, or the
 * sentence that the Admin prepares the Organization. */
function resolveKind() {
  const failure = content.job()?.failure;
  const login =
    failure?.item.kind === "organization" ? failure.item.login : null;
  const code = failure?.code ?? null;
  if (
    login !== null &&
    code !== null &&
    unpreparedCode(code) &&
    rootAccess?.login !== login
  )
    void readRootAccess(login);
  return resolveOf({
    ai: aiFact(),
    code,
    rootAccess: rootAccess?.login === login ? rootAccess.write : null,
    ...(isPublicEnvironment(entry) ? { audience: "public" as const } : {}),
  });
}
function unpreparedCode(code: string): boolean {
  return code === "root-not-found" || code === "organization-unreadable";
}
async function readRootAccess(login: string) {
  rootAccess = { login, write: null };
  let write = false;
  try {
    const { value, ok } = await get(
      `/api/content/root-access?org=${encodeURIComponent(login)}`,
    );
    write =
      ok &&
      (value as { kind?: unknown; write?: unknown } | null)?.kind ===
        "root-access" &&
      (value as { write?: unknown }).write === true;
  } catch {}
  if (rootAccess?.login !== login) return;
  rootAccess = { login, write };
  content.render();
  firstRun();
}
/** The line in Apps now. */
function setupLineNow() {
  const facts = firstRunFacts();
  return facts === null
    ? null
    : appsSetupLine(
        {
          ...facts,
          running: content.job()?.state === "running",
          resolve: resolveKind(),
        },
        copy,
      );
}
/** Reads the AI again; `fresh` asks the CLIs now instead of the minute the
 * server keeps their answer (Začínáme's "Zkontrolovat znovu"). */
/** What must come before the content (`contentBlockedBy`); `unknown` before
 * the profile is read. */
function contentBlocked() {
  const facts = firstRunFacts();
  return facts === null ? "unknown" : contentBlockedBy(facts);
}
/** Every new reading of the AI, GitHub or the content: once this view saw
 * GitHub or the AI arrive, the content starts by itself as soon as both are
 * there, whichever came last (0201 point 3, `autoStartStep`), never after a
 * stop and never before its turn. */
function startByItself() {
  const facts = firstRunFacts();
  if (facts === null) return;
  const step = autoStartStep(autoStart, facts, content.running());
  autoStart = step.state;
  if (step.start) void content.start();
}
async function readAi(fresh = false) {
  let read: AiReading | null = null;
  try {
    const { value, ok } = await get(fresh ? "/api/ai?fresh=1" : "/api/ai");
    read = ok ? parseAiAnswer(value) : null;
  } catch {}
  aiRead = true;
  if (read !== null || aiReading === null) aiReading = read;
  content.render();
  startByItself();
  firstRun();
}
// The Environment's id, the key of the tour:
// the shell document's, once asked for; without it the Machine's name.
function environmentKey(): string | null {
  if (shellDocument !== null && shellDocument.current !== null)
    return shellDocument.current;
  if (!shellRead || profileState === null) return null;
  return profileState.machine ?? "local";
}
const contentTransport: ContentTransport = async (method, path, body) => {
  const response = await fetch(path, {
    method,
    headers:
      method === "POST"
        ? { "Content-Type": "application/json", ...credential() }
        : credential(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  denied(response);
  const value: unknown = await response.json().catch(() => null);
  const mode = recoveryModeAnswer(response.status, value);
  if (mode !== null) enterRecovery(mode);
  return { status: response.status, value };
};
const content = createContentPanel({
  client: createContentClient(contentTransport),
  copy: () => copy,
  github: () =>
    profileState === null
      ? "unknown"
      : githubFact(
          toolsOverview,
          profileState.revision,
          profileState.responsible,
        ),
  modules: (login) => catalog.modulesOf(login),
  pluralModules: (count) =>
    copy[
      pluralKey(count, {
        one: "appsModulesOne",
        few: "appsModulesFew",
        many: "appsModulesMany",
      })
    ].replace("{count}", String(count)),
  changed: () => {
    // A finished installation brings its modules into Apps.
    const state = content.fact().state;
    if (
      state === "ready" &&
      contentSeen !== "ready" &&
      contentSeen !== "loading" &&
      contentSeen !== "none"
    )
      void catalog.refresh();
    contentSeen = state;
    // The personal space's holder as the content routes say it now: the
    // home is drawn again when it changes, so the tile follows.
    const holder = personalHolderOf(content.list());
    if (holder !== personalHolder) {
      personalHolder = holder;
      catalog.render();
    }
    void probePreparePrompt();
    startByItself();
    firstRun();
  },
  blockedBy: () => contentBlocked(),
  resolveKind: () => resolveKind(),
  resolve: () => resolveInChat(),
  connectAi: () => openAiStep(),
});
const tour = createTour({
  copy: () => copy,
  facts: () => firstRunFacts(),
  environment: () => environmentKey(),
  route: () => shell.route(),
  apps: () => ({
    chat: entry !== null,
    automate: entry?.mausbotOrigin !== undefined,
  }),
  columnHead: () => columnHead,
  // Recovery mode has no tour, and it steps aside while the person looks at
  // the Environment browser in the right panel.
  off: () => recoveryMode !== null || browser.isOpen(),
  // Never two tours at once (decision F56): the guide hears whether the
  // tour wants attention, and the tour waits while the guide is out.
  attention: guideAttention,
});
// Nastavení → Začínáme (root decision 0201): the basics from the same facts,
// the vault's state as Apps → Trezor reads it, the optional steps and the
// tour. Its vault and SSH rows are read each time it is shown, and so is
// whether Apps → Trezor gives the steps for Bitwarden ("Trezor v
// Bitwardenu", F53's addendum of 2026-10-16). Where the vault is a Lazurio
// Vaultwarden, that follows the person's membership answer, which the Trezor
// page asks too: asked here once per page, again only after an answer that
// says nothing yet (busy, no answer).
let vaultRow: StartVaultRow | null = null;
let vaultBitwarden = false;
let vaultPerson: VaultPagePerson | null = null;
let sshDevices: number | null = null;
// Composio's organization as Začínáme last read it (decision F42, note of
// 2026-10-19), so that Composio signed in but not in the organization of the
// Organization's name is not "Připojeno" there. Read each time Začínáme is
// shown, and when the sign-in changes while it is.
/** Composio's sign-in as the tools' reading names it; null signed out. */
function composioSignInKey(): string | null {
  const composio = toolsOverview?.tools.find(
    (tool) => tool.name === "composio",
  );
  return composio?.signIn?.state === "signed-in"
    ? JSON.stringify([
        composio.signIn.account ?? null,
        composio.signIn.organization ?? null,
      ])
    : null;
}
const composioOrganization = createComposioOrganizationReader({
  signIn: composioSignInKey,
  read: async () => {
    const { value, ok } = await post("/api/tools/composio/organizations", {});
    return ok && organizationChoices(value) !== null
      ? organizationRule(value)
      : null;
  },
  changed: () => startPanel.render(),
});
// "Přihlásit ChatGPT" and "Přihlásit Claude" (root decision 0201 points 3-6,
// F19's addendum of 2026-10-15): the CLI's sign-in through the Launchpad; on
// a Remote Environment its page opens in the Environment browser, and the
// right panel shows its tab, as Integrace does. Signed in, the AI is read
// again at once.
const aiSignIn = createAiSignIn({
  post: (path, body) => post(path, body),
  showView: (view) => {
    if (!browser.showView(view))
      window.open(view, "_blank", "noopener,noreferrer");
  },
  changed: () => startPanel.render(),
  readAi: () => void readAi(true),
});
const startPanel = createStartPanel({
  copy: () => copy,
  facts: () => {
    const facts = firstRunFacts();
    return facts === null
      ? null
      : {
          ...facts,
          aiReading,
          aiSignIn: aiSignIn.state(),
          aiPlace: aiSignInPlace(entry),
          githubLogin: githubAccount(toolsOverview),
          // GitHub's sign-in this page runs, its window closed or not
          // (#516): the step says it runs, and opens it again.
          githubFlow: tools.running("gh") ?? undefined,
          list: content.list(),
          buddyStep: buddyFacts(),
        };
  },
  // A public Environment's Začínáme (decision F55): Apps, a module and Chat,
  // whose line follows the AI as this page last read it.
  demo: () =>
    isPublicEnvironment(entry)
      ? demoStartView(
          {
            chat: chatHref(entry),
            module: demoModule(catalog.current()),
            ai: aiFact(),
          },
          copy,
        )
      : null,
  composio: () => composioFact(toolsOverview, composioOrganization.rule()),
  sshDevices: () => sshDevices,
  vault: () => vaultRow,
  bitwarden: () => vaultBitwarden,
  reveal: () => vaultPage.revealBitwarden(),
  toured: () => tour.toured(),
  signInGithub: () => {
    if (!tools.openSignIn("gh")) toolsAt("gh");
  },
  // "Přepnout účet" (F27's addendum of 2026-10-30): where the sign-out does
  // not end signed out, Nástroje at gh's row, whose notice says why.
  switchGithub: () =>
    void tools.switchAccount("gh").then((opened) => {
      if (!opened) toolsAt("gh");
    }),
  // Signed in already, the dialog opens at the step left in Composio.
  signInComposio: () => {
    if (!tools.openSignIn("composio") && !tools.openComposioOrganization())
      toolsAt("composio");
  },
  // "Přihlásit kódem": ChatGPT's sign-in by code (root decision 0201 point 10).
  signInAi: (tool, byCode) =>
    void aiSignIn.start(tool, byCode === true ? { byCode: true } : {}),
  cancelAi: () => void aiSignIn.cancel(),
  reopenAi: () => aiSignIn.reopen(),
  sendAiCode: (code) => void aiSignIn.sendCode(code),
  restartTour: () => tour.restart(),
  navigate: (path) => shell.navigate(path),
  // "Seznamte se s Buddym" (decision F65): a new code opens the dialog on
  // it; "Pokračovat" opens it where the step stands.
  buddy: {
    signIn: () => {
      void buddyClient.start();
      buddyDialog.open("sign-in");
    },
    cancel: () => void buddyClient.cancel(),
    open: (screen) => buddyDialog.open(screen),
  },
});
// The dialog "Seznamte se s Buddym" and Nastavení → Buddy (decision F65).
const buddyAvatar = () => buddyAvatarSource(shellDocument?.buddy?.origin);
// "Připojit Telegram" (decision F66): his own bot from BotFather, from
// Nastavení → Buddy → Kanály and the last screen of "Seznamte se s Buddym".
const telegramDialog = createTelegramDialog({
  copy: () => copy,
  telegram: () => buddyClient.reading()?.telegram,
  connect: (token, intent) => buddyClient.connectTelegram(token, intent),
  approve: (request) => buddyClient.approveTelegram(request),
  closed: () => drawBuddy(),
  meetingOver: () => meetingFinished(),
});
const buddyDialog = createBuddyDialog({
  copy: () => copy,
  locale: () => locale,
  facts: buddyFacts,
  avatar: buddyAvatar,
  signIn: () => void buddyClient.start(),
  save: (draft, confirm) => buddyClient.savePersona(draft, confirm, locale),
  // The beats that show his bots and where he is name this Environment's
  // apps as its switch does (decision F60's addendum of 2026-10-26).
  apps: () => {
    const words = shellMessages(locale);
    return {
      apps:
        shellDocument === null
          ? []
          : switchTabs(shellDocument, words, "apps")
              .filter((tab) => tab.href !== null)
              .map((tab) => tab.label),
      automate: words.automate,
    };
  },
  // His bubble is this page's own `<lazurio-buddy>`: its launcher rises over
  // the dialog while it shows where he is, and his window opens once the
  // meeting is over, as the person's own click would open it.
  spotlight: (on) => buddyElement()?.spotlight(on),
  finished: () => meetingFinished(),
  closed: () => firstRun(),
  telegram: () => telegramDialog.open(undefined, "meeting"),
});
/** The meeting with Buddy is over ("Teď ne", Hotovo, or Telegram's dialog
 * it opened, closed): the page draws again and his window opens, where his
 * first message comes, as the person's own click would open it. */
function meetingFinished() {
  firstRun();
  buddyElement()?.openWindow();
}
/** This page's `<lazurio-buddy>`, Buddy's bubble, once the shell defined it. */
function buddyElement(): Readonly<{
  spotlight(on: boolean): void;
  openWindow(): boolean;
}> | null {
  const element = buddy as
    | (HTMLElement & {
        spotlight?: (on: boolean) => void;
        openWindow?: () => boolean;
      })
    | null;
  return element !== null &&
    typeof element.spotlight === "function" &&
    typeof element.openWindow === "function"
    ? (element as unknown as {
        spotlight(on: boolean): void;
        openWindow(): boolean;
      })
    : null;
}
const buddyPanel = createBuddyPanel({
  copy: () => copy,
  locale: () => locale,
  here: buddyHere,
  facts: buddyFacts,
  avatar: buddyAvatar,
  signIn: () => {
    void buddyClient.start();
    buddyDialog.open("sign-in", "sign-in");
  },
  cancel: () => void buddyClient.cancel(),
  resume: () => buddyDialog.open("sign-in", "sign-in"),
  signOut: () => buddyClient.signOut(),
  save: (draft) => buddyClient.savePersona(draft, false, locale),
  telegram: {
    open: () => telegramDialog.open("botfather", "channels"),
    resume: () => telegramDialog.open("start", "channels"),
    disconnect: () => buddyClient.disconnectTelegram(),
  },
});
const buddyNav = document.querySelector<HTMLElement>("#buddy-nav");
// The codes' countdowns, filled in place each second while one waits.
let buddyTicker: ReturnType<typeof setInterval> | undefined;
/** Draws what shows Buddy: Začínáme (and with it the count, the line, the
 * shell's prompt and the tour), the dialog and Nastavení → Buddy. */
function drawBuddy() {
  if (buddyNav !== null) buddyNav.hidden = !buddyHere();
  buddyPanel.render();
  buddyDialog.render();
  telegramDialog.render();
  firstRun();
  const waiting = buddyClient.signIn().kind === "pending";
  if (waiting && buddyTicker === undefined)
    buddyTicker = setInterval(() => tickCountdowns(document, Date.now()), 1000);
  if (!waiting && buddyTicker !== undefined) {
    clearInterval(buddyTicker);
    buddyTicker = undefined;
  }
}
/** Reads what only Začínáme shows: the vault's state and the devices with
 * SSH, where the Environment has them (not this computer). */
async function readStartExtras() {
  // A public Environment's Začínáme shows neither (decision F55), and it has
  // no vault to read.
  if (
    profileState === null ||
    profileState.preset === "local" ||
    isPublicEnvironment(entry)
  ) {
    vaultRow = null;
    vaultBitwarden = false;
    sshDevices = null;
    startPanel.render();
    return;
  }
  void composioOrganization.read(true);
  const [vault, ssh] = await Promise.all([
    get("/api/vault").catch(() => null),
    get("/api/ssh").catch(() => null),
  ]);
  const model = vault?.ok ? parseVaultPage(vault.value) : null;
  const view = model === null ? null : vaultPageView(model, null, copy);
  vaultRow =
    view?.row === null || view?.row === undefined || view.note !== null
      ? null
      : { line: view.row.line, tone: view.row.tone };
  vaultBitwarden = offersBitwarden(model, vaultPerson);
  const overview = ssh?.ok ? parseSshOverview(ssh.value) : null;
  sshDevices =
    overview?.keys === null || overview?.keys === undefined
      ? null
      : keyGroups(overview.keys).devices.length;
  startPanel.render();
  if (bitwardenTarget(model)?.kind !== "server" || vaultPerson !== null) return;
  const person = await readVaultPerson();
  if (
    person.kind === "known" ||
    !["busy", "unreachable", "failed"].includes(person.reason)
  )
    vaultPerson = person;
  vaultBitwarden = offersBitwarden(model, person);
  startPanel.render();
}
/** Where the person stands in the vault, as Apps → Trezor asks it
 * (`POST /api/vault/membership`); "failed" without an answer, as there. */
async function readVaultPerson(): Promise<VaultPagePerson> {
  try {
    const { value, ok } = await post("/api/vault/membership", {});
    const person = ok ? parseVaultMembership(value) : null;
    if (person !== null) return person;
  } catch {}
  return { kind: "unknown", reason: "failed" };
}
/** Začínáme's AI step, from a stop, a line or a hand-over without AI. */
function openAiStep() {
  const route = shell.route();
  if (route.view !== "settings" || route.section !== "start")
    shell.navigate(settingsPath("start"));
  startPanel.focusAi();
}
// What a public Environment does not have (decision F55): the page's
// stylesheet hides Integrace in the Apps column, Nástroje in the settings
// navigation and Začínáme's "Zkontrolovat znovu" while `<html
// data-audience="public">` says so; the router shows Apps and Settings in
// place of the first two. Trezor follows its vault (`drawVaultNav`, plan
// DEV-6668 slice 6).
function drawAudience() {
  if (isPublicEnvironment(entry))
    document.documentElement.dataset.audience = "public";
  else delete document.documentElement.dataset.audience;
}
drawAudience();
const startNav = document.querySelector<HTMLElement>("#start-nav");
const startCountNode = document.querySelector<HTMLElement>("#start-count");
// Trezor in the Apps column (F53's addendum of 2026-10-18): only where this
// Environment has a vault, as the server read it for the first paint (the
// boot document's `vaultInApps`, F53's addendum of 2026-10-18 (3)), which
// the served page already shows; a page that carries none by its preset,
// never on this computer, and on a public Environment not at all, where the
// router then shows Apps in Trezor's place (plan DEV-6668 slice 6). Until the
// page knows whether it is a public Environment's (`entryKnown`: its boot
// document's entry, or `GET /api/entry` answered), not on any page: a public
// Environment without its vault never shows it, also while its entry is slow
// or fails, and any other shows it once its entry is read. Marked while its
// page shows.
const vaultNav = document.querySelector<HTMLElement>("#vault-nav");
const vaultOpen = document.querySelector<HTMLAnchorElement>("#vault-open");
let entryKnown = entry !== null;
const vaultHere = () =>
  vaultInApps(
    boot?.vaultInApps ?? null,
    profileState?.preset ?? null,
    entryKnown ? isPublicEnvironment(entry) : null,
  );
function drawVaultNav() {
  if (vaultNav !== null) vaultNav.hidden = !vaultHere();
}
drawVaultNav();
// The shell document the elements were last given, with the page's own
// `setup`.
let shellProvided: string | null = null;
/** Draws what the first run says now: the line (Apps is drawn again only
 * when it changed from the one last drawn, so a running preparation does not
 * close an open tile menu every second, and nothing is drawn twice),
 * Začínáme and its count, the shell's prompt from this page's own facts,
 * the tour, and a start request the page took on arrival. */
let lineDrawn = JSON.stringify(null);
function firstRun() {
  if (!framed) return;
  const facts = firstRunFacts();
  const line = JSON.stringify(setupLineNow());
  if (line !== lineDrawn) catalog.render();
  if (startNav !== null)
    startNav.hidden =
      profileState !== null &&
      !hasOnboarding(profileState.preset) &&
      !isPublicEnvironment(entry);
  drawVaultNav();
  const count = facts === null ? null : startCount(facts);
  if (startCountNode !== null) {
    startCountNode.hidden = count === null;
    startCountNode.textContent = count ?? "";
  }
  startPanel.render();
  provideOwnSetup(facts);
  // What Začínáme's "?" plays follows the profile and the entry.
  drawGuide(shell.route());
  tour.update();
  takeStart();
}
/** The column head of this page counts the basics from what the page
 * itself read, which is newer than the shell document's last reading: the
 * prompt follows a sign-in or an installation here at once. Nothing is
 * changed while GitHub's state is not known here. */
function provideOwnSetup(facts: TourFacts | null) {
  if (shellDocument === null || facts === null || profileState === null) return;
  // While GitHub's state is not known here, the server's `setup` stays, with
  // Buddy's step as this page read it: his bubble follows his meeting at
  // once (decision F60's addendum of 2026-10-26).
  const setup =
    facts.github !== "unknown"
      ? shellSetup({
          preset: profileState.preset,
          audience: facts.audience,
          ai: facts.ai,
          github: facts.github,
          list: content.list(),
          job: content.job(),
          ...(facts.buddy === undefined ? {} : { buddy: facts.buddy }),
        })
      : shellDocument.setup === undefined || facts.buddy === undefined
        ? undefined
        : withBuddySetup(shellDocument.setup, facts.buddy);
  if (facts.github === "unknown" && setup === undefined) return;
  const { setup: _, ...rest } = shellDocument;
  const next = setup === undefined ? rest : { ...rest, setup };
  const drawn = JSON.stringify(next);
  if (drawn === shellProvided) return;
  shellProvided = drawn;
  provideShell(withAppsTheme(next));
}
// A start request (`#lazurio-start=…`, or a button of the line) runs once
// the page is in its Settings section and knows enough: gh's sign-in opens
// once Nástroje have read it, the installation starts once the content is
// read and something is missing.
function takeStart() {
  const start = pendingStart;
  if (start === null || profileState === null) return;
  const route = shell.route();
  if (route.view !== "settings" || route.section !== startSection[start])
    return;
  const facts = firstRunFacts();
  if (facts === null) return;
  // GitHub waits for AI, the content for its turn (0201 point 3,
  // `startDecision`): an older link starts nothing out of order.
  // Buddy's request waits for the shell document, which says whether he is
  // here at all.
  if (start === "meet-buddy" && shellDocument === null && !shellRead) return;
  const decision = startDecision(start, facts);
  if (decision === "wait") return;
  if (decision === "meet-buddy") {
    // His dialog where his step stands: his sign-in or his introduction.
    pendingStart = null;
    buddyDialog.open(meetStart(buddyFacts()));
    return;
  }
  if (decision === "sign-in-gh") {
    if (tools.openSignIn("gh")) pendingStart = null;
    return;
  }
  pendingStart = null;
  if (decision === "open-ai") startPanel.focusAi();
  if (decision === "install") void content.start();
}
// Settings → Tools at one tool's row (Matěj 2026-10-28): whoever sends a
// person there for a tool shows them where to go on, never only the page.
function toolsAt(name: string) {
  shell.navigate(settingsPath("tools"));
  tools.reveal(name);
}
// Integrace's card for an app its tool connects (Matěj 2026-10-28): the
// tool's sign-in opens over Integrace where it has one, so WhatsApp's QR
// code shows at once; otherwise Settings → Tools opens at the tool's row.
async function openTool(name: string) {
  if (!(await tools.connect(name))) toolsAt(name);
}
function setupAction(action: SetupAction) {
  if (action === "resolve-in-chat") {
    resolveInChat();
    return;
  }
  // The button is a link to Začínáme; the move runs the start.
  if (action === "open-start") {
    const facts = firstRunFacts();
    if (facts !== null && nextBasic(facts) === "ai") startPanel.focusAi();
    return;
  }
  pendingStart = action;
}
// Whether this Launchpad serves the prepared prompt of the stop shown, for
// the login its link names: "Vyřešit v Chatu" then opens Chat by link (the
// fork fetches the text), otherwise it copies the prompt. Asked before the
// click, so that the click itself opens the tab.
let preparePromptServed: string | null = null;
async function probePreparePrompt() {
  const context = prepareContext(content.list(), content.job(), copy);
  const login = context?.login ?? null;
  if (login === null || entry === null) {
    preparePromptServed = null;
    return;
  }
  if (preparePromptServed === login) return;
  try {
    const response = await fetch(
      `/.lazurio/prompts/prepare-content?org=${encodeURIComponent(login)}`,
      { headers: credential(), cache: "no-store" },
    );
    const value = response.ok
      ? ((await response.json()) as { schema?: unknown })
      : null;
    preparePromptServed =
      value?.schema === "lazurio.prompt.v1" ? login : preparePromptServed;
  } catch {}
}
// "Vyřešit v Chatu" (root decision 0188): the wireframe's prompt that
// finishes the preparation with the same command, tests included; only
// inserted in Chat, never sent. Without AI it leads to Začínáme's AI step
// instead, and a stop only the Organization's Admin fixes has nothing to
// hand over (root decision 0201 points 3 and 8).
function resolveInChat() {
  const lead = resolveKind();
  if (lead === "ai") {
    openAiStep();
    return;
  }
  if (lead === "admin") return;
  const context = prepareContext(content.list(), content.job(), copy);
  if (context === null) return;
  const text = preparePrompt(context.target, context.failure, copy);
  const linked =
    context.login !== null && preparePromptServed === context.login;
  void handOver({
    id: "prepare-content",
    organization: linked ? context.login : null,
    text,
  }).then((outcome) =>
    catalog.say(
      copy[
        outcome === "handed-over"
          ? "contentResolveOpened"
          : outcome === "copied"
            ? "contentResolveCopied"
            : "contentResolveCopyFailed"
      ],
    ),
  );
}
// The Files page (decision F35): the Documents folder of this Environment.
// Behind a gateway a download is a plain link the session cookie admits;
// locally the token is in page memory only, so the page fetches with it.
const files = createFilesPanel({
  get: (path) => get(path),
  credential: () => credential(),
  linkDownloads: () => !token,
  denied: (status) => denied({ status, type: "default" }),
  copy: () => copy,
  locale: () => locale,
});
// Apps → Integrace (decision F42): the apps of this Environment. A sign-in
// opens in a window of this browser, and in the Environment browser's panel
// only where a direct sign-in can return to Executor alone on a Remote
// Environment (its addendum of 2026-10-13).
const integrations = createIntegrationsPanel({
  get: (path) => get(path),
  post: (path, body) => post(path, body),
  copy: () => copy,
  locale: () => locale,
  navigate: (path) => shell.navigate(path),
  showBrowser: (view) => {
    if (!browser.showView(view))
      window.open(view, "_blank", "noopener,noreferrer");
  },
  // Composio's sign-in asked for by a card (decision F42, note of
  // 2026-10-19): the tools are read live first, so a card read before
  // Composio's sign-in or its "Používají agenti" never sends the person
  // away; only this read's own reading, proving Composio signed out, makes
  // Settings → Tools open its sign-in.
  signInComposio: () =>
    composioSignIn(
      () => tools.refresh({ signIn: true }),
      () => {
        shell.navigate(settingsPath("tools"));
        if (tools.openSignIn("composio")) return true;
        tools.reveal("composio");
        return false;
      },
    ),
  openTool: (tool) => void openTool(tool),
  admin: async () => {
    const key = catalog.soleOrganization();
    if (key === null) return false;
    try {
      const { value, ok } = await get(
        `/api/organizations/${encodeURIComponent(key)}/owner`,
      );
      return ok && (value as { owner?: unknown } | null)?.owner === true;
    } catch {
      return false;
    }
  },
  dashboard: () =>
    shellDocument !== null && shellDocument.organizations.length === 1
      ? (shellDocument.organizations[0]?.dashboard ?? null)
      : null,
  // A Team Environment's Composio is the Team's Composio account.
  team: () =>
    shellDocument !== null &&
    currentEnvironment(shellDocument)?.kind === "team",
  // Whether Composio is allowed chooses what Integrace's "?" plays.
  drawn: () => {
    if (framed) drawGuide(shell.route());
  },
});
// Settings → Recovery, and in Recovery mode the whole page
// (docs/recovery.md "The Recovery page"): read on first view, never written.
const recovery = createRecoveryPanel({
  get: async () => {
    const response = await fetch("/api/recovery", {
      headers: credential(),
      cache: "no-store",
    });
    denied(response);
    return { value: await response.json(), ok: response.ok };
  },
  copy: () => copy,
  t3codeOrigin: () => chatHref(entry),
});
// Settings → SSH from your devices (decision F49): read on first view. Who
// added a key is the login of the Lazurio account the gateway relays to this
// page (`/.lazurio/account/environments`), a label and never evidence; a
// workstation's page has no such account and its keys say `local`. The page
// read the account as it loaded; "Add device" waits for that read at most
// two seconds more and never fails for it.
const ssh = createSshPanel({
  get: (path) => get(path),
  post: (path, body) => post(path, body),
  copy: () => copy,
  addedBy: async () => {
    if (token) return null;
    let late: ReturnType<typeof setTimeout> | undefined;
    const account = await Promise.race([
      pageAccountJson().catch(() => null),
      new Promise<null>((resolve) => {
        late = setTimeout(() => resolve(null), 2_000);
      }),
    ]).finally(() => clearTimeout(late));
    return parseShellAccount(account)?.operator.login ?? null;
  },
  origin: () => location.origin,
});
// Apps → Vault, Apps → Trezor (root decision 0198 point 5, F53's addendum of
// 2026-10-18): read on first view; the server adds the person the gateway
// admitted to the vault.
const vaultPage = createVaultPagePanel({
  get: (path) => get(path),
  post: (path, body) => post(path, body),
  copy: () => copy,
  shown: () => (framed ? shell.route().view === "vault" : false),
  // What it read chooses what Trezor's "?" plays (#499).
  drawn: () => {
    if (framed) drawGuide(shell.route());
  },
});
// Trezor's video where the approved video of how a vault works is true of
// this Environment (guides.ts `vaultHelp`): in place, under the page's
// heading, open as the page opens, its "?" closing and reopening it
// (page-help.ts).
const vaultVideoBox = document.querySelector<HTMLElement>("#vault-video");
const vaultVideoSlot = document.querySelector<HTMLElement>(
  "#vault-video-player",
);
const vaultVideo =
  vaultVideoBox === null || vaultVideoSlot === null
    ? { toggle() {}, draw() {}, open: false, render() {} }
    : createHelpVideo({
        box: vaultVideoBox,
        slot: vaultVideoSlot,
        line: "vault-video-line",
        name: "vault-overview",
        title: () => copy.vaultExplainerTitle,
        copy: () => copy,
        locale: () => locale,
      });
for (const help of Object.values(pageHelps))
  help?.addEventListener("click", () => {
    if (help === videoHelp) vaultVideo.toggle(help);
  });
// Apps → Trezor: the agents' secret requests (decision F54), the section of
// those that wait and one request's page; read when shown.
const vaultRequests = createVaultRequestsPanel({
  get: (path) => get(path),
  post: (path, body) => post(path, body),
  copy: () => copy,
});
// The left column as the person left it in this browser (Matěj's tuning of
// 2026-10-12, layout.ts): hidden or shown, and its width; placed before the
// page first shows, so it never moves on arrival. The heads of the page
// leave the page's top right corner free, as wide as what it holds.
const column = createColumn({ copy: () => copy });
keepCornerFree();
// The right panel (decision F38's addendum of 2026-10-05, decision F47 point
// 9): the tabs the Launchpad holds and its Nová karta entries, offered only
// where the recorded entry routes the view and never in Recovery mode; closed
// until the person opens it. Its requests carry the page's credential, as
// every read of this page does.
const browser = createBrowserPanel({
  copy: () => copy,
  locale: () => locale,
  origin: () => browserPanelOrigin(entry, recoveryMode !== null),
  transport: async (method, path, body) => {
    try {
      const response = await fetch(path, {
        method,
        headers:
          method === "POST"
            ? { "Content-Type": "application/json", ...credential() }
            : credential(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
      });
      denied(response);
      const value: unknown = await response.json().catch(() => null);
      const mode = recoveryModeAnswer(response.status, value);
      if (mode !== null) enterRecovery(mode);
      return { status: response.status, value };
    } catch {
      return { status: 0, value: null };
    }
  },
  changed: () => tour.update(),
});
// The Marketplace (plan DEV-6593): its catalog, an offer's detail and the
// form whose brief goes to Chat as "+ Nový modul"'s does.
const marketplace = createMarketplacePanel({
  copy: () => copy,
  route: () => shell.route(),
  catalog: () => catalog.current(),
  handOver: (prompt) => handOver(prompt),
});
// The frame: routes, the catalog and settings navigation, the breadcrumb and
// the sheet of a narrow viewport. It shows its first route while it is
// created; `framed` says it exists.
let framed = false;
const shell = createShell({
  copy: () => copy,
  displayName: (organization) => catalog.displayName(organization),
  // A public Environment has no Integrace, and Trezor only with its vault
  // (decision F55, plan DEV-6668 slice 6).
  place: (route) =>
    isPublicEnvironment(entry)
      ? publicRoute(route, { vault: vaultHere() })
      : route,
  // Escape is the guide's while it explains a page (decision F56): it
  // closes the explanation and the page stays.
  guiding: () => guideAttention.playing() !== null,
  onRoute: (route) => {
    // The switch marks Apps, the gear Settings (the Organization rail).
    columnHead?.setAttribute(
      "active",
      route.view === "settings" ? "settings" : "apps",
    );
    catalog.render(route);
    marketplace.render(route);
    // Back on "Všechny moduly" the catalog is read again (the first read
    // starts below, once the frame exists).
    if (framed && (route.view === "home" || route.view === "organization"))
      void catalog.refresh();
    files.show(route);
    drawGuide(route);
    integrations.show(route);
    if (
      route.view === "settings" &&
      route.section === "recovery" &&
      !recovery.loaded
    )
      void recovery.refresh();
    if (route.view === "settings" && route.section === "ssh" && !ssh.loaded)
      void ssh.refresh();
    if (route.view === "vault" && !vaultPage.loaded) void vaultPage.refresh();
    vaultRequests.show(route);
    if (route.view === "vault") vaultOpen?.setAttribute("aria-current", "page");
    else vaultOpen?.removeAttribute("aria-current");
    if (framed && route.view === "settings") {
      // Settings read what only they show the first time they are shown;
      // back in Tento Environment or Začínáme the content is read again, and
      // Začínáme reads the AI, the vault and SSH each time.
      const read = backgroundRead;
      readBackground();
      if (read && (route.section === "machine" || route.section === "start"))
        void content.refresh({ restore: false });
      if (route.section === "start") {
        if (read) void readAi();
        void readStartExtras();
      }
      // Začínáme and Nastavení → Buddy read him each time they are shown.
      if (route.section === "start" || route.section === "buddy")
        readBuddy(true);
    }
    firstRun();
  },
});
framed = true;
// A start request in the first address leads to its Settings section.
if (pendingStart !== null) {
  const route = shell.route();
  const section = startSection[pendingStart];
  if (route.view !== "settings" || route.section !== section)
    shell.navigate(settingsPath(section));
}
// A start request after the first address: a link of the shell on this
// origin (`lazurio-navigate`, which the router has already followed by
// now), Buddy's bubble on this very page among them, or the address's
// fragment changed in place. Only the requests `readFragment` knows count;
// the fragment leaves the address again.
function takeStartRequest(start: StartRequest | null) {
  if (start === null) return;
  pendingStart = start;
  const route = shell.route();
  const section = startSection[start];
  if (route.view !== "settings" || route.section !== section)
    shell.navigate(settingsPath(section));
  takeStart();
}
document.addEventListener("lazurio-navigate", (event) => {
  const href = (event as CustomEvent<{ href?: unknown }>).detail?.href;
  if (
    typeof href !== "string" ||
    !href.startsWith("/") ||
    href.startsWith("//")
  )
    return;
  takeStartRequest(readFragment(new URL(href, location.origin).hash).start);
});
window.addEventListener("hashchange", () => {
  const { start } = readFragment(location.hash);
  if (start === null) return;
  history.replaceState(null, "", location.pathname);
  takeStartRequest(start);
});

let current: {
  revision: number;
  preset: { name: string; version: number; selection: string };
  // The presets a change may end on: the recorded one and the new choices.
  allowedPresets: string[];
  machine: MachineView | null;
  profile: Record<string, string>;
  voice: VoiceView;
};
let pending: {
  expectedRevision: number;
  preset: string;
  profile: Record<string, string>;
} | null = null;
// Settings → Tento Environment (root decision 0188): what a person needs in
// view, the recorded technical facts folded under "Pro podporu"; rendered as
// text only, never as editable controls. Drawn again once the catalog (an
// Organization's name) or the shell document (a Team's name) is read.
function factRows(facts: readonly Fact[]): HTMLElement[] {
  return facts.map(([label, value]) => {
    const row = document.createElement("div");
    row.className = "row";
    const main = document.createElement("div");
    main.className = "row-main";
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    if (typeof value === "string") detail.textContent = value;
    else {
      const list = document.createElement("ul");
      list.replaceChildren(
        ...value.map((line) => {
          const item = document.createElement("li");
          item.textContent = line;
          return item;
        }),
      );
      detail.replaceChildren(list);
    }
    main.append(term, detail);
    row.append(main);
    return row;
  });
}
function drawMachine() {
  if (!loaded) return;
  const environment =
    shellDocument === null ? null : currentEnvironment(shellDocument);
  const { facts, support } = environmentFacts(
    {
      preset: current.preset.name,
      machine: current.machine,
      organization: (login) => catalog.organizationName(login),
      team: environment?.kind === "team" ? environment.label : null,
    },
    copy,
  );
  controls.machine.replaceChildren(...factRows(facts));
  controls.machineSupport.hidden = support.length === 0;
  controls.machineSupportList.replaceChildren(...factRows(support));
}
// Every refused API route names Recovery mode (docs/update.md "Recovery
// mode"): the page then becomes the Recovery page and stays it until reload.
let recoveryMode: RecoveryMode | null = null;
let stopUpdatePoll: (() => void) | undefined;
function enterRecovery(mode: RecoveryMode) {
  if (recoveryMode !== null) return;
  recoveryMode = mode;
  stopUpdatePoll?.();
  browser.render();
  // Nothing of the Folder can be read, its language neither: the browser's.
  if (!loaded) {
    locale = navigator.language.startsWith("cs") ? "cs" : "en";
    copy = messages(locale, kindOf(shellDocument));
  }
  document.documentElement.dataset.mode = "recovery";
  guideOff = true;
  relabel();
  shell.pin({ view: "settings", section: "recovery" });
  recovery.enter(mode);
  showWhenDrawn();
}
// Whether the page's words were written in its language once.
let labelled = false;
function relabel() {
  labelled = true;
  document.documentElement.lang = locale;
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-message]",
  )) {
    const key = element.dataset.message;
    if (key && Object.hasOwn(copy, key))
      element.textContent = copy[key as MessageKey];
  }
  if (guide !== null)
    guide.href = `https://documentation.lazurio.ai/${locale === "en" ? "en" : "cs"}/guide/?utm_source=launchpad&utm_medium=product&utm_campaign=guide`;
  shell.relabel();
  if (framed) drawGuide(shell.route());
  recovery.render();
  ssh.render();
  theme.render();
  vaultPage.render();
  if (framed) marketplace.render();
  vaultVideo.render();
  vaultRequests.relabel();
  files.relabel();
  integrations.relabel();
  column.relabel();
  browser.relabel();
  buddyPanel.render();
  buddyDialog.render();
}
async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...credential() },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  denied(response);
  const value = await response.json();
  const mode = recoveryModeAnswer(response.status, value);
  if (mode !== null) enterRecovery(mode);
  return { value, ok: response.ok };
}
async function get(path: string) {
  const response = await fetch(path, {
    headers: credential(),
    cache: "no-store",
  });
  denied(response);
  const value = await response.json();
  return { value, ok: response.ok };
}
async function request(path: string, body: unknown) {
  const { value, ok } = await post(path, body);
  controls.result.textContent = JSON.stringify(value, null, 2);
  if (!ok) throw new Error(copy.refused);
  return value;
}
async function load() {
  current = await request("/api/profile", {});
  // The first read follows the page's start, a later one a change of the
  // Folder (a profile or tools change, "Reload profile").
  const first = !loaded;
  loaded = true;
  const read = current.profile.locale === "cs" ? "cs" : "en";
  // The words are written again only in another language or kind.
  const before = copy;
  locale = read;
  copy = messages(locale, kindOf(shellDocument));
  const relabelled = !labelled || copy !== before;
  profileState = {
    preset: current.preset.name,
    revision: current.revision,
    machine: current.machine?.name ?? null,
    responsible: responsibleLogin(current.preset.name, current.machine),
  };
  // The content core owns availability; a persona account uses the same
  // content operation as a person's work Environment.
  if (!first) void content.refresh();
  renderUpdate();
  if (relabelled) {
    relabel();
    catalog.render();
  }
  // The shell document follows a change of the Folder (its language, its
  // preset); the page's start reads it once, or carries it.
  if (!first) void readShell();
  voice.load(current);
  drawMachine();
  // One fixed option on a public Environment (the Try overlay, F55's
  // addendum of 2026-10-20).
  const presets = presetChoice(
    {
      allowedPresets: current.allowedPresets,
      preset: current.preset.name,
      machine: current.machine,
    },
    copy,
  );
  controls.presetSelect.replaceChildren(
    ...presets.options.map(
      (option) =>
        new Option(option.label, option.value, false, option.selected),
    ),
  );
  controls.presetSelect.disabled = presets.fixed;
  for (const [key, value] of Object.entries(current.profile)) {
    const control = controls.form.elements.namedItem(key);
    if (control instanceof HTMLSelectElement) control.value = value;
  }
  // The Folder's revision and its OS are nothing a person needs here (F36's
  // addendum of 2026-10-16); a preview or a refusal says its result.
  controls.status.textContent = "";
  controls.choices.disabled = false;
  if (first) {
    // What only Settings show (and the first run's line in Apps) is read on
    // a Settings route at once, elsewhere once the page is idle.
    if (shell.route().view === "settings") readBackground();
    else whenIdle(readBackground);
    // Začínáme opened directly (the shell's "Dokončit nastavení" loads it)
    // reads its vault and SSH rows too, as a move to it does.
    const route = shell.route();
    if (route.view === "settings" && route.section === "start")
      void readStartExtras();
  }
  // The tools section follows the same state: locale and revision.
  else void tools.refresh();
  firstRun();
  showWhenDrawn();
}
/** Reads, once, what only Settings show and the first run's line needs: the
 * tools with their sign-ins, which may ask the providers, and where the
 * content core admits it its content, which asks GitHub. Never
 * on the way to the page's first paint (F36's addendum of 2026-10-08). */
function readBackground() {
  if (backgroundRead || !loaded) return;
  backgroundRead = true;
  void tools.refresh();
  void content.refresh();
  void readAi();
}
/** Runs `task` once the page is idle, at the latest after two seconds. */
function whenIdle(task: () => void) {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(() => task(), { timeout: 2000 });
  else setTimeout(task, 300);
}
// The tools section (decision F18). A change recorded there moves the Folder
// revision, so a profile preview made before it is no longer valid.
const tools = createToolsPanel({
  // What Nástroje's "?" can point at chooses its steps.
  drawn: (targets) => {
    toolTargets = targets;
    if (framed) drawGuide(shell.route());
  },
  observed: (overview) => {
    // A tool's sign-in changes which apps it connects, and Composio's
    // organization which accounts count: Integrace read again.
    const signIns = toolSignInsKey(overview);
    if (
      toolSignIns !== null &&
      toolSignIns !== signIns &&
      !isPublicEnvironment(entry)
    )
      void integrations.refresh();
    toolSignIns = signIns;
    toolsOverview = overview;
    // Začínáme shown: Composio's organization for its sign-in as it is now.
    const route = shell.route();
    if (route.view === "settings" && route.section === "start")
      void composioOrganization.read(false);
    // Once GitHub is connected the content routes may answer otherwise; a
    // sign-in this view saw starts the content once its turn has come (0201
    // point 3).
    const github =
      profileState === null
        ? "unknown"
        : githubFact(overview, profileState.revision, profileState.responsible);
    if (githubSeen !== "connected" && github === "connected")
      void content.refresh({ restore: false });
    githubSeen = github;
    // A tool installed, or switched on or off for agents, changes what
    // connects the apps too (decision F42, note of 2026-10-19).
    if (!isPublicEnvironment(entry)) integrations.toolsRead(overview);
    content.render();
    startByItself();
    firstRun();
  },
  post,
  copy: () => copy,
  changed: async () => {
    pending = null;
    controls.apply.disabled = true;
    await load();
  },
  // A public Environment has no Nástroje (decision F55): nothing to read.
  absent: () => isPublicEnvironment(entry),
  // A sign-in of this page started, moved on or ended, its window open or
  // closed (#516): Začínáme follows.
  signInsChanged: () => firstRun(),
  // The Automated Environment's gh is the persona's account (F27's addendum
  // of 2026-10-30): its code is confirmed with that account.
  persona: () => personaGithub(profileState?.preset),
});
const voice = voicePanel({
  post,
  copy: () => copy,
  changed: async () => {
    pending = null;
    controls.apply.disabled = true;
    await load();
  },
});
// The Environment's theme (root decision 0208): Settings → Obecné → Téma
// Prostředí. A choice is declared in this page at once and kept in the page's
// shell document, so the next reading of it changes nothing.
const theme = createThemePanel({
  get,
  post,
  copy: () => copy,
  apply: (chosen) => {
    if (shellDocument === null) return;
    shellDocument = { ...shellDocument, theme: chosen };
    provideShell(withAppsTheme(shellDocument));
  },
  // A public Environment's theme is fixed (decision F55): no group.
  fixed: () => isPublicEnvironment(entry),
  shared: () =>
    shellDocument !== null &&
    currentEnvironment(shellDocument)?.kind === "team",
});
// The page shown again (another tab, another app, `lazurio theme` meanwhile):
// the shell document read again, at most once a second, never by a timer.
let shellRereadAt = Number.NEGATIVE_INFINITY;
function rereadShell() {
  if (document.hidden || recoveryMode !== null) return;
  const now = Date.now();
  if (now - shellRereadAt < 1000) return;
  shellRereadAt = now;
  void readShell();
}
document.addEventListener("visibilitychange", rereadShell);
window.addEventListener("focus", rereadShell);
// Another tab of this origin chose a theme (the shell followed it at once):
// this page's document and Settings follow too.
document.addEventListener("lazurio-theme", (event) => {
  const change = (event as CustomEvent<{ revision?: unknown } | null>).detail;
  if (
    change !== null &&
    typeof change?.revision === "number" &&
    change.revision !== shellDocument?.theme?.revision
  )
    rereadShell();
});
// Začínáme's "Zkontrolovat znovu": every fact asked again now, the CLIs and
// gh's sign-in included.
document.querySelector("#start-refresh")?.addEventListener("click", () => {
  void readAi(true);
  void tools.refresh({ signIn: true });
  void content.refresh({ restore: false });
  void readStartExtras();
  readBuddy(true);
});
controls.form.addEventListener("change", () => {
  pending = null;
  controls.apply.disabled = true;
});
document.querySelector("#reload")?.addEventListener("click", async () => {
  pending = null;
  controls.apply.disabled = true;
  controls.choices.disabled = true;
  try {
    await load();
  } catch {
    controls.status.textContent = copy.reloadFailed;
  } finally {
    controls.choices.disabled = false;
  }
});
controls.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  pending = null;
  controls.apply.disabled = true;
  controls.choices.disabled = true;
  try {
    controls.choices.disabled = false;
    const { preset, ...axes } = Object.fromEntries(
      new FormData(controls.form).entries(),
    ) as Record<string, string>;
    // Only the communication axes come from the form; the fixed axes stay
    // with the preset and the Machine binding is never sent.
    const profile = { ...current.profile, ...axes };
    controls.choices.disabled = true;
    const candidate = {
      expectedRevision: current.revision,
      preset: preset ?? current.preset.name,
      profile,
    };
    const preview = await request("/api/preview", candidate);
    if (preview.kind === "profile-change") {
      pending = candidate;
      controls.apply.disabled = false;
    }
    controls.status.textContent = copy.previewComplete;
  } catch {
    controls.status.textContent = copy.refused;
  } finally {
    controls.choices.disabled = false;
  }
});
controls.apply.addEventListener("click", async () => {
  const candidate = pending;
  if (!candidate) return;
  pending = null;
  controls.apply.disabled = true;
  controls.choices.disabled = true;
  try {
    await request("/api/update", candidate);
    await load();
  } catch {
    controls.status.textContent = copy.refused;
  } finally {
    controls.choices.disabled = false;
  }
});
// Chat and Automate (launchpad-parity B8, DEV-6632) are tabs of the switch
// at the top of the column (decision F36), plain links to the recorded
// origins, and a plain click follows the link as it is: the page asks the
// server for nothing on the way. T3 Code and MausBot pair an unpaired
// browser themselves (`GET /.lazurio/chat/pairing`, the decision of
// 2026-10-17; `GET /.lazurio/mausbot/pairing`, its addendum of 2026-10-22),
// and a browser with a session opens at once. The click's own pairing went
// with the addendum of 2026-10-31: it cost a round trip and the app's
// pairing page flashing by on every switch. Apps on this origin moves
// within the page.
// "+ Nový modul" (decision F36 addendum of 2026-10-04). Where this
// Environment's Chat takes a prepared prompt by link (Lazurio/t3code#35,
// the server asks its T3 Code for the version), Chat opens in a new tab on
// its plain origin with the prompt's id and the Organization in the link's
// fragment, never the text, and pairs the browser itself on the way: the fork fetches the text from its own
// origin and leaves it in a new thread's composer, not sent, and nothing is
// copied. Otherwise, and when the tab cannot open, the prompt goes to the
// clipboard (written first, while the page still has the focus) and Chat
// opens, where the person pastes it into a new chat. A workstation has no
// Chat origin: the prompt is copied all the same.
async function handOver(
  prompt: Readonly<{ id: string; organization: string | null; text: string }>,
): Promise<NewModuleOutcome> {
  // No agent can take it while no AI is connected: Začínáme's AI step
  // instead of an empty Chat (root decision 0201 point 3).
  if (aiFact() === "missing") {
    openAiStep();
    return "needs-ai";
  }
  const current = entry;
  const link: PromptLink | null =
    prompt.organization === null
      ? null
      : { id: prompt.id, organization: prompt.organization };
  if (current !== null && chatTakesPrompts && link !== null) {
    const href = chatPromptHref(current.t3codeOrigin, link);
    if (href === null) return "failed";
    const tab = window.open("about:blank", "_blank");
    if (tab !== null) {
      tab.opener = null;
      tab.location.href = href;
      return "handed-over";
    }
  }
  const copying = navigator.clipboard.writeText(prompt.text).then(
    () => true,
    () => false,
  );
  const tab = current === null ? null : window.open("about:blank", "_blank");
  if (current !== null && tab !== null) {
    tab.opener = null;
    tab.location.href = current.t3codeOrigin;
  }
  return (await copying) ? "copied" : "failed";
}
document.addEventListener("lazurio-app", (event) => {
  const detail = (event as CustomEvent<{ app?: unknown; href?: unknown }>)
    .detail;
  if (typeof detail?.href !== "string" || typeof detail.app !== "string")
    return;
  const target = new URL(detail.href, location.href);
  if (target.origin !== location.origin) return;
  event.preventDefault();
  shell.navigate(target.pathname);
});
// The entry, and whether Chat takes a prepared prompt by link, read side by
// side: the second is the server's own answer, no on a workstation.
async function readEntry() {
  const handoff = readPromptHandoff();
  let read: PublicEntry | null;
  try {
    const { value, ok } = await get("/api/entry");
    read = ok ? parseEntryAnswer(value) : null;
    // Known once answered: an entry, or a workstation's none. A failed or
    // unreadable answer leaves it unknown, and Trezor hidden.
    if (read !== null || (ok && isNoEntry(value))) entryKnown = true;
  } catch {
    read = null;
  }
  // Drawn again only when it differs from what the page shows.
  if (JSON.stringify(read) !== JSON.stringify(entry)) {
    entry = read;
    recovery.render();
    catalog.render();
    browser.render();
    // Whether it is a public Environment, which the page may learn only now.
    drawAudience();
    shell.replace();
    firstRun();
  }
  // Trezor waited for the entry (plan DEV-6668 slice 6): drawn now, whether
  // the entry changed or not.
  drawVaultNav();
  openAskedService();
  await handoff;
}
// The service a `/service/<id>` link asked for (`askedService`), opened
// once the catalog and the entry are known (root decision 0209 point 6): its
// page in the Environment browser's panel, as its tile opens it, and only
// once: the frame already shows `/`, so neither Back nor a reload asks
// again.
function openAskedService() {
  if (askedService === null || catalog.current() === null || !entryKnown)
    return;
  const service = askedService;
  askedService = null;
  void catalog.openService(service);
}
async function readPromptHandoff() {
  try {
    const { value, ok } = await get("/api/chat/prompt-handoff");
    chatTakesPrompts = ok && parsePromptHandoff(value);
  } catch {
    chatTakesPrompts = false;
  }
}
if (boot === null) {
  void readEntry();
  void readShell();
  void catalog.refresh();
} else {
  // Carried by the page: its words are the server's, the rest is drawn here.
  if (entry === null) void readEntry();
  else void readPromptHandoff();
  if (shellDocument === null) void readShell();
  if (boot.catalog === null) void catalog.refresh();
  relabel();
  browser.render();
  openAskedService();
}
// Buddy, where the carried shell document names him.
readBuddy();
drawBuddy();
// The themes for Settings → Obecné; nothing to read on a public Environment.
void theme.load();
load().catch(() => {
  loadFailed = true;
  controls.status.textContent = copy.loadFailed;
  // The tools section says for itself that it could not be read.
  void tools.refresh();
  showWhenDrawn();
});
showWhenDrawn();

// The update pill (docs/update.md "Surfaces"): the server derives the state;
// the browser only shows it and sends the one click back with the version it
// showed. Hidden where this Launchpad is not an installed one.
const updateSection = document.querySelector<HTMLElement>("#update");
const updateText = document.querySelector<HTMLSpanElement>("#update-text");
const updateNotes = document.querySelector<HTMLAnchorElement>("#update-notes");
const updateAction =
  document.querySelector<HTMLButtonElement>("#update-action");
const updateChecked =
  document.querySelector<HTMLParagraphElement>("#update-checked");
const updateError =
  document.querySelector<HTMLParagraphElement>("#update-error");
const updateStateInvalid = document.querySelector<HTMLParagraphElement>(
  "#update-state-invalid",
);
if (
  !updateSection ||
  !updateText ||
  !updateNotes ||
  !updateAction ||
  !updateChecked ||
  !updateError ||
  !updateStateInvalid
)
  throw new Error("Missing update UI");
let updateStatus: PillStatus | null = null;
let updateNote: string | null = null;
function renderUpdate() {
  if (!updateStatus || !updateSection) return;
  const view = pillView(updateStatus, copy, Date.now());
  // Only while an update is available (pillVisible). The Folder's refresh
  // is part of the update and never shown (F17's addendum of 2026-10-30).
  updateSection.hidden = !pillVisible(updateStatus);
  if (updateText) updateText.textContent = view.text;
  if (updateNotes) {
    updateNotes.hidden = view.notesUrl === null;
    if (view.notesUrl === null) updateNotes.removeAttribute("href");
    else updateNotes.href = view.notesUrl;
  }
  if (updateAction) {
    updateAction.hidden = view.action === null;
    updateAction.textContent = view.action?.label ?? "";
    updateAction.dataset.version = view.action?.version ?? "";
  }
  if (updateChecked) {
    updateChecked.textContent = updateNote ?? view.checked;
    updateChecked.classList.toggle("stale", view.stale);
  }
  if (updateError) {
    updateError.hidden = view.error === null;
    updateError.textContent = view.error ?? "";
  }
  if (updateStateInvalid) {
    updateStateInvalid.hidden = view.stateInvalid === null;
    updateStateInvalid.textContent = view.stateInvalid ?? "";
  }
}
async function refreshUpdate() {
  try {
    // A redirect is never followed: behind a gateway it is the sign-in,
    // which a background request cannot follow (a cross-origin answer
    // without CORS), so the poll sees it as a denial instead of a failure.
    const response = await fetch("/api/update/status", {
      headers: credential(),
      cache: "no-store",
      redirect: "manual",
    });
    denied(response);
    if (!response.ok) {
      const mode = recoveryModeAnswer(
        response.status,
        await response.json().catch(() => null),
      );
      if (mode !== null) enterRecovery(mode);
      return;
    }
    updateStatus = (await response.json()) as PillStatus;
    renderUpdate();
  } catch {
    // The next refresh tries again; the pill keeps what it showed.
  }
}
updateAction.addEventListener("click", async () => {
  const version = updateAction.dataset.version;
  if (!version || updateAction.disabled) return;
  updateAction.disabled = true;
  updateNote = copy.updateStarted;
  renderUpdate();
  try {
    const { ok } = await post("/api/update/apply", { version });
    if (!ok) updateNote = copy.updateRefused;
  } catch {
    updateNote = copy.updateRefused;
  } finally {
    await refreshUpdate();
    updateNote = null;
    updateAction.disabled = false;
    renderUpdate();
  }
});
// The pill asks every ten seconds, only while the page is shown, and at once
// when it is shown again.
stopUpdatePoll = pollWhileVisible(refreshUpdate, 10_000);
