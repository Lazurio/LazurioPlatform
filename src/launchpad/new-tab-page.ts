import { browserViewDocumentPath } from "../browser/contract/platform";
import {
  addressBarTarget,
  browserLanguage,
  browserTimes,
  type NewTabChoice,
  newTabToolIcon,
  parseNewTabChoice,
} from "../browser/contract/pure";
import { parseShell, type Shell } from "../shell/contract";
import {
  acceptNewTabHostMessage,
  type NewTabHostMessage,
  type NewTabTheme,
  newTabHostOrigins,
  newTabMessage,
  newTabReadyTargets,
  newTabThemeRoles,
} from "../shell/new-tab-protocol";
import { bootElementId, parseBoot } from "./boot";
import {
  actionFailure,
  catalogModuleLook,
  closeOutcome,
  closeWarning,
  fill,
  hideAnswered,
  hideAsked,
  isNoBrowser,
  type ModuleRow,
  memoryModel,
  moduleRows,
  type NewTabAnswer,
  type NewTabOverview,
  type NewTabTab,
  newTabCopy,
  noteMs,
  overviewFailure,
  type PendingUndo,
  pageStrip,
  parseOverview,
  settleOverrides,
  suggestions,
  type TabOverride,
  type TabRow,
  tabRows,
  toastModel,
  toolForKey,
  viewOriginOf,
  withOverride,
} from "./new-tab-view";

// The page `/new-tab` (decision F47 points 1-3 and 6-8): Nová karta, drawn
// on the Launchpad's origin so that its reads and writes are same-origin
// with it. Inside `<lazurio-new-tab>` it says it is ready to the app around
// it and draws what the app hands over (its strip, tools, language and
// colour roles), and posts what the tab became; nothing else navigates the
// app. Standalone (Matěj 2026-10-11: Codex Desktop's browser opens it on its
// own), when it is not framed or no host message came within 1.5 s: the
// strip is the Launchpad's, there are no tools, the address bar takes the
// focus and a choice navigates this window to the tab's view; a page opened
// here is the Launchpad's to hold, a tab chosen in Přehled is not. Přehled is
// read every 5 s while the page is visible, never while it is hidden. What
// it decides is new-tab-view.ts; this module only draws and asks.

const find = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing ${id}`);
  return element;
};
const form = find("address-form", HTMLFormElement);
const input = find("address", HTMLInputElement);
const foreignBox = find("foreign", HTMLDivElement);
const toolsSection = find("tools", HTMLElement);
const toolsTitle = find("tools-title", HTMLHeadingElement);
const toolsList = find("tools-list", HTMLDivElement);
const overviewTitle = find("overview-title", HTMLHeadingElement);
const overviewBody = find("overview-body", HTMLDivElement);
const suggestedSection = find("suggested", HTMLElement);
const suggestedTitle = find("suggested-title", HTMLHeadingElement);
const suggestedCaption = find("suggested-caption", HTMLHeadingElement);
const suggestedList = find("suggested-list", HTMLDivElement);
const toastRegion = find("toast", HTMLDivElement);

// What the server's boot document carries (boot.ts): the Folder's
// language, the shell document, the catalog and the recorded entry's public
// parts. Without it (a slow boot read) the page reads the shell document and
// the view's origin itself, and has no names or suggestions from a catalog.
const boot = parseBoot(document.getElementById(bootElementId)?.textContent);
let locale: "cs" | "en" = boot?.locale ?? browserLanguage(navigator.language);
let copy = newTabCopy(locale);
let shell: Shell | null = boot?.shell ?? null;
const entry = boot?.entry ?? null;
const catalog = boot?.catalog ?? null;
const look = catalogModuleLook(catalog);
const offered = suggestions(catalog, entry);
let viewOrigin: string | null =
  entry?.browserOrigin !== undefined && entry.browserOrigin !== location.origin
    ? entry.browserOrigin
    : null;

// Hosted or standalone: decided by the first host message, or after 1.5 s
// without one; a page that is not framed is standalone at once. A host
// message that comes later still makes it hosted: a slow host is no other
// host.
const framed = window.parent !== window;
let mode: "waiting" | "hosted" | "standalone" = framed
  ? "waiting"
  : "standalone";
let host: NewTabHostMessage | null = null;
let hostOrigin: string | null = null;
let hostOrigins: readonly string[] =
  shell === null ? [] : newTabHostOrigins(shell, location.origin);
let decide: () => void = () => undefined;
const decided = new Promise<void>((resolve) => {
  decide = resolve;
});
if (mode === "standalone") decide();
const standaloneTimer = framed
  ? setTimeout(() => {
      if (mode !== "waiting") return;
      mode = "standalone";
      decide();
      drawAll();
      focusAddress();
    }, browserTimes.standaloneAfterMs)
  : undefined;

/** The strip a page opened here is for: the host's, else none (0191 point
 * 29). */
const stripNow = (): string | null => pageStrip(mode, host?.strip ?? null);

// Přehled's state.
let overview: NewTabOverview | null = null;
let overviewState:
  | "loading"
  | "ready"
  | "failed"
  | "unreachable"
  | "no-browser" = "loading";
/** The Environment's clock minus this browser's, from the overview's
 * `Date`: "when last used" is measured on the clock that wrote it. */
let clockOffset = 0;
/** Overviews requested so far (`TabOverride`). */
let requests = 0;
let overrides: readonly TabOverride[] = [];
/** Modules stopped here, until an overview requested after the stop. */
let stopped: readonly Readonly<{ unit: string; after: number }>[] = [];
const stopping = new Set<string>();
let opening = false;
let foreign: Readonly<{ href: string; where: string }> | null = null;
let warningOpen = false;
let pending: PendingUndo | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let note: string | null = null;
let noteTimer: ReturnType<typeof setTimeout> | undefined;

// ---- Drawing ----------------------------------------------------------------

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function relabel() {
  document.documentElement.lang = locale;
  document.title = copy.pageTitle;
  input.placeholder = copy.address;
  input.setAttribute("aria-label", copy.address);
  toolsTitle.textContent = copy.tools;
  overviewTitle.textContent = copy.overview;
  suggestedTitle.textContent = copy.suggested;
  suggestedCaption.textContent = copy.appsCaption;
}

function setLocale(next: "cs" | "en") {
  if (next === locale) return;
  locale = next;
  copy = newTabCopy(locale);
  drawAll();
}

function applyTheme(theme: NewTabTheme) {
  const style = document.documentElement.style;
  for (const role of newTabThemeRoles) {
    const value = theme[role];
    if (value === undefined) style.removeProperty(role);
    else style.setProperty(role, value);
  }
}

function focusAddress() {
  if (!warningOpen) input.focus({ preventScroll: true });
}

function drawTools() {
  const tools = mode === "hosted" ? (host?.tools ?? []) : [];
  toolsSection.hidden = tools.length === 0;
  toolsList.replaceChildren(
    ...tools.map((tool) => {
      const button = element("button", "nt-tool");
      button.type = "button";
      if (tool.key !== undefined) {
        button.setAttribute("aria-keyshortcuts", tool.key);
        button.title = `${tool.label} (${tool.key})`;
      }
      button.append(
        icon(newTabToolIcon(tool)),
        element("span", "nt-tool-label", tool.label),
      );
      if (tool.key !== undefined)
        button.append(element("kbd", "nt-kbd", tool.key));
      button.addEventListener("click", () =>
        choose({ kind: "tool", id: tool.id }),
      );
      return button;
    }),
  );
}

function drawForeign() {
  foreignBox.hidden = foreign === null;
  if (foreign === null) {
    foreignBox.replaceChildren();
    return;
  }
  const text = element("span", "nt-notice-text");
  // The Environment's id stays on one line: it breaks at its hyphens.
  text.append(
    element("strong", "", copy.foreign),
    " ",
    element("span", "nt-notice-where", `(${foreign.where}).`),
  );
  const link = element("a", "nt-notice-link", copy.foreignOpen);
  link.href = foreign.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const dismiss = element("button", "nt-icon-button");
  dismiss.type = "button";
  dismiss.setAttribute("aria-label", copy.dismiss);
  dismiss.append(icon("x"));
  dismiss.addEventListener("click", () => {
    foreign = null;
    drawForeign();
    focusAddress();
  });
  foreignBox.replaceChildren(icon("info"), text, link, dismiss);
}

/** A tab's icon: its favicon, or a globe when it has none or it does not
 * load; a dot while an agent works in it. */
function favicon(row: TabRow): HTMLSpanElement {
  const box = element("span", "nt-favicon");
  if (row.favicon === null) box.append(icon("globe"));
  else {
    const image = element("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.src = row.favicon;
    image.addEventListener("error", () => image.replaceWith(icon("globe")), {
      once: true,
    });
    box.append(image);
  }
  if (row.status?.working === true) {
    const dot = element("span", "nt-agent");
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", copy.statusWorking);
    box.append(dot);
  }
  return box;
}

function tabItem(row: TabRow, tab: NewTabTab): HTMLLIElement {
  const item = element("li", "nto-row");
  const open = element("button", "nto-open");
  open.type = "button";
  open.title = row.openTitle;
  open.dataset.focusKey = `open:${row.id}`;
  const meta = element("span", "nto-meta");
  if (row.who !== null) {
    const who = element("span", "nto-who");
    who.title = copy.whoTitle;
    who.append(icon(row.who.icon), row.who.text);
    meta.append(who);
  }
  if (row.status !== null)
    meta.append(
      element(
        "span",
        row.status.working ? "nto-status-working" : "",
        row.status.text,
      ),
    );
  if (row.here) meta.append(element("span", "nto-here", copy.inThisThread));
  const text = element("span", "nto-text");
  text.append(element("span", "nto-name", row.title), meta);
  open.append(favicon(row), text);
  open.addEventListener("click", () => {
    if (row.view === null) say(copy.openFailed);
    else choose({ kind: "tab", tab: row.id, view: row.view });
  });
  const memory = element(
    "span",
    `nto-mem${row.heavy ? " is-heavy" : ""}`,
    row.memory ?? "",
  );
  if (row.memory !== null) memory.title = copy.heapTitle;
  const close = element("button", "nto-action", copy.close);
  close.type = "button";
  close.title = row.closeTitle;
  close.setAttribute("aria-label", fill(copy.closeTab, { title: row.title }));
  close.dataset.focusKey = `close:${row.id}`;
  close.addEventListener("click", () => askClose(tab, close));
  const actions = element("span", "nto-actions");
  actions.append(close);
  item.append(open, memory, actions);
  return item;
}

function moduleItem(row: ModuleRow): HTMLLIElement {
  const item = element("li", "nto-row");
  const what = element("span", "nto-open is-static");
  if (row.stone === null) what.append(icon("grid"));
  else {
    const stone = element("img", "nt-stone");
    stone.alt = "";
    stone.width = 16;
    stone.height = 16;
    stone.src = row.stone;
    what.append(stone);
  }
  const text = element("span", "nto-text");
  text.append(
    element("span", "nto-name", row.name),
    element("span", "nto-meta", row.line),
  );
  what.append(text);
  const memory = element(
    "span",
    `nto-mem${row.heavy ? " is-heavy" : ""}`,
    row.memory ?? "",
  );
  const busy = stopping.has(row.unit);
  const stop = element(
    "button",
    "nto-action",
    busy ? copy.stopping : copy.stop,
  );
  stop.type = "button";
  stop.disabled = busy;
  stop.title = copy.stopTitle;
  stop.setAttribute("aria-label", fill(copy.stopModule, { name: row.name }));
  stop.dataset.focusKey = `stop:${row.unit}`;
  stop.addEventListener("click", () => void stopModule(row));
  const actions = element("span", "nto-actions");
  actions.append(stop);
  item.append(what, memory, actions);
  return item;
}

function group(title: string, count: number | null): HTMLElement {
  const box = element("section", "nto-group");
  const head = element("h3", "nto-group-title", title);
  if (count !== null) head.append(element("span", "nto-count", String(count)));
  box.append(head);
  return box;
}

let drawnOverview = "";

/** Přehled for the last answer; drawn again only when it says something
 * else, and with the focus kept on the control that had it. */
function drawOverview(force = false) {
  const strip = mode === "hosted" ? (host?.strip ?? null) : null;
  const memory =
    overview === null ? null : memoryModel(overview.memory, copy, locale);
  const tabs = overview?.tabs ?? null;
  const rows =
    tabs === null
      ? null
      : tabRows(tabs, {
          now: Date.now() + clockOffset,
          strip,
          viewOrigin,
          overrides,
          copy,
          locale,
        });
  const modules =
    overview?.modules == null
      ? null
      : moduleRows(
          overview.modules.filter(
            (module) => !stopped.some((stop) => stop.unit === module.unit),
          ),
          look,
          copy,
          locale,
        );
  const signature = JSON.stringify([
    overviewState,
    overview === null,
    memory,
    rows,
    modules,
    [...stopping],
    locale,
  ]);
  if (!force && signature === drawnOverview) return;
  drawnOverview = signature;
  const focused =
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.dataset.focusKey ?? null)
      : null;
  const parts: HTMLElement[] = [];
  if (overviewState === "no-browser") {
    parts.push(element("p", "nto-empty", copy.noBrowser));
    overviewBody.replaceChildren(...parts);
    return;
  }
  // The last reading failed: said above what an earlier one showed.
  const failure =
    overviewState === "failed"
      ? copy.overviewFailed
      : overviewState === "unreachable"
        ? copy.launchpadUnreachable
        : null;
  if (overview === null) {
    parts.push(element("p", "nto-status", failure ?? copy.overviewLoading));
    overviewBody.replaceChildren(...parts);
    return;
  }
  if (failure !== null) parts.push(element("p", "nto-status", failure));
  if (memory !== null) {
    const box = element("section", "nto-memory");
    box.dataset.tone = memory.tone;
    box.setAttribute("aria-label", copy.memoryTitle);
    const head = element("div", "nto-memory-head");
    head.append(element("span", "nto-memory-title", copy.memoryTitle));
    if (memory.value !== null) {
      const value = element("span", "nto-memory-value");
      value.append(
        element("strong", "", memory.value.used),
        ` ${copy.memoryOf} ${memory.value.total}`,
      );
      head.append(value);
    }
    box.append(head);
    if (memory.percent !== null) {
      const bar = element("span", "nto-bar");
      bar.setAttribute("aria-hidden", "true");
      const fillBar = element("span", "nto-bar-fill");
      fillBar.style.width = `${memory.percent}%`;
      bar.append(fillBar);
      box.append(bar);
    }
    if (memory.parts.length > 0) {
      const line = element("div", "nto-memory-parts");
      for (const part of memory.parts) {
        const span = element("span", "", part.text);
        if (part.title !== null) span.title = part.title;
        line.append(span);
      }
      box.append(line);
    }
    if (memory.hint !== null) {
      const hint = element("p", "nto-memory-hint");
      hint.append(icon("warning"), memory.hint);
      box.append(hint);
    }
    parts.push(box);
  }
  const tabsBox = group(copy.tabsTitle, rows === null ? null : rows.length);
  if (rows === null)
    tabsBox.append(element("p", "nto-empty", copy.hubUnreachable));
  else if (rows.length === 0)
    tabsBox.append(element("p", "nto-empty", copy.tabsEmpty));
  else {
    const list = element("ul", "nto-list");
    const byId = new Map((tabs ?? []).map((tab) => [tab.id, tab]));
    for (const row of rows) {
      const tab = byId.get(row.id);
      if (tab !== undefined) list.append(tabItem(row, tab));
    }
    tabsBox.append(list);
  }
  parts.push(tabsBox);
  const modulesBox = group(
    copy.modulesTitle,
    modules === null ? null : modules.length,
  );
  if (modules === null)
    modulesBox.append(element("p", "nto-empty", copy.modulesUnknown));
  else if (modules.length === 0)
    modulesBox.append(element("p", "nto-empty", copy.modulesEmpty));
  else {
    const list = element("ul", "nto-list");
    list.append(...modules.map(moduleItem));
    modulesBox.append(list);
  }
  parts.push(modulesBox);
  overviewBody.replaceChildren(...parts);
  if (focused !== null)
    overviewBody
      .querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)
      ?.focus({ preventScroll: true });
}

function drawSuggested() {
  suggestedSection.hidden = offered.length === 0;
  suggestedList.replaceChildren(
    ...offered.map((suggestion) => {
      const tile = element("button", "nt-tile");
      tile.type = "button";
      const stone = element("img", "nt-stone");
      stone.alt = "";
      stone.width = 36;
      stone.height = 36;
      stone.src = suggestion.stone;
      tile.append(stone, element("span", "nt-tile-name", suggestion.name));
      tile.addEventListener("click", () => void openPage(suggestion.href));
      return tile;
    }),
  );
}

function drawToast() {
  const model = toastModel(pending, note, copy);
  if (model === null) {
    toastRegion.replaceChildren();
    return;
  }
  const toast = element("div", "nt-toast");
  const text = element("span");
  if (model.note !== null) {
    if (model.text === null) text.textContent = model.note;
    else text.append(element("span", "nt-toast-note", model.note));
  }
  if (model.text !== null) text.append(model.text);
  toast.append(text);
  if (model.undo !== null) {
    const undo = element("button", "nt-toast-undo", model.undo);
    undo.type = "button";
    undo.addEventListener("click", () => void restore());
    toast.append(undo);
  }
  toastRegion.replaceChildren(toast);
}

function drawAll() {
  relabel();
  drawTools();
  drawForeign();
  drawOverview(true);
  drawSuggested();
  drawToast();
}

/** A short message, above Vrátit while a close waits for its grace. */
function say(text: string) {
  note = text;
  drawToast();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note = null;
    drawToast();
  }, noteMs);
}

// ---- What the tab becomes ---------------------------------------------------------

/** The host hears the choice and turns its tab into it; standalone, this
 * window goes to the tab's view. */
function choose(choice: NewTabChoice) {
  if (mode === "hosted" && hostOrigin !== null) {
    window.parent.postMessage(
      { type: newTabMessage.choice, choice },
      hostOrigin,
    );
    return;
  }
  if (choice.kind !== "tool") location.assign(choice.view);
}

async function post(path: string, body: unknown): Promise<NewTabAnswer> {
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return {
      status: response.status,
      value: await response.json().catch(() => null),
    };
  } catch {
    return { status: 0, value: null };
  }
}

/** A new remote tab at `url`, only now (F47 point 3), for the host's strip
 * or, standalone, for nobody: it ends 30 s after its last viewer leaves
 * (root decision 0191 point 29). */
async function openPage(url: string) {
  if (opening) return;
  opening = true;
  form.setAttribute("aria-busy", "true");
  try {
    await decided;
    const strip = stripNow();
    const answer = await post("/api/new-tab/open", {
      url,
      ...(strip === null ? {} : { strip }),
    });
    const value =
      typeof answer.value === "object" && answer.value !== null
        ? (answer.value as Record<string, unknown>)
        : {};
    const choice =
      answer.status === 201
        ? parseNewTabChoice({ kind: "page", tab: value.tab, view: value.view })
        : null;
    if (choice === null) {
      say(actionFailure(answer, copy.openFailed, copy));
      return;
    }
    input.value = "";
    choose(choice);
    void poll();
  } finally {
    opening = false;
    form.removeAttribute("aria-busy");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const target = addressBarTarget(input.value, viewOrigin);
  foreign = target.kind === "foreign" ? target : null;
  drawForeign();
  if (target.kind === "tab")
    choose({ kind: "tab", tab: target.tab, view: target.view });
  else if (target.kind === "page") void openPage(target.url);
  // This view's bare origin: a new blank remote tab, as in a browser.
  else if (target.kind === "new-tab") void openPage("about:blank");
  else if (target.kind === "refused")
    say(
      target.reason === "view"
        ? copy.addressRefused
        : copy.addressRefusedScheme,
    );
});

// Escape clears what was typed, as in a browser.
input.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  input.value = "";
  input.blur();
});

/** Where the person types: letters belong there, not to the tools. */
const typing = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  ) !== null;

// The host's tools open by their letters while nobody types (the
// wireframe's NewTab): T3 Code's launcher did so, and the page passes them
// on from inside its frame.
window.addEventListener(
  "keydown",
  (event) => {
    const tools = mode === "hosted" ? (host?.tools ?? []) : [];
    if (tools.length === 0) return;
    const id = toolForKey(
      {
        key: event.key,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        composing: event.isComposing,
        handled: event.defaultPrevented,
      },
      tools,
      { typing: typing(event.target), dialog: warningOpen },
    );
    if (id === null) return;
    event.preventDefault();
    choose({ kind: "tool", id });
  },
  true,
);

// ---- Closing for everyone, Vrátit and Zastavit -------------------------------

/** The warning before closing a tab an agent works in: focus on keeping
 * it, Escape keeps it, the focus returns where it was. */
function warn(tab: NewTabTab, confirm: () => void, back: HTMLElement) {
  const words = closeWarning(tab, copy);
  const scrim = element("div", "nt-scrim");
  const box = element("div", "nt-confirm");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "nt-confirm-title");
  box.setAttribute("aria-describedby", "nt-confirm-text");
  const title = element("strong", "nt-confirm-title", words.title);
  title.id = "nt-confirm-title";
  const text = element("p", "nt-confirm-text", words.text);
  text.id = "nt-confirm-text";
  const keep = element("button", "nt-button", words.keep);
  keep.type = "button";
  const close = element("button", "nt-button is-danger", words.close);
  close.type = "button";
  const actions = element("div", "nt-confirm-actions");
  actions.append(keep, close);
  box.append(title, text, actions);
  scrim.append(box);
  const done = (closeIt: boolean) => {
    scrim.remove();
    warningOpen = false;
    // Back to the same Zavřít, also when a reading drew the list anew
    // meanwhile.
    const key = back.dataset.focusKey;
    (back.isConnected || key === undefined
      ? back
      : overviewBody.querySelector<HTMLElement>(
          `[data-focus-key="${CSS.escape(key)}"]`,
        )
    )?.focus({ preventScroll: true });
    if (closeIt) confirm();
  };
  keep.addEventListener("click", () => done(false));
  close.addEventListener("click", () => done(true));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      done(false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      (document.activeElement === keep ? close : keep).focus();
    }
  });
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) done(false);
  });
  warningOpen = true;
  document.body.append(scrim);
  keep.focus();
}

function askClose(tab: NewTabTab, back: HTMLElement) {
  if (tab.agents.length > 0) warn(tab, () => void closeTab(tab), back);
  else void closeTab(tab);
}

/** Vrátit for `next` until `until` (this browser's clock, `undoDeadline`),
 * or none. */
function setPending(next: PendingUndo | null, until = 0) {
  clearTimeout(pendingTimer);
  pending = next;
  if (next !== null)
    pendingTimer = setTimeout(
      () => {
        pending = null;
        drawToast();
      },
      Math.max(0, until - Date.now()),
    );
  drawToast();
}

/** Zavřít: the tab ends for everyone after the grace (F47 point 6). It goes
 * from the list at once and stays gone until the hub has accepted the close
 * and a later overview says so, or comes back when the close fails; Vrátit
 * lasts until the hub's deadline. */
async function closeTab(tab: NewTabTab) {
  const text = tab.agents.length > 0 ? copy.closingAgent : copy.closing;
  overrides = hideAsked(overrides, tab.id);
  drawOverview();
  const sentAt = Date.now();
  const answer = await post("/api/new-tab/close", { tab: tab.id });
  const outcome = closeOutcome(answer, sentAt, Date.now());
  overrides = hideAnswered(
    overrides,
    tab.id,
    outcome.kind === "accepted",
    requests,
  );
  if (outcome.kind === "failed")
    say(actionFailure(answer, copy.closeFailed, copy));
  else if (outcome.undoUntil !== null)
    setPending(
      { tabs: [tab.id], text, shown: null, ends: true },
      outcome.undoUntil,
    );
  else if (answer.status === 202) say(text);
  drawOverview();
  void poll();
}

async function restore() {
  const closed = pending;
  if (closed === null) return;
  setPending(null);
  // One Zavřít closes one tab; Vrátit brings back what it closed.
  for (const tab of closed.tabs) {
    const answer = await post("/api/new-tab/restore", { tab });
    if (answer.status === 200)
      overrides = withOverride(overrides, tab, "shown", requests);
    else say(actionFailure(answer, copy.restoreFailed, copy));
  }
  drawOverview();
  void poll();
}

/** Zastavit: the Module's existing stop. */
async function stopModule(row: ModuleRow) {
  if (stopping.has(row.unit)) return;
  stopping.add(row.unit);
  drawOverview();
  const answer = await post(row.stop, { app: row.app });
  stopping.delete(row.unit);
  if (answer.status >= 200 && answer.status < 300) {
    stopped = [
      ...stopped.filter((stop) => stop.unit !== row.unit),
      { unit: row.unit, after: requests },
    ];
    say(
      row.memory === null
        ? fill(copy.stoppedPlain, { name: row.name })
        : fill(copy.stopped, { name: row.name, memory: row.memory }),
    );
  } else
    say(actionFailure(answer, fill(copy.stopFailed, { name: row.name }), copy));
  drawOverview();
  void poll();
}

// ---- Reading Přehled -------------------------------------------------------------

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
let pollAgain = false;

/** One reading of the overview, then the next in 5 s while the page is
 * visible; never while it is hidden, and no more once the Environment says
 * it has no browser. */
async function poll(): Promise<void> {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  if (document.visibilityState !== "visible") return;
  if (overviewState === "no-browser") return;
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;
  requests += 1;
  const request = requests;
  try {
    const response = await fetch("/api/new-tab/overview", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const date = Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(date)) clockOffset = date - Date.now();
    const value: unknown = await response.json().catch(() => null);
    if (isNoBrowser({ status: response.status, value })) {
      overviewState = "no-browser";
      overview = null;
    } else {
      const read = response.ok ? parseOverview(value) : null;
      if (read === null) overviewState = overviewFailure(response.status);
      else {
        overview = read;
        overviewState = "ready";
        if (read.tabs !== null) overrides = settleOverrides(overrides, request);
        stopped = stopped.filter((stop) => stop.after >= request);
      }
    }
  } catch {
    // No answer came: the Launchpad is unreachable (F47's failure modes).
    overviewState = "unreachable";
  } finally {
    polling = false;
  }
  drawOverview();
  if (pollAgain) {
    pollAgain = false;
    void poll();
    return;
  }
  if (document.visibilityState === "visible" && overviewState !== "no-browser")
    pollTimer = setTimeout(() => void poll(), browserTimes.overviewEveryMs);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void poll();
  else {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
});

// ---- The host ------------------------------------------------------------------------

window.addEventListener("message", (event) => {
  const message = acceptNewTabHostMessage(
    {
      data: event.data,
      origin: event.origin,
      fromParent: framed && event.source === window.parent,
    },
    hostOrigins,
  );
  if (message === null) return;
  const focusBefore = host?.focusAddress ?? false;
  const first = host === null;
  host = message;
  hostOrigin = event.origin;
  if (mode !== "hosted") {
    mode = "hosted";
    clearTimeout(standaloneTimer);
    decide();
  }
  applyTheme(message.theme);
  locale = message.lang;
  copy = newTabCopy(locale);
  drawAll();
  // The address bar takes the focus only with `focusAddress`, once it is
  // asked for.
  if (message.focusAddress && (first || !focusBefore)) focusAddress();
});

/** "Ready" to the window around the page, on an origin that may host it
 * (`newTabReadyTargets`): nothing goes to another origin. */
function announce() {
  if (!framed) return;
  const ancestor = location.ancestorOrigins?.item(0) ?? null;
  for (const origin of newTabReadyTargets(hostOrigins, ancestor))
    try {
      window.parent.postMessage({ type: newTabMessage.ready }, origin);
    } catch {}
}

async function readShell(): Promise<void> {
  if (shell !== null) return;
  try {
    const response = await fetch("/.lazurio/shell.json", {
      credentials: "same-origin",
      cache: "no-store",
    });
    const read = response.ok ? parseShell(await response.json()) : null;
    if (read === null) return;
    shell = read;
    hostOrigins = newTabHostOrigins(read, location.origin);
    if (boot === null && host === null) setLocale(read.locale);
  } catch {}
}

async function readViewOrigin(): Promise<void> {
  if (viewOrigin !== null) return;
  try {
    const response = await fetch(browserViewDocumentPath, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    viewOrigin = response.ok
      ? viewOriginOf(await response.json(), location.origin)
      : null;
    drawOverview(true);
  } catch {}
}

drawAll();
if (mode === "standalone") focusAddress();
void readShell().then(announce);
void readViewOrigin();
void poll();
