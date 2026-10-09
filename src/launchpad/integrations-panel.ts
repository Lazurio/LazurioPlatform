import { integrationsCatalog } from "../integrations/catalog";
import type { CatalogApp } from "../integrations/catalog-schema";
import type {
  CustomServer,
  IntegrationAccount,
  IntegrationApp,
  IntegrationsOverview,
} from "../integrations/model";
import {
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
  /** The custom server form, while it is open. */
  let draft: {
    kind: "command" | "url";
    name: string;
    target: string;
    secretName: string;
  } | null = null;
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
        const shown = accountView(account, copy);
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
    if (draft === null) {
      const add = button(copy.integrationsMcpAdd, "primary", () => {
        draft = { kind: "url", name: "", target: "", secretName: "" };
        render();
      });
      add.prepend(icon("i-plus"));
      add.disabled = unavailable;
      head.append(add);
    }
    const nodes: HTMLElement[] = [head];
    if (unavailable)
      nodes.push(element("p", "empty", copy.integrationsMcpUnavailable));
    if (draft !== null) nodes.push(serverForm());
    if (servers.length === 0 && draft === null && !unavailable)
      nodes.push(element("p", "empty", copy.integrationsMcpNone));
    if (servers.length > 0) {
      const list = element("ul", "card integration-servers");
      for (const server of servers) {
        const row = element("li", "row integration-server");
        row.dataset.state = server.state;
        const main = element("div", "row-main");
        const words = element("div", "row-copy");
        const title = element("p", "row-title");
        title.append(
          icon(server.kind === "remote" ? "i-globe" : "i-terminal"),
          element("span", "", server.name),
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

  function serverForm(): HTMLFormElement {
    const copy = options.copy();
    const current = draft as NonNullable<typeof draft>;
    const form = element("form", "card integration-server-form");
    const kinds = element("fieldset", "integration-kinds");
    kinds.append(element("legend", "sr-only", copy.integrationsMcpKind));
    for (const [kind, label] of [
      ["url", copy.integrationsMcpUrl],
      ["command", copy.integrationsMcpCommand],
    ] as const) {
      const option = element("label", "integration-kind");
      const radio = element("input");
      radio.type = "radio";
      radio.name = "integration-kind";
      radio.value = kind;
      radio.checked = current.kind === kind;
      radio.addEventListener("change", () => {
        current.kind = kind;
        current.target = "";
        current.secretName = "";
        render();
      });
      option.append(radio, element("span", "", label));
      kinds.append(option);
    }
    const field = (
      label: string,
      value: string,
      update: (value: string) => void,
      attributes: Partial<HTMLInputElement> = {},
    ) => {
      const wrap = element("label", "integration-field");
      const input = element("input");
      Object.assign(input, attributes);
      input.value = value;
      input.addEventListener("input", () => update(input.value));
      wrap.append(element("span", "", label), input);
      return { wrap, input };
    };
    const name = field(
      copy.integrationsMcpName,
      current.name,
      (value) => {
        current.name = value;
      },
      { maxLength: 64, required: true },
    );
    const target = field(
      current.kind === "command"
        ? copy.integrationsMcpCommandLine
        : copy.integrationsMcpAddress,
      current.target,
      (value) => {
        current.target = value;
      },
      { required: true, className: "mono" },
    );
    const secret = field(
      current.kind === "command"
        ? copy.integrationsMcpVariable
        : copy.integrationsMcpHeader,
      current.secretName,
      (value) => {
        current.secretName = value;
        value_.input.disabled = value.trim() === "";
      },
      { className: "mono" },
    );
    // The key is typed into a masked field and only sent: never kept here.
    const value_ = field(copy.integrationsMcpValue, "", () => {}, {
      type: "password",
      autocomplete: "off",
      disabled: current.secretName.trim() === "",
    });
    const actions = element("div", "dialog-foot");
    const submit = element("button", "primary", copy.integrationsMcpSubmit);
    submit.type = "submit";
    actions.append(
      submit,
      button(copy.integrationsCancel, "ghost", () => {
        draft = null;
        render();
      }),
    );
    form.append(
      kinds,
      name.wrap,
      target.wrap,
      secret.wrap,
      value_.wrap,
      actions,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const secretName = current.secretName.trim();
      const secretValue = value_.input.value;
      value_.input.value = "";
      const reserved =
        current.kind === "url" && !options.hosted()
          ? window.open("about:blank", "_blank")
          : null;
      submit.disabled = true;
      try {
        const answer = await options.post("/api/integrations/custom/add", {
          name: current.name.trim(),
          kind: current.kind,
          target: current.target.trim(),
          ...(secretName === "" || secretValue === ""
            ? {}
            : { secretName, secretValue }),
        });
        const kind = (answer.value as { kind?: unknown } | null)?.kind;
        if (kind === "connected" || kind === "authorize") draft = null;
        if (kind === "blocked" || !answer.ok) {
          reserved?.close();
          const reason = (answer.value as { reason?: unknown } | null)?.reason;
          say(
            reason === "name-taken"
              ? copy.integrationsMcpNameTaken
              : copy.integrationsMcpAddFailed,
          );
          return;
        }
        await started(current.name.trim(), answer, reserved);
      } catch {
        reserved?.close();
        say(copy.integrationsMcpAddFailed);
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  function render() {
    const copy = options.copy();
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
      status.textContent = failed
        ? copy.integrationsLoadFailed
        : copy.integrationsLoading;
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
    body.replaceChildren(
      ...problems,
      ...(route.tab === "custom" ? customSection() : appsSection(route.tab)),
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
        render();
        return;
      }
      const first = route === null && overview === null;
      route = {
        tab: next.tab,
        ...(next.app === undefined ? {} : { app: next.app }),
      };
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
