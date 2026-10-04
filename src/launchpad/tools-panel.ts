import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { ToolSignIn } from "../tools/status";
import type { MessageKey } from "./messages";
import {
  answerWithin,
  curatedActions,
  currentNotes,
  installOutcome,
  type LoginPhase,
  type LoginView,
  loginAnswerMs,
  loginEndMessage,
  loginLink,
  loginProgress,
  loginStepOrder,
  loginSteps,
  logoutOutcome,
  nextNotes,
  nextSelection,
  noteDraftView,
  organizationChoices,
  parseLoginState,
  parseToolsOverview,
  qrImageSource,
  signedInMessage,
  signInLine,
  sourceLink,
  sshOutcome,
  type ToolChange,
  type ToolChangeOutcome,
  takesNote,
  teamInstallOutcome,
  toolChangeOutcome,
  toolGroups,
  toolStatusView,
} from "./tools-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;
type Post = (
  path: string,
  body: unknown,
) => Promise<{ value: unknown; ok: boolean }>;

// The tools section of the page (decision F18). The server derives every
// fact; the browser shows it as text and sends back the full next selection
// (and, for a note, the full next set of notes) with the revision it showed.
// One click applies a change; the confirmation on the card names the new
// Folder revision and offers Undo, which restores the state before it.
export function createToolsPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
    /** Share the same observation with Apps, including failed reads. */
    observed: (overview: ToolsOverview | null) => void;
    /** The Folder changed through this panel: the rest of the page reloads,
     * and that reload refreshes this panel too. */
    changed: () => Promise<void>;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing tools UI");
    return element;
  };
  const groups = find<HTMLDivElement>("#tools-groups");
  const shared = find<HTMLParagraphElement>("#tools-shared");
  const checked = find<HTMLSpanElement>("#tools-checked");
  const announce = find<HTMLParagraphElement>("#tools-announce");
  const refreshButton = find<HTMLButtonElement>("#tools-refresh");
  const mcpButton = find<HTMLButtonElement>("#tools-mcp");
  const dialog = find<HTMLDialogElement>("#tools-prompt");
  const dialogTitle = find<HTMLHeadingElement>("#tools-prompt-title");
  const dialogHint = find<HTMLParagraphElement>("#tools-prompt-hint");
  const dialogText = find<HTMLTextAreaElement>("#tools-prompt-text");
  const dialogCopy = find<HTMLButtonElement>("#tools-prompt-copy");
  const dialogClose = find<HTMLButtonElement>("#tools-prompt-close");
  const dialogStatus = find<HTMLSpanElement>("#tools-prompt-status");
  const loginDialog = find<HTMLDialogElement>("#tools-login");
  const loginTitle = find<HTMLHeadingElement>("#tools-login-title");
  const loginStepList = find<HTMLOListElement>("#tools-login-steps");
  const loginStatus = find<HTMLParagraphElement>("#tools-login-status");
  const loginBody = find<HTMLDivElement>("#tools-login-body");
  const loginClose = find<HTMLButtonElement>("#tools-login-close");

  type Selection = Readonly<{
    tools: readonly string[];
    notes: Readonly<Record<string, string>>;
  }>;
  let overview: ToolsOverview | null = null;
  let failed = false;
  let busy = false;
  let sequence = 0;
  // The sign-ins are probed only on the first read and on Refresh status (a
  // probe may contact the provider); other reads keep the last answer.
  let signInChecked = false;
  const signIns = new Map<string, ToolSignIn>();
  // What the operator typed and did not save yet, and which cards have
  // "What agents are told" open: both survive a re-render.
  const drafts = new Map<string, string>();
  const opened = new Set<string>();
  let notice: {
    name: string;
    outcome: ToolChangeOutcome;
    /** The state before the change, restored at the new revision. */
    undo: (Selection & { expectedRevision: number }) | null;
  } | null = null;
  let focus: { name: string; control: string } | null = null;
  let opener: HTMLElement | null = null;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  const button = (
    label: string,
    name: string,
    control: string,
    action: () => void,
    accessibleName?: string,
  ) => {
    const created = element("button", "", label);
    created.type = "button";
    created.dataset.tool = name;
    created.dataset.control = control;
    created.disabled = busy;
    if (accessibleName) created.setAttribute("aria-label", accessibleName);
    created.addEventListener("click", action);
    return created;
  };

  function openPrompt(
    title: string,
    hint: string,
    prompt: string,
    from: HTMLElement,
  ) {
    opener = from;
    dialogTitle.textContent = title;
    dialogHint.textContent = hint;
    dialogText.value = prompt;
    dialogStatus.textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialogText.scrollTop = 0;
    dialogCopy.focus();
  }
  function closePrompt() {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
  dialog.addEventListener("close", () => {
    dialogText.value = "";
    // The button that opened the panel may have been rendered again since.
    const target =
      opener?.isConnected === true
        ? opener
        : opener?.dataset.tool
          ? groups.querySelector<HTMLElement>(
              `[data-tool="${opener.dataset.tool}"][data-control="agent"]`,
            )
          : null;
    opener = null;
    // The agent's button of a `launchpad` tool sits behind "Details".
    const holder = target?.closest("details");
    if (holder && !holder.open) holder.open = true;
    target?.focus();
  });
  dialogClose.addEventListener("click", closePrompt);
  dialogCopy.addEventListener("click", async () => {
    const copy = options.copy();
    try {
      await navigator.clipboard.writeText(dialogText.value);
      dialogStatus.textContent = copy.toolsCopied;
    } catch {
      dialogText.focus();
      dialogText.select();
      dialogStatus.textContent = copy.toolsCopyFailed;
    }
  });
  mcpButton.addEventListener("click", () => {
    if (!overview) return;
    const copy = options.copy();
    openPrompt(
      copy.toolsMcpAction,
      copy.toolsMcpPromptHint,
      overview.mcpPrompt,
      mcpButton,
    );
  });

  // The curated install and login of one tool in the dialog (decision
  // F19). The browser holds the login through its session handle; closing
  // the dialog cancels a running login. Everything shown is text, the QR
  // code an image of the server's own drawing.
  type Flow = {
    tool: ToolOverview;
    /** Install and sign in, sign in, or link the SSH key of a signed-in gh. */
    mode: "install" | "login" | "ssh";
    install: boolean;
    /** "Link SSH key" had to show a device code to widen the sign-in. */
    refresh: boolean;
    phase: LoginPhase;
    failedAt: "installing" | "waiting" | "linking";
    handle: string | null;
    timer: ReturnType<typeof setTimeout> | null;
    turn: number;
    challenge: string | null;
    qr: HTMLImageElement | null;
  };
  let flow: Flow | null = null;
  let loginOpener: { name: string; control: string } | null = null;

  function renderSteps() {
    if (flow === null) return;
    const copy = options.copy();
    const keys = {
      done: "toolsStepDone",
      current: "toolsStepCurrent",
      todo: "toolsStepTodo",
      failed: "toolsStepFailed",
    } as const;
    loginStepList.replaceChildren(
      ...loginSteps(
        loginStepOrder({
          mode:
            flow.mode === "ssh" ? "ssh" : flow.install ? "install" : "login",
          tool: flow.tool.name,
          refresh: flow.refresh,
        }),
        flow.phase,
        flow.failedAt,
        copy,
      ).map((step) => {
        const item = element(
          "li",
          "",
          fill(copy[keys[step.state]], { step: step.label }),
        );
        item.dataset.state = step.state;
        if (step.state === "current") item.setAttribute("aria-current", "step");
        return item;
      }),
    );
  }
  function phase(next: LoginPhase, status: string) {
    if (flow === null) return;
    flow.phase = next;
    renderSteps();
    if (loginStatus.textContent !== status) loginStatus.textContent = status;
  }
  function stopPolling() {
    if (flow?.timer) clearTimeout(flow.timer);
    if (flow) flow.timer = null;
  }

  function openLogin(tool: ToolOverview, mode: "install" | "login" | "ssh") {
    const copy = options.copy();
    loginOpener = {
      name: tool.name,
      control: mode === "ssh" ? "link-ssh" : "curated",
    };
    flow = {
      tool,
      mode,
      install: mode === "install",
      refresh: false,
      phase: "confirm",
      failedAt:
        mode === "install"
          ? "installing"
          : mode === "ssh"
            ? "linking"
            : "waiting",
      handle: null,
      timer: null,
      turn: 0,
      challenge: null,
      qr: null,
    };
    loginTitle.textContent = fill(
      mode === "install"
        ? copy.toolsLoginTitleInstall
        : mode === "ssh"
          ? copy.toolsLoginTitleSsh
          : copy.toolsLoginTitle,
      { name: tool.name },
    );
    loginStatus.textContent = "";
    loginBody.replaceChildren();
    if (typeof loginDialog.showModal === "function") loginDialog.showModal();
    else loginDialog.setAttribute("open", "");
    loginTitle.focus();
    if (overview?.sharedEnvironment === true) {
      // Everyone on a shared Environment uses what is signed in here.
      phase("confirm", copy.toolsShared);
      const go = element("button", "", copy.toolsLoginContinue);
      go.type = "button";
      go.addEventListener("click", () => void begin());
      const warning = element("p", "tools-warning", copy.toolsShared);
      const row = element("p", "tool-actions");
      row.append(go);
      loginBody.replaceChildren(warning, row);
      go.focus();
      return;
    }
    void begin();
  }

  async function begin() {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    const name = current.tool.name;
    if (current.install) {
      current.failedAt = "installing";
      phase("installing", fill(copy.toolsInstalling, { name }));
      loginBody.replaceChildren(
        element("p", "", fill(copy.toolsInstalling, { name })),
      );
      let value: unknown = null;
      try {
        ({ value } = await options.post("/api/tools/install", { tool: name }));
      } catch {}
      if (flow !== current) return;
      const outcome = installOutcome(value, name, copy);
      if (!outcome.ok) return loginFailed(outcome.message, outcome.agent);
      current.install = true;
      loginBody.replaceChildren(element("p", "", outcome.message));
    }
    await startLogin();
  }

  async function startLogin(phone?: string) {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    stopPolling();
    const ssh = current.mode === "ssh";
    current.failedAt = ssh ? "linking" : "waiting";
    current.challenge = null;
    current.qr = null;
    current.refresh = false;
    const turn = ++current.turn;
    // The status names the step; the detail, never the same sentence, says
    // what happens and how long at most.
    const progress = loginProgress(null, copy);
    phase(ssh ? "linking" : "waiting", progress.status);
    if (
      !ssh &&
      progress.detail !== null &&
      (loginBody.childElementCount === 0 || phone === undefined)
    )
      loginBody.append(element("p", "tools-muted", progress.detail));
    const answer = await answerWithin(
      options.post("/api/tools/login/start", {
        tool: current.tool.name,
        ...(phone === undefined ? {} : { phone }),
        ...(ssh ? { sshKey: true } : {}),
      }),
      loginAnswerMs,
    );
    if (flow !== current || current.turn !== turn) return;
    if (!answer.answered) return loginFailed(copy.toolsLoginNoAnswer, false);
    accept(answer.value);
  }

  function schedulePoll() {
    const current = flow;
    if (current === null || current.handle === null) return;
    const turn = current.turn;
    const handle = current.handle;
    current.timer = setTimeout(async () => {
      const answer = await answerWithin(
        options.post("/api/tools/login/poll", {
          tool: current.tool.name,
          session: handle,
        }),
        loginAnswerMs,
      );
      if (flow !== current || current.turn !== turn) return;
      if (!answer.answered) {
        // The session is not left running without anyone to watch it.
        void options
          .post("/api/tools/login/cancel", {
            tool: current.tool.name,
            session: handle,
          })
          .catch(() => undefined);
        return loginFailed(options.copy().toolsLoginNoAnswer, false);
      }
      accept(answer.value);
    }, 2_000);
  }

  function accept(value: unknown) {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    const state = parseLoginState(value);
    if (state === null || state.tool !== current.tool.name)
      return loginFailed(copy.toolsLoginUnreadable, false);
    if (state.kind === "pending") {
      current.handle = state.session;
      if (state.step === "ssh-key") {
        // Signed in: the SSH key of this Machine is being linked.
        current.failedAt = "linking";
        if (current.challenge !== "linking") {
          current.challenge = "linking";
          current.qr = null;
          // The status line carries the sentence; the body stays empty.
          loginBody.replaceChildren();
        }
        phase("linking", copy.toolsLoginLinking);
      } else {
        if (current.mode === "ssh" && state.challenge !== undefined)
          current.refresh = true;
        current.failedAt = "waiting";
        // Nothing to act on yet: the status still says it is starting and
        // the detail below stays.
        phase("waiting", loginProgress(state, copy).status);
        showChallenge(state);
      }
      schedulePoll();
      return;
    }
    current.handle = null;
    if (state.kind === "signed-in") return signedIn(state);
    const end = loginEndMessage(state, copy);
    loginFailed(end.message, end.agent);
  }

  // Draws the challenge once; a rotated QR code only replaces the image, so
  // a phone number being typed stays where it is.
  function showChallenge(state: Extract<LoginView, { kind: "pending" }>) {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    const challenge = state.challenge;
    if (challenge === undefined) return;
    const key =
      challenge.kind === "qr" || challenge.kind === "pair-code"
        ? `${challenge.kind}:${challenge.sequence}`
        : `${challenge.kind}:${challenge.kind === "url" ? challenge.url : challenge.code}`;
    if (current.challenge === key) return;
    const previous = current.challenge;
    current.challenge = key;
    if (
      challenge.kind === "qr" &&
      previous?.startsWith("qr:") &&
      current.qr?.isConnected === true
    ) {
      const source = qrImageSource(state.qrSvg);
      if (source !== null) current.qr.src = source;
      return;
    }
    const code = (value: string, label: string) => {
      const box = element("p", "tools-code");
      box.setAttribute("aria-label", `${label}: ${value.split("").join(" ")}`);
      box.textContent = value;
      return box;
    };
    const link = (href: string, label: string) => {
      const anchor = element("a", "", label);
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      const row = element("p", "");
      row.append(anchor);
      return row;
    };
    if (challenge.kind === "device-code") {
      const url = loginLink(challenge.url, "github.com");
      loginBody.replaceChildren(
        element(
          "p",
          "",
          current.mode === "ssh"
            ? copy.toolsLoginRefreshText
            : copy.toolsLoginGhText,
        ),
        element("p", "tools-muted", copy.toolsLoginCodeLabel),
        code(challenge.code, copy.toolsLoginCodeLabel),
        ...(url === null ? [] : [link(url, copy.toolsLoginGhLink)]),
      );
      return;
    }
    if (challenge.kind === "url") {
      const url = loginLink(challenge.url, "dashboard.composio.dev");
      loginBody.replaceChildren(
        element("p", "", copy.toolsLoginComposioText),
        ...(url === null ? [] : [link(url, copy.toolsLoginComposioLink)]),
      );
      return;
    }
    if (challenge.kind === "pair-code") {
      const again = element("button", "", copy.toolsLoginQrAgain);
      again.type = "button";
      again.addEventListener("click", () => void startLogin());
      const row = element("p", "tool-actions");
      row.append(again);
      const label = fill(copy.toolsLoginPairLabel, { phone: challenge.phone });
      loginBody.replaceChildren(
        element("p", "", copy.toolsLoginPairText),
        element("p", "tools-muted", label),
        code(challenge.code, label),
        row,
      );
      return;
    }
    const source = qrImageSource(state.qrSvg);
    const image = element("img", "tools-qr");
    image.alt = copy.toolsLoginQrAlt;
    image.width = 280;
    image.height = 280;
    if (source !== null) image.src = source;
    current.qr = image;
    loginBody.replaceChildren(
      element("p", "", copy.toolsLoginQrText),
      source === null
        ? element("p", "tools-warning", copy.toolsLoginUnreadable)
        : image,
      phoneForm(),
    );
  }

  function phoneForm(): HTMLElement {
    const copy = options.copy();
    const form = element("form", "tools-phone");
    const title = element("p", "", copy.toolsLoginPhoneTitle);
    const label = element("label", "", copy.toolsLoginPhoneLabel);
    const input = element("input", "");
    input.type = "tel";
    input.id = "tools-login-phone";
    input.autocomplete = "tel";
    input.inputMode = "tel";
    input.maxLength = 32;
    label.htmlFor = input.id;
    const problem = element("p", "tool-note-problem");
    problem.setAttribute("aria-live", "polite");
    const submit = element("button", "", copy.toolsLoginPhoneAction);
    submit.type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const number = input.value.trim();
      if (!/^\+?[0-9 ().-]{7,24}$/.test(number)) {
        problem.textContent = copy.toolsLoginPhoneInvalid;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      void startLogin(number.startsWith("+") ? number : `+${number}`);
    });
    const row = element("p", "tool-actions");
    row.append(submit);
    form.append(title, label, input, problem, row);
    return form;
  }

  function signedIn(state: LoginView) {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    stopPolling();
    // gh: signed in is complete only with the SSH key linked (decision F19,
    // addendum 2026-09-28); otherwise the linking step did not finish.
    const ssh = sshOutcome(state, copy);
    if (ssh !== null && !ssh.linked) {
      current.failedAt = "linking";
      loginFailed(`${ssh.message} ${ssh.detail}`, true);
      void refresh({ signIn: true });
      return;
    }
    if (ssh !== null) {
      phase("signed-in", ssh.message);
      loginBody.replaceChildren(element("p", "tools-muted", ssh.detail));
      void refresh({ signIn: true });
      return;
    }
    const message = signedInMessage(state, copy);
    phase("signed-in", message);
    // The status line above already says it; the body adds what follows.
    loginBody.replaceChildren(
      ...(current.tool.name === "wacli" &&
      !(state.kind === "signed-in" && state.already === true)
        ? [element("p", "tools-muted", copy.toolsLoginWacliSync)]
        : []),
    );
    if (current.tool.name === "composio") void organizations();
    // The card's sign-in line follows.
    void refresh({ signIn: true });
  }

  async function organizations() {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    const box = element("div", "tools-orgs");
    const status = element("p", "tools-muted", copy.toolsComposioOrgLoading);
    status.setAttribute("aria-live", "polite");
    box.append(status);
    loginBody.append(box);
    let value: unknown = null;
    try {
      ({ value } = await options.post("/api/tools/composio/organizations", {}));
    } catch {}
    if (flow !== current) return;
    const choices = organizationChoices(value, copy);
    if (choices === null || choices.length === 0) {
      status.textContent = copy.toolsComposioOrgUnavailable;
      return;
    }
    const select = element("select", "");
    select.id = "tools-login-org";
    const label = element("label", "", copy.toolsComposioOrgLabel);
    label.htmlFor = select.id;
    for (const choice of choices)
      select.append(new Option(choice.label, choice.id, false, choice.current));
    const hint = element("p", "tools-muted", copy.toolsComposioOrgHint);
    hint.id = "tools-login-org-hint";
    select.setAttribute("aria-describedby", hint.id);
    status.textContent = "";
    select.addEventListener("change", async () => {
      const chosen = choices.find((choice) => choice.id === select.value);
      if (chosen === undefined) return;
      select.disabled = true;
      let answer: unknown = null;
      try {
        ({ value: answer } = await options.post(
          "/api/tools/composio/organization",
          { id: chosen.id },
        ));
      } catch {}
      if (flow !== current) return;
      select.disabled = false;
      const selected =
        answer !== null &&
        typeof answer === "object" &&
        (answer as { kind?: unknown }).kind ===
          "composio-organization-selected";
      status.textContent = selected
        ? fill(copy.toolsComposioOrgSaved, {
            name: chosen.label.replace(/ \(.*\)$/, ""),
          })
        : copy.toolsComposioOrgFailed;
      if (selected) void refresh({ signIn: true });
    });
    box.replaceChildren(label, select, hint, status);
  }

  function loginFailed(message: string, agent: boolean) {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    stopPolling();
    current.handle = null;
    phase("failed", message);
    const row = element("p", "tool-actions");
    if (agent) {
      const finish = element("button", "", copy.toolsFinishWithAgent);
      finish.type = "button";
      finish.addEventListener("click", () => {
        const tool = current.tool;
        loginDialog.close();
        const from =
          groups.querySelector<HTMLElement>(
            `[data-tool="${tool.name}"][data-control="agent"]`,
          ) ?? mcpButton;
        openPrompt(
          fill(copy.toolsPromptTitle, { name: tool.name }),
          copy.toolsPromptHint,
          tool.prompt,
          from,
        );
      });
      row.append(finish);
    }
    const again = element("button", "", copy.toolsLoginTryAgain);
    again.type = "button";
    again.addEventListener("click", () => {
      // Signed in already: trying again links the SSH key only.
      if (current.failedAt === "linking") {
        current.mode = "ssh";
        current.install = false;
      }
      void begin();
    });
    row.append(again);
    loginBody.replaceChildren(
      ...(agent ? [element("p", "tools-muted", copy.toolsAgentFallback)] : []),
      row,
    );
    (row.firstElementChild as HTMLElement | null)?.focus();
  }

  loginClose.addEventListener("click", () => loginDialog.close());
  loginDialog.addEventListener("close", () => {
    const current = flow;
    flow = null;
    if (current !== null) {
      if (current.timer) clearTimeout(current.timer);
      // Closing the dialog ends a running login and its tool.
      if (current.handle !== null)
        void options
          .post("/api/tools/login/cancel", {
            tool: current.tool.name,
            session: current.handle,
          })
          .catch(() => undefined);
    }
    // No code, link or QR stays in the page.
    loginBody.replaceChildren();
    loginStepList.replaceChildren();
    loginStatus.textContent = "";
    const target = loginOpener;
    loginOpener = null;
    // The row is read again after a sign-in and its buttons are disabled
    // meanwhile: the render after that read places the focus.
    if (target !== null && !dialog.open)
      if (busy) focus = target;
      else focusRow(target);
  });

  // "Install" of gh on a Team Environment (Matěj 2026-09-28): the
  // installation alone, no sign-in afterwards.
  async function installOnly(tool: ToolOverview) {
    if (busy) return;
    const copy = options.copy();
    busy = true;
    notice = null;
    render();
    say(fill(copy.toolsInstalling, { name: tool.name }));
    let value: unknown = null;
    try {
      ({ value } = await options.post("/api/tools/install", {
        tool: tool.name,
      }));
    } catch {}
    busy = false;
    const outcome = teamInstallOutcome(value, tool.name, copy);
    notice = { name: tool.name, outcome, undo: null };
    say(outcome.message);
    focus = { name: tool.name, control: "curated" };
    await refresh({ signIn: true });
  }

  async function logout(tool: ToolOverview) {
    if (busy) return;
    const copy = options.copy();
    busy = true;
    notice = null;
    render();
    say(copy.toolsBusy);
    let value: unknown = null;
    try {
      ({ value } = await options.post("/api/tools/logout", {
        tool: tool.name,
      }));
    } catch {}
    busy = false;
    const outcome = logoutOutcome(value, tool.name, copy);
    notice = { name: tool.name, outcome, undo: null };
    say(outcome.message);
    focus = { name: tool.name, control: "curated" };
    await refresh({ signIn: true });
  }

  function noteEditor(tool: ToolOverview, copy: Copy): HTMLElement {
    if (!takesNote(tool))
      return element("p", "tools-muted", copy.toolsNoteAfterEnable);
    const box = element("div", "tool-note");
    const id = `tool-note-${tool.name}`;
    const label = element("label", "", copy.toolsNoteLabel);
    label.htmlFor = id;
    const hint = element("p", "tools-muted", copy.toolsNoteHint);
    hint.id = `${id}-hint`;
    const area = element("textarea", "");
    area.id = id;
    area.rows = 3;
    area.spellcheck = true;
    area.value = drafts.get(tool.name) ?? tool.note ?? "";
    area.dataset.tool = tool.name;
    area.dataset.control = "note";
    const count = element("p", "tools-muted");
    count.id = `${id}-count`;
    const problem = element("p", "tool-note-problem");
    problem.setAttribute("aria-live", "polite");
    area.setAttribute("aria-describedby", `${hint.id} ${count.id}`);
    const save = button(
      copy.toolsNoteSave,
      tool.name,
      "note-save",
      () => {
        const view = noteDraftView(area.value, tool.note, options.copy());
        if (view.savable) void saveNote(tool, view.note);
      },
      fill(copy.toolsNoteSaveNamed, { name: tool.name }),
    );
    const clear = button(
      copy.toolsNoteClear,
      tool.name,
      "note-clear",
      () => void saveNote(tool, undefined),
      fill(copy.toolsNoteClearNamed, { name: tool.name }),
    );
    const update = () => {
      const view = noteDraftView(area.value, tool.note, options.copy());
      count.textContent = view.count;
      problem.textContent = view.problem ?? "";
      area.setAttribute(
        "aria-invalid",
        view.problem === null ? "false" : "true",
      );
      save.disabled = busy || !view.savable;
      clear.disabled = busy || tool.note === undefined;
    };
    area.addEventListener("input", () => {
      drafts.set(tool.name, area.value);
      update();
    });
    update();
    const actions = element("p", "tool-actions");
    actions.append(save, clear);
    box.append(label, hint, area, count, problem, actions);
    return box;
  }

  // One settings row per tool (the row pattern of T3 Code's settings): name,
  // purpose and state on the left, the one action and the switch on the
  // right; the path, what agents are told, the note and the agent's prompt
  // behind "Details".
  function card(tool: ToolOverview, copy: Copy): HTMLLIElement {
    const item = element("li", "row");
    item.dataset.tool = tool.name;
    const main = element("div", "row-main");
    const text = element("div", "row-copy");
    const title = element("h3", "row-title", tool.name);
    if (tool.command !== tool.name)
      title.append(element("code", "", tool.command));
    text.append(title, element("p", "row-desc", tool.purpose));

    const view = toolStatusView(tool, copy, overview?.hosted === true);
    const status = element("p", "row-status");
    const headline = element("span", "tool-state", view.headline);
    headline.dataset.state = view.state;
    const separator = element("span", "", " · ");
    separator.setAttribute("aria-hidden", "true");
    // The sign-in, and for gh the SSH key as its own part of the same line
    // (version · signed in as X · SSH key linked), so a key that is not
    // linked can carry the warning colour.
    const ssh = tool.signIn?.ssh;
    // On a Team Environment gh working as the Organization's App identity
    // reads "Works as lazurio-for-github[bot]".
    const team = overview?.sharedEnvironment === true;
    const who =
      tool.signIn === undefined || ssh === undefined
        ? signInLine(tool, copy, team)
        : signInLine(
            {
              ...tool,
              signIn: {
                state: tool.signIn.state,
                ...(tool.signIn.account === undefined
                  ? {}
                  : { account: tool.signIn.account }),
                ...(tool.signIn.organization === undefined
                  ? {}
                  : { organization: tool.signIn.organization }),
                ...(tool.signIn.identity === undefined
                  ? {}
                  : { identity: tool.signIn.identity }),
              },
            },
            copy,
            team,
          );
    const signIn = element("span", "tool-signin", who);
    signIn.dataset.state = tool.signIn?.state ?? "unchecked";
    status.append(headline, separator, signIn);
    if (ssh !== undefined) {
      const dot = element("span", "", " · ");
      dot.setAttribute("aria-hidden", "true");
      // A Team Environment works in GitHub through Lazurio for GitHub: its
      // gh line says so instead of inviting a person to link a key.
      const key = element(
        "span",
        "tool-ssh",
        overview?.sharedEnvironment === true
          ? copy.toolsSshTeam
          : ssh.state === "linked"
            ? copy.toolsSshLinked
            : ssh.state === "not-linked"
              ? copy.toolsSshNotLinked
              : copy.toolsSshUnknown,
      );
      key.dataset.state =
        overview?.sharedEnvironment === true ? "team" : ssh.state;
      status.append(dot, key);
    }
    text.append(status);
    for (const note of view.notes)
      text.append(element("p", "row-status tool-attention", note));
    if (tool.name === "gh" && overview?.sharedEnvironment === true) {
      // Not a warning here: a Team Environment is not signed in personally.
      signIn.dataset.state = "team";
      text.append(element("p", "tool-team", copy.toolsTeamGithub));
    }

    const agent = button(
      copy.toolsAgentAction,
      tool.name,
      "agent",
      () =>
        openPrompt(
          fill(copy.toolsPromptTitle, { name: tool.name }),
          copy.toolsPromptHint,
          tool.prompt,
          agent,
        ),
      fill(copy.toolsAgentActionNamed, { name: tool.name }),
    );
    // The prompt is text already on the page; reading it is never blocked.
    agent.disabled = false;

    const controls = element("div", "row-control");
    // The curated flow of a `launchpad` tool (decision F19): install and
    // sign in, sign in, or sign out. A tool an agent sets up has the agent's
    // prompt as its action instead.
    // A Team Environment works in GitHub through Lazurio for GitHub, set up
    // by the Organization (Matěj 2026-09-28): its gh row offers no
    // personal sign-in or SSH key, only "Install" when gh is missing, and
    // "Sign out" only while a person's account is signed in there; a
    // sentence says why.
    const curated = curatedActions(tool, copy, team);
    const primary = curated.primary;
    if (primary !== null)
      controls.append(
        button(
          primary.label,
          tool.name,
          "curated",
          () =>
            primary.mode === "install-only"
              ? void installOnly(tool)
              : openLogin(tool, primary.mode),
          fill(
            primary.mode === "install"
              ? copy.toolsInstallActionNamed
              : primary.mode === "install-only"
                ? copy.toolsInstallOnlyNamed
                : copy.toolsSignInActionNamed,
            { name: tool.name },
          ),
        ),
      );
    // A signed-in gh whose SSH key is not linked (F19 addendum 2026-09-28):
    // "Link SSH key" is the row's primary action, before "Sign out".
    if (curated.linkSsh) {
      const link = button(
        copy.toolsLinkSshAction,
        tool.name,
        "link-ssh",
        () => openLogin(tool, "ssh"),
        fill(copy.toolsLinkSshNamed, { name: tool.name }),
      );
      link.className = "primary";
      controls.append(link);
    }
    if (curated.logout) {
      const signOut = button(
        copy.toolsSignOutAction,
        tool.name,
        "logout",
        () => void logout(tool),
        fill(copy.toolsSignOutNamed, { name: tool.name }),
      );
      signOut.className = "destructive";
      controls.append(signOut);
    }
    if (tool.setup !== "launchpad") controls.append(agent);
    if (tool.tier === "required")
      controls.append(element("span", "always-on", copy.toolsAlwaysOn));
    else {
      // "Used by agents": the switch guides agents to the tool; installing
      // and signing in are separate acts (the section's intro says so once).
      // Its accessible name holds the visible label and names the tool.
      const enable = !tool.enabled;
      const toggler = button(
        "",
        tool.name,
        "toggle",
        () => void toggle(tool, enable),
        fill(copy.toolsSwitchNamed, { name: tool.name }),
      );
      toggler.className = "switch";
      toggler.setAttribute("role", "switch");
      toggler.setAttribute("aria-checked", String(tool.enabled));
      const label = element("span", "switch-label", copy.toolsSwitchLabel);
      label.setAttribute("aria-hidden", "true");
      label.addEventListener("click", () => toggler.click());
      const field = element("span", "switch-field");
      field.append(label, toggler);
      controls.append(field);
    }
    main.append(text, controls);
    item.append(main);

    const details = element("details", "row-details");
    details.open = opened.has(tool.name);
    details.addEventListener("toggle", () => {
      if (details.open) opened.add(tool.name);
      else opened.delete(tool.name);
    });
    const summary = element("summary", "", copy.toolsDetails);
    summary.setAttribute(
      "aria-label",
      fill(copy.toolsDetailsNamed, { name: tool.name }),
    );
    const body = element("div", "details-body");
    if (view.path !== null) {
      const where = element("section", "");
      where.append(
        element("h4", "", copy.toolsPathLabel),
        element("p", "tool-path", view.path),
      );
      body.append(where);
    }
    const usage = element("section", "");
    usage.append(
      element("h4", "", copy.toolsUsage),
      element("p", "tools-muted", copy.toolsUsageCatalog),
      element("p", "usage", tool.usage),
    );
    const link = sourceLink(tool.source);
    if (link !== null) {
      const source = element("p", "tools-muted");
      const anchor = element("a", "", copy.toolsSource);
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      source.append(anchor);
      usage.append(source);
    }
    body.append(usage, noteEditor(tool, copy));
    // The agent's fallback of a `launchpad` tool; on a Team Environment the
    // server hands gh's Team prompt, which signs nobody in.
    if (tool.setup === "launchpad") {
      const fallback = element("section", "");
      const row = element("p", "tool-actions");
      row.append(agent);
      fallback.append(
        element("h4", "", copy.toolsAgentAction),
        element("p", "tools-muted", copy.toolsAgentFallback),
        row,
      );
      body.append(fallback);
    }
    details.append(summary, body);

    if (notice?.name === tool.name) {
      const message = element("div", "tool-message");
      message.dataset.kind = notice.outcome.kind;
      message.append(element("p", "", notice.outcome.message));
      if (notice.outcome.shared === true)
        message.append(element("p", "", copy.toolsShared));
      const choices = element("p", "tool-actions");
      const undo = notice.undo;
      if (undo !== null)
        choices.append(
          button(
            copy.toolsUndo,
            tool.name,
            "undo",
            () =>
              void change(
                { name: tool.name, action: "undo", installed: tool.installed },
                undo,
                undo.expectedRevision,
              ),
            fill(copy.toolsUndoNamed, { name: tool.name }),
          ),
        );
      if (notice.outcome.reload)
        choices.append(
          button(copy.toolsReload, tool.name, "reload", () => {
            notice = null;
            focus = { name: tool.name, control: "toggle" };
            void reloadPage();
          }),
        );
      if (choices.childElementCount > 0) message.append(choices);
      item.append(message);
    }
    item.append(details);
    return item;
  }

  function render() {
    const copy = options.copy();
    refreshButton.disabled = busy;
    mcpButton.disabled = overview === null;
    shared.hidden = overview?.sharedEnvironment !== true;
    if (overview === null) {
      groups.replaceChildren(
        element(
          "p",
          failed ? "tools-warning" : "tools-muted",
          failed ? copy.toolsLoadFailed : copy.toolsLoading,
        ),
      );
      return;
    }
    groups.replaceChildren(
      ...toolGroups(overview.tools, copy).map((group) => {
        const section = element("section", "group");
        const heading = element("h2", "", group.title);
        heading.id = `tools-group-${group.tier}`;
        section.setAttribute("aria-labelledby", heading.id);
        const head = element("div", "group-head");
        head.append(heading, element("p", "group-note", group.note));
        const list = element("ul", "card tools-list");
        list.setAttribute("aria-labelledby", heading.id);
        list.replaceChildren(...group.tools.map((tool) => card(tool, copy)));
        section.append(head, list);
        return section;
      }),
    );
    // A control is disabled while the panel is busy and cannot take the
    // focus then; the render after the read places it.
    if (focus !== null && !busy) {
      focusRow(focus);
      focus = null;
    }
  }

  // The named control of a tool's row or, when a sign-in or sign-out
  // replaced it (Sign in became Sign out), the row's first action.
  function focusRow(target: { name: string; control: string }) {
    (
      groups.querySelector<HTMLElement>(
        `[data-tool="${target.name}"][data-control="${target.control}"]`,
      ) ??
      groups.querySelector<HTMLElement>(
        `li[data-tool="${target.name}"] .row-control button`,
      )
    )?.focus();
  }

  function say(message: string) {
    announce.textContent = message;
  }

  /** Reads the tools again. `signIn` asks for the sign-in probes, which may
   * contact the providers: by default only the first read does. */
  async function refresh(
    request: Readonly<{ signIn?: boolean }> = {},
  ): Promise<void> {
    const copy = options.copy();
    const turn = ++sequence;
    const probe = request.signIn ?? !signInChecked;
    busy = true;
    if (overview === null) failed = false;
    render();
    try {
      const { value, ok } = await options.post(
        "/api/tools/status",
        probe ? { signIn: true } : {},
      );
      if (turn !== sequence) return;
      const parsed = ok ? parseToolsOverview(value) : null;
      if (parsed === null) throw new Error("Tools unavailable");
      if (probe) {
        signInChecked = true;
        signIns.clear();
        for (const tool of parsed.tools)
          if (tool.signIn !== undefined) signIns.set(tool.name, tool.signIn);
      }
      const known = (tool: ToolOverview) => signIns.get(tool.name);
      overview = {
        ...parsed,
        tools: parsed.tools.map((tool) => {
          const signIn = tool.signIn ?? known(tool);
          return signIn === undefined ? tool : { ...tool, signIn };
        }),
      };
      failed = false;
      checked.textContent = fill(options.copy().toolsChecked, {
        revision: String(parsed.revision),
        time: new Date().toLocaleTimeString(parsed.locale, {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    } catch {
      if (turn !== sequence) return;
      overview = null;
      failed = true;
      checked.textContent = "";
      say(copy.toolsLoadFailed);
    } finally {
      if (turn === sequence) {
        busy = false;
        render();
        options.observed(overview);
      }
    }
  }

  // The whole page reads the Folder again; its reload refreshes this panel.
  async function reloadPage() {
    try {
      await options.changed();
    } catch {
      await refresh();
    }
  }

  // The state the page shows, as a request would restore it.
  function shown(tools: readonly ToolOverview[]): Selection {
    return {
      tools: tools
        .filter((tool) => tool.tier !== "required" && tool.enabled)
        .map((tool) => tool.name)
        .sort(),
      notes: currentNotes(tools),
    };
  }

  // One click, one recorded change at the revision the page shows. Without
  // `notes` the server keeps the recorded notes of the tools that stay on.
  async function change(
    what: ToolChange,
    request: Readonly<{
      tools: readonly string[];
      notes?: Readonly<Record<string, string>>;
    }>,
    expectedRevision: number,
  ) {
    if (busy || overview === null) return;
    const copy = options.copy();
    const before = shown(overview.tools);
    busy = true;
    notice = null;
    render();
    say(copy.toolsBusy);
    let outcome: ToolChangeOutcome;
    try {
      const { value } = await options.post("/api/tools/update", {
        expectedRevision,
        tools: request.tools,
        ...(request.notes === undefined ? {} : { notes: request.notes }),
      });
      outcome = toolChangeOutcome(value, what, copy);
    } catch {
      // A lost answer does not say the change was not written.
      outcome = toolChangeOutcome(null, what, copy);
    }
    busy = false;
    notice = {
      name: what.name,
      outcome,
      undo:
        outcome.kind === "updated" && outcome.revision !== undefined
          ? { ...before, expectedRevision: outcome.revision }
          : null,
    };
    if (outcome.kind === "updated") drafts.delete(what.name);
    focus = {
      name: what.name,
      control:
        outcome.kind === "updated"
          ? "undo"
          : outcome.reload
            ? "reload"
            : "toggle",
    };
    say(outcome.message);
    if (outcome.kind === "updated") await reloadPage();
    else render();
  }

  function toggle(tool: ToolOverview, enable: boolean) {
    if (overview === null) return;
    return change(
      {
        name: tool.name,
        action: enable ? "enable" : "disable",
        installed: tool.installed,
      },
      { tools: nextSelection(overview.tools, tool.name, enable) },
      overview.revision,
    );
  }

  function saveNote(tool: ToolOverview, note: string | undefined) {
    if (overview === null) return;
    return change(
      {
        name: tool.name,
        action: note === undefined ? "note-clear" : "note-save",
        installed: tool.installed,
      },
      {
        tools: shown(overview.tools).tools,
        notes: nextNotes(overview.tools, tool.name, note),
      },
      overview.revision,
    );
  }

  refreshButton.addEventListener("click", () => {
    notice = null;
    void refresh({ signIn: true });
  });
  render();
  return { refresh };
}
