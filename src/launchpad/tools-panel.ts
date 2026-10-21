import { composioDashboard } from "../integrations/composio-source";
import { executorToolName, vaultToolName } from "../tools/catalog";
import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { ToolSignIn } from "../tools/status";
import {
  composioNameStep,
  composioScene,
  composioStepMarker,
} from "./composio-scene";
import { createExecutorPanel } from "./executor-panel";
import type { MessageKey } from "./messages";
import { integrationsPath } from "./routes";
import {
  answerWithin,
  autoEnable,
  type ComposioDialogView,
  composioConnectedLine,
  composioDialogView,
  composioPollDelay,
  composioPollNext,
  composioSignInText,
  connectionLine,
  createLoginPoll,
  curatedActions,
  currentNotes,
  gitIdentityNote,
  installOutcome,
  type LoginFlowState,
  type LoginPhase,
  type LoginPoll,
  type LoginView,
  loginAnswerMs,
  loginCancelOffered,
  loginCloseAction,
  loginEndMessage,
  loginFlowState,
  loginLink,
  loginPollGivenUp,
  loginProgress,
  loginStepOrder,
  loginSteps,
  loginTitle,
  logoutOutcome,
  nextNotes,
  nextSelection,
  noteDraftView,
  noticeHolds,
  organizationDetails,
  organizationView,
  parseLoginState,
  parseToolsOverview,
  qrImageSource,
  signedInMessage,
  signInMode,
  sourceLink,
  sshOutcome,
  type ToolChange,
  type ToolGuideTargets,
  type ToolNotice,
  takesNote,
  teamInstallOutcome,
  toolChangeOutcome,
  toolDescription,
  toolGroups,
  toolGuideTargets,
  toolNoticeView,
  toolStatusView,
  updateAction,
  updateOutcome,
} from "./tools-view";
import { fill } from "./update-view";
import { createVaultPanel } from "./vault-panel";

type Copy = Readonly<Record<MessageKey, string>>;
type Post = (
  path: string,
  body: unknown,
) => Promise<{ value: unknown; ok: boolean }>;

// The tools section of the page (decision F18). The server derives every
// fact; the browser shows it as text and sends back the full next selection
// (and, for a note, the full next set of notes) with the revision it showed.
// One click applies a change; the confirmation on the card says it in plain
// words and offers Undo, which restores the state before it. It is said
// from the tool as the page shows it at every render and ends with the next
// act on that tool, so it never contradicts the row (Matěj 2026-10-09); the
// technical part of a notice is in the tool's Details.
export function createToolsPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
    /** Share the same observation with Apps, including failed reads. */
    observed: (overview: ToolsOverview | null) => void;
    /** Called after the tools are drawn, with what the guide of the page's
     * "?" can point at now (`toolGuideTargets`), null while the tools are
     * not read (decision F56's addendum (2) of 2026-10-18). */
    drawn?: (targets: ToolGuideTargets | null) => void;
    /** The Folder changed through this panel: the rest of the page reloads,
     * and that reload refreshes this panel too. */
    changed: () => Promise<void>;
    /** Whether this Environment has no Nástroje (a public Environment,
     * decision F55): nothing is read, so nothing is offered. */
    absent?: () => boolean;
    /** A sign-in this page holds started, moved from waiting for the person
     * to finishing, or ended (`running`), its window open or closed (#516):
     * Začínáme says it. */
    signInsChanged?: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing tools UI");
    return element;
  };
  const groups = find<HTMLDivElement>("#tools-groups");
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
  const loginHeading = find<HTMLHeadingElement>("#tools-login-title");
  const loginStepList = find<HTMLOListElement>("#tools-login-steps");
  const loginStatus = find<HTMLParagraphElement>("#tools-login-status");
  const loginBody = find<HTMLDivElement>("#tools-login-body");
  const loginClose = find<HTMLButtonElement>("#tools-login-close");
  const loginFoot = find<HTMLDivElement>("#tools-login-foot");
  const loginCancel = find<HTMLButtonElement>("#tools-login-cancel");
  // The Environment's own vault (decision F53): its own state, read beside
  // the tools; the Environment sets it up itself, and the setup in which the
  // vault becomes ready turns the agents' switch on in the Folder, once per
  // vault (never this page, so a person's "off" stays). A setup this page
  // followed that ends connected may have changed the Folder: the whole page
  // reads it again.
  const vault = createVaultPanel({
    post: options.post,
    copy: options.copy,
    changed: () => render(),
    connected: () => {
      // The setup is the next act on the row: the notice before it ends.
      endNotice(vaultToolName);
      void reloadPage();
    },
  });

  // Executor (decision F44): its own state, read beside the tools; Lazurio
  // sets it up itself, so its row offers Install, Update or Repair, and an
  // agent's prompt for a conflict.
  const executor = createExecutorPanel({
    post: options.post,
    copy: options.copy,
    changed: () => render(),
    settled: () => void refresh(),
    prompt: (title, hint, text, from) => openPrompt(title, hint, text, from),
  });

  type Selection = Readonly<{
    tools: readonly string[];
    notes: Readonly<Record<string, string>>;
  }>;
  let overview: ToolsOverview | null = null;
  let failed = false;
  let busy = false;
  // Shown from the Launchpad's older reading while it reads anew.
  let checking = false;
  let sequence = 0;
  // The sign-ins are probed only on the first read and on Refresh status (a
  // probe may contact the provider); other reads keep the last answer.
  let signInChecked = false;
  const signIns = new Map<string, ToolSignIn>();
  // What the operator typed and did not save yet, and which cards have
  // "What agents are told" open: both survive a re-render.
  const drafts = new Map<string, string>();
  const opened = new Set<string>();
  // The last act on one tool's row (Matěj 2026-10-09). It ends with the next
  // act on that tool, with Refresh status or Reload, and with a reading of
  // another Folder revision (`noticeHolds`), where its Undo would be refused.
  let notice: ToolNotice | null = null;
  function endNotice(name: string) {
    if (notice?.name === name) notice = null;
  }
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

  // The curated install and login of one tool in the dialog (decision F19,
  // its addendum of 2026-10-19, #516). The browser holds each sign-in
  // through its session handle, one per tool. Closing the dialog (its ×,
  // Escape) never ends a sign-in that starts or runs: it is detached
  // (`loginCloseAction`), the page polls on, and its end runs as it would
  // with the dialog open; opening the same tool's sign-in again shows it
  // instead of starting another, which would replace it on the server. Only
  // "Zrušit", offered while a code, link or QR waits for the person
  // (`loginCancelOffered`), cancels. A poll that gets no answer ends
  // nothing: the page asks again until the session's own end has passed.
  // Everything shown is text, the QR code an image of the server's own
  // drawing; a detached sign-in keeps no code, link or QR in the page.
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
    /** The one poll loop of its session (`createLoginPoll`), across its
     * window hiding and showing again. */
    poll: LoginPoll | null;
    /** Composio's reading of its organizations after the sign-in. */
    timer: ReturnType<typeof setTimeout> | null;
    turn: number;
    /** What the dialog draws now (a challenge's key, `linking`), null when
     * nothing is drawn: always null while the dialog is closed. */
    challenge: string | null;
    qr: HTMLImageElement | null;
    /** The status line as last said, drawn again when the dialog shows the
     * sign-in again. */
    status: string;
    /** When the server ends the session by itself at the latest (its
     * `expiresAt`, in ms). */
    expiresAt: number | null;
    /** What `running` last said of it. */
    reported: LoginFlowState | null;
    /** Composio after its sign-in: what its organizations say, read again
     * while the person has something to do in Composio. */
    composio?: ComposioWatch;
  };
  type ComposioWatch = {
    account: string | null;
    /** Readings since the view last changed (the wait grows with them). */
    attempt: number;
    reading: boolean;
    view: ComposioDialogView | null;
    key: string | null;
  };
  /** The sign-ins this page holds, one per tool: the one the dialog shows
   * and those it was closed on while they ran (#516). */
  const flows = new Map<string, Flow>();
  /** The sign-in the dialog shows, while it is open. */
  let flow: Flow | null = null;
  let loginOpener: { name: string; control: string } | null = null;
  /** Still the page's sign-in of its tool. */
  const live = (current: Flow) => flows.get(current.tool.name) === current;
  /** The one the dialog shows now. */
  const visible = (current: Flow) => flow === current;

  /** Its row and Začínáme hear when a sign-in starts, moves on or ends
   * (`running`). */
  function report(current: Flow) {
    const state = live(current) ? loginFlowState(current.phase) : null;
    if (state === current.reported) return;
    current.reported = state;
    render();
    options.signInsChanged?.();
  }

  function renderSteps(current: Flow) {
    if (!visible(current)) return;
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
            current.mode === "ssh"
              ? "ssh"
              : current.install
                ? "install"
                : "login",
          tool: current.tool.name,
          refresh: current.refresh,
        }),
        current.phase,
        current.failedAt,
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
  /** The status line, with the waiting mark while the sign-in is under way
   * (installing, waiting for the person, finishing): it runs, also when
   * the window is closed. */
  function drawStatus(current: Flow) {
    if (!visible(current)) return;
    loginStatus.classList.remove("is-connected");
    const finishing =
      current.phase === "installing" ||
      current.phase === "waiting" ||
      current.phase === "linking";
    if (
      loginStatus.textContent === current.status &&
      (loginStatus.querySelector(".spinner") !== null) === finishing
    )
      return;
    if (!finishing) {
      loginStatus.textContent = current.status;
      return;
    }
    const spinner = element("span", "spinner");
    spinner.setAttribute("aria-hidden", "true");
    loginStatus.replaceChildren(spinner, element("span", "", current.status));
  }
  /** "Zrušit" in the dialog's foot, only while a code, link or QR waits. */
  function drawFoot(current: Flow) {
    if (!visible(current)) return;
    loginFoot.hidden = !loginCancelOffered({
      phase: current.phase,
      challenge: current.challenge !== null && current.challenge !== "linking",
    });
  }
  function phase(current: Flow, next: LoginPhase, status: string) {
    current.phase = next;
    current.status = status;
    renderSteps(current);
    drawStatus(current);
    drawFoot(current);
    report(current);
  }
  function stopPolling(current: Flow) {
    current.poll?.stop();
    current.poll = null;
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
  }

  /** The dialog on `current`, focused on its title. */
  function showDialog(current: Flow) {
    const copy = options.copy();
    flow = current;
    loginOpener = {
      name: current.tool.name,
      control: current.mode === "ssh" ? "link-ssh" : "curated",
    };
    loginHeading.textContent = loginTitle(
      current.tool.name,
      current.mode,
      copy,
    );
    loginClose.title = copy.toolsClose;
    loginStatus.textContent = "";
    loginBody.replaceChildren();
    loginFoot.hidden = true;
    if (typeof loginDialog.showModal === "function") loginDialog.showModal();
    else loginDialog.setAttribute("open", "");
    loginHeading.focus();
  }

  function openLogin(tool: ToolOverview, mode: "install" | "login" | "ssh") {
    // The same tool's sign-in runs already, its window closed meanwhile:
    // show it, never start another, which would replace it (#516).
    const running = flows.get(tool.name);
    if (running !== undefined) {
      reattach(running);
      return;
    }
    const copy = options.copy();
    const current = showLogin(tool, mode);
    if (overview?.sharedEnvironment === true) {
      // Everyone on a shared Environment uses what is signed in here. The
      // dialog's status says it once; the page already shows the same note.
      phase(current, "confirm", copy.toolsShared);
      const go = element("button", "", copy.toolsLoginContinue);
      go.type = "button";
      go.addEventListener("click", () => void begin(current));
      const row = element("p", "tool-actions");
      row.append(go);
      loginBody.replaceChildren(row);
      go.focus();
      return;
    }
    void begin(current);
  }

  /** The dialog of a tool's sign-in, open and empty, with its flow: the
   * page's sign-in of its tool from now on. */
  function showLogin(
    tool: ToolOverview,
    mode: "install" | "login" | "ssh",
  ): Flow {
    const current: Flow = {
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
      poll: null,
      timer: null,
      turn: 0,
      challenge: null,
      qr: null,
      status: "",
      expiresAt: null,
      reported: null,
    };
    flows.set(tool.name, current);
    showDialog(current);
    return current;
  }

  /** The dialog on a sign-in this page runs, its window closed before: its
   * steps and status as they stand, and its state read at once, which
   * draws its code, link or QR again (#516). */
  function reattach(current: Flow) {
    const copy = options.copy();
    current.challenge = null;
    current.qr = null;
    showDialog(current);
    renderSteps(current);
    drawStatus(current);
    if (current.phase === "linking")
      loginBody.replaceChildren(
        element("p", "tools-muted", copy.toolsLoginFinishingDetail),
      );
    // Its state at once, from its one poll loop: an answer under way counts
    // as it comes, and no second loop starts.
    current.poll?.now();
  }

  async function begin(current: Flow) {
    if (!live(current)) return;
    const copy = options.copy();
    const name = current.tool.name;
    if (current.install) {
      current.failedAt = "installing";
      phase(current, "installing", fill(copy.toolsInstalling, { name }));
      if (visible(current))
        loginBody.replaceChildren(
          element("p", "", fill(copy.toolsInstalling, { name })),
        );
      let value: unknown = null;
      try {
        ({ value } = await options.post("/api/tools/install", { tool: name }));
      } catch {}
      const outcome = installOutcome(value, name, copy);
      // The tool is there now, whatever the sign-in does next: its row
      // follows at once, and the notice of the act before this one ends.
      if (outcome.ok) {
        endNotice(name);
        void refresh();
      }
      // Closed while it installed: the sign-in does not start.
      if (!live(current)) return;
      if (!outcome.ok)
        return loginFailed(
          current,
          outcome.message,
          outcome.agent,
          outcome.detail,
        );
      current.install = true;
      if (visible(current))
        loginBody.replaceChildren(
          element("p", "", outcome.message),
          ...(outcome.detail === undefined ? [] : [folded(outcome.detail)]),
        );
    }
    await startLogin(current);
  }

  async function startLogin(current: Flow, phone?: string) {
    if (!live(current)) return;
    const copy = options.copy();
    stopPolling(current);
    const ssh = current.mode === "ssh";
    current.failedAt = ssh ? "linking" : "waiting";
    current.challenge = null;
    current.qr = null;
    current.refresh = false;
    const turn = ++current.turn;
    // The status names the step; the detail, never the same sentence, says
    // what happens and how long at most.
    const progress = loginProgress(null, copy);
    phase(current, ssh ? "linking" : "waiting", progress.status);
    if (
      visible(current) &&
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
    // Closed meanwhile, the sign-in goes on: its answer is taken still.
    if (!live(current) || current.turn !== turn) return;
    if (!answer.answered)
      return loginFailed(current, copy.toolsLoginNoAnswer, false);
    accept(current, answer.value);
  }

  /** The poll loop of the session of the current start: made once, on its
   * first pending answer, and asked to poll on after each answer. */
  function pollOn(current: Flow) {
    if (!live(current) || current.handle === null) return;
    if (current.poll === null) {
      const turn = current.turn;
      const handle = current.handle;
      const loop = createLoginPoll({
        ask: () =>
          answerWithin(
            options.post("/api/tools/login/poll", {
              tool: current.tool.name,
              session: handle,
            }),
            loginAnswerMs,
          ),
        answered: (answer) => {
          if (!live(current) || current.turn !== turn || current.poll !== loop)
            return;
          // A poll without an answer ends nothing (#516): the session goes
          // on by itself on the server, so the page asks again, until the
          // session's own end has surely passed.
          if (!answer.answered || answer.value === null) {
            if (loginPollGivenUp(current.expiresAt, Date.now()))
              return loginFailed(
                current,
                options.copy().toolsLoginNoAnswer,
                false,
              );
            loop.schedule();
            return;
          }
          accept(current, answer.value);
        },
      });
      current.poll = loop;
    }
    current.poll.schedule();
  }

  function accept(current: Flow, value: unknown) {
    if (!live(current)) return;
    const copy = options.copy();
    const state = parseLoginState(value);
    if (state === null || state.tool !== current.tool.name)
      return loginFailed(current, copy.toolsLoginUnreadable, false);
    if (state.kind === "pending") {
      current.handle = state.session;
      const expires = Date.parse(state.expiresAt);
      if (Number.isFinite(expires)) current.expiresAt = expires;
      if (state.step === "ssh-key") {
        // Signed in: the SSH key of this Environment is being linked. The
        // dialog never says connected before the proof passed, and says
        // that its window may be closed.
        current.failedAt = "linking";
        const progress = loginProgress(state, copy);
        if (current.challenge !== "linking") {
          current.challenge = "linking";
          current.qr = null;
          if (visible(current))
            loginBody.replaceChildren(
              element("p", "tools-muted", progress.detail ?? ""),
            );
        }
        phase(current, "linking", progress.status);
      } else {
        if (current.mode === "ssh" && state.challenge !== undefined)
          current.refresh = true;
        current.failedAt = "waiting";
        // Nothing to act on yet: the status still says it is starting and
        // the detail below stays.
        phase(current, "waiting", loginProgress(state, copy).status);
        showChallenge(current, state);
        drawFoot(current);
      }
      pollOn(current);
      return;
    }
    current.handle = null;
    if (state.kind === "signed-in") return signedIn(current, state);
    const end = loginEndMessage(state, copy);
    loginFailed(current, end.message, end.agent);
  }

  // Draws the challenge once, only into the open dialog; a rotated QR code
  // only replaces the image, so a phone number being typed stays where it
  // is.
  function showChallenge(
    current: Flow,
    state: Extract<LoginView, { kind: "pending" }>,
  ) {
    if (!visible(current)) return;
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
    // The provider's page, as the dialog's primary button (the
    // wireframe's "Otevřít GitHub"), in a new tab.
    const link = (href: string, label: string) => {
      const anchor = element("a", "button primary tools-open", label);
      anchor.href = href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      const row = element("p", "tool-actions");
      row.append(anchor);
      return row;
    };
    if (challenge.kind === "device-code") {
      const url = loginLink(challenge.url, "github.com");
      // The code and a button that copies it, only when the person clicks.
      const row = element("div", "tools-code-row");
      const copyCode = element("button", "", copy.toolsLoginCopyCode);
      copyCode.type = "button";
      copyCode.addEventListener("click", () => {
        void navigator.clipboard.writeText(challenge.code).then(
          () => {
            copyCode.textContent = copy.toolsLoginCodeCopied;
          },
          () => undefined,
        );
      });
      row.append(code(challenge.code, copy.toolsLoginCodeLabel), copyCode);
      loginBody.replaceChildren(
        element(
          "p",
          "",
          current.mode === "ssh"
            ? copy.toolsLoginRefreshText
            : copy.toolsLoginGhText,
        ),
        row,
        ...(url === null ? [] : [link(url, copy.toolsLoginGhLink)]),
        element("p", "tools-muted", copy.toolsLoginGhHint),
      );
      return;
    }
    if (challenge.kind === "url") {
      const url = loginLink(challenge.url, "dashboard.composio.dev");
      loginBody.replaceChildren(
        element(
          "p",
          "",
          composioSignInText(copy, overview?.sharedEnvironment === true),
        ),
        ...(url === null ? [] : [link(url, copy.toolsLoginComposioLink)]),
      );
      return;
    }
    if (challenge.kind === "pair-code") {
      const again = element("button", "", copy.toolsLoginQrAgain);
      again.type = "button";
      again.addEventListener("click", () => void startLogin(current));
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
      phoneForm(current),
    );
  }

  function phoneForm(current: Flow): HTMLElement {
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
      void startLogin(current, number.startsWith("+") ? number : `+${number}`);
    });
    const row = element("p", "tool-actions");
    row.append(submit);
    form.append(title, label, input, problem, row);
    return form;
  }

  // "Hotovo": closes the dialog of a finished sign-in.
  function doneRow(): HTMLElement {
    const row = element("p", "tool-actions tools-login-done");
    const done = element("button", "primary", options.copy().toolsLoginDone);
    done.type = "button";
    done.addEventListener("click", () => loginDialog.close());
    row.append(done);
    return row;
  }

  // What is for support, folded under "Details" in the dialog: the key a
  // sign-in uses, the technical part of an installation.
  function folded(detail: string): HTMLElement {
    const more = element("details", "tools-login-more");
    more.append(
      element("summary", "", options.copy().contentDetails),
      element("p", "tools-muted", detail),
    );
    return more;
  }

  // A sign-in completed in this Launchpad session turns "Používají agenti"
  // on (Matěj 2026-10-04), after the reading that follows it, so the change
  // is made at the current revision; never for a tool signed in before.
  function afterSignIn(name: string, state: LoginView) {
    void refresh({ signIn: true }).then(() => {
      const tool = overview?.tools.find((entry) => entry.name === name);
      if (tool !== undefined && autoEnable(tool, state))
        void toggle(tool, true);
    });
  }

  /** A sign-in that ended while its window was closed (#516): the page
   * holds it no more, and its row and Začínáme read where it ended (with
   * `read`; a completed one is read by `afterSignIn`). */
  function endDetached(current: Flow, read: boolean) {
    stopPolling(current);
    if (live(current)) flows.delete(current.tool.name);
    report(current);
    if (read) void refresh({ signIn: true });
  }

  function signedIn(current: Flow, state: LoginView) {
    const copy = options.copy();
    stopPolling(current);
    // A sign-in is the next act on the row: the notice before it ends, and
    // the reading that follows draws the row as it is now.
    endNotice(current.tool.name);
    // gh: signed in is complete only with the SSH key linked (decision F19,
    // addendum 2026-09-28); otherwise the linking step did not finish.
    const ssh = sshOutcome(state, copy);
    // The Git identity the sign-in set, or that it could not (F19, addendum
    // 2026-10-14): a missing one is said aloud, a set one is for support.
    const identity = gitIdentityNote(state, copy);
    if (ssh !== null && !ssh.linked) {
      current.failedAt = "linking";
      // Closed meanwhile, `loginFailed` reads the row again itself.
      if (visible(current)) void refresh({ signIn: true });
      loginFailed(
        current,
        [
          ssh.message,
          ssh.detail,
          identity?.set === false ? identity.message : "",
        ]
          .filter((part) => part !== "")
          .join(" "),
        true,
      );
      return;
    }
    // Its window was closed meanwhile (#516): it ends as it would with the
    // window open, said by its row and Začínáme.
    if (!visible(current)) {
      endDetached(current, false);
      afterSignIn(current.tool.name, state);
      return;
    }
    if (ssh !== null) {
      phase(current, "signed-in", ssh.message);
      // Which key it uses is for support: folded.
      loginBody.replaceChildren(
        ...(identity?.set === false
          ? [element("p", "tools-muted", identity.message)]
          : []),
        folded(
          identity?.set === true
            ? `${ssh.detail} ${identity.message}`
            : ssh.detail,
        ),
        doneRow(),
      );
      afterSignIn(current.tool.name, state);
      return;
    }
    if (current.tool.name === "composio") {
      // No "Connected as …" here: the organization the sign-in named may
      // not be the one the reading makes current (decision F42, addendum
      // (2) of 2026-10-13, note of 2026-10-17). The organizations decide
      // what the dialog shows.
      phase(current, "signed-in", copy.toolsComposioOrgLoading);
      loginBody.replaceChildren();
      current.composio = {
        account:
          state.kind === "signed-in" && state.account !== undefined
            ? state.account
            : null,
        attempt: 0,
        reading: false,
        view: null,
        key: null,
      };
      void readComposio(current);
      afterSignIn(current.tool.name, state);
      return;
    }
    const message = signedInMessage(state, copy);
    phase(current, "signed-in", message);
    // The status line above already says it; the body adds what follows.
    loginBody.replaceChildren(
      ...(current.tool.name === "wacli" &&
      !(state.kind === "signed-in" && state.already === true)
        ? [element("p", "tools-muted", copy.toolsLoginWacliSync)]
        : []),
      doneRow(),
    );
    // The card's sign-in line follows.
    afterSignIn(current.tool.name, state);
  }

  // Composio after its sign-in (decision F42, addendum (2) of 2026-10-13,
  // note of 2026-10-17): the dialog asks only for what the person still has
  // to do in Composio, with one button there, and reads the organizations
  // again by itself until it is done: the reading makes the organization of
  // the Organization's name current as soon as it exists. It reads at a calm
  // pace that grows while nothing changes, not while the page is hidden, at
  // once when the page shows again, and never once connected or closed.
  async function readComposio(current: Flow) {
    const watch = current.composio;
    if (watch === undefined || watch.reading) return;
    watch.reading = true;
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
    const answer = await answerWithin(
      options.post("/api/tools/composio/organizations", {}),
      loginAnswerMs,
    );
    watch.reading = false;
    if (flow !== current) return;
    const view = composioDialogView(
      answer.answered ? answer.value : null,
      watch.account,
      options.copy(),
    );
    const key = JSON.stringify(view);
    if (key === watch.key) watch.attempt += 1;
    else {
      watch.attempt = 0;
      watch.key = key;
      watch.view = view;
      drawComposio(view);
      // The card names the organization it works in now.
      if (view.kind === "connected") void refresh({ signIn: true });
    }
    scheduleComposio(current);
  }

  function scheduleComposio(current: Flow) {
    const view = current.composio?.view;
    if (view == null || current.composio === undefined) return;
    const next = composioPollNext(view, {
      open: flow === current,
      hidden: document.hidden,
    });
    if (next !== "read") return;
    const attempt = current.composio.attempt;
    current.timer = setTimeout(
      () => void readComposio(current),
      composioPollDelay(attempt),
    );
  }

  document.addEventListener("visibilitychange", () => {
    const current = flow;
    const view = current?.composio?.view;
    if (current === null || view == null || current.composio === undefined)
      return;
    if (current.timer) clearTimeout(current.timer);
    current.timer = null;
    if (
      composioPollNext(view, { open: true, hidden: document.hidden }) !== "read"
    )
      return;
    // Back from Composio's tab: read at once.
    current.composio.attempt = 0;
    void readComposio(current);
  });

  /** The dialog's status line as the view says it; connected, with its
   * check. */
  function composioStatus(text: string, connected = false) {
    loginStatus.classList.toggle("is-connected", connected);
    if (!connected) {
      if (loginStatus.textContent !== text) loginStatus.textContent = text;
      return;
    }
    const mark = icon("i-check");
    loginStatus.replaceChildren(mark, element("span", "", text));
  }

  function icon(name: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    svg.append(use);
    return svg;
  }

  /** "Otevřít Composio": Composio's dashboard in the person's own tab. */
  function composioOpen(): HTMLElement {
    const open = element(
      "a",
      "button primary tools-open",
      options.copy().toolsLoginComposioLink,
    );
    open.href = composioDashboard;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    const row = element("p", "tool-actions");
    row.append(open);
    return row;
  }

  /** The quiet line under the button while the dialog waits for Composio. */
  function composioWait(text: string): HTMLElement {
    const line = element("p", "composio-wait");
    const dot = element("span", "composio-wait-dot");
    dot.setAttribute("aria-hidden", "true");
    line.append(dot, element("span", "", text));
    return line;
  }

  /** The Organization's name as Composio accepts it, to copy into Composio's
   * field. */
  function composioName(name: string): HTMLElement {
    const copy = options.copy();
    const box = element("div", "composio-name");
    const value = element("input", "");
    value.readOnly = true;
    value.value = name;
    value.spellcheck = false;
    value.setAttribute("aria-label", copy.toolsComposioCreateName);
    const copyName = element("button", "", copy.toolsLoginCopyCode);
    copyName.type = "button";
    copyName.addEventListener("click", () => {
      void navigator.clipboard.writeText(name).then(
        () => {
          copyName.textContent = options.copy().toolsLoginCodeCopied;
        },
        () => {
          value.focus();
          value.select();
        },
      );
    });
    box.append(composioStepMarker(composioNameStep), value, copyName);
    return box;
  }

  /** "Vybrat aplikace": Apps → Integrace, where the apps are connected. */
  function composioApps(): HTMLElement {
    const apps = element(
      "a",
      "button primary tools-open",
      options.copy().toolsComposioChooseApps,
    );
    apps.href = integrationsPath();
    apps.dataset.route = "";
    // A plain click moves within the page (shell.ts) and ends the dialog.
    apps.addEventListener("click", (event) => {
      if (
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey
      )
        loginDialog.close();
    });
    const row = element("p", "tool-actions");
    row.append(apps);
    return row;
  }

  /** The person's choice where several organizations are theirs to choose
   * from (a personal Environment, a computer). */
  function composioChoice(
    view: Extract<ComposioDialogView, { kind: "connected" }>,
    line: HTMLElement,
  ): HTMLElement[] {
    const choices = view.choices;
    if (choices === null) return [];
    const copy = options.copy();
    const select = element("select", "");
    select.id = "tools-login-org";
    const label = element("label", "", copy.toolsComposioOrgLabel);
    label.htmlFor = select.id;
    for (const choice of choices)
      select.append(new Option(choice.label, choice.id, false, choice.current));
    const problem = element("p", "tool-note-problem");
    problem.setAttribute("aria-live", "polite");
    let chosen = select.value;
    select.addEventListener("change", async () => {
      const current = flow;
      const next = choices.find((choice) => choice.id === select.value);
      if (next === undefined) return;
      select.disabled = true;
      problem.textContent = "";
      let answer: unknown = null;
      try {
        ({ value: answer } = await options.post(
          "/api/tools/composio/organization",
          { id: next.id },
        ));
      } catch {}
      if (flow !== current) return;
      select.disabled = false;
      const selected =
        answer !== null &&
        typeof answer === "object" &&
        (answer as { kind?: unknown }).kind ===
          "composio-organization-selected";
      if (!selected) {
        select.value = chosen;
        problem.textContent = options.copy().toolsComposioOrgFailed;
        return;
      }
      chosen = next.id;
      line.textContent = composioConnectedLine({
        ...view,
        organization: next.label,
      });
      void refresh({ signIn: true });
    });
    const box = element("div", "composio-choice");
    box.append(label, select, problem);
    return [box];
  }

  function drawComposio(view: ComposioDialogView) {
    const current = flow;
    if (current === null) return;
    const copy = options.copy();
    // A view drawn over the focused control moves the focus to its button.
    const focused = loginBody.contains(document.activeElement);
    loginHeading.textContent =
      view.kind === "create" || view.kind === "rename"
        ? copy.toolsComposioCreateTitle
        : loginTitle(current.tool.name, current.mode, copy);
    if (view.kind === "create") {
      composioStatus(copy.toolsComposioCreateText);
      loginBody.replaceChildren(
        composioName(view.name),
        composioScene(copy, view.name),
        composioOpen(),
        composioWait(copy.toolsComposioCreateWait),
      );
    } else if (view.kind === "rename") {
      composioStatus(fill(copy.toolsComposioRenameText, { name: view.name }));
      loginBody.replaceChildren(
        composioOpen(),
        composioWait(copy.toolsComposioRenameWait),
      );
    } else if (view.kind === "problem") {
      composioStatus(view.message);
      loginBody.replaceChildren();
    } else {
      composioStatus(copy.toolsComposioConnected, true);
      const line = element(
        "p",
        "composio-account",
        composioConnectedLine(view),
      );
      loginBody.replaceChildren(
        line,
        ...composioChoice(view, line),
        composioApps(),
      );
    }
    if (focused || document.activeElement === document.body)
      (
        loginBody.querySelector<HTMLElement>(".primary") ?? loginHeading
      ).focus();
  }

  function loginFailed(
    current: Flow,
    message: string,
    agent: boolean,
    detail?: string,
  ) {
    stopPolling(current);
    current.handle = null;
    // Its window was closed meanwhile (#516): the row and Začínáme say it.
    if (!visible(current)) {
      endDetached(current, true);
      return;
    }
    const copy = options.copy();
    phase(current, "failed", message);
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
      // Read again as the page's sign-in of its tool, unless another one
      // of the same tool started meanwhile (it is shown by its own window).
      if (!live(current)) {
        if (flows.has(current.tool.name)) return;
        flows.set(current.tool.name, current);
      }
      void begin(current);
    });
    row.append(again);
    loginBody.replaceChildren(
      ...(detail === undefined ? [] : [folded(detail)]),
      ...(agent ? [element("p", "tools-muted", copy.toolsAgentFallback)] : []),
      row,
    );
    (row.firstElementChild as HTMLElement | null)?.focus();
  }

  // The dialog's ×, and Escape (its `cancel`), close it; what that does to
  // the sign-in is `loginCloseAction` (#516): a sign-in that starts or runs
  // goes on without its window, and anything else ends with it.
  loginClose.addEventListener("click", () => loginDialog.close());
  // "Zrušit": the one way to end a sign-in early, while its code, link or
  // QR waits for the person.
  loginCancel.addEventListener("click", () => {
    const current = flow;
    if (current === null) return;
    const handle = current.handle;
    stopPolling(current);
    current.handle = null;
    if (live(current)) flows.delete(current.tool.name);
    if (handle !== null)
      void options
        .post("/api/tools/login/cancel", {
          tool: current.tool.name,
          session: handle,
        })
        .catch(() => undefined);
    loginDialog.close();
  });
  loginDialog.addEventListener("close", () => {
    const current = flow;
    flow = null;
    if (current !== null) {
      if (live(current) && loginCloseAction(current.phase) === "detach") {
        // It goes on, polled; nothing of its challenge stays in the page.
        current.challenge = null;
        current.qr = null;
      } else {
        stopPolling(current);
        if (live(current)) flows.delete(current.tool.name);
      }
      report(current);
    }
    // No code, link or QR stays in the page.
    loginBody.replaceChildren();
    loginStepList.replaceChildren();
    loginStatus.classList.remove("is-connected");
    loginStatus.textContent = "";
    loginFoot.hidden = true;
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
    notice = {
      name: tool.name,
      revision: overview?.revision ?? 0,
      act: { kind: "team-install", answer: value },
      undo: null,
    };
    say(teamInstallOutcome(value, tool.name, copy).message);
    focus = { name: tool.name, control: "curated" };
    await refresh({ signIn: true });
  }

  // The tool's update (`lazurio tools update`'s core, decision F42 addendum
  // (3)): only on the person's click, said on the row like an installation.
  async function update(tool: ToolOverview) {
    if (busy) return;
    const copy = options.copy();
    busy = true;
    notice = null;
    render();
    say(fill(copy.toolsUpdating, { name: tool.name }));
    let value: unknown = null;
    try {
      ({ value } = await options.post("/api/tools/upgrade", {
        tool: tool.name,
      }));
    } catch {}
    busy = false;
    notice = {
      name: tool.name,
      revision: overview?.revision ?? 0,
      act: { kind: "update", answer: value },
      undo: null,
    };
    say(updateOutcome(value, tool.name, copy).message);
    // Back on "Update" while it stays; else the row's first action.
    focus = { name: tool.name, control: "update" };
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
    notice = {
      name: tool.name,
      revision: overview?.revision ?? 0,
      act: { kind: "logout", answer: value },
      undo: null,
    };
    say(logoutOutcome(value, tool.name, copy).message);
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

  // One settings row per tool (the row pattern of T3 Code's settings): its
  // real name, one plain sentence on what it is for and whether it is
  // connected (Matěj 2026-10-04) on the left, the one action and the switch
  // on the right; the version, the path, what agents are told, the note and
  // the agent's prompt behind "Details".
  function card(tool: ToolOverview, copy: Copy): HTMLLIElement {
    const item = element("li", "row");
    item.dataset.tool = tool.name;
    const main = element("div", "row-main");
    const text = element("div", "row-copy");
    const title = element("h3", "row-title", tool.name);
    if (tool.command !== tool.name)
      title.append(element("code", "", tool.command));
    // On a Team Environment gh working as the Organization's App identity
    // reads "Works as lazurio-for-github[bot]", and Composio's sentence
    // names the Team's Composio account.
    const team = overview?.sharedEnvironment === true;
    text.append(
      title,
      element("p", "row-desc", toolDescription(tool, copy, team)),
    );

    const view = toolStatusView(tool, copy, overview?.hosted === true, team);
    const line = connectionLine(tool, copy, team);
    // The last act on this row, said from the tool as it is now (Matěj
    // 2026-10-09): it never contradicts the line above.
    const recorded =
      notice !== null && notice.name === tool.name ? notice : null;
    const said =
      recorded === null ? null : toolNoticeView(recorded, tool, copy);
    // The Environment's vault (decision F53) and Executor (F44) say their
    // own state and offer their own steps: an account of the Environment and
    // a service Lazurio runs, not a person's sign-in.
    const vaultRow =
      tool.name === vaultToolName
        ? vault.row(copy)
        : tool.name === executorToolName
          ? executor.row(copy)
          : null;
    // A tool this Environment does not offer (decision F44) is listed only
    // while it is still switched on, so that it can be switched off.
    const offeredLine = tool.offered
      ? line
      : { text: copy.toolsNotOffered, state: "unknown", ssh: null };
    const status = element("p", "row-status");
    // A sign-in of this tool that the page runs, its window closed or open
    // (#516): the line says it runs, with the waiting mark, and the row's
    // button shows it again.
    const held = running(tool.name);
    const signIn = element(
      "span",
      "tool-signin",
      held === "waiting"
        ? copy.toolsSignInWaiting
        : held === "finishing"
          ? copy.toolsLoginLinking
          : (vaultRow?.line.text ?? offeredLine.text),
    );
    signIn.dataset.state =
      held !== null ? "waiting" : (vaultRow?.line.state ?? offeredLine.state);
    if (held !== null) {
      const spinner = element("span", "spinner");
      spinner.setAttribute("aria-hidden", "true");
      signIn.prepend(spinner);
    }
    status.append(signIn);
    // gh's SSH key, as its own part of the line, only when it needs the
    // person (not linked, in the warning colour; not verified, also without
    // a proof's answer) or on a Team Environment.
    const ssh = tool.signIn?.ssh;
    if (held === null && line.ssh !== null) {
      const dot = element("span", "", " · ");
      dot.setAttribute("aria-hidden", "true");
      const key = element("span", "tool-ssh", line.ssh);
      key.dataset.state = team ? "team" : (ssh?.state ?? "unknown");
      status.append(dot, key);
    }
    text.append(status);
    if (tool.name === "gh" && team) {
      // Not a warning here: a Team Environment is not signed in personally.
      signIn.dataset.state = "team";
      text.append(element("p", "tool-team", copy.toolsTeamGithub));
    }
    // A tool the Organization decides here (root decision 0194, decision
    // F45): why its switch does not move, and that the person's choice is
    // kept for when the Organization allows it again.
    const organization = organizationView(tool, copy);
    for (const line of [organization.line, organization.kept])
      if (line !== null) text.append(element("p", "tool-organization", line));

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
    const curated =
      vaultRow === null && tool.offered
        ? curatedActions(tool, copy, team)
        : { primary: null, logout: false, linkSsh: false };
    const primary = curated.primary;
    if (vaultRow !== null) controls.append(...vaultRow.controls);
    if (primary !== null) {
      const action = button(
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
      );
      controls.append(action);
    }
    // Not the build Lazurio pins for the tool (composio, decision F42
    // addendum (3)): "Update" installs exactly that build in place, keeping
    // the sign-in.
    const updating = vaultRow === null ? updateAction(tool, copy) : null;
    if (updating !== null)
      controls.append(
        button(
          updating.label,
          tool.name,
          "update",
          () => void update(tool),
          updating.named,
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
    if (tool.setup !== "launchpad" && tool.offered) controls.append(agent);
    // A tool outside the standard place on a hosted Machine (0161 point 6):
    // one action that hands the straightening to an agent, and no sentence
    // about paths.
    if (view.fix) {
      const fix = button(
        copy.toolsFixWithAgent,
        tool.name,
        "fix",
        () =>
          openPrompt(
            fill(copy.toolsFixWithAgentNamed, { name: tool.name }),
            copy.toolsFixPromptHint,
            fill(copy.toolsFixPrompt, {
              command: tool.command,
              path: tool.path ?? "",
            }),
            fix,
          ),
        fill(copy.toolsFixWithAgentNamed, { name: tool.name }),
      );
      fix.disabled = false;
      controls.append(fix);
    }
    if (tool.tier === "required") {
      // Not offered here (Executor on a computer): nothing is on.
      if (tool.offered)
        controls.append(element("span", "always-on", copy.toolsAlwaysOn));
    } else if (tool.offered || tool.enabled) {
      // "Used by agents": the switch guides agents to the tool; installing
      // and signing in are separate acts (the section's intro says so once).
      // Its accessible name holds the visible label and names the tool. A
      // tool this Environment does not offer has it only to be switched off.
      const enable = !tool.enabled;
      const toggler = button(
        "",
        tool.name,
        "toggle",
        () => void toggle(tool, enable),
        fill(
          organization.locked
            ? copy.toolsOrganizationLockedNamed
            : copy.toolsSwitchNamed,
          { name: tool.name },
        ),
      );
      toggler.className = "switch";
      toggler.setAttribute("role", "switch");
      // The Organization's switch: off, whatever the person chose, and it
      // never moves from this page.
      toggler.setAttribute(
        "aria-checked",
        String(tool.enabled && !organization.locked),
      );
      if (organization.locked) toggler.disabled = true;
      const label = element(
        "span",
        "switch-label",
        organization.locked
          ? copy.toolsOrganizationLocked
          : copy.toolsSwitchLabel,
      );
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
    // The technical part of the notice on the row (a path, a reason, a
    // command, a key's fingerprint): only here, while the notice lasts.
    if (said?.detail !== undefined) {
      const happened = element("section", "");
      happened.append(
        element("h4", "", copy.toolsWhatHappened),
        element("p", "tools-muted", said.detail),
      );
      body.append(happened);
    }
    if (vaultRow?.details) body.append(vaultRow.details);
    // The Organization's settings this tool follows: who changes them,
    // where this Environment gets them, the version and its state.
    if (tool.organization !== undefined) {
      const settings = element("section", "");
      settings.append(element("h4", "", copy.toolsOrganizationDetails));
      for (const line of organizationDetails(
        overview?.organizationSettings,
        copy,
        (iso) =>
          new Date(iso).toLocaleString(overview?.locale ?? "en", {
            day: "numeric",
            month: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
      ))
        settings.append(element("p", "tools-muted", line));
      body.append(settings);
    }
    // The installation: version, anything to look at, where it is, and for
    // gh whether the SSH key of this Environment is linked.
    const installation = element("section", "");
    const headline = element("p", "tool-state", view.headline);
    headline.dataset.state = view.state;
    installation.append(element("h4", "", copy.toolsInstallLabel), headline);
    for (const note of view.notes)
      installation.append(element("p", "tool-attention", note));
    if (ssh !== undefined && !team && line.ssh === null)
      installation.append(
        element(
          "p",
          "tools-muted",
          ssh.state === "linked" ? copy.toolsSshLinked : copy.toolsSshUnknown,
        ),
      );
    body.append(installation);
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
    // server hands gh's Team prompt, which signs nobody in. Not for a tool
    // the Organization does not allow here.
    if (tool.setup === "launchpad" && !organization.locked) {
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

    if (recorded !== null && said !== null) {
      const message = element("div", "tool-message");
      message.dataset.kind = said.kind;
      message.append(element("p", "", said.message));
      if (said.shared === true)
        message.append(element("p", "", copy.toolsShared));
      const choices = element("p", "tool-actions");
      const { undo, revision } = recorded;
      if (undo !== null)
        choices.append(
          button(
            copy.toolsUndo,
            tool.name,
            "undo",
            () =>
              void change({ name: tool.name, action: "undo" }, undo, revision),
            fill(copy.toolsUndoNamed, { name: tool.name }),
          ),
        );
      if (said.reload)
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

  // What the guide can point at, as last drawn; null while not read.
  let guideTargets: ToolGuideTargets | null = null;
  function render() {
    guideTargets = null;
    draw();
    options.drawn?.(guideTargets);
  }

  function draw() {
    const copy = options.copy();
    refreshButton.disabled = busy;
    groups.toggleAttribute("data-checking", checking);
    groups.setAttribute("aria-busy", checking ? "true" : "false");
    mcpButton.disabled = overview === null;
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
    const shownGroups = toolGroups(overview.tools, copy);
    groups.replaceChildren(
      ...shownGroups.map((group) => {
        const section = element("section", "group");
        const heading = element("h2", "", group.title);
        heading.id = `tools-group-${group.tier}`;
        section.setAttribute("aria-labelledby", heading.id);
        const head = element("div", "group-head");
        head.append(heading);
        const list = element("ul", "card tools-list");
        list.setAttribute("aria-labelledby", heading.id);
        list.replaceChildren(...group.tools.map((tool) => card(tool, copy)));
        section.append(head, list);
        return section;
      }),
    );
    // What the guide of the page's "?" points at (decision F56's addendum
    // (2) of 2026-10-18, `toolGuideTargets`): connecting and the switch,
    // where the page draws them; the guide's steps follow (`drawn`).
    const targets = toolGuideTargets(
      shownGroups,
      copy,
      overview.sharedEnvironment === true,
    );
    guideTargets = targets;
    const row = (name: string) =>
      [...groups.querySelectorAll<HTMLElement>("li[data-tool]")].find(
        (item) => item.dataset.tool === name,
      );
    if (targets.connect !== null)
      row(targets.connect.tool)
        ?.querySelector(
          targets.connect.part === "action"
            ? 'button[data-control="curated"]'
            : ".row-status",
        )
        ?.setAttribute("data-guide", "tool-connect");
    if (targets.agents !== null)
      row(targets.agents.tool)
        ?.querySelector(".switch-field")
        ?.setAttribute("data-guide", "tool-agents");
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
   * contact the providers: by default only the first read does, and only an
   * explicit `signIn: true` skips the Launchpad's reading of the last minute
   * (`fresh`, tools-reading.ts). Any other read takes an older reading at
   * once (`allowStale`): its rows are shown as being checked, with their
   * controls waiting, nothing else on the page reads it, and the read asks
   * again for the reading the Launchpad runs behind it. Answers this
   * read's own reading, or null where it failed, was not one or a later read
   * superseded it: never the reading a later read left (decision F42, note
   * of 2026-10-19). */
  async function refresh(
    request: Readonly<{ signIn?: boolean }> = {},
  ): Promise<ToolsOverview | null> {
    if (options.absent?.() === true) return null;
    const copy = options.copy();
    const turn = ++sequence;
    const probe = request.signIn ?? !signInChecked;
    let reading: ToolsOverview | null = null;
    busy = true;
    if (overview === null) failed = false;
    render();
    // The vault beside the tools: asked itself when the sign-ins are.
    void vault.read(probe);
    void executor.read();
    const known = (tool: ToolOverview) => signIns.get(tool.name);
    const withKnown = (parsed: ToolsOverview): ToolsOverview => ({
      ...parsed,
      tools: parsed.tools.map((tool) => {
        const signIn = tool.signIn ?? known(tool);
        return signIn === undefined ? tool : { ...tool, signIn };
      }),
    });
    try {
      // A page's first reading may be the Launchpad's from within the last
      // minute, or an older one while it reads anew; every reading asked
      // for with the sign-ins (Refresh status, Zkontrolovat znovu, the end
      // of a flow) is read anew.
      let allowStale = request.signIn !== true;
      let parsed: ToolsOverview | null;
      for (;;) {
        const { value, ok } = await options.post("/api/tools/status", {
          ...(probe ? { signIn: true } : {}),
          ...(request.signIn === true ? { fresh: true } : {}),
          ...(allowStale ? { allowStale: true } : {}),
        });
        if (turn !== sequence) return null;
        parsed = ok ? parseToolsOverview(value) : null;
        if (parsed === null) throw new Error("Tools unavailable");
        if (parsed.stale !== true || !allowStale) break;
        overview = withKnown(parsed);
        failed = false;
        checking = true;
        render();
        allowStale = false;
      }
      if (probe) {
        signInChecked = true;
        signIns.clear();
        for (const tool of parsed.tools)
          if (tool.signIn !== undefined) signIns.set(tool.name, tool.signIn);
      }
      reading = withKnown(parsed);
      overview = reading;
      failed = false;
      // A notice belongs to the Folder revision it was made at: a reading of
      // another one means the Folder changed since, elsewhere, and its Undo
      // would be refused.
      if (notice !== null && !noticeHolds(notice, overview)) notice = null;
    } catch {
      if (turn !== sequence) return null;
      overview = null;
      failed = true;
      say(copy.toolsLoadFailed);
    } finally {
      if (turn === sequence) {
        busy = false;
        checking = false;
        render();
        options.observed(overview);
      }
    }
    return reading;
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
    what: Readonly<{ name: string; action: ToolChange["action"] }>,
    request: Readonly<{
      tools: readonly string[];
      notes?: Readonly<Record<string, string>>;
    }>,
    expectedRevision: number,
  ) {
    if (busy || overview === null) return;
    const copy = options.copy();
    const before = shown(overview.tools);
    const installed =
      overview.tools.find((tool) => tool.name === what.name)?.installed ===
      true;
    busy = true;
    notice = null;
    render();
    say(copy.toolsBusy);
    // A lost answer does not say the change was not written: it is read as
    // unconfirmed.
    let answer: unknown = null;
    try {
      ({ value: answer } = await options.post("/api/tools/update", {
        expectedRevision,
        tools: request.tools,
        ...(request.notes === undefined ? {} : { notes: request.notes }),
      }));
    } catch {}
    busy = false;
    const outcome = toolChangeOutcome(answer, { ...what, installed }, copy);
    const produced = outcome.kind === "updated" ? outcome.revision : undefined;
    notice = {
      name: what.name,
      // A recorded change belongs to the revision it produced, where its
      // Undo applies; anything else to the one the page showed.
      revision: produced ?? expectedRevision,
      act: { kind: "change", action: what.action, answer },
      undo: produced === undefined ? null : before,
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
      { name: tool.name, action: enable ? "enable" : "disable" },
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

  /** Opens a tool's sign-in as its row does: the arrival of "Připojit
   * GitHub" from Začínáme, the line in Apps or the shell's column head (root
   * decision 0188). A sign-in of the tool this page runs, its window closed,
   * is shown again (#516); a signed-in gh whose SSH does not work here gets
   * its SSH link (`signInMode`, #515). True when it opened. */
  function openSignIn(name: string): boolean {
    if (loginDialog.open) return false;
    const running = flows.get(name);
    if (running !== undefined) {
      reattach(running);
      return true;
    }
    if (overview === null || busy) return false;
    const tool = overview.tools.find((entry) => entry.name === name);
    if (tool === undefined) return false;
    const mode = signInMode(
      tool,
      options.copy(),
      overview.sharedEnvironment === true,
    );
    if (mode === null) return false;
    openLogin(tool, mode);
    return true;
  }

  /** Composio signed in, but not in the organization of its Organization's
   * name (Začínáme's "Dokončit", decision F42, note of 2026-10-19): its
   * dialog opens at what is left to do in Composio, as after a sign-in. A
   * Composio sign-in this page runs, its window closed, is shown again
   * instead, never replaced (#516). True when it opened. */
  function openComposioOrganization(): boolean {
    if (overview === null || busy || loginDialog.open) return false;
    const running = flows.get("composio");
    if (running !== undefined) {
      reattach(running);
      return true;
    }
    const tool = overview.tools.find((entry) => entry.name === "composio");
    if (tool?.signIn?.state !== "signed-in") return false;
    signedIn(showLogin(tool, "login"), {
      kind: "signed-in",
      tool: tool.name,
      already: true,
      ...(tool.signIn.account === undefined
        ? {}
        : { account: tool.signIn.account }),
    });
    return true;
  }

  /** Whether this page runs a sign-in of the tool, its window open or
   * closed (#516): waiting for the person, or finishing; null when none. */
  function running(name: string): LoginFlowState | null {
    const current = flows.get(name);
    return current === undefined ? null : loginFlowState(current.phase);
  }

  render();
  return { refresh, openSignIn, openComposioOrganization, running };
}
