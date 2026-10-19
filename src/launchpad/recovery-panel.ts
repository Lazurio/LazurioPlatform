import type { RecoveryResult } from "../recover/recover";
import type { MessageKey } from "./messages";
import {
  parseRecovery,
  type RecoveryControl,
  type RecoveryMode,
  recoveryModeView,
  recoveryView,
} from "./recovery-view";

type Copy = Readonly<Record<MessageKey, string>>;

// The Recovery section of Settings and, in Recovery mode, the whole page
// (docs/recovery.md "The Recovery page"). It reads `GET /api/recovery`, the
// same result as `lazurio recover --json`, and changes nothing: the only
// actions copy a prepared text to the clipboard, open T3 Code (hosted) or
// GitHub's prefilled issue form in a new tab. Every value is shown as text.
export function createRecoveryPanel(
  options: Readonly<{
    /** `GET /api/recovery` with the page's credential. */
    get: () => Promise<{ value: unknown; ok: boolean }>;
    copy: () => Copy;
    /** The recorded entry's T3 Code origin, or null (a workstation). */
    t3codeOrigin: () => string | null;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing recovery UI");
    return element;
  };
  const modeBox = find<HTMLDivElement>("#recovery-mode");
  const status = find<HTMLParagraphElement>("#recovery-status");
  const body = find<HTMLDivElement>("#recovery-body");
  const again = find<HTMLButtonElement>("#recovery-refresh");

  let mode: RecoveryMode | null = null;
  let result: RecoveryResult | null = null;
  let failed = false;
  let loading = false;
  let journal = false;
  let sequence = 0;

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text?: string,
  ) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  const group = (title: string, note: string | null, ...content: Node[]) => {
    const section = element("section", "group");
    const head = element("div", "group-head");
    head.append(element("h2", "", title));
    if (note !== null) head.append(element("p", "group-note", note));
    section.append(head, ...content);
    return section;
  };

  async function copyText(
    text: string,
    fallback: HTMLTextAreaElement,
    said: HTMLElement,
  ) {
    const copy = options.copy();
    try {
      await navigator.clipboard.writeText(text);
      said.textContent = copy.toolsCopied;
    } catch {
      const holder = fallback.closest("details");
      if (holder) holder.open = true;
      fallback.focus();
      fallback.select();
      said.textContent = copy.toolsCopyFailed;
    }
  }

  function renderMode() {
    modeBox.hidden = mode === null;
    if (mode === null) return modeBox.replaceChildren();
    const view = recoveryModeView(mode, options.copy());
    const rows = element("dl", "recovery-mode-rows");
    for (const row of view.rows) {
      const term = element("dt", "", row.label);
      const detail = element("dd");
      detail.append(element("code", "", row.id));
      if (row.text !== null) detail.append(" ", row.text);
      rows.append(term, detail);
    }
    modeBox.replaceChildren(
      element("h2", "", view.title),
      element("p", "", view.text),
      rows,
    );
  }

  function render() {
    const copy = options.copy();
    renderMode();
    again.disabled = loading;
    status.textContent = loading
      ? copy.recoveryLoading
      : failed
        ? copy.recoveryLoadFailed
        : "";
    if (result === null) return body.replaceChildren();
    const view = recoveryView(result, copy, {
      journal,
      t3codeOrigin: options.t3codeOrigin(),
    });
    const blocks: Node[] = [];
    const summary = element("p", "callout", view.summary);
    if (view.verdict === "broken") summary.dataset.kind = "warning";
    blocks.push(summary);

    const checks = element("ul", "card");
    for (const check of view.checks) {
      const row = element("li", "row");
      const main = element("div", "row-main");
      const text = element("div", "row-copy");
      const title = element("p", "row-title");
      title.append(element("code", "", check.id));
      text.append(title);
      if (check.detail) text.append(element("p", "row-desc", check.detail));
      const state = element("div", "row-control");
      const badge = element("span", "badge", check.state);
      badge.dataset.outcome = check.outcome;
      state.append(badge);
      main.append(text, state);
      row.append(main);
      checks.append(row);
    }
    blocks.push(group(copy.recoveryChecksTitle, null, checks));

    const copies = new Map<RecoveryControl, string>(
      view.actions.map((action) => [action.control, action.label]),
    );

    if (view.prompt !== null) {
      const area = element("textarea", "recovery-text");
      area.readOnly = true;
      area.rows = 12;
      area.spellcheck = false;
      area.value = view.prompt;
      area.setAttribute("aria-label", copy.recoveryPromptTitle);
      const said = element("span", "row-status");
      said.setAttribute("role", "status");
      const button = element(
        "button",
        "primary",
        copies.get("copy-prompt") ?? "",
      );
      button.type = "button";
      button.dataset.control = "copy-prompt";
      button.addEventListener("click", () => copyText(area.value, area, said));
      const actions = element("div", "toolbar");
      actions.append(button);
      // Hosted: T3 Code, where the prompt goes, in a new tab; a plain link.
      if (view.chat !== null) {
        const link = element("a", "button", view.chat.label);
        link.href = view.chat.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.dataset.control = "open-t3";
        actions.append(link);
      }
      actions.append(said);
      blocks.push(
        group(copy.recoveryPromptTitle, copy.recoveryPromptText, area, actions),
      );
    }

    if (view.issue?.kind === "prepared") {
      const issue = view.issue;
      const preview = element("pre", "recovery-issue-body", issue.body);
      const command = element("textarea", "recovery-text");
      command.readOnly = true;
      command.rows = 8;
      command.spellcheck = false;
      command.value = issue.command;
      const technical = element("details", "technical");
      technical.append(element("summary", "", "gh"), command);
      const said = element("span", "row-status");
      said.setAttribute("role", "status");
      const button = element("button", "", copies.get("copy-gh") ?? "");
      button.type = "button";
      button.dataset.control = "copy-gh";
      button.addEventListener("click", () =>
        copyText(issue.command, command, said),
      );
      const link = element("a", "button", issue.linkLabel);
      link.href = issue.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const actions = element("div", "toolbar");
      actions.append(button, link, said);
      blocks.push(
        group(
          copy.recoveryIssueTitle,
          issue.text,
          element("p", "row-title", issue.title),
          preview,
          actions,
          technical,
        ),
      );
    } else if (view.issue?.kind === "refused")
      blocks.push(
        group(
          copy.recoveryIssueTitle,
          null,
          element("p", "callout", view.issue.text),
        ),
      );

    if (view.evidence !== null) {
      const content: Node[] = [element("pre", "", view.evidence)];
      if (view.journalToggle !== null) {
        const toggle = element("button", "ghost", view.journalToggle);
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(journal));
        toggle.addEventListener("click", () => {
          journal = !journal;
          render();
          body
            .querySelector<HTMLButtonElement>("[data-control=journal]")
            ?.focus();
        });
        toggle.dataset.control = "journal";
        content.push(toggle);
        if (view.journal !== null)
          content.push(
            element("p", "group-note", copy.recoveryJournalText),
            element("pre", "", view.journal),
          );
      }
      blocks.push(
        group(
          copy.recoveryEvidenceTitle,
          copy.recoveryEvidenceText,
          ...content,
        ),
      );
    }

    if (view.nothingFiled !== null)
      blocks.push(element("p", "intro", view.nothingFiled));
    body.replaceChildren(...blocks);
  }

  async function refresh() {
    const turn = ++sequence;
    loading = true;
    render();
    let next: RecoveryResult | null = null;
    try {
      const { value, ok } = await options.get();
      next = ok ? parseRecovery(value) : null;
    } catch {}
    if (turn !== sequence) return;
    loading = false;
    failed = next === null;
    if (next !== null) result = next;
    render();
  }
  again.addEventListener("click", () => void refresh());

  return {
    /** The Launchpad is in Recovery mode for this check and reason. */
    enter(next: RecoveryMode) {
      mode = next;
      render();
    },
    refresh,
    /** The language changed. */
    render,
    /** Read only once the section is first shown: the check runs the active
     * executable's self-check. */
    get loaded() {
      return result !== null || loading || failed;
    },
  };
}
