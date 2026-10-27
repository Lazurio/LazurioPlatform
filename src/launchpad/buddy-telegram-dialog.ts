import { drawnKey } from "./buddy-dialog";
import {
  looksLikeBotToken,
  type TelegramApproveResult,
  type TelegramConnectResult,
  type TelegramReading,
  type TelegramStep,
  telegramApproveLine,
  telegramConnectLine,
  telegramFirstStep,
  telegramStartScreen,
  telegramSteps,
} from "./buddy-view";
import type { MessageKey } from "./messages";
import { qrImageSource } from "./tools-view";
import { fill } from "./update-view";

type Copy = Readonly<Record<MessageKey, string>>;

// "Připojit Telegram" (decision F66; the wireframe's ConnectTelegramDialog,
// prototypes-lazurio #90): Buddy's own bot in three steps, as Propojit
// Bitwarden has them, opened from Nastavení → Buddy → Kanály and from the
// last screen of "Seznamte se s Buddym".
//
//   1. Založte bota u @BotFather: a few short lines for someone who never
//      made a bot, and Otevřít BotFather.
//   2. Vložte token, který vám BotFather poslal: one field, hidden as a
//      password and never filled in by the browser, its shape checked here,
//      emptied as it is sent. Telegram decides on the server.
//   3. Otevřete svého bota a stiskněte Start: the bot's link and its code to
//      scan, "Čekám na vaši zprávu…", then "Je to váš účet …?" for each
//      account that wrote to it. Připojuje se… while Buddy's gateway takes
//      it in, without an error when Telegram makes it wait.
//
// Opened from the meeting's last screen, it is part of the meeting: however
// it closes (Hotovo once his bot is connected, Zavřít, Escape), the meeting
// ends as "Teď ne" ends it, and his window opens with his first message
// (the approved prototype, prototypes-lazurio #92). Opened from Nastavení →
// Buddy → Kanály, closing it ends nothing.
//
// While a write to Hermes is in doubt, a connect waits ("held"): only this
// dialog keeps its token, in memory, and sends it once more when the reading
// says `retry`; a reading without it (a later disconnect, or the time for it
// gone) forgets it, and so does closing the dialog.
//
// The token is never kept: the field is the only place the page holds it,
// and it is emptied before the answer comes. Every value is drawn with
// textContent; the bot's code only as the server's own QR drawing.

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

/** BotFather, as Telegram opens him. */
export const botFatherUrl = "https://t.me/BotFather";

/** Where the dialog was opened from: the meeting's last screen, or
 * Nastavení → Buddy → Kanály. */
export type TelegramEntry = "meeting" | "channels";

export function createTelegramDialog(
  options: Readonly<{
    copy: () => Copy;
    telegram: () => TelegramReading | undefined;
    connect: (token: string) => Promise<TelegramConnectResult>;
    approve: (request: string) => Promise<TelegramApproveResult>;
    /** The dialog closed: the page draws again. */
    closed: () => void;
    /** It closed after the meeting's last screen opened it: the meeting
     * ends, as with "Teď ne". */
    meetingOver: () => void;
  }>,
) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error("Missing Telegram dialog");
    return node;
  };
  const dialog = find<HTMLDialogElement>("#buddy-telegram");
  const title = find<HTMLElement>("#buddy-telegram-title");
  const body = find<HTMLElement>("#buddy-telegram-body");
  const dots = find<HTMLElement>("#buddy-telegram-dots");
  const nav = find<HTMLElement>("#buddy-telegram-nav");
  const close = find<HTMLButtonElement>("#buddy-telegram-close");

  let step: TelegramStep = "botfather";
  let sending = false;
  let approving: string | null = null;
  let line: string | null = null;
  let drawn: string | null = null;
  // Where this visit was opened from: every open says it.
  let entry: TelegramEntry = "channels";
  // The token's field of this visit, read and emptied as it is sent.
  let field: HTMLInputElement | null = null;
  // The token of a connect that waits for a write in doubt, in memory only.
  let waiting: string | null = null;

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

  const link = (label: string, href: string, primary = false) => {
    const node = element("a", primary ? "button primary" : "button", label);
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    node.append(icon("external"));
    return node;
  };

  function move(next: TelegramStep) {
    step = next;
    line = null;
    drawn = null;
    render();
    title.focus({ preventScroll: true });
  }

  // ---- 1. BotFather ----

  function botFatherBody(copy: Copy): HTMLElement[] {
    const say = element("p", "buddy-say", copy.telegramStepBotFather);
    const steps = element("ol", "buddy-steps telegram-guide");
    const lines = [
      copy.telegramGuideOpen,
      copy.telegramGuideNew,
      copy.telegramGuideName,
      copy.telegramGuideToken,
    ];
    lines.forEach((text, index) => {
      const item = element("li");
      item.append(
        element("span", "buddy-steps-n", String(index + 1)),
        element("span", "buddy-steps-text", text),
      );
      if (index === 0)
        item.append(link(copy.telegramOpenBotFather, botFatherUrl));
      steps.append(item);
    });
    return [say, steps];
  }

  // ---- 2. The token ----

  function tokenBody(copy: Copy): HTMLElement[] {
    const say = element("p", "buddy-say", copy.telegramStepToken);
    const form = element("form", "telegram-token");
    form.noValidate = true;
    const label = element(
      "label",
      "telegram-token-label",
      copy.telegramTokenLabel,
    );
    const input = element("input", "buddy-input telegram-token-input");
    input.id = "buddy-telegram-token";
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.maxLength = 256;
    label.htmlFor = input.id;
    input.addEventListener("input", () => {
      if (line !== null) {
        line = null;
        status.textContent = "";
        input.removeAttribute("aria-invalid");
      }
      drawNav();
    });
    const status = element("p", "buddy-line telegram-token-line", line ?? "");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.id = "buddy-telegram-token-line";
    input.setAttribute("aria-describedby", status.id);
    const kept = element("p", "buddy-own", copy.telegramTokenKept);
    form.append(label, input, status);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void send();
    });
    field = input;
    return [say, form, kept];
  }

  async function send() {
    const input = field;
    if (input === null || sending) return;
    const copy = options.copy();
    const token = input.value.trim();
    if (!looksLikeBotToken(token)) {
      // Never sent: the person fixes the paste.
      line = copy.telegramTokenShape;
      input.setAttribute("aria-invalid", "true");
      const status = body.querySelector<HTMLElement>(".telegram-token-line");
      if (status) status.textContent = line;
      return;
    }
    // The page holds it no longer than this.
    input.value = "";
    sending = true;
    drawNav();
    const result = await options.connect(token);
    sending = false;
    if (result.kind === "held") waiting = token;
    if (result.kind === "saved" || result.kind === "held") {
      move("start");
      return;
    }
    line = telegramConnectLine(result, options.copy());
    input.setAttribute("aria-invalid", "true");
    const status = body.querySelector<HTMLElement>(".telegram-token-line");
    if (status) status.textContent = line ?? "";
    drawNav();
    input.focus();
  }

  // ---- 3. Start ----

  function botNodes(
    copy: Copy,
    bot: string | null,
    botQr: string | null,
  ): HTMLElement[] {
    if (bot === null) return [element("p", "buddy-own", copy.telegramFindBot)];
    const open = element("div", "buddy-act");
    open.append(
      link(fill(copy.telegramOpenBot, { bot }), `https://t.me/${bot}`, true),
    );
    const nodes: HTMLElement[] = [open];
    const source = qrImageSource(botQr ?? undefined);
    if (source !== null) {
      const code = element("div", "telegram-qr");
      const picture = element("img", "telegram-qr-image");
      picture.alt = copy.telegramQrLabel;
      picture.src = source;
      picture.width = 132;
      picture.height = 132;
      code.append(picture, element("p", "buddy-own", copy.telegramScan));
      nodes.push(code);
    }
    return nodes;
  }

  function startBody(copy: Copy): HTMLElement[] {
    const view = telegramStartScreen(options.telegram(), copy);
    const say = element("p", "buddy-say", copy.telegramStepStart);
    switch (view.kind) {
      case "starting": {
        const status = element("p", "buddy-status");
        status.setAttribute("role", "status");
        status.append(spinner(), copy.telegramStarting);
        const nodes = [say, ...botNodes(copy, view.bot, view.botQr), status];
        if (view.quiet !== null)
          nodes.push(element("p", "buddy-own", view.quiet));
        return nodes;
      }
      case "waiting": {
        const nodes = [say, ...botNodes(copy, view.bot, view.botQr)];
        if (view.asks.length === 0) {
          const status = element("p", "buddy-status");
          status.setAttribute("role", "status");
          status.append(spinner(), copy.telegramWaitingMessage);
          nodes.push(status);
        } else {
          const asks = element("div", "telegram-asks");
          asks.setAttribute("role", "group");
          if (view.many)
            asks.append(element("p", "buddy-own", copy.telegramMany));
          for (const ask of view.asks) {
            const row = element("div", "telegram-ask");
            const yes = button(
              copy.telegramYes,
              () => void approve(ask.request),
              true,
            );
            yes.disabled = approving !== null;
            if (approving === ask.request) yes.prepend(spinner());
            row.append(element("p", "telegram-ask-line", ask.line), yes);
            asks.append(row);
          }
          nodes.push(asks);
        }
        if (line !== null) {
          const status = element("p", "buddy-status buddy-warn", line);
          status.setAttribute("role", "status");
          nodes.push(status);
        }
        return nodes;
      }
      case "connected": {
        const status = element("p", "buddy-status buddy-ok");
        status.setAttribute("role", "status");
        status.append(icon("check"), view.line);
        return [status, element("p", "buddy-say", copy.telegramApproved)];
      }
      case "failed": {
        const status = element("p", "buddy-status buddy-warn");
        status.setAttribute("role", "status");
        status.append(icon("warning"), view.line);
        return [status];
      }
      case "none":
        return [say, element("p", "buddy-status", copy.telegramNone)];
      case "unknown": {
        const status = element("p", "buddy-status buddy-warn");
        status.setAttribute("role", "status");
        status.append(icon("warning"), view.line);
        return [say, status];
      }
    }
  }

  async function approve(request: string) {
    if (approving !== null) return;
    approving = request;
    line = null;
    drawn = null;
    render();
    const result = await options.approve(request);
    approving = null;
    line = telegramApproveLine(result, options.copy());
    drawn = null;
    render();
  }

  // ---- The frame ----

  function drawNav() {
    const copy = options.copy();
    const items: HTMLElement[] = [];
    if (step === "botfather")
      items.push(button(copy.telegramBotCreated, () => move("token"), true));
    else if (step === "token") {
      items.push(button(copy.telegramBack, () => move("botfather")));
      const next = button(
        sending ? copy.telegramChecking : copy.telegramConnect,
        () => void send(),
        true,
      );
      next.disabled = sending || (field?.value.trim() ?? "") === "";
      if (sending) next.prepend(spinner());
      items.push(next);
    } else {
      const view = telegramStartScreen(options.telegram(), copy);
      if (view.kind === "connected")
        items.push(button(copy.buddyDone, () => hide(), true));
      else if (view.kind === "failed")
        items.push(button(copy.telegramConnect, () => move(view.again), true));
      else if (view.kind === "none")
        items.push(button(copy.telegramConnect, () => move("botfather"), true));
      // While it starts or waits, the person acts in Telegram; the row in
      // Nastavení → Buddy takes them back here, or cancels it.
      else items.push(button(copy.toolsClose, () => hide()));
    }
    nav.replaceChildren(...items);
    const index = telegramSteps.indexOf(step);
    dots.setAttribute(
      "aria-label",
      fill(copy.buddyDialogStep, {
        n: String(index + 1),
        total: String(telegramSteps.length),
      }),
    );
    dots.replaceChildren(
      ...telegramSteps.map((_, n) => {
        const dot = element("i");
        if (n === index) dot.dataset.state = "on";
        else if (n < index) dot.dataset.state = "done";
        return dot;
      }),
    );
  }

  /** The connect that waited: sent once more when the reading invites it,
   * forgotten when it no longer can. */
  function resume() {
    const token = waiting;
    const reading = options.telegram();
    if (token === null || sending || reading === undefined || reading.held)
      return;
    waiting = null;
    if (reading.retry !== true) return;
    sending = true;
    void options.connect(token).then((result) => {
      sending = false;
      if (result.kind === "held") waiting = token;
      else if (result.kind !== "saved") {
        // Refused now: the person pastes it again, with the reason.
        move("token");
        line = telegramConnectLine(result, options.copy());
        const status = body.querySelector<HTMLElement>(".telegram-token-line");
        if (status) status.textContent = line ?? "";
        return;
      }
      render();
    });
  }

  function render() {
    if (!dialog.open) return;
    resume();
    const copy = options.copy();
    title.textContent = copy.telegramDialogTitle;
    close.setAttribute("aria-label", copy.toolsClose);
    if (step === "start") {
      const view = telegramStartScreen(options.telegram(), copy);
      const key = drawnKey(["start", view, approving, line]);
      if (key !== drawn) {
        drawn = key;
        body.replaceChildren(...startBody(copy));
      }
    } else if (drawn === null) {
      // Built once per visit, so the field keeps what is pasted.
      drawn = step;
      body.replaceChildren(
        ...(step === "botfather" ? botFatherBody(copy) : tokenBody(copy)),
      );
      if (step === "token") field?.focus();
    }
    drawNav();
  }

  function hide() {
    if (dialog.open) dialog.close();
  }

  close.addEventListener("click", () => hide());
  dialog.addEventListener("close", () => {
    // Nothing of a token stays behind the dialog.
    if (field !== null) field.value = "";
    field = null;
    waiting = null;
    drawn = null;
    line = null;
    options.closed();
    if (entry === "meeting") options.meetingOver();
  });

  return Object.freeze({
    /** Opens where his Telegram stands: Start while it starts or waits,
     * else BotFather. `from` says what its close ends. */
    open(at: TelegramStep | undefined, from: TelegramEntry) {
      entry = from;
      step = at ?? telegramFirstStep(options.telegram());
      line = null;
      approving = null;
      drawn = null;
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
      render();
      title.focus({ preventScroll: true });
    },
    /** Something changed: the last step follows it. */
    render,
    isOpen: () => dialog.open,
  });
}
