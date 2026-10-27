import { integrationsCatalog } from "../integrations/catalog";
import type { CatalogApp } from "../integrations/catalog-schema";
import { composioDashboard } from "../integrations/composio-source";
import { microsoft365Card } from "../integrations/microsoft365-card";
import type {
  CustomServer,
  IntegrationAccount,
  IntegrationApp,
  IntegrationsOverview,
} from "../integrations/model";
import {
  addRow,
  type CustomForm,
  customBody,
  customFormView,
  customInput,
  customRefusal,
  customSaved,
  editCustomForm,
  type FieldLine,
  type FieldName,
  type KeyList,
  newCustomForm,
  parseCustomSettings,
  type RowList,
  removeRow,
  withArg,
  withField,
  withKey,
  withoutStoredBearer,
  withType,
} from "./custom-server-form";
import {
  type AccountView,
  accountView,
  appsPreview,
  attentionCount,
  type CardAction,
  type ComposioSignInAnswer,
  type ComposioTrip,
  type ComposioUpdate,
  cardView,
  composioOrganizationChanged,
  composioOrganizationLine,
  composioOrganizationWaits,
  composioSignInNote,
  composioTrip,
  composioUpdated,
  composioUpdateLine,
  disconnectFailure,
  disconnectText,
  integrationsHelp,
  liveAnnouncement,
  liveText,
  monogram,
  type Note,
  type NoticeTone,
  noneConnectedText,
  noteAfterReading,
  noticeIcon,
  parseIntegrations,
  type Removals,
  refusalNote,
  removalKey,
  removalRecheckMs,
  removalStep,
  removalsRead,
  serverLine,
  sourceLines,
  tabLabels,
  toolStatesKey,
  visibleApps,
} from "./integrations-view";
import type { MessageKey } from "./messages";
import {
  customServerPath,
  type IntegrationsTab,
  integrationsPath,
  type PageRoute,
  settingsPath,
} from "./routes";
import {
  composioDialogView,
  composioPollDelay,
  composioPollNext,
} from "./tools-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Apps → Integrace (decision F42): the page's DOM over integrations-view.ts.
// The server drives Executor and Composio; this page only opens what the
// person signs in to: a window of their own browser (claimed in the click,
// so no pop-up blocker stops it, and closed once the app is connected), or
// the Environment browser's view in the right panel where a direct sign-in
// can return only to Executor on a Remote Environment (decision F42,
// addendum of 2026-10-13). A link URL lives only in that window and in page
// memory; a key typed for a custom server goes to the server once and is
// never kept. Every value from the server is drawn with textContent.
// Where Composio's accounts count here, "Aplikace v Composiu" (the page's
// corner) and "Aplikaci tu nenajdete? Připojte ji v Composiu" (the foot of
// Vše, also of a search that found nothing) open the Apps of the person's
// Composio organization in their own browser, the link the server built;
// coming back reads the Integrace once (decision F42, addendum of
// 2026-10-14). "Odpojit" closes its confirmation at once and the account's
// row says "Odpojuji…" until the reading after it; where Composio is not the
// build Lazurio pins, one line offers its update (decision F42, addendum (b)
// of 2026-10-14). Where the organization of the Organization's name is
// missing in Composio or there twice, the page reads its verdict again by
// itself, at the pace of Composio's sign-in dialog, and the Integrace once
// it changed (decision F42, note of 2026-10-19).

type Session = Readonly<{
  id: string;
  app: string;
  window: Window | null;
  /** What started it, for a sign-in asked for again (#596). */
  name: string | null;
  again?: IntegrationAccount;
}>;

/** The page of a custom MCP server while its route is shown: the server
 * (null for a new one), its form once read, the line beside Save. */
type CustomPage = Readonly<{
  server: string | null;
  form: CustomForm | null;
  failed: boolean;
  saving: boolean;
  status: string;
}>;

export function createIntegrationsPanel(
  options: Readonly<{
    get: (path: string) => Promise<{ value: unknown; ok: boolean }>;
    post: (
      path: string,
      body: unknown,
    ) => Promise<{ value: unknown; ok: boolean }>;
    copy: () => Copy;
    locale: () => "cs" | "en";
    navigate: (path: string) => void;
    /** Opens the right panel on the Environment browser's view. */
    showBrowser: (view: string) => void;
    /** Composio's sign-in, read live first (`composioSignIn`, decision F42,
     * note of 2026-10-19): `signed-in` where Composio is signed in here
     * after all, and nothing else happens; `unreadable` where the tools
     * could not be read, and the person stays here; otherwise Settings →
     * Tools is shown, with its sign-in `opened` where it could open. */
    signInComposio: () => Promise<ComposioSignInAnswer>;
    /** Whether the person is the Organization's Admin or Owner (GitHub's
     * answer); false where it is not known. */
    admin: () => Promise<boolean>;
    /** The Organization's page in the Dashboard, where its Admin sets up a
     * company app and allows Composio; null where none is known. */
    dashboard: () => string | null;
    /** Whether this is a Team Environment, whose Composio is signed in with
     * the Team's Composio account (decision F42, note of 2026-10-19). */
    team: () => boolean;
    /** Called after the page is drawn: what the guide of the page's "?" is
     * chosen by may have changed (whether Composio is allowed). */
    drawn?: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing integrations UI");
    return element;
  };
  const navLink = find<HTMLAnchorElement>("#integrations-open");
  const attention = find<HTMLSpanElement>("#integrations-attention");
  const composioApps = find<HTMLAnchorElement>("#integrations-composio");
  const search = find<HTMLInputElement>("#integrations-search");
  const refreshButton = find<HTMLButtonElement>("#integrations-refresh");
  const tabs = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      "#integrations-tabs a[data-tab]",
    ),
  ];
  const notices = find<HTMLDivElement>("#integrations-notices");
  const alert = find<HTMLDivElement>("#integrations-alert");
  const problemsHost = find<HTMLDivElement>("#integrations-problems");
  const status = find<HTMLParagraphElement>("#integrations-status");
  const live = find<HTMLParagraphElement>("#integrations-live");
  const body = find<HTMLDivElement>("#integrations-body");
  const formHost = find<HTMLDivElement>("#integrations-form");
  const confirm = find<HTMLDialogElement>("#integrations-confirm");
  const confirmTitle = find<HTMLHeadingElement>("#integrations-confirm-title");
  const confirmText = find<HTMLParagraphElement>("#integrations-confirm-text");
  const confirmStatus = find<HTMLParagraphElement>(
    "#integrations-confirm-status",
  );
  const confirmOk = find<HTMLButtonElement>("#integrations-confirm-ok");
  const confirmCancel = find<HTMLButtonElement>("#integrations-confirm-cancel");

  let route: Readonly<{ tab: IntegrationsTab; app?: string }> | null = null;
  let overview: IntegrationsOverview | null = null;
  let loading = false;
  let failed = false;
  let reads = 0;
  let showAll = false;
  let admin = false;
  let adminAsked = false;
  /** The app whose connect form is open, and its name field. */
  let forming: string | null = null;
  let formName = "";
  let formNeedsName = false;
  /** The page of a custom MCP server, while its route is shown, and the
   * nodes its refresh fills (lines, inputs, Save) by key. */
  let custom: CustomPage | null = null;
  const fields = new Map<string, HTMLElement>();
  /** The notice under the tabs about the last action: a refusal, a pop-up
   * blocked, an ended flow, a connection done; null for none. */
  let note: Note | null = null;
  /** The app a deep link opened, brought into view once drawn, and opened
   * with its form once the reading is in. */
  let focus: string | null = null;
  let deepLink: string | null = null;
  const sessions = new Map<string, Session>();
  let busy = new Set<string>();
  /** What the confirmation's OK does: an action it waits for, saying its
   * failure in the dialog (`wait`), or one it starts once closed
   * (`start`), which says how it goes on the page. */
  let confirmAction:
    | Readonly<{ kind: "wait"; run: () => Promise<string | null> }>
    | Readonly<{ kind: "start"; run: () => void }>
    | null = null;
  /** "Odpojit" of each account from its confirmation until the reading
   * after it (`Removal`). */
  let removals: Removals = new Map();
  /** Which tools are installed and on for agents, as last reported
   * (`toolsRead`); null before the first report. */
  let toolStates: string | null = null;
  /** Composio's update from this page (`ComposioUpdate`). */
  let updating: ComposioUpdate = "idle";
  /** The way to Composio's Apps and back (`composioTrip`). */
  let trip: ComposioTrip = "idle";
  /** The organizations' verdict read again while the page waits for the
   * person in Composio (`composioOrganizationWaits`): the next reading, the
   * readings without a change so far, and the last one's view. */
  const waiting: {
    timer: ReturnType<typeof setTimeout> | null;
    attempt: number;
    key: string | null;
    reading: boolean;
  } = { timer: null, attempt: 0, key: null, reading: false };

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    content?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const icon = (name: string) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
  };
  const button = (label: string, className: string, action: () => void) => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  /** A link that moves within the page (`data-route`, shell.ts). */
  const routeLink = (href: string, className: string, content?: string) => {
    const link = element("a", className, content);
    link.href = href;
    link.dataset.route = "";
    return link;
  };
  /** A notice's icon, then its text and actions, which wrap beside the
   * icon, as the callout's row draws them. */
  const noticeParts = (
    tone: NoticeTone,
    text: string,
    actions: readonly HTMLElement[] = [],
    mark: Element = icon(noticeIcon(tone)),
  ): Node[] => {
    if (mark instanceof SVGElement) mark.classList.add("callout-icon");
    const words = element("div", "callout-body");
    words.append(element("span", "callout-text", text));
    if (actions.length > 0) {
      const holder = element("div", "callout-actions");
      holder.append(...actions);
      words.append(holder);
    }
    return [mark, words];
  };
  /** One notice of the page: a callout of its tone, its icon, the text and
   * its actions; `bare` draws only the row, inside a callout that holds
   * more. */
  function notice(
    tone: NoticeTone,
    text: string,
    actions: readonly HTMLElement[] = [],
    draw: Readonly<{ icon?: Element; bare?: boolean }> = {},
  ): HTMLElement {
    const box = element(
      "div",
      draw.bare ? "callout-row" : "callout callout-row",
    );
    if (!draw.bare) box.dataset.kind = tone;
    box.append(...noticeParts(tone, text, actions, draw.icon));
    return box;
  }
  // The Microsoft 365 company app's card stands beside the catalog's
  // (decision F42 addendum (c) of 2026-10-14).
  const catalogOf = (id: string): CatalogApp | undefined =>
    id === microsoft365Card.id
      ? microsoft365Card
      : integrationsCatalog.apps.find((app) => app.id === id);

  /** The app's mark: its bundled icon, else its first letter. */
  function mark(app: IntegrationApp): HTMLElement {
    const entry = catalogOf(app.id);
    const holder = element("span", "integration-mark");
    holder.setAttribute("aria-hidden", "true");
    if (entry?.icon === undefined) {
      holder.classList.add("integration-mark-letter");
      holder.textContent = monogram(app.name);
      return holder;
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", entry.icon.path);
    path.setAttribute("fill", `#${entry.icon.hex}`);
    svg.append(path);
    holder.append(svg);
    return holder;
  }

  const active = () => route !== null;

  async function load(refresh = false) {
    reads += 1;
    const read = reads;
    loading = true;
    render();
    /** What this reading answered, where it succeeded. */
    let fresh: IntegrationsOverview | null = null;
    try {
      const { value, ok } = await options.get(
        refresh ? "/api/integrations?refresh=1" : "/api/integrations",
      );
      const parsed = ok ? parseIntegrations(value) : null;
      if (read !== reads) return;
      if (parsed === null) failed = true;
      else {
        overview = parsed;
        fresh = parsed;
        failed = false;
      }
    } catch {
      if (read === reads) failed = true;
    } finally {
      if (read === reads) {
        loading = false;
        note = noteAfterReading(note, fresh, options.copy());
        // Only a successful reading without the account ends its "Odpojit";
        // a failed or stale one keeps the row waiting and reads again, a
        // bounded number of times (`removalsRead`).
        const next = removalsRead(removals, fresh);
        removals = next.removals;
        if (next.again) setTimeout(() => void load(true), removalRecheckMs);
        drawAttention();
        if (deepLink !== null) openLinked(deepLink);
        render();
        waitForComposio();
        if (!adminAsked && overview?.scope === "organization") {
          adminAsked = true;
          void options.admin().then((answer) => {
            admin = answer;
            render();
          });
        }
      }
    }
  }

  /** Reads the organizations' verdict again while the page waits for the
   * person in Composio and is shown: after the dialog's pace, or `now` (the
   * page shown again); never while hidden or once it no longer waits. */
  function waitForComposio(now = false) {
    if (waiting.timer !== null) clearTimeout(waiting.timer);
    waiting.timer = null;
    if (
      waiting.reading ||
      document.hidden ||
      !active() ||
      !composioOrganizationWaits(overview)
    )
      return;
    if (now) waiting.attempt = 0;
    waiting.timer = setTimeout(
      () => void readComposioOrganization(),
      now ? 0 : composioPollDelay(waiting.attempt),
    );
  }

  async function readComposioOrganization() {
    waiting.timer = null;
    waiting.reading = true;
    let answer: unknown = null;
    try {
      const { value, ok } = await options.post(
        "/api/tools/composio/organizations",
        {},
      );
      if (ok) answer = value;
    } catch {}
    waiting.reading = false;
    if (!active() || !composioOrganizationWaits(overview)) return;
    // Found, or otherwise changed: the Integrace say what it is now. The
    // pace keeps growing, so a reading that would still disagree never
    // makes the page read faster.
    if (composioOrganizationChanged(overview, answer)) {
      waiting.attempt += 1;
      waiting.key = null;
      void load(true);
      return;
    }
    const view = composioDialogView(answer, null, options.copy());
    const key = JSON.stringify(view);
    if (key === waiting.key) waiting.attempt += 1;
    else {
      waiting.attempt = 0;
      waiting.key = key;
    }
    if (
      composioPollNext(view, { open: true, hidden: document.hidden }) === "read"
    )
      waitForComposio();
  }

  /** An agent's link to an app's card: the card with its form, unless the
   * app goes through its tool, has nothing to connect it, or an account of
   * it waits for the person. */
  function openLinked(id: string) {
    const found = overview?.apps.find((item) => item.id === id);
    if (found === undefined) return;
    deepLink = null;
    if (
      (found.path.path === "direct" || found.path.path === "composio") &&
      found.accounts.every((account) => account.state === "connected")
    ) {
      forming = id;
      formName = "";
      formNeedsName =
        found.path.path === "composio" &&
        found.accounts.some((account) => !account.spare);
    }
  }

  function drawAttention() {
    const count = attentionCount(overview);
    attention.hidden = count === 0;
    attention.textContent = count === 0 ? "" : String(count);
  }

  function say(text: string, tone: NoticeTone) {
    note = { text, tone };
    render();
  }

  /** Waits for a session: connected, ended, or still going. */
  async function follow(session: Session) {
    const copy = options.copy();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (!sessions.has(session.id)) return;
      let answer: { value: unknown; ok: boolean };
      try {
        answer = await options.post("/api/integrations/poll", {
          session: session.id,
        });
      } catch {
        continue;
      }
      const kind = (answer.value as { kind?: unknown } | null)?.kind;
      if (kind === "pending") continue;
      sessions.delete(session.id);
      busy = new Set([...busy].filter((id) => id !== session.app));
      const ended = (answer.value ?? {}) as Record<string, unknown>;
      if (kind === "connected") {
        // Its window has done its part; the person is back on the card.
        session.window?.close();
        const name =
          overview?.apps.find((app) => app.id === session.app)?.name ??
          session.app;
        note = {
          text: fill(copy.integrationsConnectedNow, { app: name }),
          tone: "success",
        };
      } else if (ended.reason === "mfa-required") {
        // Microsoft wanted MFA the sign-in did not do (#596): once more in
        // the Environment browser, where Microsoft guides the MFA step or a
        // method's setup.
        session.window?.close();
        const app = overview?.apps.find((item) => item.id === session.app);
        const name = app?.name ?? session.app;
        note =
          ended.retry === "environment-browser" && app !== undefined
            ? {
                text: fill(copy.integrationsConnectMfa, { app: name }),
                tone: "warning",
                action: {
                  label: copy.integrationsSignInInEnvironment,
                  run: () => {
                    void connect(app, session.name, session.again, true);
                  },
                },
              }
            : {
                text: fill(copy.integrationsConnectMfaHere, { app: name }),
                tone: "warning",
              };
      } else note = { text: copy.integrationsConnectEnded, tone: "warning" };
      await load(true);
      return;
    }
  }

  /** The answer of a connect: a window to open, the panel, done, refused. */
  async function started(
    app: string,
    answer: { value: unknown; ok: boolean },
    reserved: Window | null,
    retry: Pick<Session, "name" | "again"> = { name: null },
  ) {
    const copy = options.copy();
    const value = (answer.value ?? {}) as Record<string, unknown>;
    if (value.kind === "authorize" && typeof value.session === "string") {
      const session: Session = {
        id: value.session,
        app,
        window: reserved,
        ...retry,
      };
      sessions.set(session.id, session);
      if (typeof value.view === "string") {
        reserved?.close();
        options.showBrowser(value.view);
        note = { text: copy.integrationsFinishInEnvironment, tone: "info" };
      } else if (typeof value.url === "string") {
        if (reserved === null)
          note = { text: copy.integrationsPopupBlocked, tone: "danger" };
        else {
          reserved.opener = null;
          reserved.location.href = value.url;
          note = { text: copy.integrationsWaiting, tone: "info" };
        }
      }
      forming = null;
      render();
      void follow(session);
      return;
    }
    reserved?.close();
    busy = new Set([...busy].filter((id) => id !== app));
    if (value.kind === "connected") {
      forming = null;
      const name = overview?.apps.find((item) => item.id === app)?.name ?? app;
      note = {
        text: fill(copy.integrationsConnectedNow, { app: name }),
        tone: "success",
      };
      await load(true);
      return;
    }
    const reason = value.reason;
    note = refusalNote(reason, overview, copy, options.team());
    if (reason === "name-required") {
      formNeedsName = true;
      forming = app;
    } else if (reason === "composio-signed-out") void composioFirst(app);
    render();
  }

  /** "Připojit" where the page's reading asks for Composio's sign-in, or a
   * connect refused for it (decision F42, note of 2026-10-19). Composio is
   * read live first: signed in, the page reads the Integrace again and the
   * card connects, or says that Composio is off for agents; signed out, its
   * sign-in opens in Settings → Tools, as before; not read, the person stays
   * here and is told to try again. */
  async function composioFirst(id: string) {
    const said = composioSignInNote(
      await options.signInComposio(),
      options.copy(),
    );
    if (said !== null) {
      say(said.text, said.tone);
      return;
    }
    note = null;
    await load(true);
    const app = overview?.apps.find((item) => item.id === id);
    if (app?.path.path === "composio" && !app.path.signIn) form(app, false);
  }

  /** The connect form of an app's card: opened, or closed again where
   * `toggle` and it is open. */
  function form(app: IntegrationApp, toggle: boolean) {
    forming = toggle && forming === app.id ? null : app.id;
    formName = "";
    formNeedsName =
      app.accounts.some(
        (account) => !account.spare && account.state === "connected",
      ) && app.path.path === "composio";
    render();
  }

  /** Starts connecting an app the way its card says; `again` signs one of
   * its accounts in again; `inEnvironment` signs the company app in in the
   * Environment browser (#596). */
  async function connect(
    app: IntegrationApp,
    name: string | null,
    again?: IntegrationAccount,
    inEnvironment = false,
  ) {
    if (busy.has(app.id)) return;
    // Claimed in the click, before anything is awaited; closed again where
    // the server answers no address for it. The Environment browser needs
    // no window of the person's own.
    const reserved = inEnvironment
      ? null
      : window.open("about:blank", "_blank");
    busy = new Set([...busy, app.id]);
    note = null;
    render();
    try {
      const answer = await options.post("/api/integrations/connect", {
        app: app.id,
        ...(name === null ? {} : { name }),
        ...(again?.path === "direct" && again.selector !== null
          ? { account: again.selector }
          : {}),
        ...(inEnvironment ? { browser: "environment" } : {}),
      });
      await started(app.id, answer, reserved, {
        name,
        ...(again === undefined ? {} : { again }),
      });
    } catch {
      reserved?.close();
      busy = new Set([...busy].filter((id) => id !== app.id));
      say(options.copy().integrationsConnectFailed, "danger");
    }
  }

  function openConfirm(
    title: string,
    text: string,
    ok: string,
    action: NonNullable<typeof confirmAction>,
  ) {
    const copy = options.copy();
    confirmTitle.textContent = title;
    confirmText.textContent = text;
    confirmStatus.textContent = "";
    confirmOk.textContent = ok;
    confirmOk.disabled = false;
    confirmCancel.textContent = copy.integrationsCancel;
    confirmAction = action;
    confirm.showModal();
    confirmTitle.focus();
  }
  confirmOk.addEventListener("click", async () => {
    const action = confirmAction;
    if (action === null) return;
    if (action.kind === "start") {
      confirmAction = null;
      confirm.close();
      action.run();
      return;
    }
    confirmOk.disabled = true;
    const failure = await action
      .run()
      .catch(() => options.copy().integrationsDisconnectFailed);
    if (failure === null) {
      confirm.close();
      confirmAction = null;
      await load(true);
      return;
    }
    confirmStatus.textContent = failure;
    confirmOk.disabled = false;
  });
  confirmCancel.addEventListener("click", () => confirm.close());

  function disconnect(app: IntegrationApp, account: IntegrationAccount) {
    const copy = options.copy();
    const name = account.label ?? copy.integrationsAccountUnnamed;
    openConfirm(
      fill(copy.integrationsDisconnectTitle, { account: name, app: app.name }),
      disconnectText(app, account, copy),
      copy.integrationsDisconnect,
      { kind: "start", run: () => void remove(app, account) },
    );
  }

  /** "Odpojit", confirmed: the row says "Odpojuji…" from now until the
   * reading after the removal, or why it failed (decision F42, addendum (b)
   * of 2026-10-14). */
  async function remove(app: IntegrationApp, account: IntegrationAccount) {
    const copy = options.copy();
    const key = removalKey(app, account);
    if (removals.get(key)?.state === "removing") return;
    removals = removalStep(removals, key, { kind: "confirmed" });
    render();
    let failure: string | null;
    try {
      const { value } = await options.post("/api/integrations/disconnect", {
        app: app.id,
        path: account.path,
        account: account.selector,
        confirm: true,
      });
      failure = disconnectFailure(value, overview, copy, options.team());
    } catch {
      failure = copy.integrationsDisconnectFailed;
    }
    removals = removalStep(removals, key, { kind: "answered", failure });
    if (failure !== null) {
      render();
      return;
    }
    await load(true);
  }

  /** "Aktualizovat" of the line about Composio: the update of Settings →
   * Tools (`/api/tools/upgrade`, `lazurio tools update composio`), the
   * person's click being the consent; then the page reads again. */
  async function updateComposio() {
    if (updating === "updating") return;
    updating = "updating";
    note = null;
    render();
    let value: unknown = null;
    try {
      ({ value } = await options.post("/api/tools/upgrade", {
        tool: "composio",
      }));
    } catch {}
    if (!composioUpdated(value)) {
      updating = "failed";
      render();
      return;
    }
    await load(true);
    updating = "idle";
    note = {
      text: options.copy().integrationsComposioUpdated,
      tone: "success",
    };
    render();
  }

  // --- The "⋯" menu of a Composio account (#312) --------------------------
  // The tile menu's pattern (catalog-panel.ts): one menu open at a time,
  // closed by a click elsewhere, Escape or the next drawing of the page; the
  // arrow keys move through its items, and focus that leaves it closes it.

  let closeMenu: (() => void) | null = null;
  document.addEventListener("click", (event) => {
    if (closeMenu === null) return;
    const target = event.target;
    if (target instanceof Element && target.closest(".integration-menu"))
      return;
    closeMenu();
  });
  // Escape where the focus is not in the menu (its own keys handle it there).
  document.addEventListener("keydown", (event) => {
    if (
      event.key !== "Escape" ||
      closeMenu === null ||
      event.defaultPrevented ||
      event.isComposing
    )
      return;
    event.preventDefault();
    closeMenu();
  });

  function accountMenu(
    app: IntegrationApp,
    account: IntegrationAccount,
    menu: NonNullable<AccountView["menu"]>,
    disabled: boolean,
  ): HTMLElement {
    const copy = options.copy();
    const box = element("div", "tile-menu integration-menu");
    const toggle = element("button", "tile-menu-button");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", menu.label);
    toggle.append(icon("i-more"));
    toggle.disabled = disabled;
    const list = element("div", "tile-menu-list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    const items: HTMLElement[] = [];
    const close = () => {
      list.hidden = true;
      box.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      if (closeMenu === close) closeMenu = null;
    };
    // Closed by its own item or key: the focus goes back to its button (a
    // dialog the item opens returns it there).
    const done = () => {
      close();
      toggle.focus();
    };
    const open = (index: number) => {
      closeMenu?.();
      list.hidden = false;
      box.classList.add("is-open");
      toggle.setAttribute("aria-expanded", "true");
      closeMenu = close;
      items[index]?.focus();
    };
    // The app's page in the person's Composio organization, in a new tab of
    // their browser: Composio's own place to see and change the account.
    const manage = element("a", "tile-menu-item");
    manage.href = menu.manage;
    manage.target = "_blank";
    manage.rel = "noopener noreferrer";
    manage.setAttribute("role", "menuitem");
    manage.append(
      icon("i-external"),
      element("span", "", copy.integrationsManageInComposio),
    );
    manage.addEventListener("click", done);
    items.push(manage);
    if (menu.disconnect) {
      const remove = element("button", "tile-menu-item danger");
      remove.type = "button";
      remove.setAttribute("role", "menuitem");
      remove.append(
        icon("i-x"),
        element("span", "", copy.integrationsDisconnect),
      );
      remove.addEventListener("click", () => {
        done();
        disconnect(app, account);
      });
      items.push(remove);
    }
    // The arrows move between the items; Tab leaves the menu (WAI-ARIA's
    // menu button).
    for (const item of items) item.tabIndex = -1;
    list.append(...items);
    const last = items.length - 1;
    toggle.addEventListener("click", () => {
      if (list.hidden) open(0);
      else close();
    });
    box.addEventListener("keydown", (event) => {
      const down = event.key === "ArrowDown";
      if (list.hidden) {
        // The menu button's keys: the arrows open it at either end.
        if (event.target === toggle && (down || event.key === "ArrowUp")) {
          event.preventDefault();
          open(down ? 0 : last);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        done();
        return;
      }
      // Tab moves on from the menu, which closes once the focus is there.
      if (event.key === "Tab") {
        setTimeout(close);
        return;
      }
      // Space chooses an item as Enter does, the link too.
      if (event.key === " " && document.activeElement === manage) {
        event.preventDefault();
        manage.click();
        return;
      }
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = down
        ? at < 0 || at === last
          ? 0
          : at + 1
        : event.key === "ArrowUp"
          ? at <= 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
      if (next === null) return;
      event.preventDefault();
      items[next]?.focus();
    });
    // Focus moved elsewhere closes it too; a click elsewhere has no next
    // focus here (Safari focuses no button it clicks) and closes it above.
    box.addEventListener("focusout", (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !box.contains(next)) close();
    });
    box.append(toggle, list);
    return box;
  }

  async function askAdmin(app: IntegrationApp, line: string) {
    const copy = options.copy();
    try {
      await navigator.clipboard.writeText(
        fill(copy.integrationsAskAdminText, { app: app.name, line }),
      );
      say(copy.integrationsAskAdminCopied, "success");
    } catch {
      say(fill(copy.integrationsAskAdminText, { app: app.name, line }), "info");
    }
  }

  function act(app: IntegrationApp, action: CardAction, line: string) {
    if (action.kind === "connect") {
      if (app.path.path === "composio" && app.path.signIn) {
        void composioFirst(app.id);
        return;
      }
      form(app, true);
      return;
    }
    if (action.kind === "open-tools") options.navigate(settingsPath("tools"));
    else if (action.kind === "ask-admin") void askAdmin(app, line);
    else if (action.kind === "set-up" || action.kind === "allow") {
      const target = options.dashboard();
      if (target !== null) window.open(target, "_blank", "noopener,noreferrer");
    }
  }

  function connectForm(
    app: IntegrationApp,
    composio: boolean,
  ): HTMLFormElement {
    const copy = options.copy();
    const form = element("form", "integration-form");
    if (composio) {
      const noteLine = element(
        "p",
        "integration-form-note",
        copy.integrationsComposioNote,
      );
      const link = element("a", "", ` ${copy.integrationsHelp}`);
      link.href = integrationsHelp(options.locale());
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      noteLine.append(link);
      form.append(noteLine);
    }
    const label = element("label", "integration-form-field");
    const caption = element(
      "span",
      "sr-only",
      formNeedsName
        ? copy.integrationsAccountNameRequired
        : copy.integrationsAccountName,
    );
    const input = element("input");
    input.maxLength = 64;
    input.required = formNeedsName;
    input.value = formName;
    input.placeholder = formNeedsName
      ? copy.integrationsAccountNameRequired
      : copy.integrationsAccountName;
    input.addEventListener("input", () => {
      formName = input.value;
    });
    label.append(caption, input);
    const submit = element("button", "primary", copy.integrationsContinue);
    submit.type = "submit";
    const cancel = button(copy.integrationsCancel, "ghost", () => {
      forming = null;
      render();
    });
    form.append(label, submit, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = formName.trim();
      void connect(app, name === "" ? null : name);
    });
    queueMicrotask(() => input.focus());
    return form;
  }

  function card(app: IntegrationApp): HTMLElement {
    const copy = options.copy();
    const scope = overview?.scope ?? "personal";
    const view = cardView(app, catalogOf(app.id), {
      locale: options.locale(),
      scope,
      admin,
      dashboard: options.dashboard() !== null,
      copy,
      composioOff: overview?.sources.composio === "off",
    });
    const article = element("article", "integration-card");
    article.id = `integration-${app.id}`;
    if (focus === app.id) article.classList.add("is-focused");
    const top = element("div", "integration-top");
    const text = element("div", "integration-text");
    // Cut to one line and two, each whole on hover.
    const name = element("h3", "integration-name", app.name);
    name.title = app.name;
    const line = element("p", "integration-line", view.line);
    line.title = view.line;
    text.append(name, line);
    top.append(mark(app), text);
    article.append(top);
    if (forming === app.id && view.action.kind === "connect")
      article.append(connectForm(app, view.composio));
    const foot = element("div", "integration-foot");
    // Not verified now: said as such, never as not connected (decision F42,
    // addendum of 2026-10-27); not the connected state the guide points at.
    if (view.connected === null) {
      const state = element("span", "integration-unknown");
      state.append(
        icon("i-info"),
        element("span", "", copy.integrationsUnknown),
      );
      foot.append(state);
    } else if (view.connected) {
      const state = element("span", "integration-state");
      state.append(
        icon("i-check"),
        element("span", "", copy.integrationsConnected),
      );
      if (view.pathLabel !== null) {
        const label = element("span", "integration-path");
        if (app.path.path === "direct") label.append(icon("i-lock"));
        label.append(element("span", "", view.pathLabel));
        state.append(label);
      }
      foot.append(state);
      // The Admin's sentence stands alone in the foot, from its left edge.
    } else if (view.action.kind !== "where") foot.append(element("span"));
    if (view.action.kind === "where")
      foot.append(element("p", "integration-where", view.action.text));
    else if (view.action.kind !== "none" && forming !== app.id) {
      const action = view.action;
      const node = button(action.label, "integration-action", () =>
        act(app, action, view.line),
      );
      node.dataset.action = action.kind;
      node.disabled = busy.has(app.id);
      foot.append(node);
    }
    article.append(foot);
    if (app.accounts.length > 0) {
      const list = element("ul", "integration-accounts");
      for (const account of app.accounts) {
        const shown = accountView(
          app,
          account,
          copy,
          overview?.composio.disconnect === true,
          removals.get(removalKey(app, account)),
        );
        const row = element("li", "integration-account");
        row.dataset.state = account.spare ? "spare" : account.state;
        // Being disconnected: dimmed, with a spinner before "Odpojuji…".
        if (shown.busy) row.setAttribute("aria-busy", "true");
        const words = element("div", "integration-account-text");
        // Cut to one line, whole on hover and while its buttons have the
        // focus; a screen reader reads it whole.
        const name = element("span", "integration-account-name", shown.name);
        name.title = shown.name;
        words.append(name);
        if (shown.line !== null) {
          const line = element("span", "integration-account-line");
          if (shown.busy) line.append(element("span", "spinner"));
          if (shown.failed) line.dataset.kind = "error";
          line.append(shown.line);
          words.append(line);
        }
        row.append(words);
        const actions = element("div", "integration-account-actions");
        if (shown.retry !== null)
          actions.append(
            button(
              shown.retry,
              "link-button",
              () => void connect(app, account.label, account),
            ),
          );
        if (shown.disconnect) {
          const remove = button(
            copy.integrationsDisconnect,
            "link-button danger",
            () => disconnect(app, account),
          );
          remove.disabled = shown.busy;
          actions.append(remove);
        }
        if (shown.menu !== null)
          actions.append(accountMenu(app, account, shown.menu, shown.busy));
        row.append(actions);
        list.append(row);
      }
      article.append(list);
    }
    return article;
  }

  /** Composio's Apps opened from this page: their return reads again. */
  const toComposio = () => {
    trip = composioTrip(trip, "opened").trip;
  };

  /** "Aplikaci tu nenajdete? Připojte ji v Composiu ↗", where Composio's
   * accounts count here; a span inside the empty line, else a line. */
  function composioHint(tag: "p" | "span"): HTMLElement | null {
    const apps = overview?.composio.apps ?? null;
    if (apps === null) return null;
    const copy = options.copy();
    const hint = element(tag, "integrations-hint");
    const link = element("a", "", copy.integrationsComposioConnectThere);
    link.href = apps;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.append(icon("i-external"));
    link.addEventListener("click", toComposio);
    hint.append(`${copy.integrationsComposioMissing} `, link);
    return hint;
  }

  function appsSection(tab: "all" | "connected"): HTMLElement[] {
    const copy = options.copy();
    if (overview === null) return [];
    const query = search.value;
    // The app a card link names stays listed while the link is open.
    const apps = visibleApps(
      overview,
      // Its words find the Microsoft 365 card: Outlook, OneDrive,
      // SharePoint, Microsoft.
      [...integrationsCatalog.apps, microsoft365Card],
      tab,
      query,
      route?.app ?? null,
    );
    const searching = query.trim() !== "";
    const capped =
      tab === "all" && !searching && !showAll && apps.length > appsPreview;
    const shown = capped ? apps.slice(0, appsPreview) : apps;
    const head = element(
      "p",
      "integrations-section-head",
      tab === "connected"
        ? copy.integrationsYours
        : searching
          ? copy.integrationsResults
          : fill(copy.integrationsAvailable, { count: String(apps.length) }),
    );
    const section = element("section", "integrations-section");
    section.setAttribute("aria-label", head.textContent ?? "");
    const nodes: HTMLElement[] = [head];
    if (shown.length === 0) {
      const empty = element(
        "p",
        "empty",
        tab === "connected" && !searching
          ? noneConnectedText(overview, copy)
          : copy.integrationsNoneFound,
      );
      if (tab === "connected" && !searching) {
        const pick = element("a", "button", copy.integrationsPick);
        pick.href = integrationsPath("all");
        pick.dataset.route = "";
        empty.append(" ", pick);
      }
      const hint = tab === "all" ? composioHint("span") : null;
      if (hint !== null) empty.append(hint);
      nodes.push(empty);
      section.append(...nodes);
      return [section];
    }
    const grid = element("div", "integration-grid");
    grid.append(...shown.map(card));
    // What the guide points at (decision F56's addendum of 2026-10-18): the
    // first connected app, and the first Connect of one that is not.
    grid
      .querySelector(".integration-state")
      ?.closest(".integration-card")
      ?.setAttribute("data-guide", "integration-on");
    grid
      .querySelector('.integration-action[data-action="connect"]')
      ?.setAttribute("data-guide", "integration-connect");
    nodes.push(grid);
    if (capped)
      nodes.push(
        button(
          fill(copy.integrationsShowAll, { count: String(apps.length) }),
          "integrations-more",
          () => {
            showAll = true;
            render();
          },
        ),
      );
    const hint = tab === "all" ? composioHint("p") : null;
    if (hint !== null) nodes.push(hint);
    section.append(...nodes);
    return [section];
  }

  function customSection(): HTMLElement[] {
    const copy = options.copy();
    const servers: readonly CustomServer[] = overview?.custom ?? [];
    const head = element("div", "integrations-custom-head");
    const title = element("h2", "", copy.integrationsMcpTitle);
    title.id = "integrations-mcp-title";
    head.append(title);
    const unavailable = overview?.sources.executor !== "ok";
    // The guide points at the way to add one and at the list (decision
    // F56's addendum of 2026-10-18).
    if (unavailable) {
      const add = button(copy.integrationsMcpAdd, "primary", () => {});
      add.prepend(icon("i-plus"));
      add.disabled = true;
      add.dataset.guide = "mcp-add";
      head.append(add);
    } else {
      const add = routeLink(customServerPath(null), "button primary");
      add.append(icon("i-plus"), copy.integrationsMcpAdd);
      add.dataset.guide = "mcp-add";
      head.append(add);
    }
    // Where Executor is not running, the notice above says so once; the
    // list says only what it holds.
    const nodes: HTMLElement[] = [head];
    if (servers.length === 0) {
      const empty = element("p", "empty", copy.integrationsMcpNone);
      empty.dataset.guide = "mcp-list";
      nodes.push(empty);
    }
    if (servers.length > 0) {
      const list = element("ul", "card integration-servers");
      list.dataset.guide = "mcp-list";
      for (const server of servers) {
        const row = element("li", "row integration-server");
        row.dataset.state = server.state;
        const main = element("div", "row-main");
        const words = element("div", "row-copy");
        const title = element("p", "row-title");
        // The name opens the server's page, the same form filled in.
        const open = routeLink(customServerPath(server.id), "", server.name);
        title.append(
          icon(server.kind === "remote" ? "i-globe" : "i-terminal"),
          open,
        );
        words.append(
          title,
          element(
            "p",
            "row-desc",
            server.kind === "remote"
              ? (server.target ?? "")
              : copy.integrationsMcpWhereCommand,
          ),
          element("p", "row-status", serverLine(server, copy)),
        );
        const controls = element("div", "row-control");
        controls.append(
          routeLink(
            customServerPath(server.id),
            "link-button",
            copy.integrationsMcpEdit,
          ),
          button(copy.integrationsMcpRemove, "link-button danger", () =>
            openConfirm(
              fill(copy.integrationsMcpRemoveTitle, { name: server.name }),
              copy.integrationsMcpRemoveText,
              copy.integrationsMcpRemove,
              {
                kind: "wait",
                run: async () => {
                  const { value } = await options.post(
                    "/api/integrations/custom/remove",
                    { id: server.id, confirm: true },
                  );
                  return (value as { kind?: unknown } | null)?.kind ===
                    "removed"
                    ? null
                    : copy.integrationsDisconnectFailed;
                },
              },
            ),
          ),
        );
        main.append(words, controls);
        row.append(main);
        list.append(row);
      }
      nodes.push(list);
    }
    const section = element("section", "integrations-section");
    section.setAttribute("aria-labelledby", "integrations-mcp-title");
    section.append(...nodes);
    return [section];
  }

  // --- The page of a custom MCP server (F42's addendum of 2026-10-11) -----
  // Codex Desktop's "Connect to a custom MCP" in the Lazurio look, below
  // the tabs as Codex shows it below its own: back, the title and its docs,
  // the card of the name and the type, the card of the type's fields, Save.
  // It lives in a holder of its own beside the page's body, so a reading of
  // the Integrace never draws it again under the person's hands: typing
  // only updates its lines and Save; adding or removing a row, or another
  // type, draws it anew with the focus where the person is.

  /** Draws the page anew; `focus` names the field to focus after it. */
  function drawCustom(focus?: string) {
    speak();
    const copy = options.copy();
    const page = custom;
    fields.clear();
    if (page === null) {
      formHost.replaceChildren();
      return;
    }
    const back = routeLink(integrationsPath("custom"), "back");
    back.append(icon("i-chevron-left"), copy.integrationsMcpBack);
    const head = element("div", "mcp-head");
    const title = element(
      "h2",
      "mcp-title",
      page.server === null
        ? copy.integrationsMcpPageTitle
        : copy.integrationsMcpEditTitle,
    );
    const docs = element("a", "mcp-docs", copy.integrationsMcpDocs);
    docs.href = integrationsHelp(options.locale());
    docs.target = "_blank";
    docs.rel = "noopener noreferrer";
    docs.append(icon("i-external"));
    head.append(title, docs);
    if (page.form === null) {
      formHost.replaceChildren(
        back,
        head,
        element(
          "p",
          "row-status",
          page.failed
            ? copy.integrationsMcpLoadFailed
            : copy.integrationsMcpLoading,
        ),
      );
      return;
    }
    const form = page.form;
    const node = element("form", "mcp-form");
    node.noValidate = true;
    const top = element("div", "card mcp-card");
    top.append(
      textSection("name", copy.integrationsMcpName, form.name, {
        placeholder: copy.integrationsMcpNamePlaceholder,
        maxLength: 64,
      }),
      typeRow(form),
    );
    const body = element("div", "card mcp-card");
    if (form.type === "stdio")
      body.append(
        textSection(
          "command",
          copy.integrationsMcpCommand,
          form.stdio.command,
          {
            placeholder: "npx",
          },
        ),
        argsSection(form),
        keysSection(form, "env"),
        textSection("cwd", copy.integrationsMcpCwd, form.stdio.cwd, {
          placeholder: "~/code",
        }),
      );
    else
      body.append(
        textSection("url", copy.integrationsMcpUrl, form.http.url, {
          placeholder: "https://mcp.example.com/mcp",
          type: "url",
        }),
        bearerSection(form),
        keysSection(form, "headers"),
      );
    const foot = element("div", "mcp-foot");
    const note = element("div", "mcp-foot-text");
    // Its line is said through the page's one live region (`speak`).
    const status = element("p", "mcp-status");
    note.append(status);
    const save = element(
      "button",
      "primary mcp-save",
      copy.integrationsMcpSave,
    );
    save.type = "submit";
    foot.append(note, save);
    fields.set("status", status);
    fields.set("save", save);
    node.append(top, body, foot);
    node.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCustom();
    });
    formHost.replaceChildren(back, head, node);
    refreshCustom();
    if (focus !== undefined)
      formHost.querySelector<HTMLElement>(`[data-field="${focus}"]`)?.focus();
  }

  /** A section of one field: its label, the input and the line under it. */
  function textSection(
    field: FieldName,
    label: string,
    value: string,
    attributes: Partial<HTMLInputElement>,
  ): HTMLElement {
    const section = element("div", "mcp-section");
    const id = `mcp-${field}`;
    const caption = element("label", "mcp-label", label);
    caption.htmlFor = id;
    const input = textInput(id, field, value, attributes, (next) => {
      update(withField(custom?.form as CustomForm, field, next));
    });
    section.append(caption, input, line(field, input));
    return section;
  }

  function textInput(
    id: string,
    field: string,
    value: string,
    attributes: Partial<HTMLInputElement>,
    change: (value: string) => void,
  ): HTMLInputElement {
    const input = element("input", "mcp-input");
    Object.assign(input, attributes);
    input.id = id;
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.field = field;
    input.addEventListener("input", () => change(input.value));
    fields.set(`input:${field}`, input);
    return input;
  }

  /** The line under a field, filled by refreshCustom. */
  function line(key: string, input: HTMLInputElement): HTMLElement {
    const node = element("p", "mcp-line");
    node.id = `mcp-line-${key}`;
    node.hidden = true;
    input.setAttribute("aria-describedby", node.id);
    fields.set(key, node);
    return node;
  }

  /** Name's card, second row: the type as Codex's segmented control. */
  function typeRow(form: CustomForm): HTMLElement {
    const copy = options.copy();
    const row = element("div", "mcp-type");
    const label = element("span", "mcp-label", copy.integrationsMcpType);
    label.id = "mcp-type-label";
    const group = element("div", "mcp-segments");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-labelledby", label.id);
    const fixed = form.id !== null;
    if (fixed) group.title = copy.integrationsMcpTypeFixed;
    const types = [
      ["stdio", "STDIO"],
      ["http", "Streamable HTTP"],
    ] as const;
    for (const [type, text] of types) {
      const option = element("button", "mcp-segment", text);
      option.type = "button";
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(form.type === type));
      option.tabIndex = form.type === type ? 0 : -1;
      option.dataset.field = `type-${type}`;
      if (fixed && form.type !== type) option.disabled = true;
      option.addEventListener("click", () => switchType(type));
      option.addEventListener("keydown", (event) => {
        if (fixed) return;
        if (
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        switchType(form.type === "stdio" ? "http" : "stdio");
      });
      group.append(option);
    }
    row.append(label, group);
    return row;
  }

  function switchType(type: "stdio" | "http") {
    const form = custom?.form;
    if (form === null || form === undefined || form.type === type) return;
    custom = { ...(custom as CustomPage), form: withType(form, type) };
    drawCustom(`type-${type}`);
  }

  /** The "+ Přidat …" under a list: a full-width quiet button. */
  function addButton(label: string, list: RowList, focus: () => string) {
    const add = element("button", "mcp-add");
    add.type = "button";
    add.dataset.field = `add-${list}`;
    add.append(icon("i-plus"), label);
    add.addEventListener("click", () => {
      const form = custom?.form;
      if (form === null || form === undefined) return;
      custom = { ...(custom as CustomPage), form: addRow(form, list) };
      drawCustom(focus());
    });
    return add;
  }

  function trash(label: string, remove: () => void) {
    const node = element("button", "mcp-remove");
    node.type = "button";
    node.setAttribute("aria-label", label);
    node.title = label;
    node.append(icon("i-trash"));
    node.addEventListener("click", remove);
    return node;
  }

  /** After a row went: focus the row now at its place, the one before it,
   * or the list's "+ Přidat". */
  function afterRemove(list: RowList, index: number, count: number): string {
    if (count === 0) return `add-${list}`;
    const at = Math.min(index, count - 1);
    return list === "args" ? `args-${at}` : `${list}-${at}-name`;
  }

  function argsSection(form: CustomForm): HTMLElement {
    const copy = options.copy();
    const section = element("div", "mcp-section");
    section.append(element("p", "mcp-label", copy.integrationsMcpArgs));
    const rows = element("div", "mcp-rows");
    form.stdio.args.forEach((arg, index) => {
      const row = element("div", "mcp-row");
      const input = textInput(
        `mcp-args-${index}`,
        `args-${index}`,
        arg,
        {},
        (next) => update(withArg(custom?.form as CustomForm, index, next)),
      );
      input.setAttribute(
        "aria-label",
        `${copy.integrationsMcpArgs} ${index + 1}`,
      );
      row.append(
        input,
        trash(copy.integrationsMcpRemoveArg, () => {
          const next = removeRow(custom?.form as CustomForm, "args", index);
          custom = { ...(custom as CustomPage), form: next };
          drawCustom(afterRemove("args", index, next.stdio.args.length));
        }),
      );
      rows.append(row, line(`args-${index}`, input));
    });
    section.append(
      rows,
      addButton(copy.integrationsMcpAddArg, "args", () => {
        const count = custom?.form?.stdio.args.length ?? 1;
        return `args-${count - 1}`;
      }),
    );
    return section;
  }

  function keysSection(form: CustomForm, list: KeyList): HTMLElement {
    const copy = options.copy();
    const section = element("div", "mcp-section");
    section.append(
      element(
        "p",
        "mcp-label",
        list === "env" ? copy.integrationsMcpEnv : copy.integrationsMcpHeaders,
      ),
    );
    const rows = element("div", "mcp-rows");
    const own = list === "env" ? form.stdio.env : form.http.headers;
    own.forEach((row, index) => {
      const node = element("div", "mcp-row mcp-row-pair");
      const name = textInput(
        `mcp-${list}-${index}-name`,
        `${list}-${index}-name`,
        row.name,
        { placeholder: copy.integrationsMcpKey },
        (next) =>
          update(
            withKey(custom?.form as CustomForm, list, index, "name", next),
          ),
      );
      name.setAttribute(
        "aria-label",
        `${list === "env" ? copy.integrationsMcpEnv : copy.integrationsMcpHeaders} ${index + 1}: ${copy.integrationsMcpKey}`,
      );
      const value = textInput(
        `mcp-${list}-${index}-value`,
        `${list}-${index}-value`,
        row.value,
        { placeholder: copy.integrationsMcpValue },
        (next) =>
          update(
            withKey(custom?.form as CustomForm, list, index, "value", next),
          ),
      );
      value.setAttribute(
        "aria-label",
        `${list === "env" ? copy.integrationsMcpEnv : copy.integrationsMcpHeaders} ${index + 1}: ${copy.integrationsMcpValue}`,
      );
      node.append(
        name,
        value,
        trash(
          list === "env"
            ? copy.integrationsMcpRemoveEnv
            : copy.integrationsMcpRemoveHeader,
          () => {
            const next = removeRow(custom?.form as CustomForm, list, index);
            custom = { ...(custom as CustomPage), form: next };
            drawCustom(
              afterRemove(
                list,
                index,
                list === "env"
                  ? next.stdio.env.length
                  : next.http.headers.length,
              ),
            );
          },
        ),
      );
      rows.append(node);
      const lines = element("div", "mcp-row mcp-row-pair mcp-row-lines");
      lines.append(
        line(`${list}-${index}-name`, name),
        line(`${list}-${index}-value`, value),
      );
      rows.append(lines);
    });
    section.append(
      rows,
      addButton(
        list === "env"
          ? copy.integrationsMcpAddEnv
          : copy.integrationsMcpAddHeader,
        list,
        () => {
          const count =
            list === "env"
              ? (custom?.form?.stdio.env.length ?? 1)
              : (custom?.form?.http.headers.length ?? 1);
          return `${list}-${count - 1}-name`;
        },
      ),
    );
    return section;
  }

  function bearerSection(form: CustomForm): HTMLElement {
    const copy = options.copy();
    const section = element("div", "mcp-section");
    const caption = element("label", "mcp-label", copy.integrationsMcpBearer);
    caption.htmlFor = "mcp-bearer";
    // The token is typed into a masked field and sent once; never kept.
    const input = textInput(
      "mcp-bearer",
      "bearer",
      form.http.bearer,
      { type: "password" },
      (next) => update(withField(custom?.form as CustomForm, "bearer", next)),
    );
    input.autocomplete = "new-password";
    if (form.http.bearerStored) {
      const row = element("div", "mcp-row");
      row.append(
        input,
        trash(copy.integrationsMcpRemoveBearer, () => {
          custom = {
            ...(custom as CustomPage),
            form: withoutStoredBearer(custom?.form as CustomForm),
          };
          drawCustom("bearer");
        }),
      );
      section.append(caption, row, line("bearer", input));
    } else section.append(caption, input, line("bearer", input));
    return section;
  }

  function update(form: CustomForm) {
    if (custom === null) return;
    custom = { ...custom, form, status: "" };
    refreshCustom();
  }

  /** The lines, the key fields' placeholders and Save, from the form. */
  function refreshCustom() {
    const page = custom;
    if (page === null || page.form === null) return;
    const copy = options.copy();
    const view = customFormView(page.form, copy);
    const show = (key: string, value: FieldLine | null) => {
      const node = fields.get(key);
      if (node === undefined) return;
      node.hidden = value === null;
      node.textContent = value?.text ?? "";
      node.dataset.kind = value?.kind ?? "";
      const input = fields.get(`input:${key}`);
      if (input !== undefined) {
        if (value?.kind === "error") input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      }
    };
    for (const field of ["name", "command", "cwd", "url", "bearer"] as const)
      show(field, view[field]);
    view.args.forEach((value, index) => {
      show(`args-${index}`, value);
    });
    for (const list of ["env", "headers"] as const)
      view[list].forEach((key, index) => {
        show(`${list}-${index}-name`, key.name);
        show(`${list}-${index}-value`, key.value);
        const input = fields.get(`input:${list}-${index}-value`);
        if (input instanceof HTMLInputElement)
          input.placeholder = key.placeholder;
      });
    const bearer = fields.get("input:bearer");
    if (bearer instanceof HTMLInputElement)
      bearer.placeholder = view.bearerPlaceholder;
    const status = fields.get("status");
    if (status !== undefined) {
      status.hidden = page.status === "";
      status.textContent = page.status;
    }
    const save = fields.get("save");
    if (save instanceof HTMLButtonElement) {
      save.disabled = !view.canSave || page.saving;
      save.textContent = page.saving
        ? copy.integrationsMcpSaving
        : copy.integrationsMcpSave;
    }
    speak();
  }

  /** Opens the page of a route: a new server's form, or reads a server's
   * settings into it. The same page shown again keeps its form. */
  function openCustom(server: string | null) {
    if (custom !== null && custom.server === server) {
      drawCustom();
      return;
    }
    note = null;
    const page: CustomPage = {
      server,
      form: server === null ? newCustomForm() : null,
      failed: false,
      saving: false,
      status: "",
    };
    custom = page;
    drawCustom(server === null ? "name" : undefined);
    if (server === null) return;
    void (async () => {
      let settings: ReturnType<typeof parseCustomSettings> = null;
      try {
        const { value, ok } = await options.get(
          `/api/integrations/custom/server?id=${encodeURIComponent(server)}`,
        );
        settings = ok ? parseCustomSettings(value) : null;
      } catch {
        settings = null;
      }
      if (custom !== page) return;
      custom =
        settings === null
          ? { ...page, failed: true }
          : { ...page, form: editCustomForm(settings) };
      drawCustom(settings === null ? undefined : "name");
    })();
  }

  async function saveCustom() {
    const page = custom;
    if (page === null || page.form === null || page.saving) return;
    const copy = options.copy();
    const form = page.form;
    if (!customFormView(form, copy).canSave) return;
    const input = customInput(form);
    // A remote server without keys may need a sign-in in a window of this
    // browser: claimed in the click, before anything is awaited.
    const reserved =
      input.type === "http" &&
      input.bearer === null &&
      input.headers.length === 0
        ? window.open("about:blank", "_blank")
        : null;
    custom = { ...page, saving: true, status: "" };
    refreshCustom();
    try {
      const answer = await options.post(
        form.id === null
          ? "/api/integrations/custom/add"
          : "/api/integrations/custom/update",
        customBody(form),
      );
      const value = (answer.value ?? {}) as Record<string, unknown>;
      if (custom !== page && custom?.server !== page.server) {
        reserved?.close();
        return;
      }
      if (value.kind === "connected" || value.kind === "saved") {
        reserved?.close();
        custom = null;
        note = { text: customSaved(form, copy), tone: "success" };
        options.navigate(integrationsPath("custom"));
        await load(true);
        return;
      }
      if (value.kind === "authorize") {
        custom = null;
        options.navigate(integrationsPath("custom"));
        await started(
          typeof value.app === "string" ? value.app : form.name.trim(),
          answer,
          reserved,
        );
        return;
      }
      reserved?.close();
      custom = {
        ...(custom as CustomPage),
        saving: false,
        status: customRefusal(value.reason ?? value.error, copy),
      };
    } catch {
      reserved?.close();
      if (custom !== null)
        custom = {
          ...custom,
          saving: false,
          status: copy.integrationsMcpSaveFailed,
        };
    }
    refreshCustom();
  }

  /** The page's one live region (`#integrations-live`), mounted before
   * anything changes: its text is written only when the page has something
   * new to say, so drawing the page again says nothing again. */
  function speak() {
    const said = liveAnnouncement(
      {
        read: overview !== null,
        loading,
        failed: failed && custom === null,
        note,
        update: updating,
        form:
          custom === null
            ? ""
            : custom.failed
              ? options.copy().integrationsMcpLoadFailed
              : custom.status,
      },
      options.copy(),
    );
    const next = liveText(live.textContent ?? "", said);
    if (next !== null) live.textContent = next;
  }

  function render() {
    const copy = options.copy();
    // The page is drawn anew: an open account menu goes with it.
    closeMenu = null;
    if (active()) navLink.setAttribute("aria-current", "page");
    else navLink.removeAttribute("aria-current");
    if (route === null) return;
    const labels = tabLabels(overview, copy);
    for (const link of tabs) {
      const tab = link.dataset.tab as IntegrationsTab;
      link.textContent = labels[tab];
      if (tab === route.tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    refreshButton.disabled = loading;
    refreshButton.classList.toggle("is-spinning", loading);
    // Only a link the server built, to Composio's dashboard (parsed).
    const apps = overview?.composio.apps ?? null;
    composioApps.hidden = apps === null;
    if (apps === null) composioApps.removeAttribute("href");
    else composioApps.href = apps;
    speak();
    // Every notice of the page is one callout of its tone, the page's
    // width, one under another (Matěj 2026-10-14): the line about the last
    // action first, then what the reading says. None of them is a live
    // region: `speak` says what changed.
    alert.hidden = note === null;
    alert.dataset.kind = note?.tone ?? "info";
    const action = note?.action;
    alert.replaceChildren(
      ...(note === null
        ? []
        : noticeParts(
            note.tone,
            note.text,
            action === undefined
              ? []
              : [
                  button(action.label, "", () => {
                    note = null;
                    action.run();
                  }),
                ],
          )),
    );
    const problems: HTMLElement[] = [];
    // A reading that failed says so, with its retry, above the last one it
    // shows: a row waiting for "Odpojit" waits for a reading that succeeds.
    if (failed && !loading && custom === null)
      problems.push(
        notice("danger", copy.integrationsLoadFailed, [
          button(copy.integrationsRetry, "", () => {
            note = null;
            void load(true);
          }),
        ]),
      );
    status.textContent =
      overview === null
        ? custom === null && !failed
          ? copy.integrationsLoading
          : ""
        : loading && route.tab === "connected"
          ? copy.integrationsChecking
          : "";
    if (overview === null) {
      problemsHost.replaceChildren(...problems);
      notices.hidden = alert.hidden && problems.length === 0;
      formHost.hidden = custom === null;
      body.replaceChildren();
      return;
    }
    for (const line of sourceLines(overview, copy))
      problems.push(notice("warning", line));
    // Composio in no organization of this Environment's Organization's
    // name: what to do in Composio (decision F42, addendum of 2026-10-13;
    // the figure that explained the model is gone since its note of
    // 2026-10-17, the explanation is in the documentation).
    const organizationLine = composioOrganizationLine(
      overview,
      copy,
      options.team(),
    );
    if (organizationLine !== null && overview.composio.organization !== null) {
      const open = element("a", "button", copy.integrationsComposioOpen);
      open.href = composioDashboard;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      problems.push(notice("warning", organizationLine, [open]));
    }
    // Composio not the build Lazurio pins: one line and its update, above
    // the apps (decision F42, addendum (b) of 2026-10-14).
    const update =
      custom === null && route.tab !== "custom"
        ? composioUpdateLine(overview, updating, copy)
        : null;
    if (update !== null) {
      const run = button(update.action, "primary", () => void updateComposio());
      run.disabled = update.busy;
      // While it runs, the spinner stands where the icon was.
      const box = notice(
        updating === "failed" ? "danger" : "info",
        update.text,
        [run],
        {
          icon: update.busy ? element("span", "spinner") : icon("i-download"),
        },
      );
      box.classList.add("integrations-update");
      problems.push(box);
    }
    problemsHost.replaceChildren(...problems);
    notices.hidden = alert.hidden && problems.length === 0;
    formHost.hidden = custom === null;
    body.replaceChildren(
      ...(custom !== null
        ? []
        : route.tab === "custom"
          ? customSection()
          : appsSection(route.tab)),
    );
    if (focus !== null) {
      const target = document.getElementById(`integration-${focus}`);
      if (target !== null) {
        target.scrollIntoView({ block: "center" });
        focus = null;
      }
    }
    options.drawn?.();
  }

  function relabel() {
    const copy = options.copy();
    // Below 768 px the corner's links show only their icons.
    composioApps.title = copy.integrationsComposioApps;
    search.placeholder = copy.integrationsSearch;
    refreshButton.title = copy.integrationsRefresh;
    if (custom !== null) drawCustom();
    render();
  }

  search.addEventListener("input", () => render());
  composioApps.addEventListener("click", toComposio);
  // Back from Composio's Apps: the Integrace read again, once, while shown.
  const step = (event: "left" | "back") => {
    const next = composioTrip(trip, event);
    trip = next.trip;
    if (next.refresh && active()) {
      note = null;
      void load(true);
    }
  };
  document.addEventListener("visibilitychange", () => {
    step(document.visibilityState === "hidden" ? "left" : "back");
    // Back from Composio's tab: the organization read at once.
    waitForComposio(!document.hidden);
  });
  window.addEventListener("blur", () => step("left"));
  window.addEventListener("focus", () => step("back"));
  refreshButton.addEventListener("click", () => {
    note = null;
    void load(true);
  });

  return {
    /** Shows the route: reads the Integrace on the first visit; an app's
     * card link opens its card with its form. */
    show(next: PageRoute) {
      if (next.view !== "integrations") {
        route = null;
        custom = null;
        drawCustom();
        render();
        waitForComposio();
        return;
      }
      const first = route === null && overview === null;
      const again = route === null && overview !== null;
      route = {
        tab: next.tab,
        ...(next.app === undefined ? {} : { app: next.app }),
      };
      if (next.form !== undefined) openCustom(next.form.server);
      else if (custom !== null) {
        custom = null;
        drawCustom();
      }
      if (next.app !== undefined) {
        search.value = "";
        showAll = true;
        focus = next.app;
        deepLink = next.app;
        if (overview !== null) openLinked(next.app);
      }
      if (first) queueMicrotask(() => void load());
      else {
        render();
        // Shown again while it waits: the organization read at once.
        if (again) waitForComposio(true);
      }
    },
    relabel,
    /** Reads again: after a tool's sign-in, or on request. */
    refresh: () => load(true),
    /** Whether Composio is allowed here, as the page last read it; null
     * until read. */
    composio: (): boolean | null => overview?.composio.allowed ?? null,
    /** The tools were read (Settings → Tools): where a tool was installed,
     * or switched on or off for agents, since the last reading, the
     * Integrace are read again (decision F42, note of 2026-10-19). After a
     * sign-in, Composio's "Používají agenti" goes on only after the reading
     * the sign-in caused, which the sign-in's own re-read came before. */
    toolsRead(tools: Parameters<typeof toolStatesKey>[0]) {
      const states = toolStatesKey(tools);
      if (toolStates !== null && toolStates !== states) void load(true);
      toolStates = states;
    },
  };
}
