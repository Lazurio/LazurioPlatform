import {
  type BeatDrawing,
  type BuddyPart,
  type BuddyStepFacts,
  beatView,
  type Countdown,
  countdownText,
  draftOf,
  type IntroduceScreen,
  introduceNav,
  introduceScreen,
  keepTogether,
  type MeetScreen,
  meetBeats,
  meetQuestionsAt,
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
//   2. He introduces himself, now that he can speak (decision F60's
//      addendum of 2026-10-26; prototypes-lazurio #92): five short beats in
//      his own words, each with his figure and one small drawing (he waves
//      on the first; on the last, where he is, the real launcher of his
//      bubble rises over this dialog with a ring), then his questions: what
//      to call him, what to call the person and how he will write their
//      name, with Opravit, and ty or vy, which nobody chooses for the
//      person. Pokračovat waits for that choice and saves it all with the
//      person's confirmation.
//   3. Telegram, optional (decision F66), and that his chat in Lazurio
//      stays. "Teď ne" ends the meeting: the dialog closes and his window
//      opens, where his first message comes. "Připojit Telegram" closes this
//      dialog and opens "Připojit Telegram". The step is done before it: it
//      never waits for Telegram. Once his bot is connected, it says so, and
//      Hotovo ends the meeting as "Teď ne" does.
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

/** His waving figure, the design system's own frames of him (one strip of
 * three, bundled with the page): it waves twice and stays; without motion
 * it stands still. `size` is a frame's width on screen. Null where the page
 * carries no strip. */
function waveNode(size: number, still = false): HTMLElement | null {
  const source = document.querySelector<HTMLImageElement>(
    "#buddy-wave-pictures img",
  );
  if (source === null) return null;
  const frame = element("span", still ? "buddy-wave is-still" : "buddy-wave");
  frame.setAttribute("aria-hidden", "true");
  frame.style.setProperty("--frame", `${size}px`);
  const strip = source.cloneNode() as HTMLImageElement;
  strip.removeAttribute("loading");
  strip.alt = "";
  frame.append(strip);
  return frame;
}

/** His figure on a beat or beside his questions: his picture from his
 * origin (the launcher's), or the design system's still of him where it
 * does not load. */
function figureNode(avatar: string | null, size: number): HTMLElement {
  const figure = element("span", "buddy-figure");
  figure.setAttribute("aria-hidden", "true");
  figure.style.setProperty("--frame", `${size}px`);
  const still = () => {
    const wave = waveNode(size, true);
    figure.replaceChildren(...(wave === null ? [] : [wave]));
  };
  if (avatar === null) still();
  else {
    const picture = element("img");
    picture.alt = "";
    picture.decoding = "async";
    picture.draggable = false;
    picture.addEventListener("error", still, { once: true });
    picture.src = avatar;
    figure.append(picture);
  }
  return figure;
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
    /** The Environment's apps as its switch names them, the ones it has,
     * and its name of Automate, where his bots work: for the beats that
     * show them. */
    apps: () => Readonly<{ apps: readonly string[]; automate: string }>;
    /** Lifts the launcher of his bubble over this dialog (true) while the
     * beat that shows where he is stands, and lets it back (false). */
    spotlight: (on: boolean) => void;
    /** The meeting ended with "Teď ne": his window opens. */
    finished: () => void;
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
  // Where the introduction stands: a beat, then his questions.
  let beat = 0;
  let draft: PersonaDraft = draftOf(null, "cs");
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
    if (next === "introduce") {
      beat = 0;
      draft = draftOf(
        options.facts().reading?.persona ?? null,
        options.locale(),
      );
    }
    drawn = null;
    render();
    title.focus({ preventScroll: true });
  }

  /** Another beat of his introduction, or his questions: drawn anew, the
   * focus on what goes on (his questions' first field, else Další). */
  function toBeat(next: number) {
    beat = Math.max(0, Math.min(meetQuestionsAt, next));
    drawn = null;
    render();
    const target =
      beat === meetQuestionsAt
        ? body.querySelector<HTMLElement>("#buddy-meet-name")
        : nav.querySelector<HTMLElement>("button.primary");
    target?.focus({ preventScroll: true });
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

  /** One beat: his figure and one or two of his speech bubbles, which come
   * one after another, a small drawing, and the five bars of where it
   * stands. */
  function beatBody(copy: Copy): HTMLElement[] {
    const view = beatView(
      beat,
      {
        buddyName: draft.buddyName,
        address: draft.address,
        ...options.apps(),
      },
      copy,
    );
    const stage = element("div", "buddy-beat");
    stage.dataset.beat = view.beat;
    const talk = element("div", "buddy-beat-talk");
    const size = view.waves ? 144 : 96;
    const figure =
      (view.waves ? waveNode(size) : null) ??
      figureNode(options.avatar(), size);
    const says = element("div", "buddy-beat-says");
    says.setAttribute("aria-live", "polite");
    view.lines.forEach((text, n) => {
      const bubble = element("p", "buddy-bubble buddy-beat-line");
      bubble.textContent = keepTogether(text);
      bubble.style.setProperty("--n", String(n));
      says.append(bubble);
    });
    talk.append(figure, says);
    stage.append(talk);
    const drawing = drawingNode(view.drawing);
    if (drawing !== null) stage.append(drawing);
    const progress = element("span", "buddy-beat-progress");
    progress.setAttribute("role", "img");
    progress.setAttribute("aria-label", view.progress);
    meetBeats.forEach((_, n) => {
      const bar = element("i");
      if (n === view.index) bar.dataset.state = "on";
      else if (n < view.index) bar.dataset.state = "done";
      progress.append(bar);
    });
    stage.append(progress);
    return [stage];
  }

  /** The drawing of a beat, from the design system's parts: no lines
   * between things, position and nesting carry the relation. */
  function drawingNode(drawing: BeatDrawing | null): HTMLElement | null {
    if (drawing === null) return null;
    const delayed = (node: HTMLElement, n: number) => {
      node.style.setProperty("--n", String(n));
      return node;
    };
    switch (drawing.kind) {
      case "does": {
        const cards = element("ul", "buddy-beat-cards");
        drawing.cards.forEach((card, n) => {
          const item = delayed(element("li", "buddy-beat-card"), n);
          item.append(icon(card.icon), keepTogether(card.text));
          cards.append(item);
        });
        return cards;
      }
      case "bots": {
        const panel = element("div", "buddy-beat-panel");
        const head = element("span", "buddy-beat-panel-title");
        head.append(icon("bot"), drawing.title);
        const rows = element("ul", "buddy-beat-bots");
        drawing.rows.forEach((row, n) => {
          const item = delayed(element("li", "buddy-beat-bot"), n);
          const face = element("span", "buddy-beat-bot-face");
          face.append(icon("bot"));
          const state = element("span", "buddy-beat-bot-state");
          if (row.done) {
            state.dataset.done = "";
            state.append(icon("check"));
          } else state.append(spinner());
          state.append(row.status);
          item.append(
            face,
            element("span", "buddy-beat-bot-task", row.task),
            state,
          );
          rows.append(item);
        });
        panel.append(head, rows);
        return panel;
      }
      case "memory": {
        const panel = element("div", "buddy-beat-panel");
        const head = element("span", "buddy-beat-panel-title");
        head.append(icon("book"), drawing.title);
        const chips = element("ul", "buddy-beat-chips");
        drawing.items.forEach((text, n) => {
          chips.append(
            delayed(element("li", "buddy-beat-chip", keepTogether(text)), n),
          );
        });
        panel.append(head, chips);
        return panel;
      }
      case "where": {
        const tiles = element("ul", "buddy-beat-where");
        const avatar = options.avatar();
        drawing.apps.forEach((app, n) => {
          const tile = delayed(element("li", "buddy-beat-tile"), n);
          const screen = element("span", "buddy-beat-tile-screen");
          const corner = element("span", "buddy-beat-tile-bubble");
          if (avatar !== null) {
            const picture = element("img");
            picture.alt = "";
            picture.decoding = "async";
            picture.addEventListener("error", () => picture.remove(), {
              once: true,
            });
            picture.src = avatar;
            corner.append(picture);
          }
          screen.append(
            element("span", "buddy-beat-tile-rail"),
            element("span", "buddy-beat-tile-line"),
            element("span", "buddy-beat-tile-line buddy-beat-tile-short"),
            corner,
          );
          tile.append(screen, element("span", "buddy-beat-tile-name", app));
          tiles.append(tile);
        });
        const phone = delayed(
          element("li", "buddy-beat-tile buddy-beat-phone"),
          drawing.apps.length,
        );
        const screen = element("span", "buddy-beat-tile-screen");
        screen.append(
          element("span", "buddy-beat-msg"),
          element("span", "buddy-beat-msg buddy-beat-msg-mine"),
        );
        phone.append(
          screen,
          element("span", "buddy-beat-tile-name", drawing.phone),
        );
        tiles.append(phone);
        return tiles;
      }
    }
  }

  /** His questions after the beats, built once per visit: typing changes
   * only their lines in place, so a field keeps its focus and its caret.
   * Each is his speech bubble with its answer under it: his name, the
   * person's name and how he writes it, then ty or vy, neither chosen. */
  function questionsBody(copy: Copy): HTMLElement[] {
    const locale = options.locale();
    const view = (): IntroduceScreen => introduceScreen(draft, locale, copy);
    const first = view();
    const stage = element("div", "buddy-q");
    const face = figureNode(options.avatar(), 48);
    face.classList.add("buddy-q-face");
    const talk = element("div", "buddy-q-talk");

    const ask = (id: string, text: string, control: HTMLElement) => {
      const row = element("div", "buddy-q-ask");
      const label = element("label", "buddy-bubble", keepTogether(text));
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
    const name = ask(nameInput.id, first.askName, nameInput);

    const yourInput = element("input", "buddy-input");
    yourInput.id = "buddy-meet-you";
    yourInput.value = draft.user.nominative;
    yourInput.maxLength = 60;
    yourInput.autocomplete = "off";
    yourInput.setAttribute("aria-label", copy.buddyYouLabel);
    const you = ask(yourInput.id, first.askYou, yourInput);

    const formsRow = element("div", "buddy-q-forms");
    const formsAsk = element("span", "buddy-q-forms-say", first.forms);
    const forms = element("div", "buddy-forms");
    formsRow.append(formsAsk, forms);

    let addressRow: HTMLElement | null = null;
    let addressLabel: HTMLElement | null = null;
    const choices: HTMLButtonElement[] = [];
    if (first.askAddress !== null) {
      // Two answers, neither chosen until the person chooses one.
      const group = element("div", "buddy-answers");
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
      addressRow = element("div", "buddy-q-ask");
      addressLabel = element(
        "p",
        "buddy-bubble",
        keepTogether(first.askAddress),
      );
      addressLabel.id = "buddy-meet-address";
      group.setAttribute("aria-labelledby", addressLabel.id);
      addressRow.append(addressLabel, group);
    }
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

    /** Every line follows his address at once ("Tykej mi"). */
    function update(redrawForms = true) {
      const current = view();
      name.label.textContent = keepTogether(current.askName);
      you.label.textContent = keepTogether(current.askYou);
      formsAsk.textContent = current.forms;
      if (addressLabel !== null && current.askAddress !== null)
        addressLabel.textContent = keepTogether(current.askAddress);
      for (const choice of choices) {
        const chosen = choice.dataset.address === current.chosen;
        choice.setAttribute("aria-pressed", String(chosen));
        choice.classList.toggle("primary", chosen);
      }
      if (redrawForms) drawForms();
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
    talk.append(
      name.row,
      you.row,
      formsRow,
      ...(addressRow === null ? [] : [addressRow]),
    );
    stage.append(face, talk);
    update();
    status.textContent = line ?? "";
    return [stage, status];
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
    const words = telegramScreen(
      persona?.confirmed ? persona : draft,
      copy,
      reading?.telegram,
    );
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
    }
    // Zpět from the second beat on; Další through the beats, then
    // Pokračovat, which waits for the names and for ty or vy.
    const way =
      screen === "introduce"
        ? introduceNav(beat, draft, options.locale())
        : null;
    if (way !== null) {
      if (way.back)
        items.push(button(copy.buddyBeatBack, () => toBeat(beat - 1)));
      if (way.next === "beat")
        items.push(button(copy.buddyBeatNext, () => toBeat(beat + 1), true));
      else {
        const next = button(copy.buddyContinue, () => void confirm(), true);
        next.disabled = saving || !way.ready;
        if (saving) next.prepend(spinner());
        items.push(next);
      }
    }
    // His Telegram: "Teď ne" ends the meeting, "Připojit Telegram" opens
    // its dialog; once his bot is connected (or Hermes cannot be asked),
    // Hotovo ends it.
    if (screen === "telegram") {
      const state = options.facts().reading?.telegram?.state;
      if (state === "connected" || state === "unknown")
        items.push(button(copy.buddyDone, () => finish(), true));
      else
        items.push(
          button(copy.buddyLater, () => finish()),
          button(
            copy.buddyTelegramConnect,
            () => {
              hide();
              options.telegram();
            },
            true,
          ),
        );
    }
    nav.replaceChildren(...items);
    // The launcher rises over this dialog while it shows where he is.
    options.spotlight(dialog.open && way?.spotlight === true);
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
        ...(screen === "telegram"
          ? telegramBody(copy)
          : beat < meetQuestionsAt
            ? beatBody(copy)
            : questionsBody(copy)),
      );
    }
    drawNav();
  }

  function hide() {
    if (dialog.open) dialog.close();
  }

  /** The meeting is over ("Teď ne"): the dialog goes and his window
   * opens, where his first message comes. */
  function finish() {
    hide();
    options.finished();
  }

  close.addEventListener("click", () => hide());
  dialog.addEventListener("close", () => {
    drawn = null;
    options.spotlight(false);
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
      beat = 0;
      if (screen === "introduce")
        draft = draftOf(
          options.facts().reading?.persona ?? null,
          options.locale(),
        );
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
