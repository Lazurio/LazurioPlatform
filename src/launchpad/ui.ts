import { type MessageKey, messages } from "./messages";

const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const form = document.querySelector<HTMLFormElement>("#profile");
const choices = document.querySelector<HTMLFieldSetElement>("#choices");
const apply = document.querySelector<HTMLButtonElement>("#apply");
const status = document.querySelector<HTMLParagraphElement>("#status");
const result = document.querySelector<HTMLPreElement>("#result");
if (!form || !choices || !apply || !status || !result)
  throw new Error("Missing UI");
const controls = { form, choices, apply, status, result };
let copy = messages("en");
let current: { revision: number; profile: Record<string, string> };
let pending: {
  expectedRevision: number;
  profile: Record<string, string>;
} | null = null;
async function request(path: string, body: unknown) {
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
  controls.result.textContent = JSON.stringify(value, null, 2);
  if (!response.ok) throw new Error(copy.refused);
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
    const profile = {
      ...current.profile,
      ...Object.fromEntries(new FormData(controls.form).entries()),
    } as Record<string, string>;
    controls.choices.disabled = true;
    const candidate = { expectedRevision: current.revision, profile };
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
