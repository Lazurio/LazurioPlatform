import type { AiProvider } from "../tools/ai";
import { buddyPartNode, drawnKey } from "./buddy-dialog";
import type { BuddyStepView, MeetScreen } from "./buddy-view";
import { deviceCodeBlock } from "./device-code-block";
import type { ComposioFact } from "./first-run";
import type { MessageKey } from "./messages";
import {
  type AiAction,
  type DemoRow,
  type DemoStartView,
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
// beneath them ChatGPT's quieter "Přihlásit kódem" with its line (root
// decision 0201 point 10) and, while its code waits, the code and OpenAI's
// page in the block of gh's code (device-code-block.ts), "Otevřít
// přihlášení", "Zrušit", "Zkusit znovu", "Přihlásit jiný účet" and
// the field for the code of Claude's code page; the sign-in itself is
// ai-sign-in.ts. Where the Environment has Buddy his step comes first
// (decision F65): its two quiet parts with their states and one action,
// which opens "Seznamte se s Buddym" (buddy-dialog.ts). A public
// Environment (decision F55) shows instead only "Vyzkoušejte" (Apps, a
// module, Chat) and the tour.

export type StartVaultRow = Readonly<{
  line: string;
  tone: "ok" | "busy" | "warn" | "quiet";
}>;

export function createStartPanel(
  options: Readonly<{
    copy: () => Copy;
    /** What Začínáme reads, or null while the profile is not loaded. */
    facts: () => StartFacts | null;
    /** A public Environment's Začínáme (`demoStartView`); null elsewhere. */
    demo: () => DemoStartView | null;
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
    /** "Přepnout účet": the responsible user's own account signed out and
     * the sign-in opened for the persona's (the Automated Environment). */
    switchGithub: () => void;
    signInComposio: () => void;
    /** The AI step's sign-in (ai-sign-in.ts); `byCode`: ChatGPT's by code. */
    signInAi: (tool: AiProvider, byCode?: boolean) => void;
    cancelAi: () => void;
    reopenAi: () => void;
    sendAiCode: (code: string) => void;
    restartTour: () => void;
    navigate: (path: string) => void;
    /** Buddy's step: a new code (the dialog opens on it), "Zrušit", and the
     * dialog at one of its screens. */
    buddy: Readonly<{
      signIn: () => void;
      cancel: () => void;
      open: (screen: MeetScreen) => void;
    }>;
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
  const tourGroup = find<HTMLElement>("#start-tour-group");
  const demoGroup = find<HTMLElement>("#start-demo-group");
  const demoRows = find<HTMLDivElement>("#start-demo");
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
    if (step.basic === "ai" || step.basic === "buddy")
      node.dataset.tour = `start-${step.basic}`;
    // What the guide of the page's "?" points at (decision F56's addendum of
    // 2026-10-18): Buddy's step, the AI step and GitHub's.
    if (
      step.basic === "ai" ||
      step.basic === "github" ||
      step.basic === "buddy"
    )
      node.dataset.guide = `start-${step.basic}`;
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

  /** ChatGPT's sign-in by code beneath the two (root decision 0201 point
   * 10): a quiet button, then its one line, that the setting comes first. */
  const byCodeNode = (hint: string, copy: Copy): HTMLElement => {
    const start = button(copy.startAiByCode, () => {
      choosing = false;
      options.signInAi("codex", true);
    });
    start.classList.add("link-button");
    start.dataset.byCode = "codex";
    const box = element("div", "start-by-code");
    box.append(start, element("p", "start-by-code-hint", hint));
    return box;
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
              () => options.signInAi(action.tool, action.byCode === true),
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
        return {
          actions: [],
          body: [choices, byCodeNode(action.byCode.hint, copy)],
        };
      }
      case "by-code": {
        // The code and OpenAI's page, as gh's dialog shows its code.
        const block = element("div", "start-by-code-block");
        block.append(
          ...deviceCodeBlock({
            code: action.code,
            url: action.url,
            labels: {
              code: copy.toolsLoginCodeLabel,
              copy: copy.toolsLoginCopyCode,
              copied: copy.toolsLoginCodeCopied,
              open: copy.startAiByCodeOpen,
            },
          }),
        );
        return {
          actions: [button(copy.startAiCancel, () => options.cancelAi())],
          body: [block],
        };
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

  /** Buddy's step: its one action, and its parts as the step's body. */
  function buddyParts(
    view: BuddyStepView,
    copy: Copy,
  ): Readonly<{ actions: HTMLElement[]; body: HTMLElement[] }> {
    const actions: HTMLElement[] = [];
    const handlers = options.buddy;
    switch (view.action) {
      case "sign-in":
        actions.push(button(copy.buddySignIn, handlers.signIn, true));
        break;
      case "sign-in-other":
        actions.push(button(copy.buddySignInOther, handlers.signIn, true));
        break;
      case "resume":
        actions.push(
          button(copy.buddyCancel, handlers.cancel),
          button(copy.buddyContinue, () => handlers.open("sign-in"), true),
        );
        break;
      case "new-code":
        actions.push(button(copy.buddyNewCode, handlers.signIn, true));
        break;
      case "introduce":
        actions.push(
          button(copy.buddyContinue, () => handlers.open("introduce"), true),
        );
        break;
      case "edit": {
        const link = element("a", "button", copy.buddyEdit);
        link.href = "/settings/buddy";
        link.dataset.route = "";
        actions.push(link);
        break;
      }
      case "none":
        break;
    }
    const parts = element("ul", "buddy-parts");
    parts.append(...view.parts.map((part) => buddyPartNode(part, copy)));
    return { actions, body: [parts] };
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

  /** One row of a public Environment's Začínáme: its title, its sentence,
   * a state where it has one, and its button. Chat opens as the shell's own
   * Chat entry does (the `lazurio-app` event pairs it); a route of this page
   * moves within it. */
  function demoNode(row: DemoRow): HTMLElement {
    const node = element("div", "row");
    node.dataset.demo = row.id;
    const main = element("div", "row-main");
    const copyBox = element("div", "row-copy");
    copyBox.append(
      element("p", "row-title", row.title),
      element("p", "row-desc", row.text),
    );
    if (row.status !== null)
      copyBox.append(element("p", "row-status", row.status));
    main.append(copyBox);
    const action = row.action;
    if (action !== null) {
      const control = element("div", "row-control");
      const link = element("a", "button", action.label);
      link.href = action.href;
      if (action.app === undefined) link.dataset.route = "";
      else
        link.addEventListener("click", (event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const asked = new CustomEvent("lazurio-app", {
            detail: { app: action.app, href: action.href },
            cancelable: true,
          });
          document.dispatchEvent(asked);
          if (asked.defaultPrevented) event.preventDefault();
        });
      control.append(link);
      main.append(control);
    }
    node.append(main);
    return node;
  }

  /** A public Environment's Začínáme: "Vyzkoušejte" and the tour, never a
   * sign-in, and no sentence under the title (F56's addendum (6) of
   * 2026-10-24). */
  function renderDemo(view: DemoStartView, copy: Copy) {
    notHere.hidden = true;
    intro.hidden = true;
    intro.textContent = "";
    for (const group of groups) group.hidden = group !== tourGroup;
    vaultGroup.hidden = true;
    demoGroup.hidden = false;
    const toured = options.toured();
    const now = JSON.stringify(["demo", view, toured]);
    if (now === drawn) return;
    drawn = now;
    demoRows.replaceChildren(...view.rows.map(demoNode));
    tourState.textContent =
      toured === true ? copy.startToured : copy.startNotToured;
    tourButton.textContent =
      toured === true ? copy.startTourAgain : copy.startTourStart;
  }

  function render() {
    const copy = options.copy();
    const facts = options.facts();
    const demo = facts === null ? null : options.demo();
    if (demo !== null) {
      renderDemo(demo, copy);
      return;
    }
    demoGroup.hidden = true;
    const view =
      facts === null
        ? null
        : startView({ ...facts, aiChoosing: choosing }, copy);
    // A Team Environment: its Organization prepares it.
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
    // A code's countdown ticks in place (buddy-dialog.ts), never by a draw.
    const now = drawnKey([view, vault, rows, toured]);
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
      if (step.basic === "buddy" && view.buddy !== null) {
        const parts = buddyParts(view.buddy, copy);
        actions.push(...parts.actions);
        body = parts.body;
      }
      if (step.basic === "ai") {
        const parts = aiParts(view.ai, copy);
        actions.push(...parts.actions);
        body = parts.body;
      }
      if (step.basic === "github" && view.github !== null) {
        // "Připojit", "Připojit znovu" where GitHub is connected badly
        // (#515), or "Otevřít" for the sign-in this page runs (#516): each
        // opens GitHub's sign-in as it stands (`openSignIn`). "Přepnout
        // účet" where the responsible user's own account is signed in on
        // the Automated Environment signs it out first (F27's addendum of
        // 2026-10-30).
        const kind = view.github.kind;
        const connect = element(
          "button",
          view.github.enabled ? "primary" : "",
          kind === "reconnect"
            ? copy.startGithubReconnect
            : kind === "switch"
              ? copy.startGithubSwitch
              : kind === "open"
                ? copy.startOpen
                : copy.startConnect,
        );
        connect.type = "button";
        connect.dataset.tour = "start-github";
        connect.disabled = !view.github.enabled;
        connect.addEventListener("click", () =>
          kind === "switch" ? options.switchGithub() : options.signInGithub(),
        );
        actions.push(connect);
      }
      const node = stepNode(
        step,
        index,
        copy,
        actions,
        (step.basic === "ai" &&
          (view.ai.kind === "signing-in" || view.ai.kind === "by-code") &&
          step.mark !== "failed") ||
          (step.basic === "github" && view.github?.kind === "open"),
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
