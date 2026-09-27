import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { MessageKey } from "./messages";
import {
  nextSelection,
  parseToolsOverview,
  sourceLink,
  type ToolChangeOutcome,
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
// with the revision it showed. A change is previewed first and written only
// after the operator confirms what the preview said.
export function createToolsPanel(
  options: Readonly<{
    post: Post;
    copy: () => Copy;
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

  let overview: ToolsOverview | null = null;
  let failed = false;
  let busy = false;
  let sequence = 0;
  let pending: {
    name: string;
    enable: boolean;
    expectedRevision: number;
    tools: string[];
    message: string;
  } | null = null;
  let notice: { name: string; outcome: ToolChangeOutcome } | null = null;
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

  function card(tool: ToolOverview, copy: Copy): HTMLLIElement {
    const item = element("li", "tool-card");
    item.dataset.tool = tool.name;
    const head = element("div", "tool-head");
    head.append(element("h4", "", tool.name));
    if (tool.command !== tool.name)
      head.append(element("code", "", tool.command));
    const state = element(
      "span",
      "tool-badge",
      tool.tier === "required"
        ? copy.toolsAlwaysOn
        : tool.enabled
          ? copy.toolsEnabled
          : copy.toolsDisabled,
    );
    state.dataset.state = tool.enabled ? "on" : "off";
    head.append(
      state,
      element(
        "span",
        "tool-badge",
        tool.setup === "agent"
          ? copy.toolsSetupAgent
          : copy.toolsSetupLaunchpad,
      ),
    );
    item.append(head, element("p", "", tool.purpose));

    const view = toolStatusView(tool, copy);
    const status = element("p", "");
    const headline = element("span", "tool-state", view.headline);
    headline.dataset.state = view.state;
    status.append(headline);
    item.append(status);
    if (view.path !== null) item.append(element("p", "tool-path", view.path));
    for (const note of view.notes)
      item.append(element("p", "tools-muted", note));

    const details = element("details", "");
    details.append(
      element("summary", "", copy.toolsUsage),
      element("p", "", tool.usage),
    );
    const link = sourceLink(tool.source);
    if (link !== null) {
      const source = element("p", "tools-muted");
      const anchor = element("a", "", copy.toolsSource);
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      source.append(anchor);
      details.append(source);
    }
    item.append(details);

    const actions = element("p", "tool-actions");
    if (tool.tier !== "required") {
      const enable = !tool.enabled;
      actions.append(
        button(
          enable ? copy.toolsEnable : copy.toolsDisable,
          tool.name,
          "toggle",
          () => void preview(tool, enable),
          fill(enable ? copy.toolsEnableNamed : copy.toolsDisableNamed, {
            name: tool.name,
          }),
        ),
      );
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
    if (tool.setup === "launchpad") {
      // The curated flow is a later release: the button says so and the
      // agent's prompt is the way meanwhile.
      const install = element("button", "", copy.toolsInstallAction);
      install.type = "button";
      install.disabled = true;
      const hint = element("span", "tools-muted", copy.toolsInstallHint);
      hint.id = `tools-install-hint-${tool.name}`;
      install.setAttribute("aria-describedby", hint.id);
      actions.append(install, agent);
      item.append(actions, hint);
    } else {
      actions.append(agent);
      item.append(actions);
    }

    if (pending?.name === tool.name) {
      const confirm = element("div", "tool-confirm");
      confirm.append(element("p", "", pending.message));
      if (pending.enable && overview?.sharedEnvironment === true)
        confirm.append(element("p", "", copy.toolsShared));
      const choices = element("p", "tool-actions");
      choices.append(
        button(copy.toolsConfirm, tool.name, "confirm", () => void apply()),
        button(copy.toolsCancel, tool.name, "cancel", () => {
          pending = null;
          focus = { name: tool.name, control: "toggle" };
          render();
        }),
      );
      confirm.append(choices);
      item.append(confirm);
    } else if (notice?.name === tool.name) {
      const message = element("div", "tool-message");
      message.dataset.kind = notice.outcome.kind;
      message.append(element("p", "", notice.outcome.message));
      if (notice.outcome.reload) {
        const choices = element("p", "tool-actions");
        choices.append(
          button(copy.toolsReload, tool.name, "reload", () => {
            notice = null;
            focus = { name: tool.name, control: "toggle" };
            void reloadPage();
          }),
        );
        message.append(choices);
      }
      item.append(message);
    }
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
      ...toolGroups(overview.tools, copy).flatMap((group) => {
        const heading = element("h3", "", group.title);
        heading.id = `tools-group-${group.tier}`;
        const list = element("ul", "tools-list");
        list.setAttribute("aria-labelledby", heading.id);
        list.replaceChildren(...group.tools.map((tool) => card(tool, copy)));
        return [heading, element("p", "tools-muted", group.note), list];
      }),
    );
    if (focus !== null) {
      groups
        .querySelector<HTMLElement>(
          `[data-tool="${focus.name}"][data-control="${focus.control}"]`,
        )
        ?.focus();
      focus = null;
    }
  }

  function say(message: string) {
    announce.textContent = message;
  }

  async function refresh() {
    const copy = options.copy();
    const turn = ++sequence;
    busy = true;
    if (overview === null) failed = false;
    render();
    try {
      const { value, ok } = await options.post("/api/tools/status", {});
      if (turn !== sequence) return;
      const parsed = ok ? parseToolsOverview(value) : null;
      if (parsed === null) throw new Error("Tools unavailable");
      // A confirmation belongs to the revision it was previewed at.
      if (pending !== null && pending.expectedRevision !== parsed.revision)
        pending = null;
      overview = parsed;
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
      pending = null;
      failed = true;
      checked.textContent = "";
      say(copy.toolsLoadFailed);
    } finally {
      if (turn === sequence) {
        busy = false;
        render();
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

  async function preview(tool: ToolOverview, enable: boolean) {
    if (busy || overview === null) return;
    const copy = options.copy();
    const change = { name: tool.name, enable, installed: tool.installed };
    const candidate = {
      expectedRevision: overview.revision,
      tools: nextSelection(overview.tools, tool.name, enable),
    };
    busy = true;
    pending = null;
    notice = null;
    render();
    say(copy.toolsBusy);
    let outcome: ToolChangeOutcome;
    try {
      const { value } = await options.post("/api/tools/preview", candidate);
      outcome = toolChangeOutcome(value, change, copy);
    } catch {
      outcome = toolChangeOutcome(null, change, copy);
    }
    busy = false;
    if (outcome.kind === "previewed") {
      pending = { ...change, ...candidate, message: outcome.message };
      focus = { name: tool.name, control: "confirm" };
    } else {
      notice = { name: tool.name, outcome };
      focus = {
        name: tool.name,
        control: outcome.reload ? "reload" : "toggle",
      };
    }
    say(outcome.message);
    render();
  }

  async function apply() {
    const candidate = pending;
    if (busy || candidate === null || overview === null) return;
    const copy = options.copy();
    const change = {
      name: candidate.name,
      enable: candidate.enable,
      installed:
        overview.tools.find((tool) => tool.name === candidate.name)
          ?.installed ?? false,
    };
    busy = true;
    pending = null;
    render();
    say(copy.toolsBusy);
    let outcome: ToolChangeOutcome;
    try {
      const { value } = await options.post("/api/tools/update", {
        expectedRevision: candidate.expectedRevision,
        tools: candidate.tools,
      });
      outcome = toolChangeOutcome(value, change, copy);
    } catch {
      // A lost answer does not say the change was not written.
      outcome = toolChangeOutcome(null, change, copy);
    }
    busy = false;
    notice = { name: candidate.name, outcome };
    focus = {
      name: candidate.name,
      control: outcome.reload ? "reload" : "toggle",
    };
    say(outcome.message);
    if (outcome.kind === "updated") await reloadPage();
    else render();
  }

  refreshButton.addEventListener("click", () => {
    notice = null;
    void refresh();
  });
  render();
  return { refresh };
}
