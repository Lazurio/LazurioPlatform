import { createCatalogPanel } from "./catalog-panel";
import type { PublicEntry } from "./chat";
import { chatHref, chatPairLink, parseEntryAnswer } from "./chat-view";
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
// and until read. The Chat link and the Recovery page's T3 Code link.
let entry: PublicEntry | null = null;
const [chatMenu, chat] = ((menu, link) => {
  if (!menu || !link) throw new Error("Missing chat UI");
  return [menu, link] as const;
})(
  document.querySelector<HTMLUListElement>("#chat-menu"),
  document.querySelector<HTMLAnchorElement>("#chat"),
);
// The Launchpad home: the catalog of this Folder's Organizations and modules
// (launchpad-parity B1), drawn for the route the frame shows.
const catalog = createCatalogPanel({
  post: (path, body) => post(path, body),
  get: (path) => get(path),
  copy: () => copy,
  route: () => shell.route(),
  loaded: () => shell.relabel(),
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
// the sheet of a narrow viewport.
const shell = createShell({
  copy: () => copy,
  displayName: (organization) => catalog.displayName(organization),
  onRoute: (route) => {
    catalog.render(route);
    if (
      route.view === "settings" &&
      route.section === "recovery" &&
      !recovery.loaded
    )
      void recovery.refresh();
  },
});
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
        assignment?:
          | { kind: "operator"; githubLogin: string; githubId: number }
          | { kind: "team" };
      };
  network: { headscaleHostname: string } | null;
  host: { kind: string; id: string };
  relationships?: { zone: string; peers: MachinePeer[] };
};
let current: {
  revision: number;
  preset: { name: string; version: number; selection: string };
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
      ? binding.owner.assignment.kind === "team"
        ? copy.machineAssignmentTeam
        : `${binding.owner.assignment.githubLogin} (GitHub id ${binding.owner.assignment.githubId})`
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
  shell.relabel();
  renderChat();
  recovery.render();
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
  relabel();
  catalog.render();
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
// Chat (launchpad-parity B8): the recorded entry's T3 Code origin as a plain
// link, shown only with an entry. A plain click first asks the server for a
// one-time pairing link on that origin and follows it in this tab, as the
// resident did (`R:launchpad/public/app.js:2257-2281`); when there is none
// (no T3 launcher, a failed call) it follows the plain origin, where T3 Code
// itself asks an unpaired browser to pair. A modified click opens the plain
// origin as a link does.
function renderChat() {
  const href = chatHref(entry);
  chatMenu.hidden = href === null;
  chat.hidden = href === null;
  if (href === null) chat.removeAttribute("href");
  else chat.href = href;
  chat.title = copy.chatTitle;
}
chat.addEventListener("click", async (event) => {
  const current = entry;
  if (
    current === null ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  if (chat.getAttribute("aria-disabled") === "true") return;
  chat.setAttribute("aria-disabled", "true");
  let target = current.t3codeOrigin;
  try {
    const { value, ok } = await post("/api/chat/pair", {});
    target = (ok && chatPairLink(value, current.t3codeOrigin)) || target;
  } catch {}
  location.assign(target);
});
// Back from T3 Code restores this page from the bfcache with the link still
// held by the click that navigated away.
window.addEventListener("pageshow", () =>
  chat.removeAttribute("aria-disabled"),
);
async function readEntry() {
  try {
    const { value, ok } = await get("/api/entry");
    entry = ok ? parseEntryAnswer(value) : null;
  } catch {
    entry = null;
  }
  renderChat();
  recovery.render();
}
void readEntry();
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
