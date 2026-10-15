import type { ComposioFact } from "./first-run";
import type { MessageKey } from "./messages";
import {
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
// aplikace". Every value is drawn with textContent. The AI step shows its
// state only: its sign-in (ChatGPT, Claude) is task 742 of DEV-6665 and
// takes its place in the step's actions.

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
    /** Whether the introduction was seen to its end. */
    toured: () => boolean | null;
    signInGithub: () => void;
    signInComposio: () => void;
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

  function stepNode(
    step: StartStep,
    index: number,
    copy: Copy,
    actions: HTMLElement[],
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
    if (step.status !== null)
      text.append(element("p", "start-status", step.status));
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
    const view = facts === null ? null : startView(facts, copy);
    // A Team or an Automated Environment: its Organization prepares it.
    notHere.hidden = facts === null || view !== null;
    for (const group of groups) group.hidden = view === null;
    intro.hidden = view === null;
    if (facts === null || view === null) return;
    intro.textContent = view.intro;

    const nodes = view.steps.map((step, index) => {
      const actions: HTMLElement[] = [];
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
      const node = stepNode(step, index, copy, actions);
      // The content's own rows: the step's body.
      if (step.basic === "content")
        node.querySelector(".start-main")?.append(content);
      return node;
    });
    steps.replaceChildren(...nodes);

    const vault = options.vault();
    vaultGroup.hidden = vault === null;
    vaultState.textContent = vault?.line ?? "";
    vaultState.dataset.tone = vault?.tone ?? "";

    const rows = optionalRows(
      {
        preset: facts.preset,
        composio: options.composio(),
        sshDevices: options.sshDevices(),
      },
      copy,
    );
    optional.replaceChildren(...rows.map(optionalNode));
    optionalGroup.hidden = rows.length === 0;

    const toured = options.toured();
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
