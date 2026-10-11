import { readFile } from "node:fs/promises";
import { type BootTime, isStrip, readBootClock } from "../browser/people/holds";
import {
  navigableAddress,
  type TabFacts,
  type TabOpener,
} from "../browser/people/hub";
import type { BrowserEntry } from "../browser/units";
import { browserViewUrl } from "../browser/view";
import type { MachineEntry } from "../folder/machine-binding";
import { ownDataValue, stateFields } from "../folder/state-fields";
import {
  createServiceManagerProcess,
  type ServiceManagerProcess,
} from "../modules/service-manager-process";
import { BodyTooLarge, readJsonBody } from "./json-body";
import {
  HolderFull,
  type LaunchpadHolder,
  launchpadStrip,
  readHolderLabel,
} from "./new-tab/holder";
import {
  closeTab,
  type HubRefusal,
  listTabs,
  openTab,
  restoreTab,
} from "./new-tab/hub-client";
import {
  type EnvironmentMemory,
  readEnvironmentMemory,
} from "./new-tab/memory";
import type { ModuleUnit } from "./new-tab/modules";

// Nová karta's reads and writes on the Launchpad (decision F47 points 4 and
// 6-8), behind the admission of every `/api/*` route (the local token, or the
// gateway's session and same origin for a write):
//
//   GET  /api/new-tab/overview   {hub, tabs, memory, modules}
//   POST /api/new-tab/open       {url, strip?}   201 {tab, view}
//   POST /api/new-tab/hold       {tab}           200 {held: true}
//   POST /api/new-tab/close      {tab}           202 {closing}
//   POST /api/new-tab/restore    {tab}           200 {restored: true}
//
// Only where the entry routes the Environment browser's view (`entry.browser`);
// elsewhere, a workstation among them, every path answers 404 `no-browser`.
// The tabs, their opening, closing and Vrátit are the view's hub's (F47 point
// 6), which the Launchpad asks on loopback; the memory and the running Modules
// are the Launchpad's own reading; the holds of the Launchpad are its holder
// file. Zastavit is the Module's existing stop.

/** Where the overview and the actions read and write: this account's runtime
 * directory (the holder files and the hub's list of live tabs), its service
 * manager, `/proc` and the boot clock. Trusted composition, never HTTP input;
 * tests supply their own. */
export type NewTabHost = Readonly<{
  runtimeDirectory: string | undefined;
  /** Null off Linux or without the runtime directory. */
  run: ServiceManagerProcess | null;
  readFile: (path: string) => Promise<string>;
  bootClock: () => Promise<BootTime | null>;
  /** One line of the Launchpad's journal: what happened, never a value. */
  log: (event: string) => void;
}>;

export function processNewTabHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): NewTabHost {
  const runtimeDirectory = env.XDG_RUNTIME_DIR;
  return Object.freeze({
    runtimeDirectory,
    run:
      platform === "linux" && runtimeDirectory?.startsWith("/") === true
        ? createServiceManagerProcess(runtimeDirectory)
        : null,
    readFile: (path: string) => readFile(path, "utf8"),
    bootClock: () => readBootClock(),
    log: (event: string) =>
      console.log(JSON.stringify({ scope: "new-tab", event })),
  });
}

/** Who opened a tab, as Přehled names them: an agent by its app, from its
 * agent-browser session, with a T3 Code thread's title from its holder file;
 * a person never by name (F11, admission is not identity); a page by its
 * tab; nothing for an opener nobody knows, an agent's session of another
 * app included. */
export type TabOpenerName =
  | Readonly<{ app: "t3code"; thread: string | null }>
  | Readonly<{ app: "codex" | "claude" }>
  | Readonly<{ person: true }>
  | Readonly<{ page: string }>
  | Readonly<Record<string, never>>;

export type OverviewTab = TabFacts & Readonly<{ who: TabOpenerName }>;

export type OverviewModule = ModuleUnit &
  Readonly<{ memory: number | null; mode: "dev"; source: "main" }>;

export type NewTabOverview = Readonly<{
  /** The hub answered; while it does not, `tabs` is null and Nová karta
   * says so and asks again. */
  hub: "connected" | "unreachable";
  tabs: readonly OverviewTab[] | null;
  memory: EnvironmentMemory;
  /** Null when which Modules run is not known. */
  modules: readonly OverviewModule[] | null;
}>;

const targetIdPattern = /^[0-9A-Fa-f]{32}$/;

/** The headers the page `/new-tab` adds behind the gateway (F47 point 1):
 * only the Environment's own apps may frame Nová karta, `apps` (the
 * Launchpad itself, also `'self'`), `chat` and `automate`, from the recorded
 * entry, as present; and its type is not sniffed. No other page of the
 * Launchpad changes its headers. */
export function newTabPageHeaders(
  entry: Pick<
    MachineEntry,
    "externalOrigin" | "t3codeOrigin" | "mausbotOrigin"
  >,
): Readonly<Record<string, string>> {
  const origins = [
    entry.externalOrigin,
    entry.t3codeOrigin,
    ...(entry.mausbotOrigin === undefined ? [] : [entry.mausbotOrigin]),
  ];
  return Object.freeze({
    "Content-Security-Policy": `frame-ancestors 'self' ${[...new Set(origins)].join(" ")}`,
    "X-Content-Type-Options": "nosniff",
  });
}

function nameOpener(
  opener: TabOpener,
  thread: (session: string) => string | null,
): TabOpenerName {
  switch (opener.kind) {
    case "view":
    case "new-tab":
      return { person: true };
    case "page":
      return { page: opener.openerId };
    case "agent":
      if (opener.session.startsWith("t3-"))
        return { app: "t3code", thread: thread(opener.session) };
      if (opener.session.startsWith("codex-")) return { app: "codex" };
      if (opener.session.startsWith("claude-")) return { app: "claude" };
      return {};
    default:
      return {};
  }
}

const refusalStatus: Readonly<Record<HubRefusal["reason"], number>> = {
  "hub-unreachable": 503,
  "not-found": 404,
  "nothing-to-restore": 409,
  "invalid-request": 400,
};

export function createNewTabRoutes(
  input: Readonly<{
    /** The view's entry; undefined where the Environment has no browser. */
    browser: BrowserEntry | undefined;
    /** The Launchpad's holder file; null without a runtime directory. */
    holder: LaunchpadHolder | null;
    host: NewTabHost;
    /** The running Modules (`runningModules`); null when not known. */
    modules: () => Promise<readonly ModuleUnit[] | null>;
    headers: Readonly<Record<string, string>>;
  }>,
) {
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  const refusal = (refused: HubRefusal) =>
    response({ error: refused.reason }, refusalStatus[refused.reason]);

  /** One POST body with exactly these keys (and these optional ones). */
  async function body(
    request: Request,
    required: readonly string[],
    optional: readonly string[] = [],
  ): Promise<Record<string, unknown> | Response> {
    if (request.method !== "POST")
      return response({ error: "method-not-allowed" }, 405);
    if (request.headers.get("content-type") !== "application/json")
      return response({ error: "invalid-content-type" }, 415);
    try {
      const value = await readJsonBody(request);
      const present = optional.filter(
        (key) => ownDataValue(value, key) !== undefined,
      );
      return stateFields(value, [...required, ...present]);
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return response({ error: "body-too-large" }, 413);
      return response({ error: "invalid-request" }, 400);
    }
  }

  /** `{tab}`: one target id, upper case. */
  async function tabBody(request: Request): Promise<string | Response> {
    const value = await body(request, ["tab"]);
    if (value instanceof Response) return value;
    return typeof value.tab === "string" && targetIdPattern.test(value.tab)
      ? value.tab.toUpperCase()
      : response({ error: "invalid-tab" }, 400);
  }

  /** The Launchpad's hold, recorded before the answer. */
  async function hold(tab: string): Promise<Response | null> {
    try {
      await input.holder?.hold(tab);
      return null;
    } catch (error) {
      if (error instanceof HolderFull)
        return response({ error: "too-many-tabs" }, 409);
      input.host.log("hold-failed");
      return response({ error: "hold-failed" }, 500);
    }
  }

  async function overview(browser: BrowserEntry): Promise<NewTabOverview> {
    const [listed, measured] = await Promise.all([
      listTabs(browser, { heap: true }),
      (async () => {
        const running = await input.modules().catch(() => null);
        const reading = await readEnvironmentMemory(
          input.host,
          running?.map((module) => module.unit) ?? null,
        );
        return { running, reading };
      })(),
    ]);
    let tabs: OverviewTab[] | null = null;
    if (listed.kind === "tabs") {
      // A T3 Code thread is named by the title its server writes as its
      // holder file's label, whether or not that file holds the tab.
      const sessions = [
        ...new Set(
          listed.tabs.flatMap((tab) =>
            tab.opener.kind === "agent" && tab.opener.session.startsWith("t3-")
              ? [tab.opener.session]
              : [],
          ),
        ),
      ];
      const titles = new Map(
        await Promise.all(
          sessions.map(
            async (session) =>
              [
                session,
                await readHolderLabel(
                  input.host.runtimeDirectory,
                  session,
                  input.host.readFile,
                ),
              ] as const,
          ),
        ),
      );
      tabs = listed.tabs.map((tab) => ({
        ...tab,
        who: nameOpener(tab.opener, (session) => titles.get(session) ?? null),
      }));
    }
    const { running, reading } = measured;
    return {
      hub: listed.kind === "tabs" ? "connected" : "unreachable",
      tabs,
      memory: reading.memory,
      modules:
        running === null
          ? null
          : running.map((module) => ({
              ...module,
              memory: reading.units.get(module.unit) ?? null,
              // Every Module runs its development script from its own
              // checkout today; a worktree's run and the built mode come
              // later (DEV-6656 tasks 918 and 919).
              mode: "dev" as const,
              source: "main" as const,
            })),
    };
  }

  return Object.freeze({
    handles: (path: string) =>
      path === "/api/new-tab" || path.startsWith("/api/new-tab/"),
    async handle(
      request: Request,
      url: URL,
      extend: (seconds: number) => void,
    ): Promise<Response> {
      const browser = input.browser;
      if (browser === undefined) return response({ error: "no-browser" }, 404);
      switch (url.pathname) {
        case "/api/new-tab/overview": {
          if (request.method !== "GET")
            return response({ error: "method-not-allowed" }, 405);
          if ([...url.searchParams.keys()].length > 0)
            return response({ error: "invalid-query" }, 400);
          extend(30);
          return response(await overview(browser));
        }
        case "/api/new-tab/open": {
          const value = await body(request, ["url"], ["strip"]);
          if (value instanceof Response) return value;
          const strip = value.strip ?? null;
          const address =
            typeof value.url === "string" ? navigableAddress(value.url) : null;
          if (address === null || (strip !== null && !isStrip(strip)))
            return response({ error: "invalid-request" }, 400);
          if (strip === launchpadStrip && input.holder === null)
            return response({ error: "holder-unavailable" }, 503);
          extend(30);
          const opened = await openTab(browser, address, strip);
          if (opened.kind !== "opened") return refusal(opened);
          // The Launchpad's hold first (F47 point 8). Should it fail, the
          // new tab is one nobody has held yet, which the hub ends unless
          // it is viewed (F47 point 5).
          if (strip === launchpadStrip) {
            const failed = await hold(opened.tab);
            if (failed !== null) return failed;
          }
          return response(
            {
              tab: opened.tab,
              view: browserViewUrl(browser.origin, opened.tab),
            },
            201,
          );
        }
        case "/api/new-tab/hold": {
          // A page's new tab the person viewed in the Launchpad (F47 point
          // 4): held only while the hub lists it.
          const tab = await tabBody(request);
          if (tab instanceof Response) return tab;
          if (input.holder === null)
            return response({ error: "holder-unavailable" }, 503);
          extend(30);
          const listed = await listTabs(browser, { heap: false });
          if (listed.kind !== "tabs") return refusal(listed);
          if (!listed.tabs.some((known) => known.id === tab))
            return response({ error: "not-found" }, 404);
          return (await hold(tab)) ?? response({ held: true });
        }
        case "/api/new-tab/close": {
          const tab = await tabBody(request);
          if (tab instanceof Response) return tab;
          extend(30);
          const closed = await closeTab(browser, tab);
          return closed.kind === "closing"
            ? response({ closing: closed.closing }, 202)
            : refusal(closed);
        }
        case "/api/new-tab/restore": {
          const tab = await tabBody(request);
          if (tab instanceof Response) return tab;
          extend(30);
          const restored = await restoreTab(browser, tab);
          return restored.kind === "restored"
            ? response({ restored: true })
            : refusal(restored);
        }
        default:
          return response({ error: "not-found" }, 404);
      }
    },
  });
}
