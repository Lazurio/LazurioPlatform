import type { VaultStatus } from "../vault/flow";
import type { MessageKey } from "./messages";
import {
  parseVaultMembership,
  parseVaultPage,
  type VaultPageAction,
  type VaultPageModel,
  type VaultPagePerson,
  vaultPageSetupPollMs,
  vaultPageView,
} from "./vault-page-view";
import { parseVaultStatus } from "./vault-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// Settings → Vault, Nastavení → Trezor (root decision 0198 point 5): the
// rule, the Environment's vault with its state and the way into it, drawn
// from `vault-page-view.ts`. On first view the page reads the vault's state
// as recorded here (`GET /api/vault`), then asks the vault itself (the
// Tools row's refresh) and where the person stands in it (`POST
// /api/vault/membership`, which adds them). Every server value is drawn as
// text; the links lead into the network's own vault, in a new tab.
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

  let model: VaultPageModel | null = null;
  // The vault's own answer (the refresh), newer than the recorded state.
  let fresh: VaultStatus | null = null;
  let person: VaultPagePerson | null = null;
  let loading = false;
  let failed = false;
  let reading = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;

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
          : "";
    const view = vaultPageView(model, person, copy, fresh);
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

  again.addEventListener("click", () => void refresh());
  // Back from the vault's sign-in in another tab: a person who had no
  // account (or no master password) yet is asked about again, and is added
  // once they have one.
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      options.shown() &&
      person?.kind === "known" &&
      (person.state === "no-account" || person.state === "awaiting-password")
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
