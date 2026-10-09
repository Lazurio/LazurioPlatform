import type { VaultPhase, VaultStatus } from "../vault/flow";
import type { MessageKey } from "./messages";
import { answerWithin } from "./tools-view";
import { fill } from "./update-view";
import {
  parseVaultConnecting,
  parseVaultStatus,
  type VaultAction,
  type VaultStep,
  vaultActions,
  vaultAfterConnect,
  vaultConnectPollMs,
  vaultLink,
  vaultPhaseMarks,
  vaultPollMs,
  vaultRowLine,
  vaultSeen,
  vaultStartStep,
  vaultSteps,
} from "./vault-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Post = (
  path: string,
  body: unknown,
) => Promise<{ value: unknown; ok: boolean }>;

// The Environment vault's row and dialog on the tools screen (decision F43,
// the wireframe of prototypes-lazurio#24). The row says the state and offers
// the one next step; the dialog walks the four steps: the operator invites
// the account in the vault, the Environment connects by itself, the operator
// confirms the member by its fingerprint, connected. The server holds the
// connect: closing the dialog stops only this page's polling, never the
// work. Everything shown is text.

const answerMs = 45_000;

export function createVaultPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
    /** The vault's state changed: the tools section draws again. */
    changed: () => void;
    /** The dialog reached "Připojeno": the agents' switch turns on. */
    connected: () => void;
    /** "Odpojit" went through: the row's notice of an earlier act ends. */
    disconnected: () => void;
    /** "Dokončit s agentem": the tool's prepared prompt. */
    agent: () => void;
    /** The dialog closed: the focus returns to the row. */
    focus: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing vault UI");
    return element;
  };
  const dialog = find<HTMLDialogElement>("#tools-vault");
  const title = find<HTMLHeadingElement>("#tools-vault-title");
  const body = find<HTMLDivElement>("#tools-vault-body");
  const close = find<HTMLButtonElement>("#tools-vault-close");

  let status: VaultStatus | null = null;
  let unreadable = false;
  let reading = 0;
  let busy = false;

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
  const svg = (name: string) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", "icon");
    node.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    node.append(use);
    return node;
  };
  const button = (label: string, className: string, action: () => void) => {
    const node = element("button", className, label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };
  const vaultAnchor = (href: string, className: string) => {
    const copy = options.copy();
    const anchor = element("a", className, copy.vaultOpen);
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.append(svg("external"));
    return anchor;
  };

  /** Reads the vault's state; `sync` asks the vault itself (on the first
   * read, on Refresh status and in the dialog). */
  async function read(sync: boolean): Promise<VaultStatus | null> {
    const turn = ++reading;
    let parsed: VaultStatus | null = null;
    try {
      const answer = await answerWithin(
        options.post(
          sync ? "/api/tools/bitwarden/refresh" : "/api/tools/bitwarden/status",
          {},
        ),
        answerMs,
      );
      parsed = answer.answered ? parseVaultStatus(answer.value) : null;
    } catch {}
    if (turn !== reading) return status;
    unreadable = parsed === null;
    if (parsed !== null) status = parsed;
    options.changed();
    return parsed;
  }

  // ---- The row ---------------------------------------------------------

  /** The status line, the controls and the details of the bitwarden row. */
  function row(copy: Copy): Readonly<{
    line: Readonly<{ text: string; state: string }>;
    controls: readonly HTMLElement[];
    details: HTMLElement | null;
  }> {
    const line = unreadable
      ? { text: copy.vaultLoadFailed, state: "unknown" }
      : vaultRowLine(status, copy);
    const actions = vaultActions(status, copy);
    const controls: HTMLElement[] = [];
    if (actions.primary !== null) {
      const primary = actions.primary;
      const node = button(primary.label, "primary", () =>
        primary.action === "retry" ? void retry() : open(primary.action),
      );
      node.dataset.tool = "bitwarden";
      node.dataset.control = "vault";
      node.setAttribute(
        "aria-label",
        fill(copy.vaultActionNamed, { action: primary.label }),
      );
      node.disabled = busy;
      controls.push(node);
    }
    if (actions.disconnect) {
      const node = button(copy.vaultActionDisconnect, "destructive", () =>
        open("disconnect"),
      );
      node.dataset.tool = "bitwarden";
      node.dataset.control = "vault-disconnect";
      node.setAttribute(
        "aria-label",
        fill(copy.vaultActionNamed, { action: copy.vaultActionDisconnect }),
      );
      node.disabled = busy;
      controls.push(node);
    }
    return { line, controls, details: details(copy) };
  }

  /** The account, the vault, the organization and the collection, once
   * there is an account to speak of. */
  function details(copy: Copy): HTMLElement | null {
    if (status === null || status.state === "unsupported") return null;
    const current = status;
    const section = element("section", "vault-facts");
    section.append(element("h4", "", copy.vaultDetails));
    const facts = element("dl", "vault-list");
    const fact = (label: string, value: string | HTMLElement) => {
      const term = element("dt", "", label);
      const description = element("dd");
      description.append(value);
      facts.append(term, description);
    };
    fact(copy.vaultDetailAccount, current.account);
    const link = vaultLink(current.vault);
    fact(copy.vaultDetailVault, current.vault.replace(/^https:\/\//, ""));
    if (
      (current.state === "connected" || current.state === "confirming") &&
      current.organization !== null
    )
      fact(copy.vaultDetailOrganization, current.organization);
    fact(copy.vaultDetailCollection, current.collection);
    if (
      (current.state === "connected" ||
        current.state === "confirming" ||
        current.state === "revoked") &&
      current.fingerprint !== null
    )
      fact(copy.vaultDetailFingerprint, current.fingerprint);
    section.append(facts);
    const actions = element("p", "tool-actions");
    if (link !== null) actions.append(vaultAnchor(link, "button"));
    if (
      current.state === "connected" ||
      current.state === "revoked" ||
      current.state === "unreachable"
    ) {
      const sync = button(copy.vaultSync, "", () => void retry());
      sync.disabled = busy;
      actions.append(sync);
    }
    section.append(actions);
    return section;
  }

  async function retry() {
    if (busy) return;
    busy = true;
    options.changed();
    await read(true);
    busy = false;
    options.changed();
  }

  // ---- The dialog -----------------------------------------------------

  type Flow = {
    mode: "connect" | "disconnect";
    step: VaultStep;
    reconnect: boolean;
    phase: VaultPhase | "done" | null;
    failure: string | null;
    agent: boolean;
    working: boolean;
    copied: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    turn: number;
  };
  let flow: Flow | null = null;

  function stop() {
    if (flow?.timer) clearTimeout(flow.timer);
    if (flow) flow.timer = null;
  }

  function open(action: VaultAction | "disconnect") {
    if (status === null || status.state === "unsupported") return;
    const copy = options.copy();
    flow = {
      mode: action === "disconnect" ? "disconnect" : "connect",
      step: action === "disconnect" ? "done" : vaultStartStep(status, action),
      reconnect: action === "reconnect",
      phase: null,
      failure: null,
      agent: false,
      working: false,
      copied: null,
      timer: null,
      turn: 0,
    };
    title.textContent =
      action === "disconnect" ? copy.vaultDisconnectTitle : copy.vaultTitle;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    title.focus();
    render();
    if (flow.step === "connect") void connect();
    if (flow.step === "confirm") poll();
  }

  function render() {
    const current = flow;
    if (current === null || status === null || status.state === "unsupported")
      return;
    const copy = options.copy();
    if (current.mode === "disconnect") {
      const actions = element("p", "tool-actions");
      const cancel = button(copy.vaultCancel, "", () => dialog.close());
      const confirm = button(
        copy.vaultActionDisconnect,
        "destructive",
        () => void disconnect(),
      );
      confirm.disabled = current.working;
      actions.append(cancel, confirm);
      body.replaceChildren(
        element("p", "", copy.vaultDisconnectText),
        ...(current.failure === null
          ? []
          : [element("p", "tools-warning", current.failure)]),
        actions,
      );
      return;
    }
    const titles: Readonly<Record<VaultStep, string>> = {
      invite: copy.vaultStepInvite,
      connect: copy.vaultStepConnect,
      confirm: copy.vaultStepConfirm,
      done: copy.vaultStepDone,
    };
    const at = vaultSteps.indexOf(current.step);
    const list = element("ol", "vault-steps");
    vaultSteps.forEach((step, index) => {
      const mark =
        current.step === "done" || index < at
          ? "done"
          : index === at
            ? "current"
            : "next";
      const item = element("li", "vault-step");
      item.dataset.mark = mark;
      if (index === at) item.setAttribute("aria-current", "step");
      const badge = element("span", "vault-mark");
      badge.setAttribute("aria-hidden", "true");
      if (mark === "done") badge.append(svg("check"));
      else badge.textContent = String(index + 1);
      const content = element("div", "vault-step-body");
      content.append(element("p", "vault-step-title", titles[step]));
      if (index === at) content.append(...stepBody(step, copy));
      item.append(badge, content);
      list.append(item);
    });
    body.replaceChildren(list);
  }

  function value(label: string, text: string, id: string): HTMLElement {
    const current = flow;
    const copy = options.copy();
    const box = element("div", "vault-value");
    const words = element("div", "vault-value-text");
    const shown = element("code", "vault-value-code", text);
    // One line; a long value keeps its whole text on hover and in the copy.
    shown.title = text;
    words.append(element("span", "vault-value-label", label), shown);
    const copied = current?.copied === id;
    const action = button("", "ghost vault-copy", () => {
      void navigator.clipboard?.writeText(text).then(
        () => {
          if (flow !== null) {
            flow.copied = id;
            render();
          }
        },
        () => undefined,
      );
    });
    action.append(svg(copied ? "check" : "copy"));
    action.setAttribute("aria-label", fill(copy.vaultCopyNamed, { label }));
    action.title = copied ? copy.vaultCopied : copy.vaultCopy;
    box.append(words, action);
    return box;
  }

  function stepBody(step: VaultStep, copy: Copy): HTMLElement[] {
    const current = flow;
    if (current === null || status === null || status.state === "unsupported")
      return [];
    const facts = status;
    const link = vaultLink(facts.vault);
    const failure =
      current.failure === null
        ? []
        : [element("p", "vault-failure", current.failure)];
    for (const node of failure) node.setAttribute("role", "alert");
    if (step === "invite") {
      const card = element("div", "vault-card");
      card.append(
        value(copy.vaultCollectionLabel, facts.collection, "collection"),
        value(copy.vaultAccountLabel, facts.account, "account"),
      );
      const actions = element("p", "tool-actions");
      if (link !== null) actions.append(vaultAnchor(link, "button"));
      const invited = button(
        current.failure === null ? copy.vaultInvited : copy.vaultActionRetry,
        "primary",
        () => void connect(),
      );
      invited.disabled = current.working;
      actions.append(invited);
      return [
        element(
          "p",
          "",
          current.reconnect ? copy.vaultInviteAgainText : copy.vaultInviteText,
        ),
        card,
        element("p", "tools-muted", copy.vaultAdminHint),
        ...(facts.team
          ? [element("p", "tools-muted", copy.vaultTeamHint)]
          : []),
        ...failure,
        actions,
      ];
    }
    if (step === "connect") {
      const list = element("ol", "content-steps");
      for (const entry of vaultPhaseMarks(current.phase, copy)) {
        const item = element("li", "content-step");
        item.dataset.mark =
          current.failure !== null && entry.mark === "running"
            ? "failed"
            : entry.mark;
        const mark = element("span", "content-mark");
        mark.setAttribute("aria-hidden", "true");
        if (entry.mark === "done") mark.append(svg("check"));
        else if (current.failure !== null && entry.mark === "running")
          mark.append(svg("x"));
        else if (entry.mark === "running")
          mark.append(element("span", "spinner"));
        item.append(mark, element("span", "", entry.label));
        if (entry.mark === "running") item.setAttribute("aria-current", "step");
        list.append(item);
      }
      const nodes: HTMLElement[] = [
        list,
        element("p", "tools-muted", copy.vaultPasswordHint),
        ...failure,
      ];
      if (current.failure !== null) {
        const actions = element("p", "tool-actions");
        if (current.agent)
          actions.append(
            button(copy.toolsFinishWithAgent, "", () => {
              dialog.close();
              options.agent();
            }),
          );
        actions.append(
          button(copy.vaultActionRetry, "primary", () => void connect()),
        );
        nodes.push(actions);
      }
      return nodes;
    }
    if (step === "confirm") {
      const fingerprint =
        facts.state === "confirming" || facts.state === "connected"
          ? facts.fingerprint
          : null;
      const actions = element("p", "tool-actions");
      if (link !== null) actions.append(vaultAnchor(link, "button"));
      const waiting = element("p", "vault-waiting", copy.vaultWaiting);
      waiting.setAttribute("role", "status");
      return [
        element("p", "", copy.vaultConfirmText),
        ...(fingerprint === null
          ? []
          : [
              element("p", "tools-muted", copy.vaultFingerprintHint),
              element("code", "vault-phrase", fingerprint),
            ]),
        element("p", "tools-muted", copy.vaultAdminHint),
        actions,
        ...(facts.state === "confirming" && facts.organization !== null
          ? [
              element(
                "p",
                "tools-muted",
                fill(copy.vaultNoCollection, { collection: facts.collection }),
              ),
            ]
          : []),
        ...failure,
        waiting,
      ];
    }
    const done = button(copy.toolsLoginDone, "primary", () => dialog.close());
    const row = element("p", "tool-actions");
    row.append(done);
    return [
      ...(facts.state === "connected" &&
      facts.collections !== null &&
      facts.items !== null
        ? [
            element(
              "p",
              "",
              fill(copy.vaultSees, {
                seen: vaultSeen(facts.collections, facts.items, copy),
              }),
            ),
          ]
        : []),
      row,
    ];
  }

  /** "Pozváno", "Připojit" of an existing account, or "Zkusit znovu": the
   * server's one connect, asked again while it runs. */
  async function connect() {
    const current = flow;
    if (current === null || current.working) return;
    const copy = options.copy();
    stop();
    const turn = ++current.turn;
    current.working = true;
    current.failure = null;
    current.agent = false;
    current.step = "connect";
    current.phase = "install";
    render();
    let job: string | null = null;
    for (;;) {
      const answer = await answerWithin(
        options.post(
          "/api/tools/bitwarden/connect",
          job === null ? {} : { job },
        ),
        answerMs,
      );
      if (flow !== current || current.turn !== turn) return;
      const running = answer.answered
        ? parseVaultConnecting(answer.value)
        : null;
      if (running !== null) {
        job = running.job;
        current.phase = running.phase;
        render();
        await new Promise((resolve) => setTimeout(resolve, vaultConnectPollMs));
        if (flow !== current || current.turn !== turn) return;
        continue;
      }
      const parsed = answer.answered ? parseVaultStatus(answer.value) : null;
      current.working = false;
      if (parsed === null) {
        current.failure = copy.vaultLoadFailed;
        render();
        return;
      }
      status = parsed;
      options.changed();
      const next = vaultAfterConnect(parsed, copy);
      current.step = next.step;
      current.failure = next.failure;
      current.agent = next.agent;
      current.phase = next.step === "connect" ? current.phase : "done";
      render();
      if (next.step === "confirm") poll();
      if (next.step === "done") options.connected();
      return;
    }
  }

  /** The confirmation step asks the vault every few seconds while the
   * dialog is open. */
  function poll() {
    const current = flow;
    if (current === null) return;
    stop();
    const turn = current.turn;
    current.timer = setTimeout(async () => {
      const parsed = await read(true);
      if (flow !== current || current.turn !== turn) return;
      if (parsed?.state === "connected") {
        current.step = "done";
        current.failure = null;
        render();
        options.connected();
        return;
      }
      if (parsed?.state === "unreachable")
        current.failure = options.copy().vaultUnreachableLine;
      else if (parsed?.state === "confirming") current.failure = null;
      render();
      poll();
    }, vaultPollMs);
  }

  async function disconnect() {
    const current = flow;
    if (current === null || current.working) return;
    current.working = true;
    render();
    let parsed: VaultStatus | null = null;
    try {
      const answer = await answerWithin(
        options.post("/api/tools/bitwarden/disconnect", {}),
        answerMs,
      );
      parsed = answer.answered ? parseVaultStatus(answer.value) : null;
    } catch {}
    if (flow !== current) return;
    current.working = false;
    if (parsed === null || parsed.state === "failed") {
      current.failure = options.copy().vaultLoadFailed;
      render();
      return;
    }
    status = parsed;
    options.disconnected();
    options.changed();
    dialog.close();
  }

  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    // The event of an earlier closing may come after the dialog was opened
    // again: it then belongs to nothing that is shown.
    if (dialog.open) return;
    // Only this page's polling ends: a connect goes on in the Launchpad.
    stop();
    flow = null;
    body.replaceChildren();
    // The row is drawn again with what is read now; then it takes the focus.
    void read(false).then(() => options.focus());
  });

  return Object.freeze({ read, row });
}
