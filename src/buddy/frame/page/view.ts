import type {
  Clarify,
  ClarifyAnswer,
  ConversationMessage,
  Media,
} from "../../contract/runtime";
import { type Copy, contextLine, copyOf } from "./copy";
import type { Lang, Layout } from "./host";
import { type FrameIcon, icon } from "./icons";
import { type Block, type Inline, readMarkdown } from "./markdown";
import {
  canSend,
  type DraftAttachment,
  type FrameState,
  type Pending,
  type Row,
  statusKey,
  threadRows,
} from "./state";

// Buddy's window as the prototype draws it (prototypes-lazurio
// `BuddyWidget.tsx`, `styles.css` `.buddyw`): the head with his name, his
// state and, framed, full screen and close (the gear waits for Nastavení →
// Buddy); the thread with its days and the channel of a message from
// elsewhere; the composer with the context chip and attachments. The DOM is
// built once; a render updates only what changed, rows by their keys.

export type ViewHandlers = Readonly<{
  send: (text: string) => void;
  stop: () => void;
  layout: (mode: Layout) => void;
  contextToggle: (on: boolean) => void;
  pick: (files: readonly File[]) => void;
  detach: (id: string) => void;
  answer: (clarifyId: string, answer: ClarifyAnswer) => void;
  older: () => void;
  signIn: () => void;
  retry: () => void;
  resend: (clientId: string) => void;
}>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(name: FrameIcon, className: string): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  button.append(icon(name));
  return button;
}

function inlineNode(part: Inline): Node {
  switch (part.kind) {
    case "text":
      return document.createTextNode(part.text);
    case "code":
      return el("code", undefined, part.text);
    case "strong":
    case "em": {
      const node = el(part.kind === "strong" ? "strong" : "em");
      node.append(...part.children.map(inlineNode));
      return node;
    }
    case "link": {
      const node = el("a");
      node.href = part.href;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      node.append(...part.children.map(inlineNode));
      return node;
    }
  }
}

function blockNode(block: Block): Node {
  switch (block.kind) {
    case "paragraph": {
      const node = el("p");
      block.lines.forEach((line, index) => {
        if (index > 0) node.append(el("br"));
        node.append(...line.map(inlineNode));
      });
      return node;
    }
    case "heading": {
      const node = el("p", "bw__heading");
      node.append(...block.inline.map(inlineNode));
      return node;
    }
    case "list": {
      const node = el(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const entry = el("li");
        entry.append(...item.map(inlineNode));
        node.append(entry);
      }
      return node;
    }
    case "code": {
      const node = el("pre");
      node.append(el("code", undefined, block.text));
      return node;
    }
  }
}

const markdownNodes = (text: string): Node[] =>
  readMarkdown(text).map(blockNode);

const inlineImage = /^image\/(?:png|jpeg|gif|webp)$/;

function mediaNodes(media: readonly Media[]): Node[] {
  return media.map((item) => {
    const address = `/api/v1/media/${encodeURIComponent(item.media_id)}`;
    if (inlineImage.test(item.mime)) {
      const link = el("a", "bw__image");
      link.href = address;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const image = el("img");
      image.src = address;
      image.alt = item.name;
      image.loading = "lazy";
      link.append(image);
      return link;
    }
    const link = el("a", "bw__file", item.name);
    link.href = address;
    link.download = item.name;
    link.prepend(icon("attach", 14));
    return link;
  });
}

function draftNodes(attachments: readonly DraftAttachment[]): Node[] {
  return attachments.map((item) =>
    item.preview === null
      ? (() => {
          const chip = el("span", "bw__file", item.name);
          chip.prepend(icon("attach", 14));
          return chip;
        })()
      : (() => {
          const image = el("img", "bw__thumb");
          image.src = item.preview;
          image.alt = item.name;
          return image;
        })(),
  );
}

function messageNode(
  message: ConversationMessage,
  channel: string | null,
  copy: Copy,
): HTMLElement {
  const own = message.role === "user";
  const node = el("div", `bw__msg bw__msg--${own ? "me" : "buddy"}`);
  if (message.media.length > 0) {
    const media = el("div", "bw__media");
    media.append(...mediaNodes(message.media));
    node.append(media);
  }
  if (message.text !== "") {
    const body = el("div", "bw__text");
    if (own) body.textContent = message.text;
    else body.append(...markdownNodes(message.text));
    node.append(body);
  }
  if (channel !== null)
    node.append(el("span", "bw__via", `${copy.via} ${channel}`));
  return node;
}

function pendingNode(
  pending: Pending,
  copy: Copy,
  resend: (clientId: string) => void,
): HTMLElement {
  const node = el("div", `bw__msg bw__msg--me bw__msg--${pending.status}`);
  if (pending.attachments.length > 0) {
    const media = el("div", "bw__media");
    media.append(...draftNodes(pending.attachments));
    node.append(media);
  }
  if (pending.text !== "") node.append(el("div", "bw__text", pending.text));
  if (pending.status === "failed") {
    const again = el("button", "bw__again", copy.retry);
    again.type = "button";
    again.addEventListener("click", () => resend(pending.client_id));
    node.append(again);
  }
  return node;
}

function rowNode(row: Row, copy: Copy, handlers: ViewHandlers): HTMLElement {
  switch (row.kind) {
    case "day":
      return el("div", "bw__day", row.label);
    case "message":
      return messageNode(row.message, row.channel, copy);
    case "pending":
      return pendingNode(row.pending, copy, handlers.resend);
    case "streaming": {
      const node = el("div", "bw__msg bw__msg--buddy bw__msg--streaming");
      const body = el("div", "bw__text");
      body.append(...markdownNodes(row.text));
      node.append(body);
      return node;
    }
  }
}

/** What makes a row's node out of date: its content, not its key. */
function rowSignature(row: Row, lang: Lang): string {
  switch (row.kind) {
    case "day":
      return `${lang}:${row.label}`;
    case "message":
      return `${lang}:${row.channel ?? ""}`;
    case "pending":
      return `${lang}:${row.pending.status}`;
    case "streaming":
      return row.text;
  }
}

function clarifyNode(
  clarify: Clarify,
  copy: Copy,
  answer: ViewHandlers["answer"],
): HTMLElement {
  const card = el("div", "bw__clarify");
  card.append(el("p", "bw__question", clarify.question));
  const choices = el("div", "bw__choices");
  const chosen = new Set<string>();
  const confirm = el("button", "bw__choice bw__choice--confirm", copy.confirm);
  confirm.type = "button";
  confirm.disabled = true;
  for (const choice of clarify.choices) {
    const button = el("button", "bw__choice", choice);
    button.type = "button";
    button.addEventListener("click", () => {
      if (!clarify.multi) {
        answer(clarify.clarify_id, { choice });
        return;
      }
      if (chosen.has(choice)) chosen.delete(choice);
      else chosen.add(choice);
      button.classList.toggle("is-on", chosen.has(choice));
      button.setAttribute("aria-pressed", String(chosen.has(choice)));
      confirm.disabled = chosen.size === 0;
    });
    if (clarify.multi) button.setAttribute("aria-pressed", "false");
    choices.append(button);
  }
  if (clarify.multi) {
    confirm.addEventListener("click", () =>
      answer(clarify.clarify_id, {
        choices: clarify.choices.filter((choice) => chosen.has(choice)),
      }),
    );
    choices.append(confirm);
  }
  const other = el("button", "bw__choice bw__choice--quiet", copy.other);
  other.type = "button";
  const skip = el("button", "bw__choice bw__choice--quiet", copy.skip);
  skip.type = "button";
  skip.addEventListener("click", () =>
    answer(clarify.clarify_id, { skip: true }));
  choices.append(other, skip);
  const words = el("form", "bw__words");
  words.hidden = clarify.choices.length > 0;
  const field = el("input");
  field.type = "text";
  field.placeholder = copy.answerPlaceholder;
  field.maxLength = 2000;
  const submit = el("button", "bw__choice", copy.send);
  submit.type = "submit";
  words.append(field, submit);
  words.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = field.value.trim();
    if (text !== "") answer(clarify.clarify_id, { text });
  });
  other.addEventListener("click", () => {
    words.hidden = false;
    field.focus();
  });
  if (clarify.choices.length === 0) other.hidden = true;
  card.append(choices, words);
  return card;
}

export type View = Readonly<{
  render: (state: FrameState, lang: Lang, now: Date) => void;
  focus: () => void;
}>;

export function createView(
  root: HTMLElement,
  handlers: ViewHandlers,
  framed: boolean,
  fullscreen: () => boolean,
): View {
  root.replaceChildren();
  const window_ = el("div", "bw");
  const head = el("header", "bw__head");
  const avatar = el("img", "bw__avatar");
  avatar.src = "/assets/avatar.webp";
  avatar.alt = "";
  const who = el("div", "bw__who");
  const name = el("strong", "bw__name");
  const status = el("span", "bw__status");
  who.append(name, status);
  const full = iconButton("enlarge", "bw__icon");
  const close = iconButton("x", "bw__icon");
  full.hidden = !framed;
  close.hidden = !framed;
  full.addEventListener("click", () =>
    handlers.layout(fullscreen() ? "panel" : "fullscreen"),
  );
  close.addEventListener("click", () => handlers.layout("closed"));
  head.append(avatar, who, full, close);

  const thread = el("main", "bw__thread");
  const reading = el("div", "bw__reading");
  const older = el("button", "bw__older");
  older.type = "button";
  older.addEventListener("click", () => handlers.older());
  const rows = el("div", "bw__rows");
  rows.setAttribute("role", "log");
  rows.setAttribute("aria-live", "polite");
  const progress = el("div", "bw__progress");
  const clarifySlot = el("div");
  const gate = el("div", "bw__gate");
  reading.append(older, rows, progress, clarifySlot, gate);
  thread.append(reading);
  // Like a messenger, the thread keeps to its newest message while the
  // reader is there, also when a picture or a font arrives after it was
  // drawn: whether the reader was at the end is read against the height
  // before it grew, never from a scroll event the frame caused itself.
  let lastHeight = 0;
  const atEnd = (height: number) =>
    thread.scrollTop + thread.clientHeight >= height - 48;
  thread.addEventListener("scroll", () => {
    if (thread.scrollTop < 40 && !older.hidden && !older.disabled)
      handlers.older();
  });
  new ResizeObserver(() => {
    if (atEnd(lastHeight)) thread.scrollTop = thread.scrollHeight;
    lastHeight = thread.scrollHeight;
  }).observe(reading);

  const compose = el("footer", "bw__compose");
  const notice = el("div", "bw__notice");
  notice.setAttribute("role", "status");
  const chips = el("div", "bw__chips");
  const composer = el("div", "bw__composer");
  const imageButton = iconButton("image", "bw__tool");
  const fileButton = iconButton("attach", "bw__tool");
  const imageInput = el("input");
  imageInput.type = "file";
  imageInput.accept = "image/*";
  imageInput.multiple = true;
  imageInput.hidden = true;
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  const input = el("textarea", "bw__input");
  input.rows = 1;
  input.maxLength = 16_000;
  const send = iconButton("send", "bw__tool bw__send");
  const stop = iconButton("stop", "bw__tool bw__stop");
  composer.append(
    imageButton,
    fileButton,
    input,
    stop,
    send,
    imageInput,
    fileInput,
  );
  compose.append(notice, chips, composer);
  window_.append(head, thread, compose);
  root.append(window_);

  const pick = (from: HTMLInputElement) => () => {
    const files = [...(from.files ?? [])];
    from.value = "";
    if (files.length > 0) handlers.pick(files);
  };
  imageButton.addEventListener("click", () => imageInput.click());
  fileButton.addEventListener("click", () => fileInput.click());
  imageInput.addEventListener("change", pick(imageInput));
  fileInput.addEventListener("change", pick(fileInput));
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    handlers.pick(files);
  });

  let current: FrameState | null = null;
  let currentLang: Lang = "cs";
  const submit = () => {
    if (current === null || !canSend(current, input.value)) return;
    const text = input.value;
    input.value = "";
    handlers.send(text);
    sync();
  };
  const sync = () => {
    if (current === null) return;
    const ready = canSend(current, input.value);
    const working = current.buddy === "working" || current.streaming !== null;
    send.disabled = !ready;
    stop.hidden = !(working && input.value.trim() === "");
    send.hidden = !stop.hidden;
  };
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  send.addEventListener("click", submit);
  stop.addEventListener("click", () => handlers.stop());

  const nodes = new Map<string, { node: HTMLElement; signature: string }>();
  let clarifyShown: string | null = null;
  let firstKey: string | null = null;

  return {
    focus: () => input.focus(),
    render(state, lang, now) {
      const copy = copyOf(lang);
      const fresh = current === null;
      current = state;
      const relabel = lang !== currentLang;
      currentLang = lang;
      window_.dataset.phase = state.phase;
      name.textContent = state.name;
      // His state only once the frame knows it: not while it loads or the
      // person is signed out.
      status.textContent = `Buddy · ${copy[statusKey(state)]}`;
      status.hidden = state.phase !== "ready" && state.phase !== "offline";
      const isFull = fullscreen();
      full.replaceChildren(icon(isFull ? "reduce" : "enlarge"));
      full.title = isFull ? copy.reduce : copy.fullscreen;
      full.setAttribute("aria-label", full.title);
      full.setAttribute("aria-pressed", String(isFull));
      close.title = copy.close;
      close.setAttribute("aria-label", copy.close);

      // The gate: not signed in, signing in, or Buddy out of reach.
      gate.replaceChildren();
      const open = state.phase === "ready";
      if (state.phase === "signed-out" || state.phase === "signing-in") {
        gate.append(el("p", "bw__gate-title", copy.signInTitle));
        if (state.phase === "signing-in")
          gate.append(el("p", undefined, copy.signingIn));
        const button = el("button", "bw__primary", copy.signIn);
        button.type = "button";
        button.addEventListener("click", () => handlers.signIn());
        gate.append(button);
      } else if (state.phase === "offline") {
        gate.append(el("p", "bw__gate-title", copy.offline));
        const button = el("button", "bw__primary", copy.retry);
        button.type = "button";
        button.addEventListener("click", () => handlers.retry());
        gate.append(button);
      }
      gate.hidden = gate.childElementCount === 0;
      rows.hidden = !state.loaded;

      // The thread, row by row, keeping the reader's place.
      const heightBefore = thread.scrollHeight;
      const atBottom = atEnd(heightBefore);
      const wanted = state.loaded ? threadRows(state, now, lang) : [];
      const keep = new Set(wanted.map((row) => row.key));
      for (const [key, entry] of nodes)
        if (!keep.has(key)) {
          entry.node.remove();
          nodes.delete(key);
        }
      let previous: Element | null = null;
      for (const row of wanted) {
        const signature = rowSignature(row, lang);
        let entry = nodes.get(row.key);
        if (entry === undefined || entry.signature !== signature || relabel) {
          const node = rowNode(row, copy, handlers);
          if (entry !== undefined) entry.node.replaceWith(node);
          entry = { node, signature };
          nodes.set(row.key, entry);
        }
        const expected: Element | null =
          previous === null
            ? rows.firstElementChild
            : previous.nextElementSibling;
        if (expected !== entry.node) {
          if (previous === null) rows.prepend(entry.node);
          else previous.after(entry.node);
        }
        previous = entry.node;
      }
      const newFirst = wanted[0]?.key ?? null;
      const prepended = firstKey !== null && newFirst !== firstKey && !fresh;
      firstKey = newFirst;

      older.textContent = copy.older;
      older.hidden = !state.loaded || state.before === null;
      older.disabled = state.olderLoading;

      progress.textContent = state.progress ?? "";
      progress.hidden = state.progress === null;

      if (state.clarify?.clarify_id !== clarifyShown || relabel) {
        clarifySlot.replaceChildren();
        clarifyShown = state.clarify?.clarify_id ?? null;
        if (state.clarify !== null)
          clarifySlot.append(clarifyNode(state.clarify, copy, handlers.answer));
      }

      if (prepended && !atBottom)
        thread.scrollTop += thread.scrollHeight - heightBefore;
      else if (atBottom || fresh) thread.scrollTop = thread.scrollHeight;
      lastHeight = thread.scrollHeight;

      // The composer.
      notice.textContent = state.notice === null ? "" : copy[state.notice];
      notice.hidden = state.notice === null;
      chips.replaceChildren();
      const context = state.host?.context ?? null;
      if (context !== null) {
        const line = contextLine(context, lang);
        if (state.withContext) {
          const chip = el("span", "bw__context");
          chip.title = copy.contextTitle;
          chip.append(icon("pin", 13), el("span", undefined, line));
          const remove = iconButton("x", "bw__context-x");
          remove.title = copy.contextOff;
          remove.setAttribute("aria-label", copy.contextOff);
          remove.addEventListener("click", () => handlers.contextToggle(false));
          chip.append(remove);
          chips.append(chip);
        } else {
          const add = el("button", "bw__context bw__context--off");
          add.type = "button";
          add.append(
            icon("pin", 13),
            el("span", undefined, `${copy.contextAdd} ${line}`),
          );
          add.addEventListener("click", () => handlers.contextToggle(true));
          chips.append(add);
        }
      }
      for (const item of state.attachments) {
        const chip = el("span", "bw__attachment");
        if (item.preview !== null) {
          const image = el("img", "bw__thumb");
          image.src = item.preview;
          image.alt = "";
          chip.append(image);
        } else chip.append(icon("attach", 13));
        chip.append(el("span", undefined, item.name));
        const remove = iconButton("x", "bw__context-x");
        remove.title = copy.removeAttachment;
        remove.setAttribute(
          "aria-label",
          `${copy.removeAttachment} ${item.name}`,
        );
        remove.addEventListener("click", () => handlers.detach(item.id));
        chip.append(remove);
        chips.append(chip);
      }
      chips.hidden = chips.childElementCount === 0;
      input.placeholder = copy.placeholder;
      input.setAttribute("aria-label", copy.message);
      input.disabled = !open;
      imageButton.disabled = !open;
      fileButton.disabled = !open;
      imageButton.title = copy.attachImage;
      imageButton.setAttribute("aria-label", copy.attachImage);
      fileButton.title = copy.attachFile;
      fileButton.setAttribute("aria-label", copy.attachFile);
      send.title = copy.send;
      send.setAttribute("aria-label", copy.send);
      stop.title = copy.stop;
      stop.setAttribute("aria-label", copy.stop);
      sync();
    },
  };
}
