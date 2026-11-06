import type { NewModuleOffer } from "./apps-view";
import type { NewModuleOutcome, NewModulePrompt } from "./catalog-panel";
import { createGuideVideo, type GuideVideoLocale } from "./guide-video";
import type { MessageKey } from "./messages";
import {
  type NewModuleScreen,
  type NewModuleStep,
  newModuleBrief,
  newModuleDescription,
  newModuleDescriptionLength,
  newModuleScreen,
  newModuleSteps,
} from "./new-module-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// "+ Nový modul" (decision F36's addendum of 2026-11-05): three screens in
// one dialog, as Připojit Telegram has them. What a module is, what it should
// do, in the person's own words with what to remember and examples that fill
// the field in, and the whole brief, which the person can copy or open in
// Chat through the page's hand-over (ui.ts `handOver`). A member gets the
// same dialog with their words: the Admin founds the module, and the brief
// asks the agent for a request to the Admin. The description stays in the
// page until it is handed over, so closing the dialog by mistake loses
// nothing; it reaches Chat through the Launchpad at the click (prompt-briefs.ts),
// and where that fails through the clipboard. Every value is drawn with
// textContent.

/** What the short message at the foot of the page says after a hand-over. */
const said: Readonly<Record<NewModuleOutcome, MessageKey>> = {
  "handed-over": "appsNewModuleOpened",
  copied: "appsNewModuleCopied",
  failed: "appsNewModuleCopyFailed",
  "needs-ai": "appsNewModuleNeedsAi",
};

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

export function createNewModuleDialog(
  options: Readonly<{
    copy: () => Copy;
    locale: () => GuideVideoLocale;
    /** Hands the brief to Chat; `brief` keeps a description at the Launchpad
     * once the tab is open, and answers the id the link names. */
    handOver: (
      prompt: NewModulePrompt & { brief?: () => Promise<string | null> },
    ) => Promise<NewModuleOutcome>;
    /** Leaves a description at the Launchpad: the brief's id, or null. */
    keepBrief: (
      offer: NewModuleOffer,
      description: string,
    ) => Promise<string | null>;
    /** Writes text to the clipboard; resolves whether it did. */
    copyText: (text: string) => Promise<boolean>;
    /** A short message at the foot of the page. */
    say: (text: string) => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error("Missing new module dialog");
    return node;
  };
  const dialog = find<HTMLDialogElement>("#new-module");
  const title = find<HTMLElement>("#new-module-title");
  const body = find<HTMLElement>("#new-module-body");
  const status = find<HTMLElement>("#new-module-status");
  const dots = find<HTMLElement>("#new-module-dots");
  const nav = find<HTMLElement>("#new-module-nav");
  const close = find<HTMLButtonElement>("#new-module-close");

  let offer: NewModuleOffer | null = null;
  let step: NewModuleStep = "what";
  let description = "";
  let busy = false;
  // Each showing has its number: an answer of a closed one changes nothing.
  let showing = 0;
  // The element that opened it, where the focus goes back.
  let opener: HTMLElement | null = null;

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

  const say = (text: string) => {
    status.textContent = text;
  };

  // A video that stays open must not play on behind the next screen.
  const stopVideo = () => body.querySelector("video")?.pause();

  function move(next: NewModuleStep) {
    stopVideo();
    step = next;
    say("");
    render();
    if (next === "describe")
      body.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    else title.focus({ preventScroll: true });
  }

  function whatBody(screen: Extract<NewModuleScreen, { step: "what" }>) {
    const parts = element("ul", "new-module-parts");
    for (const part of screen.parts) {
      const item = element("li");
      item.append(element("strong", "", part.term), `: ${part.text}`);
      parts.append(item);
    }
    const nodes: HTMLElement[] = [
      element("p", "", screen.intro),
      parts,
      element("p", "", screen.who),
    ];
    const more = element("div", "new-module-more");
    if (screen.video) {
      const slot = element("div", "guide-video");
      createGuideVideo(slot, {
        name: "modules-overview",
        title: () => options.copy().modulesVideoTitle,
        copy: options.copy,
        locale: options.locale,
      });
      more.append(slot);
    }
    if (screen.template) {
      const link = element(
        "a",
        "new-module-template",
        options.copy().newModuleTemplate,
      );
      link.href = "/marketplace";
      link.dataset.route = "";
      link.addEventListener("click", () => hide());
      more.append(link);
    }
    if (more.childElementCount > 0) nodes.push(more);
    return nodes;
  }

  function describeBody(
    screen: Extract<NewModuleScreen, { step: "describe" }>,
  ) {
    const text = element("p", "", screen.text);
    text.id = "new-module-describe-text";
    const field = element("textarea", "new-module-field");
    field.rows = 6;
    field.maxLength = newModuleDescriptionLength;
    field.value = description;
    field.setAttribute("aria-labelledby", title.id);
    field.setAttribute("aria-describedby", text.id);
    field.addEventListener("input", () => {
      description = field.value;
    });
    const remember = element("div", "new-module-remember");
    const heading = element("p", "new-module-label", screen.mentionTitle);
    heading.id = "new-module-mentions";
    const mentions = element("ul", "new-module-mentions");
    mentions.setAttribute("aria-labelledby", heading.id);
    for (const mention of screen.mentions)
      mentions.append(element("li", "", mention));
    remember.append(heading, mentions);
    const examples = element("div", "new-module-examples");
    examples.setAttribute("role", "group");
    examples.setAttribute("aria-label", screen.examplesTitle);
    examples.append(
      element("span", "new-module-label", screen.examplesTitle),
      ...screen.examples.map((example) => {
        const chip = button(example.label, () => {
          field.focus();
          field.select();
          // Through the editing command where the browser has it, so that
          // undo brings back what the person wrote.
          if (!document.execCommand?.("insertText", false, example.story))
            field.value = example.story;
          description = field.value;
          field.setSelectionRange(0, 0);
          field.scrollTop = 0;
        });
        chip.classList.add("new-module-example");
        return chip;
      }),
    );
    return [text, field, remember, examples];
  }

  function briefBody(screen: Extract<NewModuleScreen, { step: "brief" }>) {
    const text = element("p", "", screen.text);
    const brief = element("pre", "new-module-brief", screen.brief);
    brief.tabIndex = 0;
    brief.setAttribute("role", "group");
    brief.setAttribute("aria-labelledby", title.id);
    const copying = element("div", "buddy-act");
    copying.append(
      button(options.copy().newModuleCopy, () => {
        void options.copyText(screen.brief).then((done) => {
          const now = options.copy();
          say(done ? now.newModuleCopied : now.appsNewModuleCopyFailed);
        });
      }),
    );
    return [text, brief, copying];
  }

  async function handOver() {
    if (offer === null || busy) return;
    const current = offer;
    const copy = options.copy();
    const told = newModuleDescription(description);
    busy = true;
    drawNav();
    const mine = showing;
    const outcome = await options
      .handOver({
        id: current.id,
        organization: current.organization,
        text: newModuleBrief(current, description, copy),
        ...(told === null
          ? {}
          : { brief: () => options.keepBrief(current, told) }),
      })
      .catch((): NewModuleOutcome => "failed");
    busy = false;
    const now = options.copy();
    // Nothing went out: the dialog stays, with the brief to copy.
    if (outcome === "failed") {
      if (mine === showing) {
        say(now[said.failed]);
        drawNav();
      }
      return;
    }
    if (outcome !== "needs-ai") description = "";
    hide();
    options.say(now[said[outcome]]);
  }

  function drawNav() {
    const copy = options.copy();
    const items: HTMLElement[] = [];
    if (step === "what")
      items.push(button(copy.newModuleContinue, () => move("describe"), true));
    else if (step === "describe")
      items.push(
        button(copy.newModuleBack, () => move("what")),
        button(copy.newModuleContinue, () => move("brief"), true),
      );
    else {
      const open = button(copy.newModuleOpen, () => void handOver(), true);
      open.disabled = busy;
      items.push(
        button(copy.newModuleBack, () => move("describe")),
        open,
      );
    }
    nav.replaceChildren(...items);
    const index = newModuleSteps.indexOf(step);
    dots.setAttribute(
      "aria-label",
      fill(copy.buddyDialogStep, {
        n: String(index + 1),
        total: String(newModuleSteps.length),
      }),
    );
    dots.replaceChildren(
      ...newModuleSteps.map((_, n) => {
        const dot = element("i");
        if (n === index) dot.dataset.state = "on";
        else if (n < index) dot.dataset.state = "done";
        return dot;
      }),
    );
  }

  function render() {
    if (!dialog.open || offer === null) return;
    const copy = options.copy();
    const screen = newModuleScreen(step, offer, description, copy);
    title.textContent = screen.title;
    close.setAttribute("aria-label", copy.toolsClose);
    body.replaceChildren(
      ...(screen.step === "what"
        ? whatBody(screen)
        : screen.step === "describe"
          ? describeBody(screen)
          : briefBody(screen)),
    );
    drawNav();
  }

  function hide() {
    if (dialog.open) dialog.close();
  }

  close.addEventListener("click", () => hide());
  dialog.addEventListener("close", () => {
    stopVideo();
    showing += 1;
    say("");
    // Back where it was opened from, once the page drew that tile again.
    const back = opener?.isConnected
      ? opener
      : document.querySelector<HTMLElement>("[data-prompt]");
    opener = null;
    back?.focus({ preventScroll: true });
  });

  return Object.freeze({
    /** Opens at its first screen. What the person wrote for this offer stays,
     * another offer starts empty. */
    open(next: NewModuleOffer, from: HTMLElement) {
      if (offer?.id !== next.id || offer.organization !== next.organization)
        description = "";
      offer = next;
      step = "what";
      busy = false;
      opener = from;
      showing += 1;
      say("");
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
      render();
      title.focus({ preventScroll: true });
    },
    /** The language changed: drawn again in it. */
    render,
  });
}
