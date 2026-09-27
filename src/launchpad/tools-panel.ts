import type { ToolOverview, ToolsOverview } from "../tools/overview";
import type { ToolSignIn } from "../tools/status";
import type { MessageKey } from "./messages";
import {
  curatedActionLabel,
  currentNotes,
  nextNotes,
  nextSelection,
  noteDraftView,
  parseToolsOverview,
  signInLine,
  sourceLink,
  type ToolChange,
  type ToolChangeOutcome,
  takesNote,
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

    const view = toolStatusView(tool, copy, overview?.hosted === true);
    const status = element("p", "");
    const headline = element("span", "tool-state", view.headline);
    headline.dataset.state = view.state;
    status.append(headline);
    item.append(status);
    if (view.path !== null) item.append(element("p", "tool-path", view.path));
    for (const note of view.notes)
      item.append(element("p", "tools-muted", note));
    const signIn = element("p", "tool-signin", signInLine(tool, copy));
    signIn.dataset.state = tool.signIn?.state ?? "unchecked";
    item.append(signIn);

    const details = element("details", "");
    details.open = opened.has(tool.name);
    details.addEventListener("toggle", () => {
      if (details.open) opened.add(tool.name);
      else opened.delete(tool.name);
    });
    details.append(
      element("summary", "", copy.toolsUsage),
      element("p", "tools-muted", copy.toolsUsageCatalog),
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
    details.append(noteEditor(tool, copy));
    item.append(details);

    const actions = element("p", "tool-actions");
    if (tool.tier !== "required") {
      const enable = !tool.enabled;
      actions.append(
        button(
          enable ? copy.toolsEnable : copy.toolsDisable,
          tool.name,
          "toggle",
          () => void toggle(tool, enable),
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
    // The curated flow of a `launchpad` tool is a later release: its button
    // says so and the agent's prompt is the way meanwhile. A tool that is
    // installed and signed in needs neither.
    const curated = curatedActionLabel(tool, copy);
    if (curated !== null) {
      const install = element("button", "", curated);
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
