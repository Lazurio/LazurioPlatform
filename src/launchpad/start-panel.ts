import type { AiProvider } from "../tools/ai";
import type { ComposioFact } from "./first-run";
import type { MessageKey } from "./messages";
import {
  type AiAction,
  type OptionalRow,
  optionalRows,
  type StartFacts,
  type StartStep,
  startView,
} from "./start-view";

type Copy = Readonly<Record<MessageKey, string>>;

// Nastavení → Začínáme (root decision 0201; the wireframe's
// `screens/Start.tsx`, prototypes-lazurio 1eefc3d), drawn from
// start-view.ts: the three basics as numbered steps checked from live facts,
// the content's own rows (content-panel.ts) inside the third, then "Hesla pro
// agenty" with the Environment's vault, "Volitelné" and "Prohlídka
// aplikace". Every value is drawn with textContent. The AI step signs
// ChatGPT and Claude in through their CLIs (F19's addendum of 2026-10-15):
// its two buttons, each with its mark (F36's addendum of 2026-10-16),
// "Otevřít přihlášení", "Zrušit", "Zkusit znovu", "Přihlásit jiný účet" and
// the field for the code of Claude's code page; the sign-in itself is
// ai-sign-in.ts.

export type StartVaultRow = Readonly<{
  line: string;
  tone: "ok" | "busy" | "warn" | "quiet";
}>;

export function createStartPanel(
  options: Readonly<{
    copy: () => Copy;
    /** What Začínáme reads, or null while the profile is not loaded. */
    facts: () => StartFacts | null;
    composio: () => ComposioFact;
    /** Devices with a key added here, null when not known. */
    sshDevices: () => number | null;
    /** The vault's row as Nastavení → Trezor says it; null hides it. */
    vault: () => StartVaultRow | null;
    /** Whether Nastavení → Trezor gives the steps for Bitwarden here
     * (`offersBitwarden`): the row "Trezor v Bitwardenu". */
    bitwarden: () => boolean;
    /** Brings a part of the page just opened into view: "Návod" of
     * "Trezor v Bitwardenu" opens Nastavení → Trezor at its steps. */
    reveal: (part: "bitwarden") => void;
    /** Whether the introduction was seen to its end. */
    toured: () => boolean | null;
    signInGithub: () => void;
    signInComposio: () => void;
    /** The AI step's sign-in (ai-sign-in.ts). */
    signInAi: (tool: AiProvider) => void;
    cancelAi: () => void;
    reopenAi: () => void;
    sendAiCode: (code: string) => void;
    restartTour: () => void;
    navigate: (path: string) => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error("Missing start UI");
    return element;
  };
  const intro = find<HTMLParagraphElement>("#start-intro");
  const notHere = find<HTMLParagraphElement>("#start-not-here");
  const groups = [
    ...document.querySelectorAll<HTMLElement>("#section-start [data-start]"),
  ];
  const steps = find<HTMLOListElement>("#start-steps");
  const content = find<HTMLDivElement>("#start-content");
  const vaultGroup = find<HTMLElement>("#start-vault-group");
  const vaultState = find<HTMLParagraphElement>("#start-vault-state");
  const optional = find<HTMLDivElement>("#start-optional");
  const optionalGroup = find<HTMLElement>("#start-optional-group");
  const tourState = find<HTMLParagraphElement>("#start-tour-state");
  const tourButton = find<HTMLButtonElement>("#start-tour");

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

  // A focus asked for on the AI step ("Připojit AI" from a stopped
  // preparation, a line or a hand-over without AI), taken once it is drawn.
  let focusAi = false;
  // "Přihlásit jiný účet" opened the choice on a connected step.
  let choosing = false;
  // What was drawn last: the page asks again on every change of a fact (each
  // second while an installation runs), and the steps are drawn again only
  // when they say something else, so a focused button keeps its focus.
  let drawn: string | null = null;

  function stepNode(
    step: StartStep,
    index: number,
    copy: Copy,
    actions: HTMLElement[],
    busy = false,
  ): HTMLLIElement {
    const node = element("li", "start-step");
    node.dataset.mark = step.mark;
    node.dataset.step = step.basic;
    if (step.basic === "ai") node.dataset.tour = "start-ai";
    const mark = element("span", "start-mark");
    mark.setAttribute("aria-hidden", "true");
    if (step.mark === "done") mark.append(svg("check"));
    else if (step.mark === "failed") mark.append(svg("warning"));
    else mark.textContent = String(index + 1);
    const main = element("div", "start-main");
    const head = element("div", "start-head");
    const text = element("div", "start-text");
    const title = element("p", "start-title", step.title);
    if (step.mark === "done")
      title.append(element("span", "sr-only", ` ${copy.startDoneMark}`));
    text.append(title);
    if (step.status !== null) {
      const status = element("p", "start-status");
      // A sign-in under way: its line with the waiting mark.
      if (busy) {
        const spinner = element("span", "spinner");
        spinner.setAttribute("aria-hidden", "true");
        status.append(spinner);
      }
      status.append(step.status);
      text.append(status);
    }
    if (step.warning !== undefined)
      text.append(element("p", "start-warning", step.warning));
    head.append(text);
    if (actions.length > 0) {
      const box = element("div", "start-actions");
      box.append(...actions);
      head.append(box);
    }
    main.append(head);
    node.append(mark, main);
    return node;
  }

  const button = (
    label: string,
    action: () => void,
    primary = false,
  ): HTMLButtonElement => {
    const node = element("button", primary ? "primary" : "", label);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  };

  /** A provider's mark before its name: Claude's from simple-icons (the
   * sprite's `i-claude`, in the button's colour); for ChatGPT OpenAI's
   * Blossom from its brand kit (`i-openai`, only in OpenAI's black or white:
   * the styles pin it), the one exception to the simple-icons rule
   * (docs/licensing.md). Both are hidden from assistive technology: the
   * button's text stays its name. */
  const providerMark = (tool: AiProvider): Element => {
    if (tool === "claude") return svg("claude");
    const mark = svg("openai");
    mark.classList.add("provider-openai");
    return mark;
  };
  const signInButton = (
    tool: AiProvider,
    label: string,
    primary = false,
  ): HTMLButtonElement => {
    const node = button(
      label,
      () => {
        choosing = false;
        options.signInAi(tool);
      },
      primary,
    );
    node.dataset.provider = tool;
    node.prepend(providerMark(tool));
    return node;
  };

  /** The AI step's buttons, and what its body holds: the choice of ChatGPT
   * or Claude, or the code's field. */
  function aiParts(
    action: AiAction,
    copy: Copy,
  ): Readonly<{ actions: HTMLElement[]; body: HTMLElement[] }> {
    switch (action.kind) {
      case "none":
        return { actions: [], body: [] };
      case "connected":
        return {
          actions: [
            button(copy.startAiOtherAccount, () => {
              choosing = true;
              render();
            }),
          ],
          body: [],
        };
      case "retry":
        return {
          actions: [
            button(
              copy.startAiRetry,
              () => options.signInAi(action.tool),
              true,
            ),
          ],
          body: [],
        };
      case "choose": {
        const choices = element("div", "start-choices");
        choices.append(
          signInButton("codex", copy.startAiSignInChatgpt, true),
          signInButton("claude", copy.startAiSignInClaude),
        );
        if (action.cancel)
          choices.append(
            button(copy.startAiCancel, () => {
              choosing = false;
              render();
            }),
          );
        return { actions: [], body: [choices] };
      }
      case "signing-in": {
        const actions: HTMLElement[] = [];
        if (action.reopen !== null && "panel" in action.reopen)
          actions.push(button(copy.startAiOpen, () => options.reopenAi()));
        else if (action.reopen !== null) {
          // The page itself, in the computer's own browser.
          const link = element("a", "button", copy.startAiOpen);
          link.href = action.reopen.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          actions.push(link);
        }
        actions.push(button(copy.startAiCancel, () => options.cancelAi()));
        if (action.code === null) return { actions, body: [] };
        // Claude's code page: one field, never a terminal.
        const form = element("form", "start-code");
        const label = element(
          "label",
          "start-code-label",
          copy.startAiCodeHint,
        );
        const input = element("input");
        input.type = "text";
        input.name = "code";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", copy.startAiCodeLabel);
        input.placeholder = copy.startAiCodeLabel;
        label.htmlFor = input.id = "start-ai-code";
        const send = element("button", "", copy.startAiCodeSend);
        send.type = "submit";
        const row = element("div", "start-code-row");
        row.append(input, send);
        form.append(label, row);
        if (action.code.note !== null) {
          const note = element("p", "start-code-note", action.code.note.text);
          note.dataset.tone = action.code.note.tone;
          note.setAttribute("role", "status");
          form.append(note);
        }
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (input.value.trim() !== "") options.sendAiCode(input.value);
        });
        return { actions, body: [form] };
      }
    }
  }

  function optionalNode(row: OptionalRow): HTMLElement {
    const node = element("div", "row");
    node.dataset.optional = row.id;
    const main = element("div", "row-main");
    const copyBox = element("div", "row-copy");
    copyBox.append(
      element("p", "row-title", row.title),
      element("p", "row-desc", row.text),
    );
    if (row.status !== null)
      copyBox.append(element("p", "row-status", row.status));
    main.append(copyBox);
    if (row.action !== null) {
      const control = element("div", "row-control");
      const { label, to } = row.action;
      if (to === "composio") {
        const button = element("button", "", label);
        button.type = "button";
        button.addEventListener("click", () => options.signInComposio());
        control.append(button);
      } else {
        const link = element("a", "button", label);
        link.href = to;
        link.dataset.route = "";
        // A part of the page: a plain click opens it there; the link itself
        // (a new tab) opens the page.
        const { part } = row.action;
        if (part !== undefined)
          link.addEventListener("click", (event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            options.navigate(to);
            options.reveal(part);
          });
        control.append(link);
      }
      main.append(control);
    }
    node.append(main);
    return node;
  }

  function render() {
    const copy = options.copy();
    const facts = options.facts();
    const view =
      facts === null
        ? null
        : startView({ ...facts, aiChoosing: choosing }, copy);
    // A Team or an Automated Environment: its Organization prepares it.
    notHere.hidden = facts === null || view !== null;
    for (const group of groups) group.hidden = view === null;
    intro.hidden = view === null;
    if (facts === null || view === null) {
      drawn = null;
      return;
    }
    const vault = options.vault();
    const rows = optionalRows(
      {
        preset: facts.preset,
        composio: options.composio(),
        sshDevices: options.sshDevices(),
        bitwarden: options.bitwarden(),
      },
      copy,
    );
    const toured = options.toured();
    const now = JSON.stringify([view, vault, rows, toured]);
    if (now === drawn && !focusAi) return;
    drawn = now;
    intro.textContent = view.intro;

    // A focus inside the AI step stays there when it is drawn again.
    const aiFocused =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('[data-step="ai"]') !== null;
    const nodes = view.steps.map((step, index) => {
      const actions: HTMLElement[] = [];
      let body: HTMLElement[] = [];
      if (step.basic === "ai") {
        const parts = aiParts(view.ai, copy);
        actions.push(...parts.actions);
        body = parts.body;
      }
      if (step.basic === "github" && view.github !== null) {
        const connect = element(
          "button",
          view.github.enabled ? "primary" : "",
          copy.startConnect,
        );
        connect.type = "button";
        connect.dataset.tour = "start-github";
        connect.disabled = !view.github.enabled;
        connect.addEventListener("click", () => options.signInGithub());
        actions.push(connect);
      }
      const node = stepNode(
        step,
        index,
        copy,
        actions,
        step.basic === "ai" &&
          view.ai.kind === "signing-in" &&
          step.mark !== "failed",
      );
      if (body.length > 0) node.querySelector(".start-main")?.append(...body);
      // The content's own rows: the step's body.
      if (step.basic === "content")
        node.querySelector(".start-main")?.append(content);
      return node;
    });
    steps.replaceChildren(...nodes);
    if (aiFocused && !focusAi) {
      const ai = steps.querySelector<HTMLElement>('[data-step="ai"]');
      const target =
        ai?.querySelector<HTMLElement>("input, button, a.button") ?? ai;
      if (target === ai) ai?.setAttribute("tabindex", "-1");
      target?.focus({ preventScroll: true });
    }

    vaultGroup.hidden = vault === null;
    vaultState.textContent = vault?.line ?? "";
    vaultState.dataset.tone = vault?.tone ?? "";

    optional.replaceChildren(...rows.map(optionalNode));
    optionalGroup.hidden = rows.length === 0;

    tourState.textContent =
      toured === true ? copy.startToured : copy.startNotToured;
    tourButton.textContent =
      toured === true ? copy.startTourAgain : copy.startTourStart;

    if (focusAi) {
      const ai = steps.querySelector<HTMLElement>('[data-step="ai"]');
      if (ai !== null && ai.closest("[hidden]") === null) {
        focusAi = false;
        ai.scrollIntoView({ block: "center", behavior: "smooth" });
        ai.setAttribute("tabindex", "-1");
        ai.focus({ preventScroll: true });
      }
    }
  }

  tourButton.addEventListener("click", () => {
    options.restartTour();
    options.navigate("/");
  });

  return {
    render,
    /** Shows the AI step: the next render brings it into view and focus. */
    focusAi() {
      focusAi = true;
      render();
    },
  };
}
