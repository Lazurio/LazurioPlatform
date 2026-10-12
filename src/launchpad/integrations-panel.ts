import { integrationsCatalog } from "../integrations/catalog";
import type { CatalogApp } from "../integrations/catalog-schema";
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
  cardView,
  disconnectText,
  integrationsHelp,
  monogram,
  parseIntegrations,
  serverLine,
  sourceLines,
  tabLabels,
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
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Apps → Integrace (decision F42): the page's DOM over integrations-view.ts.
// The server drives Executor and Composio; this page only opens what the
// person signs in to: a window of their own browser for Composio and, on
// their computer, for a direct sign-in (claimed in the click, so no pop-up
// blocker stops it), or the Environment browser's view in the right panel on
// a Remote Environment, where Executor's sign-in returns to localhost. A
// link URL lives only in that window and in page memory; a key typed for a
// custom server goes to the server once and is never kept. Every value from
// the server is drawn with textContent.

type Session = Readonly<{
  id: string;
  app: string;
  window: Window | null;
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
    /** Whether a direct sign-in opens in the Environment browser (a Remote
     * Environment with its browser), not in a window of this browser. */
    hosted: () => boolean;
    /** Opens the right panel on the Environment browser's view. */
    showBrowser: (view: string) => void;
    /** Opens Composio's sign-in of Settings → Tools; false when it could
     * not (the page then just goes there). */
    signInComposio: () => Promise<boolean>;
    /** Whether the person is the Organization's Admin or Owner (GitHub's
     * answer); false where it is not known. */
    admin: () => Promise<boolean>;
    /** The Organization's page in the Dashboard, where its Admin sets up a
     * company app and allows Composio; null where none is known. */
    dashboard: () => string | null;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing integrations UI");
    return element;
  };
  const navLink = find<HTMLAnchorElement>("#integrations-open");
  const attention = find<HTMLSpanElement>("#integrations-attention");
  const help = find<HTMLAnchorElement>("#integrations-help");
  const search = find<HTMLInputElement>("#integrations-search");
  const refreshButton = find<HTMLButtonElement>("#integrations-refresh");
  const tabs = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      "#integrations-tabs a[data-tab]",
    ),
  ];
  const alert = find<HTMLParagraphElement>("#integrations-alert");
  const status = find<HTMLParagraphElement>("#integrations-status");
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
  /** A line under the tabs: a refusal, a pop-up blocked, an ended flow. */
  let note = "";
  /** The app a deep link opened, brought into view once drawn, and opened
   * with its form once the reading is in. */
  let focus: string | null = null;
  let deepLink: string | null = null;
  const sessions = new Map<string, Session>();
  let busy = new Set<string>();
  let confirmAction: (() => Promise<string | null>) | null = null;

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
  const catalogOf = (id: string): CatalogApp | undefined =>
    integrationsCatalog.apps.find((app) => app.id === id);

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
    try {
      const { value, ok } = await options.get(
        refresh ? "/api/integrations?refresh=1" : "/api/integrations",
      );
      const parsed = ok ? parseIntegrations(value) : null;
      if (read !== reads) return;
      if (parsed === null) failed = true;
      else {
        overview = parsed;
        failed = false;
      }
    } catch {
      if (read === reads) failed = true;
    } finally {
      if (read === reads) {
        loading = false;
        drawAttention();
        if (deepLink !== null) openLinked(deepLink);
        render();
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

  function say(text: string) {
    note = text;
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
      if (kind === "connected") {
        const name =
          overview?.apps.find((app) => app.id === session.app)?.name ??
          session.app;
        note = fill(copy.integrationsConnectedNow, { app: name });
      } else note = copy.integrationsConnectEnded;
      await load(true);
      return;
    }
  }

  /** The answer of a connect: a window to open, the panel, done, refused. */
  async function started(
    app: string,
    answer: { value: unknown; ok: boolean },
    reserved: Window | null,
  ) {
    const copy = options.copy();
    const value = (answer.value ?? {}) as Record<string, unknown>;
    if (value.kind === "authorize" && typeof value.session === "string") {
      const session: Session = { id: value.session, app, window: reserved };
      sessions.set(session.id, session);
      if (typeof value.view === "string") {
        reserved?.close();
        options.showBrowser(value.view);
        note = copy.integrationsFinishInEnvironment;
      } else if (typeof value.url === "string") {
        if (reserved === null) note = copy.integrationsPopupBlocked;
        else {
          reserved.opener = null;
          reserved.location.href = value.url;
          note = copy.integrationsWaiting;
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
      note = fill(copy.integrationsConnectedNow, { app: name });
      await load(true);
      return;
    }
    const reason = value.reason;
    if (reason === "name-required") {
      formNeedsName = true;
      forming = app;
      note = copy.integrationsAccountNameHint;
    } else if (reason === "name-taken") note = copy.integrationsNameTaken;
    else if (reason === "composio-signed-out") {
      note = copy.integrationsComposioSignIn;
      if (!(await options.signInComposio()))
        options.navigate(settingsPath("tools"));
    } else if (reason === "browser-unavailable")
      note = copy.integrationsBrowserMissing;
    else if (reason === "executor-unavailable")
      note = copy.integrationsExecutorUnavailable;
    else if (reason === "integration-conflict")
      note = copy.integrationsIntegrationConflict;
    else if (reason === "still-failing") note = copy.integrationsStillFailing;
    else note = copy.integrationsConnectFailed;
    render();
  }

  /** Starts connecting an app the way its card says; `again` signs one of
   * its accounts in again. */
  async function connect(
    app: IntegrationApp,
    name: string | null,
    again?: IntegrationAccount,
  ) {
    if (busy.has(app.id)) return;
    const path = app.path.path;
    // Claimed in the click, before anything is awaited.
    const reserved =
      path === "composio" || !options.hosted()
        ? window.open("about:blank", "_blank")
        : null;
    busy = new Set([...busy, app.id]);
    note = "";
    render();
    try {
      const answer = await options.post("/api/integrations/connect", {
        app: app.id,
        ...(name === null ? {} : { name }),
        ...(again?.path === "direct" && again.selector !== null
          ? { account: again.selector }
          : {}),
      });
      await started(app.id, answer, reserved);
    } catch {
      reserved?.close();
      busy = new Set([...busy].filter((id) => id !== app.id));
      say(options.copy().integrationsConnectFailed);
    }
  }

  function openConfirm(
    title: string,
    text: string,
    ok: string,
    action: () => Promise<string | null>,
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
    if (confirmAction === null) return;
    confirmOk.disabled = true;
    const failure = await confirmAction().catch(
      () => options.copy().integrationsDisconnectFailed,
    );
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
      disconnectText(app, account, null, copy),
      copy.integrationsDisconnect,
      async () => {
        const { value } = await options.post("/api/integrations/disconnect", {
          app: app.id,
          path: account.path,
          account: account.selector,
          confirm: true,
        });
        const answer = (value ?? {}) as Record<string, unknown>;
        if (answer.kind === "disconnected") return null;
        return answer.reason === "disconnect-unsupported"
          ? copy.integrationsDisconnectUnsupported
          : copy.integrationsDisconnectFailed;
      },
    );
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
  ): HTMLElement {
    const copy = options.copy();
    const box = element("div", "tile-menu integration-menu");
    const toggle = element("button", "tile-menu-button");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", menu.label);
    toggle.append(icon("i-more"));
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
      say(copy.integrationsAskAdminCopied);
    } catch {
      say(fill(copy.integrationsAskAdminText, { app: app.name, line }));
    }
  }

  function act(app: IntegrationApp, action: CardAction, line: string) {
    if (action.kind === "connect") {
      if (app.path.path === "composio" && app.path.signIn) {
        void options.signInComposio().then((opened) => {
          if (!opened) options.navigate(settingsPath("tools"));
        });
        say(options.copy().integrationsComposioSignIn);
        return;
      }
      forming = forming === app.id ? null : app.id;
      formName = "";
      formNeedsName =
        app.accounts.some(
          (account) => !account.spare && account.state === "connected",
        ) && app.path.path === "composio";
      render();
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
      copy,
    });
    const article = element("article", "integration-card");
    article.id = `integration-${app.id}`;
    if (focus === app.id) article.classList.add("is-focused");
    const top = element("div", "integration-top");
    const text = element("div", "integration-text");
    text.append(
      element("h3", "integration-name", app.name),
      element("p", "integration-line", view.line),
    );
    top.append(mark(app), text);
    article.append(top);
    if (forming === app.id && view.action.kind === "connect")
      article.append(connectForm(app, view.composio));
    const foot = element("div", "integration-foot");
    if (view.connected) {
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
    } else foot.append(element("span"));
    if (view.action.kind !== "none" && forming !== app.id) {
      const action = view.action;
      const node = button(action.label, "integration-action", () =>
        act(app, action, view.line),
      );
      node.disabled = busy.has(app.id);
      foot.append(node);
    }
    article.append(foot);
    if (app.accounts.length > 0) {
      const list = element("ul", "integration-accounts");
      for (const account of app.accounts) {
        const shown = accountView(app, account, copy);
        const row = element("li", "integration-account");
        row.dataset.state = account.spare ? "spare" : account.state;
        const words = element("div", "integration-account-text");
        words.append(element("span", "integration-account-name", shown.name));
        if (shown.line !== null)
          words.append(element("span", "integration-account-line", shown.line));
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
        if (shown.disconnect)
          actions.append(
            button(copy.integrationsDisconnect, "link-button danger", () =>
              disconnect(app, account),
            ),
          );
        if (shown.menu !== null)
          actions.append(accountMenu(app, account, shown.menu));
        row.append(actions);
        list.append(row);
      }
      article.append(list);
    }
    return article;
  }

  function appsSection(tab: "all" | "connected"): HTMLElement[] {
    const copy = options.copy();
    if (overview === null) return [];
    const query = search.value;
    // The app a card link names stays listed while the link is open.
    const apps = visibleApps(
      overview,
      integrationsCatalog.apps,
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
    const nodes: HTMLElement[] = [head];
    if (shown.length === 0) {
      const empty = element(
        "p",
        "empty",
        tab === "connected" && !searching
          ? copy.integrationsNoneConnected
          : copy.integrationsNoneFound,
      );
      if (tab === "connected" && !searching) {
        const pick = element("a", "button", copy.integrationsPick);
        pick.href = integrationsPath("all");
        pick.dataset.route = "";
        empty.append(" ", pick);
      }
      nodes.push(empty);
      return nodes;
    }
    const grid = element("div", "integration-grid");
    grid.append(...shown.map(card));
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
    return nodes;
  }

  function customSection(): HTMLElement[] {
    const copy = options.copy();
    const servers: readonly CustomServer[] = overview?.custom ?? [];
    const head = element("div", "integrations-custom-head");
    head.append(element("h2", "", copy.integrationsMcpTitle));
    const unavailable = overview?.sources.executor !== "ok";
    if (unavailable) {
      const add = button(copy.integrationsMcpAdd, "primary", () => {});
      add.prepend(icon("i-plus"));
      add.disabled = true;
      head.append(add);
    } else {
      const add = routeLink(customServerPath(null), "button primary");
      add.append(icon("i-plus"), copy.integrationsMcpAdd);
      head.append(add);
    }
    const nodes: HTMLElement[] = [head];
    if (unavailable)
      nodes.push(element("p", "empty", copy.integrationsMcpUnavailable));
    if (servers.length === 0 && !unavailable)
      nodes.push(element("p", "empty", copy.integrationsMcpNone));
    if (servers.length > 0) {
      const list = element("ul", "card integration-servers");
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
              async () => {
                const { value } = await options.post(
                  "/api/integrations/custom/remove",
                  { id: server.id, confirm: true },
                );
                return (value as { kind?: unknown } | null)?.kind === "removed"
                  ? null
                  : copy.integrationsDisconnectFailed;
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
    return nodes;
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
    const status = element("p", "mcp-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
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
  }

  /** Opens the page of a route: a new server's form, or reads a server's
   * settings into it. The same page shown again keeps its form. */
  function openCustom(server: string | null) {
    if (custom !== null && custom.server === server) {
      drawCustom();
      return;
    }
    note = "";
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
      input.headers.length === 0 &&
      !options.hosted()
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
        note = customSaved(form, copy);
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
    alert.hidden = note === "";
    alert.textContent = note;
    if (overview === null) {
      status.textContent =
        custom !== null
          ? ""
          : failed
            ? copy.integrationsLoadFailed
            : copy.integrationsLoading;
      formHost.hidden = custom === null;
      body.replaceChildren();
      return;
    }
    status.textContent =
      loading && route.tab === "connected" ? copy.integrationsChecking : "";
    const problems = sourceLines(overview, copy).map((line) => {
      const node = element("p", "callout", line);
      node.dataset.kind = "warning";
      return node;
    });
    formHost.hidden = custom === null;
    body.replaceChildren(
      ...problems,
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
  }

  function relabel() {
    const copy = options.copy();
    help.href = integrationsHelp(options.locale());
    search.placeholder = copy.integrationsSearch;
    refreshButton.title = copy.integrationsRefresh;
    if (custom !== null) drawCustom();
    render();
  }

  search.addEventListener("input", () => render());
  refreshButton.addEventListener("click", () => {
    note = "";
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
        return;
      }
      const first = route === null && overview === null;
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
      else render();
    },
    relabel,
    /** Reads again: after a tool's sign-in, or on request. */
    refresh: () => load(true),
  };
}
