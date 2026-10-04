import { currentEnvironment, parseShell, type Shell } from "../shell/contract";
import { defineShellElements, provideShell } from "../shell/elements";
import { shellMessages } from "../shell/messages";
import { environmentName } from "../shell/view";
import type { ToolsOverview } from "../tools/overview";
import { accountWriter, readAccount } from "./account";
import {
  createCatalogPanel,
  type NewModuleOutcome,
  type NewModulePrompt,
} from "./catalog-panel";
import type { PublicEntry } from "./chat";
import {
  chatHref,
  chatPairLink,
  chatPromptHref,
  mausbotPairLink,
  parseEntryAnswer,
  parsePromptHandoff,
} from "./chat-view";
import { createFilesPanel } from "./files-panel";
import { type AssignmentView, assignmentText } from "./machine-view";
import { type MessageKey, messages } from "./messages";
import { createRecoveryPanel } from "./recovery-panel";
import { type RecoveryMode, recoveryModeAnswer } from "./recovery-view";
import { createShell } from "./shell";
import { createToolsPanel } from "./tools-panel";
import type { PillStatus } from "./update-pill";
import { fill, pillView, pillVisible } from "./update-view";

const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const form = document.querySelector<HTMLFormElement>("#profile");
const choices = document.querySelector<HTMLFieldSetElement>("#choices");
const apply = document.querySelector<HTMLButtonElement>("#apply");
const status = document.querySelector<HTMLParagraphElement>("#status");
const result = document.querySelector<HTMLPreElement>("#result");
const machine = document.querySelector<HTMLDListElement>("#machine");
const presetSelect = document.querySelector<HTMLSelectElement>("#preset");
const presetSelection =
  document.querySelector<HTMLSpanElement>("#preset-selection");
if (
  !form ||
  !choices ||
  !apply ||
  !status ||
  !result ||
  !machine ||
  !presetSelect ||
  !presetSelection
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
  presetSelection,
};
let locale: "cs" | "en" = "en";
let copy = messages(locale);
// The recorded entry's public parts (`GET /api/entry`); null on a workstation
// and until read. The pairing of Chat and Automate, the tiles' module
// origins and the Recovery page's T3 Code link.
let entry: PublicEntry | null = null;
// Whether Chat on this Environment takes a prepared prompt by link
// (`GET /api/chat/prompt-handoff`, Lazurio/t3code#35): read once with the
// entry, no until answered.
let chatTakesPrompts = false;
// The Lazurio shell (decision F36): the rail and the switch, drawn from
// this Environment's `/.lazurio/shell.json`, which the page reads with its
// own credential and hands over (the forks let the elements read it).
defineShellElements();
const columnHead = document.querySelector<HTMLElement>("#column-head");
const rail = document.querySelector<HTMLElement>("#rail");
// The documentation of the Launchpad's "Guide" (the root Launchpad's
// `guideDocumentationUrl`), in the page's language.
const guide = document.querySelector<HTMLAnchorElement>("#catalog-guide");
const marketplaceText =
  document.querySelector<HTMLParagraphElement>("#marketplace-text");
let shellDocument: Shell | null = null;
let toolsOverview: ToolsOverview | null = null;
async function readShell() {
  try {
    const response = await fetch("/.lazurio/shell.json", {
      headers: credential(),
      cache: "no-store",
    });
    denied(response);
    const parsed = response.ok ? parseShell(await response.json()) : null;
    if (parsed === null) return;
    shellDocument = parsed;
    provideShell(parsed);
    catalog.render();
  } catch {
    // The rail stays empty; the page itself works without it.
  }
}
// The Launchpad home: the catalog of this Folder's Organizations and modules
// (launchpad-parity B1), drawn for the route the frame shows.
const catalog = createCatalogPanel({
  tools: () => toolsOverview,
  revision: () => current?.revision ?? null,
  post: (path, body) => post(path, body),
  get: (path) => get(path),
  copy: () => copy,
  route: () => shell.route(),
  navigate: (path) => shell.navigate(path),
  loaded: () => shell.relabel(),
  entry: () => entry,
  avatar: (slug) =>
    shellDocument?.organizations.find(
      (organization) => organization.slug.toLowerCase() === slug.toLowerCase(),
    )?.avatar ?? null,
  environment: () => {
    if (shellDocument === null) return null;
    const current = currentEnvironment(shellDocument);
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
    for (const element of [rail, columnHead])
      if (element !== null && element.getAttribute("space") !== space)
        element.setAttribute("space", space);
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
});
// The Files page (decision F35): the Documents folder of this Environment.
// Behind a gateway a download is a plain link the session cookie admits;
// locally the token is in page memory only, so the page fetches with it.
const files = createFilesPanel({
  get: (path) => get(path),
  credential: () => credential(),
  linkDownloads: () => !token,
  denied: (status) => {
    if (!token && status === 401) location.assign(location.href);
  },
  copy: () => copy,
  locale: () => locale,
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
// The frame: routes, the catalog and settings navigation, the breadcrumb and
// the sheet of a narrow viewport. It shows its first route while it is
// created; `framed` says it exists.
let framed = false;
const shell = createShell({
  copy: () => copy,
  displayName: (organization) => catalog.displayName(organization),
  onRoute: (route) => {
    // The switch marks Apps, the gear Settings (the Organization rail).
    columnHead?.setAttribute(
      "active",
      route.view === "settings" ? "settings" : "apps",
    );
    catalog.render(route);
    // Back on "Všechny moduly" the catalog is read again (the first read
    // starts below, once the frame exists).
    if (framed && (route.view === "home" || route.view === "organization"))
      void catalog.refresh();
    if (route.view === "marketplace" && marketplaceText !== null) {
      const name = catalog.scopeName(route);
      marketplaceText.textContent =
        copy.appsMarketplaceText +
        (name === null
          ? ""
          : copy.appsMarketplaceOrganization.replace("{name}", name));
    }
    files.show(route);
    if (
      route.view === "settings" &&
      route.section === "recovery" &&
      !recovery.loaded
    )
      void recovery.refresh();
  },
});
framed = true;

type MachinePeer = {
  name: string;
  kind: string;
  zone: string | null;
  organization: string | null;
  ssh: { host: string; user: string | null; direction: string } | null;
  https: string[];
};
type MachineBinding = {
  kind: string;
  name: string;
  owner:
    | { kind: "principal"; githubLogin: string; githubId: number }
    | {
        kind: "organization";
        organization: string;
        team: string | null;
        assignment?: AssignmentView;
      };
  network: { headscaleHostname: string } | null;
  host: { kind: string; id: string };
  relationships?: { zone: string; peers: MachinePeer[] };
};
let current: {
  revision: number;
  preset: { name: string; version: number; selection: string };
  // The presets a change may end on: the recorded one and the new choices.
  allowedPresets: string[];
  machine: MachineBinding | null;
  profile: Record<string, string>;
};
let pending: {
  expectedRevision: number;
  preset: string;
  profile: Record<string, string>;
} | null = null;
const presetLabels: Record<string, MessageKey> = {
  local: "presetLocal",
  "hosted-personal": "presetHostedPersonal",
  "hosted-organization-personal": "presetHostedOrganizationPersonal",
  "hosted-organization-team": "presetHostedOrganizationTeam",
  "hosted-organization-steward": "presetHostedOrganizationSteward",
};
// One compact read-only line per recorded peer, in the handover's own words.
function peerText(peer: MachinePeer): string {
  const who = [peer.kind, peer.zone, peer.organization]
    .filter((part) => part !== null)
    .join(", ");
  const ssh =
    peer.ssh === null
      ? copy.machineNoSsh
      : `SSH ${peer.ssh.direction} ${peer.ssh.user === null ? "" : `${peer.ssh.user}@`}${peer.ssh.host}`;
  const https =
    peer.https.length === 0
      ? copy.machineNoHttps
      : `HTTPS ${peer.https.join(", ")}`;
  return `${peer.name} (${who}): ${ssh}; ${https}`;
}
// The immutable part: rendered as text only, never as editable controls.
function machineRows(
  binding: MachineBinding | null,
): [MessageKey, string | string[]][] {
  if (binding === null) return [["machineKind", copy.machineWorkstation]];
  const owner =
    binding.owner.kind === "principal"
      ? `${binding.owner.githubLogin} (GitHub id ${binding.owner.githubId})`
      : binding.owner.organization;
  const assignment =
    binding.owner.kind === "organization" &&
    binding.owner.assignment !== undefined
      ? assignmentText(binding.owner.assignment, copy)
      : null;
  return [
    ["machineKind", binding.kind],
    ["machineName", binding.name],
    ["machineOwner", owner],
    ...(binding.owner.kind === "organization" && binding.owner.team !== null
      ? ([["machineTeam", binding.owner.team]] as [MessageKey, string][])
      : []),
    ...(assignment === null
      ? []
      : ([["machineAssignment", assignment]] as [MessageKey, string][])),
    ["machineTailnet", binding.network?.headscaleHostname ?? copy.machineNone],
    ["machineHost", `${binding.host.kind} ${binding.host.id}`],
    ...(binding.relationships === undefined
      ? []
      : ([
          [
            "machineRelationships",
            binding.relationships.peers.length === 0
              ? copy.machineNoPeers
              : binding.relationships.peers.map(peerText),
          ],
        ] as [MessageKey, string | string[]][])),
  ];
}
// Local: the fragment token is the credential. Hosted (no token): the
// gateway's session cookie is, sent by the browser itself; a denial means the
// session ended and the page re-enters through the gateway.
const credential = (): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};
function denied(response: Response) {
  if (!token && response.status === 401) location.assign(location.href);
}
// Every refused API route names Recovery mode (docs/update.md "Recovery
// mode"): the page then becomes the Recovery page and stays it until reload.
let recoveryMode: RecoveryMode | null = null;
let updateTimer: ReturnType<typeof setInterval> | undefined;
function enterRecovery(mode: RecoveryMode) {
  if (recoveryMode !== null) return;
  recoveryMode = mode;
  clearInterval(updateTimer);
  // Nothing of the Folder can be read, its language neither: the browser's.
  if (!loaded) {
    locale = navigator.language.startsWith("cs") ? "cs" : "en";
    copy = messages(locale);
  }
  document.documentElement.dataset.mode = "recovery";
  relabel();
  shell.pin({ view: "settings", section: "recovery" });
  recovery.enter(mode);
}
function relabel() {
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
  recovery.render();
  files.relabel();
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
let loaded = false;
async function load() {
  current = await request("/api/profile", {});
  loaded = true;
  locale = current.profile.locale === "cs" ? "cs" : "en";
  copy = messages(locale);
  renderUpdate();
  // A Team Environment's folder is the whole Team's.
  files.shared(current.preset.name === "hosted-organization-team");
  relabel();
  catalog.render();
  void readShell();
  // One settings row per recorded fact: the name on the left, the value on
  // the right.
  controls.machine.replaceChildren(
    ...machineRows(current.machine).map(([key, value]) => {
      const row = document.createElement("div");
      row.className = "row";
      const main = document.createElement("div");
      main.className = "row-main";
      const term = document.createElement("dt");
      term.textContent = copy[key];
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
    }),
  );
  controls.presetSelect.replaceChildren(
    ...current.allowedPresets.map(
      (name) =>
        new Option(
          copy[presetLabels[name] ?? "preset"],
          name,
          false,
          name === current.preset.name,
        ),
    ),
  );
  controls.presetSelection.textContent =
    current.preset.selection === "explicit"
      ? copy.presetExplicit
      : copy.presetDerived;
  for (const [key, value] of Object.entries(current.profile)) {
    const control = controls.form.elements.namedItem(key);
    if (control instanceof HTMLSelectElement) control.value = value;
  }
  controls.status.textContent = `${copy.revision} ${current.revision} · ${current.profile.os}`;
  controls.choices.disabled = false;
  // The tools section follows the same state: locale and revision.
  void tools.refresh();
}
// The tools section (decision F18). A change recorded there moves the Folder
// revision, so a profile preview made before it is no longer valid.
const tools = createToolsPanel({
  observed: (overview) => {
    toolsOverview = overview;
    catalog.render();
  },
  post,
  copy: () => copy,
  changed: async () => {
    pending = null;
    controls.apply.disabled = true;
    await load();
  },
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
// origins. A plain click on one first asks the server for a one-time pairing
// link on that origin and follows it in this tab, as the resident did
// (`R:launchpad/public/app.js:2257-2281`); when there is none (no T3
// launcher, a failed call) it follows the plain origin, where the app itself
// asks an unpaired browser to pair. Apps on this origin moves within the page.
const pairing: Readonly<
  Record<
    string,
    Readonly<{
      path: string;
      origin: (entry: PublicEntry) => string | undefined;
      accept: (value: unknown, origin: string) => string | null;
    }>
  >
> = {
  chat: {
    path: "/api/chat/pair",
    origin: (current) => current.t3codeOrigin,
    accept: chatPairLink,
  },
  automate: {
    path: "/api/mausbot/pair",
    origin: (current) => current.mausbotOrigin,
    accept: mausbotPairLink,
  },
};
// The address to follow into Chat or Automate: a one-time pairing link on
// its origin when the server mints one, otherwise the plain origin.
async function pairedHref(app: string): Promise<string | null> {
  const pair = Object.hasOwn(pairing, app) ? pairing[app] : undefined;
  const plain =
    entry === null || pair === undefined ? undefined : pair.origin(entry);
  if (pair === undefined || plain === undefined) return null;
  try {
    const { value, ok } = await post(pair.path, {});
    return (ok && pair.accept(value, plain)) || plain;
  } catch {
    return plain;
  }
}
// "+ Nový modul" (decision F36 addendum of 2026-10-04). Where this
// Environment's Chat takes a prepared prompt by link (Lazurio/t3code#35,
// the server asks its T3 Code for the version), Chat opens in a new tab
// through the pairing with the prompt's id and the Organization in the
// link's fragment, never the text: the fork fetches the text from its own
// origin and leaves it in a new thread's composer, not sent, and nothing is
// copied. Otherwise, and when the tab cannot open, the prompt goes to the
// clipboard (written first, while the page still has the focus) and Chat
// opens, where the person pastes it into a new chat. A workstation has no
// Chat origin: the prompt is copied all the same.
async function handOver(prompt: NewModulePrompt): Promise<NewModuleOutcome> {
  const current = entry;
  if (current !== null && chatTakesPrompts) {
    const tab = window.open("about:blank", "_blank");
    if (tab !== null) {
      const next = await pairedHref("chat");
      const href =
        next === null
          ? null
          : chatPromptHref(next, current.t3codeOrigin, prompt);
      if (href === null) {
        tab.close();
        return "failed";
      }
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
  if (tab !== null) {
    const next = await pairedHref("chat");
    if (next === null) tab.close();
    else {
      tab.opener = null;
      tab.location.href = next;
    }
  }
  return (await copying) ? "copied" : "failed";
}
let following = false;
document.addEventListener("lazurio-app", (event) => {
  const detail = (event as CustomEvent<{ app?: unknown; href?: unknown }>)
    .detail;
  if (typeof detail?.href !== "string" || typeof detail.app !== "string")
    return;
  const target = new URL(detail.href, location.href);
  if (target.origin === location.origin) {
    event.preventDefault();
    shell.navigate(target.pathname);
    return;
  }
  const pair = Object.hasOwn(pairing, detail.app)
    ? pairing[detail.app]
    : undefined;
  if (entry === null || pair === undefined || pair.origin(entry) === undefined)
    return;
  event.preventDefault();
  if (following) return;
  following = true;
  const { app, href } = detail;
  void (async () => {
    location.assign((await pairedHref(app)) ?? href);
  })();
});
// Back from the app restores this page from the bfcache with the click that
// navigated away still held.
window.addEventListener("pageshow", () => {
  following = false;
});
async function readEntry() {
  try {
    const { value, ok } = await get("/api/entry");
    entry = ok ? parseEntryAnswer(value) : null;
  } catch {
    entry = null;
  }
  recovery.render();
  catalog.render();
  if (entry === null) return;
  try {
    const { value, ok } = await get("/api/chat/prompt-handoff");
    chatTakesPrompts = ok && parsePromptHandoff(value);
  } catch {
    chatTakesPrompts = false;
  }
}
void readEntry();
void readShell();
load().catch(() => {
  controls.status.textContent = copy.loadFailed;
  // The tools section says for itself that it could not be read.
  void tools.refresh();
});
void catalog.refresh();

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
const updateFolderRefresh = document.querySelector<HTMLParagraphElement>(
  "#update-folder-refresh",
);
if (
  !updateSection ||
  !updateText ||
  !updateNotes ||
  !updateAction ||
  !updateChecked ||
  !updateError ||
  !updateStateInvalid ||
  !updateFolderRefresh
)
  throw new Error("Missing update UI");
let updateStatus: PillStatus | null = null;
let updateNote: string | null = null;
function renderUpdate() {
  if (!updateStatus || !updateSection) return;
  const view = pillView(updateStatus, copy, Date.now());
  // Only while an update is available (pillVisible); the Folder refresh
  // line below is independent of the pill.
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
  // Read-only: the command is shown, never run from here. It stands in its
  // own selectable monospace line of the sentence.
  if (updateFolderRefresh) {
    const refresh = updateStatus.folderRefresh;
    updateFolderRefresh.hidden = view.folderRefresh === null;
    if (refresh === null) updateFolderRefresh.replaceChildren();
    else {
      const [before, after = ""] = fill(copy.updateFolderRefresh, {
        recorded: refresh.recorded,
        product: refresh.product,
      }).split("{command}");
      const command = document.createElement("code");
      command.textContent = refresh.command;
      updateFolderRefresh.replaceChildren(
        (before ?? "").trimEnd(),
        command,
        after,
      );
    }
  }
}
async function refreshUpdate() {
  try {
    const response = await fetch("/api/update/status", {
      headers: credential(),
      cache: "no-store",
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
updateTimer = setInterval(() => void refreshUpdate(), 10_000);
void refreshUpdate();
