import type { CatalogApp } from "../integrations/catalog-schema";
import { composioDashboard } from "../integrations/composio-source";
import type {
  CustomServer,
  IntegrationAccount,
  IntegrationApp,
  IntegrationsOverview,
  SourceState,
} from "../integrations/model";
import { forAdmin } from "../integrations/model";
import {
  type AppTool,
  appTools,
  integrationIdPattern,
  type PathChoice,
} from "../integrations/path";
import { pluralKey } from "./apps-view";
import type { MessageKey } from "./messages";
import type { IntegrationsTab } from "./routes";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Apps → Integrace (decision F42), what the page shows: pure, so it is tested
// without a DOM; integrations-panel.ts draws it. The approved wireframe
// (prototypes-lazurio `screens/Integrations.tsx`): the tabs Vše · Připojené
// (N) · Vlastní, cards with the app's mark, one line about it, the action and
// its accounts; a connected card says quietly which way it goes; where
// nothing connects an app, one line says why and one action follows.

/** Without a search, Vše shows this many cards before "Zobrazit všech". */
export const appsPreview = 24;

/** The documentation behind "Jak to funguje". */
export function integrationsHelp(locale: "cs" | "en"): string {
  return `https://documentation.lazurio.ai/${locale}/environment-app-connections/?utm_source=launchpad&utm_medium=product&utm_campaign=app-connections`;
}

const states = new Set(["connected", "expired", "pending", "failed"]);
const sourceStates = new Set([
  "ok",
  "unavailable",
  "absent",
  "unreadable",
  "signed-out",
  "not-allowed",
  "organization",
]);
const organizationStates = new Set([
  "matches",
  "missing",
  "ambiguous",
  "elsewhere",
]);

/** The Composio organization of the reading: null, or its name and state;
 * the name null only where the Organization's name cannot be read. */
function isTarget(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (target.state === "unverified") return target.name === null;
  return (
    typeof target.name === "string" &&
    target.name !== "" &&
    organizationStates.has(target.state as string)
  );
}

function isChoice(value: unknown): value is PathChoice {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as Record<string, unknown>;
  if (choice.path === "direct") return true;
  if (choice.path === "composio") return typeof choice.signIn === "boolean";
  if (choice.path === "tool")
    return (appTools as readonly unknown[]).includes(choice.tool);
  if (choice.path !== null) return false;
  if (choice.missing === "path") return true;
  if (choice.missing === "tool")
    return (appTools as readonly unknown[]).includes(choice.tool);
  if (choice.missing === "company-app")
    return (
      typeof choice.provider === "string" &&
      (choice.action === "set-up" || choice.action === "ask-admin")
    );
  if (choice.missing === "composio")
    return choice.action === "allow" || choice.action === "ask-admin";
  return false;
}

/** A link the page opens in Composio's dashboard, and no other. */
const dashboardLink = (value: unknown): boolean =>
  typeof value === "string" && value.startsWith(`${composioDashboard}/`);

function isAccount(value: unknown): value is IntegrationAccount {
  if (typeof value !== "object" || value === null) return false;
  const account = value as Record<string, unknown>;
  return (
    (account.path === "direct" || account.path === "composio") &&
    (account.selector === null || typeof account.selector === "string") &&
    (account.label === null || typeof account.label === "string") &&
    states.has(account.state as string) &&
    typeof account.spare === "boolean" &&
    (account.manage === null || dashboardLink(account.manage))
  );
}

function isApp(value: unknown): value is IntegrationApp {
  if (typeof value !== "object" || value === null) return false;
  const app = value as Record<string, unknown>;
  return (
    typeof app.id === "string" &&
    integrationIdPattern.test(app.id) &&
    typeof app.name === "string" &&
    isChoice(app.path) &&
    typeof app.connected === "boolean" &&
    Array.isArray(app.accounts) &&
    app.accounts.every(isAccount) &&
    typeof app.catalog === "boolean" &&
    (app.link === null || typeof app.link === "string")
  );
}

function isServer(value: unknown): value is CustomServer {
  if (typeof value !== "object" || value === null) return false;
  const server = value as Record<string, unknown>;
  return (
    typeof server.id === "string" &&
    typeof server.name === "string" &&
    (server.kind === "remote" || server.kind === "command") &&
    (server.target === null || typeof server.target === "string") &&
    (server.state === "ready" || states.has(server.state as string)) &&
    (server.tools === null ||
      (typeof server.tools === "number" && Number.isSafeInteger(server.tools)))
  );
}

/** `GET /api/integrations` as the page takes it, or null for any other
 * answer (a refusal, a shape of another version). */
export function parseIntegrations(value: unknown): IntegrationsOverview | null {
  if (typeof value !== "object" || value === null) return null;
  const answer = value as Record<string, unknown>;
  const composio = answer.composio as Record<string, unknown> | null;
  const sources = answer.sources as Record<string, unknown> | null;
  if (
    answer.kind !== "integrations" ||
    (answer.locale !== "cs" && answer.locale !== "en") ||
    (answer.scope !== "organization" && answer.scope !== "personal") ||
    (answer.page !== null && typeof answer.page !== "string") ||
    typeof composio !== "object" ||
    composio === null ||
    typeof composio.allowed !== "boolean" ||
    (composio.source !== "organization" && composio.source !== "environment") ||
    typeof composio.ready !== "boolean" ||
    typeof composio.disconnect !== "boolean" ||
    typeof composio.update !== "boolean" ||
    (composio.apps !== null && !dashboardLink(composio.apps)) ||
    !isTarget(composio.organization) ||
    typeof sources !== "object" ||
    sources === null ||
    !["tools", "executor", "composio"].every((name) =>
      sourceStates.has(sources[name] as string),
    ) ||
    !Array.isArray(answer.tools) ||
    !answer.tools.every((tool) =>
      (appTools as readonly unknown[]).includes(tool),
    ) ||
    !Array.isArray(answer.apps) ||
    !answer.apps.every(isApp) ||
    !Array.isArray(answer.custom) ||
    !answer.custom.every(isServer) ||
    typeof answer.readAt !== "string"
  )
    return null;
  return answer as IntegrationsOverview;
}

/** Search without case and diacritics: "kalendar" finds Google Kalendář. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** The labels of the tabs: Připojené and Vlastní with their counts. */
export function tabLabels(
  overview: IntegrationsOverview | null,
  copy: Copy,
): Readonly<Record<IntegrationsTab, string>> {
  const connected = overview?.apps.filter((app) => app.connected).length ?? 0;
  const custom = overview?.custom.length ?? 0;
  const count = (label: string, n: number) => (n > 0 ? `${label} ${n}` : label);
  return {
    all: copy.integrationsTabAll,
    connected: count(copy.integrationsTabConnected, connected),
    custom: count(copy.integrationsTabCustom, custom),
  };
}

/** Accounts that need the person: expired sign-ins on an app's path. */
export function attentionCount(overview: IntegrationsOverview | null): number {
  return (
    overview?.apps.reduce(
      (sum, app) =>
        sum +
        app.accounts.filter(
          (account) => !account.spare && account.state === "expired",
        ).length,
      0,
    ) ?? 0
  );
}

/** What the catalog lists without a search (the wireframe's
 * `offeredApps`): every app where Composio is allowed, otherwise the apps
 * with a direct path here (on a personal Environment the one-click ones);
 * always the apps a connected tool connects and the apps connected here. */
export function offered(app: IntegrationApp): boolean {
  if (app.connected || app.accounts.length > 0) return true;
  // An Organization's company app is offered for its Admin to set up.
  return app.path.path !== null || app.path.missing === "company-app";
}

/** The apps of a tab, in the order the page shows them: connected first,
 * then what connects here, then what cannot yet; each group in catalog
 * order. A search finds every app; Vše without one lists what is offered,
 * and always the app a card link names (`linked`), even one nothing
 * connects here, so the link opens its card with what is missing. */
export function visibleApps(
  overview: IntegrationsOverview,
  catalog: readonly CatalogApp[],
  tab: IntegrationsTab,
  search: string,
  linked: string | null = null,
): IntegrationApp[] {
  const wanted = normalize(search.trim());
  const describe = (app: IntegrationApp) => {
    const entry = catalog.find((item) => item.id === app.id);
    return [
      app.name,
      app.id,
      entry?.name.cs,
      entry?.name.en,
      entry?.description.cs,
      entry?.description.en,
    ];
  };
  const pool =
    tab === "connected"
      ? overview.apps.filter((app) => app.connected || app.accounts.length > 0)
      : wanted === ""
        ? overview.apps.filter((app) => offered(app) || app.id === linked)
        : overview.apps;
  const matching =
    wanted === ""
      ? pool
      : pool.filter((app) =>
          describe(app).some(
            (text) => text !== undefined && normalize(text).includes(wanted),
          ),
        );
  const rank = (app: IntegrationApp) =>
    app.connected ? 0 : app.path.path !== null ? 1 : 2;
  return matching
    .map((app, index) => ({ app, index }))
    .sort((a, b) => rank(a.app) - rank(b.app) || a.index - b.index)
    .map(({ app }) => app);
}

/** The quiet label of a connected card: přímo, přes Composio, přes <tool>. */
export function pathLabel(choice: PathChoice, copy: Copy): string | null {
  if (choice.path === "direct") return copy.integrationsPathDirect;
  if (choice.path === "composio") return copy.integrationsPathComposio;
  if (choice.path === "tool")
    return fill(copy.integrationsPathTool, { tool: choice.tool });
  return null;
}

/** The company apps by the names a card says. */
const providerNames: Readonly<Record<string, string>> = {
  google: "Google",
  microsoft: "Microsoft",
};

/** What a card offers: connect (or another account), what is missing with
 * its one action, or nothing (through its tool it is just there). */
export type CardAction =
  | Readonly<{ kind: "connect"; label: string; path: "direct" | "composio" }>
  | Readonly<{ kind: "open-tools"; label: string }>
  | Readonly<{ kind: "set-up"; label: string }>
  | Readonly<{ kind: "allow"; label: string }>
  | Readonly<{ kind: "ask-admin"; label: string }>
  | Readonly<{ kind: "none" }>;

export type CardView = Readonly<{
  /** The line under the name: the app's sentence, why nothing connects it,
   * or that a connection waits for the browser. */
  line: string;
  connected: boolean;
  pathLabel: string | null;
  action: CardAction;
  /** Whether connecting goes through Composio, a third party: the form
   * says so in one sentence. */
  composio: boolean;
}>;

export function cardView(
  app: IntegrationApp,
  entry: CatalogApp | undefined,
  options: Readonly<{
    locale: "cs" | "en";
    scope: IntegrationsOverview["scope"];
    admin: boolean;
    copy: Copy;
  }>,
): CardView {
  const { copy } = options;
  const choice = forAdmin(app.path, options.admin);
  // An app the catalog does not know has no sentence of its own: it says
  // where it comes from (decision F42, addendum of 2026-10-14).
  const about =
    entry?.description[options.locale] ??
    (app.catalog ? app.name : copy.integrationsOutsideCatalog);
  const own = app.accounts.filter((account) => !account.spare);
  const waiting =
    !app.connected &&
    own.length > 0 &&
    own.every((account) => account.state === "pending");
  const label = pathLabel(choice, copy);
  if (choice.path === "tool")
    return {
      line: about,
      connected: true,
      pathLabel: label,
      action: { kind: "none" },
      composio: false,
    };
  if (choice.path === "direct" || choice.path === "composio")
    return {
      line: waiting ? copy.integrationsFinishInBrowser : about,
      connected: app.connected,
      pathLabel: app.connected ? label : null,
      action: {
        kind: "connect",
        label: own.some(
          (account) =>
            account.state === "connected" || account.state === "expired",
        )
          ? copy.integrationsAddAccount
          : copy.integrationsConnect,
        path: choice.path,
      },
      composio: choice.path === "composio",
    };
  if (choice.missing === "path")
    return {
      line: copy.integrationsMissingPath,
      connected: false,
      pathLabel: null,
      action: { kind: "none" },
      composio: false,
    };
  if (choice.missing === "tool")
    return {
      line: fill(copy.integrationsMissingTool, { tool: choice.tool }),
      connected: false,
      pathLabel: null,
      action: { kind: "open-tools", label: copy.integrationsOpenTools },
      composio: false,
    };
  const line =
    choice.missing === "company-app"
      ? fill(copy.integrationsMissingCompanyApp, {
          provider: providerNames[choice.provider] ?? app.name,
        })
      : options.scope === "organization"
        ? copy.integrationsComposioOffOrganization
        : copy.integrationsComposioOffHere;
  const action: CardAction =
    choice.action === "ask-admin"
      ? { kind: "ask-admin", label: copy.integrationsAskAdmin }
      : choice.missing === "company-app"
        ? { kind: "set-up", label: copy.integrationsSetUpInDashboard }
        : { kind: "allow", label: copy.integrationsAllowComposio };
  return { line, connected: false, pathLabel: null, action, composio: false };
}

export type AccountView = Readonly<{
  /** Its name (Executor's name, Composio's alias or the provider's
   * identity its list gives), else "účet". */
  name: string;
  /** Why it is not active, or that it is on another way; "Odpojuji…" while
   * it is being disconnected, why that failed, or that it still shows after
   * it was disconnected; none when ok. */
  line: string | null;
  /** Being disconnected: the row is dimmed with a spinner, and its
   * actions wait (`Removal`). */
  busy: boolean;
  /** `line` says why disconnecting it failed. */
  failed: boolean;
  /** "Přihlásit znovu" or "Zkusit znovu"; none when ok, spare or waiting. */
  retry: string | null;
  /** "Odpojit" in the row: an account in Executor that can be named. */
  disconnect: boolean;
  /** The "⋯" menu of a Composio account (#312): the label of its button,
   * "Spravovat v Composiu" to `manage`, and whether "Odpojit" is in it:
   * only where the CLI removes an account without a prompt. */
  menu: Readonly<{
    label: string;
    manage: string;
    disconnect: boolean;
  }> | null;
}>;

export function accountView(
  app: IntegrationApp,
  account: IntegrationAccount,
  copy: Copy,
  /** Composio's CLI removes an account here (`overview.composio.disconnect`). */
  composioDisconnect: boolean,
  /** Where "Odpojit" of this account stands (`removalKey`), if anywhere. */
  removal?: Removal,
): AccountView {
  const view = accountState(app, account, copy, composioDisconnect);
  if (removal === undefined) return view;
  if (removal.state === "failed")
    return { ...view, line: removal.text, failed: true };
  if (removal.state === "listed")
    return { ...view, line: copy.integrationsDisconnectStillListed };
  return {
    ...view,
    line: copy.integrationsDisconnecting,
    busy: true,
    retry: null,
  };
}

function accountState(
  app: IntegrationApp,
  account: IntegrationAccount,
  copy: Copy,
  composioDisconnect: boolean,
): AccountView {
  const name = account.label ?? copy.integrationsAccountUnnamed;
  const named = account.selector !== null;
  // A Composio account has its menu, with "Odpojit" in it; an account in
  // Executor keeps "Odpojit" in the row.
  const menu =
    account.manage === null
      ? null
      : {
          label: fill(copy.integrationsAccountMore, {
            account: name,
            app: app.name,
          }),
          manage: account.manage,
          disconnect: named && composioDisconnect,
        };
  const disconnect = menu === null && named;
  if (account.spare)
    return {
      name,
      line:
        account.path === "direct"
          ? copy.integrationsAccountSpareDirect
          : copy.integrationsAccountSpareComposio,
      retry: null,
      disconnect,
      menu,
      busy: false,
      failed: false,
    };
  const line =
    account.state === "expired"
      ? copy.integrationsAccountExpired
      : account.state === "pending"
        ? copy.integrationsAccountPending
        : account.state === "failed"
          ? copy.integrationsAccountFailed
          : null;
  const retry =
    account.state === "expired"
      ? copy.integrationsSignInAgain
      : account.state === "failed"
        ? copy.integrationsRetry
        : null;
  return { name, line, retry, disconnect, menu, busy: false, failed: false };
}

/** "Odpojit" of one account, from the person's confirmation until a reading
 * that no longer lists it (decision F42, addendum (b) of 2026-10-14):
 * Composio may take a few seconds to remove an account and the page as long
 * to read again, so the row says "Odpojuji…" all that time. `removing`: the
 * removal runs; `removed`: it answered that the account is disconnected, and
 * no successful reading without the account has come in yet (`checks`: the
 * readings since that did not show it gone); `failed`: it did not
 * disconnect, and the row says why until the next successful reading or a new
 * attempt; `listed`: it was disconnected, but successful readings still list
 * the account after the re-reads (`removalRechecks`), so the row is drawn as
 * it is with one plain line, until a reading without it. */
export type Removal =
  | Readonly<{ state: "removing" }>
  | Readonly<{ state: "removed"; checks: number }>
  | Readonly<{ state: "failed"; text: string }>
  | Readonly<{ state: "listed" }>;

export type Removals = ReadonlyMap<string, Removal>;

/** Which account a removal is: its app, path and selector. */
export function removalKey(
  app: Pick<IntegrationApp, "id">,
  account: Pick<IntegrationAccount, "path" | "selector">,
): string {
  return JSON.stringify([app.id, account.path, account.selector]);
}

/** The removals after the person confirmed one (`confirmed`) or it
 * answered (`answered`: null where the account was disconnected, else why
 * not, `disconnectFailure`). */
export function removalStep(
  removals: Removals,
  key: string,
  event:
    | Readonly<{ kind: "confirmed" }>
    | Readonly<{ kind: "answered"; failure: string | null }>,
): Removals {
  const next = new Map(removals);
  if (event.kind === "confirmed") next.set(key, { state: "removing" });
  else
    next.set(
      key,
      event.failure === null
        ? { state: "removed", checks: 0 }
        : { state: "failed", text: event.failure },
    );
  return next;
}

/** How many readings after a removal answered may still show the account
 * (or fail) before the page stops reading again by itself: Composio's list
 * may lag behind a removal for a moment. */
export const removalRechecks = 2;

/** How long the page waits before it reads again for a removal. */
export const removalRecheckMs = 1_500;

/** The removals once a reading completed: `reading` is the overview it
 * answered, or null where it failed or answered something the page does not
 * take. Only a successful reading that no longer lists an account ends its
 * removal; a running removal waits for its answer whatever is read; a failed
 * or stale reading keeps "Odpojuji…" and asks for another reading (`again`)
 * at most `removalRechecks` times; a reading whose source of the account's
 * path was not read (`sources.composio` or `sources.executor` other than
 * `ok`) counts as stale. After them, a successful reading that
 * still lists the account draws it as it is (`listed`); a failing one keeps
 * the row waiting, and the page says the Integrace could not be read. */
export function removalsRead(
  removals: Removals,
  reading: IntegrationsOverview | null,
): Readonly<{ removals: Removals; again: boolean }> {
  const shown =
    reading === null
      ? null
      : new Set(
          reading.apps.flatMap((app) =>
            app.accounts.map((account) => removalKey(app, account)),
          ),
        );
  // An account counts as gone only where its own path's source was read:
  // a reading may answer with one source unreadable and leave that source's
  // accounts out, which is never "nothing connected" (Pablo's review of #417).
  const read = (key: string): boolean => {
    if (reading === null) return false;
    const path: unknown = (JSON.parse(key) as unknown[])[1];
    const source =
      path === "composio"
        ? reading.sources.composio
        : path === "direct"
          ? reading.sources.executor
          : null;
    return source === "ok";
  };
  const next = new Map<string, Removal>();
  let again = false;
  for (const [key, removal] of removals) {
    const gone = shown !== null && read(key) && !shown.has(key);
    if (removal.state === "removing") next.set(key, removal);
    else if (removal.state === "removed") {
      if (gone) continue;
      if (removal.checks < removalRechecks) {
        next.set(key, { state: "removed", checks: removal.checks + 1 });
        again = true;
      } else
        next.set(
          key,
          shown === null || !read(key) ? removal : { state: "listed" },
        );
    } else if (removal.state === "failed") {
      if (shown === null) next.set(key, removal);
    } else if (!gone) next.set(key, removal);
  }
  return { removals: next, again };
}

/** Why "Odpojit" did not disconnect the account, from the route's answer;
 * null where it did. */
export function disconnectFailure(
  answer: unknown,
  overview: IntegrationsOverview | null,
  copy: Copy,
): string | null {
  const value =
    typeof answer === "object" && answer !== null
      ? (answer as Record<string, unknown>)
      : {};
  if (value.kind === "disconnected") return null;
  if (value.reason === "composio-organization")
    return (
      (overview === null ? null : composioOrganizationLine(overview, copy)) ??
      copy.integrationsComposioOrganizationChanged
    );
  return value.reason === "disconnect-unsupported"
    ? copy.integrationsDisconnectUnsupported
    : copy.integrationsDisconnectFailed;
}

/** Composio's update on this page (decision F42, addendum (b) of
 * 2026-10-14): `idle`, `updating` from the click until the reading after a
 * finished update, `failed` until the next click. */
export type ComposioUpdate = "idle" | "updating" | "failed";

/** The one line that asks the person to update Composio, where the reading
 * says Composio is on here but not the build Lazurio pins and its update
 * can work (`composio.update`); null elsewhere. The button runs the update
 * of Settings → Tools; the person's click is the consent. */
export function composioUpdateLine(
  overview: IntegrationsOverview,
  update: ComposioUpdate,
  copy: Copy,
): Readonly<{ text: string; action: string; busy: boolean }> | null {
  if (!overview.composio.update) return null;
  return {
    text:
      update === "updating"
        ? copy.integrationsComposioUpdating
        : update === "failed"
          ? copy.integrationsComposioUpdateFailed
          : copy.integrationsComposioUpdate,
    action: copy.toolsUpdateAction,
    busy: update === "updating",
  };
}

/** Whether `/api/tools/upgrade` installed the pinned build (`lazurio tools
 * update`'s `tool-updated`); anything else, a refusal or a failure, did
 * not. */
export function composioUpdated(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    (answer as Record<string, unknown>).kind === "tool-updated"
  );
}

/** The one consequence the disconnect dialog names. */
export function disconnectText(
  app: IntegrationApp,
  account: IntegrationAccount,
  composioAccount: string | null,
  copy: Copy,
): string {
  if (account.state === "pending")
    return fill(copy.integrationsDisconnectPending, { app: app.name });
  if (account.path === "direct") return copy.integrationsDisconnectDirect;
  return composioAccount === null
    ? copy.integrationsDisconnectComposioAny
    : fill(copy.integrationsDisconnectComposio, { account: composioAccount });
}

/** The way to Composio's Apps and back (decision F42, addendum of
 * 2026-10-14): "Aplikace v Composiu" opened (`opened`), the page lost the
 * person to it (`left`: the tab hidden or the window blurred), and their
 * return (`back`) reads the connections once, so what they connected in
 * Composio shows without "Zkontrolovat připojení". A link opened in the
 * background never took the person away: its page reads again only once
 * they did leave and came back. Focus and visibility both report a return;
 * the second reads nothing. No polling. */
export type ComposioTrip = "idle" | "opened" | "away";

export function composioTrip(
  trip: ComposioTrip,
  event: "opened" | "left" | "back",
): Readonly<{ trip: ComposioTrip; refresh: boolean }> {
  if (event === "opened") return { trip: "opened", refresh: false };
  if (event === "left")
    return { trip: trip === "idle" ? "idle" : "away", refresh: false };
  return trip === "away"
    ? { trip: "idle", refresh: true }
    : { trip, refresh: false };
}

/** One line per source that could not be read, so a missing source is
 * never taken for "nothing connected". */
export function sourceLines(
  overview: IntegrationsOverview,
  copy: Copy,
): string[] {
  const lines: string[] = [];
  const executor: SourceState = overview.sources.executor;
  if (executor === "unavailable")
    lines.push(copy.integrationsExecutorUnavailable);
  if (executor === "absent") lines.push(copy.integrationsExecutorAbsent);
  if (executor === "unreadable")
    lines.push(copy.integrationsExecutorUnreadable);
  if (overview.sources.composio === "unreadable" && overview.composio.ready)
    lines.push(copy.integrationsComposioUnreadable);
  if (overview.sources.tools !== "ok")
    lines.push(copy.integrationsToolsUnreadable);
  return lines;
}

/** What the page says where Composio does not work in the organization of
 * this Environment's Organization's name (decision F42, addendum (2) of
 * 2026-10-13): missing or there more than once, while Composio works in the
 * person's current organization; not made current, or the Organization's
 * name unreadable, while nothing of it counts. Null where nothing is to
 * say. */
export function composioOrganizationLine(
  overview: IntegrationsOverview,
  copy: Copy,
): string | null {
  const target = overview.composio.organization;
  if (target === null || target.state === "matches") return null;
  if (target.state === "unverified" || target.name === null)
    return copy.integrationsComposioOrganizationUnverified;
  const key =
    target.state === "missing"
      ? "integrationsComposioOrganizationMissing"
      : target.state === "ambiguous"
        ? "integrationsComposioOrganizationAmbiguous"
        : "integrationsComposioOrganizationElsewhere";
  return fill(copy[key], { name: target.name });
}

/** "Připojeno · 5 nástrojů", "Nepodařilo se spustit", "Spouštím…". */
export function serverLine(server: CustomServer, copy: Copy): string {
  if (server.state === "failed" || server.state === "expired")
    return copy.integrationsMcpFailed;
  if (server.state === "pending") return copy.integrationsMcpPending;
  if (server.tools === null) return copy.integrationsMcpReady;
  return fill(copy.integrationsMcpTools, {
    tools: fill(
      copy[
        pluralKey(server.tools, {
          one: "integrationsToolsOne",
          few: "integrationsToolsFew",
          many: "integrationsToolsMany",
        })
      ],
      { count: String(server.tools) },
    ),
  });
}

/** The monogram of an app without a bundled icon: its first letter. */
export function monogram(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** The tools a person can open for an app only its tool connects. */
export function toolOf(choice: PathChoice): AppTool | null {
  return choice.path === null && choice.missing === "tool" ? choice.tool : null;
}
