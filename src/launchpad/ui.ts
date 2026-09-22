import {
  applicationMessage,
  discoveredApplicationChoices,
  localApplicationLink,
} from "./application-view";
import { type MessageKey, messages } from "./messages";

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
let copy = messages("en");
type MachineBinding = {
  kind: string;
  name: string;
  owner:
    | { kind: "principal"; githubLogin: string; githubId: number }
    | { kind: "organization"; organization: string; team: string | null };
  network: { headscaleHostname: string } | null;
  host: { kind: string; id: string };
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
};
// The immutable part: rendered as text only, never as editable controls.
function machineRows(binding: MachineBinding | null): [MessageKey, string][] {
  if (binding === null) return [["machineKind", copy.machineWorkstation]];
  const owner =
    binding.owner.kind === "principal"
      ? `${binding.owner.githubLogin} (GitHub id ${binding.owner.githubId})`
      : binding.owner.organization;
  return [
    ["machineKind", binding.kind],
    ["machineName", binding.name],
    ["machineOwner", owner],
    ...(binding.owner.kind === "organization" && binding.owner.team !== null
      ? ([["machineTeam", binding.owner.team]] as [MessageKey, string][])
      : []),
    ["machineTailnet", binding.network?.headscaleHostname ?? copy.machineNone],
    ["machineHost", `${binding.host.kind} ${binding.host.id}`],
  ];
}
async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
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
  copy = messages(current.profile.locale);
  document.documentElement.lang = current.profile.locale === "cs" ? "cs" : "en";
  document.title = copy.title;
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-message]",
  )) {
    const key = element.dataset.message;
    if (key && Object.hasOwn(copy, key))
      element.textContent = copy[key as MessageKey];
  }
  controls.machine.replaceChildren(
    ...machineRows(current.machine).flatMap(([key, value]) => {
      const term = document.createElement("dt");
      term.textContent = copy[key];
      const detail = document.createElement("dd");
      detail.textContent = value;
      return [term, detail];
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
}
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
load().catch(() => {
  controls.status.textContent = copy.loadFailed;
});

const appForm = document.querySelector<HTMLFormElement>("#application");
const appChoices = document.querySelector<HTMLFieldSetElement>("#app-choices");
const appStatus = document.querySelector<HTMLParagraphElement>("#app-status");
const appResult = document.querySelector<HTMLPreElement>("#app-result");
const appLink = document.querySelector<HTMLAnchorElement>("#app-link");
if (!appForm || !appChoices || !appStatus || !appResult || !appLink)
  throw new Error("Missing application UI");
const apps = {
  form: appForm,
  choices: appChoices,
  status: appStatus,
  result: appResult,
  link: appLink,
};
function clearAppLink() {
  apps.link.hidden = true;
  apps.link.removeAttribute("href");
}
function clearAppSelectionResult() {
  clearAppLink();
  apps.status.textContent = "";
  apps.result.textContent = "";
}
apps.form.addEventListener("input", clearAppSelectionResult);
controls.form.addEventListener("change", clearAppLink);
const discover = document.querySelector<HTMLButtonElement>("#app-discover");
const discovered = document.querySelector<HTMLSelectElement>("#app-discovered");
const discoveryStatus = document.querySelector<HTMLParagraphElement>(
  "#app-discovery-status",
);
const discoveryResult = document.querySelector<HTMLPreElement>(
  "#app-discovery-result",
);
if (!discover || !discovered || !discoveryStatus || !discoveryResult)
  throw new Error("Missing discovery UI");
const discovery = {
  button: discover,
  select: discovered,
  status: discoveryStatus,
  result: discoveryResult,
};
let observedChoices: ReturnType<typeof discoveredApplicationChoices> = [];
discovery.button.addEventListener("click", async () => {
  if (apps.choices.disabled) return;
  clearAppLink();
  apps.choices.disabled = true;
  discovery.result.textContent = "";
  observedChoices = [];
  discovery.select.replaceChildren(new Option("", ""));
  discovery.select.disabled = true;
  discovery.button.disabled = true;
  discovery.status.textContent = copy.appBusy;
  try {
    const { value, ok } = await post("/api/apps/discover", {});
    discovery.result.textContent = JSON.stringify(value, null, 2);
    if (!ok || value?.kind !== "applications-observed")
      throw new Error("Discovery unavailable");
    observedChoices = discoveredApplicationChoices(value);
    observedChoices.forEach((selection, index) => {
      discovery.select.add(
        new Option(
          `${selection.company} / ${selection.module} / ${selection.package}`,
          String(index),
        ),
      );
    });
    discovery.select.disabled = observedChoices.length === 0;
    discovery.status.textContent = copy.appDiscoveryNotice;
  } catch {
    discovery.status.textContent = copy.appDiscoveryUnavailable;
  } finally {
    discovery.button.disabled = false;
    apps.choices.disabled = false;
  }
});
discovery.select.addEventListener("change", () => {
  clearAppLink();
  if (apps.choices.disabled || discovery.select.value === "") return;
  const selection = observedChoices[Number(discovery.select.value)];
  if (!selection) return;
  clearAppSelectionResult();
  for (const [key, value] of Object.entries(selection)) {
    const field = apps.form.elements.namedItem(key);
    if (field instanceof HTMLInputElement) field.value = value;
  }
});
apps.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = event.submitter;
  if (
    !(action instanceof HTMLButtonElement) ||
    !["prepare", "clean-prepare", "start", "status", "open", "stop"].includes(
      action.value,
    )
  )
    return;
  const operation = action.value;
  const selection = Object.fromEntries(new FormData(apps.form).entries());
  clearAppLink();
  apps.choices.disabled = true;
  discovery.button.disabled = true;
  discovery.select.disabled = true;
  apps.status.textContent = copy.appBusy;
  try {
    const { value, ok } = await post(`/api/apps/${operation}`, selection);
    apps.result.textContent = JSON.stringify(value, null, 2);
    const local = current?.profile.access === "local";
    apps.status.textContent = copy[applicationMessage(value, local)];
    const link =
      value?.kind === "local-entrypoint"
        ? localApplicationLink(value.url)
        : null;
    if (ok && local && link) {
      apps.link.href = link;
      apps.link.hidden = false;
    }
  } catch {
    apps.status.textContent = copy.appResultUnknown;
  } finally {
    apps.choices.disabled = false;
    discovery.button.disabled = false;
    discovery.select.disabled = observedChoices.length === 0;
  }
});
