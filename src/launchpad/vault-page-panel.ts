import type { VaultStatus } from "../vault/flow";
import type { MessageKey } from "./messages";
import {
  connectionFilled,
  connectionRefusalText,
  parseVaultMembership,
  parseVaultPage,
  type VaultPageAction,
  type VaultPageModel,
  type VaultPagePerson,
  vaultPageSetupPollMs,
  vaultPageView,
} from "./vault-page-view";
import {
  parseVaultSettingUp,
  parseVaultStatus,
  vaultSetupPollMs,
} from "./vault-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// Settings → Vault, Nastavení → Trezor (root decision 0198 point 5): the
// rule, the Environment's vault with its state and the way into it, drawn
// from `vault-page-view.ts`. On first view the page reads the vault's state
// as recorded here (`GET /api/vault`), then asks the vault itself (the
// Tools row's refresh) and where the person stands in it (`POST
// /api/vault/membership`, which adds them). Every server value is drawn as
// text; the links lead into the network's own vault, in a new tab. A
// personal Environment whose person has not connected their own Bitwarden
// shows the form instead (root decision 0203 point 7): its values go from
// the inputs into the one `POST /api/vault/connect` and nowhere else (no
// storage, address or log), the secret ones are emptied as they are sent
// and the rest once connected; the page then follows the setup that
// creates the vault, as the Tools row does.
export function createVaultPagePanel(
  options: Readonly<{
    get: (path: string) => Answer;
    post: (path: string, body: unknown) => Answer;
    copy: () => Copy;
    /** Whether the page shows this section now. */
    shown: () => boolean;
    /** This Environment's Chat (T3 Code's origin as recorded), or null on a
     * workstation: the guide's button opens it as the shell's Chat does. */
    chat: () => string | null;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing vault UI");
    return element;
  };
  const rule = find<HTMLParagraphElement>("#vault-page-rule");
  const status = find<HTMLParagraphElement>("#vault-page-status");
  const note = find<HTMLParagraphElement>("#vault-page-note");
  const group = find<HTMLElement>("#vault-page-group");
  const name = find<HTMLParagraphElement>("#vault-page-name");
  const state = find<HTMLParagraphElement>("#vault-page-state");
  const actions = find<HTMLDivElement>("#vault-page-actions");
  const hint = find<HTMLParagraphElement>("#vault-page-hint");
  const guide = find<HTMLParagraphElement>("#vault-page-guide");
  const again = find<HTMLButtonElement>("#vault-page-refresh");
  const connectSection = find<HTMLElement>("#vault-connect");
  const form = find<HTMLFormElement>("#vault-connect-form");
  const region = find<HTMLSelectElement>("#vault-connect-region");
  const clientId = find<HTMLInputElement>("#vault-connect-client-id");
  const clientSecret = find<HTMLInputElement>("#vault-connect-client-secret");
  const password = find<HTMLInputElement>("#vault-connect-password");
  const email = find<HTMLInputElement>("#vault-connect-email");
  const connectError = find<HTMLParagraphElement>("#vault-connect-error");
  const connectSubmit = find<HTMLButtonElement>("#vault-connect-submit");
  const reveals = [
    ...form.querySelectorAll<HTMLButtonElement>("button[data-reveal]"),
  ];
  const disconnectBox = find<HTMLDivElement>("#vault-page-disconnect");
  const disconnectButton = find<HTMLButtonElement>("#vault-disconnect");

  let model: VaultPageModel | null = null;
  // The vault's own answer (the refresh), newer than the recorded state.
  let fresh: VaultStatus | null = null;
  let person: VaultPagePerson | null = null;
  let loading = false;
  let failed = false;
  let reading = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  // The connection of a personal Environment's own Bitwarden: whether it is
  // sent now, why the last one was refused, the answer of the setup it
  // started when that did not connect, and the disconnect.
  let connecting = false;
  let problem: string | null = null;
  let outcome: VaultStatus | null = null;
  let disconnecting = false;
  let notice: string | null = null;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = (icon: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${icon}`);
    node.append(use);
    return node;
  };
  const link = (action: VaultPageAction) => {
    const anchor = element(
      "a",
      action.primary ? "button primary" : "button",
      action.label,
    );
    anchor.href = action.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.dataset.control = `vault-${action.control}`;
    if (action.control === "add") anchor.prepend(svg("plus"));
    else anchor.append(svg("external"));
    return anchor;
  };

  /** Asks the vault itself: its state now and where the person stands. */
  async function ask(turn: number): Promise<void> {
    await Promise.all([
      (async () => {
        try {
          const { value, ok } = await options.post(
            "/api/tools/bitwarden/refresh",
            {},
          );
          const parsed = ok ? parseVaultStatus(value) : null;
          if (turn === reading && parsed !== null) {
            fresh = parsed;
            render();
          }
        } catch {}
      })(),
      membership(turn),
    ]);
  }

  /** Where the person stands, after the Environment adds them. */
  async function membership(turn = reading): Promise<void> {
    let parsed: VaultPagePerson | null = null;
    try {
      const { value, ok } = await options.post("/api/vault/membership", {});
      parsed = ok ? parseVaultMembership(value) : null;
    } catch {}
    if (turn !== reading) return;
    person = parsed ?? { kind: "unknown", reason: "failed" };
    render();
  }

  /** Reads the page again, and follows a setup that creates the vault. */
  async function refresh(): Promise<void> {
    const turn = ++reading;
    clearTimeout(poll);
    loading = true;
    render();
    let read: VaultPageModel | null = null;
    try {
      const { value, ok } = await options.get("/api/vault");
      read = ok ? parseVaultPage(value) : null;
    } catch {}
    if (turn !== reading) return;
    loading = false;
    failed = read === null;
    if (read !== null) {
      model = read;
      fresh = null;
      person = null;
      // A setup's failure stays until the vault is connected, or waits for
      // its person again.
      if (
        read.status.state === "connected" ||
        read.status.state === "needs-connection"
      )
        outcome = null;
    }
    render();
    if (read === null) return;
    if (read.setup !== null) {
      poll = setTimeout(() => {
        if (options.shown()) void refresh();
      }, vaultPageSetupPollMs);
      return;
    }
    if (read.status.state !== "unsupported") await ask(turn);
  }

  function render() {
    const copy = options.copy();
    again.disabled = loading;
    status.textContent =
      loading && model === null
        ? copy.vaultRowChecking
        : failed
          ? copy.vaultLoadFailed
          : (notice ?? "");
    const view = vaultPageView(model, person, copy, outcome ?? fresh);
    connectSection.hidden = !view.connect;
    connectSubmit.textContent = connecting
      ? copy.vaultConnectSubmitting
      : copy.vaultConnectSubmit;
    connectSubmit.disabled = connecting || !connectionFilled(values());
    connectError.textContent = problem ?? "";
    for (const button of reveals) {
      const input = document.getElementById(button.dataset.reveal ?? "");
      button.textContent =
        input instanceof HTMLInputElement && input.type === "text"
          ? copy.vaultRequestHide
          : copy.vaultRequestShow;
    }
    disconnectBox.hidden = !view.disconnect;
    disconnectButton.disabled = disconnecting;
    disconnectButton.textContent = disconnecting
      ? copy.vaultDisconnecting
      : copy.vaultDisconnect;
    rule.hidden = !view.rule;
    note.hidden = view.note === null;
    note.textContent = view.note ?? "";
    group.hidden = view.row === null;
    name.textContent = view.row?.title ?? "";
    state.textContent = view.row?.line ?? "";
    state.dataset.tone = view.row?.tone ?? "quiet";
    actions.replaceChildren(...view.actions.map(link));
    hint.hidden = view.hint === null;
    hint.textContent = view.hint ?? "";
    guide.hidden = !view.guide;
    guide.replaceChildren(...(view.guide ? guideOf(copy) : []));
  }

  /** The way to use the vault: one line, and Chat to start in. Chat opens
   * as the shell's own Chat entry does (the `lazurio-app` event pairs it);
   * without a Chat (a workstation) only the line. */
  function guideOf(copy: Copy): Node[] {
    const line = element("span", "", copy.vaultPageGuide);
    const href = options.chat();
    if (href === null) return [line];
    const anchor = element("a", "button", copy.vaultPageGuideChat);
    anchor.href = href;
    anchor.dataset.control = "vault-chat";
    anchor.addEventListener("click", (event) => {
      const asked = new CustomEvent("lazurio-app", {
        detail: { app: "chat", href },
        cancelable: true,
      });
      document.dispatchEvent(asked);
      if (asked.defaultPrevented) event.preventDefault();
    });
    return [line, document.createTextNode(" "), anchor];
  }

  /** The form's values as typed: the master password exactly so. */
  function values(): Record<string, string> {
    return {
      region: region.value,
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      masterPassword: password.value,
      email: email.value,
    };
  }

  /** The secret inputs emptied and masked again; all of them with `all`. */
  function forget(all: boolean) {
    for (const input of [clientSecret, password]) {
      input.value = "";
      input.type = "password";
    }
    for (const button of reveals) button.setAttribute("aria-pressed", "false");
    if (all) {
      clientId.value = "";
      email.value = "";
      region.value = "eu";
    }
  }

  /** Connects the person's own Bitwarden: the values in one request, the
   * secret ones emptied as they leave, then the setup that creates the
   * vault followed by its job, as the Tools row follows it. */
  async function connect(): Promise<void> {
    const sent = values();
    if (connecting || !connectionFilled(sent)) return;
    connecting = true;
    problem = null;
    forget(false);
    render();
    let answer: { value: unknown; ok: boolean } | null = null;
    try {
      answer = await options.post("/api/vault/connect", sent);
    } catch {}
    connecting = false;
    if (answer?.ok === true) {
      forget(true);
      const running = parseVaultSettingUp(answer.value);
      if (running !== null) void follow(running.job);
      else outcome = endedOf(parseVaultStatus(answer.value));
    } else {
      const copy = options.copy();
      problem =
        connectionRefusalText(
          (answer?.value as { reason?: unknown } | null)?.reason,
          copy,
        ) ?? copy.vaultConnectFailed;
    }
    // Read again either way: a refusal may come from a vault connected
    // meanwhile, which then shows instead of the form.
    await refresh();
  }

  /** A setup's answer worth keeping on the page: one that did not connect. */
  const endedOf = (ended: VaultStatus | null): VaultStatus | null =>
    ended !== null &&
    (ended.state === "failed" || ended.state === "unreachable")
      ? ended
      : null;

  /** Follows the setup a connection started until it ends; its answer is
   * kept when it did not connect, and the page is read again. */
  async function follow(job: string): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, vaultSetupPollMs));
      let value: unknown = null;
      try {
        ({ value } = await options.post("/api/tools/bitwarden/setup", { job }));
      } catch {}
      if (parseVaultSettingUp(value) !== null) continue;
      outcome = endedOf(parseVaultStatus(value));
      if (options.shown()) await refresh();
      return;
    }
  }

  /** Disconnects the person's own Bitwarden: the account forgotten here,
   * the organization kept in Bitwarden. */
  async function disconnect(): Promise<void> {
    if (disconnecting) return;
    disconnecting = true;
    notice = null;
    render();
    try {
      const { value, ok } = await options.post("/api/vault/disconnect", {});
      if (!ok)
        notice = connectionRefusalText(
          (value as { reason?: unknown } | null)?.reason,
          options.copy(),
        );
    } catch {
      notice = options.copy().vaultConnectFailed;
    }
    disconnecting = false;
    outcome = null;
    problem = null;
    await refresh();
  }

  form.addEventListener("input", () => render());
  form.addEventListener("change", () => render());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void connect();
  });
  for (const button of reveals)
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.reveal ?? "");
      if (!(input instanceof HTMLInputElement)) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", String(show));
      render();
    });
  disconnectButton.addEventListener("click", () => void disconnect());
  again.addEventListener("click", () => void refresh());
  // Back from the vault's sign-in in another tab: a person who had no
  // account (or no master password) yet is asked about again, and is added
  // once they have one. So is a person whose sign-in carried no Lazurio
  // username, back from signing in again.
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      options.shown() &&
      ((person?.kind === "known" &&
        (person.state === "no-account" ||
          person.state === "awaiting-password" ||
          // Back from accepting the e-mailed invitation of a personal
          // Environment's own Bitwarden: confirmed now.
          person.state === "invitation-pending" ||
          person.state === "accepted")) ||
        (person?.kind === "unknown" && person.reason === "no-username"))
    )
      void membership();
  });

  return Object.freeze({
    refresh,
    render,
    /** Whether the section was read once. */
    get loaded() {
      return model !== null || loading;
    },
  });
}
