import {
  type BuddyPart,
  type BuddyStepFacts,
  type Countdown,
  countdownText,
  draftOf,
  type IntroduceScreen,
  introduceScreen,
  type MeetScreen,
  meetScreens,
  type PersonaDraft,
  type PersonaSaveResult,
  type SignInScreen,
  saveLine,
  signInScreen,
  telegramScreen,
  withForm,
  withYourName,
} from "./buddy-view";
import { codeBox } from "./device-code-block";
import type { MessageKey } from "./messages";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// "Seznamte se s Buddym" (decision F65; the wireframe's BuddyMeet.tsx,
// prototypes-lazurio #90): the first step of an Osobní Prostředí with Buddy,
// one dialog in three screens, as Propojit Bitwarden has them.
//
//   1. His own ChatGPT sign-in: OpenAI's page, the code with Kopírovat, the
//      time it still holds, "Čekám na přihlášení…", Nový kód, then
//      Připojeno. The person signs in in their own browser; nobody copies a
//      command and no agent is involved.
//   2. He introduces himself, now that he can speak, and asks in his own
//      words: what to call him, ty or vy, what to call the person, and how
//      he will write their name, with Opravit. Pokračovat saves it with the
//      person's confirmation.
//   3. Telegram, optional (decision F66): "Připojit Telegram", which closes
//      this dialog and opens "Připojit Telegram", or "Teď ne", and that his
//      chat in Lazurio stays. The step is done before it: it never waits for
//      Telegram. Once his bot is connected, it says so, and Hotovo.
//
// Nastavení → Buddy opens the first screen alone to sign him in again. Every
// value is drawn with textContent; the code reaches the clipboard only by
// its button. Also the part rows of his step and the countdowns, which a
// timer fills in place each second, so nothing is drawn again for them.

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

const icon = (name: string) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("class", "icon");
  node.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  node.append(use);
  return node;
};

const spinner = () => {
  const node = element("span", "spinner");
  node.setAttribute("aria-hidden", "true");
  return node;
};

/** A text that counts down: the ticker fills it again each second. */
function countdownNode(countdown: Countdown, text: string): HTMLSpanElement {
  const node = element("span", "", text);
  node.dataset.countdown = countdown.template;
  node.dataset.expiresAt = String(countdown.expiresAt);
  return node;
}

/** Every countdown under `root`, filled for `now`. */
export function tickCountdowns(root: ParentNode, now: number) {
  for (const node of root.querySelectorAll<HTMLElement>("[data-countdown]")) {
    const template = node.dataset.countdown ?? "";
    const expiresAt = Number(node.dataset.expiresAt);
    if (!Number.isFinite(expiresAt)) continue;
    const text = countdownText({ template, expiresAt }, now);
    if (node.textContent !== text) node.textContent = text;
  }
}

/** Buddy's face: his picture from his origin (the launcher's), or the
 * first letter of his name where it does not load. */
export function faceNode(
  avatar: string | null,
  name: string,
  small = false,
): HTMLElement {
  const face = element(
    "span",
    small ? "buddy-face buddy-face-small" : "buddy-face",
  );
  face.setAttribute("aria-hidden", "true");
  const letter = () => {
    face.replaceChildren(name.trim().charAt(0).toLocaleUpperCase() || "B");
  };
  if (avatar === null) letter();
  else {
    const picture = element("img");
    picture.alt = "";
    picture.decoding = "async";
    picture.draggable = false;
    picture.addEventListener("error", letter, { once: true });
    picture.src = avatar;
    face.append(picture);
  }
  return face;
}

let helpIds = 0;

/** A "?" that shows what to do, under the line it explains. */
function helpNodes(help: string, copy: Copy): HTMLElement[] {
  const id = `buddy-help-${++helpIds}`;
  const toggle = element("button", "buddy-help-toggle", "?");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", id);
  toggle.setAttribute("aria-label", copy.buddyRefusedHelpLabel);
  toggle.title = copy.buddyRefusedHelpLabel;
  const text = element("p", "buddy-help", help);
  text.id = id;
  text.hidden = true;
  toggle.addEventListener("click", () => {
    text.hidden = !text.hidden;
    toggle.setAttribute("aria-expanded", String(!text.hidden));
  });
  return [toggle, text];
}

/** One quiet part of Buddy's step (and Přihlášení k ChatGPT in Nastavení →
 * Buddy): its mark, its name, its state. */
export function buddyPartNode(part: BuddyPart, copy: Copy): HTMLLIElement {
  const node = element("li", "buddy-part");
  node.dataset.part = part.id;
  node.dataset.mark = part.mark;
  const mark = element("span", "buddy-part-mark");
  mark.setAttribute("aria-hidden", "true");
  if (part.mark === "done") mark.append(icon("check"));
  if (part.mark === "warn") mark.append(icon("warning"));
  const title = element("span", "buddy-part-title", part.title);
  if (part.mark === "done")
    title.append(element("span", "sr-only", ` ${copy.startDoneMark}`));
  const status = element("span", "buddy-part-status");
  if (part.busy === true) status.append(spinner());
  status.append(
    part.countdown === undefined
      ? element("span", "", part.status)
      : countdownNode(part.countdown, part.status),
  );
  node.append(mark, title, status);
  if (part.help !== undefined) {
    const [toggle, text] = helpNodes(part.help, copy);
    if (toggle !== undefined) status.append(toggle);
    if (text !== undefined) node.append(text);
  }
  return node;
}

/** What a view draws, without the seconds of its countdowns (a status that
 * counts down keys by its template): drawn again only when it says
 * something else, so a focused button keeps its focus. */
export const drawnKey = (value: unknown): string =>
  JSON.stringify(value, function (this: unknown, key, item) {
    const holder = this as { countdown?: Countdown } | null;
    return key === "status" &&
      holder !== null &&
      typeof holder === "object" &&
      holder.countdown !== undefined
      ? holder.countdown.template
      : item;
  });

export function createBuddyDialog(
  options: Readonly<{
    copy: () => Copy;
    locale: () => "cs" | "en";
    facts: () => BuddyStepFacts;
    /** His picture (`<origin>/assets/avatar.webp`); null without it. */
    avatar: () => string | null;
    /** A new code ("Přihlásit Buddyho", "Nový kód"). */
    signIn: () => void;
    /** The names, with the person's confirmation from the introduction. */
    save: (draft: PersonaDraft, confirm: boolean) => Promise<PersonaSaveResult>;
    /** The dialog closed: the page draws again (its tour comes back). */
    closed: () => void;
    /** "Připojit Telegram": this dialog closes and that one opens. */
    telegram: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error("Missing Buddy dialog");
    return node;
  };
  const dialog = find<HTMLDialogElement>("#buddy-meet");
  const title = find<HTMLElement>("#buddy-meet-title");
  const body = find<HTMLElement>("#buddy-meet-body");
  const dots = find<HTMLElement>("#buddy-meet-dots");
  const nav = find<HTMLElement>("#buddy-meet-nav");
  const close = find<HTMLButtonElement>("#buddy-meet-close");

  let screen: MeetScreen = "sign-in";
  // `sign-in`: Nastavení → Buddy's "Přihlásit", the first screen alone.
  let only = false;
  let draft: PersonaDraft = draftOf(null);
  let fixing = false;
  let saving = false;
  let line: string | null = null;
  let drawn: string | null = null;

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

  function move(next: MeetScreen) {
    screen = next;
    line = null;
    fixing = false;
    if (next === "introduce")
      draft = draftOf(options.facts().reading?.persona ?? null);
    drawn = null;
    render();
    title.focus({ preventScroll: true });
  }

  // ---- 1. The sign-in ----

  function signInBody(view: SignInScreen, copy: Copy): HTMLElement[] {
    const say = element("p", "buddy-say", copy.buddySay);
    const own = element("p", "buddy-own", copy.buddyOwn);
    switch (view.kind) {
      case "checking":
        return [say, element("p", "buddy-status", copy.startChecking)];
      case "start": {
        const act = element("div", "buddy-act");
        act.append(button(copy.buddySignIn, options.signIn, true));
        return [say, act, own];
      }
      case "starting": {
        const status = element("p", "buddy-status");
        status.append(spinner(), copy.buddySignInStarting);
        return [say, status, own];
      }
      case "code": {
        const steps = element("ol", "buddy-steps");
        const open = element("li");
        const link = element("a", "button primary", copy.buddyOpenButton);
        link.href = view.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.append(icon("external"));
        open.append(
          element("span", "buddy-steps-n", "1"),
          element("span", "buddy-steps-text", copy.buddyOpenPage),
          link,
        );
        const enter = element("li");
        const code = element("span", "buddy-code");
        const copyButton = button(copy.buddyCopy, () => {
          void navigator.clipboard.writeText(view.code).then(
            () => {
              copyButton.textContent = copy.buddyCopied;
            },
            () => undefined,
          );
        });
        code.append(codeBox(view.code, copy.buddyCodeLabel), copyButton);
        enter.append(
          element("span", "buddy-steps-n", "2"),
          element("span", "buddy-steps-text", copy.buddyEnterCode),
          code,
        );
        steps.append(open, enter);
        const holds = element("p", "buddy-holds");
        holds.append(
          countdownNode(view.holds, countdownText(view.holds, Date.now())),
        );
        const waiting = element("p", "buddy-status");
        waiting.setAttribute("role", "status");
        waiting.append(spinner(), copy.buddyWaiting);
        const again = element("div", "buddy-again");
        again.append(button(copy.buddyNewCode, options.signIn), own);
        return [say, steps, holds, waiting, again];
      }
      case "expired": {
        const status = element("p", "buddy-status buddy-warn");
        status.setAttribute("role", "status");
        status.append(icon("warning"), copy.buddyCodeExpired);
        const again = element("div", "buddy-again");
        again.append(button(copy.buddyNewCode, options.signIn, true), own);
        return [say, status, again];
      }
      case "connected": {
        const status = element("p", "buddy-status buddy-ok");
        status.setAttribute("role", "status");
        status.append(icon("check"), copy.startConnected);
        return [say, status];
      }
      case "failed": {
        const status = element("p", "buddy-status buddy-warn");
        status.setAttribute("role", "status");
        status.append(icon("warning"), view.line);
        const nodes: HTMLElement[] = [say, status];
        if (view.help !== undefined) {
          const [toggle, text] = helpNodes(view.help, copy);
          if (toggle !== undefined) status.append(toggle);
          if (text !== undefined) nodes.push(text);
        }
        if (view.retry) {
          const again = element("div", "buddy-again");
          again.append(button(copy.buddyNewCode, options.signIn, true), own);
          nodes.push(again);
        }
        return nodes;
      }
    }
  }

  // ---- 2. He introduces himself ----

  /** The second screen, built once per visit: typing changes only its
   * lines in place, so the field keeps its focus and its caret. */
  function introduceBody(copy: Copy): HTMLElement[] {
    const locale = options.locale();
    const view = (): IntroduceScreen => introduceScreen(draft, locale, copy);
    const first = view();
    const art = element("div", "buddy-meet-art");
    const face = faceNode(options.avatar(), draft.buddyName);
    const says = element("div", "buddy-says");
    const hello = element("p", "buddy-bubble", first.hello);
    const intro = element("p", "buddy-bubble", first.intro);
    says.append(hello, intro);
    art.append(face, says);

    const questions = element("div", "buddy-questions");
    const question = (ask: string, control: HTMLElement, id: string) => {
      const row = element("div", "buddy-question");
      const label = element("label", "buddy-ask", ask);
      label.htmlFor = id;
      row.append(label, control);
      return { row, label };
    };
    const nameInput = element("input", "buddy-input");
    nameInput.id = "buddy-meet-name";
    nameInput.value = draft.buddyName;
    nameInput.maxLength = 60;
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;
    nameInput.setAttribute("aria-label", copy.buddyNameLabel);
    const name = question(first.askName, nameInput, nameInput.id);

    const yourInput = element("input", "buddy-input");
    yourInput.id = "buddy-meet-you";
    yourInput.value = draft.user.nominative;
    yourInput.maxLength = 60;
    yourInput.autocomplete = "off";
    yourInput.setAttribute("aria-label", copy.buddyYouLabel);
    const you = question(first.askYou, yourInput, yourInput.id);

    let addressRow: HTMLElement | null = null;
    let addressLabel: HTMLElement | null = null;
    const choices: HTMLButtonElement[] = [];
    if (first.askAddress !== null) {
      const group = element("div", "buddy-segmented");
      group.setAttribute("role", "group");
      for (const value of ["vy", "ty"] as const) {
        const choice = button(first.answers[value], () => {
          draft = { ...draft, address: value };
          update();
        });
        choice.dataset.address = value;
        choices.push(choice);
        group.append(choice);
      }
      addressRow = element("div", "buddy-question");
      addressLabel = element("span", "buddy-ask", first.askAddress);
      group.setAttribute("aria-label", first.askAddress);
      addressRow.append(addressLabel, group);
    }

    const formsRow = element("div", "buddy-question buddy-forms-row");
    const formsAsk = element("span", "buddy-ask buddy-ask-quiet", first.forms);
    const forms = element("div", "buddy-forms");
    formsRow.append(formsAsk, forms);
    const status = element("p", "buddy-line");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    function drawForms() {
      const current = view();
      if (fixing && current.fixable) {
        const field = (form: "accusative" | "dative", template: string) => {
          const quote = element("span", "buddy-trace");
          const [before = "", after = ""] = template.split("{name}");
          const input = element("input", "buddy-input buddy-input-word");
          input.value = draft.user[form];
          input.maxLength = 60;
          input.autocomplete = "off";
          input.setAttribute("aria-label", before.trim() || template);
          input.addEventListener("input", () => {
            draft = withForm(draft, form, input.value);
            update(false);
          });
          quote.append(`„${before}`, input, `${after}“`);
          return quote;
        };
        forms.replaceChildren(
          field("accusative", copy.buddyTraceFor),
          field("dative", copy.buddyTraceSend),
        );
      } else
        forms.replaceChildren(
          ...current.traces.map((trace) =>
            element(
              "span",
              "buddy-trace",
              options.locale() === "cs" ? `„${trace}“` : `“${trace}”`,
            ),
          ),
        );
      if (current.fixable) {
        const fix = button(fixing ? copy.buddyFixDone : copy.buddyFix, () => {
          fixing = !fixing;
          drawForms();
        });
        fix.className = "link-button buddy-fix";
        forms.append(fix);
      }
    }

    function update(forms = true) {
      const current = view();
      hello.textContent = current.hello;
      intro.textContent = current.intro;
      name.label.textContent = current.askName;
      you.label.textContent = current.askYou;
      if (addressLabel !== null && current.askAddress !== null)
        addressLabel.textContent = current.askAddress;
      formsAsk.textContent = current.forms;
      for (const choice of choices)
        choice.setAttribute(
          "aria-pressed",
          String(choice.dataset.address === draft.address),
        );
      if (forms) drawForms();
      drawNav();
    }
    nameInput.addEventListener("input", () => {
      draft = { ...draft, buddyName: nameInput.value };
      update(false);
    });
    yourInput.addEventListener("input", () => {
      draft = withYourName(draft, yourInput.value, options.locale());
      update(!fixing);
    });
    questions.append(
      name.row,
      ...(addressRow === null ? [] : [addressRow]),
      you.row,
      formsRow,
    );
    update();
    status.textContent = line ?? "";
    return [art, questions, status];
  }

  async function confirm() {
    if (saving) return;
    saving = true;
    drawNav();
    const result = await options.save(draft, true);
    saving = false;
    if (result.kind === "saved") {
      move("telegram");
      return;
    }
    line = saveLine(result, options.copy());
    const status = body.querySelector<HTMLElement>(".buddy-line");
    if (status) status.textContent = line ?? "";
    drawNav();
  }

  // ---- 3. Telegram, optional ----

  function telegramBody(copy: Copy): HTMLElement[] {
    const reading = options.facts().reading;
    const persona = reading?.persona ?? null;
    const words = telegramScreen(persona ?? draft, copy, reading?.telegram);
    const art = element("div", "buddy-meet-art");
    const face = faceNode(
      options.avatar(),
      persona?.buddyName ?? draft.buddyName,
    );
    const says = element("div", "buddy-says");
    says.append(
      element("p", "buddy-bubble", words.ask),
      element("p", "buddy-bubble", words.here),
    );
    art.append(face, says);
    if (words.connected === null) return [art];
    const status = element("p", "buddy-status buddy-ok");
    status.setAttribute("role", "status");
    status.append(icon("check"), words.connected);
    return [art, status];
  }

  // ---- The frame ----

  function drawNav() {
    const copy = options.copy();
    const items: HTMLElement[] = [];
    if (screen === "sign-in") {
      const view = signInScreen(options.facts(), copy);
      if (view.kind === "connected")
        items.push(
          only
            ? button(copy.buddyDone, () => hide(), true)
            : button(copy.buddyContinue, () => move("introduce"), true),
        );
    } else if (screen === "introduce") {
      const next = button(copy.buddyContinue, () => void confirm(), true);
      next.disabled =
        saving || !introduceScreen(draft, options.locale(), copy).ready;
      if (saving) next.prepend(spinner());
      items.push(next);
    } else if (
      options.facts().reading?.telegram?.state === "connected" ||
      options.facts().reading?.telegram?.state === "unknown"
    )
      items.push(button(copy.buddyDone, () => hide(), true));
    else
      items.push(
        button(copy.buddyLater, () => hide()),
        button(
          copy.buddyTelegramConnect,
          () => {
            hide();
            options.telegram();
          },
          true,
        ),
      );
    nav.replaceChildren(...items);
    // The steps of the guide, as Propojit Bitwarden shows them.
    dots.hidden = only;
    const index = meetScreens.indexOf(screen);
    dots.setAttribute(
      "aria-label",
      fill(copy.buddyDialogStep, {
        n: String(index + 1),
        total: String(meetScreens.length),
      }),
    );
    dots.replaceChildren(
      ...meetScreens.map((_, n) => {
        const dot = element("i");
        if (n === index) dot.dataset.state = "on";
        else if (n < index) dot.dataset.state = "done";
        return dot;
      }),
    );
  }

  function render() {
    if (!dialog.open) return;
    const copy = options.copy();
    title.textContent = only ? copy.buddySignIn : copy.buddyStepTitle;
    close.setAttribute("aria-label", copy.toolsClose);
    if (screen === "sign-in") {
      const view = signInScreen(options.facts(), copy);
      const key = drawnKey(["sign-in", view, only, options.locale()]);
      if (key !== drawn) {
        drawn = key;
        body.replaceChildren(...signInBody(view, copy));
      }
    } else if (drawn === null) {
      drawn = screen;
      body.replaceChildren(
        ...(screen === "introduce" ? introduceBody(copy) : telegramBody(copy)),
      );
    }
    drawNav();
  }

  function hide() {
    if (dialog.open) dialog.close();
  }

  close.addEventListener("click", () => hide());
  dialog.addEventListener("close", () => {
    drawn = null;
    options.closed();
  });

  return Object.freeze({
    /** Opens at `start`; `sign-in` only (Nastavení → Buddy) keeps it to
     * the first screen. */
    open(start: MeetScreen, mode: "meet" | "sign-in" = "meet") {
      only = mode === "sign-in";
      screen = only ? "sign-in" : start;
      line = null;
      fixing = false;
      if (screen === "introduce")
        draft = draftOf(options.facts().reading?.persona ?? null);
      drawn = null;
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
      render();
      title.focus({ preventScroll: true });
    },
    /** Something changed: the first screen follows it. */
    render,
    isOpen: () => dialog.open,
  });
}
