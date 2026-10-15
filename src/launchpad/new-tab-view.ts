import {
  browserTimes,
  browserViewUrl,
  isStrip,
  launchpadStrip,
  type StripApp,
  stripAppOf,
  targetIdOf,
  viewAddressOf,
} from "../browser/contract/pure";
import type { Catalog } from "../organizations/catalog";
import {
  catalogGroups,
  catalogOrganizationKey,
} from "../organizations/catalog-selection";
import { moduleName, moduleStone, tileTarget } from "./apps-view";
import type { PublicEntry } from "./chat";

// Nová karta's page without a DOM (decision F47 points 1-3 and 6-9, the
// approved wireframe `HumanAndMachine-ai/prototypes-lazurio` #27: NewTab.tsx
// and browser.ts): everything the page `/new-tab` (new-tab-page.ts) and the
// Launchpad's panel decide without a document. The overview's answer read
// field by field, the memory and its tone,
// "when last used", who opened a tab, the order of the tabs, the running
// Modules with their names from the boot catalog, the suggestions, the
// warning before closing a tab an agent works in, the toast
// with Vrátit, and the rule by which a local action outlives an older
// overview. Its words are the page's own (`newTabCopy`), Czech as the
// wireframe's and English. Left out because F47 does not decide them: Uspat,
// people's names, recent sites and the desktop line.

const en = {
  pageTitle: "New tab",
  address: "Search or enter an address",
  tools: "Tools",
  overview: "Overview",
  memoryTitle: "Environment memory",
  memoryOf: "of",
  memoryTabs: "Tabs {value}",
  memoryModules: "Modules {value}",
  memoryOther: "Other {value}",
  memoryOtherTitle:
    "Launchpad, T3 Code, the Environment's gateway, agents and the system",
  memoryHint:
    "Memory is almost full. Close heavy tabs and stop Modules you do not need.",
  tabsTitle: "Environment tabs",
  tabsEmpty:
    "No tab is open in the Environment browser. Enter an address above.",
  hubUnreachable:
    "The Environment browser is not answering right now. Trying again…",
  noBrowser: "This Environment has no browser.",
  overviewLoading: "Reading the overview…",
  overviewFailed: "The overview could not be read right now. Trying again…",
  launchpadUnreachable:
    "The Launchpad is not answering right now. Trying again…",
  browserDown:
    "The Environment browser is not answering right now; try again in a moment.",
  launchpadDown:
    "The Launchpad is not answering right now; try again in a moment.",
  whoTitle: "Who opened the tab",
  whoT3Thread: "Agent · T3 Code · {thread}",
  whoT3: "Agent · T3 Code",
  whoCodex: "Agent · Codex",
  whoClaude: "Agent · Claude Code",
  whoPerson: "User",
  whoPage: "Opened by a page",
  statusWorking: "an agent is working here",
  statusNow: "in use now",
  statusAgo: "last used {ago}",
  agoNow: "now",
  agoMinutes: "{n} min ago",
  agoHours: "{n} h ago",
  agoYesterday: "yesterday",
  agoDays: "{n} days ago",
  inThisThread: "in this thread",
  heapTitle: "An estimate: the page's JavaScript heap",
  openTab: "Open the tab",
  openInThread: "Open in this thread; it stays shared",
  close: "Close",
  closeTab: "Close the tab {title}",
  closeTitle: "Closes the tab for everyone",
  closeAgentTitle:
    "An agent is working in it: it closes for everyone after a warning",
  modulesTitle: "Running Modules",
  modulesEmpty: "No Module is running.",
  modulesUnknown: "Which Modules are running could not be read right now.",
  moduleDev: "Development server",
  stop: "Stop",
  stopModule: "Stop {name}",
  stopTitle: "Frees memory; opening it from Apps starts the Module again",
  stopping: "Stopping…",
  stopped: "{name} stopped and freed {memory}.",
  stoppedPlain: "{name} stopped.",
  stopFailed: "{name} could not be stopped.",
  suggested: "Suggested",
  appsCaption: "The Environment's apps",
  foreign: "This tab belongs to another Environment",
  foreignOpen: "Open it there",
  dismiss: "Dismiss",
  openFailed: "The tab could not be opened.",
  addressRefused:
    "This address is on the view of an Environment browser but links to no tab, so it does not open here.",
  addressRefusedScheme:
    "The Environment browser opens only http and https addresses here.",
  warnTitle: "Close a tab an agent is working in?",
  warnText:
    "An agent{where} is working in the tab “{title}”. If you close it, the agent loses the page it is working on and has to open it again.",
  warnThread: " of the thread “{thread}” ({app})",
  warnApp: " ({app})",
  warnKeep: "Keep it open",
  warnClose: "Close anyway",
  closing: "The tab closes in the Environment.",
  closingAgent: "The tab closes in the Environment and for the agent.",
  undo: "Undo",
  closeFailed: "The tab could not be closed.",
  restoreFailed: "The tab can no longer be brought back.",
  holdFailed: "The tab could not be kept in the Launchpad.",
  holdFull:
    "The Launchpad already keeps as many tabs as it can. Close some and try again.",
  holdGone: "The tab is no longer in the Environment.",
  retry: "Try again",
  closeInLaunchpad: "Close in the Launchpad",
  releasedAgent:
    "The tab left the Launchpad. An agent is working in it, so it stays open.",
  releasedElsewhere: "The tab left the Launchpad. It stays {places}.",
  placeThread: "in the thread “{thread}”",
  placeOtherThread: "in another thread",
  placeElsewhere: "elsewhere",
  placesAnd: " and ",
  releaseFailed: "The tab could not be taken out of the Launchpad.",
  closingTabs: "The tabs close in the Environment.",
  releasedTabsStay:
    "The tabs left the Launchpad. They stay open elsewhere or with an agent.",
  releasedTabsSome:
    "The tabs left the Launchpad. Some stay open elsewhere or with an agent; the others close in the Environment.",
  releaseTabsFailed: "The tabs could not be taken out of the Launchpad.",
  holdTabsFailed: "The tabs could not be kept in the Launchpad.",
  restoreTabsFailed: "The tabs can no longer be brought back.",
  stripLabel: "Tabs of the Environment browser",
  newTabTitle: "New tab: address, overview and suggestions",
  closeNewTab: "Close the new tab",
  tabWorking: "{title} · an agent is working here",
  tabLoading: "Loading…",
};
type Words = { readonly [K in keyof typeof en]: string };
const cs: Words = {
  pageTitle: "Nová karta",
  address: "Hledejte nebo zadejte adresu",
  tools: "Nástroje",
  overview: "Přehled",
  memoryTitle: "Paměť Prostředí",
  memoryOf: "z",
  memoryTabs: "Záložky {value}",
  memoryModules: "Moduly {value}",
  memoryOther: "Ostatní {value}",
  memoryOtherTitle: "Lazurio, T3 Code, brána Prostředí, agenti a systém",
  memoryHint:
    "Paměť je skoro plná. Zavřete těžké záložky a zastavte Moduly, které nepotřebujete.",
  tabsTitle: "Záložky Prostředí",
  tabsEmpty:
    "V prohlížeči Prostředí není otevřená žádná záložka. Zadejte adresu nahoře.",
  hubUnreachable: "Prohlížeč Prostředí teď neodpovídá. Zkouším to znovu…",
  noBrowser: "Toto Prostředí nemá prohlížeč.",
  overviewLoading: "Načítám přehled…",
  overviewFailed: "Přehled se teď nepodařilo načíst. Zkouším to znovu…",
  launchpadUnreachable: "Lazurio teď neodpovídá. Zkouším to znovu…",
  browserDown: "Prohlížeč Prostředí teď neodpovídá, zkuste to za chvíli znovu.",
  launchpadDown: "Lazurio teď neodpovídá, zkuste to za chvíli znovu.",
  whoTitle: "Kdo záložku otevřel",
  whoT3Thread: "Agent · T3 Code · {thread}",
  whoT3: "Agent · T3 Code",
  whoCodex: "Agent · Codex",
  whoClaude: "Agent · Claude Code",
  whoPerson: "Uživatel",
  whoPage: "Otevřela ji stránka",
  statusWorking: "agent tu pracuje",
  statusNow: "používaná teď",
  statusAgo: "naposledy {ago}",
  agoNow: "teď",
  agoMinutes: "před {n} min",
  agoHours: "před {n} h",
  agoYesterday: "včera",
  agoDays: "před {n} dny",
  inThisThread: "v tomto vlákně",
  heapTitle: "Odhad: JavaScriptová halda stránky",
  openTab: "Otevřít záložku",
  openInThread: "Otevřít v tomto vlákně; zůstane sdílená",
  close: "Zavřít",
  closeTab: "Zavřít záložku {title}",
  closeTitle: "Zavře záložku pro všechny",
  closeAgentTitle: "Pracuje v ní agent: zavře se pro všechny až po varování",
  modulesTitle: "Spuštěné Moduly",
  modulesEmpty: "Žádný Modul neběží.",
  modulesUnknown: "Které Moduly běží, se teď nepodařilo zjistit.",
  moduleDev: "Vývojový server",
  stop: "Zastavit",
  stopModule: "Zastavit {name}",
  stopTitle: "Uvolní paměť; otevřením z Apps se Modul spustí znovu",
  stopping: "Zastavuji…",
  stopped: "Modul {name} se zastavil a uvolnil {memory}.",
  stoppedPlain: "Modul {name} se zastavil.",
  stopFailed: "Modul {name} se nepodařilo zastavit.",
  suggested: "Navrhované",
  appsCaption: "Aplikace Prostředí",
  foreign: "Tato záložka patří jinému Prostředí",
  foreignOpen: "Otevřít v něm",
  dismiss: "Zavřít",
  openFailed: "Záložku se nepodařilo otevřít.",
  addressRefused:
    "Tato adresa patří pohledu prohlížeče Prostředí, ale neodkazuje na žádnou záložku, takže se tu neotevře.",
  addressRefusedScheme:
    "Prohlížeč Prostředí tu otevírá jen adresy http a https.",
  warnTitle: "Zavřít záložku, ve které pracuje agent?",
  warnText:
    "V záložce „{title}“ právě pracuje agent{where}. Po zavření přijde o rozdělanou stránku a bude ji muset otevřít znovu.",
  warnThread: " z vlákna „{thread}“ ({app})",
  warnApp: " ({app})",
  warnKeep: "Nechat otevřenou",
  warnClose: "Zavřít i tak",
  closing: "Záložka se zavře v Prostředí.",
  closingAgent: "Záložka se zavře v Prostředí i agentovi.",
  undo: "Vrátit",
  closeFailed: "Záložku se nepodařilo zavřít.",
  restoreFailed: "Záložku už nejde vrátit.",
  holdFailed: "Záložku se nepodařilo v Apps ponechat.",
  holdFull:
    "Apps už mají tolik záložek, kolik unesou. Zavřete některé a zkuste to znovu.",
  holdGone: "Záložka už v Prostředí není.",
  retry: "Zkusit znovu",
  closeInLaunchpad: "Zavřít v Apps",
  releasedAgent:
    "Záložka zmizela z Apps. Pracuje v ní agent, takže zůstává otevřená.",
  releasedElsewhere: "Záložka zmizela z Apps. Dál je {places}.",
  placeThread: "ve vlákně „{thread}“",
  placeOtherThread: "v jiném vlákně",
  placeElsewhere: "jinde",
  placesAnd: " a ",
  releaseFailed: "Záložku se nepodařilo z Apps odebrat.",
  closingTabs: "Záložky se zavřou v Prostředí.",
  releasedTabsStay:
    "Záložky zmizely z Apps. Zůstávají otevřené jinde nebo u agenta.",
  releasedTabsSome:
    "Záložky zmizely z Apps. Některé zůstávají otevřené jinde nebo u agenta, ostatní se zavřou v Prostředí.",
  releaseTabsFailed: "Záložky se nepodařilo z Apps odebrat.",
  holdTabsFailed: "Záložky se nepodařilo v Apps ponechat.",
  restoreTabsFailed: "Záložky už nejde vrátit.",
  stripLabel: "Záložky prohlížeče Prostředí",
  newTabTitle: "Nová karta: adresa, Přehled a Navrhované",
  closeNewTab: "Zavřít Novou kartu",
  tabWorking: "{title} · pracuje tu agent",
  tabLoading: "Načítá se…",
};

export type NewTabCopy = Words;

/** Nová karta's words in the page's language. */
export function newTabCopy(locale: unknown): NewTabCopy {
  return locale === "cs" ? cs : en;
}

/** A sentence with its `{name}` slots filled. */
export function fill(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{([a-z]+)\}/g, (slot, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? slot) : slot,
  );
}

// How often Přehled is read while the page is visible (F47 point 3), the
// hub's grace that bounds the Vrátit of a close for everyone (F47 points 5
// and 6, the wireframe's `GRACE_MS`) and when a framed page that has not
// heard its host is standalone are the contract's (`browserTimes`, F50).
/** How long a short message stays. */
export const noteMs = 4_000;
/** How long a message with an action (Zkusit znovu) stays: long enough to
 * take it. */
export const actionNoteMs = 10_000;

/** The strip a page opened from the Nová karta page is for: its host's
 * while an app hosts it. Standalone, as in Codex Desktop's browser, it is
 * none: nobody holds the page, and it ends 30 s after its last viewer leaves
 * (root decision 0191 point 29, which ends point 27's hold by the
 * Launchpad). */
export function pageStrip(
  mode: "waiting" | "hosted" | "standalone",
  hostStrip: string | null,
): string | null {
  return mode === "hosted" ? hostStrip : null;
}

// ---- The overview's answer ----------------------------------------------------

/** Who opened a tab, as the overview names them (new-tab-routes.ts). */
export type OpenerName =
  | Readonly<{ app: "t3code"; thread: string | null }>
  | Readonly<{ app: "codex" | "claude" }>
  | Readonly<{ person: true }>
  | Readonly<{ page: string }>
  | Readonly<Record<string, never>>;

/** One remote tab of the overview, as the page uses it. */
export type NewTabTab = Readonly<{
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  /** When it was last used (viewed, acted in, navigated), in milliseconds
   * of the Environment's clock; null when not given. */
  usedAt: number | null;
  /** The sessions whose agent works in it now. */
  agents: readonly string[];
  holders: readonly Readonly<{ strip: string; label: string }>[];
  /** A close for everyone counts down (F47 point 6). */
  closing: boolean;
  /** Its JavaScript heap in bytes, the estimate marked "≈" (F47 point 7);
   * null where it is not known. */
  heap: number | null;
  who: OpenerName;
}>;

export type NewTabMemory = Readonly<{
  total: number | null;
  used: number | null;
  browser: number | null;
  core: Readonly<{ launchpad: number | null; t3code: number | null }>;
  modules: number | null;
  rest: number | null;
}>;

export type NewTabModule = Readonly<{
  org: string;
  module: string;
  app: string;
  unit: string;
  memory: number | null;
  mode: string;
  source: string;
}>;

export type NewTabOverview = Readonly<{
  hub: "connected" | "unreachable";
  /** Null while the hub does not answer. */
  tabs: readonly NewTabTab[] | null;
  memory: NewTabMemory;
  /** Null when which Modules run is not known. */
  modules: readonly NewTabModule[] | null;
}>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const bytes = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;
const time = (value: unknown): number | null => {
  if (typeof value !== "string" || value.length > 40) return null;
  const read = Date.parse(value);
  return Number.isFinite(read) ? read : null;
};

function openerName(value: unknown): OpenerName {
  if (!isRecord(value)) return {};
  if (value.app === "t3code")
    return {
      app: "t3code",
      thread:
        typeof value.thread === "string" && value.thread.trim() !== ""
          ? value.thread.slice(0, 200)
          : null,
    };
  if (value.app === "codex" || value.app === "claude")
    return { app: value.app };
  if (value.person === true) return { person: true };
  const page = targetIdOf(value.page);
  return page === null ? {} : { page };
}

function parseTab(value: unknown): NewTabTab | null {
  if (!isRecord(value)) return null;
  const id = targetIdOf(value.id);
  if (id === null) return null;
  const url = text(value.url, 2_048);
  const title = text(value.title, 500);
  if (url === null || title === null) return null;
  const favicon =
    typeof value.favicon === "string" &&
    value.favicon.startsWith("https://") &&
    value.favicon.length <= 2_048
      ? value.favicon
      : null;
  const heap = isRecord(value.heap) ? bytes(value.heap.used) : null;
  return {
    id,
    url,
    title,
    favicon,
    usedAt: time(value.usedAt),
    agents: Array.isArray(value.agents) ? value.agents.filter(isStrip) : [],
    holders: Array.isArray(value.holders)
      ? value.holders.flatMap((hold: unknown) =>
          isRecord(hold) && isStrip(hold.strip)
            ? [
                {
                  strip: hold.strip,
                  label: typeof hold.label === "string" ? hold.label : "",
                },
              ]
            : [],
        )
      : [],
    closing: typeof value.closing === "string",
    heap,
    who: openerName(value.who),
  };
}

function parseModule(value: unknown): NewTabModule | null {
  if (!isRecord(value)) return null;
  const { org, module, app, unit, mode, source } = value;
  if (
    typeof org !== "string" ||
    typeof module !== "string" ||
    typeof app !== "string" ||
    typeof unit !== "string" ||
    typeof mode !== "string" ||
    typeof source !== "string"
  )
    return null;
  return {
    org,
    module,
    app,
    unit,
    memory: bytes(value.memory),
    mode,
    source,
  };
}

/** `GET /api/new-tab/overview`'s answer, read field by field; null when it
 * is not one. A tab or a Module of another shape is left out, a memory value
 * that is no byte count is unknown. */
export function parseOverview(value: unknown): NewTabOverview | null {
  if (!isRecord(value)) return null;
  if (value.hub !== "connected" && value.hub !== "unreachable") return null;
  const memory = isRecord(value.memory) ? value.memory : {};
  const core = isRecord(memory.core) ? memory.core : {};
  return {
    hub: value.hub,
    tabs: Array.isArray(value.tabs)
      ? value.tabs.flatMap((tab: unknown) => {
          const read = parseTab(tab);
          return read === null ? [] : [read];
        })
      : null,
    memory: {
      total: bytes(memory.total),
      used: bytes(memory.used),
      browser: bytes(memory.browser),
      core: {
        launchpad: bytes(core.launchpad),
        t3code: bytes(core.t3code),
      },
      modules: bytes(memory.modules),
      rest: bytes(memory.rest),
    },
    modules: Array.isArray(value.modules)
      ? value.modules.flatMap((module: unknown) => {
          const read = parseModule(module);
          return read === null ? [] : [read];
        })
      : null,
  };
}

/** One answer of the Launchpad to Nová karta: its status, 0 when no answer
 * came, and its JSON body, null when it has none. */
export type NewTabAnswer = Readonly<{ status: number; value: unknown }>;

/** The Environment says it has no browser (`404 {error: "no-browser"}`):
 * a workstation, or an entry that routes no view. */
export function isNoBrowser(answer: NewTabAnswer): boolean {
  return (
    answer.status === 404 &&
    isRecord(answer.value) &&
    answer.value.error === "no-browser"
  );
}

/** Why Přehled could not be read (F47's failure modes): the Launchpad did
 * not answer, no answer at all or the gateway's 502-504 while it restarts,
 * which Nová karta says as such; or it answered something else. */
export function overviewFailure(status: number): "unreachable" | "failed" {
  return status === 0 || (status >= 502 && status <= 504)
    ? "unreachable"
    : "failed";
}

/** What Nová karta says when an action did not happen: the cause where the
 * answer names it (no browser, the browser's hub not answering, F47 point 6,
 * or the Launchpad not answering, which also says so while it closes), else
 * `fallback`, also for any other reason the Launchpad gave. */
export function actionFailure(
  answer: NewTabAnswer,
  fallback: string,
  copy: NewTabCopy,
): string {
  if (isNoBrowser(answer)) return copy.noBrowser;
  const error = isRecord(answer.value) ? answer.value.error : undefined;
  if (answer.status === 503 && error === "hub-unreachable")
    return copy.browserDown;
  if (typeof error === "string" && error !== "closing") return fallback;
  return overviewFailure(answer.status) === "unreachable"
    ? copy.launchpadDown
    : fallback;
}

// ---- Memory (F47 point 7, the wireframe's `formatMemory` and `memoryTone`) ---

/** Bytes as people read them, after the wireframe: "180 MB", "1,4 GB",
 * "8 GB" (binary units, written as the Dashboard writes them). */
export function formatMemory(value: number, locale: "cs" | "en"): string {
  const mib = value / (1024 * 1024);
  if (mib < 1000) return `${value > 0 ? Math.max(1, Math.round(mib)) : 0} MB`;
  const gb = String(Math.round((mib / 1024) * 10) / 10);
  return `${locale === "cs" ? gb.replace(".", ",") : gb} GB`;
}

/** The Dashboard's thresholds: 80 % warns, 90 % is bad. */
export function memoryTone(percent: number): "ok" | "warn" | "bad" {
  return percent >= 90 ? "bad" : percent >= 80 ? "warn" : "ok";
}

/** A tab or a Module of half a gigabyte or more stands out. */
export const heavyBytes = 500 * 1024 * 1024;

export type MemoryModel = Readonly<{
  /** What is in use and the total, each formatted; null unless both are
   * known. */
  value: Readonly<{ used: string; total: string }> | null;
  /** The bar's width, never past 100; null unless both are known. */
  percent: number | null;
  tone: "ok" | "warn" | "bad";
  /** Only the parts that are known: never an unknown one as 0. */
  parts: readonly Readonly<{ text: string; title: string | null }>[];
  hint: string | null;
}>;

/** The memory block of Přehled; null when nothing of it is known. Ostatní
 * is everything but the tabs and the Modules, the protected core (the
 * Launchpad and T3 Code) included, as the wireframe's title says. */
export function memoryModel(
  memory: NewTabMemory,
  copy: NewTabCopy,
  locale: "cs" | "en",
): MemoryModel | null {
  const { total, used } = memory;
  const percent =
    total !== null && used !== null && total > 0
      ? Math.round((used / total) * 100)
      : null;
  const other =
    memory.rest === null ||
    memory.core.launchpad === null ||
    memory.core.t3code === null
      ? null
      : memory.rest + memory.core.launchpad + memory.core.t3code;
  const parts: { text: string; title: string | null }[] = [];
  const part = (
    template: string,
    value: number | null,
    title: string | null = null,
  ) => {
    if (value !== null)
      parts.push({
        text: fill(template, { value: formatMemory(value, locale) }),
        title,
      });
  };
  part(copy.memoryTabs, memory.browser);
  part(copy.memoryModules, memory.modules);
  part(copy.memoryOther, other, copy.memoryOtherTitle);
  if (percent === null && parts.length === 0) return null;
  const tone = percent === null ? "ok" : memoryTone(percent);
  return {
    value:
      percent === null || total === null || used === null
        ? null
        : {
            used: formatMemory(used, locale),
            total: formatMemory(total, locale),
          },
    percent: percent === null ? null : Math.min(percent, 100),
    tone,
    parts,
    hint: tone === "ok" ? null : copy.memoryHint,
  };
}

// ---- The tabs of Přehled -------------------------------------------------------

/** When a tab was last used, after the wireframe's `ago`: "teď", "před 3
 * min", "před 2 h", "včera", "před 2 dny". */
export function ago(elapsedMs: number, copy: NewTabCopy): string {
  const minutes = Math.max(0, elapsedMs) / 60_000;
  if (minutes < 1) return copy.agoNow;
  if (minutes < 60)
    return fill(copy.agoMinutes, { n: String(Math.floor(minutes)) });
  if (minutes < 24 * 60)
    return fill(copy.agoHours, { n: String(Math.floor(minutes / 60)) });
  if (minutes < 48 * 60) return copy.agoYesterday;
  return fill(copy.agoDays, { n: String(Math.floor(minutes / (24 * 60))) });
}

/** The status line of a tab: an agent at work, else when it was used; null
 * when neither is known, since a time nobody gave is never "in use now". */
export function tabStatus(
  tab: Pick<NewTabTab, "agents" | "usedAt">,
  now: number,
  copy: NewTabCopy,
): Readonly<{ text: string; working: boolean }> | null {
  if (tab.agents.length > 0) return { text: copy.statusWorking, working: true };
  if (tab.usedAt === null) return null;
  const elapsed = now - tab.usedAt;
  return elapsed < 60_000
    ? { text: copy.statusNow, working: false }
    : {
        text: fill(copy.statusAgo, { ago: ago(elapsed, copy) }),
        working: false,
      };
}

/** Who opened a tab, as Přehled says it: a user, never by name (F11), or
 * an agent by its app (Matěj 2026-10-12: uživatel and agent, and bot once
 * Lazurio MausBot is an app of Nová karta); null when nobody knows. */
export function openerLabel(
  who: OpenerName,
  copy: NewTabCopy,
): Readonly<{ text: string; icon: "bot" | "user" | "page" }> | null {
  if ("app" in who) {
    if (who.app === "t3code")
      return {
        text:
          who.thread === null
            ? copy.whoT3
            : fill(copy.whoT3Thread, { thread: who.thread }),
        icon: "bot",
      };
    return {
      text: who.app === "codex" ? copy.whoCodex : copy.whoClaude,
      icon: "bot",
    };
  }
  if ("person" in who) return { text: copy.whoPerson, icon: "user" };
  if ("page" in who) return { text: copy.whoPage, icon: "page" };
  return null;
}

/** "v tomto vlákně": the host's strip holds the tab, and that strip is a
 * thread's, never the Launchpad's, which holds every tab it opened. */
export function inThisStrip(
  tab: Pick<NewTabTab, "holders">,
  strip: string | null,
): boolean {
  return (
    strip !== null &&
    strip !== launchpadStrip &&
    tab.holders.some((hold) => hold.strip === strip)
  );
}

/** Přehled's order: the heaviest first, a tab whose memory is unknown
 * after every known one, then the most recently used. */
export function sortTabs<T extends Pick<NewTabTab, "id" | "heap" | "usedAt">>(
  tabs: readonly T[],
): T[] {
  return [...tabs].sort(
    (a, b) =>
      (b.heap ?? -1) - (a.heap ?? -1) ||
      (b.usedAt ?? 0) - (a.usedAt ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// ---- Local actions over an older overview -------------------------------------

/** A tab that the person closed, saw end, opened or brought back here,
 * which an overview requested before that does not know yet. `after` is the
 * number of overviews requested when the hub had done it: the answer to a
 * later request is the hub's own word and replaces it. Null while the
 * request is still on its way: no overview can know it yet, so none lifts
 * it. */
export type TabOverride = Readonly<{
  id: string;
  state: "hidden" | "shown";
  after: number | null;
}>;

/** The overrides an overview answering request `request` (the n-th one
 * begun) leaves: those still on their way, and those the hub had done once
 * that request had begun. */
export function settleOverrides(
  overrides: readonly TabOverride[],
  request: number,
): readonly TabOverride[] {
  return overrides.filter(
    (override) => override.after === null || override.after >= request,
  );
}

/** `overrides` with the one of `id` replaced. */
export function withOverride(
  overrides: readonly TabOverride[],
  id: string,
  state: TabOverride["state"],
  after: number | null,
): readonly TabOverride[] {
  return [
    ...overrides.filter((override) => override.id !== id),
    { id, state, after },
  ];
}

/** `overrides` without the one of `id`. */
export function withoutOverride(
  overrides: readonly TabOverride[],
  id: string,
): readonly TabOverride[] {
  return overrides.filter((override) => override.id !== id);
}

/** A tab was taken away here: Zavřít in Přehled closes it for everyone (F47
 * point 6), × in the Launchpad's strip lets go of the Launchpad's hold (its
 * addendum of 2026-10-12). It goes at once and stays gone, whatever an
 * overview says, while the request is on its way: an overview read before
 * the request was done still lists the tab as it was. */
export function hideAsked(
  overrides: readonly TabOverride[],
  id: string,
): readonly TabOverride[] {
  return withOverride(overrides, id, "hidden", null);
}

/** The request's answer came. Done, the tab stays gone until an overview
 * requested after now (`requests` begun so far) gives its word: a closed tab
 * as closing or not at all, a released one without the Launchpad's hold.
 * Failed, it comes back. */
export function hideAnswered(
  overrides: readonly TabOverride[],
  id: string,
  accepted: boolean,
  requests: number,
): readonly TabOverride[] {
  return accepted
    ? withOverride(overrides, id, "hidden", requests)
    : withoutOverride(overrides, id);
}

/** What a close for everyone's answer means here. Accepted (202), with the
 * moment Vrátit stops being offered (`undoDeadline`), null when that has
 * passed or the answer does not say; a tab the hub no longer lists (404) is
 * gone as surely, without Vrátit. Anything else failed, and the tab comes
 * back. */
export type CloseOutcome =
  | Readonly<{ kind: "accepted"; undoUntil: number | null }>
  | Readonly<{ kind: "failed" }>;

export function closeOutcome(
  answer: NewTabAnswer,
  sentAt: number,
  now: number,
): CloseOutcome {
  if (answer.status === 404 && !isNoBrowser(answer))
    return { kind: "accepted", undoUntil: null };
  if (answer.status !== 202) return { kind: "failed" };
  const until = undoDeadline(answer.value, sentAt);
  return {
    kind: "accepted",
    undoUntil: until !== null && until > now ? until : null,
  };
}

/** When Vrátit stops being offered, on this browser's clock. The hub ends
 * the tab at its deadline (F47 point 6), which is on the Environment's
 * clock, so the close's answer also says how long the grace has left
 * (`left`, in milliseconds, as the Launchpad measured it when it answered).
 * Counted from when the request was sent, the earliest the Launchpad can
 * have measured it, Vrátit never outlives the deadline, however the clocks
 * differ or late the answer comes. Never longer than the grace; null
 * without a `left`. */
export function undoDeadline(value: unknown, sentAt: number): number | null {
  if (!isRecord(value)) return null;
  const left = value.left;
  return typeof left === "number" && Number.isFinite(left) && left >= 0
    ? sentAt + Math.min(left, browserTimes.releaseGraceMs)
    : null;
}

/** The tabs to show: none hidden here, and none whose close for everyone
 * counts down unless it was brought back here. */
export function visibleTabs<T extends Pick<NewTabTab, "id" | "closing">>(
  tabs: readonly T[],
  overrides: readonly TabOverride[],
): T[] {
  const hidden = new Set(
    overrides.filter((o) => o.state === "hidden").map((o) => o.id),
  );
  const shown = new Set(
    overrides.filter((o) => o.state === "shown").map((o) => o.id),
  );
  return tabs.filter(
    (tab) => !hidden.has(tab.id) && (!tab.closing || shown.has(tab.id)),
  );
}

export type TabRow = Readonly<{
  id: string;
  /** Its title, else its address. */
  title: string;
  url: string;
  favicon: string | null;
  who: ReturnType<typeof openerLabel>;
  status: ReturnType<typeof tabStatus>;
  here: boolean;
  /** "≈ 182 MB", or null where the heap is not known. */
  memory: string | null;
  heavy: boolean;
  /** Its view, from the view's origin; null while that is not known. */
  view: string | null;
  /** The row's own title: open it, in a thread "stays shared". */
  openTitle: string;
  closeTitle: string;
}>;

/** Přehled's rows of tabs: visible, in Přehled's order. The hub's blank
 * window is in no list it writes (F47 point 5), so it never shows. */
export function tabRows(
  tabs: readonly NewTabTab[],
  context: Readonly<{
    now: number;
    strip: string | null;
    viewOrigin: string | null;
    overrides: readonly TabOverride[];
    copy: NewTabCopy;
    locale: "cs" | "en";
  }>,
): readonly TabRow[] {
  const { copy } = context;
  return sortTabs(visibleTabs(tabs, context.overrides)).map((tab) => {
    const here = inThisStrip(tab, context.strip);
    const thread = context.strip !== null && context.strip !== launchpadStrip;
    return {
      id: tab.id,
      title: tab.title.trim() === "" ? tab.url : tab.title,
      url: tab.url,
      favicon: tab.favicon,
      who: openerLabel(tab.who, copy),
      status: tabStatus(tab, context.now, copy),
      here,
      memory:
        tab.heap === null
          ? null
          : `≈ ${formatMemory(tab.heap, context.locale)}`,
      heavy: tab.heap !== null && tab.heap >= heavyBytes,
      view:
        context.viewOrigin === null
          ? null
          : browserViewUrl(context.viewOrigin, tab.id),
      openTitle: thread && !here ? copy.openInThread : copy.openTab,
      closeTitle:
        tab.agents.length > 0 ? copy.closeAgentTitle : copy.closeTitle,
    };
  });
}

// ---- Closing for everyone (F47 point 6, the wireframe's CloseWarning) ------

/** The apps whose agents work in a tab, by the registry of prefixes
 * (decision F50 point 2), and their names. */
const agentApps: Readonly<Partial<Record<StripApp, string>>> = {
  t3code: "T3 Code",
  codex: "Codex",
  claude: "Claude Code",
};

/** The warning before closing a tab an agent works in (0195 point 5):
 * which agent, by its app and a T3 Code thread's title where its holder
 * file names it. Keeping the tab is the default answer. */
export function closeWarning(
  tab: Pick<NewTabTab, "title" | "url" | "agents" | "holders">,
  copy: NewTabCopy,
): Readonly<{ title: string; text: string; keep: string; close: string }> {
  const session = tab.agents[0] ?? "";
  const owner = stripAppOf(session);
  const app = owner === null ? undefined : agentApps[owner];
  const thread = tab.holders.find((hold) => hold.strip === session)?.label;
  const where =
    app === undefined
      ? ""
      : app === "T3 Code" && thread !== undefined && thread !== ""
        ? fill(copy.warnThread, { thread, app })
        : fill(copy.warnApp, { app });
  return {
    title: copy.warnTitle,
    text: fill(copy.warnText, {
      title: tab.title.trim() === "" ? tab.url : tab.title,
      where,
    }),
    keep: copy.warnKeep,
    close: copy.warnClose,
  };
}

/** What Vrátit undoes while it is offered: a close for everyone here, or one
 * command of the Launchpad's strip, its × or a close of a tab's menu, with
 * every tab that command let go of (F47 point 9's addendum of 2026-10-13).
 * `text` is the toast's line, what happens to them; `shown` the one of them
 * shown where they were taken away, shown there again, or null; `ends`
 * whether one of them ends, closes in the Environment (`replacesUndo`). */
export type PendingUndo = Readonly<{
  tabs: readonly string[];
  text: string;
  shown: string | null;
  ends: boolean;
}>;

/** Whether the Vrátit of `next` takes the place of the one `offered` now.
 * One Vrátit is offered at a time, the last command's, unless that command
 * ends no tab while the Vrátit offered brings back one that ends: that one
 * stays, so its tab is not lost, and the command says its line above it as
 * a message (the review of #27, the wireframe's `keptText`). */
export function replacesUndo(
  offered: PendingUndo | null,
  next: PendingUndo,
): boolean {
  return offered === null || next.ends || !offered.ends;
}

/** The toast (the wireframe's PendingClose): what happens to the tabs and
 * Vrátit while its grace lasts, with a later message above it, which never
 * takes Vrátit away (Pablo's review of #27); a message alone otherwise. */
export function toastModel(
  pending: PendingUndo | null,
  note: string | null,
  copy: NewTabCopy,
): Readonly<{
  note: string | null;
  text: string | null;
  undo: string | null;
}> | null {
  if (pending !== null) return { note, text: pending.text, undo: copy.undo };
  return note === null ? null : { note, text: null, undo: null };
}

// ---- Running Modules and the suggestions ------------------------------------

export type ModuleLook = Readonly<{ name: string; stone: string | null }>;

/** A running Module's name and stone from the boot catalog, by the
 * Organization key the stop route takes and the module id; null when the
 * catalog does not know it. */
export function catalogModuleLook(
  catalog: Catalog | null,
): (org: string, module: string) => ModuleLook | null {
  return (org, module) => {
    if (catalog === null) return null;
    for (const group of catalogGroups(catalog)) {
      if (catalogOrganizationKey(catalog, group) !== org) continue;
      const found = group.modules.find((item) => item.module === module);
      if (found !== undefined)
        return { name: moduleName(found), stone: moduleStone(found).src };
    }
    return null;
  };
}

export type ModuleRow = Readonly<{
  unit: string;
  name: string;
  stone: string | null;
  memory: string | null;
  heavy: boolean;
  /** "Vývojový server · main". */
  line: string;
  /** Zastavit: the Module's existing stop and its body. */
  stop: string;
  app: string;
}>;

/** Spuštěné Moduly, the heaviest first, each with its name from the boot
 * catalog, else its id. */
export function moduleRows(
  modules: readonly NewTabModule[],
  look: (org: string, module: string) => ModuleLook | null,
  copy: NewTabCopy,
  locale: "cs" | "en",
): readonly ModuleRow[] {
  return [...modules]
    .sort(
      (a, b) =>
        (b.memory ?? -1) - (a.memory ?? -1) ||
        (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0),
    )
    .map((module) => {
      const found = look(module.org, module.module);
      return {
        unit: module.unit,
        name: found?.name ?? module.module,
        stone: found?.stone ?? null,
        memory:
          module.memory === null ? null : formatMemory(module.memory, locale),
        heavy: module.memory !== null && module.memory >= heavyBytes,
        line: `${module.mode === "dev" ? copy.moduleDev : module.mode} · ${module.source}`,
        stop: `/api/modules/${encodeURIComponent(module.org)}/${encodeURIComponent(module.module)}/stop`,
        app: module.app,
      };
    });
}

export type Suggestion = Readonly<{
  key: string;
  name: string;
  stone: string;
  href: string;
}>;

/** Navrhované: the Environment's apps as the Launchpad's Apps opens them
 * (`tileTarget`): every module of the boot catalog with an app that opens on
 * its own origin, in the catalog's order. None on a workstation, whose apps
 * start through the lifecycle and have no address yet. */
export function suggestions(
  catalog: Catalog | null,
  entry: PublicEntry | null,
): readonly Suggestion[] {
  if (catalog === null || entry === null) return [];
  const found: Suggestion[] = [];
  for (const group of catalogGroups(catalog))
    for (const module of group.modules) {
      const target = tileTarget(catalog, group, module, entry);
      if (target.kind !== "hosted") continue;
      found.push({
        key: `${catalogOrganizationKey(catalog, group) ?? group.directory}/${module.module}`,
        name: moduleName(module),
        stone: moduleStone(module).src,
        href: target.href,
      });
    }
  return found;
}

// ---- Where things are -------------------------------------------------------------

/** The view's origin from `GET /.lazurio/browser.json`'s answer (its `view`
 * for a new tab): the origin of a view address of the contract
 * (`viewAddressOf`), never the page's own; null otherwise. */
export function viewOriginOf(
  answer: unknown,
  pageOrigin: string,
): string | null {
  if (!isRecord(answer) || answer.available !== true) return null;
  const address = viewAddressOf(answer.view);
  return address !== null && address.origin !== pageOrigin
    ? address.origin
    : null;
}

/** The letter key that chooses a tool (the wireframe's NewTab): a single
 * letter or digit without modifiers, while nobody types and no dialog is
 * open, matching a tool's key regardless of case; null otherwise. */
export function toolForKey(
  key: Readonly<{
    key: string;
    meta: boolean;
    ctrl: boolean;
    alt: boolean;
    composing: boolean;
    handled: boolean;
  }>,
  tools: readonly Readonly<{ id: string; key?: string }>[],
  context: Readonly<{ typing: boolean; dialog: boolean }>,
): string | null {
  if (
    key.handled ||
    key.composing ||
    key.meta ||
    key.ctrl ||
    key.alt ||
    context.typing ||
    context.dialog ||
    key.key.length !== 1
  )
    return null;
  const wanted = key.key.toLowerCase();
  return tools.find((tool) => tool.key?.toLowerCase() === wanted)?.id ?? null;
}
