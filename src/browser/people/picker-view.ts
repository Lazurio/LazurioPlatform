import type { Rect } from "./input-map";
import type {
  ClientMessage,
  FrameHeader,
  PickerItem,
  PickerKind,
  PickerRect,
  ServerMessage,
} from "./protocol";
import type { Words } from "./words";

/** The view's own pickers (F39's addendum of 2026-11-14, #970): what the
 * view shows in place of the pop-ups Chrome draws outside the page, a
 * `<select>`'s list, a datalist's suggestions, a calendar or a colour
 * chooser. The hub found the control and kept Chrome's own pop-up shut; the
 * person chooses here and the hub writes the choice into the page.
 *
 * A list sits at the control with a fine pointer and room for it, and is a
 * sheet at the bottom of the page on a touch screen or a narrow view, with
 * rows a finger hits. It takes the keys while it is open: arrows, Home,
 * End, Page Up and Down move, Enter and Space choose, Esc and a press
 * outside close it with nothing chosen, and typing jumps to the first choice
 * that begins with what was typed. A field (date, time, month, week,
 * colour) is the person's own browser's field of that kind, with the page's
 * `min`, `max` and `step`, and the view opens its picker at once where the
 * browser lets it. */

export type PickerMessage = Extract<ServerMessage, { t: "picker" }>;

/** The control's place in the person's page: the inverse of `mapPoint`. */
export function controlRect(
  rect: PickerRect,
  drawn: Rect,
  header: FrameHeader,
): Rect | null {
  if (
    !(drawn.width > 0 && drawn.height > 0) ||
    !(header.deviceWidth > 0 && header.deviceHeight > 0)
  )
    return null;
  const sx = drawn.width / header.deviceWidth;
  const sy = drawn.height / header.deviceHeight;
  return {
    left: drawn.left + rect.x * sx,
    top: drawn.top + (rect.y + header.offsetTop) * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

/** Where a list or a field's panel goes in a box of `area`: under the
 * control, or over it when there is more room above; as wide as the control
 * at least and never past the box's edges (`margin` from them). Its height
 * is at most `wanted` and what the chosen side has. */
export function placePanel(
  control: Rect,
  area: Readonly<{ width: number; height: number }>,
  wanted: Readonly<{ width: number; height: number }>,
  margin = 8,
): Readonly<{
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
}> {
  const gap = 4;
  const below = area.height - (control.top + control.height) - gap - margin;
  const aboveRoom = control.top - gap - margin;
  const above = below < Math.min(wanted.height, 160) && aboveRoom > below;
  const maxHeight = Math.max(
    48,
    Math.min(wanted.height, above ? aboveRoom : below),
  );
  const width = Math.min(
    Math.max(control.width, wanted.width),
    area.width - 2 * margin,
  );
  const left = Math.min(
    Math.max(margin, control.left),
    area.width - margin - width,
  );
  const top = above
    ? Math.max(margin, control.top - gap - maxHeight)
    : Math.min(control.top + control.height + gap, area.height - margin - 48);
  return { left, top, width, maxHeight, above };
}

/** A sheet at the bottom rather than a list at the control: on a touch
 * screen, or where the box is too small for a list beside the control. */
export function useSheet(
  coarse: boolean,
  area: Readonly<{ width: number; height: number }>,
): boolean {
  return coarse || area.width < 420 || area.height < 320;
}

/** Text compared as a person reads it: no case, no accents. */
export function folded(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .trim();
}

/** The next choice that can be chosen from `from` in `step` (±1), or by a
 * page (±n), staying at the ends; `from` -1 starts before the first. */
export function stepChoice(
  items: readonly PickerItem[],
  from: number,
  step: number,
): number {
  const n = items.length;
  if (n === 0 || step === 0) return from;
  const enabled = (index: number) => items[index]?.disabled !== true;
  const wanted = from < 0 ? (step > 0 ? step - 1 : n + step) : from + step;
  const target = Math.min(n - 1, Math.max(0, wanted));
  const direction = step < 0 ? -1 : 1;
  // A choice that cannot be chosen is skipped onward, else back.
  for (let index = target; index >= 0 && index < n; index += direction)
    if (enabled(index)) return index;
  for (
    let index = target - direction;
    index >= 0 && index < n;
    index -= direction
  )
    if (enabled(index)) return index;
  return -1;
}

/** Type to jump: the first choice after `from` whose text begins with what
 * was typed, wrapping round; one key repeated cycles through the choices
 * that begin with it, as a native list does. -1 for none. */
export function typeAhead(
  items: readonly PickerItem[],
  from: number,
  typed: string,
): number {
  const query = folded(typed);
  if (query === "" || items.length === 0) return -1;
  const repeated = [...query].every((c) => c === query[0]);
  const needle = repeated ? (query[0] ?? "") : query;
  const start = repeated || from < 0 ? from + 1 : from;
  for (let k = 0; k < items.length; k++) {
    const index = (((start + k) % items.length) + items.length) % items.length;
    const item = items[index];
    if (
      item !== undefined &&
      item.disabled !== true &&
      folded(item.text).startsWith(needle)
    )
      return index;
  }
  return -1;
}

/** A datalist's suggestions for what the field holds: those that contain
 * it, or all of them when none do or it is empty. */
export function suggestionsFor(
  items: readonly PickerItem[],
  value: string,
): readonly PickerItem[] {
  const query = folded(value);
  if (query === "") return items;
  const matching = items.filter(
    (item) =>
      folded(item.value).includes(query) ||
      folded(item.label ?? "").includes(query),
  );
  return matching.length > 0 ? matching : items;
}

/** The picker's heading: the control's own name, else its kind's. */
export function pickerTitle(message: PickerMessage, say: Words): string {
  if (message.name !== "") return message.name;
  const kinds: Record<PickerKind, string> = {
    select: say.pickerSelect,
    datalist: say.pickerDatalist,
    date: say.pickerDate,
    time: say.pickerTime,
    "datetime-local": say.pickerDatetime,
    month: say.pickerMonth,
    week: say.pickerWeek,
    color: say.pickerColor,
  };
  return kinds[message.kind];
}

type PickerOptions = Readonly<{
  message: PickerMessage;
  /** The box the remote page is drawn in, and the control's place in it
   * (null when the frame is not drawn yet: then a sheet). */
  box: HTMLElement;
  control: Rect | null;
  say: Words;
  send: (message: ClientMessage) => void;
  /** Called once, when the picker has closed. */
  closed: () => void;
}>;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
};

/** One open picker in a viewer's box. `close` takes it away without an
 * answer (the page went away); the person's own Esc answers `pick-cancel`. */
export class PickerView {
  readonly token: string;
  private readonly root: HTMLDivElement;
  private done = false;
  private typed = "";
  private typedAt = 0;

  constructor(private readonly options: PickerOptions) {
    const { message, box, control, say } = options;
    this.token = message.token;
    const area = { width: box.clientWidth, height: box.clientHeight };
    const coarse = matchMedia("(pointer: coarse)").matches;
    const sheet = control === null || useSheet(coarse, area);
    this.root = el("div", sheet ? "picker-veil sheet" : "picker-veil");
    // A press outside closes it with nothing chosen, as a native list.
    this.root.addEventListener("pointerdown", (event) => {
      if (event.target !== this.root) return;
      event.preventDefault();
      this.answer(null);
    });
    const panel = el("div", "picker");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", pickerTitle(message, say));
    if (sheet)
      panel.append(el("div", "picker-title", pickerTitle(message, say)));
    const list = message.kind === "select" || message.kind === "datalist";
    const body = list ? this.list(panel) : this.field(panel);
    this.root.append(panel);
    box.append(this.root);
    if (!sheet && control !== null) {
      const place = placePanel(control, area, {
        width: list ? 220 : 280,
        height: list ? 360 : 200,
      });
      panel.style.left = `${Math.round(place.left)}px`;
      panel.style.top = `${Math.round(place.top)}px`;
      panel.style.minWidth = `${Math.round(place.width)}px`;
      panel.style.maxWidth = `${Math.round(Math.max(place.width, area.width - 16))}px`;
      panel.style.maxHeight = `${Math.round(place.maxHeight)}px`;
      panel.dataset.side = place.above ? "above" : "below";
    }
    body.focus({ preventScroll: true });
    body.dispatchEvent(new Event("lazurio-opened"));
  }

  /** Takes the picker away without an answer. */
  close(): void {
    if (this.done) return;
    this.done = true;
    this.root.remove();
    this.options.closed();
  }

  private answer(
    choice: Readonly<{ index?: number; value?: string; text?: string }> | null,
  ): void {
    if (this.done) return;
    this.options.send(
      choice === null
        ? { t: "pick-cancel", token: this.token }
        : { t: "pick", token: this.token, ...choice },
    );
    this.close();
  }

  // ---- A list: a select's options or a datalist's suggestions -------------

  private list(panel: HTMLElement): HTMLElement {
    const { message } = this.options;
    const items =
      message.kind === "datalist"
        ? suggestionsFor(message.items ?? [], message.value ?? "")
        : (message.items ?? []);
    const listbox = el("div", "picker-list");
    listbox.setAttribute("role", "listbox");
    listbox.tabIndex = 0;
    listbox.setAttribute("aria-label", pickerTitle(message, this.options.say));
    const rows: HTMLElement[] = [];
    let group = -1;
    let groupBox: HTMLElement = listbox;
    items.forEach((item, index) => {
      if (message.kind === "select" && (item.group ?? -1) !== group) {
        group = item.group ?? -1;
        const label = message.groups?.[group];
        if (label !== undefined) {
          groupBox = el("div", "picker-group");
          groupBox.setAttribute("role", "group");
          const head = el("div", "picker-group-label", label.label);
          head.id = `picker-group-${this.token}-${group}`;
          groupBox.setAttribute("aria-labelledby", head.id);
          groupBox.append(head);
          listbox.append(groupBox);
        } else groupBox = listbox;
      }
      const row = el("div", "picker-item");
      row.id = `picker-${this.token}-${index}`;
      row.setAttribute("role", "option");
      const text = el(
        "span",
        "picker-text",
        item.text === "" ? " " : item.text,
      );
      row.append(text);
      if (item.label !== undefined && item.label !== "")
        row.append(el("span", "picker-hint", item.label));
      if (item.disabled === true) row.setAttribute("aria-disabled", "true");
      const chosen = message.kind === "select" && item.i === message.selected;
      row.setAttribute("aria-selected", chosen ? "true" : "false");
      row.addEventListener("click", () => {
        if (item.disabled !== true) this.choose(item);
      });
      row.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse" && item.disabled !== true)
          activate(index, false);
      });
      groupBox.append(row);
      rows.push(row);
    });
    if (items.length === 0)
      listbox.append(el("div", "picker-empty", this.options.say.pickerEmpty));
    let active = -1;
    const activate = (index: number, scroll: boolean) => {
      rows[active]?.classList.remove("active");
      active = index;
      const row = rows[index];
      if (row === undefined) {
        listbox.removeAttribute("aria-activedescendant");
        return;
      }
      row.classList.add("active");
      listbox.setAttribute("aria-activedescendant", row.id);
      if (scroll) row.scrollIntoView({ block: "nearest" });
    };
    const pageSize = () =>
      Math.max(
        1,
        Math.floor(listbox.clientHeight / (rows[0]?.offsetHeight || 32)) - 1,
      );
    listbox.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      const move = (to: number) => {
        event.preventDefault();
        if (to >= 0) activate(to, true);
      };
      const chooseActive = () => {
        event.preventDefault();
        const item = items[active];
        if (item !== undefined && item.disabled !== true) this.choose(item);
        else this.answer(null);
      };
      const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
      // Alt with an arrow closes a native list on its choice.
      if (arrow && event.altKey) return chooseActive();
      switch (event.key) {
        case "ArrowDown":
          return move(stepChoice(items, active, 1));
        case "ArrowUp":
          return move(stepChoice(items, active, -1));
        case "Home":
          return move(stepChoice(items, -1, 1));
        case "End":
          return move(stepChoice(items, -1, -1));
        case "PageDown":
          return move(stepChoice(items, active, pageSize()));
        case "PageUp":
          return move(stepChoice(items, active, -pageSize()));
        case "Enter":
          return chooseActive();
        case "Escape":
        case "Tab":
          event.preventDefault();
          this.answer(null);
          return;
      }
      // A space chooses, unless it is part of a name being typed.
      if (event.key === " " && !this.typing()) return chooseActive();
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const now = performance.now();
        this.typed =
          now - this.typedAt > 1_000 ? event.key : this.typed + event.key;
        this.typedAt = now;
        const found = typeAhead(items, active, this.typed);
        if (found >= 0) activate(found, true);
      }
    });
    listbox.addEventListener("lazurio-opened", () => {
      const selected = items.findIndex(
        (item) => message.kind === "select" && item.i === message.selected,
      );
      if (selected >= 0) activate(selected, true);
      else if (message.kind === "select")
        activate(stepChoice(items, -1, 1), true);
    });
    panel.append(listbox);
    return listbox;
  }

  private typing(): boolean {
    return this.typed !== "" && performance.now() - this.typedAt < 1_000;
  }

  private choose(item: PickerItem): void {
    if (this.options.message.kind === "select")
      this.answer({ index: item.i, value: item.value, text: item.text });
    else this.answer({ value: item.value });
  }

  // ---- A field: date, time, month, week, colour -----------------------------

  private field(panel: HTMLElement): HTMLElement {
    const { message, say } = this.options;
    const form = el("form", "picker-form");
    const input = el("input", "picker-field");
    input.type = message.kind;
    input.value = message.value ?? "";
    if ((message.min ?? "") !== "") input.min = message.min ?? "";
    if ((message.max ?? "") !== "") input.max = message.max ?? "";
    if ((message.step ?? "") !== "") input.step = message.step ?? "";
    input.setAttribute("aria-label", pickerTitle(message, say));
    const error = el("p", "picker-error");
    error.hidden = true;
    const apply = el("button", "button primary", say.pickerApply);
    apply.type = "submit";
    const cancel = el("button", "button", say.cancel);
    cancel.type = "button";
    cancel.addEventListener("click", () => this.answer(null));
    // The page's min, max and step hold here as on the page: a value they
    // refuse is not sent.
    const check = () => {
      const valid = input.checkValidity();
      error.hidden = valid;
      error.textContent = valid ? "" : input.validationMessage;
      apply.disabled = !valid;
    };
    input.addEventListener("input", check);
    input.addEventListener("change", check);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      check();
      if (!apply.disabled) this.answer({ value: input.value });
    });
    form.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.answer(null);
    });
    const actions = el("div", "actions");
    actions.append(cancel, apply);
    form.append(input, error, actions);
    panel.append(form);
    input.addEventListener("lazurio-opened", () => {
      check();
      // The person's own calendar or colour chooser at once, while their
      // press still counts as one; where the browser refuses, the field
      // opens it on a click.
      try {
        input.showPicker();
      } catch {}
    });
    return input;
  }
}
